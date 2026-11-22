"""Local web console that manages the dedicated nginx reverse-proxy config."""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from preferences import load_preferences, parse_port, save_preferences


ROOT = Path(__file__).resolve().parent
NGINX_DIR = ROOT.parent
NGINX_BIN = Path('~/.config/ddns-go/bin/nginx').expanduser()
NGINX_PREFIX = f'{NGINX_DIR}/'
NGINX_CONF = NGINX_DIR / 'nginx.conf'
APPS_CONF = NGINX_DIR / 'conf.d' / 'apps.conf'
UNIT = 'nginx-ipzz.service'
CERT_DIR = str(Path('~/.config/ddns-go/acme/*.example.org_ecc').expanduser())
MAX_RULES = 64
DOMAIN_RE = re.compile(r'^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$')
BACKUP_NAME = 'apps.conf.backup'

ASSETS = {
    '/': ('panel.html', 'text/html; charset=utf-8'),
    '/panel.css': ('panel.css', 'text/css; charset=utf-8'),
    '/panel.js': ('panel.js', 'text/javascript; charset=utf-8'),
    '/favicon.svg': ('../nginx-control.svg', 'image/svg+xml'),
}


class ControlError(Exception):
    """用户可见的操作失败。"""


def load_state() -> dict:
    try:
        data = json.loads((ROOT / 'control-state.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    rules = data.get('rules')
    if not isinstance(rules, list):
        rules = []
    raw = data.get('raw')
    result = {'mode': 'raw' if data.get('mode') == 'raw' else 'rules', 'raw': raw if isinstance(raw, str) else ''}
    cleaned = []
    for rule in rules:
        if not isinstance(rule, dict):
            continue
        try:
            cleaned.append({'id': str(rule['id']), 'domain': normalize_domain(rule['domain']),
                            'port': normalize_port(rule['port']), 'enabled': rule.get('enabled') is True})
        except (KeyError, TypeError, ValueError):
            continue
    result['rules'] = cleaned
    if not cleaned and result['mode'] == 'rules':
        result['rules'] = [{'id': secrets.token_hex(12), 'domain': 'onenav.example.org',
                            'port': 9632, 'enabled': True}]
    return result


def save_state(state: dict) -> None:
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode='w', encoding='utf-8', dir=ROOT, prefix='.control-state.', delete=False,
        ) as file:
            temporary = Path(file.name)
            json.dump(state, file, ensure_ascii=False, indent=2)
            file.write('\n')
        os.replace(temporary, ROOT / 'control-state.json')
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def normalize_domain(value) -> str:
    if not isinstance(value, str):
        raise ValueError('域名须为字符串')
    domain = value.strip().lower().rstrip('.')
    if not DOMAIN_RE.match(domain):
        raise ValueError(f'域名格式无效：{value!r}')
    return domain


def normalize_port(value) -> int:
    if isinstance(value, str):
        value = value.strip()
        if not value.isascii() or not value.isdecimal() or len(value) > 5:
            raise ValueError('端口须为 1 到 65535 之间的整数')
        value = int(value)
    if type(value) is not int or not 1 <= value <= 65535:
        raise ValueError('端口须为 1 到 65535 之间的整数')
    return value


def normalize_rules(rules) -> list[dict]:
    if not isinstance(rules, list) or not rules or len(rules) > MAX_RULES:
        raise ValueError(f'须保留 1 到 {MAX_RULES} 条规则')
    cleaned = []
    seen = set()
    for item in rules:
        if not isinstance(item, dict) or item.keys() - {'id', 'domain', 'port', 'enabled'}:
            raise ValueError('规则字段须为 id、domain、port、enabled')
        domain = normalize_domain(item.get('domain'))
        port = normalize_port(item.get('port'))
        if domain in seen:
            raise ValueError(f'重复的子域名：{domain}')
        seen.add(domain)
        cleaned.append({'id': str(item.get('id') or secrets.token_hex(12)),
                        'domain': domain, 'port': port, 'enabled': item.get('enabled') is True})
    return cleaned


def generate_config(state: dict) -> str:
    if state['mode'] == 'raw':
        text = state.get('raw', '')
        if not text.strip():
            raise ValueError('原文模式内容为空')
        return text
    enabled = [rule for rule in state['rules'] if rule['enabled']]
    if not enabled:
        raise ValueError('至少启用一条规则，否则全部域名都会 404')
    cert = f'{CERT_DIR}/fullchain.cer'
    key = f'{CERT_DIR}/*.example.org.key'
    domains = ' '.join(rule['domain'] for rule in enabled)
    blocks = [
        '# 本文件由 Nginx/control 自动生成，请勿直接手改；在控制台编辑规则。',
        '',
        '# HTTP 统一跳转 HTTPS',
        'server {',
        '    listen 80;',
        '    listen [::]:80;',
        f'    server_name {domains};',
        '    return 301 https://$host$request_uri;',
        '}',
        '',
        '# 未匹配的域名直接拒绝',
        'server {',
        '    listen 443 ssl default_server;',
        '    listen [::]:443 ssl default_server;',
        '    http2 on;',
        f'    ssl_certificate {cert};',
        f'    ssl_certificate_key {key};',
        '    ssl_protocols TLSv1.2 TLSv1.3;',
        '    return 404;',
        '}',
    ]
    for rule in enabled:
        blocks += [
            '',
            f'# {rule["domain"]}',
            'server {',
            '    listen 443 ssl;',
            '    listen [::]:443 ssl;',
            '    http2 on;',
            f'    server_name {rule["domain"]};',
            f'    ssl_certificate {cert};',
            f'    ssl_certificate_key {key};',
            '    ssl_protocols TLSv1.2 TLSv1.3;',
            '    ssl_session_cache shared:SSL:10m;',
            '',
            '    location / {',
            f'        proxy_pass http://127.0.0.1:{rule["port"]};',
            '    }',
            '}',
        ]
    return '\n'.join(blocks) + '\n'


def run_command(command: list[str], timeout: float = 20) -> tuple[int, str]:
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ControlError(f'命令执行失败：{error}') from error
    output = ((result.stdout or '') + (result.stderr or '')).strip()
    return result.returncode, output


def service_action(action: str) -> str:
    code, output = run_command(['systemctl', '--user', action, UNIT])
    if code != 0:
        raise ControlError(f'{UNIT} {action} 失败：{output}')
    return output or f'{UNIT} {action} 完成'


def apply_config(state: dict) -> dict:
    content = generate_config(state)
    lock_path = ROOT / '.apply.lock'
    with lock_path.open('a') as lock:
        import fcntl
        fcntl.flock(lock, fcntl.LOCK_EX)
        backup = APPS_CONF.with_name(BACKUP_NAME)
        if APPS_CONF.exists():
            shutil.copyfile(APPS_CONF, backup)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(
                mode='w', encoding='utf-8', dir=APPS_CONF.parent,
                prefix='.apps.', suffix='.conf', delete=False,
            ) as file:
                temporary = Path(file.name)
                file.write(content)
            os.replace(temporary, APPS_CONF)
            code, output = run_command([
                str(NGINX_BIN), '-t', '-p', NGINX_PREFIX, '-c', str(NGINX_CONF),
            ])
            if code != 0:
                shutil.copyfile(backup, APPS_CONF)
                raise ControlError('nginx -t 校验失败，已回滚到上一版配置：\n' + output)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        service_action('reload')
        return {'message': '配置已生成、校验通过并重载 nginx', 'backup': str(backup)}


def restore_backup() -> dict:
    backup = APPS_CONF.with_name(BACKUP_NAME)
    if not backup.exists():
        raise ControlError('还没有可恢复的备份')
    shutil.copyfile(backup, APPS_CONF)
    code, output = run_command([str(NGINX_BIN), '-t', '-p', NGINX_PREFIX, '-c', str(NGINX_CONF)])
    if code != 0:
        raise ControlError('恢复后校验失败：\n' + output)
    service_action('reload')
    return {'message': '已恢复上一版配置并重载 nginx'}


def check_new_port(value, current: int) -> int:
    port = parse_port(value)
    if port == current:
        raise ValueError('新端口与当前端口相同')
    with socket.socket() as connection:
        connection.settimeout(0.5)
        if connection.connect_ex(('127.0.0.1', port)) == 0:
            raise ValueError(f'端口 {port} 已被其他服务占用')
    return port


def status_snapshot(state: dict) -> dict:
    code, _ = run_command(['systemctl', '--user', 'is-active', UNIT], timeout=5)
    try:
        current_file = APPS_CONF.read_text(encoding='utf-8', errors='replace')[:65536]
    except OSError:
        current_file = ''
    return {
        'mode': state['mode'], 'raw': state.get('raw', ''), 'rules': state['rules'],
        'serviceActive': code == 0,
        'listeners': [80, 443],
        'generated': state['mode'] == 'rules',
        'currentFile': current_file,
        'panelPort': load_preferences()['port'],
    }


class Handler(BaseHTTPRequestHandler):
    def setup(self) -> None:
        self.request.settimeout(5)
        super().setup()

    def log_message(self, format: str, *args) -> None:
        pass

    def respond(self, code: int, content: bytes, mime: str) -> None:
        self.send_response(code)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(content)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Nginx-Control', 'local-panel')
        self.send_header('Content-Security-Policy',
                         "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        self.end_headers()
        self.wfile.write(content)

    def json_response(self, code: int, data: dict) -> None:
        self.respond(code, json.dumps(data, ensure_ascii=False).encode(), 'application/json; charset=utf-8')

    def permitted(self, write: bool = False) -> bool:
        origin = f'http://{self.server.authority}'
        if self.headers.get_all('Host') != [self.server.authority]:
            self.json_response(403, {'error': '请使用启动日志中的本机地址'})
            return False
        if write and self.headers.get_all('Origin') != [origin]:
            self.json_response(403, {'error': '管理操作须从本机控制台提交'})
            return False
        return True

    def do_GET(self) -> None:
        if not self.permitted():
            return
        if self.path == '/api/state':
            self.json_response(200, status_snapshot(load_state()))
        elif self.path in ASSETS:
            file, mime = ASSETS[self.path]
            self.respond(200, (ROOT / file).read_bytes(), mime)
        else:
            self.json_response(404, {'error': '页面不存在'})

    def do_POST(self) -> None:
        if not self.permitted(write=True):
            return
        if self.path != '/api/action':
            self.json_response(404, {'error': '接口不存在'})
            return
        if self.headers.get_content_type() != 'application/json':
            self.json_response(415, {'error': '请求须使用 JSON'})
            return
        lengths = self.headers.get_all('Content-Length', [])
        if len(lengths) != 1 or self.headers.get('Transfer-Encoding') is not None:
            self.json_response(400, {'error': '请求长度无效'})
            return
        length = lengths[0]
        if not length.isascii() or not length.isdecimal() or int(length) > 65536:
            self.json_response(400, {'error': '请求长度无效'})
            return
        try:
            data = json.loads(self.rfile.read(int(length)))
            if not isinstance(data, dict):
                raise ValueError
        except (ValueError, RecursionError):
            self.json_response(400, {'error': '请求须为 JSON 对象'})
            return
        action = data.get('action')
        state = load_state()
        try:
            if action in ('save', 'apply'):
                if 'raw' in data or data.get('mode') == 'raw':
                    state['mode'] = 'raw'
                    if isinstance(data.get('raw'), str):
                        state['raw'] = data['raw']
                    if action == 'save':
                        save_state(state)
                        result = {'message': '原文已保存（未应用）'}
                    else:
                        result = apply_config(state)
                        save_state(state)
                else:
                    state['mode'] = 'rules'
                    state['rules'] = normalize_rules(data.get('rules'))
                    if action == 'save':
                        save_state(state)
                        result = {'message': '规则已保存（未应用）'}
                    else:
                        result = apply_config(state)
                        save_state(state)
            elif action == 'reload':
                result = {'message': service_action('reload')}
            elif action == 'restart':
                result = {'message': service_action('restart')}
            elif action == 'restore-backup':
                result = restore_backup()
            elif action == 'set-port':
                port = check_new_port(data.get('port'), load_preferences()['port'])
                save_preferences({'port': port})
                result = {
                    'message': f'面板端口已保存为 {port}，服务重启中，稍后自动跳转新地址。',
                    'newPort': port,
                }
            else:
                raise ValueError('未知的操作')
        except (ControlError, ValueError) as error:
            self.json_response(409, {'error': str(error)})
            return
        self.json_response(200, {**result, **status_snapshot(state)})
        if result.get('newPort'):
            # 1 秒后用 execv 原位重启进程：同一 PID 替换进程映像，重读偏好绑定新端口，
            # 避免“在服务自己的 cgroup 里调 systemctl 重启”被连带杀掉的问题。
            script = str(Path(__file__).resolve())
            restart = threading.Timer(1.0, lambda: os.execv(
                sys.executable, [sys.executable, '-B', script]))
            restart.daemon = True
            restart.start()


class ControlServer(ThreadingHTTPServer):
    def __init__(self, port: int) -> None:
        super().__init__(('127.0.0.1', port), Handler)
        self.authority = f'127.0.0.1:{port}'


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description='nginx 反代配置控制台')
    parser.add_argument('--port', type=int, help='本机端口，默认使用已保存设置（初始 8790）')
    args = parser.parse_args(argv)
    port = load_preferences()['port'] if args.port is None else args.port
    if not 1 <= port <= 65535:
        parser.error('端口须在 1 到 65535 之间')
    try:
        server = ControlServer(port)
    except OSError as error:
        print(f'端口 {port} 无法监听：{error}', file=sys.stderr)
        return 1
    print(f'nginx 配置控制台：http://{server.authority}/')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
