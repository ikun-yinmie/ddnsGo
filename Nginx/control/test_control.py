import json
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import control
from control import (
    ControlError, apply_config, generate_config, load_state, normalize_domain,
    normalize_port, normalize_rules, run_command, save_state,
)


def rule(domain='onenav.example.org', port=9632, enabled=True, id='a1b2c3d4e5f6'):
    return {'id': id, 'domain': domain, 'port': port, 'enabled': enabled}


class ValidationTests(unittest.TestCase):
    def test_domain_and_port(self):
        self.assertEqual(normalize_domain(' OneNav.Example.Org. '), 'onenav.example.org')
        self.assertEqual(normalize_port(' 9632 '), 9632)
        for value in ('', '-1', 'abc', '0', '65536', None, 'a..b', '主机.local'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                (normalize_port if str(value).isascii() and str(value).isdigit() or value is None else normalize_domain)(value)

    def test_normalize_rules(self):
        rules = normalize_rules([rule(), rule('app.example.org', 9634, False, 'b2')])
        self.assertEqual(len(rules), 2)
        self.assertFalse(rules[1]['enabled'])
        with self.assertRaisesRegex(ValueError, '重复'):
            normalize_rules([rule(), rule()])
        with self.assertRaisesRegex(ValueError, '须保留'):
            normalize_rules([])
        with self.assertRaisesRegex(ValueError, '字段'):
            normalize_rules([dict(rule(), extra=1)])


class GenerateTests(unittest.TestCase):
    def test_check_new_port(self):
        with patch.object(control.socket.socket, 'connect_ex', return_value=1):
            self.assertEqual(control.check_new_port('9000', 8790), 9000)
            with self.assertRaisesRegex(ValueError, '相同'):
                control.check_new_port(8790, 8790)
            with self.assertRaisesRegex(ValueError, '端口须为'):
                control.check_new_port('0', 8790)
        with patch.object(control.socket.socket, 'connect_ex', return_value=0):
            with self.assertRaisesRegex(ValueError, '占用'):
                control.check_new_port('9000', 8790)

    def test_generated_blocks(self):
        state = {'mode': 'rules', 'raw': '', 'rules': normalize_rules([
            rule(), rule('app.example.org', 9634, False, 'b2'),
        ])}
        content = generate_config(state)
        self.assertIn('server_name onenav.example.org;', content)
        self.assertNotIn('app.example', content)
        self.assertIn('proxy_pass http://127.0.0.1:9632;', content)
        self.assertIn('return 301 https://$host$request_uri;', content)
        self.assertIn('return 404;', content)
        self.assertIn('fullchain.cer', content)

    def test_empty_and_raw(self):
        with self.assertRaisesRegex(ValueError, '至少启用'):
            generate_config({'mode': 'rules', 'raw': '', 'rules': [rule(enabled=False)]})
        self.assertEqual(generate_config({'mode': 'raw', 'raw': '# custom\n', 'rules': []}), '# custom\n')
        with self.assertRaisesRegex(ValueError, '为空'):
            generate_config({'mode': 'raw', 'raw': '  ', 'rules': []})


class StateTests(unittest.TestCase):
    def test_roundtrip_and_seed(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(control, 'ROOT', root):
                state = load_state()
                self.assertEqual(state['rules'][0]['domain'], 'onenav.example.org')
                state['rules'].append(rule('app.example.org', 9634, False, 'b2'))
                save_state(state)
                again = load_state()
                self.assertEqual(len(again['rules']), 2)
                (root / 'control-state.json').write_text('broken')
                self.assertEqual(load_state()['rules'][0]['port'], 9632)


class ApplyTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        (root / 'conf.d').mkdir()
        (root / 'conf.d' / 'apps.conf').write_text('# old\n')
        (root / 'nginx.conf').write_text('# main\n')
        patchers = [
            patch.object(control, 'ROOT', root),
            patch.object(control, 'NGINX_DIR', root),
            patch.object(control, 'NGINX_PREFIX', f'{root}/'),
            patch.object(control, 'NGINX_CONF', root / 'nginx.conf'),
            patch.object(control, 'APPS_CONF', root / 'conf.d' / 'apps.conf'),
            patch.object(control, 'NGINX_BIN', root / 'bin' / 'nginx'),
        ]
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)
        self.state = {'mode': 'rules', 'raw': '', 'rules': normalize_rules([rule()])}

    def write_validator(self, succeed):
        bin_dir = Path(self.directory.name) / 'bin'
        bin_dir.mkdir(exist_ok=True)
        script = bin_dir / 'nginx'
        script.write_text(f'#!/bin/sh\nexit {0 if succeed else 1}\n')
        os.chmod(script, 0o755)

    def test_apply_success_reloads(self):
        self.write_validator(succeed=True)
        with patch.object(control, 'service_action', return_value='ok') as reload_call:
            result = apply_config(self.state)
            reload_call.assert_called_once_with('reload')
        self.assertIn('server_name onenav.example.org;', (control.APPS_CONF).read_text())
        self.assertIn('校验通过并重载', result['message'])

    def test_failed_test_rolls_back(self):
        self.write_validator(succeed=False)
        with patch.object(control, 'service_action') as reload_call:
            with self.assertRaisesRegex(ControlError, '校验失败，已回滚'):
                apply_config(self.state)
            reload_call.assert_not_called()
        self.assertEqual((control.APPS_CONF).read_text(), '# old\n')
        self.assertTrue((control.APPS_CONF.with_name('apps.conf.backup')).exists())

    def test_restore_backup(self):
        self.write_validator(succeed=True)
        (control.APPS_CONF.with_name('apps.conf.backup')).write_text('# restored\n')
        with patch.object(control, 'service_action', return_value='ok') as reload_call:
            result = control.restore_backup()
            reload_call.assert_called_once_with('reload')
        self.assertEqual((control.APPS_CONF).read_text(), '# restored\n')
        self.assertIn('恢复', result['message'])
        with patch.object(control, 'run_command', return_value=(1, 'bad')):
            with self.assertRaisesRegex(ControlError, '恢复后校验失败'):
                control.restore_backup()

    def test_raw_mode_apply(self):
        self.write_validator(succeed=True)
        state = {'mode': 'raw', 'raw': '# raw server block\n', 'rules': []}
        with patch.object(control, 'service_action', return_value='ok'):
            apply_config(state)
        self.assertEqual((control.APPS_CONF).read_text(), '# raw server block\n')

    def test_run_command_timeout(self):
        with patch.object(control.subprocess, 'run', side_effect=control.subprocess.TimeoutExpired('cmd', 1)):
            with self.assertRaisesRegex(ControlError, '命令执行失败'):
                run_command(['true'])


if __name__ == '__main__':
    unittest.main()
