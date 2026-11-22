"""Native controller window: manage the web panel and nginx services."""

import json
import socket
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.error import URLError
from urllib.request import ProxyHandler, build_opener

from PyQt5 import QtCore, QtGui, QtWidgets

from preferences import THEME_LABELS, load_preferences, save_preferences


SERVICES = (
    {'unit': 'nginx-ipzz.service', 'title': '反代服务 nginx-ipzz', 'short': '反代'},
    {'unit': 'nginx-control.service', 'title': '面板服务 nginx-control', 'short': '面板'},
)
LOG_LINES = 35


def panel_url():
    return f'http://127.0.0.1:{load_preferences()["port"]}/'
ROOT = Path(__file__).resolve().parent.parent

PALETTES = {
    'purple': {
        'bg': '#130e21', 'surface': '#231832', 'ink': '#f2eaff', 'muted': '#baaaca',
        'accent': '#c5a2ff', 'accent_hover': '#d9bdff', 'accent_ink': '#29163e',
        'button': '#342244', 'hover': '#49305d', 'border': '#59416d',
        'input': '#1a1128', 'disabled': '#867393', 'error': '#ffacc8', 'warn': '#e0bbff',
        'ok': '#8ff0cf',
    },
    'dark': {
        'bg': '#0e1118', 'surface': '#1b202d', 'ink': '#edf0f7', 'muted': '#adb6ca',
        'accent': '#b7a7ef', 'accent_hover': '#d2c4ff', 'accent_ink': '#201932',
        'button': '#2b3142', 'hover': '#3b4358', 'border': '#4b556b',
        'input': '#131824', 'disabled': '#828ca0', 'error': '#ffa8be', 'warn': '#ddc3fa',
        'ok': '#8ff0cf',
    },
    'light': {
        'bg': '#f5f2fa', 'surface': '#ffffff', 'ink': '#30243f', 'muted': '#655772',
        'accent': '#713ab5', 'accent_hover': '#8752c8', 'accent_ink': '#ffffff',
        'button': '#eee6f5', 'hover': '#e2d5ee', 'border': '#baabc8',
        'input': '#fcfaff', 'disabled': '#83768f', 'error': '#a32350', 'warn': '#714a96',
        'ok': '#0f7d70',
    },
}


def set_text(widget, value):
    if widget.text() != value:
        widget.setText(value)


def set_enabled(widget, enabled):
    if widget.isEnabled() != enabled:
        widget.setEnabled(enabled)


def run(command, timeout=20):
    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    return result.returncode, (result.stdout or '').strip(), (result.stderr or '').strip()


def panel_responding():
    try:
        with build_opener(ProxyHandler({})).open(panel_url(), timeout=2) as response:
            return response.headers.get('X-Nginx-Control') == 'local-panel'
    except (URLError, OSError):
        return False


def collect_status():
    """Read service states, panel API info and recent log files (worker thread)."""
    data = {'services': {}, 'log': '', 'panel': None, 'listeners': []}
    for service in SERVICES:
        unit = service['unit']
        code, output, _ = run(['systemctl', '--user', 'is-active', unit], timeout=10)
        state = output or 'unknown'
        data['services'][unit] = {'active': state == 'active', 'state': state}
    if data['services']['nginx-control.service']['active']:
        try:
            with build_opener(ProxyHandler({})).open(panel_url() + 'api/state', timeout=3) as response:
                payload = json.load(response)
            data['panel'] = {
                'rules': len(payload.get('rules', [])),
                'enabled': sum(1 for rule in payload.get('rules', []) if rule.get('enabled')),
                'mode': '原文' if payload.get('mode') == 'raw' else '规则',
                'ready': payload.get('serviceActive') is True,
            }
        except (URLError, OSError, ValueError):
            data['panel'] = None
    for port in (80, 443):
        with socket.socket() as connection:
            connection.settimeout(0.6)
            if connection.connect_ex(('127.0.0.1', port)) == 0:
                data['listeners'].append(port)
    parts = []
    for source in (('反代日志', ROOT / 'logs' / 'service.log'),
                   ('面板日志', ROOT / 'logs' / 'control.log')):
        try:
            content = source[1].read_text(encoding='utf-8', errors='replace')
            lines = content.splitlines()[-LOG_LINES:]
        except OSError:
            lines = []
        parts.append(f'── {source[0]} ──\n' + ('\n'.join(lines) or '暂无日志'))
    data['log'] = '\n\n'.join(parts)
    return data


