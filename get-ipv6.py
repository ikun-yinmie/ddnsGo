#!/usr/bin/env python3
"""Print the current routed, non-deprecated global IPv6 address for ddns-go."""

import ipaddress
import subprocess
import sys


def current_ipv6():
    route = subprocess.check_output(
        ['ip', '-6', 'route', 'get', '2606:4700:4700::1111'],
        text=True, stderr=subprocess.PIPE, timeout=5,
    ).split()
    address = ipaddress.IPv6Address(route[route.index('src') + 1])
    interface = route[route.index('dev') + 1]
    if address not in ipaddress.IPv6Network('2000::/3'):
        raise ValueError('当前路由没有可用的全球单播 IPv6')
    assigned = subprocess.check_output(
        ['ip', '-6', '-o', 'addr', 'show', 'dev', interface, 'scope', 'global'],
        text=True, stderr=subprocess.PIPE, timeout=5,
    )
    for line in assigned.splitlines():
        parts = line.split()
        candidate = ipaddress.IPv6Interface(parts[parts.index('inet6') + 1]).ip
        if candidate == address and not {'deprecated', 'tentative', 'dadfailed'} & set(parts):
            return str(address)
    raise ValueError('当前 IPv6 地址未就绪或已弃用')


if __name__ == '__main__':
    try:
        print(current_ipv6())
    except (OSError, ValueError, IndexError, subprocess.SubprocessError) as error:
        print(f'获取当前 IPv6 失败：{error}', file=sys.stderr)
        sys.exit(1)
