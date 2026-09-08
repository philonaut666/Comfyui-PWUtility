import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ---- 媒体类型工具 ----
const PW_AUDIO_EXTS = ["mp3", "flac", "aac", "m4a", "wav", "ogg", "oga", "opus", "wma", "aiff", "aif", "amr"];
const PW_VIDEO_EXTS = ["mp4", "mov", "mkv", "webm", "m4v", "avi", "mpg", "mpeg", "ts", "flv", "wmv", "h264", "h265", "hevc"];

function pwGetExt(name) {
    const i = String(name || "").lastIndexOf(".");
    return i >= 0 ? String(name).slice(i + 1).toLowerCase() : "";
}
function pwIsAudioPath(p) {
    return PW_AUDIO_EXTS.includes(pwGetExt(p));
}
function pwFileLooksLikeMedia(f) {
    if (!f) return false;
    const t = f.type || "";
    if (t.startsWith("video/") || t.startsWith("audio/")) return true;
    const ext = pwGetExt(f.name);
    return PW_AUDIO_EXTS.includes(ext) || PW_VIDEO_EXTS.includes(ext);
}
function pwEscapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- 共享 AudioContext（用于波形解码） ----
let pwSharedAudioCtx = null;
function pwGetAudioCtx() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!pwSharedAudioCtx) pwSharedAudioCtx = new AC();
    return pwSharedAudioCtx;
}

// ---- 波形绘制 ----
function pwDrawWaveformToCanvas(canvas, audioBuffer) {
    const w = canvas.clientWidth || 300;
    const h = canvas.clientHeight || 28;
    canvas.width = w;
    canvas.height = h;
    const ctx2 = canvas.getContext("2d");
    ctx2.clearRect(0, 0, w, h);
    const data = audioBuffer.getChannelData(0);
    const numBars = w;
    const samplesPerBar = Math.floor(data.length / numBars);
    if (samplesPerBar <= 0) return;
    ctx2.fillStyle = "rgba(180, 200, 220, 0.55)";
    const mid = h / 2;
    for (let i = 0; i < numBars; i++) {
        let min = 0, max = 0;
        const start = i * samplesPerBar;
        const end = Math.min(start + samplesPerBar, data.length);
        const stride = Math.max(1, Math.floor((end - start) / 50));
        for (let j = start; j < end; j += stride) {
            const v = data[j];
            if (v > max) max = v;
            if (v < min) min = v;
        }
        const y1 = mid + min * mid;
        const y2 = mid + max * mid;
        ctx2.fillRect(i, y1, 1, Math.max(1, y2 - y1));
    }
}

async function pwLoadAndDrawWaveform(canvas, url) {
    try {
        const resp = await fetch(url);
        if (!resp.ok) return;
        const arr = await resp.arrayBuffer();
        const ac = pwGetAudioCtx();
        if (!ac) return;
        const audioBuffer = await ac.decodeAudioData(arr);
        pwDrawWaveformToCanvas(canvas, audioBuffer);
    } catch (e) {
        // 某些视频容器无法用 decodeAudioData 解出音轨时静默跳过
    }
}

const PW_TRIM_ICON_SVG = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><g transform="rotate(-90 12 12)"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></g></svg>';
const PW_MUSIC_ICON_SVG = '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';

function injectGalleryStyles() {
    if (document.getElementById('pw-video-gallery-styles')) return;
    const style = document.createElement('style');
    style.id = 'pw-video-gallery-styles';
    style.textContent = `
        .pw-gallery-item { position: relative; }
        .pw-gallery-item .pw-crop-btn { 
            opacity: 0; 
            transition: opacity 0.2s, transform 0.2s, background 0.2s; 
            pointer-events: none; 
        }
        .pw-gallery-item:hover .pw-crop-btn { 
            opacity: 1; 
            pointer-events: auto; 
        }
        .pw-gallery-item .pw-crop-btn:hover {
            background: rgba(0, 122, 204, 0.9) !important;
            transform: translate(-50%, -50%) scale(1.1) !important;
        }
        .pw-gallery-item .pw-crop-btn svg { display: block; }
    `;
    document.head.appendChild(style);
}

function injectVideoPreviewStyles() {
    if (document.getElementById('pw-video-preview-styles')) return;
    const style = document.createElement('style');
    style.id = 'pw-video-preview-styles';
    style.textContent = `
        .pw-video-preview-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.75); display: flex; align-items: center; justify-content: center; z-index: 10020; backdrop-filter: blur(4px); }
        .pw-video-preview-panel { width: 920px; max-width: 92vw; max-height: 88vh; background: #1e1e1e; border-radius: 8px; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6); display: flex; flex-direction: column; overflow: hidden; border: 1px solid #3c3c3c; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
        .pw-video-preview-header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; background: #2d2d30; border-bottom: 1px solid #3c3c3c; }
        .pw-video-preview-title { font-size: 13px; font-weight: 600; color: #cccccc; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .pw-video-preview-close { cursor: pointer; color: #cccccc; font-size: 16px; line-height: 16px; padding: 4px 6px; border-radius: 4px; transition: background 0.2s, color 0.2s; flex-shrink: 0; }
        .pw-video-preview-close:hover { background: rgba(255, 255, 255, 0.1); color: #ffffff; }
        .pw-video-preview-body { padding: 16px; flex: 1; overflow: hidden; display: flex; align-items: center; justify-content: center; background: #1e1e1e; min-height: 200px; }
        .pw-video-preview-video { max-width: 100%; max-height: 100%; border-radius: 4px; border: 1px solid #3c3c3c; background: #000; }
        .pw-video-trim-section { padding: 12px 16px 8px; background: #252526; border-top: 1px solid #3c3c3c; }
        .pw-video-trim-info { font-size: 12px; color: #cccccc; margin-bottom: 14px; text-align: center; font-family: 'Consolas', 'Courier New', monospace; user-select: none; }
        .pw-video-trim-timeline { position: relative; width: 100%; height: 28px; background: #3c3c3c; border-radius: 4px; cursor: pointer; user-select: none; overflow: hidden; }
        .pw-video-trim-selected { position: absolute; top: 0; bottom: 0; background: rgba(0, 122, 204, 0.35); border-radius: 4px; pointer-events: none; }
        .pw-video-trim-handle { position: absolute; top: -4px; width: 14px; height: 36px; background: #007acc; border-radius: 3px; cursor: ew-resize; z-index: 5; box-shadow: 0 2px 6px rgba(0,0,0,0.4); }
        .pw-video-trim-handle:hover { background: #1a8cd8; }
        .pw-video-trim-controls { padding: 10px 16px 16px; display: flex; justify-content: center; gap: 10px; background: #252526; }
        .pw-video-trim-btn { min-width: 70px; height: 32px; padding: 0 14px; background: #0e639c; color: white; border-radius: 4px; display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 13px; user-select: none; transition: background 0.2s; }
        .pw-video-trim-btn:hover { background: #1177bb; }
        .pw-video-trim-btn-secondary { background: #3c3c3c; }
        .pw-video-trim-btn-secondary:hover { background: #4d4d4d; }
    `;
    document.head.appendChild(style);
}

