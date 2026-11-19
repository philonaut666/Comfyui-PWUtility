import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "Comfy.MediaResizePW",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "MediaResizePW") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
            const node = this;

            const scaleModeWidget = node.widgets.find(w => w.name === "scale_mode");
            const widthWidget = node.widgets.find(w => w.name === "width");
            const heightWidget = node.widgets.find(w => w.name === "height");
            const longerWidget = node.widgets.find(w => w.name === "longer_size");
            const shorterWidget = node.widgets.find(w => w.name === "shorter_size");
            const interpolationWidget = node.widgets.find(w => w.name === "interpolation");
            const resizeMethodWidget = node.widgets.find(w => w.name === "resize_method");
            const padColorWidget = node.widgets.find(w => w.name === "pad_color");
            const cropPositionWidget = node.widgets.find(w => w.name === "crop_position");
            const multipleOfWidget = node.widgets.find(w => w.name === "multiple_of");

            // 标准隐藏方式（与修复后的 ImageLoaderPW 一致）：type="hidden" + computeSize [0,-4]
            const setHidden = (widget, isHidden) => {
                if (!widget) return;
                if (widget.__pwOrigType === undefined) {
                    widget.__pwOrigType = widget.type;
                    widget.__pwOrigComputeSize = widget.computeSize;
                }
                if (isHidden) {
                    widget.type = "hidden";
                    widget.hidden = true;
                    widget.computeSize = () => [0, -4];
                } else {
                    widget.type = widget.__pwOrigType;
                    widget.hidden = false;
                    if (widget.__pwOrigComputeSize) {
                        widget.computeSize = widget.__pwOrigComputeSize;
                    } else {
                        delete widget.computeSize;
                    }
                }
                if (widget.element) {
                    widget.element.style.display = isHidden ? "none" : "";
                }
            };

            // 显隐条件与 ImageLoaderPW.updateResizeWidgetsVisibility 完全一致
            function updateVisibility() {
                const mode = scaleModeWidget ? scaleModeWidget.value : "none";
                const rMode = resizeMethodWidget ? resizeMethodWidget.value : "keep proportion";
                const isNone = mode === "none";

                setHidden(widthWidget, isNone || mode !== "scale dimensions");
                setHidden(heightWidget, isNone || mode !== "scale dimensions");
                setHidden(longerWidget, isNone || mode !== "scale longer");
                setHidden(shorterWidget, isNone || mode !== "scale shorter");
                setHidden(interpolationWidget, isNone);
                setHidden(resizeMethodWidget, isNone);
                setHidden(multipleOfWidget, isNone);
                setHidden(padColorWidget, isNone || rMode !== "pad");
                setHidden(cropPositionWidget, isNone || rMode !== "crop");
                // img_compression 与 video 始终显示

                if (node.graph) node.graph.setDirtyCanvas(true, true);
            }

            if (scaleModeWidget) {
                const orig = scaleModeWidget.callback;
                scaleModeWidget.callback = function (v) {
                    if (orig) orig.apply(this, [v]);
                    updateVisibility();
                };
            }
            if (resizeMethodWidget) {
                const orig = resizeMethodWidget.callback;
                resizeMethodWidget.callback = function (v) {
                    if (orig) orig.apply(this, [v]);
                    updateVisibility();
                };
            }

            updateVisibility();
            const visInterval = setInterval(updateVisibility, 100);
            setTimeout(() => clearInterval(visInterval), 2000);

            return r;
        };
    }
});