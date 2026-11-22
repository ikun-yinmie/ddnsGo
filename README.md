# ddnsGo 部署套件

围绕 [ddns-go](https://github.com/jeessy2/ddns-go) v6 的家庭服务器自部署套件。解决一个典型场景:**家庭宽带只有动态 IPv6 公网地址**,需要稳定对外提供 HTTP/HTTPS 服务 —— 动态域名、子域名反代、服务入口路由,三件套一次配好。

> 二进制与第三方工具(ddns-go、nginx、acme.sh)不随仓库分发,请从官方渠道下载,见下文。

## 组成

| 部分 | 用途 |
|---|---|
| [安装说明.md](安装说明.md) | ddns-go 官方二进制部署为 systemd 用户服务:Cloudflare DDNS + IPv6,含 API Token 创建、AAAA 记录、开机自启完整步骤 |
| [get-ipv6.py](get-ipv6.py) | IPv6 源地址选择脚本:按当前默认路由选择全球单播地址,拒绝弃用/未就绪地址;给 ddns-go 的「命令获取 IPv6」方式使用,避免运营商换前缀后解析残留旧地址 |
| [Nginx/](Nginx/) | 便携版 Nginx 反代:子域名 → 本机端口 规则化维护,自动生成配置、`nginx -t` 校验失败自动回滚、reload 生效;配合 acme.sh 签发泛域名证书 |
| [worker/service-router.js](worker/service-router.js) | Cloudflare Worker 服务路由:对外提供统一服务目录页,自动探活并跳转到可达入口(Cloudflare 优选代理通道 / IPv6 直连通道),管理面板存 KV,密码走 Worker Secret |

## 快速开始

### 1. DDNS(ddns-go)

按 [安装说明.md](安装说明.md) 操作即可,要点:

1. 下载 ddns-go 单文件,配置 systemd 用户服务(自动重启 + linger 常驻)
2. Cloudflare 创建 `Zone.DNS Edit` Token,Web 界面(默认 `127.0.0.1:9876`)里配置
3. IPv6 获取方式选「命令」,填入本套件的 `get-ipv6.py`(先复制到 `~/.config/ddns-go/`)

### 2. 子域名反代(Nginx)

```bash
cd Nginx
# nginx.conf 与 control/control.py 里的路径按自己环境调整后:
python3 control/control.py        # 控制台 http://127.0.0.1:8790
```

- 控制台里维护「子域名 → 本机端口」规则,「校验并生效」自动:生成 `conf.d/apps.conf` → `nginx -t` → 失败回滚 → 成功 reload
- 证书目录默认读 `~/.config/ddns-go/acme/`(acme.sh DNS 验证签发的泛域名证书,配置见 control/README.md)
- 详见 [Nginx/control/README.md](Nginx/control/README.md);生成配置的格式见 [Nginx/conf.d/apps.example.conf](Nginx/conf.d/apps.example.conf)

### 3. 服务路由(Cloudflare Worker)

```bash
# Cloudflare Dashboard → Workers → 新建 Worker,粘贴 worker/service-router.js
# 绑定:
#   KV 命名空间,变量名 CONFIG(存服务列表与设置)
#   Secret:ADMIN_PASSWORD(管理面板密码)
```

- 访问 Worker 地址得到服务目录页:每个服务同时探测 Cloudflare 代理入口与 IPv6 直连入口,自动跳转最快可达的
- 管理面板在 `worker地址/admin`,可增删服务、改别名/图标、扫描站点图标
- 首次部署未绑定 KV 时使用内置默认配置(域名是示例,自行修改)

## 目录结构

```
ddnsGo/
├── 安装说明.md            # ddns-go 部署完整步骤
├── get-ipv6.py            # IPv6 源地址选择脚本
├── Nginx/                 # 便携 nginx + 子域名控制台
│   ├── nginx.conf         # 主配置(路径需按环境调整)
│   ├── conf.d/            # 生成的反代规则(运行时文件,不入库)
│   ├── control/           # Web 控制台(纯标准库 Python)
│   └── root/etc/nginx/    # Debian nginx 配置模板(mime.types 等)
├── worker/service-router.js  # Cloudflare Worker 服务路由(单文件)
└── docs/                  # 上游 ddns-go README 备份
```

## 上游与许可

- 核心 DDNS 能力来自 [jeessy2/ddns-go](https://github.com/jeessy2/ddns-go)([LICENSE](LICENSE))
- 本仓库其余脚本与控制台为自己编写,随意取用
- nginx / acme.sh 分别遵循其自身许可
