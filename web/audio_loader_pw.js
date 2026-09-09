import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

app.registerExtension({
    name: "Comfy.AudioLoaderPW",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "Audio Loader PW") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            const onDrawBackground = nodeType.prototype.onDrawBackground;

            nodeType.prototype.onDrawBackground = function (ctx) {
                if (onDrawBackground) onDrawBackground.apply(this, arguments);
            };

            nodeType.prototype.onNodeCreated = function () {
                const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
                const node = this;
                node._initializing = true;
                node._should_reset_trim = false;

                setTimeout(() => {
                    if (node.widgets) {
                        const idx = node.widgets.findIndex(w => w.name === "audioUI");
                        if (idx !== -1) {
                            const w = node.widgets[idx];
                            if (w.element) {
                                w.element.style.display = "none";
                                w.element.style.height = "0px";
                                w.element.style.position = "absolute";
                                w.element.style.pointerEvents = "none";
                            }
                            w.type = "hidden";
                            w.hidden = true;
                            w.computeSize = () => [0, 0];
                            const cw = node.size[0];
                            node.setSize([cw, node.computeSize()[1]]);
                            if (app.graph) app.graph.setDirtyCanvas(true, true);
                        }
                    }
                }, 10);

                Object.defineProperty(node, 'imgs', {
                    get: function () { return undefined; },
                    set: function () { },
                    configurable: true
                });

                const getSubfolder = () => {
                    const sfW = node.widgets && node.widgets.find(w => w.name === "upload_subfolder");
                    return (sfW && sfW.value) ? sfW.value.trim() : "";
                };

                // ===== 上传（.aac 自动转 .mp3）=====
                const handleFileUpload = async (file) => {
                    const ext = (file.name.split('.').pop() || '').toLowerCase();
                    const isMedia = file.type.startsWith('audio/') || file.type.startsWith('video/') || ext === 'aac';
                    if (!isMedia) return false;
                    try {
                        const subfolder = getSubfolder();
                        let resp;
                        if (ext === 'aac') {
                            const body = new FormData();
                            body.append("file", file);
                            body.append("filename", file.name);
                            if (subfolder) body.append("subfolder", subfolder);
                            resp = await api.fetchApi("/AudioLoaderPW/aac_to_mp3_upload", { method: "POST", body });
                        } else {
                            const body = new FormData();
                            body.append("image", file);
                            body.append("type", "input");
                            body.append("subfolder", subfolder);
                            resp = await api.fetchApi("/upload/image", { method: "POST", body });
                        }

                        if (resp.status === 200) {
                            const data = await resp.json();
                            const pathWidget = node.widgets && node.widgets.find(w => w.name === "path");
                            if (pathWidget) {
                                node._should_reset_trim = true;
                                let fullName;
                                if (ext === 'aac') {
                                    fullName = data.name;
                                } else {
                                    fullName = data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
                                }
                                pathWidget.value = fullName;
                                if (pathWidget.callback) pathWidget.callback(fullName);
                                app.graph.setDirtyCanvas(true, false);
                            }
                        } else {
                            const errText = await resp.text();
                            console.error("Upload/convert failed:", resp.status, errText);
                        }
                    } catch (err) {
                        console.error("Error uploading audio file:", err);
                    }
                    return true;
                };

                // ===== 文件选择 + "choose file to upload" 按钮（参考 VideoLoaderPW）=====
                const fileInput = document.createElement("input");
                fileInput.type = "file";
                fileInput.accept = "audio/*,video/*,.aac";
                fileInput.style.display = "none";
                document.body.appendChild(fileInput);

                this.addWidget("button", "choose file to upload", null, () => { fileInput.click(); });

                fileInput.addEventListener("change", (e) => {
                    if (e.target.files.length) handleFileUpload(e.target.files[0]);
                    fileInput.value = "";
                });

                this.onDragDrop = function (e) {
                    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                        const file = e.dataTransfer.files[0];
                        const ext = (file.name.split('.').pop() || '').toLowerCase();
                        if (file.type.startsWith('audio/') || file.type.startsWith('video/') || ext === 'aac') {
                            handleFileUpload(file);
                            return true;
                        }
                    }
                    return false;
                };

                // ===== UI 容器 =====
                const container = document.createElement("div");
                const defaultBg = "rgba(30,30,30,0.9)";
                Object.assign(container.style, {
                    display: "flex", flexDirection: "column", gap: "10px",
                    width: "100%", padding: "10px", boxSizing: "border-box",
                    background: defaultBg, borderRadius: "6px", color: "white",
                    fontFamily: "sans-serif", marginTop: "8px", flexShrink: "0",
                    transition: "background 0.2s"
                });

                const playerTop = document.createElement("div");
                Object.assign(playerTop.style, { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 2px", marginBottom: "-4px" });

                const playerTitle = document.createElement("span");
                playerTitle.textContent = "No audio selected";
                Object.assign(playerTitle.style, { fontSize: "11px", color: "#aaa", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "140px" });

                const trimLength = document.createElement("span");
                Object.assign(trimLength.style, { fontSize: "11px", color: "#38bdf8", fontWeight: "bold", background: "rgba(56,189,248,0.1)", padding: "3px 6px", borderRadius: "4px", whiteSpace: "nowrap" });
                trimLength.textContent = "Trimmed: 0.0s";

                playerTop.appendChild(playerTitle);
                playerTop.appendChild(trimLength);
                container.appendChild(playerTop);

                const audioEl = document.createElement("audio");
                audioEl.controls = true;
                audioEl.style.width = "100%";
                audioEl.style.height = "40px";
                audioEl.style.outline = "none";
                container.appendChild(audioEl);
                node._audioEl = audioEl;
                node._playerTitle = playerTitle;

                // ===== applyAudioPath（同步 path 字段）=====
                const applyAudioPath = (rawPath) => {
                    if (!rawPath || !rawPath.trim()) return;
                    const p = rawPath.trim();
                    const isNewFile = (p !== node._lastLoadedAudioPath);
                    node._lastLoadedAudioPath = p;
                    if (isNewFile) {
                        const endW = node.widgets && node.widgets.find(w => w.name === "end_time");
                        const startW = node.widgets && node.widgets.find(w => w.name === "start_time");
                        if (endW) endW.value = 0;
                        if (startW) startW.value = 0;
                        node._should_reset_trim = true;
                    }
                    const pathW = node.widgets && node.widgets.find(w => w.name === "path");
                    if (pathW) pathW.value = p;

                    let audioSrc;
                    const isAbsolute = (p.length >= 2 && p[1] === ':') || p.startsWith('/');
                    if (isAbsolute) {
                        audioSrc = api.apiURL(`/video_ui_custom_view?filename=${encodeURIComponent(p)}`);
                        playerTitle.textContent = p.split(/[\/\\]/).pop();
                    } else {
                        let fname = p, subfolder = "";
                        if (fname.includes("/") || fname.includes("\\")) {
                            const sep = fname.includes("/") ? "/" : "\\";
                            const parts = fname.split(sep);
                            fname = parts.pop();
                            subfolder = parts.join("/");
                        }
                        playerTitle.textContent = fname;
                        audioSrc = api.apiURL(`/view?filename=${encodeURIComponent(fname)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);
                    }
                    if (isNewFile) {
                        audioEl.src = audioSrc;
                        drawWaveform(audioSrc);
                    }
                };

                const _execHandler = ({ detail }) => {
                    if (!detail || String(detail.node) !== String(node.id)) return;
                    const out = detail.output;
                    if (out && out.audio_path && out.audio_path.length) applyAudioPath(out.audio_path[0]);
                };
                api.addEventListener("executed", _execHandler);

                // ===== trim area + waveform =====
                const trimArea = document.createElement("div");
                Object.assign(trimArea.style, { display: "flex", flexDirection: "column", gap: "6px", background: "rgba(0,0,0,0.35)", padding: "12px", borderRadius: "6px", border: "1px solid rgba(255,255,255,0.05)" });

                const timeRuler = document.createElement("div");
                Object.assign(timeRuler.style, { position: "relative", width: "100%", height: "22px", fontSize: "10px", color: "#aaa", pointerEvents: "none", userSelect: "none" });
                trimArea.appendChild(timeRuler);

                const sliderBox = document.createElement("div");
                Object.assign(sliderBox.style, { position: "relative", width: "100%", height: "36px", background: "#111", borderRadius: "4px", cursor: "pointer", userSelect: "none", boxShadow: "inset 0 1px 3px rgba(0,0,0,0.5)", overflow: "hidden" });

                const waveCanvas = document.createElement("canvas");
                Object.assign(waveCanvas.style, { position: "absolute", top: "0", left: "0", width: "100%", height: "100%", pointerEvents: "none", zIndex: "0" });
                sliderBox.insertBefore(waveCanvas, sliderBox.firstChild);

                const fill = document.createElement("div");
                Object.assign(fill.style, { position: "absolute", height: "100%", background: "rgba(14,165,233,0.35)", pointerEvents: "none", zIndex: "1" });
                sliderBox.appendChild(fill);

                const createHandle = (color) => {
                    const h = document.createElement("div");
                    Object.assign(h.style, { position: "absolute", top: "0", width: "8px", height: "100%", background: color, transform: "translateX(-50%)", pointerEvents: "none", boxShadow: "0 0 4px rgba(0,0,0,0.8)", borderRadius: "2px", zIndex: "2" });
                    return h;
                };
                const startHandle = createHandle("#38bdf8");
                const endHandle = createHandle("#38bdf8");
                sliderBox.appendChild(startHandle);
                sliderBox.appendChild(endHandle);
                trimArea.appendChild(sliderBox);
                container.appendChild(trimArea);

                const widget = this.addDOMWidget("audio_ui", "audio_ui", container);
                this.size = [475, this.computeSize()[1]];
                widget.computeSize = function (width) { return [width, 200]; };

                let cachedWaveData = null;

                const renderWaveform = () => {
                    const ctx = waveCanvas.getContext("2d");
                    if (!cachedWaveData) { if (ctx) ctx.clearRect(0, 0, waveCanvas.width, waveCanvas.height); return; }
                    const width = waveCanvas.clientWidth * 2;
                    const height = waveCanvas.clientHeight * 2;
                    if (!width || !height) return;
                    waveCanvas.width = width;
                    waveCanvas.height = height;
                    ctx.clearRect(0, 0, width, height);
                    ctx.fillStyle = "rgba(140,160,180,0.6)";
                    const mid = height / 2;
                    const len = cachedWaveData.length;
                    for (let i = 0; i < width; i++) {
                        const p = cachedWaveData[Math.floor((i / width) * len)];
                        ctx.fillRect(i, mid - p.max * mid, 1, Math.max(1, (p.max - p.min) * mid));
                    }
                };

                const drawWaveform = async (src) => {
                    if (!src) return;
                    try {
                        const resp = await fetch(src);
                        if (!resp.ok) return;
                        const buf = await resp.arrayBuffer();
                        const actx = new (window.AudioContext || window.webkitAudioContext)();
                        const abuf = await actx.decodeAudioData(buf);
                        const raw = abuf.getChannelData(0);
                        const N = 1000;
                        const step = Math.floor(raw.length / N);
                        if (!step) return;
                        let peak = 0;
                        const pts = [];
                        for (let i = 0; i < N; i++) {
                            let mn = 1, mx = -1;
                            for (let j = 0; j < step; j++) {
                                const v = raw[i * step + j];
                                if (v < mn) mn = v;
                                if (v > mx) mx = v;
                            }
                            peak = Math.max(peak, Math.abs(mn), Math.abs(mx));
                            pts.push({ min: mn, max: mx });
                        }
                        if (!peak) peak = 1;
                        cachedWaveData = pts.map(p => ({ min: p.min / peak, max: p.max / peak }));
                        renderWaveform();
                    } catch (e) { console.warn("Waveform decode failed:", e); }
                };

                const resizeObs = new ResizeObserver(() => renderWaveform());
                resizeObs.observe(sliderBox);

                const _origRemoved = node.onRemoved;
                node.onRemoved = function () {
                    api.removeEventListener("executed", _execHandler);
                    if (resizeObs) resizeObs.disconnect();
                    if (fileInput && fileInput.parentNode) fileInput.parentNode.removeChild(fileInput);
                    if (_origRemoved) _origRemoved.apply(this, arguments);
                };

                // ===== widget bindings =====
                setTimeout(() => {
                    const pathWidget = node.widgets && node.widgets.find(w => w.name === "path");
                    const startWidget = node.widgets && node.widgets.find(w => w.name === "start_time");
                    const endWidget = node.widgets && node.widgets.find(w => w.name === "end_time");
                    const durationWidget = node.widgets && node.widgets.find(w => w.name === "duration");
                    const preSilenceWidget = node.widgets && node.widgets.find(w => w.name === "pre_silence");
                    const postSilenceWidget = node.widgets && node.widgets.find(w => w.name === "post_silence");

                    let duration = 0, dragging = null, dragOffset = 0, dragSelW = 0, isUpdatingDuration = false;

                    if (durationWidget) {
                        const origCb = durationWidget.callback;
                        durationWidget.callback = function (v) {
                            if (!duration || isUpdatingDuration) { if (origCb) origCb.apply(this, arguments); return; }
                            isUpdatingDuration = true;
                            let d = Math.max(0, parseFloat(v) || 0);
                            let pre = preSilenceWidget ? parseFloat(preSilenceWidget.value) || 0 : 0;
                            let post = postSilenceWidget ? parseFloat(postSilenceWidget.value) || 0 : 0;
                            let avail = Math.max(0, d - pre - post);
                            let s = startWidget ? parseFloat(startWidget.value) || 0 : 0;
                            let newEnd = s + avail;
                            let newStart = s;
                            if (newEnd > duration) { newEnd = duration; newStart = Math.max(0, duration - avail); }
                            if (startWidget) startWidget.value = parseFloat(newStart.toFixed(2));
                            if (endWidget) endWidget.value = parseFloat(newEnd.toFixed(2));
                            updateUI(true);
                            app.graph.setDirtyCanvas(true, false);
                            if (origCb) origCb.apply(this, arguments);
                            isUpdatingDuration = false;
                        };
                    }

                    if (pathWidget) {
                        const updateAudio = (overridePath) => {
                            const filename = overridePath || pathWidget.value;
                            if (!filename || !filename.trim()) {
                                playerTitle.textContent = "No audio selected";
                                cachedWaveData = null;
                                renderWaveform();
                                return;
                            }
                            let audioSrc;
                            if (filename.match(/^[a-zA-Z]:\\/) || filename.startsWith('/')) {
                                audioSrc = api.apiURL(`/video_ui_custom_view?filename=${encodeURIComponent(filename)}`);
                                playerTitle.textContent = filename.split(/[\\/]/).pop();
                            } else {
                                let fname = filename, subfolder = "";
                                if (fname.includes("/") || fname.includes("\\")) {
                                    const sep = fname.includes("/") ? "/" : "\\";
                                    const parts = fname.split(sep);
                                    fname = parts.pop();
                                    subfolder = parts.join("/");
                                }
                                playerTitle.textContent = fname;
                                audioSrc = api.apiURL(`/view?filename=${encodeURIComponent(fname)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);
                            }
                            if (audioSrc !== audioEl.src) {
                                audioEl.src = audioSrc;
                                drawWaveform(audioSrc);
                            }
                        };
                        pathWidget.callback = function () {
                            if (!node._initializing) node._should_reset_trim = true;
                            updateAudio();
                        };
                        updateAudio();
                        node._updateAudio = updateAudio;
                    }

                    container.ondragover = (e) => { e.preventDefault(); e.stopPropagation(); container.style.background = "rgba(14,165,233,0.2)"; };
                    container.ondragleave = (e) => { e.preventDefault(); e.stopPropagation(); container.style.background = defaultBg; };
                    container.ondrop = async (e) => {
                        e.preventDefault(); e.stopPropagation();
                        container.style.background = defaultBg;
                        if (e.dataTransfer.files && e.dataTransfer.files.length) handleFileUpload(e.dataTransfer.files[0]);
                    };

                    const formatTime = (s) => s < 60 ? s.toFixed(1) + "s" : `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

                    const updateRuler = () => {
                        timeRuler.innerHTML = '';
                        if (!duration) return;
                        const total = 16;
                        for (let i = 0; i <= total; i++) {
                            const pct = i / total;
                            const major = i % 4 === 0;
                            const tw = document.createElement("div");
                            Object.assign(tw.style, { position: "absolute", left: `${pct * 100}%`, top: "0", display: "flex", flexDirection: "column", alignItems: "center", transform: "translateX(-50%)" });
                            if (i === 0) { tw.style.transform = "none"; tw.style.alignItems = "flex-start"; }
                            if (i === total) { tw.style.transform = "translateX(-100%)"; tw.style.alignItems = "flex-end"; }
                            const ln = document.createElement("div");
                            Object.assign(ln.style, { width: major ? "2px" : "1px", height: major ? "6px" : "4px", background: major ? "#aaa" : "#555", marginBottom: "2px", borderRadius: "1px" });
                            tw.appendChild(ln);
                            if (major) { const lb = document.createElement("div"); lb.textContent = formatTime(duration * pct); tw.appendChild(lb); }
                            timeRuler.appendChild(tw);
                        }
                    };

                    const updateUI = (syncPlayer = false) => {
                        if (!duration) return;
                        let s = startWidget ? parseFloat(startWidget.value) || 0 : 0;
                        let e = endWidget ? parseFloat(endWidget.value) || 0 : 0;
                        let pre = preSilenceWidget ? parseFloat(preSilenceWidget.value) || 0 : 0;
                        let post = postSilenceWidget ? parseFloat(postSilenceWidget.value) || 0 : 0;
                        if (e === 0 || e > duration) e = duration;
                        if (s > e) s = e;
                        const sPct = (s / duration) * 100, ePct = (e / duration) * 100;
                        startHandle.style.left = `${sPct}%`;
                        endHandle.style.left = `${ePct}%`;
                        fill.style.left = `${sPct}%`;
                        fill.style.width = `${ePct - sPct}%`;
                        const cur = parseFloat((e - s + pre + post).toFixed(2));
                        trimLength.textContent = `Trimmed: ${cur}s`;
                        if (durationWidget && durationWidget.value !== cur) { isUpdatingDuration = true; durationWidget.value = cur; isUpdatingDuration = false; }
                        if (syncPlayer && audioEl.readyState >= 1) audioEl.currentTime = s;
                    };

                    audioEl.onloadedmetadata = () => {
                        duration = audioEl.duration;
                        if (node._should_reset_trim) {
                            if (startWidget) startWidget.value = 0;
                            if (endWidget) endWidget.value = parseFloat(duration.toFixed(2));
                            node._should_reset_trim = false;
                        } else {
                            let e = endWidget ? parseFloat(endWidget.value) || 0 : 0;
                            if (endWidget && (e === 0 || e > duration)) endWidget.value = parseFloat(duration.toFixed(2));
                        }
                        updateRuler();
                        updateUI();
                        app.graph.setDirtyCanvas(true, false);
                    };

                    audioEl.ontimeupdate = () => {
                        if (dragging || !duration) return;
                        let s = startWidget ? parseFloat(startWidget.value) || 0 : 0;
                        let e = endWidget ? parseFloat(endWidget.value) || duration : duration;
                        if (e === 0) e = duration;
                        if (audioEl.currentTime >= e) { audioEl.pause(); audioEl.currentTime = s; }
                    };

                    audioEl.onplay = () => {
                        let s = startWidget ? parseFloat(startWidget.value) || 0 : 0;
                        let e = endWidget ? parseFloat(endWidget.value) || duration : duration;
                        if (e === 0) e = duration;
                        if (audioEl.currentTime < s || audioEl.currentTime >= e) audioEl.currentTime = s;
                    };

                    [startWidget, endWidget, preSilenceWidget, postSilenceWidget].forEach(w => {
                        if (w) { const orig = w.callback; w.callback = function () { updateUI(true); if (orig) orig.apply(this, arguments); }; }
                    });

                    sliderBox.onpointerdown = (e) => {
                        if (!duration) return;
                        const rect = sliderBox.getBoundingClientRect();
                        const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
                        const val = (x / rect.width) * duration;
                        let s = startWidget ? parseFloat(startWidget.value) || 0 : 0;
                        let ev = endWidget ? parseFloat(endWidget.value) || duration : duration;
                        const tol = (10 / rect.width) * duration;
                        if (val > s + tol && val < ev - tol) { dragging = 'center'; dragOffset = val - s; dragSelW = ev - s; }
                        else if (Math.abs(val - s) < Math.abs(val - ev)) { dragging = 'start'; if (startWidget) startWidget.value = parseFloat(Math.min(val, ev).toFixed(2)); }
                        else { dragging = 'end'; if (endWidget) endWidget.value = parseFloat(Math.max(val, s).toFixed(2)); }
                        updateUI(true);
                        app.graph.setDirtyCanvas(true, false);
                        sliderBox.setPointerCapture(e.pointerId);
                    };

                    sliderBox.onpointermove = (e) => {
                        if (!dragging || !duration) return;
                        const rect = sliderBox.getBoundingClientRect();
                        const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
                        const val = (x / rect.width) * duration;
                        if (dragging === 'start') { let ev = endWidget ? parseFloat(endWidget.value) || duration : duration; if (startWidget) startWidget.value = parseFloat(Math.min(val, ev).toFixed(2)); }
                        else if (dragging === 'end') { const s = startWidget ? parseFloat(startWidget.value) || 0 : 0; if (endWidget) endWidget.value = parseFloat(Math.max(val, s).toFixed(2)); }
                        else if (dragging === 'center') {
                            let ns = val - dragOffset, ne = ns + dragSelW;
                            if (ns < 0) { ns = 0; ne = dragSelW; } else if (ne > duration) { ne = duration; ns = duration - dragSelW; }
                            if (startWidget) startWidget.value = parseFloat(ns.toFixed(2));
                            if (endWidget) endWidget.value = parseFloat(ne.toFixed(2));
                        }
                        updateUI(true);
                        app.graph.setDirtyCanvas(true, false);
                    };

                    sliderBox.onpointerup = (e) => { dragging = null; sliderBox.releasePointerCapture(e.pointerId); };

                    setTimeout(() => { node._initializing = false; }, 500);
                }, 100);

                node.onExecuted = function (output) {
                    if (output && output.audio_path && output.audio_path.length) applyAudioPath(output.audio_path[0]);
                };

                return r;
            };
        }
    }
});