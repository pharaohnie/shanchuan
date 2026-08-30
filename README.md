# 闪传

浏览器端到端加密文件传输工具。发送方与接收方通过口令配对，数据经 PAKE 协商密钥后 AES-GCM 加密传输；优先尝试 WebRTC 点对点直连，不可用时自动降级到中继转发。

![闪传界面截图](docs/screenshot.png)

## 功能特点

- **端到端加密**：PAKE 口令认证 + AES-GCM 加密，中继服务器无法解密文件内容
- **口令与房间 ID 解耦**：加入房间时发送口令哈希，降低口令明文暴露面
- **智能传输路径**：STUN 直连优先，可选 TURN 提升跨网段成功率，失败时回退 WebSocket 中继
- **多文件与文本**：支持拖拽多选文件、纯文本发送；接收方可流式下载大文件
- **零账号**：无需注册登录，分享口令即可传输
- **安全加固**：限流防暴力枚举、CSP 安全头、文件名消毒、AAD 绑定防篡改、公网 `ws://` 明文拦截

## 环境要求

| 依赖 | 版本 |
|------|------|
| [Go](https://go.dev/dl/) | 1.26+ |
| [Node.js](https://nodejs.org/) | 18+（仅运行测试时需要） |

## 快速开始

### 1. 克隆仓库

```bash
git clone <repo-url> croc-wasm
cd croc-wasm
```

### 2. 构建

```bash
./build.sh
```

构建产物：

- `relay/relay-server` — WebSocket 中继服务（同时托管前端静态资源）
- `public/croc.wasm` — Go 编译的加密 WASM 模块
- `public/wasm_exec.js` — Go WASM 运行时

### 3. 启动服务

```bash
cd relay && ./relay-server
```

默认监听 `http://localhost:8154`，在浏览器打开该地址即可使用。

配置文件位于项目根目录 `config.yaml`，中继启动时会自动查找。也可手动指定：

```bash
./relay-server -config ../config.yaml
```

### 4. 使用流程

**发送方**

1. 点击「发送」，选择文件或输入文本
2. 点击「开始发送」，复制生成的口令码
3. 将口令码分享给接收方，等待传输完成

**接收方**

1. 点击「接收」，输入发送方分享的口令码
2. 点击「接收文件」，等待下载或查看文本

## 配置说明

编辑 `config.yaml` 可调整监听地址、CORS/WebSocket Origin 白名单、房间上限、限流阈值、CSP 策略等。生产部署时请注意：

- 将 `cors.allowed_origins` 与 `websocket.allowed_origins` 改为实际前端域名
- 使用 HTTPS/WSS（前置反向代理或 TLS 终止）
- 按需设置 `client.relay_url` 为完整的 `wss://` 地址
- 按需设置 `client.public_url` 为分享链接前缀（如 `https://croc.example.com`）
- 跨网段提高 P2P 成功率时，部署 TURN 并配置 `client.ice_servers`（见下文）

### 域名与反代分工

典型生产架构：**前端走 HTTPS 反代，TURN 直连应用服务器**。

| 域名 | DNS 指向 | 用途 | 反代方式 |
|------|----------|------|----------|
| `croc.example.com` | 反代服务器公网 IP | 闪传页面、WebSocket 信令 | 反代 → `relay-server` 监听端口 |
| `turn.croc.example.com` | **应用服务器公网 IP** | WebRTC TURN 媒体中继 | **不要**经 HTTP 反代；浏览器直连 UDP/TCP |

说明：

- WebSocket 中继（`wss://croc.example.com/ws`）走 HTTPS 反代即可。
- TURN 依赖 **UDP**（3478 + 49152–65535），常见 HTTP 反代无法可靠转发，必须在 relay 同机或可达公网 IP 上单独部署 coturn。
- `turn.croc.example.com` 与 `croc.example.com` 是**两个独立 A 记录**；未给 TURN 配 DNS 时，可在 `ice_servers` 中暂时写公网 IP（见下）。

### TURN 服务器（coturn）

**作用**：当两端 NAT/防火墙导致 UDP 打洞失败时，WebRTC 经 TURN 转发流量；UI 仍显示「直连 (P2P)」，与 WebSocket「中继转发」不同。

**部署文件**：[`deploy/coturn/`](deploy/coturn/)（`docker-compose.yml` + `turnserver.conf` + `install.sh`）。

在应用服务器（与 `relay-server` 同机）上：

```bash
sudo cp -r deploy/coturn /opt/coturn
cd /opt/coturn
# 编辑 turnserver.conf：external-ip、user=用户名:密码
sudo ./install.sh
```

**防火墙 / 安全组**（应用服务器入站）：

| 端口 | 协议 | 用途 |
|------|------|------|
| 3478 | UDP + TCP | TURN/STUN |
| 49152–65535 | UDP | coturn 媒体端口段 |

**验证 TURN**（在任意能访问公网的服务器上）：

```bash
docker run --rm coturn/coturn turnutils_uclient -y -v \
  -u <用户名> -w '<密码>' <公网IP或turn域名>
```

成功时应看到 relay 分配且无持续丢包。

### `config.yaml` 中的 ICE 配置

TURN 账号密码通过 `GET /api/config` 下发给浏览器（WebRTC 常见做法）。`turnserver.conf` 里 `user=` 的密码须与 `credential` **完全一致**。

```yaml
client:
  public_url: "https://croc.example.com"
  ice_servers:
    - urls: "stun:stun.cloudflare.com:3478"
    # 方式 A：公网 IP（不依赖 TURN 域名 DNS，推荐先用于联调）
    - urls: "turn:turn.croc.example.com:3478?transport=udp"
      username: "turnuser"
      credential: "<与 turnserver.conf 相同>"
    - urls: "turn:turn.croc.example.com:3478?transport=tcp"
      username: "turnuser"
      credential: "<与 turnserver.conf 相同>"
```

留空 `ice_servers` 时，前端仅使用 Cloudflare STUN；跨复杂 NAT 时更容易回退到 WebSocket 中继。

修改 `config.yaml` 或 coturn 配置后，需**重启 `relay-server`** 并**硬刷新**浏览器。

**传输路径优先级**（简要）：

1. STUN 打洞直连（最快）
2. TURN 中继（仍属 WebRTC P2P 通道）
3. WebSocket 中继（页面显示「中继转发」）

调试：浏览器控制台执行 `localStorage.setItem('croc-debug','1'); location.reload();`，可查看 ICE 状态与 `P2P negotiate -> p2p` / `relay` 原因。

## 测试

```bash
# 前端安全与传输策略
node --test tests/*.test.mjs

# 中继服务
go test ./relay/...
```

## 项目结构

```
croc-wasm/
├── deploy/
│   └── coturn/      # TURN（coturn）Docker 部署与配置
├── docs/            # 文档与截图
├── public/          # 前端静态资源（HTML / JS / CSS / WASM）
├── relay/           # Go WebSocket 中继服务
├── wasm/            # Go WASM 加密模块（PAKE + AES-GCM）
├── tests/           # Node.js 单元测试
├── config.yaml      # 中继服务配置
└── build.sh         # 一键构建脚本
```

