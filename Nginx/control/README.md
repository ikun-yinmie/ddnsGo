# Nginx Control

本机 Web 控制台，管理专用 nginx（`nginx-ipzz.service`）的反代配置：维护「子域名 → 本机端口」规则，自动生成 `conf.d/apps.conf`，校验后重载生效。监听 `127.0.0.1:8790`，仅本机可访问。

## 启动

```bash
systemctl --user status nginx-control
# 手动运行：python3 control.py
```

打开 [http://127.0.0.1:8790/](http://127.0.0.1:8790/)。

## 双击启动（Linux）

双击上级目录的 **NginxControl.desktop**：自动确保 `nginx-ipzz` 和 `nginx-control` 两个服务已启动，然后打开控制台页面；关浏览器不影响后台服务。右键图标可选「重启反代与控制台」「停止反代与控制台」。命令行等价：`python3 launch-control.py`（`--stop` / `--restart` / `--status` / `--no-browser`）。

## 面板端口

面板默认监听 `127.0.0.1:8790`，端口保存在 `.runtime/preferences.json`。Web 面板的「面板端口」设置区可修改：应用后面板自动重启，浏览器 3 秒后跳转新地址，桌面控制窗口与双击入口自动跟随。`control.py --port 9876` 可临时覆盖一次。

## 两种模式

- **规则模式**：表格维护域名、本机端口、启用开关。「校验并生效」会生成配置 → `nginx -t` → 失败自动回滚 → 成功后重载 nginx。「仅保存」只存规则不改 nginx。
- **原文模式**：直接编辑生成的 `apps.conf` 全文，适合 server 块需要特殊指令的场景，同样走校验与回滚管线。

## 应用管线

1. 备份当前 `conf.d/apps.conf` 为 `apps.conf.backup`。
2. 生成/写入新配置。
3. `~/.config/ddns-go/bin/nginx -t` 校验。
4. 失败 → 自动恢复备份并在页面报错；成功 → `systemctl --user reload nginx-ipzz.service`。

「恢复备份」按钮把 `apps.conf.backup` 写回并重载。

## 注意

- 新增子域名需同时在 ddns-go 的 IPv6 Domains 加一行，AAAA 记录才会创建。
- 证书路径指向 acme.sh 的通配符证书目录；`nginx.conf` 主文件不归本控制台管理。
- 状态与原文内容保存在 `control-state.json`。

服务日志分别写入 `Nginx/logs/service.log`（反代）与 `Nginx/logs/control.log`（面板）。桌面窗口日志区右键「清空日志」可真实清空这两个文件；nginx 自身的 access/error 日志不受影响。