function openVideoPreviewPW(videoSrc, title, onSave, isAudio) {
    injectVideoPreviewStyles();

    const overlay = document.createElement("div");
    overlay.className = "pw-video-preview-overlay";

    const panel = document.createElement("div");
    panel.className = "pw-video-preview-panel";

    const headerBar = document.createElement("div");
    headerBar.className = "pw-video-preview-header";
    const titleEl = document.createElement("div");
    titleEl.className = "pw-video-preview-title";
    titleEl.innerText = title || "Media Preview";
    const closeButton = document.createElement("div");
    closeButton.className = "pw-video-preview-close";
    closeButton.innerHTML = "×";
    headerBar.appendChild(titleEl);
    headerBar.appendChild(closeButton);

    const body = document.createElement("div");
    body.className = "pw-video-preview-body";

    const media = document.createElement(isAudio ? "audio" : "video");
    media.className = "pw-video-preview-video";
    media.src = videoSrc;
    media.controls = false;
    media.playsInline = true;

    if (isAudio) {
        const icon = document.createElement("div");
        icon.style.cssText = "display:flex;align-items:center;justify-content:center;color:#8fb7e8;";
        icon.innerHTML = '<svg width="84" height="84" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
        body.appendChild(icon);
    }
    body.appendChild(media);

    const trimSection = document.createElement("div");
    trimSection.className = "pw-video-trim-section";
    const infoBar = document.createElement("div");
    infoBar.className = "pw-video-trim-info";
    infoBar.innerText = "Loading...";

    const timeline = document.createElement("div");
    timeline.className = "pw-video-trim-timeline";

    // 波形画布（底层）
    const waveCanvas = document.createElement("canvas");
    waveCanvas.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;z-index:1;pointer-events:none;";
    timeline.appendChild(waveCanvas);

    const selectedRegion = document.createElement("div");
    selectedRegion.className = "pw-video-trim-selected";
    selectedRegion.style.zIndex = "2";
    const leftHandle = document.createElement("div");
    leftHandle.className = "pw-video-trim-handle pw-video-trim-handle-left";
    const rightHandle = document.createElement("div");
    rightHandle.className = "pw-video-trim-handle pw-video-trim-handle-right";
    timeline.appendChild(selectedRegion);
    timeline.appendChild(leftHandle);
    timeline.appendChild(rightHandle);
    trimSection.appendChild(infoBar);
    trimSection.appendChild(timeline);

    const controlsBar = document.createElement("div");
    controlsBar.className = "pw-video-trim-controls";
    const playBtn = document.createElement("div");
    playBtn.className = "pw-video-trim-btn";
    playBtn.innerHTML = "▶ Play";
    const resetBtn = document.createElement("div");
    resetBtn.className = "pw-video-trim-btn pw-video-trim-btn-secondary";
    resetBtn.innerHTML = "Reset";
    controlsBar.appendChild(playBtn);
    controlsBar.appendChild(resetBtn);

    let saveBtn = null;
    if (typeof onSave === "function") {
        saveBtn = document.createElement("div");
        saveBtn.className = "pw-video-trim-btn";
        saveBtn.innerHTML = "Save &amp; Close";
        saveBtn.style.background = "#2e7d32";
        controlsBar.appendChild(saveBtn);
    }

    panel.appendChild(headerBar);
    panel.appendChild(body);
    panel.appendChild(trimSection);
    panel.appendChild(controlsBar);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    // 异步加载并绘制波形（视频/音频通用）
    pwLoadAndDrawWaveform(waveCanvas, videoSrc);

    let duration = 0;
    let startTime = 0;
    let endTime = 0;
    let dragging = null;
    const cleanupFns = [];

    function addListener(target, event, handler, opts) {
        target.addEventListener(event, handler, opts);
        cleanupFns.push(() => target.removeEventListener(event, handler, opts));
    }

    function formatTime(sec) {
        if (!isFinite(sec) || sec < 0) sec = 0;
        const totalCs = Math.round(sec * 100);
        const cs = totalCs % 100;
        const totalSec = Math.floor(totalCs / 100);
        const s = totalSec % 60;
        const m = Math.floor(totalSec / 60);
        return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
    }

    function updateUI() {
        if (duration <= 0) return;
        const leftPct = (startTime / duration) * 100;
        const rightPct = (endTime / duration) * 100;
        leftHandle.style.left = `calc(${leftPct}% - 7px)`;
        rightHandle.style.left = `calc(${rightPct}% - 7px)`;
        selectedRegion.style.left = `${leftPct}%`;
        selectedRegion.style.width = `${Math.max(0, rightPct - leftPct)}%`;
        infoBar.innerText = `Start: ${formatTime(startTime)}   |   End: ${formatTime(endTime)}   |   Kept: ${formatTime(endTime - startTime)}   |   Total: ${formatTime(duration)}`;
    }

    media.addEventListener("loadedmetadata", () => {
        duration = isFinite(media.duration) ? media.duration : 0;
        startTime = 0;
        endTime = duration;
        updateUI();
    });

    addListener(media, "timeupdate", () => {
        if (duration > 0 && !media.paused && media.currentTime >= endTime) {
            media.currentTime = startTime;
        }
    });

    function getTimeFromEvent(e) {
        const rect = timeline.getBoundingClientRect();
        const clientX = (e.touches && e.touches.length) ? e.touches[0].clientX : e.clientX;
        let pct = (clientX - rect.left) / rect.width;
        pct = Math.max(0, Math.min(1, pct));
        return pct * duration;
    }

    addListener(leftHandle, "mousedown", (e) => { e.preventDefault(); e.stopPropagation(); dragging = "left"; });
    addListener(rightHandle, "mousedown", (e) => { e.preventDefault(); e.stopPropagation(); dragging = "right"; });

    addListener(document, "mousemove", (e) => {
        if (!dragging || duration <= 0) return;
        const minGap = Math.min(0.1, duration * 0.01);
        const t = getTimeFromEvent(e);
        if (dragging === "left") {
            startTime = Math.max(0, Math.min(t, endTime - minGap));
            media.currentTime = startTime;
        } else {
            endTime = Math.min(duration, Math.max(t, startTime + minGap));
            media.currentTime = endTime;
        }
        updateUI();
    });

    addListener(document, "mouseup", () => { dragging = null; });

    addListener(timeline, "mousedown", (e) => {
        if (duration > 0 && (e.target === timeline || e.target === selectedRegion)) {
            media.currentTime = getTimeFromEvent(e);
        }
    });

    addListener(playBtn, "click", () => {
        if (duration <= 0) return;
        if (media.paused) {
            if (media.currentTime < startTime || media.currentTime >= endTime) {
                media.currentTime = startTime;
            }
            media.play();
        } else {
            media.pause();
        }
    });

    addListener(media, "play", () => { playBtn.innerHTML = "⏸ Pause"; });
    addListener(media, "pause", () => { playBtn.innerHTML = "▶ Play"; });

    addListener(resetBtn, "click", () => {
        startTime = 0;
        endTime = duration;
        media.currentTime = 0;
        updateUI();
    });

    // Save & Close：保存完成后自动关闭
    if (saveBtn) {
        addListener(saveBtn, "click", () => {
            if (duration <= 0) return;
            try {
                onSave(startTime, endTime, duration);
            } catch (e) {
                console.error("[VideoAudioSimpleUploaderPW] save error:", e);
            }
            closePreview();
        });
    }

    function closePreview() {
        media.pause();
        cleanupFns.forEach((fn) => { try { fn(); } catch (e) {} });
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    addListener(closeButton, "click", closePreview);
    addListener(overlay, "click", (e) => { if (e.target === overlay) closePreview(); });
}

app.registerExtension({
    name: "Comfy.VideoAudioSimpleUploaderPW",
    async nodeCreated(node) {
        if (node.comfyClass !== "VideoAudioSimpleUploaderPW") return;

        injectGalleryStyles();
        injectVideoPreviewStyles();

        node._pwLocalFiles = node._pwLocalFiles || {};

        let v3NodeElement = null;
        function checkIsV3() {
            if (v3NodeElement) return true;
            let el = container.parentElement;
            while (el) {
                if ((el.tagName && el.tagName.toLowerCase().includes('comfy-node')) || 
                    (el.classList && el.classList.contains('comfy-node'))) {
                    v3NodeElement = el;
                    return true;
                }
                el = el.parentElement || (el.getRootNode ? el.getRootNode().host : null);
            }
            return false;
        }

        const container = document.createElement("div");
        container.style.cssText = `
            width: 100%;
            min-width: 100px; 
            background: #222222;
            border: 1px solid #353545;
            border-radius: 4px;
            margin-top: 5px;
            padding: 10px;
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
            gap: 10px;
            pointer-events: auto;
            overflow: hidden;
        `;

        const topBar = document.createElement("div");
        topBar.style.cssText = "display: flex; flex-wrap: wrap; justify-content: flex-start; align-items: center; width: 100%; gap: 8px;";
        
        const uploadBtn = document.createElement("button");
        uploadBtn.innerText = "Upload Media";
        uploadBtn.style.cssText = `
            background: #3a3f4b; color: white; border: 1px solid #5a5f6b; 
            padding: 3px 8px; border-radius: 3px; cursor: pointer; font-size: 10px;
        `;

        const removeAllBtn = document.createElement("button");
        removeAllBtn.innerText = "Remove All";
        removeAllBtn.style.cssText = `
            background: #cc2222; color: white; border: 1px solid #aa1111; 
            padding: 3px 8px; border-radius: 3px; cursor: pointer; font-size: 10px;
            transition: background 0.2s;
        `;
        removeAllBtn.onmouseenter = () => { removeAllBtn.style.background = "#ff3333"; };
        removeAllBtn.onmouseleave = () => { removeAllBtn.style.background = "#cc2222"; };
        removeAllBtn.onclick = () => {
            setWidgetValue([], false);
        };

        topBar.appendChild(uploadBtn);
        topBar.appendChild(removeAllBtn);
        container.appendChild(topBar);

        const gridWrapper = document.createElement("div");
        gridWrapper.style.cssText = `
            position: relative;
            flex-grow: 1;
            width: 100%;
            min-height: 0;
        `;

        const grid = document.createElement("div");
        grid.style.cssText = `
            position: absolute;
            top: 0; left: 0; right: 0; bottom: 0;
            display: grid;
            gap: 8px;
            justify-content: center;
            align-content: center;
        `;
        
        gridWrapper.appendChild(grid);
        container.appendChild(gridWrapper);

        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.multiple = true;
        fileInput.accept = "video/*,audio/*,.mp4,.mov,.mkv,.webm,.m4v,.mp3,.flac,.aac,.m4a,.wav,.ogg,.oga,.opus,.wma,.aiff,.aif";
        fileInput.style.display = "none";
        container.appendChild(fileInput);

        const galleryWidget = node.addDOMWidget("Gallery", "html_gallery", container, { serialize: false });
        
        galleryWidget.computeSize = function() {
            const galleryY = this.last_y || 40;
            const minOutputsHeight = (node.outputs ? node.outputs.length : 1) * 20;
            const requiredGalleryHeight = Math.max(250, minOutputsHeight + 40 - galleryY);
            return [150, requiredGalleryHeight]; 
        };

        const pathsWidget = node.widgets.find(w => w.name === "video_paths");
        if (pathsWidget) {
            Object.defineProperty(pathsWidget, 'hidden', {
                get: () => true,
                set: () => {} 
            });
            Object.defineProperty(pathsWidget, 'type', {
                get: () => "hidden",
                set: () => {} 
            });
            
            pathsWidget.computeSize = function() {
                return [0, 0];
            };

            const hideInterval = setInterval(() => {
                if (pathsWidget.element) {
                    pathsWidget.element.style.display = "none";
                }
            }, 50);
            setTimeout(() => clearInterval(hideInterval), 1000);
        }

        const oldCallback = pathsWidget?.callback;

        function setWidgetValue(newPathsArray, isRearranging = false) {
            if (!pathsWidget) return;
            const val = newPathsArray.join("\n");
            
            const tempCallback = pathsWidget.callback;
            pathsWidget.callback = null;
            
            pathsWidget.value = val;
            if (oldCallback) oldCallback.apply(pathsWidget, [val]);
            
            pathsWidget.callback = tempCallback;
            refreshGallery(isRearranging);
        }

        function optimizeGrid(gridW, gridH) {
            const paths = (pathsWidget?.value || "").split('\n').map(s => s.trim()).filter(s => s);
            const N = paths.length;
            
            if (N === 0) {
                grid.style.gridTemplateColumns = 'repeat(auto-fit, minmax(75px, 1fr))';
                grid.style.gridAutoRows = 'max-content';
                return;
            }
            
            if (gridW <= 0 || gridH <= 0) return;

            let bestS = 0;
            let bestCols = 1;

            for (let c = 1; c <= N; c++) {
                const r = Math.ceil(N / c);
                const maxW = Math.max(5, (gridW - (c - 1) * 8) / c);
                const maxH = Math.max(5, (gridH - (r - 1) * 8) / r);
                const size = Math.min(maxW, maxH);
                
                if (size >= bestS - 0.1) {
                    bestS = size;
                    bestCols = c;
                }
            }
            
            bestS = Math.max(10, Math.floor(bestS)); 
            
            grid.style.gridTemplateColumns = `repeat(${bestCols}, ${bestS}px)`;
            grid.style.gridAutoRows = `${bestS}px`;
        }

        let v3EventsAttached = false;

        function enforceV3CSS() {
            const isV3 = checkIsV3();
            if (isV3 && v3NodeElement) {
                const paddingBottom = 15;
                const galleryY = galleryWidget.last_y || 40;
                const minOutputsHeight = (node.outputs ? node.outputs.length : 1) * 20;
                const absoluteMinHeight = Math.max(galleryY + 250 + paddingBottom, minOutputsHeight + 40);

                v3NodeElement.style.removeProperty('min-width');
                v3NodeElement.style.setProperty('min-height', absoluteMinHeight + 'px', 'important');

                if (!v3EventsAttached) {
                    v3EventsAttached = true;
                    v3NodeElement.addEventListener("dragover", (e) => { e.preventDefault(); });
                    v3NodeElement.addEventListener("drop", (e) => {
                        if (e.dataTransfer && e.dataTransfer.files) {
                            const files = Array.from(e.dataTransfer.files).filter(pwFileLooksLikeMedia);
                            if (files.length > 0) {
                                e.preventDefault();
                                e.stopPropagation();
                                handleFiles(files);
                            }
                        }
                    });
                }
            }
        }

        let isLayouting = false;
        
        function updateLayout(forceShrink = false) {
            if (isLayouting) return;
            isLayouting = true;

            const isV3 = checkIsV3();
            const minW = isV3 ? 100 : 200; 
            const paddingBottom = isV3 ? 15 : 25; 

            const galleryY = galleryWidget.last_y || 40; 
            const minOutputsHeight = (node.outputs ? node.outputs.length : 1) * 20;
            const absoluteMinHeight = Math.max(galleryY + 250 + paddingBottom, minOutputsHeight + 40);

            node.min_size = [minW, absoluteMinHeight];
            enforceV3CSS();

            let targetW = Math.max(node.size[0], minW);
            let targetH = forceShrink ? absoluteMinHeight : node.size[1];

            targetH = Math.max(targetH, absoluteMinHeight);

            if (node.size[0] !== targetW || node.size[1] !== targetH) {
                node.setSize([targetW, targetH]);
                app.graph.setDirtyCanvas(true, true);
            }

            const availableGalleryHeight = Math.max(targetH - galleryY - paddingBottom, 60);
            container.style.height = availableGalleryHeight + "px";

            isLayouting = false;
        }

        const origOnResize = node.onResize;
        node.onResize = function(size) {
            const isV3 = checkIsV3();
            const minW = isV3 ? 100 : 220; 
            const paddingBottom = isV3 ? 15 : 25; 

            const galleryY = galleryWidget.last_y || 40;
            const minOutputsHeight = (this.outputs ? this.outputs.length : 1) * 20;
            const absoluteMinHeight = Math.max(galleryY + 250 + paddingBottom, minOutputsHeight + 40);
            
            size[0] = Math.max(size[0], minW);
            size[1] = Math.max(size[1], absoluteMinHeight);

            if (origOnResize) origOnResize.call(this, size);
            if (isLayouting) return; 
            
            node.min_size = [minW, absoluteMinHeight];
            enforceV3CSS(); 
            
            const availableGalleryHeight = Math.max(size[1] - galleryY - paddingBottom, 60);
            container.style.height = availableGalleryHeight + "px";
        };

        const origComputeSize = node.computeSize;
        node.computeSize = function(out) {
            const isV3 = checkIsV3();
            const minW = isV3 ? 100 : 220; 
            const paddingBottom = isV3 ? 15 : 25; 

            let res = origComputeSize ? origComputeSize.apply(this, arguments) : [minW, 250];
            const galleryY = galleryWidget.last_y || 40; 
            const minOutputsHeight = (this.outputs ? this.outputs.length : 1) * 20;
            const absoluteMinHeight = Math.max(galleryY + 250 + paddingBottom, minOutputsHeight + 40);
     
            this.min_size = [minW, absoluteMinHeight];
            res[0] = Math.max(res[0], minW);
            res[1] = Math.max(res[1], absoluteMinHeight);
            
            enforceV3CSS();  
            return res;
        };

        const origSetSize = node.setSize;
        node.setSize = function(size) {
            const isV3 = checkIsV3();
            const minW = isV3 ? 100 : 220;
            const paddingBottom = isV3 ? 15 : 25; 

            const galleryY = galleryWidget.last_y || 40;
            const minOutputsHeight = (this.outputs ? this.outputs.length : 1) * 20;
            const absoluteMinHeight = Math.max(galleryY + 250 + paddingBottom, minOutputsHeight + 40);

            size[0] = Math.max(size[0], minW);
            size[1] = Math.max(size[1], absoluteMinHeight);

            if (origSetSize) {
                origSetSize.call(this, size);
            } else {
                this.size = size;
            }
            enforceV3CSS();
        };

        let lastObservedWidth = 0;
        let lastObservedHeight = 0;
        
        const resizeObserver = new ResizeObserver((entries) => {
            enforceV3CSS(); 
            for (const entry of entries) {
                const w = Math.round(entry.contentRect.width);
                const h = Math.round(entry.contentRect.height);
                
                if (Math.abs(w - lastObservedWidth) > 1 || Math.abs(h - lastObservedHeight) > 1) {
                    lastObservedWidth = w;
                    lastObservedHeight = h;
                    if (h > 0) {
                        optimizeGrid(w, h);
                    }
                }
            }
        });
        resizeObserver.observe(gridWrapper);

        let draggedNode = null;
        let lastSwapX = 0;
        let lastSwapY = 0;
        let lastSwapTime = 0;

        function refreshGallery(isRearranging = false) {
            grid.innerHTML = "";
            const paths = (pathsWidget?.value || "").split('\n').map(s => s.trim()).filter(s => s);

            paths.forEach((path, index) => {
                const isLocal = path.startsWith("local://");
                let previewSrc = "";
                let displayName = path;
                let localId = null;
                let isTrimmed = false;
                let isAudio = false;

                if (isLocal) {
                    const rest = path.slice("local://".length);
                    const slashIdx = rest.indexOf("/");
                    localId = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
                    displayName = slashIdx >= 0 ? rest.slice(slashIdx + 1) : rest;
                    const entry = node._pwLocalFiles ? node._pwLocalFiles[localId] : null;
                    if (entry) {
                        if (entry.blobUrl) previewSrc = entry.blobUrl;
                        isTrimmed = !!(entry.trim && typeof entry.trim.start === "number" && typeof entry.trim.end === "number" && entry.trim.end > entry.trim.start);
                        isAudio = entry.kind === "audio" || pwIsAudioPath(displayName);
                    } else {
                        isAudio = pwIsAudioPath(displayName);
                    }
                } else {
                    previewSrc = `/view?filename=${encodeURIComponent(path)}&type=input`;
                    displayName = path.split('/').pop();
                    isAudio = pwIsAudioPath(path);
                }

                const item = document.createElement("div");
                item.className = "pw-gallery-item";
                item.dataset.path = path; 
                item.draggable = true;
                item.style.cssText = `
                    position: relative; 
                    width: 100%;
                    height: 100%;
                    aspect-ratio: 1 / 1; 
                    background: #000000; 
                    border-radius: 4px; 
                    border: 1px solid #444; 
                    overflow: hidden; 
                    cursor: grab;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                `;

                let mediaEl;
                if (isAudio) {
                    mediaEl = document.createElement("div");
                    mediaEl.style.cssText = "width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;background:#101318;color:#8fb7e8;pointer-events:none;";
                    mediaEl.innerHTML = PW_MUSIC_ICON_SVG +
                        '<div style="font-size:10px;line-height:1.2;max-width:92%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#9aa4b2;">' + pwEscapeHtml(displayName) + '</div>';
                } else if (isLocal) {
                    mediaEl = document.createElement("video");
                    mediaEl.src = previewSrc;
                    mediaEl.muted = true;
                    mediaEl.preload = "metadata";
                    mediaEl.addEventListener("loadedmetadata", () => {
                        try {
                            const d = isFinite(mediaEl.duration) ? mediaEl.duration : 0;
                            if (d > 0) mediaEl.currentTime = d > 0.3 ? 0.1 : d / 3;
                        } catch (e) {}
                    }, { once: true });
                    mediaEl.style.cssText = "width: 100%; height: 100%; object-fit: cover; display: block; background: #000; pointer-events: none;";
                    mediaEl.draggable = false;
                } else {
                    mediaEl = document.createElement("img");
                    mediaEl.src = `/VideoAudioSimpleUploaderPW/thumbnail?filename=${encodeURIComponent(path)}`;
                    mediaEl.loading = "lazy";
                    mediaEl.style.cssText = "width: 100%; height: 100%; object-fit: cover; display: block; background: #000; pointer-events: none;";
                    mediaEl.draggable = false;
                }
                
                const del = document.createElement("div");
                del.style.cssText = `
                    position: absolute; top: 0; right: 0; 
                    background: #cc2222; color: white; 
                    width: 18px; height: 18px; 
                    display: flex; align-items: center; justify-content: center; 
                    font-size: 14px; cursor: pointer; z-index: 10;
                    font-family: Arial, sans-serif; font-weight: bold;
                    line-height: 1; border-bottom-left-radius: 4px;
                    transition: background 0.2s;
                `;
                del.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
                     <path d="M1 1L9 9M9 1L1 9" stroke="white" stroke-width="2" stroke-linecap="round"/>
                 </svg>`;
                
                del.onmouseenter = () => { del.style.background = "#ff3333"; };
                del.onmouseleave = () => { del.style.background = "#cc2222"; };
                
                del.onclick = (e) => {
                    e.stopPropagation();
                    const removedPath = paths[index];
                    if (removedPath && removedPath.startsWith("local://")) {
                        const rest = removedPath.slice("local://".length);
                        const si = rest.indexOf("/");
                        const lid = si >= 0 ? rest.slice(0, si) : rest;
                        const entry = node._pwLocalFiles ? node._pwLocalFiles[lid] : null;
                        if (entry && entry.blobUrl) URL.revokeObjectURL(entry.blobUrl);
                        if (node._pwLocalFiles) delete node._pwLocalFiles[lid];
                    }
                    const newPaths = paths.filter((_, i) => i !== index);
                    setWidgetValue(newPaths, false);
                };

                const numBadge = document.createElement("div");
                numBadge.style.cssText = `
                    position: absolute; bottom: 0; left: 0; 
                    background: rgba(0, 0, 0, 0.75); color: #fff; 
                    padding: 2px 6px; font-size: 11px; font-family: sans-serif;
                    font-weight: bold; border-top-right-radius: 4px; pointer-events: none;
                    z-index: 5;
                `;
                numBadge.innerText = (index + 1).toString();

                let localBadge = null;
                if (isLocal) {
                    localBadge = document.createElement("div");
                    localBadge.style.cssText = `
                        position: absolute; top: 0; left: 0;
                        background: #e6a817; color: #1a1a1a;
                        padding: 2px 6px; font-size: 10px; font-family: sans-serif;
                        font-weight: bold; border-bottom-right-radius: 4px; pointer-events: none;
                        z-index: 6;
                    `;
                    localBadge.innerText = isTrimmed ? "local ✂" : "local";
                }

                const previewBtn = document.createElement("div");
                previewBtn.className = "pw-crop-btn";
                previewBtn.style.cssText = `
                    position: absolute; top: 50%; left: 50%; 
                    transform: translate(-50%, -50%);
                    background: rgba(0, 0, 0, 0.6); color: white; 
                    width: 48px; height: 48px; 
                    display: flex; align-items: center; justify-content: center; 
                    cursor: pointer; z-index: 10;
                    border-radius: 50%;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.6);
                `;
                previewBtn.innerHTML = PW_TRIM_ICON_SVG;
                previewBtn.onclick = (e) => {
                    e.stopPropagation();
                    if (!previewSrc) return;
                    const saveCallback = isLocal ? (start, end, dur) => {
                        if (localId && node._pwLocalFiles && node._pwLocalFiles[localId]) {
                            const entry = node._pwLocalFiles[localId];
                            const trimmed = dur > 0 && (start > 0.05 || end < dur - 0.05);
                            entry.trim = trimmed ? { start: start, end: end } : null;
                            refreshGallery(false);
                        }
                    } : null;
                    openVideoPreviewPW(previewSrc, displayName, saveCallback, isAudio);
                };

                item.addEventListener("contextmenu", (e) => {
                    e.stopPropagation();
                });

                item.ondragstart = (e) => { 
                    draggedNode = item; 
                    e.dataTransfer.setData('text/plain', path);
                    e.dataTransfer.effectAllowed = "move";
                    
                    setTimeout(() => { 
                        if (draggedNode === item) {
                            item.style.background = "transparent";
                            item.style.border = "2px dashed #666";
                            Array.from(item.children).forEach(c => c.style.opacity = "0");
                        }
                    }, 0);
                };
                
                item.ondragend = () => { 
                    if (draggedNode) {
                        draggedNode.style.background = "#000000";
                        draggedNode.style.border = "1px solid #444";
                        Array.from(draggedNode.children).forEach(c => c.style.opacity = "1");
                    }
                    draggedNode = null; 
                    
                    const newPaths = Array.from(grid.children).map(n => n.dataset.path);
                    const currentVal = (pathsWidget?.value || "").trim();
                    if (newPaths.join("\n") !== currentVal) {
                        setWidgetValue(newPaths, true);
                    }
                };

                item.ondragover = (e) => { 
                    e.preventDefault(); 
                    e.stopPropagation(); 
                    if (!draggedNode || draggedNode === item) return;

                    const distMoved = Math.hypot(e.clientX - lastSwapX, e.clientY - lastSwapY);
                    if (Date.now() - lastSwapTime < 50 && distMoved < 5) {
                        return;
                    }

                    const itemRect = item.getBoundingClientRect();
                    const bufferX = itemRect.width * 0.25; 
                    const bufferY = itemRect.height * 0.25;
                    
                    if (e.clientX < itemRect.left + bufferX || e.clientX > itemRect.right - bufferX ||
                        e.clientY < itemRect.top + bufferY || e.clientY > itemRect.bottom - bufferY) {
                        return;
                    }

                    const items = Array.from(grid.children);
                    const draggedIdx = items.indexOf(draggedNode);
                    const targetIdx = items.indexOf(item);

                    if (draggedIdx < targetIdx) {
                        grid.insertBefore(draggedNode, item.nextSibling);
                    } else {
                        grid.insertBefore(draggedNode, item);
                    }

                    lastSwapX = e.clientX;
                    lastSwapY = e.clientY;
                    lastSwapTime = Date.now();
                };
                
                item.ondrop = (e) => {
                    e.preventDefault();
                    e.stopPropagation(); 
                };

                item.appendChild(mediaEl);
                item.appendChild(del);
                item.appendChild(numBadge);
                if (localBadge) item.appendChild(localBadge);
                item.appendChild(previewBtn);
                grid.appendChild(item);
            });

            if (!isRearranging) {
                requestAnimationFrame(() => {
                    updateLayout();
                    if (gridWrapper.offsetWidth > 0) optimizeGrid(gridWrapper.offsetWidth, gridWrapper.offsetHeight);
                });
            }
        }

        function handleFiles(files) {
            const newPlaceholders = [];
            for (const file of files) {
                const localId = "pwlocal_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
                const blobUrl = URL.createObjectURL(file);
                const kind = ((file.type && file.type.startsWith("audio/")) || pwIsAudioPath(file.name)) ? "audio" : "video";
                node._pwLocalFiles[localId] = { file: file, blobUrl: blobUrl, name: file.name, trim: null, kind: kind };
                newPlaceholders.push(`local://${localId}/${file.name}`);
            }
            if (newPlaceholders.length > 0) {
                const current = (pathsWidget?.value || "").trim();
                const allPaths = current ? current.split('\n').concat(newPlaceholders) : newPlaceholders;
                setWidgetValue(allPaths, false);
            }
        }

        node._pwUploadLocalVideos = async function() {
            if (!node._pwLocalFiles || Object.keys(node._pwLocalFiles).length === 0) return;

            const subfolderWidget = node.widgets.find(w => w.name === "input/");
            const subfolderValue = subfolderWidget ? (subfolderWidget.value || "").trim() : "";

            const lines = (pathsWidget?.value || "").split("\n").map(s => s.trim()).filter(s => s);
            const newLines = [];
            let changed = false;

            const FULL_RANGE_END = 9999999; // 表示"到结尾"（用于未剪辑 .aac 转码）

            for (const line of lines) {
                if (line.startsWith("local://")) {
                    const rest = line.slice("local://".length);
                    const slashIdx = rest.indexOf("/");
                    const localId = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
                    const entry = node._pwLocalFiles[localId];
                    if (entry && entry.file) {
                        const hasTrim = entry.trim &&
                            typeof entry.trim.start === "number" &&
                            typeof entry.trim.end === "number" &&
                            entry.trim.end > entry.trim.start;
                        const ext = pwGetExt(entry.name);
                        const isAac = (ext === "aac"); // .m4a 不在此列

                        try {
                            if (hasTrim) {
                                // 有剪辑：走剪辑端点（服务端会处理 .aac->mp3 与 metadata）
                                const body = new FormData();
                                body.append("file", entry.file);
                                body.append("start", String(entry.trim.start));
                                body.append("end", String(entry.trim.end));
                                body.append("filename", entry.name);
                                if (subfolderValue) body.append("subfolder", subfolderValue);
                                const resp = await api.fetchApi("/VideoAudioSimpleUploaderPW/trim_upload", { method: "POST", body });
                                if (resp.status === 200) {
                                    const data = await resp.json();
                                    if (data && data.name) {
                                        newLines.push(data.name);
                                        if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl);
                                        delete node._pwLocalFiles[localId];
                                        changed = true;
                                    } else {
                                        newLines.push(line);
                                    }
                                } else {
                                    newLines.push(line);
                                }
                            } else if (isAac) {
                                // 未剪辑的 .aac：转码为 .mp3（全段）
                                const body = new FormData();
                                body.append("file", entry.file);
                                body.append("start", "0");
                                body.append("end", String(FULL_RANGE_END));
                                body.append("filename", entry.name);
                                if (subfolderValue) body.append("subfolder", subfolderValue);
                                const resp = await api.fetchApi("/VideoAudioSimpleUploaderPW/trim_upload", { method: "POST", body });
                                if (resp.status === 200) {
                                    const data = await resp.json();
                                    if (data && data.name) {
                                        newLines.push(data.name);
                                        if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl);
                                        delete node._pwLocalFiles[localId];
                                        changed = true;
                                    } else {
                                        newLines.push(line);
                                    }
                                } else {
                                    newLines.push(line);
                                }
                            } else {
                                // 未剪辑、非 .aac：直接上传原文件
                                const body = new FormData();
                                body.append("image", entry.file);
                                if (subfolderValue) body.append("subfolder", subfolderValue);
                                const resp = await api.fetchApi("/upload/image", { method: "POST", body });
                                if (resp.status === 200) {
                                    const data = await resp.json();
                                    let name = data.name;
                                    if (data.subfolder) name = data.subfolder + "/" + name;
                                    newLines.push(name);
                                    if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl);
                                    delete node._pwLocalFiles[localId];
                                    changed = true;
                                } else {
                                    newLines.push(line);
                                }
                            }
                        } catch (err) {
                            console.error("[VideoAudioSimpleUploaderPW] upload error:", err);
                            newLines.push(line);
                        }
                    } else {
                        newLines.push(line);
                    }
                } else {
                    newLines.push(line);
                }
            }

            if (changed && pathsWidget) {
                pathsWidget.value = newLines.join("\n");
                refreshGallery(false);
            }
        };

        const origOnDragDrop = node.onDragDrop;
        node.onDragDrop = function(e) {
            let handled = false;
            if (e.dataTransfer && e.dataTransfer.files) {
                const files = Array.from(e.dataTransfer.files).filter(pwFileLooksLikeMedia);
                if (files.length > 0) {
                    e.preventDefault();
                    handleFiles(files);
                    handled = true;
                }
            }
            if (!handled && origOnDragDrop) {
                return origOnDragDrop.apply(this, arguments);
            }
            return handled;
        };

        const origOnDragOver = node.onDragOver;
        node.onDragOver = function(e) {
            if (e.dataTransfer && e.dataTransfer.items) {
                const hasMedia = Array.from(e.dataTransfer.items).some(f => f.kind === 'file' && pwFileLooksLikeMedia(f));
                if (hasMedia) {
                    e.preventDefault();
                    return true;
                }
            }
            if (origOnDragOver) {
                return origOnDragOver.apply(this, arguments);
            }
            return false;
        };

        uploadBtn.onclick = () => fileInput.click();
        fileInput.onchange = (e) => {
            const files = Array.from(e.target.files || []).filter(pwFileLooksLikeMedia);
            if (files.length > 0) handleFiles(files);
            fileInput.value = "";
        };
        
        container.ondragover = (e) => { e.preventDefault(); e.stopPropagation(); container.style.borderColor = "#4CAF50"; };
        container.ondragleave = (e) => { e.preventDefault(); e.stopPropagation(); container.style.borderColor = "#353545"; };
        container.ondrop = (e) => {
            e.preventDefault();
            e.stopPropagation(); 
            container.style.borderColor = "#353545";
            const files = Array.from(e.dataTransfer.files || []).filter(pwFileLooksLikeMedia);
            if (files.length > 0) handleFiles(files);
        };

        const pasteHandler = (e) => {
            if (app.canvas.selected_nodes && app.canvas.selected_nodes[node.id]) {
                const items = e.clipboardData?.items;
                if (!items) return;
                const files = [];
                for (let i = 0; i < items.length; i++) {
                    if (items[i].kind === 'file') {
                        const f = items[i].getAsFile();
                        if (f && pwFileLooksLikeMedia(f)) files.push(f);
                    }
                }
                if (files.length > 0) {
                    e.preventDefault();
                    e.stopImmediatePropagation(); 
                    handleFiles(files);
                }
            }
        };

        document.addEventListener("paste", pasteHandler, { capture: true });

        const origOnRemoved = node.onRemoved;
        node.onRemoved = function() {
            document.removeEventListener("paste", pasteHandler, { capture: true });
            resizeObserver.disconnect();
            if (node._pwLocalFiles) {
                for (const id in node._pwLocalFiles) {
                    const e = node._pwLocalFiles[id];
                    if (e && e.blobUrl) URL.revokeObjectURL(e.blobUrl);
                }
                node._pwLocalFiles = {};
            }
            if (origOnRemoved) origOnRemoved.apply(this, arguments);
        };

        if (pathsWidget) {
            pathsWidget.callback = (v) => {
                if (oldCallback) oldCallback.apply(pathsWidget, [v]);
                refreshGallery();
            };
        }

        refreshGallery();

        const origOnAdded = node.onAdded;
        node.onAdded = function() {
            if (origOnAdded) origOnAdded.apply(this, arguments);
            const isV3 = checkIsV3();
            if (!isV3) {
                requestAnimationFrame(() => {
                    const galleryY = galleryWidget.last_y || 40;
                    const minOutputsHeight = (this.outputs ? this.outputs.length : 1) * 20;
                    const paddingBottom = 25; 
                    const absoluteMinHeight = Math.max(galleryY + 250 + paddingBottom, minOutputsHeight + 40);
                    if (this.size && this.size[1] > absoluteMinHeight + 5) {
                        this.setSize([this.size[0], absoluteMinHeight]);
                        if (app.graph) app.graph.setDirtyCanvas(true, true);
                    }
                });
            }
        };

        node._pwUpdateLayout = () => updateLayout();
        if (!window._pwVideoAudioUploaderGraphHooked) {
            window._pwVideoAudioUploaderGraphHooked = true;
            const _origAfterGraphConfigured = app.graph.afterGraphConfigured;
            app.graph.afterGraphConfigured = function() {
                if (_origAfterGraphConfigured) _origAfterGraphConfigured.apply(this, arguments);
                setTimeout(() => {
                    const nodes = app.graph._nodes || [];
                    for (const n of nodes) {
                        if (n.comfyClass === "VideoAudioSimpleUploaderPW" && typeof n._pwUpdateLayout === "function") {
                            n._pwUpdateLayout();
                        }
                    }
                }, 100);
            };
        }

        if (!window._pwVideoAudioUploaderQueueHooked) {
            if (typeof app.queuePrompt === "function") {
                window._pwVideoAudioUploaderQueueHooked = true;
                const origQueuePrompt = app.queuePrompt.bind(app);
                app.queuePrompt = async function(...args) {
                    try {
                        const nodes = app.graph._nodes || [];
                        for (const n of nodes) {
                            if (n.comfyClass === "VideoAudioSimpleUploaderPW" && typeof n._pwUploadLocalVideos === "function") {
                                await n._pwUploadLocalVideos();
                            }
                        }
                    } catch (e) {
                        console.error("[VideoAudioSimpleUploaderPW] pre-queue upload error:", e);
                    }
                    return origQueuePrompt(...args);
                };
            }
        }

        [200, 500, 900].forEach(delay => setTimeout(() => updateLayout(), delay));
        setTimeout(() => refreshGallery(), 100);
    }
});