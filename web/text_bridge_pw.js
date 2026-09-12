import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

app.registerExtension({
    name: "PWUtility.TextBridge",
    async setup() {
        api.addEventListener("pw_text_bridge_processed", function (event) {
            const nodeId = parseInt(event.detail.node);
            const widgetName = event.detail.widget;
            const text = event.detail.text;
            
            const node = app.graph?.getNodeById(nodeId);
            if (!node) return;
            
            const widget = node.widgets?.find(w => w.name === widgetName);
            if (!widget) return;
            
            widget.value = text;
            node.setDirtyCanvas(true, true);
        });
    },
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "Text Bridge PW") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
                
                const triggerWidget = this.widgets.find(w => w.name === "update_trigger");
                if (triggerWidget) {
                    // 核心修复：只设置 hidden 和 computeSize
                    // 不要修改 triggerWidget.type！
                    // 之前设置 type = "hidden" 导致前端序列化时跳过该参数
                    triggerWidget.hidden = true;
                    triggerWidget.computeSize = function() { return [0, -4]; };
                }

                const widget = this.addWidget("button", "Update from Input", null, () => {
                    if (triggerWidget) {
                        triggerWidget.value = (triggerWidget.value || 0) + 1;
                        if (triggerWidget.callback) {
                            triggerWidget.callback(triggerWidget.value);
                        }
                    }
                    
                    const nodeIdStr = String(this.id);
                    try {
                        if (typeof app.queuePrompt === 'function') {
                            app.queuePrompt(0, 1, [nodeIdStr]);
                        }
                    } catch (e) {
                        console.error("PWUtility: Failed to queue prompt", e);
                    }
                }, { serialize: false });
                
                this.size[1] = Math.max(this.size[1], 120);
                return r;
            };
        }
    }
});