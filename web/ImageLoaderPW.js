import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// --- CSS Injections ---
function injectGalleryStyles() {
    if (document.getElementById('pw-gallery-styles')) return;
    const style = document.createElement('style');
    style.id = 'pw-gallery-styles';
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
    `;
    document.head.appendChild(style);
}

function injectEditorStyles() {
    if (document.getElementById('pw-image-editor-styles')) return;
    const style = document.createElement('style');
    style.id = 'pw-image-editor-styles';
    style.textContent = `
        .pw-image-editor-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.75); display: flex; align-items: center; justify-content: center; z-index: 10020; backdrop-filter: blur(4px); }
        .pw-image-editor-panel { width: 920px; max-width: 92vw; max-height: 88vh; background: #1e1e1e; border-radius: 8px; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6); display: flex; flex-direction: column; overflow: hidden; border: 1px solid #3c3c3c; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
        .pw-image-editor-header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; background: #2d2d30; border-bottom: 1px solid #3c3c3c; }
        .pw-image-editor-title { font-size: 13px; font-weight: 600; color: #cccccc; }
        .pw-image-editor-close { cursor: pointer; color: #cccccc; font-size: 16px; line-height: 16px; padding: 4px 6px; border-radius: 4px; transition: background 0.2s, color 0.2s; }
        .pw-image-editor-close:hover { background: rgba(255, 255, 255, 0.1); color: #ffffff; }
        .pw-image-editor-body { padding: 16px; flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 12px; background: #1e1e1e; }
        .pw-image-editor-meta { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #cccccc; background: #252526; padding: 8px 12px; border-radius: 4px; border: 1px solid #3c3c3c; }
        .pw-image-editor-meta-left { flex: 1; }
        .pw-image-editor-meta-right { display: flex; align-items: center; gap: 16px; }
        .pw-image-editor-size { font-weight: 600; color: #007acc; min-width: 120px; text-align: right; }
        .pw-image-editor-canvas-shell { border-radius: 4px; background: #252526; padding: 12px; border: 1px solid #3c3c3c; display: flex; justify-content: center; align-items: center; flex: 1; overflow: hidden; min-height: 200px; position: relative; }
        .pw-image-editor-canvas { background: #000; border-radius: 4px; cursor: crosshair; border: 1px solid #3c3c3c; }
        .pw-image-editor-info { font-size: 12px; color: #cccccc; text-align: center; padding: 8px; }
        .pw-image-editor-footer { padding: 12px 16px; display: flex; justify-content: flex-end; gap: 8px; border-top: 1px solid #3c3c3c; background: #2d2d30; }
        .pw-button { padding: 6px 12px; border-radius: 4px; border: 1px solid #3c3c3c; background: #0e639c; color: #ffffff; font-size: 12px; font-weight: 600; cursor: pointer; transition: background 0.2s, border-color 0.2s; user-select: none; min-width: 80px; text-align: center; }
        .pw-button:hover { background: #1177bb; border-color: #4d4d4d; }
        .pw-button.disabled { opacity: 0.6; cursor: not-allowed; background: #3c3c3c; }
        .pw-button-secondary { background: #3c3c3c; border-color: #4d4d4d; }
        .pw-button-secondary:hover { background: #4d4d4d; border-color: #5a5a5a; }
        .pw-button-primary { background: #0e639c; border-color: #1177bb; }
        .pw-button-primary:hover { background: #1177bb; border-color: #138cdd; }
        .pw-comfyui-toggle-container { display: flex; align-items: center; gap: 8px; }
        .pw-comfyui-toggle { appearance: none; width: 32px; height: 16px; background: #3c3c3c; border-radius: 8px; position: relative; cursor: pointer; border: 1px solid #4d4d4d; transition: background 0.2s, border-color 0.2s; }
        .pw-comfyui-toggle:checked { background: #0e639c; border-color: #1177bb; }
        .pw-comfyui-toggle::before { content: ''; position: absolute; width: 12px; height: 12px; border-radius: 50%; background: #cccccc; top: 1px; left: 1px; transition: transform 0.2s; }
        .pw-comfyui-toggle:checked::before { transform: translateX(16px); background: #ffffff; }
        .pw-comfyui-toggle-label { font-size: 12px; color: #cccccc; cursor: pointer; user-select: none; }
    `;
    document.head.appendChild(style);
}

// --- Image Editor Logic ---
function openImageEditorPW(originalPath, onCropSaved) {
    injectEditorStyles();
    let isSaving = false;
    const overlay = document.createElement("div");
    overlay.className = "pw-image-editor-overlay";
    const cleanupListeners = [];
    const addListener = (target, event, handler) => {
        target.addEventListener(event, handler);
        cleanupListeners.push(() => target.removeEventListener(event, handler));
    };

    const panel = document.createElement("div");
    panel.className = "pw-image-editor-panel";
    panel.style.width = "90vw";
    panel.style.height = "90vh";
    panel.style.maxWidth = "none";
    panel.style.maxHeight = "none";

    const headerBar = document.createElement("div");
    headerBar.className = "pw-image-editor-header";
    const title = document.createElement("div");
    title.className = "pw-image-editor-title";
    title.innerText = `Edit ${originalPath.split('/').pop()}`;
    const closeButton = document.createElement("div");
    closeButton.className = "pw-image-editor-close";
    closeButton.innerHTML = "×";
    headerBar.appendChild(title);
    headerBar.appendChild(closeButton);

    const body = document.createElement("div");
    body.className = "pw-image-editor-body";
    const footer = document.createElement("div");
    footer.className = "pw-image-editor-footer";
    const info = document.createElement("div");
    info.className = "pw-image-editor-info";
    info.innerText = "Loading original image...";
    body.appendChild(info);

    panel.appendChild(headerBar);
    panel.appendChild(body);
    panel.appendChild(footer);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    function closeEditor() {
        cleanupListeners.forEach(fn => { try { fn(); } catch (e) {} });
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    addListener(closeButton, "click", closeEditor);
    addListener(overlay, "click", (e) => { if (e.target === overlay) closeEditor(); });

    const saveButton = document.createElement("div");
    saveButton.className = "pw-button pw-button-primary";
    saveButton.innerText = "Save Crop";
    const cancelButton = document.createElement("div");
    cancelButton.className = "pw-button pw-button-secondary";
    cancelButton.innerText = "Cancel";
    footer.appendChild(cancelButton);
    footer.appendChild(saveButton);
    addListener(cancelButton, "click", closeEditor);

    let cropState = null;
    let sizeLabel = null;

    function updateSaveState(enabled) {
        const allow = enabled && !isSaving && typeof cropState === "function";
        if (allow) {
            saveButton.classList.remove("disabled");
            saveButton.style.pointerEvents = "auto";
        } else {
            saveButton.classList.add("disabled");
            saveButton.style.pointerEvents = "none";
        }
    }
    updateSaveState(false);

    function renderCropper(imageUrl) {
        body.innerHTML = "";
        cropState = null;
        const metaBar = document.createElement("div");
        metaBar.className = "pw-image-editor-meta";
        const leftInfo = document.createElement("div");
        leftInfo.className = "pw-image-editor-meta-left";
        leftInfo.innerText = `Original: ... x ...`;
        const rightContainer = document.createElement("div");
        rightContainer.className = "pw-image-editor-meta-right";

        const toggleContainer = document.createElement("div");
        toggleContainer.className = "pw-comfyui-toggle-container";
        const cropToggle = document.createElement("input");
        cropToggle.className = "pw-comfyui-toggle";
        cropToggle.type = "checkbox";
        cropToggle.id = `pw-crop-toggle-${Date.now()}`;
        cropToggle.checked = true;
        const toggleLabel = document.createElement("label");
        toggleLabel.className = "pw-comfyui-toggle-label";
        toggleLabel.setAttribute("for", cropToggle.id);
        toggleLabel.innerText = "Show Crop Box";
        let showCropBox = true;

        addListener(cropToggle, "change", () => { showCropBox = cropToggle.checked; draw(); });
        toggleContainer.appendChild(cropToggle);
        toggleContainer.appendChild(toggleLabel);

        sizeLabel = document.createElement("div");
        sizeLabel.className = "pw-image-editor-size";
        sizeLabel.innerText = `Crop: ... x ...`;

        rightContainer.appendChild(toggleContainer);
        rightContainer.appendChild(sizeLabel);
        metaBar.appendChild(leftInfo);
        metaBar.appendChild(rightContainer);

        const canvasShell = document.createElement("div");
        canvasShell.className = "pw-image-editor-canvas-shell";
        canvasShell.style.overflow = "hidden";
        canvasShell.style.position = "relative";

        const canvas = document.createElement("canvas");
        canvas.className = "pw-image-editor-canvas";
        canvasShell.appendChild(canvas);
        body.appendChild(metaBar);
        body.appendChild(canvasShell);

        const img = new Image();
        const ctx = canvas.getContext("2d");

        let actualWidth = 0;
        let actualHeight = 0;
        let userZoom = 1;
        let canvasOffsetX = 0;
        let canvasOffsetY = 0;

        let dragging = null;
        let startPoint = null;
        let crop = { x: 0, y: 0, width: 1, height: 1 };

        function setCrop(newCrop) {
            crop = {
                x: Math.max(0, Math.min(newCrop.x, actualWidth)),
                y: Math.max(0, Math.min(newCrop.y, actualHeight)),
                width: Math.max(1, Math.min(newCrop.width, actualWidth)),
                height: Math.max(1, Math.min(newCrop.height, actualHeight))
            };
            if (crop.x + crop.width > actualWidth) crop.width = Math.max(1, actualWidth - crop.x);
            if (crop.y + crop.height > actualHeight) crop.height = Math.max(1, actualHeight - crop.y);
            crop.x = Math.max(0, Math.min(crop.x, actualWidth - 1));
            crop.y = Math.max(0, Math.min(crop.y, actualHeight - 1));
            crop.width = Math.max(1, Math.min(crop.width, actualWidth - crop.x));
            crop.height = Math.max(1, Math.min(crop.height, actualHeight - crop.y));

            if (sizeLabel) sizeLabel.innerText = `Crop: ${Math.round(crop.width)} x ${Math.round(crop.height)}`;
            updateSaveState(crop.width >= 2 && crop.height >= 2 && !isSaving);
        }

        function draw() {
            if (!actualWidth || !actualHeight) return;
            const displayWidth = Math.round(actualWidth * userZoom);
            const displayHeight = Math.round(actualHeight * userZoom);
            if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
                canvas.width = displayWidth;
                canvas.height = displayHeight;
            }
            canvasOffsetX = 0; 
            canvasOffsetY = 0;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, canvasOffsetX, canvasOffsetY, displayWidth, displayHeight);

            if (!crop.width || !crop.height) return;

            const left = crop.x * userZoom + canvasOffsetX;
            const top = crop.y * userZoom + canvasOffsetY;
            const w = crop.width * userZoom;
            const h = crop.height * userZoom;

            if (showCropBox) {
                ctx.save();
                ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.globalCompositeOperation = "destination-out";
                ctx.fillRect(left, top, w, h);
                ctx.restore();

                ctx.strokeStyle = "#007ACC";
                ctx.lineWidth = 2;
                ctx.strokeRect(left, top, w, h);

                const handleSize = 8;
                const handles = [[left, top], [left + w, top], [left, top + h], [left + w, top + h]];
                ctx.fillStyle = "#007ACC";
                handles.forEach(([hx, hy]) => {
                    ctx.beginPath(); ctx.arc(hx, hy, handleSize / 2, 0, Math.PI * 2); ctx.fill();
                });

                const edgeHandles = [[left + w/2, top], [left + w/2, top + h], [left, top + h/2], [left + w, top + h/2]];
                edgeHandles.forEach(([hx, hy]) => {
                    ctx.beginPath(); ctx.arc(hx, hy, handleSize / 2, 0, Math.PI * 2); ctx.fill();
                });
            }
        }

        function toImageCoords(evt) {
            const rect = canvas.getBoundingClientRect();
            const rawX = (evt.clientX - rect.left);
            const rawY = (evt.clientY - rect.top);
            const displayX = (rawX - canvasOffsetX) / userZoom;
            const displayY = (rawY - canvasOffsetY) / userZoom;
            const clampedX = Math.max(0, Math.min(displayX, actualWidth));
            const clampedY = Math.max(0, Math.min(displayY, actualHeight));
            return { x: clampedX, y: clampedY };
        }

        function getHandle(pos) {
            if (!crop.width || !crop.height || !actualWidth || !actualHeight) return null;
            const threshold = 8 / userZoom;
            const left = crop.x, right = crop.x + crop.width, top = crop.y, bottom = crop.y + crop.height;
            const nearLeft = Math.abs(pos.x - left) <= threshold;
            const nearRight = Math.abs(pos.x - right) <= threshold;
            const nearTop = Math.abs(pos.y - top) <= threshold;
            const nearBottom = Math.abs(pos.y - bottom) <= threshold;

            if (nearLeft && nearTop) return "nw";
            if (nearRight && nearTop) return "ne";
            if (nearLeft && nearBottom) return "sw";
            if (nearRight && nearBottom) return "se";

            const nearVerticalCenter = Math.abs(pos.y - (top + bottom) / 2) <= threshold;
            const nearHorizontalCenter = Math.abs(pos.x - (left + right) / 2) <= threshold;
            if (nearTop && nearHorizontalCenter) return "n";
            if (nearBottom && nearHorizontalCenter) return "s";
            if (nearLeft && nearVerticalCenter) return "w";
            if (nearRight && nearVerticalCenter) return "e";

            const inside = pos.x >= left && pos.x <= right && pos.y >= top && pos.y <= bottom;
            if (inside) return "move";
            return null;
        }

        function applyDrag(pos) {
            if (!dragging || !actualWidth || !actualHeight) return;
            const minSize = 8;
            let { x, y, width, height } = crop;
            const clampX = (val) => Math.max(0, Math.min(val, actualWidth));
            const clampY = (val) => Math.max(0, Math.min(val, actualHeight));

            if (dragging === "new") {
                x = Math.min(startPoint.x, pos.x);
                y = Math.min(startPoint.y, pos.y);
                width = Math.max(minSize, Math.abs(pos.x - startPoint.x));
                height = Math.max(minSize, Math.abs(pos.y - startPoint.y));
            } else if (dragging === "move") {
                const dx = pos.x - startPoint.x;
                const dy = pos.y - startPoint.y;
                x = clampX(x + dx);
                y = clampY(y + dy);
                startPoint = pos;
            } else {
                switch (dragging) {
                    case "n": const newTop = clampY(pos.y); height = height + (y - newTop); y = newTop; break;
                    case "s": height = clampY(pos.y) - y; break;
                    case "w": const newLeft = clampX(pos.x); width = width + (x - newLeft); x = newLeft; break;
                    case "e": width = clampX(pos.x) - x; break;
                    case "nw": const ntlx = clampX(pos.x); const ntly = clampY(pos.y); width = width + (x - ntlx); height = height + (y - ntly); x = ntlx; y = ntly; break;
                    case "ne": const ntrx = clampX(pos.x); height = height + (y - clampY(pos.y)); y = clampY(pos.y); width = ntrx - x; break;
                    case "sw": const nblx = clampX(pos.x); width = width + (x - nblx); height = clampY(pos.y) - y; x = nblx; break;
                    case "se": width = clampX(pos.x) - x; height = clampY(pos.y) - y; break;
                }
                width = Math.max(minSize, width);
                height = Math.max(minSize, height);
                startPoint = pos;
            }
            x = clampX(x); y = clampY(y);
            width = Math.min(width, actualWidth - x);
            height = Math.min(height, actualHeight - y);
            setCrop({ x, y, width, height });
            draw();
        }

        addListener(canvas, "mousedown", (evt) => {
            evt.preventDefault();
            if (!actualWidth || !actualHeight) return;
            const pos = toImageCoords(evt);
            const handle = getHandle(pos);
            if (!handle && (pos.x < crop.x || pos.x > crop.x + crop.width || pos.y < crop.y || pos.y > crop.y + crop.height)) {
                dragging = "new";
                startPoint = pos;
                setCrop({ x: pos.x, y: pos.y, width: 1, height: 1 });
                draw();
            } else {
                dragging = handle || "move";
                startPoint = pos;
            }
        });

        const handleMove = (evt) => { if (dragging) applyDrag(toImageCoords(evt)); };
        const handleUp = () => { dragging = null; };
        addListener(window, "mousemove", handleMove);
        addListener(window, "mouseup", handleUp);

        addListener(canvasShell, "wheel", (evt) => {
            evt.preventDefault();
            const rect = canvas.getBoundingClientRect();
            const mouseX = (evt.clientX - rect.left - canvasOffsetX) / userZoom;
            const mouseY = (evt.clientY - rect.top - canvasOffsetY) / userZoom;
            const zoomFactor = evt.deltaY > 0 ? 0.9 : 1.1;
            const maxZoom = 1;
            const newZoom = Math.max(0.1, Math.min(maxZoom, userZoom * zoomFactor));
            if (Math.abs(newZoom - userZoom) < 0.01) return;
            const newMouseX = (evt.clientX - rect.left - canvasOffsetX) / newZoom;
            const newMouseY = (evt.clientY - rect.top - canvasOffsetY) / newZoom;
            const deltaX = (newMouseX - mouseX) * newZoom;
            const deltaY = (newMouseY - mouseY) * newZoom;
            userZoom = newZoom;
            canvasOffsetX += deltaX;
            canvasOffsetY += deltaY;
            draw();
            if (sizeLabel) {
                const zoomPercent = Math.round(userZoom * 100);
                sizeLabel.innerText = `Crop: ${Math.round(crop.width)} x ${Math.round(crop.height)} | Zoom: ${zoomPercent}%`;
            }
        });

        img.onload = () => {
            actualWidth = img.naturalWidth;
            actualHeight = img.naturalHeight;
            leftInfo.innerText = `Original: ${actualWidth} x ${actualHeight}`;
            const canvasShellRect = canvasShell.getBoundingClientRect();
            const maxWidth = canvasShellRect.width - 24;
            const maxHeight = canvasShellRect.height - 24;
            const displayScale = Math.min(maxWidth / actualWidth, maxHeight / actualHeight, 1);
            userZoom = displayScale;
            
            const defaultWidth = Math.max(1, Math.floor(actualWidth / 2));
            const defaultHeight = Math.max(1, Math.floor(actualHeight / 2));
            const defaultX = Math.max(0, Math.floor((actualWidth - defaultWidth) / 2));
            const defaultY = Math.max(0, Math.floor((actualHeight - defaultHeight) / 2));
            setCrop({ x: defaultX, y: defaultY, width: defaultWidth, height: defaultHeight });
            draw();

            cropState = () => {
                const cropCanvas = document.createElement("canvas");
                const w = Math.max(1, Math.round(crop.width));
                const h = Math.max(1, Math.round(crop.height));
                cropCanvas.width = w;
                cropCanvas.height = h;
                const cropCtx = cropCanvas.getContext("2d");
                cropCtx.drawImage(img, crop.x, crop.y, crop.width, crop.height, 0, 0, w, h);
                return { dataUrl: cropCanvas.toDataURL("image/png"), width: w, height: h };
            };
            updateSaveState(true);
        };
        img.onerror = () => {
            body.innerHTML = "";
            const errorText = document.createElement("div");
            errorText.className = "pw-image-editor-info";
            errorText.innerText = "Unable to render image";
            body.appendChild(errorText);
            updateSaveState(false);
        };
        
        img.src = imageUrl;
    }

    const imageUrl = `/view?filename=${encodeURIComponent(originalPath)}&type=input`;
    renderCropper(imageUrl);

    addListener(saveButton, "click", async () => {
        if (!cropState || isSaving) return;
        const cropped = cropState();
        if (!cropped || !cropped.dataUrl) return;
        isSaving = true;
        updateSaveState(false);
        saveButton.innerText = "Saving...";
        try {
            const resp = await fetch("/ImageLoaderPW/crop", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ filename: originalPath, image: cropped.dataUrl })
            });
            const data = await resp.json();
            if (data.error) throw new Error(data.error);
            
            onCropSaved(data.filename);
            closeEditor();
        } catch (error) {
            console.error("Save crop failed:", error);
            saveButton.innerText = "Save Crop";
            isSaving = false;
            updateSaveState(true);
        }
    });
}

app.registerExtension({
    name: "Comfy.ImageLoaderPW",
    async nodeCreated(node) {
        if (node.comfyClass !== "ImageLoaderPW") return;

        injectGalleryStyles();
        injectEditorStyles();

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
            min-height: 250px; 
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
        uploadBtn.innerText = "Upload Images";
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
        fileInput.accept = "image/*";
        fileInput.style.display = "none";
        container.appendChild(fileInput);

        const galleryWidget = node.addDOMWidget("Gallery", "html_gallery", container, { serialize: false });
        
        galleryWidget.computeSize = function() {
            const galleryY = this.last_y || 40;
            const minOutputsHeight = (node.outputs ? node.outputs.length : 1) * 20;
            const requiredGalleryHeight = Math.max(250, minOutputsHeight + 40 - galleryY);
            return [150, requiredGalleryHeight]; 
        };

        const pathsWidget = node.widgets.find(w => w.name === "image_paths");
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

        // --- CRITICAL FIX FOR V3 ---
        function syncOutputs(count) {
            if (!node.outputs) return;
            
            // V3 nodes have static schemas defined in the backend. 
            // We CANNOT add or remove outputs dynamically in V3, or the node will crash.
            const isV3 = checkIsV3();
            if (isV3) {
                // In V3, all 51 outputs are always present. Just update layout.
                updateLayout();
                return;
            }

            // V1 LiteGraph dynamic output logic
            let changed = false;
            const targetImageOutputs = Math.max(3, count);
            const targetTotal = targetImageOutputs + 1; 
            
            while (node.outputs.length > targetTotal && node.outputs.length > 4) {
                node.removeOutput(node.outputs.length - 1);
                changed = true;
            }

            for (let i = node.outputs.length; i < targetTotal; i++) {
                node.addOutput(`image_${i}`, "IMAGE");
                changed = true;
            }

            if (changed) {
                updateLayout();
            }
        }

        function notifyConnectedNodes(imageCount) {
            if (!node.outputs) return;
            for (const output of node.outputs) {
                if (!output.links) continue;
                for (const linkId of output.links) {
                    const link = app.graph.links[linkId];
                    if (!link) continue;
                    const targetNode = app.graph.getNodeById(link.target_id);
                    if (targetNode && typeof targetNode._syncImageCount === "function") {
                        targetNode._syncImageCount(imageCount);
                    }
                }
            }
        }

        function optimizeGrid(gridW, gridH) {
            const paths = (pathsWidget?.value || "").split(/\n|,/).map(s => s.trim()).filter(s => s);
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
                    v3NodeElement.addEventListener("dragover", (e) => {
                        e.preventDefault(); 
                    });
                    v3NodeElement.addEventListener("drop", (e) => {
                        if (e.dataTransfer && e.dataTransfer.files) {
                            const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
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

            const availableGalleryHeight = targetH - galleryY - paddingBottom;
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
            
            const availableGalleryHeight = size[1] - galleryY - paddingBottom;
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
            const paths = (pathsWidget?.value || "").split(/\n|,/).map(s => s.trim()).filter(s => s);
            
            if (!isRearranging) {
                syncOutputs(paths.length);
            }
            node._imageCount = paths.length;
            notifyConnectedNodes(paths.length);

            paths.forEach((path, index) => {
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

                const img = document.createElement("img");
                img.src = `/api/view?filename=${encodeURIComponent(path)}&type=input`;
                img.style.cssText = "max-width: 100%; max-height: 100%; object-fit: contain; pointer-events: auto; display: block;";
                img.draggable = false; 
                
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

                const cropBtn = document.createElement("div");
                cropBtn.className = "pw-crop-btn";
                cropBtn.style.cssText = `
                    position: absolute; top: 50%; left: 50%; 
                    transform: translate(-50%, -50%);
                    background: rgba(0, 0, 0, 0.6); color: white; 
                    width: 48px; height: 48px; 
                    display: flex; align-items: center; justify-content: center; 
                    font-size: 32px; cursor: pointer; z-index: 10;
                    border-radius: 50%;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.6);
                `;
                cropBtn.innerHTML = "✂️";

                cropBtn.onclick = (e) => {
                    e.stopPropagation();
                    openImageEditorPW(path, (newFilename) => {
                        const currentPaths = (pathsWidget?.value || "").split("\n").map(s => s.trim()).filter(s => s);
                        const updatedPaths = currentPaths.map(p => p === path ? newFilename : p);
                        setWidgetValue(updatedPaths, false);
                    });
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

                item.appendChild(img);
                item.appendChild(del);
                item.appendChild(numBadge);
                item.appendChild(cropBtn);
                grid.appendChild(item);
            });

            if (!isRearranging) {
                requestAnimationFrame(() => {
                    updateLayout();
                    if (gridWrapper.offsetWidth > 0) optimizeGrid(gridWrapper.offsetWidth, gridWrapper.offsetHeight);
                });
            }
        }

        async function handleFiles(files) {
            const uploaded = [];
            for (const file of files) {
                const body = new FormData();
                body.append("image", file);
                try {
                    const resp = await api.fetchApi("/upload/image", { method: "POST", body });
                    if (resp.status === 200) {
                        const data = await resp.json();
                        let name = data.name;
                        if (data.subfolder) name = data.subfolder + "/" + name;
                        uploaded.push(name);
                    }
                } catch (e) { console.error("Upload error", e); }
            }
            if (uploaded.length > 0) {
                const current = (pathsWidget?.value || "").trim();
                const allPaths = current ? current.split('\n').concat(uploaded) : uploaded;
                setWidgetValue(allPaths, false);
            }
        }

        const origOnDragDrop = node.onDragDrop;
        node.onDragDrop = function(e) {
            let handled = false;
            if (e.dataTransfer && e.dataTransfer.files) {
                const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
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
                const hasImage = Array.from(e.dataTransfer.items).some(f => f.kind === 'file' && f.type.startsWith('image/'));
                if (hasImage) {
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
        fileInput.onchange = (e) => handleFiles(e.target.files);
        
        container.ondragover = (e) => { 
            e.preventDefault(); 
            e.stopPropagation(); 
            container.style.borderColor = "#4CAF50"; 
        };
        container.ondragleave = (e) => { 
            e.preventDefault();
            e.stopPropagation(); 
            container.style.borderColor = "#353545"; 
        };
        container.ondrop = (e) => {
            e.preventDefault();
            e.stopPropagation(); 
            container.style.borderColor = "#353545";
            if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files);
        };

        const pasteHandler = (e) => {
            if (app.canvas.selected_nodes && app.canvas.selected_nodes[node.id]) {
                const items = e.clipboardData?.items;
                if (!items) return;

                const files = [];
                for (let i = 0; i < items.length; i++) {
                    if (items[i].kind === 'file' && items[i].type.startsWith('image/')) {
                        files.push(items[i].getAsFile());
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

        setTimeout(() => refreshGallery(), 100);
    }
});