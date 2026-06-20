import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "Comfy.VideoSplitterPW",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "VideoSplitterPW") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
                const node = this;

                // 获取对应的 Widget 控件 (已更新为最新的 _idx 后缀)
                const splitCountWidget = this.widgets.find(w => w.name === "split_count");
                const splitFrontWidget = this.widgets.find(w => w.name === "split_front_point_idx");
                const splitBackWidget = this.widgets.find(w => w.name === "split_back_point_idx");

                function updateVisibility() {
                    const count = splitCountWidget ? splitCountWidget.value : 0;

                    // 控制 split_front_point_idx 的显隐 (count < 1 即 count == 0 时隐藏)
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

                    // 控制 split_back_point_idx 的显隐 (count < 2 即 count == 0 或 1 时隐藏)
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

                    // 重新计算节点尺寸，自适应高度
                    if (node.computeSize) {
                        const minSize = node.computeSize();
                        node.size[0] = Math.max(node.size[0], minSize[0]);
                        node.size[1] = Math.max(node.size[1], minSize[1]);
                    }
                    app.graph.setDirtyCanvas(true, true);
                }

                // 监听 split_count 的变化
                if (splitCountWidget) {
                    const origCb = splitCountWidget.callback;
                    splitCountWidget.callback = function() {
                        if (origCb) origCb.apply(this, arguments);
                        updateVisibility();
                    };
                }

                // 节点创建时初始化一次可见性
                setTimeout(updateVisibility, 100);
                return r;
            };
        }
    }
});