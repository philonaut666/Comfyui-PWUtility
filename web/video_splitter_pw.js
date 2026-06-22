import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "Comfy.VideoSplitterPW",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "VideoSplitterPW") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
                const node = this;

                const splitCountWidget = this.widgets.find(w => w.name === "split_count");
                const alignWidget = this.widgets.find(w => w.name === "align_8n_1");
                const splitFrontWidget = this.widgets.find(w => w.name === "split_front_point_idx");
                const splitBackWidget = this.widgets.find(w => w.name === "split_back_point_idx");

                function updateVisibility() {
                    const count = splitCountWidget ? splitCountWidget.value : 0;

                    // 控制 align_8n_1 的显隐
                    if (alignWidget) {
                        alignWidget.hidden = count < 1;
                        if (count < 1) {
                            alignWidget.type = "hidden";
                            alignWidget.computeSize = () => [0, -4];
                        } else {
                            alignWidget.type = "toggle"; // BOOLEAN 在 ComfyUI 中对应 toggle
                            delete alignWidget.computeSize;
                            alignWidget.label = "align_8n+1"; // 美化显示名称
                        }
                    }

                    // 控制 split_front_point_idx 的显隐
                    if (splitFrontWidget) {
                        splitFrontWidget.hidden = count < 1;
                        if (count < 1) {
                            splitFrontWidget.type = "hidden";
                            splitFrontWidget.computeSize = () => [0, -4];
                        } else {
                            splitFrontWidget.type = "INT";
                            delete splitFrontWidget.computeSize;
                        }
                    }

                    // 控制 split_back_point_idx 的显隐
                    if (splitBackWidget) {
                        splitBackWidget.hidden = count < 2;
                        if (count < 2) {
                            splitBackWidget.type = "hidden";
                            splitBackWidget.computeSize = () => [0, -4];
                        } else {
                            splitBackWidget.type = "INT";
                            delete splitBackWidget.computeSize;
                        }
                    }

                    if (node.computeSize) {
                        const minSize = node.computeSize();
                        node.size[0] = Math.max(node.size[0], minSize[0]);
                        node.size[1] = Math.max(node.size[1], minSize[1]);
                    }
                    app.graph.setDirtyCanvas(true, true);
                }

                if (splitCountWidget) {
                    const origCb = splitCountWidget.callback;
                    splitCountWidget.callback = function() {
                        if (origCb) origCb.apply(this, arguments);
                        updateVisibility();
                    };
                }

                setTimeout(updateVisibility, 100);
                return r;
            };
        }
    }
});