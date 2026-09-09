import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const NODE_NAME = "MiniMaxH3MediaPreviewPW";
const STYLE_ID = "pw-mm3x3-style";

const SECTIONS = [
    { kind: "images", header: "IMAGES x 9", count: 9 },
    { kind: "videos", header: "VIDEOS x 3", count: 3 },
    { kind: "audio", header: "AUDIO x 3", count: 3 },
];

function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.pw-mm-root {
    width: 100%;
    box-sizing: border-box;
    padding: 4px;
}
.pw-mm-header {
    margin: 8px 2px 4px;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 1px;
    color: rgba(255, 255, 255, 0.6);
}
.pw-mm-header:first-child { margin-top: 0; }
.pw-mm-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
    box-sizing: border-box;
    width: 100%;
}
.pw-mm-cell {
    position: relative;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px dashed rgba(255, 255, 255, 0.28);
    overflow: hidden;
    box-sizing: border-box;
    /* 图片 / 视频格子：16:9，高度随宽度等比缩放 */
    aspect-ratio: 16 / 9;
}
.pw-mm-grid-audio .pw-mm-cell {
    /* 音频格子：2:1 */
    aspect-ratio: 2 / 1;
}
.pw-mm-cell.pw-mm-cell-filled {
    border: 1px solid rgba(255, 255, 255, 0.16);
    background: rgba(0, 0, 0, 0.25);
}
.pw-mm-badge {
    position: absolute;
    top: 4px;
    left: 4px;
    z-index: 2;
    background: rgba(0, 0, 0, 0.85);
    color: #fff;
    font-family: monospace;
    font-weight: 700;
    font-size: 11px;
    line-height: 1;
    padding: 5px 7px;
    border-radius: 6px;
    pointer-events: none;
}
.pw-mm-img, .pw-mm-video {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
    background: rgba(0, 0, 0, 0.35);
}
.pw-mm-media-label {
    position: absolute;
    top: 7px;
    left: 34px;
    right: 6px;
    z-index: 1;
    font-size: 11px;
    color: rgba(255, 255, 255, 0.55);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none;
}
.pw-mm-audio {
    position: absolute;
    left: 6px;
    right: 6px;
    bottom: 6px;
    height: 32px;
    width: calc(100% - 12px);
}
.pw-mm-placeholder {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: rgba(255, 255, 255, 0.35);
    font-size: 12px;
    pointer-events: none;
}
.pw-mm-status {
    margin-top: 6px;
    font-size: 10px;
    line-height: 1.4;
    color: rgba(255, 255, 255, 0.45);
    font-family: monospace;
    white-space: pre-wrap;
    word-break: break-all;
}
`;
    document.head.appendChild(style);
}

function basename(p) {
    if (!p) return "";
    return String(p).split(/[\\/]/).pop();
}

function normalizePayload(payload) {
    if (!payload) return null;
    if (Array.isArray(payload)) {
        return { images: payload, videos: [], audio: [] };
    }
    if (typeof payload === "object") {
        return {
            images: Array.isArray(payload.images) ? payload.images : [],
            videos: Array.isArray(payload.videos) ? payload.videos : [],
            audio: Array.isArray(payload.audio) ? payload.audio : [],
        };
    }
    return null;
}

function extractSlots(message) {
    if (!message) return null;
    if (message.pw_preview_slots) return message.pw_preview_slots;
    if (message.ui && message.ui.pw_preview_slots) return message.ui.pw_preview_slots;
    if (message.output && message.output.pw_preview_slots) return message.output.pw_preview_slots;
    if (message.output && message.output.ui && message.output.ui.pw_preview_slots) {
        return message.output.ui.pw_preview_slots;
    }
    return null;
}

function isPreviewOff(node) {
    if (!Array.isArray(node.widgets)) return false;
    const w = node.widgets.find(x => x.name === "Preview");
    return !!w && w.value === false;
}

/* ===== 同步前端布局所依赖的 widget 内部高度记录 ===== */
function setWidgetRecordedHeight(node, height) {
    if (!Array.isArray(node.widgets)) return null;
    const w = node.widgets.find(x => x.name === "pw_media_grid");
    if (!w) return null;
    const wh = Math.max(20, height + 8);
    try {
        w.computedHeight = wh;
    } catch (e) {
        try {
            Object.defineProperty(w, "computedHeight", { value: wh, configurable: true, writable: true });
        } catch (e2) { /* ignore */ }
    }
    try {
        w.computeSize = function (width) {
            return [width || Math.max(50, (node.size ? node.size[0] : 300) - 20), wh];
        };
    } catch (e) { /* ignore */ }
    return w;
}

/* ===== 关键：按节点宽度解析推导内容应有的高度（不依赖元素测量，打破钳制循环） ===== */
function computeContentHeight(node) {
    const nodeW = (node.size && node.size[0]) ? node.size[0] : 400;
    const rootW = Math.max(120, nodeW - 20);   // DOM widget 元素宽度 ≈ 节点宽 - 两侧边距
    const innerW = rootW - 8;                  // root 自身 padding 4px * 2
    const gap = 6;
    const cellW = (innerW - 2 * gap) / 3;
    const imgRow = cellW * 9 / 16;             // 图片/视频格子 16:9
    const audRow = cellW / 2;                  // 音频格子 2:1
    const headerH = 26;                        // 分区标题行（含上下 margin）
    const statusH = 44;                        // 状态行（最多两行）
    const pad = 8;                             // root 上下 padding
    const imagesH = 3 * imgRow + 2 * gap;
    const videosH = imgRow;
    const audioH = audRow;
    return Math.round(pad + headerH * 3 + imagesH + videosH + audioH + statusH);
}

function buildCell(kind, index) {
    const cell = document.createElement("div");
    cell.className = "pw-mm-cell";
    cell.dataset.kind = kind;
    cell.dataset.slot = String(index);

    const badge = document.createElement("div");
    badge.className = "pw-mm-badge";
    badge.textContent = String(index);
    cell.appendChild(badge);

    const markFailed = (url) => {
        console.warn("[PWUtility MiniMax] media load failed:", url);
        const ph = cell.querySelector(".pw-mm-placeholder");
        if (ph) { ph.textContent = "Load failed"; ph.style.display = ""; }
    };

    if (kind === "images") {
        const img = document.createElement("img");
        img.className = "pw-mm-img";
        img.style.display = "none";
        img.addEventListener("error", () => markFailed(img.src));
        cell.appendChild(img);
    } else if (kind === "videos") {
        const video = document.createElement("video");
        video.className = "pw-mm-video";
        video.muted = true;
        video.controls = true;
        video.preload = "metadata";
        video.style.display = "none";
        video.addEventListener("error", () => markFailed(video.src));
        cell.appendChild(video);
    } else {
        const label = document.createElement("div");
        label.className = "pw-mm-media-label";
        cell.appendChild(label);

        const audio = document.createElement("audio");
        audio.className = "pw-mm-audio";
        audio.controls = true;
        audio.preload = "metadata";
        audio.style.display = "none";
        audio.addEventListener("error", () => markFailed(audio.src));
        cell.appendChild(audio);
    }

    const placeholder = document.createElement("div");
    placeholder.className = "pw-mm-placeholder";
    placeholder.textContent = "Empty";
    cell.appendChild(placeholder);

    return cell;
}

function buildRootElement() {
    const root = document.createElement("div");
    root.className = "pw-mm-root";

    for (const sec of SECTIONS) {
        const header = document.createElement("div");
        header.className = "pw-mm-header";
        header.textContent = sec.header;
        root.appendChild(header);

        const grid = document.createElement("div");
        grid.className = "pw-mm-grid pw-mm-grid-" + sec.kind;
        for (let i = 0; i < sec.count; i++) {
            grid.appendChild(buildCell(sec.kind, i));
        }
        root.appendChild(grid);
    }

    const status = document.createElement("div");
    status.className = "pw-mm-status";
    status.textContent = "status: waiting for execution...";
    root.appendChild(status);

    return root;
}

function resetCell(cell) {
    cell.classList.remove("pw-mm-cell-filled");
    const img = cell.querySelector(".pw-mm-img");
    if (img) { img.style.display = "none"; img.removeAttribute("src"); img.removeAttribute("title"); }
    const video = cell.querySelector(".pw-mm-video");
    if (video) {
        try { video.pause(); } catch (e) { /* ignore */ }
        video.style.display = "none";
        video.removeAttribute("src");
        video.removeAttribute("title");
    }
    const audio = cell.querySelector(".pw-mm-audio");
    if (audio) {
        try { audio.pause(); } catch (e) { /* ignore */ }
        audio.style.display = "none";
        audio.removeAttribute("src");
        audio.removeAttribute("title");
    }
    const label = cell.querySelector(".pw-mm-media-label");
    if (label) { label.textContent = ""; label.removeAttribute("title"); }
    const ph = cell.querySelector(".pw-mm-placeholder");
    if (ph) { ph.textContent = "Empty"; ph.style.display = ""; }
}

function fillCell(cell, kind, item) {
    if (kind === "images") {
        const img = cell.querySelector(".pw-mm-img");
        if (!img || !item.filename) return false;
        img.src = api.apiURL(
            "/view?filename=" + encodeURIComponent(item.filename) +
            "&type=" + encodeURIComponent(item.type || "temp") +
            "&subfolder=" + encodeURIComponent(item.subfolder || "") +
            "&rand=" + (item.ts || Date.now())
        );
        img.title = item.path || "";
        img.style.display = "";
    } else {
        if (!item.path) return false;
        const url = api.apiURL("/pw_media_file_view?filename=" + encodeURIComponent(item.path));
        if (kind === "videos") {
            const video = cell.querySelector(".pw-mm-video");
            if (!video) return false;
            video.src = url;
            video.title = item.path || "";
            video.style.display = "";
        } else {
            const audio = cell.querySelector(".pw-mm-audio");
            if (!audio) return false;
            audio.src = url;
            audio.title = item.path || "";
            audio.style.display = "";
            const label = cell.querySelector(".pw-mm-media-label");
            if (label) { label.textContent = basename(item.path); label.title = item.path || ""; }
        }
    }
    cell.classList.add("pw-mm-cell-filled");
    const ph = cell.querySelector(".pw-mm-placeholder");
    if (ph) ph.style.display = "none";
    return true;
}

function collectRoots(node) {
    const roots = [];
    if (node.pw_mm_root_el) roots.push(node.pw_mm_root_el);
    if (Array.isArray(node.widgets)) {
        for (const w of node.widgets) {
            const el = w && w.element;
            if (el && el.classList && el.classList.contains("pw-mm-root") && !roots.includes(el)) {
                roots.push(el);
            }
        }
    }
    return roots;
}

function clearAllMedia(node) {
    for (const root of collectRoots(node)) {
        root.querySelectorAll(".pw-mm-cell").forEach(resetCell);
        const status = root.querySelector(".pw-mm-status");
        if (status) status.textContent = "status: preview disabled by switch";
    }
}

function updateGrid(node, rawPayload, source) {
    if (isPreviewOff(node)) {
        clearAllMedia(node);
        return 0;
    }

    const roots = collectRoots(node);
    const payload = normalizePayload(rawPayload);

    const total = { images: 0, videos: 0, audio: 0 };

    for (const root of roots) {
        root.querySelectorAll(".pw-mm-cell").forEach(resetCell);

        const filled = { images: 0, videos: 0, audio: 0 };
        if (payload) {
            for (const sec of SECTIONS) {
                const list = payload[sec.kind];
                if (!Array.isArray(list)) continue;
                const cells = root.querySelectorAll('.pw-mm-cell[data-kind="' + sec.kind + '"]');
                for (const item of list) {
                    const idx = item ? item.slot : undefined;
                    if (idx == null || idx < 0 || idx >= cells.length) continue;
                    if (fillCell(cells[idx], sec.kind, item)) filled[sec.kind]++;
                }
            }
        }

        total.images += filled.images;
        total.videos += filled.videos;
        total.audio += filled.audio;

        const status = root.querySelector(".pw-mm-status");
        if (status) {
            status.textContent =
                "status: updated via " + source +
                " | img=" + filled.images +
                " vid=" + filled.videos +
                " aud=" + filled.audio +
                " @ " + new Date().toLocaleTimeString();
        }
    }
    return total.images + total.videos + total.audio;
}

function fetchSlotsFromServer(node, source) {
    const url = api.apiURL(
        "/pw_media_preview_slots?node_id=" + encodeURIComponent(String(node.id)) + "&materialize=1"
    );
    return fetch(url)
        .then(r => r.json())
        .then(j => {
            if (j && j.slots) {
                updateGrid(node, j.slots, source);
                if (node.pw_mm_syncHeight) requestAnimationFrame(() => node.pw_mm_syncHeight());
            } else {
                console.warn("[PWUtility MiniMax] server returned no slots for node", node.id, j);
            }
        })
        .catch(err => {
            console.warn("[PWUtility MiniMax] fetch slots failed:", err);
        });
}

function applyPreviewState(node) {
    const el = node.pw_mm_root_el;
    if (!el) return;
    if (isPreviewOff(node)) {
        el.style.display = "none";
        clearAllMedia(node);
        try {
            setWidgetRecordedHeight(node, 0);
            let offTarget = 110;
            if (Array.isArray(node.widgets)) {
                const pw = node.widgets.find(x => x.name === "Preview");
                if (pw && typeof pw.y === "number" && pw.y > 0) {
                    offTarget = Math.round(pw.y + 34);
                }
            }
            node.size[1] = offTarget;
            if (node.setDirtyCanvas) node.setDirtyCanvas(true, true);
            if (app.graph && app.graph.setDirtyCanvas) app.graph.setDirtyCanvas(true, true);
        } catch (e) { /* ignore */ }
    } else {
        el.style.display = "";
        fetchSlotsFromServer(node, "http-restore");
        if (node.pw_mm_syncHeight) requestAnimationFrame(() => node.pw_mm_syncHeight());
    }
}

function handleExecuted(node, message) {
    if (isPreviewOff(node)) {
        clearAllMedia(node);
        return;
    }
    let filled = 0;
    try {
        filled = updateGrid(node, extractSlots(message), "onExecuted");
    } catch (err) {
        console.warn("[PWUtility MiniMax] updateGrid error:", err);
    }
    if (node.pw_mm_syncHeight) requestAnimationFrame(() => node.pw_mm_syncHeight());
    if (filled === 0) {
        fetchSlotsFromServer(node, "http-fetch")
            .then(() => setTimeout(() => fetchSlotsFromServer(node, "http-fetch-retry"), 300));
    }
}

api.addEventListener("executed", (e) => {
    try {
        const detail = e.detail || {};
        const id = detail.display_node || detail.node;
        if (id == null) return;
        const node = app.graph ? app.graph.getNodeById(id) : null;
        if (!node) return;
        if (node.comfyClass !== NODE_NAME && node.type !== NODE_NAME) return;
        handleExecuted(node, detail);
    } catch (err) {
        console.warn("[PWUtility MiniMax] executed listener error:", err);
    }
});

app.registerExtension({
    name: "PWUtility.MiniMaxH3MediaPreview",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

            injectStyles();
            const el = buildRootElement();
            this.pw_mm_root_el = el;
            this.addDOMWidget("pw_media_grid", "div", el, { serialize: false });

            const w = Math.max(this.size ? this.size[0] : 0, 400);
            this.setSize([w, 620]);

            const node = this;
            const syncHeight = () => {
                try {
                    if (el.style.display === "none") return;

                    // 解析高度（只依赖宽度，不受前端钳制影响）与测量高度取较大者
                    const natural = el.offsetHeight || 0;
                    const estimated = computeContentHeight(node);
                    const h = Math.max(natural, estimated);
                    if (h <= 0) return;

                    const dw = setWidgetRecordedHeight(node, h);

                    let y = 96;
                    if (dw && typeof dw.y === "number" && dw.y > 0) y = dw.y;

                    const target = Math.max(220, Math.round(y + h + 16));
                    if (Math.abs(node.size[1] - target) > 3) {
                        node.size[1] = target;
                        if (node.setDirtyCanvas) node.setDirtyCanvas(true, true);
                        if (app.graph && app.graph.setDirtyCanvas) app.graph.setDirtyCanvas(true, true);
                    }
                } catch (err) {
                    console.warn("[PWUtility MiniMax] syncHeight error:", err);
                }
            };
            node.pw_mm_syncHeight = syncHeight;

            if (typeof ResizeObserver !== "undefined") {
                const ro = new ResizeObserver(() => syncHeight());
                ro.observe(el);
                node.pw_mm_ro = ro;
            }
            setTimeout(syncHeight, 0);
            setTimeout(syncHeight, 300);
            setTimeout(syncHeight, 1000);

            // ===== 监听 Preview 开关 =====
            const pw = Array.isArray(this.widgets) ? this.widgets.find(x => x.name === "Preview") : null;
            if (pw) {
                const origCb = pw.callback;
                pw.callback = function (...args) {
                    let cbRet;
                    if (origCb) {
                        try { cbRet = origCb.apply(this, args); } catch (e) { /* ignore */ }
                    }
                    applyPreviewState(node);
                    return cbRet;
                };
            }
            setTimeout(() => applyPreviewState(node), 0);

            return r;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
            const n = this;
            setTimeout(() => applyPreviewState(n), 0);
            setTimeout(() => { if (n.pw_mm_syncHeight) n.pw_mm_syncHeight(); }, 300);
            setTimeout(() => { if (n.pw_mm_syncHeight) n.pw_mm_syncHeight(); }, 1000);
            return r;
        };

        const onResize = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function () {
            const r = onResize ? onResize.apply(this, arguments) : undefined;
            if (this.pw_mm_syncHeight) {
                requestAnimationFrame(() => this.pw_mm_syncHeight());
            }
            return r;
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            if (onExecuted) {
                try { onExecuted.apply(this, arguments); } catch (err) { /* ignore */ }
            }
            handleExecuted(this, message);
        };
    },
});