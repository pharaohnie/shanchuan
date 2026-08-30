# 闪传（croc-wasm）安全审计报告

| 项目 | 内容 |
| --- | --- |
| 审计日期 | 2026-08-30 |
| 审计基线 | `068add7`（main） |
| 审计范围 | `public/`、`relay/`、`wasm/`、`config.yaml`、`build.sh`、`tests/`，约 4300 行，全量人工阅读 |
| 基线状态 | `go vet ./...` 无告警；Go 单测 12 项全过；Node 单测 11 项全过 |
| 结论 | 发现 18 项问题：严重 2、高危 4、中危 5、低危 7。当前状态下项目对外宣称的端到端加密不成立 |

审计方式为逐文件人工阅读加数据流追踪，未做动态渗透测试、未做依赖 CVE 扫描。
GitNexus 未启用污点分析层（`analyze --pdg`），因此本报告不含自动化 source→sink 结论。

---

## 严重问题

### C1 — 中继服务器可完全解密并篡改传输内容

**位置**

```497:497:public/app.js
			ws.send(JSON.stringify({ type: "join", room: state.code }));
```

```565:565:public/app.js
			await wasmCall("wasmInitPAKE", role, state.code);
```

**问题**

同一个 `state.code` 承担了两个互相冲突的角色：既是中继用于房间配对的路由标识，又是 PAKE 的共享口令。前者必须以明文发给中继，后者的全部安全性建立在"中间人不知道它"这一个前提上。

**影响**

中继服务器在收到 join 帧的那一刻就拿到了 PAKE 口令。它可以分别与发送方、接收方各完成一次合法的 PAKE 握手，得到两把有效会话密钥，从而完整读取和任意篡改文件内容，而两端客户端都不会收到任何异常信号——PAKE 的密钥确认在两条独立的会话上都是通过的。

攻击面不限于中继运营者本身：在 `relay_url` 为空、页面通过 `http://` 提供的部署下（见 M10），`deriveRelayURL` 会回落到 `ws://`，此时同网段的任何被动旁观者抓到 join 帧即可实施同样的攻击。

**修复方向**

房间标识与口令解耦。前端只把域分隔后的哈希发给中继：

```
roomId = hex(SHA-256("croc-wasm/room/v1" || code))
```

PAKE 仍然使用原始 `code`。中继侧逻辑无需改动（它只转发字符串，现有 128 字符的房间名长度上限对 64 字符 hex 足够）。

需要注意口令强度：当前 10 位 62 进制约 2^59.5，离线爆破房间哈希代价很高但并非无穷；若要进一步提高成本可将口令加长到 12 位，或改用带迭代的 KDF 派生房间 ID。

**兼容性**：此改动会使新旧客户端握手不兼容。但发送方与接收方的静态资源都由同一个中继提供、同时更新，实际不构成兼容性问题。

---

### C2 — 中继进程会被正常使用打崩

**位置**

```196:201:relay/main.go
	if room.first != nil {
		errMsg, _ := json.Marshal(RelayMessage{Type: "error", Msg: reason})
		room.first.WriteMessage(websocket.TextMessage, errMsg)
		room.first.Close()
		room.first = nil
	}
```

```235:248:relay/main.go
	forward := func(src, dst *websocket.Conn) {
		defer wg.Done()
		defer dst.Close()
		for {
			msgType, msg, err := src.ReadMessage()
			if err != nil {
				return
			}
			logTransportMode(room, msgType, msg)
			if err := dst.WriteMessage(msgType, msg); err != nil {
				return
			}
		}
	}
```

**问题**

`Room.expire` 由 `cleanupLoop` 的 goroutine 调用，向 `room.first` 写消息；同时 `pipeConnections` 中的 `forward(b, a)` goroutine 也在向同一个连接写。`room.mu` 并没有起到串行化作用——`forward` 完全不持有该锁。

gorilla/websocket v1.5.3 对检测到的并发写直接 panic（`conn.go:617`、`624`、`745`、`750`：`panic("concurrent write to websocket connection")`）。该 panic 发生在 `forward` goroutine 中，**不在 net/http 的 recover 覆盖范围内，会导致整个中继进程退出**。

**影响**

触发不需要攻击者配合。过期判据用的是创建时间而非最后活动时间：

