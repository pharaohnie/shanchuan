# coturn 部署（192.168.1.100）

TURN 必须直连应用服务器，**不能**经 NPM（43.255.200.131）反代 UDP。

## 1. DNS

| 记录 | 类型 | 值 |
|------|------|-----|
| `turn.sc.bjedu.pro` | A | `192.168.1.100` |

未配置 DNS 前，可在 `config.yaml` 使用 `turn:192.168.1.100:3478`（当前默认）。

## 2. 防火墙（172 上）

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
cd /opt/coturn   # 或复制本目录到服务器
docker compose up -d
docker compose logs -f
```

`turnserver.conf` 中的 `user=` 密码须与项目根目录 `config.yaml` 里 `client.ice_servers` 的 `credential` 一致。

## 4. 验证

```bash
docker run --rm coturn/coturn turnutils_uclient -v \
  -u shanchuan -w 'j080mbaeIL7PlBBtQm7bedcc' turn.sc.bjedu.pro
```

成功输出应包含 relay 分配信息。
