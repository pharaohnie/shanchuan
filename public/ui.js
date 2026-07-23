// ─── UI Layer ─────────────────────────────────────────────────────────────
// All DOM manipulation for the croc-wasm frontend lives here behind the `ui`
// facade, which app.js (pure transfer logic) calls into. This file binds all
// DOM events to `window.croc` and mirrors transfer state into the Three.js
// particle background via `window.bgFX` (optional chaining — the background
// is decorative and may be absent).

const $ = (id) => document.getElementById(id);

let transferring = false;

function setTransferring(b, role) {
	transferring = b;
	window.bgFX?.setTransferring(b);
	if (b && role) {
		// 发送：粒子左→右；接收：右→左
		window.bgFX?.setDirection(role === "send" ? 1 : -1);
	}
}

// ─── ui facade (called from app.js) ────────────────────────────────────────
const ui = {
	setStatus(role, text) {
		const el = $(`${role}-status`);
		if (el) el.textContent = text;
	},

	setProgress(role, percent, animate = false) {
		const el = $(`${role}-progress-bar`);
		if (!el) return;
		const p = Math.min(100, Math.max(0, percent));
		el.classList.toggle("is-complete", animate);
		el.style.transform = `scaleX(${p / 100})`;
		window.bgFX?.setProgress(p);
		if (p >= 100) setTransferring(false);
	},

	showProgressBar(role) {
		const container = $(`${role}-progress-container`);
		if (!container) return;
		container.classList.remove("hidden");
		// Force reflow so the progress bar transition starts from 0.
		void $(`${role}-progress-bar`).offsetWidth;
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
		const card = $(`${role}-progress-card`);
		const h2 = card?.querySelector("h2");
		if (h2) h2.textContent = text;
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
		this.setStatus(role, `❌ ${message}`);
		setTransferring(false);
	},

	setBusy(role, busy) {
		const btn = $(role === "send" ? "btn-start-send" : "btn-start-receive");
		if (!btn) return;
		btn.disabled = busy;
		if (busy) {
			btn.dataset.idleLabel = btn.textContent;
			btn.textContent = role === "send" ? "⏳ 连接中继..." : "⏳ 连接中...";
		} else if (btn.dataset.idleLabel) {
			btn.textContent = btn.dataset.idleLabel;
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
				const btn = $("btn-copy-text");
				const prev = btn.textContent;
				btn.textContent = "✅ 已复制";
				setTimeout(() => (btn.textContent = prev), 2000);
			});
		};
	},

	showDownloads(files) {
		const list = $("receive-download-list");
		list.innerHTML = "";
		for (const f of files) {
			const btn = document.createElement("button");
			btn.className = "btn btn-success";
			btn.textContent = `⬇️ ${f.name}`;
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
		$("send-file-info").classList.remove("hidden");
		return;
	}
	$("send-file-list").innerHTML = "";
	$("send-file-total-size").textContent =
		`${charCount} 字符 · ${formatSize(bytes.length)}`;
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

function copyCode() {
	const code = $("send-code").textContent;
	navigator.clipboard.writeText(code).then(() => {
		const btn = $("btn-copy-code");
		btn.textContent = "✅ 已复制";
		setTimeout(() => (btn.textContent = "📋 复制"), 2000);
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

	// WASM loads in the worker (started at module load). Show UI immediately;
	// the first wasmCall awaits worker readiness if needed.
	document.querySelector(".loading-overlay")?.remove();
	$("app-content").classList.remove("hidden");
	croc.startStunPrecheck();
});