```214:214:relay/main.go
			if time.Since(room.createdAt) > 30*time.Minute {
```

因此任何走中继回退、持续超过 30 分钟的传输都会命中，进程退出会连带中断当时所有其他用户的传输。可用性影响是全局的。

**修复方向**

三个方向可选，建议同时做前两项：

1. `expire` 不再直接写连接，只 `Close()`；结束原因通过其他途径传达，或接受不传达。
2. 为 `Room` 增加专用写锁，让所有对该连接的写（包括 `forward` 内的）都经过它。
3. 将过期判据从 `createdAt` 改为最后活动时间，避免误杀长时传输。

---

## 高危问题

### H3 — 限流可被伪造请求头绕过

**位置**：`config.yaml:38`、`relay/config.go:63-67`、`relay/ratelimit.go:39-49`

出厂配置为 `trust_forwarded_ip: true`，而代码里的 `defaultConfig()` 未设置该字段（即 false），两处默认值不一致。`clientIPWithTrust` 在该开关打开时无条件采信 `X-Forwarded-For` 的第一段：

```39:49:relay/ratelimit.go
	if trustForwardedIP {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			if ip := strings.TrimSpace(parts[0]); ip != "" {
				return ip
			}
		}
		if xri := strings.TrimSpace(r.Header.Get("X-Real-IP")); xri != "" {
			return xri
		}
	}
```

**影响**

若中继直连暴露而非部署在反向代理之后，攻击者每个请求换一个 `X-Forwarded-For` 即可使 join 与 stun-check 限流完全失效。join 限流是口令暴力枚举的唯一防线，同时也是 H4 中资源耗尽攻击的唯一节流阀。

**修复方向**：引入受信代理 CIDR 白名单，仅当 `r.RemoteAddr` 落在白名单内时才读取转发头；代码与配置的默认值统一为 false，并在配置注释中写明启用前提。

### H4 — 房间数与限流表均无上界，服务端无超时

**位置**：`relay/main.go:314`、`relay/main.go:404`、`relay/ratelimit.go:17`

三个独立的资源问题叠加：

1. 第一个客户端在 `<-room.ready`（`main.go:314`）上阻塞期间**没有读循环**，对端断开无法感知，房间会一直占用到 30 分钟清理周期。
2. `Relay.rooms` 没有总数上限，`ipRateLimiter.counters` map 永不清理、按 key 单调增长——配合 H3 的 XFF 伪造，key 空间是无界的。
3. `http.ListenAndServe`（`main.go:404`）未配置任何超时，存在 Slowloris 风险（对应 gosec G114）。

**修复方向**：设置全局房间上限；按最后活动时间回收空闲房间；为限流表增加定期清理；改用 `&http.Server{ReadHeaderTimeout, ReadTimeout, WriteTimeout, IdleTimeout}`；在 WebSocket 层加 `SetReadDeadline` 与 ping/pong 保活。

### H5 — 房间过期与第二客户端加入存在竞态

**位置**

```329:343:relay/main.go
	} else if room.second == nil {
		room.second = conn
		room.mu.Unlock()

		pairedFirst, _ := json.Marshal(RelayMessage{Type: "paired", Role: "sender"})
		pairedSecond, _ := json.Marshal(RelayMessage{Type: "paired", Role: "receiver"})

		room.mu.Lock()
		room.first.WriteMessage(websocket.TextMessage, pairedFirst)
		room.second.WriteMessage(websocket.TextMessage, pairedSecond)
		room.mu.Unlock()

		close(room.ready)

		<-room.done
```

第二个客户端先设置 `room.second` 并解锁，随后重新加锁去写 `room.first`。若这一间隙内 `expire` 已执行（把两个连接置 nil 并 close 了 `ready`），则第 337 行是 nil 指针解引用，第 341 行是重复 `close` 已关闭的 channel。两者都会 panic。

这两个 panic 位于 http handler goroutine 内，会被 net/http 兜住，因此后果是连接被打断加 goroutine 泄漏，而非进程崩溃（区别于 C2）。

**附带问题**：一旦第一个客户端分支提前 return（`main.go:320-322`）或 panic，`room.done` 永不 close，第二个客户端在第 343 行 `<-room.done` 上**无超时永久阻塞**，goroutine 与连接永久泄漏。

