# coturn 部署

TURN 必须直连应用服务器公网 IP，**不能**经 HTTP 反代转发 UDP。

`docker-compose.yml` 无需修改。将 `turnserver.conf.example` 复制为 `turnserver.conf` 后填写生产值（`turnserver.conf` 已加入 `.gitignore`）。

## 1. DNS

| 记录 | 类型 | 值 |
|------|------|-----|
| `turn.example.com` | A | 应用服务器公网 IP（示例 `203.0.113.1`） |

未配置 DNS 前，可在 `config.yaml` 使用 `turn:203.0.113.1:3478`。

## 2. 防火墙

放行入站：

- UDP + TCP **3478**
- UDP **49152–65535**

示例（ufw）：

```bash
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 49152:65535/udp
```

云厂商安全组需同步放行上述端口。

## 3. 启动

```bash
cp turnserver.conf.example turnserver.conf
# 编辑 turnserver.conf：external-ip、static-auth-secret（与 config.yaml turn.auth_secret 相同）

cd /opt/coturn   # 或复制本目录到服务器
docker compose up -d
docker compose logs -f
```

`turnserver.conf` 使用 `use-auth-secret` + `static-auth-secret`；该 secret 须与项目根目录 `config.yaml` 里 `turn.auth_secret` **完全一致**。不要配置静态 `user=` 行。

修改 `turnserver.conf` 后：

```bash
docker compose restart
```

## 4. 验证

```bash
# 1. 从 relay 取临时凭据
curl -s https://croc.example.com/api/config | jq '.ice_servers[] | select(.urls | contains("turn"))'

# 2. 用返回的 username / credential 测试
docker run --rm --network host coturn/coturn turnutils_uclient -y -v \
  -u '<username>' -w '<credential>' turn.example.com
```

成功输出应包含 relay 分配信息。
