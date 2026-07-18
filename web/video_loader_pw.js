import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

app.registerExtension({
    name: "Comfy.VideoLoaderPW",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "VideoLoaderPW") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            const onConfigure = nodeType.prototype.onConfigure;
            const onResize = nodeType.prototype.onResize;
            const onDrawForeground = nodeType.prototype.onDrawForeground;

            nodeType.prototype.onConfigure = function (info) {
                if (onConfigure) onConfigure.apply(this, arguments);
                if (this.syncFramesFromTime) this.syncFramesFromTime();
                if (this.toggleWidgetVisibility) this.toggleWidgetVisibility();
                if (this.syncToggleVisual) this.syncToggleVisual();

                if (this.widgets) {
                    const pathWidget = this.widgets.find(w => w.name === "path");
                    if (pathWidget && pathWidget.value && this.updatePreview) {
                        this._lastLoadedVideoPath = pathWidget.value;
                        this.updatePreview(pathWidget.value);
                    }
                }
            };

            nodeType.prototype.onDrawForeground = function (ctx) {
                if (onDrawForeground) onDrawForeground.apply(this, arguments);
                if (this.domWidget && this.domWidget.element && this.domWidget.last_y) {
                    const remainingHeight = this.size[1] - this.domWidget.last_y - 18;
                    const currentHeight = parseFloat(this.domWidget.element.style.height);
                    const targetHeight = Math.max(150, remainingHeight);
                    if (isNaN(currentHeight) || Math.abs(currentHeight - targetHeight) > 1) {
                        this.domWidget.element.style.height = `${targetHeight}px`;
                    }
                }
            };

            nodeType.prototype.onResize = function (size) {
                if (onResize) onResize.apply(this, arguments);
                if (this.domWidget && this.domWidget.element) {
                    this.domWidget.element.style.width = "100%";
                    this.domWidget.element.style.margin = "0";
                    let yOffset = this.domWidget.last_y || 30;
                    if (!this.domWidget.last_y && this.widgets) {
                        for (let w of this.widgets) {
                            if (w === this.domWidget) break;
                            yOffset += (w.computeSize ? w.computeSize()[1] : 20) + 4;
                        }
                    }
                    this.domWidget.element.style.height = `${Math.max(150, size[1] - yOffset - 18)}px`;
                }
            };

            nodeType.prototype.onNodeCreated = function () {
                const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
                const node = this;
                
                node.accurateFrameCount = 0;
                node.accurateDuration = 0;

                const pathWidget = this.widgets.find((w) => w.name === "path");
                const frameRateWidget = this.widgets.find((w) => w.name === "frame_rate");
                const displayModeWidget = this.widgets.find((w) => w.name === "display_mode");
                const startTimeWidget = this.widgets.find((w) => w.name === "start_time");
                const endTimeWidget = this.widgets.find((w) => w.name === "end_time");
                const startFrameWidget = this.widgets.find((w) => w.name === "start_frame");
                const endFrameWidget = this.widgets.find((w) => w.name === "end_frame");
                const cropXWidget = this.widgets.find((w) => w.name === "crop_x");
                const cropYWidget = this.widgets.find((w) => w.name === "crop_y");
                const cropWWidget = this.widgets.find((w) => w.name === "crop_w");
                const cropHWidget = this.widgets.find((w) => w.name === "crop_h");
                
                const splitCountWidget = this.widgets.find((w) => w.name === "split_count");
                const splitPurpleWidget = this.widgets.find((w) => w.name === "split_purple_point");
                const splitPurpleIdxWidget = this.widgets.find((w) => w.name === "split_purple_point_idx");
                const splitGreenWidget = this.widgets.find((w) => w.name === "split_green_point");
                const splitGreenIdxWidget = this.widgets.find((w) => w.name === "split_green_point_idx");
                const selectGenerateWidget = this.widgets.find((w) => w.name === "select_generate");

                let isSyncing = false;
                let isFramesMode = displayModeWidget && displayModeWidget.value === "frames";
                if (displayModeWidget && !displayModeWidget.value) {
                    displayModeWidget.value = "frames";
                    isFramesMode = true;
                }

                let duration = 0;
                let dragging = null;
                let dragOffset = 0;
                let dragSelectionWidth = 0;
                let cropDragging = null;
                let dragStartX = 0;
                let dragStartY = 0;
                let dragStartCropX = 0;
                let dragStartCropY = 0;
                let dragStartCropW = 1;
                let dragStartCropH = 1;
                let currentAspectRatio = 0;
                let isCropVisible = false;
                let currentWaveformPeaks = [];

                const getActiveDuration = () => {
                    if (duration > 0) return duration;
                    let e = endTimeWidget ? parseFloat(endTimeWidget.value) || 0 : 0;
                    let s = startTimeWidget ? parseFloat(startTimeWidget.value) || 0 : 0;
                    let maxVal = Math.max(e, s);
                    return maxVal > 0 ? Math.max(maxVal, 1.0) : 1.0;
                };

                const formatTime = (secs) => `${secs.toFixed(2)}s`;

                function setWidgetVisibility(w, visible, typeStr) {
                    if (!w) return;
                    w.hidden = !visible;
                    if (!visible) { w.type = "hidden"; w.computeSize = () => [0, -4]; }
                    else { w.type = typeStr; delete w.computeSize; }
                }

                node.toggleWidgetVisibility = function () {
                    isFramesMode = displayModeWidget && displayModeWidget.value === "frames";
                    setWidgetVisibility(startTimeWidget, !isFramesMode, "FLOAT");
                    setWidgetVisibility(endTimeWidget, !isFramesMode, "FLOAT");
                    setWidgetVisibility(startFrameWidget, isFramesMode, "INT");
                    setWidgetVisibility(endFrameWidget, isFramesMode, "INT");
                    setWidgetVisibility(displayModeWidget, false, "combo");
                    setWidgetVisibility(cropXWidget, false, "FLOAT");
                    setWidgetVisibility(cropYWidget, false, "FLOAT");
                    setWidgetVisibility(cropWWidget, false, "FLOAT");
                    setWidgetVisibility(cropHWidget, false, "FLOAT");

                    const sc = splitCountWidget ? splitCountWidget.value : 0;
                    setWidgetVisibility(splitPurpleWidget, sc >= 1 && !isFramesMode, "FLOAT");
                    setWidgetVisibility(splitPurpleIdxWidget, sc >= 1 && isFramesMode, "INT");
                    setWidgetVisibility(splitGreenWidget, sc === 2 && !isFramesMode, "FLOAT");
                    setWidgetVisibility(splitGreenIdxWidget, sc === 2 && isFramesMode, "INT");
                    setWidgetVisibility(selectGenerateWidget, sc === 1, "combo");

                    const minSize = node.computeSize();
                    node.size[0] = Math.max(node.size[0], minSize[0]);
                    node.size[1] = Math.max(node.size[1], minSize[1]);
                    if (node.onResize) node.onResize(node.size);
                    app.graph.setDirtyCanvas(true, true);
                    if (typeof node.updateSplitHandles === 'function') node.updateSplitHandles();
                };

                const clampSplitValues = () => {
                    const fr = frameRateWidget ? parseFloat(frameRateWidget.value) || 25.0 : 25.0;
                    const sc = splitCountWidget ? splitCountWidget.value : 0;
                    const s_f = startFrameWidget ? parseInt(startFrameWidget.value) || 0 : 0;
                    let e_f = endFrameWidget ? parseInt(endFrameWidget.value) || 0 : 0;
                    if (e_f === 0) e_f = node.accurateFrameCount > 0 ? node.accurateFrameCount - 1 : Math.round(getActiveDuration() * fr) - 1;
                    if (e_f <= s_f) e_f = s_f + 2;

                    if (sc >= 1 && splitPurpleIdxWidget && splitPurpleWidget) {
                        let p_f = parseInt(splitPurpleIdxWidget.value) || 0;
                        let min_p = s_f + 1;
                        let max_p = e_f - 1;
                        if (sc === 2 && splitGreenIdxWidget) {
                            let g_f = parseInt(splitGreenIdxWidget.value) || 0;
                            max_p = Math.min(max_p, g_f - 1);
                        }
                        if (min_p > max_p) min_p = max_p;
                        p_f = Math.max(min_p, Math.min(p_f, max_p));
                        splitPurpleIdxWidget.value = p_f;
                        splitPurpleWidget.value = parseFloat((p_f / fr).toFixed(3));
                    }

                    if (sc === 2 && splitGreenIdxWidget && splitGreenWidget) {
                        let g_f = parseInt(splitGreenIdxWidget.value) || 0;
                        let p_f = splitPurpleIdxWidget ? parseInt(splitPurpleIdxWidget.value) || 0 : s_f;
                        let min_g = p_f + 1;
                        let max_g = e_f - 1;
                        if (min_g > max_g) min_g = max_g;
                        g_f = Math.max(min_g, Math.min(g_f, max_g));
                        splitGreenIdxWidget.value = g_f;
                        splitGreenWidget.value = parseFloat((g_f / fr).toFixed(3));
                    }
                };

                const resetSplitWidgets = () => {
                    if (splitCountWidget) splitCountWidget.value = 0;
                    if (splitPurpleWidget) splitPurpleWidget.value = 0.0;
                    if (splitPurpleIdxWidget) splitPurpleIdxWidget.value = 0;
                    if (splitGreenWidget) splitGreenWidget.value = 0.0;
                    if (splitGreenIdxWidget) splitGreenIdxWidget.value = 0;
                    if (selectGenerateWidget) selectGenerateWidget.value = "blue";
                    node.toggleWidgetVisibility();
                };

                node.syncFramesFromTime = function () {
                    if (isSyncing || !frameRateWidget) return;
                    isSyncing = true;
                    const fr = parseFloat(frameRateWidget.value) || 25.0;
                    if (startTimeWidget && startFrameWidget) startFrameWidget.value = Math.max(0, Math.round(startTimeWidget.value * fr));
                    if (endTimeWidget && endFrameWidget) {
                        if (endTimeWidget.value > 0) {
                            let endF = Math.round(endTimeWidget.value * fr) - 1;
                            if (node.accurateFrameCount > 0 && endF >= node.accurateFrameCount) {
                                endF = node.accurateFrameCount - 1;
                                endTimeWidget.value = parseFloat((endF / fr).toFixed(3));
                            }
                            endFrameWidget.value = Math.max(0, endF);
                        } else {
                            endFrameWidget.value = 0;
                        }
                    }
                    if (splitPurpleWidget && splitPurpleIdxWidget) splitPurpleIdxWidget.value = Math.max(0, Math.round(splitPurpleWidget.value * fr));
                    if (splitGreenWidget && splitGreenIdxWidget) splitGreenIdxWidget.value = Math.max(0, Math.round(splitGreenWidget.value * fr));
                    clampSplitValues();
                    isSyncing = false;
                };

                node.syncTimeFromFrames = function () {
                    if (isSyncing || !frameRateWidget) return;
                    isSyncing = true;
                    const fr = parseFloat(frameRateWidget.value) || 25.0;
                    if (startTimeWidget && startFrameWidget) startTimeWidget.value = parseFloat(Math.max(0, startFrameWidget.value / fr).toFixed(3));
                    if (endTimeWidget && endFrameWidget) {
                        if (endFrameWidget.value > 0) {
                            let endF = parseInt(endFrameWidget.value);
                            if (node.accurateFrameCount > 0 && endF >= node.accurateFrameCount) {
                                endF = node.accurateFrameCount - 1;
                                endFrameWidget.value = endF;
                            }
                            endTimeWidget.value = parseFloat(((endF + 1) / fr).toFixed(3));
                        } else {
                            endTimeWidget.value = 0;
                        }
                    }
                    if (splitPurpleWidget && splitPurpleIdxWidget) splitPurpleWidget.value = parseFloat(Math.max(0, splitPurpleIdxWidget.value / fr).toFixed(3));
                    if (splitGreenWidget && splitGreenIdxWidget) splitGreenWidget.value = parseFloat(Math.max(0, splitGreenIdxWidget.value / fr).toFixed(3));
                    clampSplitValues();
                    isSyncing = false;
                };

                function bindWidget(w, isFrame, isFrameRate = false) {
                    if (!w) return;
                    const orig = w.callback;
                    w.callback = function () {
                        if (orig) orig.apply(this, arguments);
                        if (isFrame) node.syncTimeFromFrames();
                        else node.syncFramesFromTime();
                        clampSplitValues();
                        if (duration === 0 || isFrameRate) updateRuler();
                        updateUI(true);
                    };
                }

                bindWidget(startTimeWidget, false);
                bindWidget(endTimeWidget, false);
                bindWidget(startFrameWidget, true);
                bindWidget(endFrameWidget, true);
                bindWidget(frameRateWidget, false, true);
                bindWidget(splitPurpleWidget, false);
                bindWidget(splitPurpleIdxWidget, true);
                bindWidget(splitGreenWidget, false);
                bindWidget(splitGreenIdxWidget, true);
                bindWidget(selectGenerateWidget, false);
                
                if (splitCountWidget) {
                    const orig = splitCountWidget.callback;
                    splitCountWidget.callback = function () {
                        if (orig) orig.apply(this, arguments);
                        const mode = splitCountWidget.value;
                        const fr = parseFloat(frameRateWidget.value) || 25.0;
                        if (mode >= 1 && splitPurpleIdxWidget) {
                            let s_f = startFrameWidget ? parseInt(startFrameWidget.value) || 0 : 0;
                            splitPurpleIdxWidget.value = s_f + 1;
                        }
                        if (mode === 2 && splitGreenIdxWidget) {
                            let e_f = endFrameWidget ? parseInt(endFrameWidget.value) || 0 : 0;
                            if (e_f === 0) e_f = node.accurateFrameCount > 0 ? node.accurateFrameCount - 1 : Math.round(getActiveDuration() * fr) - 1;
                            splitGreenIdxWidget.value = e_f - 1;
                        }
                        clampSplitValues();
                        node.toggleWidgetVisibility();
                        updateUI(true);
                    };
                }

                node.updatePreview = function (filename) {
                    if (!filename) return;
                    let url;
                    const isAbsolute = (filename.length >= 2 && filename[1] === ':') || filename.startsWith('/');
                    const timestamp = Date.now(); // 加入时间戳强制绕过浏览器缓存
                    if (isAbsolute) url = api.apiURL(`/video_ui_custom_view?filename=${encodeURIComponent(filename)}&t=${timestamp}`);
                    else url = api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input&t=${timestamp}`);
                    
                    if (videoPreview) {
                        videoPreview.src = url;
                        videoPreview.load();
                    }
                };

                function updateCropUI() {
                    const vw = videoPreview.videoWidth;
                    const vh = videoPreview.videoHeight;
                    let cx = cropXWidget ? parseFloat(cropXWidget.value) || 0 : 0;
                    let cy = cropYWidget ? parseFloat(cropYWidget.value) || 0 : 0;
                    let cw_val = cropWWidget ? parseFloat(cropWWidget.value) || 1 : 1;
                    let ch_val = cropHWidget ? parseFloat(cropHWidget.value) || 1 : 1;
                    const actualW = vw ? Math.round(cw_val * vw) : 0;
                    const actualH = vh ? Math.round(ch_val * vh) : 0;

                    if (!isCropVisible || !vw) {
                        cropBox.style.display = "none";
                        cropEditContainer.style.display = "none";
                        if (cw_val < 0.999 || ch_val < 0.999 || cx > 0.001 || cy > 0.001) {
                            cropDims.textContent = `Crop: ${actualW}x${actualH}`;
                            cropDims.style.display = "inline-block";
                        } else { cropDims.style.display = "none"; }
                        return;
                    }
                    cropDims.style.display = "none";
                    cropEditContainer.style.display = "flex";
                    cropBox.style.display = "block";
                    if (document.activeElement !== wInput) wInput.value = actualW;
                    if (document.activeElement !== hInput) hInput.value = actualH;
                    const cw = videoPreview.clientWidth;
                    const ch = videoPreview.clientHeight;
                    const ratio = Math.min(cw / vw, ch / vh);
                    const renderedW = vw * ratio;
                    const renderedH = vh * ratio;
                    const xOffset = (cw - renderedW) / 2;
                    const yOffset = (ch - renderedH) / 2;
                    cropBox.style.left = `${xOffset + cx * renderedW}px`;
                    cropBox.style.top = `${yOffset + cy * renderedH}px`;
                    cropBox.style.width = `${cw_val * renderedW}px`;
                    cropBox.style.height = `${ch_val * renderedH}px`;
                }

                function updateRuler() {
                    timeRuler.innerHTML = '';
                    const activeDur = getActiveDuration();
                    const numMajorTicks = 5;
                    const subTicks = 4;
                    const totalTicks = (numMajorTicks - 1) * subTicks;
                    const isFrames = displayModeWidget && displayModeWidget.value === "frames";
                    const fr = frameRateWidget ? parseFloat(frameRateWidget.value) || 25.0 : 25.0;

                    for (let i = 0; i <= totalTicks; i++) {
                        const pct = i / totalTicks;
                        const t = activeDur * pct;
                        const isMajor = i % subTicks === 0;
                        const tickWrapper = document.createElement("div");
                        Object.assign(tickWrapper.style, { position: "absolute", left: `${pct * 100}%`, top: "0", display: "flex", flexDirection: "column", alignItems: "center", transform: "translateX(-50%)" });
                        if (i === 0) { tickWrapper.style.transform = "none"; tickWrapper.style.alignItems = "flex-start"; }
                        if (i === totalTicks) { tickWrapper.style.transform = "translateX(-100%)"; tickWrapper.style.alignItems = "flex-end"; }
                        const line = document.createElement("div");
                        Object.assign(line.style, { width: isMajor ? "2px" : "1px", height: isMajor ? "6px" : "4px", background: isMajor ? "#aaa" : "#555", marginBottom: "2px", borderRadius: "1px" });
                        tickWrapper.appendChild(line);
                        if (isMajor) {
                            const label = document.createElement("div");
                            label.textContent = isFrames ? Math.round(t * fr) : formatTime(t);
                            tickWrapper.appendChild(label);
                        }
                        timeRuler.appendChild(tickWrapper);
                    }
                }

                function updateUI(syncPlayer = false) {
                    const activeDur = getActiveDuration();
                    let s = startTimeWidget ? parseFloat(startTimeWidget.value) || 0 : 0;
                    let e = endTimeWidget ? parseFloat(endTimeWidget.value) || 0 : 0;
                    let visualEnd = e;
                    if (visualEnd === 0 || visualEnd > activeDur) visualEnd = activeDur;
                    if (s > visualEnd) s = visualEnd;

                    let pStart = (s / activeDur) * 100;
                    let pEnd = (visualEnd / activeDur) * 100;
                    pStart = Math.max(0, Math.min(pStart, 100));
                    pEnd = Math.max(0, Math.min(pEnd, 100));

                    startHandle.style.left = `${pStart}%`;
                    endHandle.style.left = `${pEnd}%`;

                    const currentDur = parseFloat((visualEnd - s).toFixed(2));
                    const isFrames = displayModeWidget && displayModeWidget.value === "frames";
                    const fr = frameRateWidget ? parseFloat(frameRateWidget.value) || 25.0 : 25.0;
                    trimLength.textContent = isFrames ? `Trimmed: ${Math.round(currentDur * fr)} frames` : `Trimmed: ${formatTime(currentDur)}`;

                    if (syncPlayer && duration > 0) videoPreview.currentTime = s;
                    
                    const toPct = (val) => Math.max(0, Math.min(100, (val / activeDur) * 100));
                    let pS = 0, pE = 0, bS = 0, bE = 0, gS = 0, gE = 0;
                    const s_val = s, e_val = visualEnd;
                    const p_val = splitPurpleWidget ? parseFloat(splitPurpleWidget.value) || 0 : 0;
                    const g_val = splitGreenWidget ? parseFloat(splitGreenWidget.value) || 0 : 0;
                    const sc = splitCountWidget ? splitCountWidget.value : 0;
                    
                    if (sc === 0) { bS = s_val; bE = e_val; } 
                    else if (sc === 1) { pS = s_val; pE = p_val; bS = p_val; bE = e_val; } 
                    else if (sc === 2) { pS = s_val; pE = p_val; bS = p_val; bE = g_val; gS = g_val; gE = e_val; }
                    
                    fillPurple.style.left = `${toPct(pS)}%`; fillPurple.style.width = `${Math.max(0, toPct(pE) - toPct(pS))}%`;
                    fillBlue.style.left = `${toPct(bS)}%`; fillBlue.style.width = `${Math.max(0, toPct(bE) - toPct(bS))}%`;
                    fillGreen.style.left = `${toPct(gS)}%`; fillGreen.style.width = `${Math.max(0, toPct(gE) - toPct(gS))}%`;
                    
                    if (typeof node.updateSplitHandles === 'function') node.updateSplitHandles();
                }

                const resetAllParams = () => {
                    duration = 0;
                    node.accurateDuration = 0;
                    node.accurateFrameCount = 0;
                    
                    if (startTimeWidget) startTimeWidget.value = 0;
                    if (endTimeWidget) endTimeWidget.value = 0; 
                    if (startFrameWidget) startFrameWidget.value = 0;
                    if (endFrameWidget) endFrameWidget.value = 0;
                    
                    if (cropXWidget) cropXWidget.value = 0.0;
                    if (cropYWidget) cropYWidget.value = 0.0;
                    if (cropWWidget) cropWWidget.value = 1.0;
                    if (cropHWidget) cropHWidget.value = 1.0;
                    
                    isCropVisible = false;
                    if (cropBtn) { cropBtn.style.background = "rgba(255, 255, 255, 0.1)"; cropBtn.style.color = "white"; }
                    if (arSelect) arSelect.value = "0";
                    currentAspectRatio = 0;
                    if (wInput) wInput.value = "";
                    if (hInput) hInput.value = "";
                    
                    resetSplitWidgets();
                    currentWaveformPeaks = [];
                    
                    updateCropUI();
                    updateRuler();
                    updateUI(true);
                    requestAnimationFrame(drawWaveform);
                };

                const applyVideoPath = (rawPath) => {
                    if (!rawPath || !rawPath.trim()) return;
                    const p = rawPath.trim();
                    const isNewFile = (p !== node._lastLoadedVideoPath);
                    
                    if (isNewFile) {
                        resetAllParams(); 
                        node._lastLoadedVideoPath = p;
                    }
                    
                    if (pathWidget) pathWidget.value = p;
                    if (node.updatePreview) node.updatePreview(p);
                };
                
                // 【核心黑科技增强】：Load/Reload Video 逻辑
                const loadReloadVideo = () => {
                    let targetPath = "";
                    
                    // 1. 优先读取当前节点 path widget 的值
                    if (pathWidget && pathWidget.value && pathWidget.value.trim()) {
                        targetPath = pathWidget.value.trim();
                    }
                    
                    // 2. 【黑科技】：顺着连线去上游节点（如 Local Media Manager）“偷取”最新路径
                    // 这样即使不点击 Queue Prompt，也能直接同步上游节点的最新选择
                    const pathInputIndex = node.inputs ? node.inputs.findIndex(i => i.name === "path") : -1;
                    if (pathInputIndex !== -1 && node.inputs[pathInputIndex].link) {
                        const linkId = node.inputs[pathInputIndex].link;
                        const linkInfo = app.graph.links.find(l => l[0] === linkId);
                        
                        if (linkInfo) {
                            const originNodeId = linkInfo[1];
                            const originNode = app.graph.getNodeById(originNodeId);
                            
                            if (originNode && originNode.widgets) {
                                let upstreamPath = "";
                                // 尝试寻找上游节点中代表路径的 widget
                                for (let w of originNode.widgets) {
                                    if (w.value && typeof w.value === "string" && w.value.length > 2) {
                                        const name = (w.name || "").toLowerCase();
                                        // 匹配常见的路径/视频字段名
                                        if (name.includes("path") || name.includes("video") || name.includes("file") || name.includes("media")) {
                                            upstreamPath = w.value;
                                            break;
                                        }
                                    }
                                }
                                // 如果没找到特定名字的，找第一个包含路径分隔符的 string widget
                                if (!upstreamPath) {
                                    for (let w of originNode.widgets) {
                                        if (w.value && typeof w.value === "string" && (w.value.includes("/") || w.value.includes("\\"))) {
                                            upstreamPath = w.value;
                                            break;
                                        }
                                    }
                                }
                                
                                if (upstreamPath) {
                                    targetPath = upstreamPath;
                                    // 将上游的最新路径同步显示到当前节点的 path 框中
                                    if (pathWidget) pathWidget.value = targetPath;
                                }
                            }
                        }
                    }
                    
                    if (targetPath) {
                        node._lastLoadedVideoPath = null; // 强制绕过缓存，视为新文件
                        applyVideoPath(targetPath);
                    } else {
                        alert("未找到有效的视频路径。请确保已连接上游节点（如 LMM）或手动输入路径。");
                    }
                };

                const _videoExecHandler = ({ detail }) => {
                    if (!detail || String(detail.node) !== String(node.id)) return;
                    const out = detail.output;
                    if (out && out.video_path && out.video_path.length) applyVideoPath(out.video_path[0]);
                    
                    if (out && out.video_info) {
                        try {
                            const infoStr = Array.isArray(out.video_info) ? out.video_info[0] : out.video_info;
                            const info = JSON.parse(infoStr);
                            if (info.source_fps !== undefined && typeof fpsDisplay !== 'undefined' && fpsDisplay) fpsDisplay.textContent = `source_fps: ${info.source_fps}`;
                            
                            if (info.loaded_frame_count !== undefined && endFrameWidget) {
                                node.accurateFrameCount = info.loaded_frame_count;
                                node.accurateDuration = info.loaded_duration || 0;
                                let currentEnd = parseFloat(endTimeWidget.value) || 0;
                                if (currentEnd === 0 || currentEnd > node.accurateDuration) endTimeWidget.value = node.accurateDuration;
                                let currentEndF = parseInt(endFrameWidget.value) || 0;
                                if (currentEndF === 0 || currentEndF >= node.accurateFrameCount) endFrameWidget.value = node.accurateFrameCount > 0 ? node.accurateFrameCount - 1 : 0;
                                node.syncFramesFromTime();
                                updateRuler();
                                updateUI(true);
                            }
                            if (info.waveform_peaks && Array.isArray(info.waveform_peaks)) {
                                currentWaveformPeaks = info.waveform_peaks;
                                requestAnimationFrame(drawWaveform);
                            }
                        } catch(e) { console.error("Failed to parse video_info", e); }
                    }
                };
                api.addEventListener("executed", _videoExecHandler);

                const _videoOrigRemoved = node.onRemoved;
                node.onRemoved = function () {
                    api.removeEventListener("executed", _videoExecHandler);
                    if (_videoOrigRemoved) _videoOrigRemoved.apply(this, arguments);
                };

                node.onExecuted = function (output) {
                    if (output && output.video_path && output.video_path.length > 0) applyVideoPath(output.video_path[0]);
                    if (output && output.video_info) {
                        try {
                            const infoStr = Array.isArray(output.video_info) ? output.video_info[0] : output.video_info;
                            const info = JSON.parse(infoStr);
                            if (info.source_fps !== undefined && typeof fpsDisplay !== 'undefined' && fpsDisplay) fpsDisplay.textContent = `source_fps: ${info.source_fps}`;
                            if (info.loaded_frame_count !== undefined && endFrameWidget) {
                                node.accurateFrameCount = info.loaded_frame_count;
                                node.accurateDuration = info.loaded_duration || 0;
                                let currentEnd = parseFloat(endTimeWidget.value) || 0;
                                if (currentEnd === 0 || currentEnd > node.accurateDuration) endTimeWidget.value = node.accurateDuration;
                                let currentEndF = parseInt(endFrameWidget.value) || 0;
                                if (currentEndF === 0 || currentEndF >= node.accurateFrameCount) endFrameWidget.value = node.accurateFrameCount > 0 ? node.accurateFrameCount - 1 : 0;
                                node.syncFramesFromTime();
                                updateRuler();
                                updateUI(true);
                            }
                            if (info.waveform_peaks && Array.isArray(info.waveform_peaks)) {
                                currentWaveformPeaks = info.waveform_peaks;
                                requestAnimationFrame(drawWaveform);
                            }
                        } catch(e) {}
                    }
                };

                node.toggleWidgetVisibility();

                // 添加 Load/Reload 按钮
                this.addWidget("button", "Load/Reload Video", null, loadReloadVideo);

                const fileInput = document.createElement("input");
                fileInput.type = "file";
                fileInput.accept = "video/*";
                fileInput.style.display = "none";
                document.body.appendChild(fileInput);

                const btnWidget = this.addWidget("button", "choose file to upload", null, () => { fileInput.click(); });

                const uploadFile = async (file) => {
                    try {
                        if (errorMsg) errorMsg.style.display = "none";
                        btnWidget.name = "Uploading...";
                        node.setDirtyCanvas(true, false);
                        const CHUNK_SIZE = 10 * 1024 * 1024;

                        if (file.path) {
                            applyVideoPath(file.path);
                            return;
                        }

                        if (file.size > CHUNK_SIZE) {
                            const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
                            const safeFileName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
                            const safeName = Date.now() + "_" + safeFileName;
                            for (let i = 0; i < totalChunks; i++) {
                                btnWidget.name = `Uploading... ${Math.round((i / totalChunks) * 100)}%`;
                                node.setDirtyCanvas(true, false);
                                const chunk = file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
                                const formData = new FormData();
                                formData.append("file", chunk);
                                formData.append("filename", safeName);
                                formData.append("chunk_index", i);
                                formData.append("total_chunks", totalChunks);
                                const resp = await api.fetchApi("/video_ui_upload_chunk", { method: "POST", body: formData });
                                if (resp.status !== 200) throw new Error("Chunk upload failed");
                                if (i === totalChunks - 1) {
                                    const data = await resp.json();
                                    applyVideoPath(data.name);
                                }
                            }
                        } else {
                            const body = new FormData();
                            body.append("image", file);
                            const resp = await api.fetchApi("/upload/image", { method: "POST", body: body });
                            if (resp.status === 413) throw new Error("File too large.");
                            if (resp.status === 200) {
                                const data = await resp.json();
                                applyVideoPath(data.name);
                            } else {
                                throw new Error(`Upload failed: ${resp.statusText}`);
                            }
                        }
                    } catch (error) {
                        console.error("Upload failed", error);
                        if (errorMsg) { errorMsg.textContent = "Upload failed. Check console."; errorMsg.style.display = "block"; }
                    } finally {
                        btnWidget.name = "choose file to upload";
                        node.setDirtyCanvas(true, false);
                        fileInput.value = "";
                    }
                };

                fileInput.addEventListener("change", (e) => { if (e.target.files.length) uploadFile(e.target.files[0]); });
                node.onDropFile = function (file) {
                    if (file.type.startsWith('video/') || file.name.toLowerCase().match(/\.(mp4|webm|mkv|avi|mov|m4v|flv|wmv)$/)) {
                        uploadFile(file);
                        return true;
                    }
                    return false;
                };

                const originalOnRemove = node.onRemoved;
                node.onRemoved = function () {
                    if (fileInput && fileInput.parentNode) fileInput.parentNode.removeChild(fileInput);
                    if (originalOnRemove) originalOnRemove.apply(this, arguments);
                };

                const container = document.createElement("div");
                const defaultBg = "rgba(30, 30, 30, 0.9)";
                Object.assign(container.style, { display: "flex", flexDirection: "column", gap: "10px", width: "100%", margin: "0", padding: "10px", boxSizing: "border-box", background: defaultBg, borderRadius: "6px", color: "white", fontFamily: "sans-serif", marginTop: "8px", flexShrink: "0", transition: "background 0.2s" });

                const errorMsg = document.createElement("div");
                Object.assign(errorMsg.style, { color: "#ff6b6b", fontSize: "12px", display: "none", marginBottom: "4px", flexShrink: "0", boxSizing: "border-box" });
                container.appendChild(errorMsg);

                const playerTop = document.createElement("div");
                Object.assign(playerTop.style, { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 2px", marginBottom: "-4px", flexShrink: "0", boxSizing: "border-box", flexWrap: "wrap", gap: "6px", position: "relative" });

                const toggleWrapper = document.createElement("div");
                Object.assign(toggleWrapper.style, { display: "flex", alignItems: "center", gap: "6px", background: "rgba(0, 0, 0, 0.2)", padding: "0 8px", borderRadius: "4px", height: "22px", boxSizing: "border-box" });

                const toggleTitle = document.createElement("span");
                toggleTitle.textContent = "Display Mode";
                Object.assign(toggleTitle.style, { fontSize: "12px", color: "#38bdf8", fontWeight: "bold", whiteSpace: "nowrap" });

                const segmentedToggle = document.createElement("div");
                Object.assign(segmentedToggle.style, { display: "flex", alignItems: "center", background: "rgba(0, 0, 0, 0.35)", border: "1px solid rgba(56, 189, 248, 0.3)", borderRadius: "4px", overflow: "hidden", height: "18px", flexShrink: "0", cursor: "pointer" });

                const createSegBtn = (label) => {
                    const btn = document.createElement("span");
                    btn.textContent = label;
                    Object.assign(btn.style, { fontSize: "11px", fontWeight: "bold", padding: "0 8px", lineHeight: "18px", color: "rgba(255,255,255,0.45)", background: "transparent", transition: "background 0.2s, color 0.2s", userSelect: "none", whiteSpace: "nowrap" });
                    return btn;
                };

                const segTime = createSegBtn("Time");
                const segDivider = document.createElement("span");
                segDivider.style.cssText = "width:1px;height:12px;background:rgba(56,189,248,0.25);flex-shrink:0;";
                const segFrames = createSegBtn("Frames");
                segmentedToggle.appendChild(segTime);
                segmentedToggle.appendChild(segDivider);
                segmentedToggle.appendChild(segFrames);

                const applySegmentState = (frames) => {
                    if (frames) {
                        segTime.style.background = "transparent"; segTime.style.color = "rgba(255,255,255,0.45)";
                        segFrames.style.background = "rgba(37,126,235,0.85)"; segFrames.style.color = "#fff";
                    } else {
                        segTime.style.background = "rgba(56,189,248,0.85)"; segTime.style.color = "#fff";
                        segFrames.style.background = "transparent"; segFrames.style.color = "rgba(255,255,255,0.45)";
                    }
                };
                applySegmentState(isFramesMode);

                const doToggle = () => {
                    isFramesMode = !isFramesMode;
                    applySegmentState(isFramesMode);
                    if (displayModeWidget) displayModeWidget.value = isFramesMode ? "frames" : "seconds";
                    if (isFramesMode) node.syncFramesFromTime(); else node.syncTimeFromFrames();
                    node.toggleWidgetVisibility();
                    updateRuler();
                    updateUI(true);
                };
                segmentedToggle.onclick = doToggle;

                node.syncToggleVisual = function () {
                    const savedIsFrames = displayModeWidget && displayModeWidget.value === "frames";
                    isFramesMode = savedIsFrames;
                    applySegmentState(savedIsFrames);
                };

                toggleWrapper.appendChild(toggleTitle);
                toggleWrapper.appendChild(segmentedToggle);

                const fpsDisplay = document.createElement("span");
                Object.assign(fpsDisplay.style, { fontSize: "12px", color: "#38bdf8", fontWeight: "bold", whiteSpace: "nowrap", marginLeft: "10px" });
                fpsDisplay.textContent = "source_fps: -";
                toggleWrapper.appendChild(fpsDisplay);

                const leftContainer = document.createElement("div");
                Object.assign(leftContainer.style, { flex: "1 1 0%", display: "flex", justifyContent: "flex-start", minWidth: "max-content" });
                leftContainer.appendChild(toggleWrapper);
                playerTop.appendChild(leftContainer);

                const trimLength = document.createElement("span");
                Object.assign(trimLength.style, { display: "flex", alignItems: "center", fontSize: "12px", color: "#38bdf8", fontWeight: "bold", background: "rgba(56, 189, 248, 0.1)", padding: "0 6px", borderRadius: "4px", whiteSpace: "nowrap", height: "22px", boxSizing: "border-box", cursor: "pointer" });
                trimLength.textContent = "Trimmed: 0.00s";

                const cropBtn = document.createElement("button");
                cropBtn.textContent = "Crop";
                Object.assign(cropBtn.style, { background: "rgba(255, 255, 255, 0.1)", color: "white", border: "none", borderRadius: "4px", padding: "0 8px", height: "22px", fontSize: "12px", fontWeight: "bold", cursor: "pointer" });

                const cropUIContainer = document.createElement("div");
                Object.assign(cropUIContainer.style, { display: "flex", alignItems: "center", gap: "6px", zIndex: "11" });

                const cropDims = document.createElement("span");
                Object.assign(cropDims.style, { fontSize: "12px", color: "#38bdf8", fontWeight: "bold", display: "none", padding: "0 6px", pointerEvents: "none" });

                const cropEditContainer = document.createElement("div");
                Object.assign(cropEditContainer.style, { display: "none", alignItems: "center", gap: "4px" });

                const arSelect = document.createElement("select");
                Object.assign(arSelect.style, { background: "#222", color: "#fff", border: "1px solid #555", borderRadius: "3px", fontSize: "12px", padding: "2px", outline: "none", cursor: "pointer" });
                const ratios = [
                    { name: "Freeform", val: 0 }, { name: "Original", val: -1 }, { name: "1:1", val: 1 },
                    { name: "4:5", val: 4 / 5 }, { name: "5:4", val: 5 / 4 }, { name: "16:9", val: 16 / 9 },
                    { name: "9:16", val: 9 / 16 }, { name: "4:3", val: 4 / 3 }, { name: "3:4", val: 3 / 4 },
                    { name: "3:2", val: 3 / 2 }, { name: "2:3", val: 2 / 3 }, { name: "2:1", val: 2 }, { name: "1:2", val: 1 / 2 }
                ];
                ratios.forEach(r => { const opt = document.createElement("option"); opt.textContent = r.name; opt.value = r.val; arSelect.appendChild(opt); });

                const wInput = document.createElement("input");
                const hInput = document.createElement("input");
                const inputStyle = { width: "40px", background: "rgba(0,0,0,0.5)", color: "#38bdf8", border: "1px solid #555", borderRadius: "3px", fontSize: "12px", textAlign: "center", padding: "2px", outline: "none" };
                Object.assign(wInput.style, inputStyle);
                Object.assign(hInput.style, inputStyle);
                wInput.type = "text"; hInput.type = "text";

                const xSpan = document.createElement("span");
                xSpan.textContent = "x"; xSpan.style.color = "#888"; xSpan.style.fontSize = "12px";

                const resetBtn = document.createElement("button");
                resetBtn.textContent = "Reset";
                Object.assign(resetBtn.style, { background: "rgba(255, 255, 255, 0.1)", color: "white", border: "none", borderRadius: "3px", padding: "0 6px", height: "18px", fontSize: "11px", cursor: "pointer" });

                cropEditContainer.appendChild(arSelect);
                cropEditContainer.appendChild(wInput);
                cropEditContainer.appendChild(xSpan);
                cropEditContainer.appendChild(hInput);
                cropEditContainer.appendChild(resetBtn);

                cropUIContainer.appendChild(cropDims);
                cropUIContainer.appendChild(cropEditContainer);
                playerTop.appendChild(cropUIContainer);

                const rightContainer = document.createElement("div");
                Object.assign(rightContainer.style, { flex: "1 1 0%", display: "flex", justifyContent: "flex-end", gap: "6px", minWidth: "max-content" });
                rightContainer.appendChild(cropBtn);
                rightContainer.appendChild(trimLength);
                playerTop.appendChild(rightContainer);

                const handleManualDimensionInput = (isWidth) => {
                    const vw = videoPreview.videoWidth;
                    const vh = videoPreview.videoHeight;
                    if (!vw || !vh) return;
                    let newW = parseInt(wInput.value) || Math.round((cropWWidget ? parseFloat(cropWWidget.value) || 1 : 1) * vw);
                    let newH = parseInt(hInput.value) || Math.round((cropHWidget ? parseFloat(cropHWidget.value) || 1 : 1) * vh);
                    if (currentAspectRatio > 0) {
                        if (isWidth) newH = Math.round(newW / currentAspectRatio);
                        else newW = Math.round(newH * currentAspectRatio);
                    }
                    newW = Math.max(1, Math.min(newW, vw));
                    newH = Math.max(1, Math.min(newH, vh));
                    let cw_val = newW / vw;
                    let ch_val = newH / vh;
                    let cx = cropXWidget ? parseFloat(cropXWidget.value) || 0 : 0;
                    let cy = cropYWidget ? parseFloat(cropYWidget.value) || 0 : 0;
                    if (cx + cw_val > 1) cx = 1 - cw_val;
                    if (cy + ch_val > 1) cy = 1 - ch_val;
                    if (cropXWidget) cropXWidget.value = parseFloat(cx.toFixed(3));
                    if (cropYWidget) cropYWidget.value = parseFloat(cy.toFixed(3));
                    if (cropWWidget) cropWWidget.value = parseFloat(cw_val.toFixed(3));
                    if (cropHWidget) cropHWidget.value = parseFloat(ch_val.toFixed(3));
                    updateCropUI();
                    app.graph.setDirtyCanvas(true, false);
                };

                wInput.addEventListener("change", () => handleManualDimensionInput(true));
                hInput.addEventListener("change", () => handleManualDimensionInput(false));
                wInput.addEventListener("keydown", (e) => { if (e.key === "Enter") handleManualDimensionInput(true); });
                hInput.addEventListener("keydown", (e) => { if (e.key === "Enter") handleManualDimensionInput(false); });

                arSelect.onchange = () => {
                    currentAspectRatio = parseFloat(arSelect.value);
                    if (currentAspectRatio === -1 && videoPreview.videoWidth) currentAspectRatio = videoPreview.videoWidth / videoPreview.videoHeight;
                    if (currentAspectRatio > 0 && videoPreview.videoWidth) {
                        const vw = videoPreview.videoWidth;
                        const vh = videoPreview.videoHeight;
                        let cw_val = cropWWidget ? parseFloat(cropWWidget.value) || 1 : 1;
                        let cx = cropXWidget ? parseFloat(cropXWidget.value) || 0 : 0;
                        let cy = cropYWidget ? parseFloat(cropYWidget.value) || 0 : 0;
                        const actualW = cw_val * vw;
                        let actualH = actualW / currentAspectRatio;
                        let ch_val = actualH / vh;
                        if (ch_val > 1) { ch_val = 1; const newActualW = vh * currentAspectRatio; cw_val = newActualW / vw; }
                        if (cy + ch_val > 1) cy = 1 - ch_val;
                        if (cx + cw_val > 1) cx = 1 - cw_val;
                        if (cropXWidget) cropXWidget.value = parseFloat(cx.toFixed(3));
                        if (cropYWidget) cropYWidget.value = parseFloat(cy.toFixed(3));
                        if (cropWWidget) cropWWidget.value = parseFloat(cw_val.toFixed(3));
                        if (cropHWidget) cropHWidget.value = parseFloat(ch_val.toFixed(3));
                        updateCropUI();
                        app.graph.setDirtyCanvas(true, false);
                    }
                };

                cropBtn.onclick = () => {
                    isCropVisible = !isCropVisible;
                    cropBtn.style.background = isCropVisible ? "#38bdf8" : "rgba(255, 255, 255, 0.1)";
                    cropBtn.style.color = isCropVisible ? "black" : "white";
                    updateCropUI();
                    if (isCropVisible) { videoPreview.pause(); videoPreview.controls = false; }
                    else { videoPreview.controls = true; }
                };
                
                resetBtn.onclick = () => {
                    if (cropXWidget) cropXWidget.value = 0.0;
                    if (cropYWidget) cropYWidget.value = 0.0;
                    if (cropWWidget) cropWWidget.value = 1.0;
                    if (cropHWidget) cropHWidget.value = 1.0;
                    currentAspectRatio = 0;
                    if (arSelect) arSelect.value = "0";
                    if (wInput) wInput.value = "";
                    if (hInput) hInput.value = "";
                    isCropVisible = false;
                    cropBtn.style.background = "rgba(255, 255, 255, 0.1)";
                    cropBtn.style.color = "white";
                    updateCropUI();
                    app.graph.setDirtyCanvas(true, false);
                };

                container.appendChild(playerTop);

                const videoWrapper = document.createElement("div");
                Object.assign(videoWrapper.style, { position: "relative", width: "100%", flexGrow: "1", minHeight: "0px", display: "flex", alignItems: "center", justifyContent: "center", background: "#000", borderRadius: "4px", overflow: "hidden" });

                const videoPreview = document.createElement("video");
                Object.assign(videoPreview.style, { width: "100%", height: "100%", objectFit: "contain", outline: "none", boxSizing: "border-box" });
                videoPreview.controls = true;
                videoPreview.controlsList = "nodownload nofullscreen noremoteplayback";
                videoPreview.muted = false;
                videoWrapper.appendChild(videoPreview);

                const cropBox = document.createElement("div");
                Object.assign(cropBox.style, { position: "absolute", border: "2px dashed #38bdf8", display: "none", pointerEvents: "auto", cursor: "move", boxSizing: "border-box", boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.5)", zIndex: "10", overflow: "hidden" });

                for (let i = 1; i <= 2; i++) {
                    const vLine = document.createElement("div");
                    Object.assign(vLine.style, { position: "absolute", left: `${i * 33.33}%`, top: "0", bottom: "0", borderLeft: "1px dashed rgba(255,255,255,0.3)", pointerEvents: "none" });
                    const hLine = document.createElement("div");
                    Object.assign(hLine.style, { position: "absolute", top: `${i * 33.33}%`, left: "0", right: "0", borderTop: "1px dashed rgba(255,255,255,0.3)", pointerEvents: "none" });
                    cropBox.appendChild(vLine);
                    cropBox.appendChild(hLine);
                }

                const createCropHandle = (cursor, pos, borders) => {
                    const h = document.createElement("div");
                    Object.assign(h.style, { position: "absolute", width: "20px", height: "20px", background: "transparent", cursor: cursor, pointerEvents: "auto", ...borders, ...pos });
                    return h;
                };

                const tlHandle = createCropHandle("nwse-resize", { top: "-3px", left: "-3px" }, { borderTop: "6px solid #38bdf8", borderLeft: "6px solid #38bdf8" });
                const trHandle = createCropHandle("nesw-resize", { top: "-3px", right: "-3px" }, { borderTop: "6px solid #38bdf8", borderRight: "6px solid #38bdf8" });
                const blHandle = createCropHandle("nesw-resize", { bottom: "-3px", left: "-3px" }, { borderBottom: "6px solid #38bdf8", borderLeft: "6px solid #38bdf8" });
                const brHandle = createCropHandle("nwse-resize", { bottom: "-3px", right: "-3px" }, { borderBottom: "6px solid #38bdf8", borderRight: "6px solid #38bdf8" });
                const tmHandle = createCropHandle("ns-resize", { top: "-3px", left: "50%", transform: "translateX(-50%)" }, { borderTop: "6px solid #38bdf8", width: "16px", height: "10px" });
                const bmHandle = createCropHandle("ns-resize", { bottom: "-3px", left: "50%", transform: "translateX(-50%)" }, { borderBottom: "6px solid #38bdf8", width: "16px", height: "10px" });
                const lmHandle = createCropHandle("ew-resize", { top: "50%", left: "-3px", transform: "translateY(-50%)" }, { borderLeft: "6px solid #38bdf8", width: "10px", height: "16px" });
                const rmHandle = createCropHandle("ew-resize", { top: "50%", right: "-3px", transform: "translateY(-50%)" }, { borderRight: "6px solid #38bdf8", width: "10px", height: "16px" });

                const handles = [tlHandle, trHandle, blHandle, brHandle, tmHandle, bmHandle, lmHandle, rmHandle];
                handles.forEach(h => cropBox.appendChild(h));
                videoWrapper.appendChild(cropBox);
                container.appendChild(videoWrapper);

                const trimArea = document.createElement("div");
                Object.assign(trimArea.style, { display: "flex", flexDirection: "column", gap: "6px", background: "rgba(0, 0, 0, 0.35)", padding: "12px", borderRadius: "6px", border: "1px solid rgba(255, 255, 255, 0.05)", flexShrink: "0", boxSizing: "border-box" });

                const timeRuler = document.createElement("div");
                Object.assign(timeRuler.style, { position: "relative", width: "100%", height: "22px", fontSize: "11px", color: "#aaa", pointerEvents: "none", userSelect: "none", boxSizing: "border-box" });
                trimArea.appendChild(timeRuler);

                const sliderBox = document.createElement("div");
                Object.assign(sliderBox.style, { position: "relative", width: "100%", height: "24px", background: "#111", borderRadius: "4px", cursor: "pointer", userSelect: "none", boxShadow: "inset 0 1px 3px rgba(0,0,0,0.5)", boxSizing: "border-box" });

                const waveCanvas = document.createElement("canvas");
                Object.assign(waveCanvas.style, { position: "absolute", top: "0", left: "0", width: "100%", height: "100%", pointerEvents: "none", zIndex: "1", opacity: "0.6" });
                sliderBox.appendChild(waveCanvas);

                const drawWaveform = () => {
                    if (!waveCanvas) return;
                    const rect = waveCanvas.getBoundingClientRect();
                    if (rect.width === 0 || rect.height === 0) return;
                    const dpr = window.devicePixelRatio || 1;
                    if (waveCanvas.width !== rect.width * dpr || waveCanvas.height !== rect.height * dpr) {
                        waveCanvas.width = rect.width * dpr;
                        waveCanvas.height = rect.height * dpr;
                    }
                    const ctx = waveCanvas.getContext('2d');
                    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                    ctx.clearRect(0, 0, rect.width, rect.height);
                    if (currentWaveformPeaks.length === 0) return;
                    ctx.fillStyle = "rgba(56, 189, 248, 0.8)";
                    const numPeaks = currentWaveformPeaks.length;
                    const centerY = rect.height / 2;
                    const maxAmp = rect.height / 2;
                    for (let i = 0; i < numPeaks; i++) {
                        const x = (i / numPeaks) * rect.width;
                        const w = Math.max(1, (rect.width / numPeaks) - 0.5);
                        const [mn, mx] = currentWaveformPeaks[i];
                        const yMin = centerY - mx * maxAmp;
                        const yMax = centerY - mn * maxAmp;
                        ctx.fillRect(x, yMin, w, Math.max(1, yMax - yMin));
                    }
                };

                const fillPurple = document.createElement("div");
                Object.assign(fillPurple.style, { position: "absolute", height: "100%", background: "purple", pointerEvents: "none", opacity: "0.6", zIndex: "2" });
                const fillBlue = document.createElement("div");
                Object.assign(fillBlue.style, { position: "absolute", height: "100%", background: "rgba(14, 165, 233, 0.6)", pointerEvents: "none", zIndex: "2" });
                const fillGreen = document.createElement("div");
                Object.assign(fillGreen.style, { position: "absolute", height: "100%", background: "green", pointerEvents: "none", opacity: "0.6", zIndex: "2" });
                
                sliderBox.appendChild(fillPurple);
                sliderBox.appendChild(fillBlue);
                sliderBox.appendChild(fillGreen);

                const createHandle = (color) => {
                    const h = document.createElement("div");
                    Object.assign(h.style, { position: "absolute", top: "0", width: "8px", height: "100%", background: color, transform: "translateX(-50%)", pointerEvents: "none", boxShadow: "0 0 4px rgba(0,0,0,0.8)", borderRadius: "2px", zIndex: "3" });
                    return h;
                };

                const startHandle = createHandle("#38bdf8");
                const endHandle = createHandle("#38bdf8");
                sliderBox.appendChild(startHandle);
                sliderBox.appendChild(endHandle);
                
                const splitPurpleHandle = document.createElement("div");
                Object.assign(splitPurpleHandle.style, { position: "absolute", top: "0", width: "8px", height: "100%", background: "purple", transform: "translateX(-50%)", pointerEvents: "auto", cursor: "ew-resize", boxShadow: "0 0 4px rgba(0,0,0,0.8)", borderRadius: "2px", zIndex: "5", display: "none" });
                sliderBox.appendChild(splitPurpleHandle);

                const splitGreenHandle = document.createElement("div");
                Object.assign(splitGreenHandle.style, { position: "absolute", top: "0", width: "8px", height: "100%", background: "green", transform: "translateX(-50%)", pointerEvents: "auto", cursor: "ew-resize", boxShadow: "0 0 4px rgba(0,0,0,0.8)", borderRadius: "2px", zIndex: "5", display: "none" });
                sliderBox.appendChild(splitGreenHandle);

                node.updateSplitHandles = () => {
                    if (!splitPurpleHandle || !splitGreenHandle) return;
                    const activeDur = getActiveDuration();
                    const sc = splitCountWidget ? splitCountWidget.value : 0;
                    const fr = frameRateWidget ? parseFloat(frameRateWidget.value) || 25.0 : 25.0;
                    let s = startTimeWidget ? parseFloat(startTimeWidget.value) || 0 : 0;
                    let e = endTimeWidget ? parseFloat(endTimeWidget.value) || 0 : 0;
                    if (e === 0) e = activeDur;

                    if (sc < 1 || !splitPurpleWidget) splitPurpleHandle.style.display = "none";
                    else {
                        splitPurpleHandle.style.display = "block";
                        let val = isFramesMode ? (splitPurpleIdxWidget.value / fr) : parseFloat(splitPurpleWidget.value);
                        splitPurpleHandle.style.left = `${activeDur > 0 ? (val / activeDur) * 100 : 0}%`;
                    }

                    if (sc < 2 || !splitGreenWidget) splitGreenHandle.style.display = "none";
                    else {
                        splitGreenHandle.style.display = "block";
                        let val = isFramesMode ? (splitGreenIdxWidget.value / fr) : parseFloat(splitGreenWidget.value);
                        splitGreenHandle.style.left = `${activeDur > 0 ? (val / activeDur) * 100 : 0}%`;
                    }
                };
                node.updateSplitHandles();

                trimArea.appendChild(sliderBox);
                container.appendChild(trimArea);

                const waveResizeObserver = new ResizeObserver(() => { requestAnimationFrame(drawWaveform); });

                setTimeout(() => {
                    node.domWidget = node.addDOMWidget("VideoUI", "div", container);
                    node.domWidget.computeSize = function () { return [400, 250]; };
                    requestAnimationFrame(() => {
                        if (node.size[0] < 760) node.size[0] = 760;
                        if (node.size[1] < 880) node.size[1] = 880;
                        if (node.onResize) node.onResize(node.size);
                        if (displayModeWidget) {
                            isFramesMode = displayModeWidget.value === "frames";
                            applySegmentState(isFramesMode);
                            node.toggleWidgetVisibility();
                        }
                        const cw = cropWWidget ? parseFloat(cropWWidget.value) : 1;
                        const ch = cropHWidget ? parseFloat(cropHWidget.value) : 1;
                        const cx = cropXWidget ? parseFloat(cropXWidget.value) : 0;
                        const cy = cropYWidget ? parseFloat(cropYWidget.value) : 0;
                        if (cw < 0.999 || ch < 0.999 || cx > 0.001 || cy > 0.001) {
                            isCropVisible = true;
                            cropBtn.style.background = "#38bdf8";
                            cropBtn.style.color = "black";
                        }
                        updateCropUI();
                        app.graph.setDirtyCanvas(true, true);
                    });
                    waveResizeObserver.observe(sliderBox);
                    requestAnimationFrame(drawWaveform);
                }, 100);

                const onCropPointerDown = (e, handle) => {
                    if (!isCropVisible) return;
                    e.preventDefault(); e.stopPropagation();
                    cropDragging = handle;
                    e.target.setPointerCapture(e.pointerId);
                    dragStartX = e.clientX; dragStartY = e.clientY;
                    dragStartCropX = cropXWidget ? parseFloat(cropXWidget.value) || 0 : 0;
                    dragStartCropY = cropYWidget ? parseFloat(cropYWidget.value) || 0 : 0;
                    dragStartCropW = cropWWidget ? parseFloat(cropWWidget.value) || 1 : 1;
                    dragStartCropH = cropHWidget ? parseFloat(cropHWidget.value) || 1 : 1;
                    e.target.addEventListener("pointermove", onCropPointerMove);
                    e.target.addEventListener("pointerup", onCropPointerUp);
                };

                const onCropPointerMove = (e) => {
                    if (!cropDragging) return;
                    e.preventDefault();
                    const vw = videoPreview.videoWidth;
                    const vh = videoPreview.videoHeight;
                    const cw = videoPreview.clientWidth;
                    const ch = videoPreview.clientHeight;
                    const ratio = Math.min(cw / vw, ch / vh);
                    const renderedW = vw * ratio;
                    const renderedH = vh * ratio;
                    const dx = (e.clientX - dragStartX) / renderedW;
                    const dy = (e.clientY - dragStartY) / renderedH;

                    let new_cw = dragStartCropW, new_ch = dragStartCropH, new_cx = dragStartCropX, new_cy = dragStartCropY;

                    if (cropDragging === "tl") { new_cw = dragStartCropW - dx; new_ch = dragStartCropH - dy; }
                    else if (cropDragging === "tr") { new_cw = dragStartCropW + dx; new_ch = dragStartCropH - dy; }
                    else if (cropDragging === "bl") { new_cw = dragStartCropW - dx; new_ch = dragStartCropH + dy; }
                    else if (cropDragging === "br") { new_cw = dragStartCropW + dx; new_ch = dragStartCropH + dy; }
                    else if (cropDragging === "tm") { new_ch = dragStartCropH - dy; }
                    else if (cropDragging === "bm") { new_ch = dragStartCropH + dy; }
                    else if (cropDragging === "lm") { new_cw = dragStartCropW - dx; }
                    else if (cropDragging === "rm") { new_cw = dragStartCropW + dx; }

                    if (currentAspectRatio > 0 && cropDragging !== "center") {
                        const R = currentAspectRatio * (vh / vw);
                        if (["tm", "bm"].includes(cropDragging)) { new_cw = new_ch * R; new_cx = dragStartCropX + (dragStartCropW - new_cw) / 2; }
                        else if (["lm", "rm"].includes(cropDragging)) { new_ch = new_cw / R; new_cy = dragStartCropY + (dragStartCropH - new_ch) / 2; }
                        else { new_ch = new_cw / R; }
                    }

                    if (cropDragging === "tl") { new_cx = dragStartCropX + dragStartCropW - new_cw; new_cy = dragStartCropY + dragStartCropH - new_ch; }
                    else if (cropDragging === "tr") { new_cx = dragStartCropX; new_cy = dragStartCropY + dragStartCropH - new_ch; }
                    else if (cropDragging === "bl") { new_cx = dragStartCropX + dragStartCropW - new_cw; new_cy = dragStartCropY; }
                    else if (cropDragging === "br") { new_cx = dragStartCropX; new_cy = dragStartCropY; }
                    else if (cropDragging === "tm") { new_cy = dragStartCropY + dragStartCropH - new_ch; if (!(currentAspectRatio > 0)) new_cx = dragStartCropX; }
                    else if (cropDragging === "bm") { new_cy = dragStartCropY; if (!(currentAspectRatio > 0)) new_cx = dragStartCropX; }
                    else if (cropDragging === "lm") { new_cx = dragStartCropX + dragStartCropW - new_cw; if (!(currentAspectRatio > 0)) new_cy = dragStartCropY; }
                    else if (cropDragging === "rm") { new_cx = dragStartCropX; if (!(currentAspectRatio > 0)) new_cy = dragStartCropY; }
                    else if (cropDragging === "center") { new_cx = dragStartCropX + dx; new_cy = dragStartCropY + dy; }

                    if (new_cw < 0.02) { new_cw = 0.02; if (currentAspectRatio > 0) new_ch = new_cw / (currentAspectRatio * (vh / vw)); }
                    if (new_ch < 0.02) { new_ch = 0.02; if (currentAspectRatio > 0) new_cw = new_ch * (currentAspectRatio * (vh / vw)); }

                    if (cropDragging === "center") {
                        new_cx = Math.max(0, Math.min(new_cx, 1 - new_cw));
                        new_cy = Math.max(0, Math.min(new_cy, 1 - new_ch));
                    } else {
                        if (new_cx < 0) { if (["tl", "bl", "lm"].includes(cropDragging)) { new_cw += new_cx; new_cx = 0; } }
                        if (new_cy < 0) { if (["tl", "tr", "tm"].includes(cropDragging)) { new_ch += new_cy; new_cy = 0; } }
                        if (new_cx + new_cw > 1) { if (["tr", "br", "rm"].includes(cropDragging)) new_cw = 1 - new_cx; }
                        if (new_cy + new_ch > 1) { if (["bl", "br", "bm"].includes(cropDragging)) new_ch = 1 - new_cy; }

                        if (currentAspectRatio > 0) {
                            const R = currentAspectRatio * (vh / vw);
                            if (new_cw / new_ch > R + 0.001) { new_cw = new_ch * R; if (["tl", "bl", "lm"].includes(cropDragging)) new_cx = dragStartCropX + dragStartCropW - new_cw; }
                            else if (new_cw / new_ch < R - 0.001) { new_ch = new_cw / R; if (["tl", "tr", "tm"].includes(cropDragging)) new_cy = dragStartCropY + dragStartCropH - new_ch; }
                        }
                    }

                    if (cropXWidget) cropXWidget.value = parseFloat(new_cx.toFixed(3));
                    if (cropYWidget) cropYWidget.value = parseFloat(new_cy.toFixed(3));
                    if (cropWWidget) cropWWidget.value = parseFloat(new_cw.toFixed(3));
                    if (cropHWidget) cropHWidget.value = parseFloat(new_ch.toFixed(3));
                    updateCropUI();
                    app.graph.setDirtyCanvas(true, false);
                };

                const onCropPointerUp = (e) => {
                    cropDragging = null;
                    e.target.releasePointerCapture(e.pointerId);
                    e.target.removeEventListener("pointermove", onCropPointerMove);
                    e.target.removeEventListener("pointerup", onCropPointerUp);
                };

                cropBox.onpointerdown = (e) => { if (e.target === cropBox) onCropPointerDown(e, "center"); };
                tlHandle.onpointerdown = (e) => onCropPointerDown(e, "tl");
                trHandle.onpointerdown = (e) => onCropPointerDown(e, "tr");
                blHandle.onpointerdown = (e) => onCropPointerDown(e, "bl");
                brHandle.onpointerdown = (e) => onCropPointerDown(e, "br");
                tmHandle.onpointerdown = (e) => onCropPointerDown(e, "tm");
                bmHandle.onpointerdown = (e) => onCropPointerDown(e, "bm");
                lmHandle.onpointerdown = (e) => onCropPointerDown(e, "lm");
                rmHandle.onpointerdown = (e) => onCropPointerDown(e, "rm");

                const resizeObserver = new ResizeObserver(() => { if (isCropVisible) updateCropUI(); });
                resizeObserver.observe(videoWrapper);

                const oldOnRemoved = node.onRemoved;
                node.onRemoved = function () {
                    resizeObserver.disconnect();
                    if (waveResizeObserver) waveResizeObserver.disconnect();
                    if (oldOnRemoved) oldOnRemoved.apply(this, arguments);
                }
                
                const setPurpleVal = (val_sec) => {
                    const fr = frameRateWidget ? parseFloat(frameRateWidget.value) || 25.0 : 25.0;
                    if (splitPurpleIdxWidget) splitPurpleIdxWidget.value = Math.round(val_sec * fr);
                    if (splitPurpleWidget) splitPurpleWidget.value = parseFloat(val_sec.toFixed(3));
                    clampSplitValues();
                    app.graph.setDirtyCanvas(true, false);
                };

                const setGreenVal = (val_sec) => {
                    const fr = frameRateWidget ? parseFloat(frameRateWidget.value) || 25.0 : 25.0;
                    if (splitGreenIdxWidget) splitGreenIdxWidget.value = Math.round(val_sec * fr);
                    if (splitGreenWidget) splitGreenWidget.value = parseFloat(val_sec.toFixed(3));
                    clampSplitValues();
                    app.graph.setDirtyCanvas(true, false);
                };

                const setupHandleEvents = (handle, setVal) => {
                    let splitDragging = false;
                    handle.addEventListener("pointerdown", (e) => {
                        if (handle.style.display === "none") return;
                        e.preventDefault(); e.stopPropagation();
                        splitDragging = true;
                        handle.setPointerCapture(e.pointerId);
                        const activeDur = getActiveDuration();
                        const rect = sliderBox.getBoundingClientRect();
                        const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
                        setVal((x / rect.width) * activeDur);
                        if (duration > 0) videoPreview.currentTime = (x / rect.width) * activeDur;
                        node.updateSplitHandles(); updateUI(); app.graph.setDirtyCanvas(true, false);
                    });
                    handle.addEventListener("pointermove", (e) => {
                        if (!splitDragging) return;
                        e.preventDefault();
                        const activeDur = getActiveDuration();
                        const rect = sliderBox.getBoundingClientRect();
                        const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
                        setVal((x / rect.width) * activeDur);
                        if (duration > 0) videoPreview.currentTime = (x / rect.width) * activeDur;
                        node.updateSplitHandles(); updateUI(); app.graph.setDirtyCanvas(true, false);
                    });
                    handle.addEventListener("pointerup", (e) => { splitDragging = false; handle.releasePointerCapture(e.pointerId); });
                };

                setupHandleEvents(splitPurpleHandle, setPurpleVal);
                setupHandleEvents(splitGreenHandle, setGreenVal);

                setTimeout(() => { updateRuler(); updateUI(); }, 50);

                videoPreview.onloadedmetadata = () => {
                    const newDuration = videoPreview.duration;
                    if (!newDuration || newDuration === Infinity || isNaN(newDuration)) return;
                    duration = newDuration;
                    node.accurateDuration = newDuration;
                    const fr = frameRateWidget ? parseFloat(frameRateWidget.value) || 25.0 : 25.0;  
                    node.accurateFrameCount = Math.round(newDuration * fr); 
                    if (endTimeWidget) endTimeWidget.value = newDuration;
                    if (endFrameWidget) endFrameWidget.value = node.accurateFrameCount > 0 ? node.accurateFrameCount - 1 : 0;
                    node.syncFramesFromTime();
                    updateRuler();
                    updateUI(true);
                    updateCropUI();
                };

                videoPreview.ontimeupdate = () => {
                    if (!duration || dragging) return;
                    let s = startTimeWidget ? parseFloat(startTimeWidget.value) || 0 : 0;
                    let e = endTimeWidget ? parseFloat(endTimeWidget.value) || duration : duration;
                    if (e === 0) e = duration;
                    if (videoPreview.currentTime >= e && e > 0) videoPreview.currentTime = s;
                    else if (videoPreview.currentTime < s) videoPreview.currentTime = s;
                };

                sliderBox.onpointerdown = (e) => {
                    const activeDur = getActiveDuration();
                    const rect = sliderBox.getBoundingClientRect();
                    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
                    const val = (x / rect.width) * activeDur;
                    let s = startTimeWidget ? parseFloat(startTimeWidget.value) || 0 : 0;
                    let e_val = endTimeWidget ? parseFloat(endTimeWidget.value) || activeDur : activeDur;
                    if (e_val === 0) e_val = activeDur;
                    const handleTolerance = (10 / rect.width) * activeDur;

                    if (val > s + handleTolerance && val < e_val - handleTolerance) {
                        dragging = 'center'; dragOffset = val - s; dragSelectionWidth = e_val - s;
                    } else if (Math.abs(val - s) < Math.abs(val - e_val)) {
                        dragging = 'start';
                        if (startTimeWidget) startTimeWidget.value = parseFloat(Math.min(val, e_val).toFixed(2));
                        if (duration > 0) videoPreview.currentTime = startTimeWidget.value;
                    } else {
                        dragging = 'end';
                        if (endTimeWidget) endTimeWidget.value = parseFloat(Math.max(val, s).toFixed(2));
                        if (duration > 0) videoPreview.currentTime = endTimeWidget.value;
                    }
                    node.syncFramesFromTime(); updateUI(); app.graph.setDirtyCanvas(true, false);
                    sliderBox.setPointerCapture(e.pointerId);
                };

                sliderBox.onpointermove = (e) => {
                    if (!dragging) return;
                    const activeDur = getActiveDuration();
                    const rect = sliderBox.getBoundingClientRect();
                    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
                    const val = (x / rect.width) * activeDur;

                    if (dragging === 'start') {
                        let e_val = endTimeWidget ? parseFloat(endTimeWidget.value) || activeDur : activeDur;
                        if (e_val === 0) e_val = activeDur;
                        if (startTimeWidget) startTimeWidget.value = parseFloat(Math.min(val, e_val).toFixed(2));
                        if (duration > 0) videoPreview.currentTime = startTimeWidget.value;
                    } else if (dragging === 'end') {
                        const s = startTimeWidget ? parseFloat(startTimeWidget.value) || 0 : 0;
                        if (endTimeWidget) endTimeWidget.value = parseFloat(Math.max(val, s).toFixed(2));
                        if (duration > 0) videoPreview.currentTime = endTimeWidget.value;
                    } else if (dragging === 'center') {
                        let newStart = val - dragOffset; let newEnd = newStart + dragSelectionWidth;
                        if (newStart < 0) { newStart = 0; newEnd = dragSelectionWidth; }
                        else if (newEnd > activeDur) { newEnd = activeDur; newStart = activeDur - dragSelectionWidth; }
                        if (startTimeWidget) startTimeWidget.value = parseFloat(newStart.toFixed(2));
                        if (endTimeWidget) endTimeWidget.value = parseFloat(newEnd.toFixed(2));
                        if (duration > 0) videoPreview.currentTime = startTimeWidget.value;
                    }
                    node.syncFramesFromTime(); updateUI(); app.graph.setDirtyCanvas(true, false);
                };

                sliderBox.onpointerup = (e) => { dragging = null; sliderBox.releasePointerCapture(e.pointerId); };

                if (pathWidget && pathWidget.value) applyVideoPath(pathWidget.value);
                return r;
            };
        }
    },
});