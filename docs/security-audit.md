# 依赖与构建安全记录

最后运行：2026-11-18 22:27 CST

环境：`go version go1.27.0 linux/amd64`、`govulncheck v1.10.0`、Node v22.22.0。

## 1. Go 漏洞扫描

### relay（原生服务）

```bash
go run golang.org/x/vuln/cmd/govulncheck@latest ./relay/
```

结果：**7 个可达漏洞，全部来自当前 Go 标准库**，不在项目代码或第三方模块里。均已在 Go 补丁版本修复：

| 编号 | 包 | 修复版本 |
| --- | --- | --- |
| GO-2026-6859 | net/http | go1.27.4 |
| GO-2026-6617 | net/http/internal/http2 | go1.27.2 |
| GO-2026-6613 | net/http | go1.27.2 |
| GO-2026-6612 | net/http/internal/http2 | go1.27.2 |
| GO-2026-6611 | net/http/internal/http2 | go1.27.2 |
| GO-2026-6609 | net/http | go1.27.2 |
| GO-2026-6603 | net/http/internal/http2 | go1.27.2 |

可达路径包括 `http.Server.ListenAndServe`、静态文件处理和 WebSocket 升级。

**行动**：构建和部署使用 **Go >= 1.27.4**（或包含同等修复的 1.26.x 补丁版）。这不需要改业务代码，但必须在发布前升级工具链；当前环境用的 1.27.0 不满足。

### wasm（浏览器模块）

```bash
GOOS=js GOARCH=wasm govulncheck ./wasm/
```

结果：**0 个可达漏洞**。另有 1 个依赖包、14 个依赖模块中的漏洞，但调用图未触达。

### 复跑方式

```bash
go install golang.org/x/vuln/cmd/govulncheck@latest
$(go env GOPATH)/bin/govulncheck ./relay/
GOOS=js GOARCH=wasm $(go env GOPATH)/bin/govulncheck ./wasm/
```

## 2. 第三方依赖

`go.mod` 直接依赖：

- `github.com/gorilla/websocket v1.5.3`
- `github.com/schollz/pake/v3 v3.1.1`
- `gopkg.in/yaml.v3 v3.0.1`

前端没有 `package.json`，没有 npm/pnpm 依赖，因此没有 JS 依赖树可扫描。govulncheck 使用 OSV 数据源；当前环境未额外安装 `osv-scanner`，Go 部分已由 govulncheck 覆盖。

## 3. 构建产物

`build.sh` 在生成 `public/croc.wasm` 后写入 `public/croc.wasm.sha256`。发布时把该哈希一并记录，部署后可用下面的命令校验：

```bash
sha256sum -c public/croc.wasm.sha256
```

## 4. coturn 镜像

`deploy/coturn/docker-compose.yml` 固定到镜像 digest，不使用 `latest`；升级流程见 `deploy/coturn/README.md` 第 5 节。

## 5. 未覆盖

- 未做历史镜像/构建缓存的可复现构建（Go 构建本身未加 `-trimpath`/`-buildvcs=false`）。
- 未扫描部署主机、NPM 容器或 coturn 二进制的 CVE，只固定了镜像 digest。
