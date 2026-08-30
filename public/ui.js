// ─── UI Layer ─────────────────────────────────────────────────────────────
// All DOM manipulation for the croc-wasm frontend lives here behind the `ui`
// facade, which app.js (pure transfer logic) calls into. This file binds all
// DOM events to `window.croc` and mirrors transfer state into the Three.js
// particle background via `window.bgFX` (optional chaining — the background
// is decorative and may be absent).

const $ = (id) => document.getElementById(id);

// ─── Inline SVG icons (Lucide-style, 24×24 stroke) ────────────────────────
const ICONS = {
	send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
	inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
	rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
	copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
	check: '<path d="M20 6 9 17l-5-5"/>',
	download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
	loader: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
	"circle-check": '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
	"circle-x": '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
	"key-round": '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>',
	hourglass: '<path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>',
};

function svgIcon(name, cls = "") {
	return `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

// status tone → icon + color class
const STATUS_TONES = {
	working: { icon: "loader", cls: "status-working" },
	progress: { icon: null, cls: "status-working" },
	success: { icon: "circle-check", cls: "status-success" },
	error: { icon: "circle-x", cls: "status-error" },
	key: { icon: "key-round", cls: "status-key" },
	wait: { icon: "hourglass", cls: "status-wait" },
	info: { icon: null, cls: "" },
};

let transferring = false;

function setTransferring(b, role) {
	transferring = b;
	window.bgFX?.setTransferring(b);
	if (b && role) {
		// 发送：粒子左→右；接收：右→左
		window.bgFX?.setDirection(role === "send" ? 1 : -1);
	}
}

function updateProgressLabel(role, percent) {
	const label = $(`${role}-progress-percent`);
	if (!label) return;
	const p = Math.min(100, Math.max(0, percent));
	label.textContent = `${p.toFixed(1)}%`;
	label.style.left = `${p}%`;
	label.classList.toggle("is-at-start", p <= 8);
	label.classList.toggle("is-at-end", p >= 92);
}

// ─── ui facade (called from app.js) ────────────────────────────────────────
const ui = {
	setStatus(role, text, tone = "info") {
		const el = $(`${role}-status`);
		if (!el) return;
		const t = STATUS_TONES[tone] || STATUS_TONES.info;
		el.className = `status-message ${t.cls}`.trim();
		el.innerHTML = (t.icon ? svgIcon(t.icon) : "") + "<span></span>";
		el.querySelector("span").textContent = text;
	},

	setProgress(role, percent, animate = false) {
		const el = $(`${role}-progress-bar`);
		if (!el) return;
		const p = Math.min(100, Math.max(0, percent));
		el.classList.toggle("is-complete", animate);
		if (!animate) {
			el.style.transition = "none";
		}
		el.style.transform = `scaleX(${p / 100})`;
		if (!animate) {
			void el.offsetWidth;
			el.style.transition = "";
		}
		updateProgressLabel(role, p);
		window.bgFX?.setProgress(p);
		if (p >= 100) setTransferring(false);
	},

	showProgressBar(role) {
		const wrapper = $(`${role}-progress-wrapper`);
		const bar = $(`${role}-progress-bar`);
		if (!wrapper || !bar) return;
		bar.style.transition = "none";
		bar.style.transform = "scaleX(0)";
		bar.classList.remove("is-complete");
		wrapper.classList.remove("hidden");
		updateProgressLabel(role, 0);
		void bar.offsetWidth;
		bar.style.transition = "";
	},

	hideProgressBar(role) {
		$(`${role}-progress-wrapper`)?.classList.add("hidden");
	},

	setTransportMode(role, mode) {
		const el = $(`${role}-transport-mode`);
		if (!el) return;
		if (mode === "p2p") {
			el.textContent = "直连 (P2P)";
			el.className = "transport-mode transport-mode-p2p";
		} else {
			el.textContent = "中继转发";
			el.className = "transport-mode transport-mode-relay";
		}
		el.classList.remove("hidden");
	},

	setCardTitle(role, text) {
		const el = $(`${role}-progress-card`)?.querySelector(".card-title-text");
		if (el) el.textContent = text;
	},

	setCode(code) {
		$("send-code").textContent = code;
	},

	enterTransfer(role) {
		const setupCard =
			role === "send" ? $("send-upload-card") : $("receive-code-card");
		setupCard?.classList.add("hidden");
		$(`${role}-progress-card`)?.classList.remove("hidden");
		setTransferring(true, role);
	},

	showError(role, message) {
		const progressCard = $(`${role}-progress-card`);
		if (!progressCard || progressCard.classList.contains("hidden")) {
			// 还停留在设置卡片（如文本为空/超限），状态行不可见，退回 alert
			alert(message);
			return;
		}
		this.setStatus(role, message, "error");
		setTransferring(false);
	},

	setBusy(role, busy) {
		const btn = $(role === "send" ? "btn-start-send" : "btn-start-receive");
		if (!btn) return;
		btn.disabled = busy;
		if (busy) {
			btn.dataset.idleHtml = btn.innerHTML;
			const label = role === "send" ? "连接中继…" : "连接中…";
			btn.innerHTML = `${svgIcon("loader", "spin")}<span>${label}</span>`;
		} else if (btn.dataset.idleHtml) {
			btn.innerHTML = btn.dataset.idleHtml;
		}
	},

	resetReceiveView() {
		$("receive-text-section").classList.add("hidden");
		$("receive-text-content").textContent = "";
		$("receive-download-section").classList.add("hidden");
	},

	showReceivedText(text) {
		$("receive-text-content").textContent = text;
		$("receive-text-section").classList.remove("hidden");
		$("btn-copy-text").onclick = () => {
			navigator.clipboard.writeText(text).then(() => {
				flashCopied($("btn-copy-text"));
			});
		};
	},

	showDownloads(files) {
		const list = $("receive-download-list");
		list.innerHTML = "";
		for (const f of files) {
			const btn = document.createElement("button");
			btn.className = "btn btn-success";
			btn.innerHTML = svgIcon("download");
			const name = document.createElement("span");
			name.textContent = f.name;
			btn.appendChild(name);
			btn.onclick = () => {
				const a = document.createElement("a");
				a.href = f.url;
				a.download = f.name;
				a.click();
			};
			list.appendChild(btn);
		}
		$("receive-download-section").classList.remove("hidden");
	},
};
window.ui = ui;

// ─── View switching ────────────────────────────────────────────────────────
function switchView(name) {
	document
		.querySelectorAll("[data-view]")
		.forEach((b) => b.classList.toggle("active", b.dataset.view === name));
	document
		.querySelectorAll(".view")
		.forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
	const thumb = document.querySelector(".segmented-thumb");
	if (thumb) {
		const idx = [...document.querySelectorAll("[data-view]")].findIndex(
			(b) => b.dataset.view === name,
		);
		thumb.style.transform = `translateX(${Math.max(0, idx) * 100}%)`;
	}
	if (!transferring) {
		window.bgFX?.setDirection(name === "send" ? 1 : -1);
	}
}

// ─── Send panel helpers ────────────────────────────────────────────────────
function setSendModeUI(mode) {
	croc.setSendMode(mode);
	for (const btn of document.querySelectorAll("[data-send-mode]")) {
		btn.classList.toggle("active", btn.dataset.sendMode === mode);
	}
	$("send-file-panel").classList.toggle("hidden", mode !== "file");
	$("send-text-panel").classList.toggle("hidden", mode !== "text");
	if (mode === "file") {
		if (croc.state.files.length > 0) {
			renderSelectedFiles();
		} else {
			$("send-file-info").classList.add("hidden");
		}
	} else {
		updateTextSendReady();
	}
}

function updateTextSendReady() {
	if (croc.state.sendMode !== "text") return;
	const text = $("send-text-input").value;
	const bytes = new TextEncoder().encode(text);
	const countEl = $("send-text-count");
	const charCount = [...text].length;
	countEl.textContent = `${charCount} 字符`;
	const btn = $("btn-start-send");
	if (!text.trim()) {
		$("send-file-info").classList.add("hidden");
		return;
	}
	if (bytes.length > croc.MAX_TEXT_BYTES) {
		countEl.textContent = `${formatSize(bytes.length)}（超过 1MB 限制）`;
		btn.disabled = true;
		$("send-file-list").innerHTML = "";
		$("send-file-total-size").textContent = "";
		$("send-file-info").classList.remove("hidden");
		return;
	}
	$("send-file-list").innerHTML = "";
	$("send-file-total-size").textContent = "";
	$("send-file-info").classList.remove("hidden");
	btn.disabled = false;
}

function renderSelectedFiles() {
	const list = $("send-file-list");
	const totalEl = $("send-file-total-size");
	list.innerHTML = "";
	let totalBytes = 0;
	for (const file of croc.state.files) {
		totalBytes += file.size;
		const li = document.createElement("li");
		li.className = "file-list-item";
		const name = document.createElement("span");
		name.className = "file-name";
		name.textContent = file.name;
		name.title = file.name;
		const size = document.createElement("span");
		size.className = "file-size";
		size.textContent = formatSize(file.size);
		li.append(name, size);
		list.appendChild(li);
	}
	const n = croc.state.files.length;
	totalEl.textContent =
		n === 1
			? formatSize(totalBytes)
			: `共 ${n} 个文件，${formatSize(totalBytes)}`;
	$("send-file-info").classList.remove("hidden");
	$("btn-start-send").disabled = false;
}

function onFilesSelected(fileList) {
	const files = Array.from(fileList || []);
	if (files.length === 0) return;
	croc.setFiles(files);
	setSendModeUI("file");
}

function flashCopied(btn, text = "已复制") {
	const prev = btn.innerHTML;
	btn.innerHTML = `${svgIcon("check")}<span>${text}</span>`;
	setTimeout(() => (btn.innerHTML = prev), 2000);
}

async function copyCode() {
	const code = $("send-code").textContent;
	// 拼接完整分享链接：public_url（config.yaml 下发，回退页面 origin）+ #code=口令码
	// getPublicURL 已在页面加载时预热，此处 await 立即返回缓存值，
	// 避免等待 fetch 耗尽用户手势窗口导致 clipboard 写入被拒
	const base = await croc.getPublicURL();
	navigator.clipboard.writeText(`${base}/#code=${encodeURIComponent(code)}`).then(() => {
		flashCopied($("btn-copy-code"));
	}).catch((err) => {
		// 写入失败时剪贴板会保留旧内容，必须显式提示，否则用户误以为复制成功
		console.error("复制链接失败:", err);
		flashCopied($("btn-copy-code"), "复制失败");
	});
}

