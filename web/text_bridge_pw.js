import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "PWUtility.TextBridgePW.Button",
    async nodeCreated(node) {
        // 识别我们的新节点
        if (node.comfyClass === "Text Bridge PW") {
            
            // 强行添加一个 "Update" 按钮
            const btn = node.addWidget("button", "Update (获取最新输入)", "update", () => {
                // 1. 找到 Python 端定义的 force_update 开关
                const forceWidget = node.widgets.find(w => w.name === "force_update");
                
                if (forceWidget) {
                    // 2. 将开关设为 True (开启强制更新模式)
                    forceWidget.value = true;
                    node.setDirtyCanvas(true, true); // 刷新节点UI
                    
                    // 3. 自动触发一次 Queue Prompt (运行工作流)
                    app.queuePrompt(0, 1).then(() => {
                        // 4. 运行结束后，自动将开关复位为 False
                        setTimeout(() => {
                            forceWidget.value = false;
                            node.setDirtyCanvas(true, true);
                        }, 500); // 延迟500ms确保后端已经处理完毕
                    }).catch(err => {
                        console.error("自动运行失败:", err);
                        forceWidget.value = false;
                        node.setDirtyCanvas(true, true);
                    });
                }
            });
            
            // 可选：调整按钮颜色使其更醒目
            if(btn.options) {
                btn.options.color = "#2a363b";
                btn.options.textColor = "#ffffff";
            }
        }
    }
});