**修复方向**：把 `room.second` 赋值到配对通知的整个过程放在单次持锁内完成；`close(room.ready)` 改用与 `expire` 一致的 select 幂等写法；`<-room.done` 增加超时。

### H6 — 装饰性背景引入致命供应链面

**位置**

```7:7:public/bg.js
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js";
```

```43:43:config.yaml
  content_security_policy: "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net 'wasm-unsafe-eval'; connect-src 'self' ws: wss: stun:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; worker-src 'self'"
```

**影响**

对一个端到端加密应用而言，允许第三方 CDN 执行脚本意味着 CDN 投毒或 DNS 劫持可直接在页面内获得任意 JS 执行权，进而读取 `state.sessionKeyBytes` 与全部明文。ES module 的 `import` 语句无法用 SRI 保护，`'wasm-unsafe-eval'` 的存在也扩大了可利用面。

而这个背景纯粹是装饰——所有调用点均为 `window.bgFX?.` 可选链，缺失时功能不受影响。

**修复方向**：把 `three.module.js` 自托管到 `public/vendor/`，CSP 收紧为 `script-src 'self' 'wasm-unsafe-eval'`。

---

## 中危问题

### M7 — AAD 只绑定 chunk 序号，不绑定文件，跨文件拼接不可检出

发送端与接收端的 AAD 分别是：

```737:737:public/app.js
		return wasmCall("wasmEncrypt", keyBytes, encodeSeq(i), chunkData);
```

```804:805:public/app.js
	const aad = state._metadataReceived ? encodeSeq(state.currentChunk) : null;
	const decrypted = await wasmCall("wasmDecrypt", state.sessionKeyBytes, aad, data);
```

批量传输中每个文件的 seq 都从 0 重新计数，AAD 里既没有 `fileIndex` 也没有会话标识。由于 GCM nonce 随密文一起传输，攻击者把文件 A 的第 k 块整体替换为文件 B 的第 k 块，认证校验依然通过，结果是**静默数据损坏**。

元数据帧的 AAD 为 null（`app.js:695`），可被重放或换序。

另有一处线索：`state.transferId`（`app.js:96`）已声明但从未被赋值或读取，从命名看本就是打算纳入 AAD 的。

**修复方向**：AAD 改为 `transferId || fileIndex || seq` 的拼接；元数据帧也带 AAD，使用一个保留序号（如 `0xFFFFFFFFFFFFFFFF`）与数据块区分。

### M8 — 截断的文件被静默零填充

```879:880:public/app.js
			state.merged = new Uint8Array(metadata.size);
			state.mergeOffset = 0;
```

```905:911:public/app.js
		const nextOffset = state.mergeOffset + decrypted.length;
		if (nextOffset > state.receivedMetadata.size) {
			throw new Error("Received data exceeds declared file size");
		}
		state.merged.set(decrypted, state.mergeOffset);
		state.mergeOffset = nextOffset;
	}
```

接收缓冲区按声明大小预分配且零初始化，校验只检查写入量是否**超出**声明大小，从不检查结束时 `mergeOffset === metadata.size`。发送方少发数据时，`currentChunk >= totalChunks` 一到就调用 `finishCurrentFile()`，用户得到一个尾部全为 `0x00` 的"完整"文件，界面显示接收成功。streaming 分支的 `bytesWritten` 校验（`app.js:899-903`）同理只有上界。

**修复方向**：在 `finishCurrentFile` 中断言实际写入量等于声明大小，不等则报错；可选增加整文件 SHA-256 校验。

### M9 — `/api/stun-check` 可做内存 DoS 并伪造日志

```92:108:relay/main.go
	if err := json.NewDecoder(r.Body).Decode(&report); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}

	if len(report.Server) > 256 {
		http.Error(w, "server field too long", http.StatusBadRequest)
		return
	}
	if len(report.Error) > 512 {
		http.Error(w, "error field too long", http.StatusBadRequest)
		return
	}
	if len(report.CandidateTypes) > 32 {
		http.Error(w, "too many candidate types", http.StatusBadRequest)
		return
	}
```

三个问题：