// ─── Event bindings ────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
	for (const btn of document.querySelectorAll("[data-view]")) {
		btn.addEventListener("click", () => switchView(btn.dataset.view));
	}
	for (const btn of document.querySelectorAll("[data-send-mode]")) {
		btn.addEventListener("click", () => setSendModeUI(btn.dataset.sendMode));
	}

	const dropZone = $("drop-zone");
	const fileInput = $("file-input");
	dropZone.addEventListener("click", () => fileInput.click());
	dropZone.addEventListener("dragover", (e) => {
		e.preventDefault();
		dropZone.classList.add("dragover");
	});
	dropZone.addEventListener("dragleave", () => {
		dropZone.classList.remove("dragover");
	});
	dropZone.addEventListener("drop", (e) => {
		e.preventDefault();
		dropZone.classList.remove("dragover");
		onFilesSelected(e.dataTransfer.files);
	});
	fileInput.addEventListener("change", (e) => onFilesSelected(e.target.files));

	$("send-text-input").addEventListener("input", updateTextSendReady);
	$("btn-start-send").addEventListener("click", () =>
		croc.startSend($("send-text-input").value),
	);
	$("btn-copy-code").addEventListener("click", copyCode);
	$("btn-start-receive").addEventListener("click", () =>
		croc.startReceive($("receive-code-input").value),
	);
	$("receive-code-input").addEventListener("keydown", (e) => {
		if (e.key === "Enter") croc.startReceive($("receive-code-input").value);
	});

	// 分享链接自动填充：链接形如 {public_url}/#code=XXXX（见 copyCode / config.yaml client.public_url）。
	// 有 code 参数时自动切到接收视图、填入口令并聚焦；不自动开始接收，由用户确认。
	const sharedCode = new URLSearchParams(window.location.hash.slice(1)).get("code");
	if (sharedCode) {
		switchView("receive");
		const codeInput = $("receive-code-input");
		codeInput.value = sharedCode;
		codeInput.focus();
		// 清除 hash：避免刷新重复填充，口令也不留在地址栏/浏览记录
		history.replaceState(null, "", window.location.pathname + window.location.search);
	}

	// 预热分享域名缓存：用户点击“复制链接”时 getPublicURL 立即返回缓存值，
	// 不再等待网络请求，保住浏览器用户手势窗口内的剪贴板写入权限
	croc.getPublicURL();

	// WASM loads in the worker (started at module load). Show UI immediately;
	// the first wasmCall awaits worker readiness if needed.
	document.querySelector(".loading-overlay")?.remove();
	$("app-content").classList.remove("hidden");
	croc.startStunPrecheck();
});
