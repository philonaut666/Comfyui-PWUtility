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
                
                // 1. 找到 update_trigger 并在 UI 上将其隐藏
                const triggerWidget = this.widgets.find(w => w.name === "update_trigger");
                if (triggerWidget) {
                    triggerWidget.hidden = true;
                    triggerWidget.type = "hidden";
                    // 覆盖尺寸计算方法，使其在节点上不占任何高度
                    triggerWidget.computeSize = function() { return [0, -4]; };
                }

                // 2. 添加 Update from Input 按钮
                const widget = this.addWidget("button", "Update from Input", null, () => {
                    if (triggerWidget) {
                        triggerWidget.value = (triggerWidget.value || 0) + 1;
                        // 核心修复：强制触发 callback，确保 ComfyUI 前端感知到值的变化并收集它
                        if (triggerWidget.callback) {
                            triggerWidget.callback(triggerWidget.value);
                        }
                    }
                    
                    const nodeIdStr = String(this.id);
                    try {
                        if (typeof app.queuePrompt === 'function') {
                            // 局部执行：只运行当前节点及上游依赖，严格只执行 1 次
                            app.queuePrompt(0, 1, [nodeIdStr]);
                        } else if (app.api && typeof app.api.queuePrompt === 'function') {
                            app.api.queuePrompt(0, 1, [nodeIdStr]);
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