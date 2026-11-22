"""Persist desktop preferences independently of forwarding rules."""

import fcntl
import json
import os
import tempfile
from pathlib import Path


DEFAULTS = {'port': 8790, 'theme': 'purple'}
THEME_LABELS = {'purple': '紫色系', 'dark': '深色系', 'light': '浅色系'}
PREFERENCES = Path(__file__).resolve().parent / '.runtime' / 'preferences.json'


def parse_port(value):
    if isinstance(value, str):
        value = value.strip()
        if not value.isascii() or not value.isdecimal() or len(value) > 5:
            raise ValueError('Web 端口须为 1 到 65535 之间的整数')
        value = int(value)
    if type(value) is not int or not 1 <= value <= 65535:
        raise ValueError('Web 端口须为 1 到 65535 之间的整数')
    return value


def load_preferences(path=None):
    path = PREFERENCES if path is None else Path(path)
    result = DEFAULTS.copy()
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return result
    if not isinstance(data, dict):
        return result
    try:
        result['port'] = parse_port(data.get('port', DEFAULTS['port']))
    except ValueError:
        pass
    if isinstance(data.get('theme'), str) and data['theme'] in THEME_LABELS:
        result['theme'] = data['theme']
    return result


def save_preferences(updates, path=None):
    path = PREFERENCES if path is None else Path(path)
    if updates.keys() - DEFAULTS.keys():
        raise ValueError('未知偏好设置')
    if 'port' in updates:
        updates = dict(updates, port=parse_port(updates['port']))
    if 'theme' in updates and updates['theme'] not in THEME_LABELS:
        raise ValueError('未知主题')
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    with path.with_suffix('.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        data = load_preferences(path)
        data.update(updates)
        try:
            with tempfile.NamedTemporaryFile(
                mode='w', encoding='utf-8', dir=path.parent,
                prefix=f'.{path.name}.', delete=False,
            ) as file:
                temporary = Path(file.name)
                json.dump(data, file, ensure_ascii=False, indent=2)
                file.write('\n')
            os.replace(temporary, path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    return data
