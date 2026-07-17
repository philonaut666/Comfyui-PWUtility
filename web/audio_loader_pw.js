import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

app.registerExtension({
    name: "Comfy.AudioLoaderPW",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "Audio Loader PW") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            const onDrawBackground = nodeType.prototype.onDrawBackground;
            
            nodeType.prototype.onDrawBackground = function (ctx) {
                if (onDrawBackground) {
                    onDrawBackground.apply(this, arguments);
                }
            };
            
            nodeType.prototype.onNodeCreated = function () {
                const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
                const node = this;
                
                node._initializing = true;
                node._should_reset_trim = false;
                
                setTimeout(() => {
                    if (node.widgets) {
                        const nativeWidgetIndex = node.widgets.findIndex(w => w.name === "audioUI");
                        if (nativeWidgetIndex !== -1) {
                            const w = node.widgets[nativeWidgetIndex];
                            if (w.element) {
                                w.element.style.display = "none";
                                w.element.style.height = "0px";
                                w.element.style.position = "absolute";
                                w.element.style.pointerEvents = "none";
                            }
                            w.type = "hidden";
                            w.hidden = true;
                            w.computeSize = () => [0, 0];
                            
                            const currentWidth = node.size[0];
                            const recommendedHeight = node.computeSize()[1];
                            node.setSize([currentWidth, recommendedHeight]);
                            
                            if (app.graph) {
                                app.graph.setDirtyCanvas(true, true);
                            }
                        }
                    }
                }, 10);

                Object.defineProperty(node, 'imgs', {
                    get: function() { return undefined; },
                    set: function(val) { /* Ignore attempts by ComfyUI to set an image preview */ },
                    configurable: true
                });

                const handleFileUpload = async (file) => {
                    if (!file.type.startsWith('audio/') && !file.type.startsWith('video/')) return false;
                    try {
                        const body = new FormData();
                        body.append("image", file);
                        body.append("type", "input");
                        body.append("subfolder", "");
                        
                        const resp = await api.fetchApi("/upload/image", {
                            method: "POST",
                            body,
                        });

                        if (resp.status === 200) {
                            const data = await resp.json();
                            const audioWidget = node.widgets && node.widgets.find(w => w.name === "audio");
                            if (audioWidget) {
                                node._should_reset_trim = true;
                                audioWidget.value = data.name;
                                if (audioWidget.options && audioWidget.options.values && !audioWidget.options.values.includes(data.name)) {
                                    audioWidget.options.values.push(data.name);
                                }
                                if (audioWidget.callback) {
                                    audioWidget.callback(data.name);
                                }
                                app.graph.setDirtyCanvas(true, false);
                            }
                        }
                    } catch (err) {
                        console.error("Error uploading dragged audio file: ", err);
                    }
                    return true;
                };

                this.onDragDrop = function(e) {
                    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                        const file = e.dataTransfer.files[0];
                        if (file.type.startsWith('audio/') || file.type.startsWith('video/')) {
                            handleFileUpload(file);
                            return true;
                        }
                    }
                    return false;
                };

                const container = document.createElement("div");
                const defaultBg = "rgba(30, 30, 30, 0.9)";
                Object.assign(container.style, {
                    display: "flex",
                    flexDirection: "column",
                    gap: "10px", 
                    width: "100%",
                    padding: "10px", 
                    boxSizing: "border-box",
                    background: defaultBg,
                    borderRadius: "6px",
                    color: "white",
                    fontFamily: "sans-serif",
                    marginTop: "8px",
                    flexShrink: "0",
                    transition: "background 0.2s"
                });

                const playerTop = document.createElement("div");
                Object.assign(playerTop.style, {
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "0 2px",
                    marginBottom: "-4px"
                });
                
                const playerTitle = document.createElement("span");
                playerTitle.textContent = "No audio selected";
                Object.assign(playerTitle.style, {
                    fontSize: "11px",
                    color: "#aaa",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    maxWidth: "140px"
                });

                const trimLength = document.createElement("span");
                Object.assign(trimLength.style, {
                    fontSize: "11px",
                    color: "#38bdf8",
                    fontWeight: "bold",
                    background: "rgba(56, 189, 248, 0.1)",
                    padding: "3px 6px",
                    borderRadius: "4px",
                    whiteSpace: "nowrap"
                });
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

                    let audioSrc;
                    const isAbsolute = (p.length >= 2 && p[1] === ':') || p.startsWith('/');
                    if (isAbsolute) {
                        audioSrc = api.apiURL(`/video_ui_custom_view?filename=${encodeURIComponent(p)}`);
                        playerTitle.textContent = p.split(/[\/\\]/).pop();
                    } else {
                        const audioW = node.widgets && node.widgets.find(w => w.name === "audio");
                        if (audioW) audioW.value = p;
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
                    }
                };

                const _execHandler = ({ detail }) => {
                    if (!detail || String(detail.node) !== String(node.id)) return;
                    const out = detail.output;
                    if (out && out.audio_path && out.audio_path.length) {
                        applyAudioPath(out.audio_path[0]);
                    }
                };
                api.addEventListener("executed", _execHandler);

                const trimArea = document.createElement("div");
                Object.assign(trimArea.style, {
                    display: "flex",
                    flexDirection: "column",
                    gap: "6px",
                    background: "rgba(0, 0, 0, 0.35)",
                    padding: "12px",
                    borderRadius: "6px",
                    border: "1px solid rgba(255, 255, 255, 0.05)"
                });

                const timeRuler = document.createElement("div");
                Object.assign(timeRuler.style, {
                    position: "relative",
                    width: "100%",
                    height: "22px",
                    fontSize: "10px",
                    color: "#aaa",
                    pointerEvents: "none",
                    userSelect: "none"
                });
                trimArea.appendChild(timeRuler);

                const sliderBox = document.createElement("div");
                Object.assign(sliderBox.style, {
                    position: "relative",
                    width: "100%",
                    height: "36px", // 稍微增加高度以更好展示波形
                    background: "#111",
                    borderRadius: "4px",
                    cursor: "pointer",
                    userSelect: "none",
                    boxShadow: "inset 0 1px 3px rgba(0,0,0,0.5)",
                    overflow: "hidden"
                });

                // --- 新增：波形 Canvas ---
                const waveCanvas = document.createElement("canvas");
                Object.assign(waveCanvas.style, {
                    position: "absolute",
                    top: "0",
                    left: "0",
                    width: "100%",
                    height: "100%",
                    pointerEvents: "none",
                    zIndex: "0"
                });
                sliderBox.insertBefore(waveCanvas, sliderBox.firstChild);

                const fill = document.createElement("div");
                Object.assign(fill.style, {
                    position: "absolute",
                    height: "100%",
                    background: "rgba(14, 165, 233, 0.35)",
                    pointerEvents: "none",
                    zIndex: "1"
                });
                sliderBox.appendChild(fill);

                const createHandle = (color) => {
                    const h = document.createElement("div");
                    Object.assign(h.style, {
                        position: "absolute",
                        top: "0",
                        width: "8px",
                        height: "100%",
                        background: color,
                        transform: "translateX(-50%)",
                        pointerEvents: "none",
                        boxShadow: "0 0 4px rgba(0,0,0,0.8)",
                        borderRadius: "2px",
                        zIndex: "2"
                    });
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
                
                widget.computeSize = function(width) {
                    return [width, 200];
                };

                let cachedWaveData = null;

                const renderWaveform = () => {
                    if (!cachedWaveData) {
                        const ctx = waveCanvas.getContext("2d");
                        if (ctx) ctx.clearRect(0, 0, waveCanvas.width, waveCanvas.height);
                        return;
                    }
                    const width = waveCanvas.clientWidth * 2;
                    const height = waveCanvas.clientHeight * 2;
                    if (width === 0 || height === 0) return;
                    
                    waveCanvas.width = width;
                    waveCanvas.height = height;
                    const ctx = waveCanvas.getContext("2d");
                    ctx.clearRect(0, 0, width, height);
                    
                    ctx.fillStyle = "rgba(140, 160, 180, 0.6)";
                    const mid = height / 2;
                    const dataLen = cachedWaveData.length;
                    
                    for (let i = 0; i < width; i++) {
                        const dataIndex = Math.floor((i / width) * dataLen);
                        const p = cachedWaveData[dataIndex];
                        const y1 = mid - p.max * mid;
                        const y2 = mid - p.min * mid;
                        ctx.fillRect(i, y1, 1, y2 - y1);
                    }
                };

                const drawWaveform = async (src) => {
                    if (!src) return;
                    try {
                        const response = await fetch(src);
                        if (!response.ok) return;
                        const arrayBuffer = await response.arrayBuffer();
                        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
                        const rawData = audioBuffer.getChannelData(0); 
                        
                        const numPoints = 1000;
                        const step = Math.floor(rawData.length / numPoints);
                        if (step === 0) return;
                        
                        let globalPeak = 0;
                        const points = [];
                        for (let i = 0; i < numPoints; i++) {
                            let min = 1.0, max = -1.0;
                            for (let j = 0; j < step; j++) {
                                const val = rawData[(i * step) + j];
                                if (val < min) min = val;
                                if (val > max) max = val;
                            }
                            if (Math.abs(min) > globalPeak) globalPeak = Math.abs(min);
                            if (Math.abs(max) > globalPeak) globalPeak = Math.abs(max);
                            points.push({min, max});
                        }
                        if (globalPeak === 0) globalPeak = 1;
                        
                        cachedWaveData = points.map(p => ({
                            min: p.min / globalPeak,
                            max: p.max / globalPeak
                        }));
                        
                        renderWaveform();
                    } catch (e) {
                        console.warn("Waveform decode failed:", e);
                    }
                };

                const resizeObserver = new ResizeObserver(() => {
                    renderWaveform();
                });
                resizeObserver.observe(sliderBox);

                const _origRemoved = node.onRemoved;
                node.onRemoved = function () {
                    api.removeEventListener("executed", _execHandler);
                    if (resizeObserver) resizeObserver.disconnect();
                    if (_origRemoved) _origRemoved.apply(this, arguments);
                };

                setTimeout(() => {
                    const audioWidget = node.widgets && node.widgets.find(w => w.name === "audio");
                    const startWidget = node.widgets && node.widgets.find(w => w.name === "start_time");
                    const endWidget = node.widgets && node.widgets.find(w => w.name === "end_time");
                    const durationWidget = node.widgets && node.widgets.find(w => w.name === "duration");
                    const preSilenceWidget = node.widgets && node.widgets.find(w => w.name === "pre_silence");
                    const postSilenceWidget = node.widgets && node.widgets.find(w => w.name === "post_silence");
                    
                    let duration = 0;
                    let dragging = null;
                    let dragOffset = 0;
                    let dragSelectionWidth = 0;
                    let isUpdatingDuration = false;

                    if (durationWidget) {
                        const origCallback = durationWidget.callback;
                        durationWidget.callback = function(v) {
                            if (!duration || isUpdatingDuration) {
                                if (origCallback) origCallback.apply(this, arguments);
                                return;
                            }
                            
                            isUpdatingDuration = true;
                            let d = parseFloat(v) || 0;
                            if (d < 0) d = 0;
                            
                            let pre = preSilenceWidget ? parseFloat(preSilenceWidget.value) || 0 : 0;
                            let post = postSilenceWidget ? parseFloat(postSilenceWidget.value) || 0 : 0;
                            let availableForAudio = d - pre - post;
                            if (availableForAudio < 0) availableForAudio = 0;

                            let s = startWidget ? parseFloat(startWidget.value) || 0 : 0;
                            let newStart = s;
                            let newEnd = s + availableForAudio;

                            if (newEnd > duration) {
                                newEnd = duration;
                                newStart = Math.max(0, duration - availableForAudio);
                            }

                            if (startWidget) startWidget.value = parseFloat(newStart.toFixed(2));
                            if (endWidget) endWidget.value = parseFloat(newEnd.toFixed(2));

                            updateUI(true);
                            app.graph.setDirtyCanvas(true, false);
                            
                            if (origCallback) origCallback.apply(this, arguments);
                            isUpdatingDuration = false;
                        };
                    }
                    
                    if (audioWidget) {
                        const updateAudio = (overridePath) => {
                            const filename = overridePath || audioWidget.value;
                            if (!filename || filename === "none") {
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
                                let fname = filename;
                                let subfolder = "";
                                if (fname.includes("/") || fname.includes("\\")) {
                                    const sep = fname.includes("/") ? "/" : "\\";
                                    const parts = fname.split(sep);
                                    fname = parts.pop();
                                    subfolder = parts.join("/");
                                }
                                playerTitle.textContent = fname;
                                audioSrc = api.apiURL(`/view?filename=${encodeURIComponent(fname)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);
                            }
                            const isNewFile = (audioSrc !== audioEl.src);
                            if (isNewFile) {
                                audioEl.src = audioSrc;
                                drawWaveform(audioSrc);
                            }
                        };
                        audioWidget.callback = function() {
                            if (!node._initializing) {
                                node._should_reset_trim = true;
                            }
                            updateAudio();
                        };
                        updateAudio();
                        node._updateAudio = updateAudio;
                    }

                    container.ondragover = (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        container.style.background = "rgba(14, 165, 233, 0.2)";
                    };
                    container.ondragleave = (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        container.style.background = defaultBg;
                    };
                    container.ondrop = async (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        container.style.background = defaultBg;
                        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                            handleFileUpload(e.dataTransfer.files[0]);
                        }
                    };

                    const formatTime = (secs) => {
                        if (secs < 60) return secs.toFixed(1) + "s";
                        const m = Math.floor(secs / 60);
                        const s = (secs % 60).toFixed(1);
                        return `${m}:${s.padStart(4, '0')}`;
                    };

                    const updateRuler = () => {
                        timeRuler.innerHTML = '';
                        if (!duration) return;
                        const numMajorTicks = 5;
                        const subTicks = 4;
                        const totalTicks = (numMajorTicks - 1) * subTicks; 
                        for (let i = 0; i <= totalTicks; i++) {
                            const pct = i / totalTicks;
                            const t = duration * pct;
                            const isMajor = i % subTicks === 0;
                            const tickWrapper = document.createElement("div");
                            Object.assign(tickWrapper.style, {
                                position: "absolute", left: `${pct * 100}%`, top: "0",
                                display: "flex", flexDirection: "column", alignItems: "center", transform: "translateX(-50%)"
                            });
                            if (i === 0) { tickWrapper.style.transform = "none"; tickWrapper.style.alignItems = "flex-start"; }
                            if (i === totalTicks) { tickWrapper.style.transform = "translateX(-100%)"; tickWrapper.style.alignItems = "flex-end"; }
                            const line = document.createElement("div");
                            Object.assign(line.style, {
                                width: isMajor ? "2px" : "1px", height: isMajor ? "6px" : "4px",
                                background: isMajor ? "#aaa" : "#555", marginBottom: "2px", borderRadius: "1px"
                            });
                            tickWrapper.appendChild(line);
                            if (isMajor) {
                                const label = document.createElement("div");
                                label.textContent = formatTime(t);
                                tickWrapper.appendChild(label);
                            }
                            timeRuler.appendChild(tickWrapper);
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
                        
                        const sPct = (s / duration) * 100;
                        const ePct = (e / duration) * 100;
                        startHandle.style.left = `${sPct}%`;
                        endHandle.style.left = `${ePct}%`;
                        fill.style.left = `${sPct}%`;
                        fill.style.width = `${ePct - sPct}%`;
                        
                        const currentDur = parseFloat((e - s + pre + post).toFixed(2));
                        trimLength.textContent = `Trimmed: ${currentDur}s`;
                        
                        if (durationWidget && durationWidget.value !== currentDur) {
                            isUpdatingDuration = true;
                            durationWidget.value = currentDur;
                            isUpdatingDuration = false;
                        }
                        
                        if (syncPlayer && audioEl.readyState >= 1) { audioEl.currentTime = s; }
                    };

                    audioEl.onloadedmetadata = () => {
                        duration = audioEl.duration;
                        if (node._should_reset_trim) {
                            if (startWidget) startWidget.value = 0;
                            if (endWidget) endWidget.value = parseFloat(duration.toFixed(2));
                            node._should_reset_trim = false;
                        } else {
                            let e = endWidget ? parseFloat(endWidget.value) || 0 : 0;
                            if (endWidget && (e === 0 || e > duration)) { 
                                endWidget.value = parseFloat(duration.toFixed(2)); 
                            }
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
                        if (audioEl.currentTime < s || audioEl.currentTime >= e) { audioEl.currentTime = s; }
                    };

                    [startWidget, endWidget, preSilenceWidget, postSilenceWidget].forEach(w => {
                        if (w) {
                            const orig = w.callback;
                            w.callback = function() { updateUI(true); if(orig) orig.apply(this, arguments); };
                        }
                    });

                    sliderBox.onpointerdown = (e) => {
                        if (!duration) return;
                        const rect = sliderBox.getBoundingClientRect();
                        const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
                        const val = (x / rect.width) * duration;
                        let s = startWidget ? parseFloat(startWidget.value) || 0 : 0;
                        let e_val = endWidget ? parseFloat(endWidget.value) || duration : duration;
                        
                        const handleTolerance = (10 / rect.width) * duration;
                        
                        if (val > s + handleTolerance && val < e_val - handleTolerance) {
                            dragging = 'center';
                            dragOffset = val - s;
                            dragSelectionWidth = e_val - s;
                        } else if (Math.abs(val - s) < Math.abs(val - e_val)) {
                            dragging = 'start';
                            if(startWidget) startWidget.value = parseFloat(Math.min(val, e_val).toFixed(2));
                        } else {
                            dragging = 'end';
                            if(endWidget) endWidget.value = parseFloat(Math.max(val, s).toFixed(2));
                        }
                        updateUI(true); app.graph.setDirtyCanvas(true, false);
                        sliderBox.setPointerCapture(e.pointerId);
                    };

                    sliderBox.onpointermove = (e) => {
                        if (!dragging || !duration) return;
                        const rect = sliderBox.getBoundingClientRect();
                        const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
                        const val = (x / rect.width) * duration;
                        if (dragging === 'start') {
                            let e_val = endWidget ? parseFloat(endWidget.value) || duration : duration;
                            if(startWidget) startWidget.value = parseFloat(Math.min(val, e_val).toFixed(2));
                        } else if (dragging === 'end') {
                            const s = startWidget ? parseFloat(startWidget.value) || 0 : 0;
                            if(endWidget) endWidget.value = parseFloat(Math.max(val, s).toFixed(2));
                        } else if (dragging === 'center') {
                            let newStart = val - dragOffset;
                            let newEnd = newStart + dragSelectionWidth;
                            
                            if (newStart < 0) {
                                newStart = 0;
                                newEnd = dragSelectionWidth;
                            } else if (newEnd > duration) {
                                newEnd = duration;
                                newStart = duration - dragSelectionWidth;
                            }
                            
                            if(startWidget) startWidget.value = parseFloat(newStart.toFixed(2));
                            if(endWidget) endWidget.value = parseFloat(newEnd.toFixed(2));
                        }
                        updateUI(true); app.graph.setDirtyCanvas(true, false);
                    };

                    sliderBox.onpointerup = (e) => { dragging = null; sliderBox.releasePointerCapture(e.pointerId); };

                    setTimeout(() => { node._initializing = false; }, 500);

                }, 100);

                node.onExecuted = function (output) {
                    if (output && output.audio_path && output.audio_path.length) {
                        applyAudioPath(output.audio_path[0]);
                    }
                };

                return r;
            }
        }
    }
});