1. 没有 `http.MaxBytesReader`。所有长度检查都发生在请求体**完整解码进内存之后**，攻击者可用一个数百 MB 的 `server` 字段做内存 DoS（限流 10/min，且配合 H3 可绕过）。
2. `CandidateTypes` 只限元素个数 32，**单个元素长度无限制**，且在 113、123 行直接以 `%v` 打进日志。
3. `truncateForLog`（`relay/config.go:145-151`）只做 `TrimSpace`，**不剥离内嵌的 `\n` / `\r`**，可伪造日志行。

**修复方向**：`r.Body = http.MaxBytesReader(w, r.Body, 4<<10)`；解码器启用 `DisallowUnknownFields`；对每个 candidateType 单独截断；日志输出前替换控制字符。

### M10 — 安全响应头缺失，CSP 过宽

```354:359:relay/main.go
func securityMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if csp := cfg.Security.ContentSecurityPolicy; csp != "" {
			w.Header().Set("Content-Security-Policy", csp)
		}
		if origin := cfg.corsOrigin(r); origin != "" {
```

中间件只设置 CSP 与 CORS。缺失项：`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`frame-ancestors 'none'`（端到端加密页面的点击劫持防护尤其重要）、`base-uri 'none'`、`object-src 'none'`、`form-action 'none'`、`Permissions-Policy`、HSTS。

CSP 中 `connect-src 'self' ws: wss: stun:` 允许连接**任意** WebSocket 主机，等于 XSS 之后的数据外传通道没有限制，应收紧到中继来源。

`originAllowed`（`relay/config.go:102`）支持 `"*"`：当前不携带凭据所以 CORS 侧危害有限，但 `websocket.allowed_origins: ["*"]` 会允许任意网站驱动中继。

### M11 — 没有任何机制阻止明文部署

```124:130:public/security.js
	function deriveRelayURL(configuredUrl) {
		if (configuredUrl && typeof configuredUrl === "string" && configuredUrl.trim()) {
			return configuredUrl.trim();
		}
		const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
		return `${proto}//${window.location.host}/ws`;
	}
```

`config.yaml:30` 的 `relay_url` 默认为空，http 页面下回落到 `ws://`，既无检查也无告警。这会把 C1 的影响从"中继可 MITM"扩大到"同网段任何人可 MITM"。

**修复方向**：非 localhost 环境下检测到 `ws://` 时给出显式警告或拒绝启动传输；部署文档明确要求 TLS。

---

## 低危与健壮性问题

### L12 — `FileReader` 缺少错误处理，读取失败时传输永久挂起

```727:733:public/app.js
	const readChunk = (i) =>
		new Promise((resolve) => {
			const start = i * chunkSize;
			const end = Math.min(start + chunkSize, file.size);
			fileReader.onload = () => resolve(new Uint8Array(fileReader.result));
			fileReader.readAsArrayBuffer(file.slice(start, end));
		});
```

只挂了 `onload`，没有 `onerror` / `onabort`。文件在选择后被移动、删除或权限变更时，promise 永不 settle，UI 停在进度条上且不报错。建议直接改用 `await file.slice(start, end).arrayBuffer()`，天然会 reject，并可顺带去掉这个跨调用共享的 `FileReader` 实例。

### L13 — WASM 侧 nonce 计数器重置是定时炸弹

```44:47:wasm/main.go
	cachedKey = append(cachedKey[:0], key...)
	cachedAESGCM = gcm
	nonceCounter = 0
	return gcm, nil
```

`getCipher` 在密钥变化时把 `nonceCounter` 归零。当前是安全的：每次传输都经过新的 PAKE 得到不同会话密钥，且只有发送方调用 `encrypt`。但一旦将来加入双向传输、断点续传或密钥复用，就会出现 GCM nonce 重用——后果是灾难级的（泄漏 GHASH 认证密钥、两段明文异或暴露）。

建议现在就把角色编进 nonce 高位（发送方与接收方各占 1 bit），使不变量不依赖调用方的使用纪律。

### L14 — P2P 协商双方模式可能不一致导致双向挂死

```104:108:public/p2p.js
		this.pc.oniceconnectionstatechange = () => {
			if (this.pc?.iceConnectionState === "failed") {
				this._resolve("relay", null);
			}
		};
```

