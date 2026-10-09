# 单 VPS 部署

[English](deployment-vps.md) · [README](../README.zh-CN.md)

准备一台 Linux VPS、指向它的公网域名、开放的 80/443 端口，以及 Docker Engine 和 Compose。Relay 只运行一个进程，不添加副本，不将 SQLite 放在网络文件系统上。编程运行时位于另行配对的设备上。

## 配置与启动

先按[安装指南](installation.zh-CN.md)获取对应版本的 checkout 并安装 CLI。在所有者电脑上运行：

```sh
agenvo-server init --origin https://relay.example.com \
  --data-dir /data --host 0.0.0.0 --port 8080 --trusted-proxy \
  --output deploy/vps/relay.local.json
```

命令只生成不含秘密的 Relay 配置。将该文件放到 VPS 的 `deploy/vps/relay.local.json`。另在密码管理器生成并保存至少 32 随机字节编码为 hex 或 base64url 的管理员密钥，在 VPS 的 `deploy/vps/.env` 中设置 `AGENVO_DOMAIN=relay.example.com` 和 `AGENVO_ADMIN_SECRET=<生成的密钥>`。Compose 将它注入 Relay。环境文件必须为 0600，不能提交到 Git。

在 VPS 的仓库根目录运行：

```sh
mkdir -p deploy/vps/data
sudo chown 1000:1000 deploy/vps/data deploy/vps/relay.local.json
sudo chmod 700 deploy/vps/data
sudo chmod 600 deploy/vps/relay.local.json
docker compose --env-file deploy/vps/.env -f deploy/vps/compose.yaml up -d --build
curl --fail https://relay.example.com/health
```

镜像中的 `node` 用户 UID 为 1000。Caddy 自动申请和续期公网证书。只有 Caddy 暴露端口，不应暴露 8080。代理必须保留原始 Host 请求头。后续 Compose 命令同样传入 `--env-file deploy/vps/.env`。

随后[配对设备并授权 MCP 客户端](usage.zh-CN.md)。打开 `/admin` 使用管理员密钥登录。

## 不使用 Docker

安装 Node.js 24.13+，在 `/opt/agenvo` 构建仓库。创建独立的 `agenvo` 系统用户，将 `/var/lib/agenvo` 设为该用户所有、权限 0700，并准备该用户可读的 `/etc/agenvo/relay.json`。生成配置时使用 `--data-dir /var/lib/agenvo --host 127.0.0.1 --trusted-proxy`，只将这份配置传到服务器。在 `/etc/agenvo/admin.env` 设置 `AGENVO_ADMIN_SECRET=<生成的密钥>`，文件由 root 所有、权限为 0600。按实际 Node 路径调整并安装 [agenvo.service](../deploy/vps/agenvo.service)，通过 systemd 启动。Caddy 或其他 HTTPS 代理转发到 `127.0.0.1:8080`，保留 Host 和 WebSocket 升级头。

配置也可增加 `tls` 对象，以绝对路径指定 `cert` 和 `key`，由 `agenvo-server serve` 直接提供 TLS。证书续期和轮换后重启由运维者负责。HTTP 只用于内部代理链路，公网地址和 Connector 连接必须使用 HTTPS/WSS。

## 备份与重启

文件备份前先停止 Relay，复制整个数据目录、公开配置和代理配置。管理员密钥另行加密备份。运行期间不能只复制 `agenvo.sqlite`，较新的事务可能仍在 WAL 文件中。

重启同一 Compose 项目时复用数据目录，保留设备配对和 OAuth 授权。重启中断的在途调用结果不确定，重复写操作前先查询原生状态。Connector 会自动重连，Herdr 独立运行。

更换管理员密钥后重启 Relay，已有网页会话失效；需要撤销设备和 OAuth 授权时，分别在管理页操作。

## 代理与 OAuth 限制

`--trusted-proxy` 只信任一层反向代理，并按其转发的客户端地址限流。只有 Relay 完全位于该代理之后、外界不能绕过代理直连时才启用；代理必须覆盖不可信的转发头。Caddy 的默认代理配置提供此边界。直接 TLS 部署应保持关闭，此时忽略传入的转发头。公开配对每个客户端地址每十分钟最多十次。未配置可信代理时，代理后所有客户端共用该限制。

VPS OAuth 回调只支持 HTTPS 或回环 HTTP，不支持应用自定义 scheme。未经批准的注册一小时后过期，等待过久需要客户端重新注册。注册容量为 256，并受 SDK 的每客户端地址限流约束。

## 日志

Relay 和 Connector 向 stderr 输出结构化 JSON Lines，CLI 命令结果保留在 stdout。字段、级别与关联方法参见[读取日志](logging.zh-CN.md)。