class Controller(QtWidgets.QWidget):
    def __init__(self):
        super().__init__()
        self.pool = ThreadPoolExecutor(max_workers=1)
        self.future = None
        self.operation = None
        self.pending = None
        self.last_unit = ''
        self.closed = False
        self.last_result = None
        self.log_text = None
        self.log_cutoff = None
        self.theme = load_preferences()['theme']
        self.message_role = 'muted'
        self.status_roles = {service['unit']: 'warn' for service in SERVICES}
        self.setObjectName('controller')
        self.setWindowTitle('Nginx Control · 服务控制台')
        self.setWindowIcon(QtGui.QIcon(str(ROOT / 'nginx-control.svg')))
        self.resize(920, 800)
        self.setMinimumSize(840, 720)
        self.build()
        self.apply_theme(self.theme)
        self.tick_timer = QtCore.QTimer(self)
        self.tick_timer.timeout.connect(self.tick)
        self.tick_timer.start(80)
        self.poll_timer = QtCore.QTimer(self)
        self.poll_timer.timeout.connect(self.refresh)
        self.poll_timer.start(2000)
        self.refresh()

    @staticmethod
    def label(text, name=None):
        widget = QtWidgets.QLabel(text)
        if name:
            widget.setObjectName(name)
        return widget

    @staticmethod
    def button(text, handler, name=None):
        widget = QtWidgets.QPushButton(text)
        widget.setCursor(QtCore.Qt.PointingHandCursor)
        if name:
            widget.setObjectName(name)
        widget.clicked.connect(handler)
        return widget

    def build(self):
        layout = QtWidgets.QVBoxLayout(self)
        layout.setContentsMargins(28, 24, 28, 20)
        layout.setSpacing(16)
        header = QtWidgets.QHBoxLayout()
        title = QtWidgets.QVBoxLayout()
        title.setSpacing(5)
        title.addWidget(self.label('Nginx Control  /  服务控制台', 'title'))
        title.addWidget(self.label('PANEL + NGINX  ·  启停 · 重启 · 状态 · 日志', 'subtitle'))
        header.addLayout(title)
        header.addStretch()
        theme = QtWidgets.QVBoxLayout()
        theme.addWidget(self.label('界面主题', 'muted'))
        self.theme_menu = QtWidgets.QComboBox()
        for key, name in THEME_LABELS.items():
            self.theme_menu.addItem(name, key)
        self.theme_menu.setMinimumWidth(115)
        self.theme_menu.currentIndexChanged.connect(self.select_theme)
        theme.addWidget(self.theme_menu)
        header.addLayout(theme)
        layout.addLayout(header)

        self.service_rows = {}
        for service in SERVICES:
            frame = QtWidgets.QFrame()
            frame.setObjectName('status-card')
            grid = QtWidgets.QGridLayout(frame)
            grid.setContentsMargins(20, 16, 20, 16)
            grid.setHorizontalSpacing(14)
            grid.setVerticalSpacing(6)
            grid.addWidget(self.label(service['title'], 'card-title'), 0, 0, 2, 1)
            status_label = self.label('● 正在检查…', 'status')
            detail_label = self.label('—', 'muted')
            grid.addWidget(status_label, 0, 1)
            grid.addWidget(detail_label, 1, 1)
            buttons = {}
            for column, action in enumerate(('start', 'stop', 'restart'), start=2):
                names = {'start': '启动', 'stop': '停止', 'restart': '重启'}
                button = self.button(
                    names[action],
                    lambda checked=False, a=action, u=service['unit']: self.execute(a, u),
                )
                grid.addWidget(button, 0, column)
                buttons[action] = button
            self.service_rows[service['unit']] = {
                'status': status_label, 'detail': detail_label, 'buttons': buttons,
            }
            layout.addWidget(frame)

        actions = QtWidgets.QHBoxLayout()
        actions.setSpacing(10)
        self.open_button = self.button('打开 Web 面板', self.open_web, 'primary')
        self.refresh_button = self.button('刷新状态', self.refresh)
        actions.addWidget(self.open_button)
        actions.addWidget(self.refresh_button)
        actions.addStretch()
        layout.addLayout(actions)

        self.message_label = self.label('状态每 2 秒静默刷新；启停面板/反代用上方按钮。', 'message')
        self.message_label.setWordWrap(True)
        self.message_label.setMinimumHeight(30)
        layout.addWidget(self.message_label)

        logs_header = QtWidgets.QHBoxLayout()
        logs_header.addWidget(self.label('运行日志', 'logs-title'))
        logs_header.addStretch()
        logs_header.addWidget(self.label('反代 + 面板 · 右键可清空', 'subtitle'))
        layout.addLayout(logs_header)
        self.logs = QtWidgets.QPlainTextEdit()
        self.logs.setReadOnly(True)
        self.logs.setAccessibleName('运行日志')
        self.logs.setLineWrapMode(QtWidgets.QPlainTextEdit.WidgetWidth)
        self.logs.setContextMenuPolicy(QtCore.Qt.CustomContextMenu)
        self.logs.customContextMenuRequested.connect(self.show_log_menu)
        layout.addWidget(self.logs, 1)
        layout.addWidget(self.label('关闭此窗口不会停止服务；停止反代会中断全部转发。', 'subtitle'))
        self.update_controls()

    def tint(self, widget, role):
        palette = widget.palette()
        color = QtGui.QColor(PALETTES[self.theme][role])
        if palette.color(QtGui.QPalette.WindowText) != color:
            palette.setColor(QtGui.QPalette.WindowText, color)
            widget.setPalette(palette)

    def message(self, text, role='muted'):
        self.message_role = role
        set_text(self.message_label, text)
        self.tint(self.message_label, role)

    def apply_theme(self, theme):
        self.theme = theme
        c = PALETTES[theme]
        self.setStyleSheet(f'''
            QWidget {{ color: {c['ink']}; font-family: "Noto Sans CJK SC"; font-size: 13px; }}
            QWidget#controller {{ background: {c['bg']}; }}
            QLabel {{ background: transparent; }}
            QLabel#title {{ color: {c['accent']}; font-size: 25px; font-weight: 600; }}
            QLabel#subtitle {{ color: {c['muted']}; font-size: 11px; }}
            QLabel#muted {{ color: {c['muted']}; }}
            QLabel#logs-title {{ color: {c['accent']}; font-size: 14px; font-weight: 600; }}
            QLabel#card-title {{ font-size: 15px; font-weight: 600; }}
            QLabel#status {{ font-size: 15px; font-weight: 600; }}
            QFrame#status-card {{ background: {c['surface']}; border: 1px solid {c['border']}; border-radius: 18px; }}
            QPushButton {{ background: {c['button']}; color: {c['ink']}; border: 1px solid {c['border']}; border-radius: 12px; padding: 9px 15px; min-height: 20px; }}
            QPushButton:hover {{ background: {c['hover']}; border-color: {c['accent']}; }}
            QPushButton:pressed {{ background: {c['surface']}; }}
            QPushButton:focus {{ border: 1px solid {c['accent']}; }}
            QPushButton#primary {{ background: {c['accent']}; color: {c['accent_ink']}; border-color: {c['accent']}; }}
            QPushButton#primary:hover {{ background: {c['accent_hover']}; }}
            QPushButton:disabled {{ background: {c['surface']}; color: {c['disabled']}; border-color: {c['border']}; }}
            QComboBox {{ background: {c['input']}; border: 1px solid {c['border']}; border-radius: 11px; padding: 9px 12px; }}
            QComboBox:focus {{ border-color: {c['accent']}; }}
            QComboBox::drop-down {{ border: none; width: 24px; }}
            QComboBox QAbstractItemView {{ background: {c['surface']}; color: {c['ink']}; border: 1px solid {c['border']}; border-radius: 8px; padding: 5px; selection-background-color: {c['hover']}; outline: none; }}
            QPlainTextEdit {{ background: {c['input']}; color: {c['ink']}; border: 1px solid {c['border']}; border-radius: 15px; padding: 12px; font-family: "DejaVu Sans Mono"; font-size: 12px; selection-background-color: {c['hover']}; }}
            QScrollBar:vertical {{ background: transparent; width: 10px; margin: 6px 2px; }}
            QScrollBar::handle:vertical {{ background: {c['border']}; border-radius: 3px; min-height: 28px; }}
            QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{ height: 0; }}
            QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical {{ background: transparent; }}
        ''')
        blocked = self.theme_menu.blockSignals(True)
        self.theme_menu.setCurrentIndex(self.theme_menu.findData(theme))
        self.theme_menu.blockSignals(blocked)
        self.tint(self.message_label, self.message_role)
        for unit, role in self.status_roles.items():
            self.tint(self.service_rows[unit]['status'], role)

    def select_theme(self, index):
        theme = self.theme_menu.itemData(index)
        try:
            save_preferences({'theme': theme})
        except (OSError, ValueError) as error:
            self.apply_theme(self.theme)
            self.message(f'主题保存失败：{error}', 'error')
            return
        self.apply_theme(theme)
        self.message(f'已切换到{THEME_LABELS[theme]}，偏好已保存。', 'accent')

    @property
    def busy(self):
        return self.pending is not None or self.operation not in (None, 'status')

    def show_log_menu(self, position):
        menu = self.logs.createStandardContextMenu()
        menu.addSeparator()
        clear_action = menu.addAction('清空日志')
        chosen = menu.exec_(self.logs.mapToGlobal(position))
        menu.deleteLater()
        if chosen == clear_action:
            self.clear_log()

    def clear_log(self):
        # 服务日志各自落在 Nginx/logs/ 下的文件里，清空即真实删除（当前用户可写）。
        cleared = False
        for path in (ROOT / 'logs' / 'service.log', ROOT / 'logs' / 'control.log'):
            try:
                if path.exists():
                    path.write_text('', encoding='utf-8')
                    cleared = True
            except OSError as error:
                self.message(f'日志清空失败：{error}', 'error')
                return
        self.log_text = None
        self.refresh()
        self.message('日志已清空。', 'accent')

    def update_controls(self):
        statuses = self.last_result or {}
        # 状态轮询不改变按钮状态，只有真正的启停操作才临时禁用，避免每 2 秒闪动。
        idle = not self.busy
        for service in SERVICES:
            unit = service['unit']
            info = statuses.get('services', {}).get(unit)
            active = info.get('active') if info else None
            row = self.service_rows[unit]
            set_enabled(row['buttons']['start'], idle and active is False)
            set_enabled(row['buttons']['stop'], idle and active is True)
            set_enabled(row['buttons']['restart'], idle and active is True)
        set_enabled(self.open_button, bool(statuses.get('panel') and statuses['panel'].get('ready')))
        set_enabled(self.refresh_button, idle)

    def refresh(self):
        if self.future is None and not self.closed:
            self.operation = 'status'
            self.future = self.pool.submit(collect_status)
            self.update_controls()

    def execute(self, action, unit):
        if self.busy:
            return
        names = {'start': '正在启动', 'stop': '正在停止', 'restart': '正在重启'}
        self.message(f'{names[action]} {unit} …', 'accent')
        self.last_unit = unit
        self.operation = action
        if self.future is not None:
            self.pending = (action, unit)
        else:
            self.begin(action, unit)
        self.update_controls()

    def begin(self, action, unit):
        self.operation = action
        self.future = self.pool.submit(self.work, action, unit)
        self.update_controls()

    def work(self, action, unit):
        code, _, error = run(['systemctl', '--user', action, unit], timeout=30)
        if code != 0:
            raise OSError(f'{unit} {action} 失败：{error or "未知错误"}')
        time.sleep(0.4)
        return collect_status()

    def open_web(self):
        try:
            subprocess.Popen(
                ['xdg-open', panel_url()],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, start_new_session=True,
            )
        except OSError as error:
            self.message(f'浏览器启动失败：{error}', 'error')

    def render(self, data):
        self.last_result = data
        for service in SERVICES:
            unit = service['unit']
            row = self.service_rows[unit]
            info = data['services'][unit]
            if info['active']:
                title, role = '● 运行中', 'ok'
            elif info['state'] in ('activating', 'reloading'):
                title, role = '● 启动中', 'warn'
            elif info['state'] == 'failed':
                title, role = '● 启动失败', 'error'
            else:
                title, role = '○ 已停止', 'muted'
            set_text(row['status'], title)
            if self.status_roles.get(unit) != role:
                self.status_roles[unit] = role
                self.tint(row['status'], role)
            detail = f"状态 {info['state']}"
            if unit == 'nginx-ipzz.service':
                ports = '/'.join(str(port) for port in data['listeners']) or '无'
                detail += f'    监听端口 {ports}'
            elif data.get('panel'):
                panel = data['panel']
                detail += f"    规则 {panel['rules']}（启用 {panel['enabled']}）· {panel['mode']}模式"
            set_text(row['detail'], detail)
        self.update_controls()
        if data.get('panel') and data['panel'].get('ready'):
            self.message('服务正常。修改转发规则请点「打开 Web 面板」。', 'muted')
        elif data['services']['nginx-control.service']['active']:
            self.message('面板服务已运行，接口尚未就绪，请稍候。', 'warn')
        self.update_log(data['log'])

    def update_log(self, log):
        if log == self.log_text:
            return
        scroll = self.logs.verticalScrollBar()
        at_bottom = scroll.value() >= scroll.maximum() - 2
        self.logs.setPlainText(log)
        scroll.setValue(scroll.maximum() if at_bottom else scroll.value())
        self.log_text = log

    def tick(self):
        if self.closed or self.future is None or not self.future.done():
            return
        future, action = self.future, self.operation
        self.future = self.operation = None
        try:
            data = future.result()
        except Exception as error:
            self.message(str(error), 'error')
            self.update_controls()
        else:
            if action != 'status':
                unit = self.last_unit
                messages = {'start': '已启动', 'stop': '已停止', 'restart': '已重启'}
                self.message(f'{unit} {messages.get(action, action)}。', 'accent')
            self.render(data)
        if self.pending is not None:
            action, unit = self.pending
            self.pending = None
            self.begin(action, unit)

    def closeEvent(self, event):
        self.closed = True
        self.tick_timer.stop()
        self.poll_timer.stop()
        self.pool.shutdown(wait=False, cancel_futures=True)
        event.accept()


def show_controller():
    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    app.setStyle('Fusion')
    window = Controller()
    window.show()
    return app.exec_()