```178:183:public/p2p.js
			case "transport-mode": {
				if (this.role === "receiver" && msg.mode === "relay") {
					this._resolve("relay", null);
				}
				return true;
			}
```

接收方 ICE 失败时自行降级为 relay 并关闭 `pc`，而发送方可能已经定为 p2p。发送方随后发出的 `transport-mode: p2p` 在接收方只匹配 `mode === "relay"`，不产生任何效果。此后发送方向 DataChannel 写数据、接收方永远收不到，两端都不报错。

建议让发送方以接收方的最终选择为准，或双方互发 transport-mode 并取"降级优先"的合并结果。

### L15 — 目录流式写分支未排除文本负载

```843:851:public/app.js
		if (state.saveDir) {
			try {
				state.fileHandle = await state.saveDir.getFileHandle(
					metadata.name,
					{ create: true },
				);
				state.writable = await state.fileHandle.createWritable();
				state.streaming = true;
			} catch (err) {
```

该分支没有像下面的 `showSaveFilePicker` 分支那样排除 `isText`。多文件批量中若某个文件带 `kind: "text"`，会被置为 streaming，随后 `finishCurrentFile`（`app.js:759-761`）优先走 text 分支去读此时为 null 的 `state.merged`，且 `state.writable` 不会被 close（文件句柄泄漏）。恶意发送方可构造此组合。

### L16 — 批量接收会静默覆盖同名文件

同上 `getFileHandle(metadata.name, { create: true })`。文件名虽经 `sanitizeFilename` 清理（无路径穿越风险），但用户所选目录中的同名文件会被无提示覆盖。应提示确认或自动去重。

### L17 — 测试污染包级全局配置

```70:73:relay/ratelimit_test.go
func TestHandleConfigAPI(t *testing.T) {
	cfg = Config{
		Client: ClientConfig{RelayURL: "wss://relay.test/ws"},
	}
```

直接覆写包级全局 `cfg`（且 `AllowedOrigins` 为空），会影响同包中在其之后运行的测试。应保存并恢复原值，或改为向被测函数传入局部配置。

### L18 — `sanitizeFilename` 未覆盖 Windows 特有情形

`sanitizeFilename`（`public/security.js:15-33`）已正确处理路径分隔符、控制字符、`..` 序列与长度上限。未处理的情形：Windows 保留名（`CON`、`PRN`、`AUX`、`NUL`、`COM1`–`COM9`、`LPT1`–`LPT9`）、尾随的 `.` 与空格（Windows 会自动剥离，可能导致意外覆盖）。

另有一处功能性瑕疵——下面这行会把合法文件名 `报告..2026.pdf` 改写成 `报告.2026.pdf`：

```24:24:public/security.js
		base = base.replace(/\.\.+/g, ".");
```

### L19 — `drain()` 采用忙轮询

```39:47:public/transport.js
	async drain(threshold) {
		return new Promise((resolve) => {
			const check = () => {
				if (this.ws.bufferedAmount <= threshold) resolve();
				else setTimeout(check, 1);
			};
			check();
		});
	}
```

`RelayTransport` 与 `P2pTransport`（`transport.js:94-102`）都以 1ms 间隔轮询。WebSocket 确实没有对应事件所以只能轮询，但间隔可退避到 4–8ms；`RTCDataChannel` 有 `bufferedamountlow` 事件，可改为事件驱动。

---

## 修复优先级建议

| 优先级 | 条目 | 理由 |
| --- | --- | --- |
| P0 | C1、C2 | C1 推翻产品的核心安全承诺；C2 无需攻击者配合即可全局中断服务 |
| P1 | H3、H4、H5、H6 | 限流绕过与资源无上界共同构成可用性风险；H6 是 E2EE 场景下不可接受的供应链暴露 |
| P2 | M7、M8 | 数据完整性问题，会导致用户在无感知的情况下拿到损坏文件 |
| P2 | M9、M10、M11 | 服务端加固与部署安全基线 |
| P3 | L12–L19 | 健壮性、可维护性与边缘情形 |

C1 与 C2 建议分两个提交独立处理：前者改动握手协议，后者改动中继并发模型，混在一起会让回归定位困难。每项修复应先补一个能复现问题的测试，再改实现。
