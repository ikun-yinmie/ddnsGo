#!/usr/bin/env python3
"""Desktop launcher: open the native controller for panel and nginx services."""

import argparse
import json
import subprocess
import sys
from urllib.error import URLError
from urllib.request import ProxyHandler, build_opener


SERVICES = ('nginx-ipzz.service', 'nginx-control.service')


def panel_url():
    from preferences import load_preferences
    return f'http://127.0.0.1:{load_preferences()["port"]}/'


def systemctl(*arguments):
    return subprocess.run(
        ['systemctl', '--user', *arguments],
        capture_output=True, text=True, timeout=30,
    )


def status() -> dict:
    result = {}
    for service in SERVICES:
        state = systemctl('is-active', service)
        result[service] = state.stdout.strip() or state.stderr.strip()
    try:
        with build_opener(ProxyHandler({})).open(panel_url(), timeout=2) as response:
            result['panel'] = 'ready' if response.headers.get('X-Nginx-Control') == 'local-panel' else 'changed'
    except (URLError, OSError):
        result['panel'] = 'unreachable'
    return result


def report_error(message: str) -> None:
    print(message, file=sys.stderr)
    try:
        subprocess.Popen(
            ['zenity', '--error', '--title=Nginx Control', '--no-markup', '--text', message],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
        )
    except OSError:
        pass


def main() -> int:
    parser = argparse.ArgumentParser(description='Nginx Control 双击启动器')
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument('--stop', action='store_true', help='停止反代与控制台服务')
    actions.add_argument('--restart', action='store_true', help='重启反代与控制台服务')
    actions.add_argument('--status', action='store_true', help='打印服务状态（JSON）')
    parser.add_argument('--no-browser', action='store_true', help='旧参数：改用桌面控制窗口后不再直接开浏览器')
    args = parser.parse_args()
    try:
        if args.status:
            print(json.dumps(status(), ensure_ascii=False, indent=2))
            return 0
        if args.stop:
            result = systemctl('stop', *SERVICES)
            if result.returncode != 0:
                raise OSError(f'停止失败：{result.stderr.strip()}')
            print('反代与控制台已停止（重新双击图标即可恢复）')
            return 0
        if args.restart:
            result = systemctl('restart', *SERVICES)
            if result.returncode != 0:
                raise OSError(f'重启失败：{result.stderr.strip()}')
            print(f'已重启：{panel_url()}')
            return 0
        from desktop_control import show_controller
        return show_controller()
    except OSError as error:
        report_error(str(error))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
