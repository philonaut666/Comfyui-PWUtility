import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "PWUtility.QueueCountPW",
    async setup() {
        // 保存原始的 queuePrompt 方法
        const originalQueuePrompt = app.queuePrompt.bind(app);
        
        // 重写 queuePrompt 方法，拦截队列请求
        app.queuePrompt = async function(mode, batchCount = 1) {
            let queueCountNode = null;
            
            // 兼容不同版本的 LiteGraph 节点获取方式，查找工作流中的 Queue Count PW 节点
            if (app.graph && app.graph._nodes) {
                queueCountNode = app.graph._nodes.find(node => node.type === "QueueCountPW");
            } else if (app.graph && app.graph.nodes) {
                queueCountNode = app.graph.nodes.find(node => node.type === "QueueCountPW");
            }
            
            // 如果找到了节点，读取 total_count widget 的值
            if (queueCountNode && queueCountNode.widgets) {
                const totalCountWidget = queueCountNode.widgets.find(w => w.name === "total_count");
                
                // 如果值合法，则用节点的 total_count 覆盖默认的 batchCount
                if (totalCountWidget && typeof totalCountWidget.value === 'number' && totalCountWidget.value > 0) {
                    batchCount = totalCountWidget.value;
                    console.log(`[Queue Count PW] 动态设置 Queue Size 为: ${batchCount}`);
                }
            }
            
            // 调用原始的 queuePrompt，传入修改后的 batchCount
            return originalQueuePrompt(mode, batchCount);
        };
    }
});