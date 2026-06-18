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
                const splitFrontWidget = this.widgets.find(w => w.name === "split_front_point_frame");
                const splitBackWidget = this.widgets.find(w => w.name === "split_back_point_frame");
                
                function updateVisibility() {
                    const count = splitCountWidget ? splitCountWidget.value : 0;
                    
                    if (splitFrontWidget) {
                        splitFrontWidget.hidden = count < 1;
                        if (count < 1) { splitFrontWidget.type = "hidden"; splitFrontWidget.computeSize = () => [0, -4]; }
                        else { splitFrontWidget.type = "INT"; delete splitFrontWidget.computeSize; }
                    }
                    if (splitBackWidget) {
                        splitBackWidget.hidden = count < 2;
                        if (count < 2) { splitBackWidget.type = "hidden"; splitBackWidget.computeSize = () => [0, -4]; }
                        else { splitBackWidget.type = "INT"; delete splitBackWidget.computeSize; }
                    }
                    
                    const minSize = node.computeSize();
                    node.size[0] = Math.max(node.size[0], minSize[0]);
                    node.size[1] = Math.max(node.size[1], minSize[1]);
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