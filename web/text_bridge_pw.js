import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

app.registerExtension({
    name: "PWUtility.TextBridge",
    async setup() {
        // 监听后端发来的 WebSocket 消息，动态更新文本框的值
        api.addEventListener("pw_text_bridge_processed", function (event) {
            const nodeId = parseInt(event.detail.node);
            const widgetName = event.detail.widget;
            const text = event.detail.text;
            const node = app.graph.nodes.find(n => n.id === nodeId);
            if (!node) return;
            
            const widget = node.widgets.find(w => w.name === widgetName);
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
                
                // 添加 Update from Input 按钮
                const widget = this.addWidget("button", "Update from Input", null, () => {
                    // 1. 增加隐藏 trigger 值，使 ComfyUI 认为节点输入已改变，从而强制执行
                    const triggerWidget = this.widgets.find(w => w.name === "update_trigger");
                    if (triggerWidget) {
                        triggerWidget.value = (triggerWidget.value || 0) + 1;
                    }
                    
                    // 2. 触发局部执行 (Execute to selected output node)
                    // 兼容新旧版本 ComfyUI 前端 API
                    const output_nodes = [this.id];
                    if (typeof app.queuePrompt === 'function') {
                        try {
                            app.queuePrompt(0, output_nodes);
                        } catch (e) {
                            app.queuePrompt(0); // Fallback
                        }
                    } else if (app.api && typeof app.api.queuePrompt === 'function') {
                        app.api.queuePrompt(0, output_nodes);
                    }
                }, { serialize: false });
                
                // 调整节点高度以容纳按钮
                this.size[1] = Math.max(this.size[1], 120);
                
                return r;
            };
        }
    }
});