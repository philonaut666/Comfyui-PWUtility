import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";

// --- 工具函数 ---
export function customAlert(message) {
    try { app.extensionManager.toast.addAlert(message); } catch { alert(message); }
}
export function isBeforeFrontendVersion(compareVersion) {
    try {
        const frontendVersion = window['COMFYUI_FRONTEND_VERSION'];
        if (typeof frontendVersion !== 'string') return false;
        function parseVersion(v) { const p = v.split('.').map(Number); return p.length === 3 && p.every(x => !isNaN(x)) ? p : null; }
        const c = parseVersion(frontendVersion), t = parseVersion(compareVersion);
        if (!c || !t) return false;
        for (let i = 0; i < 3; i++) { if (c[i] > t[i]) return false; else if (c[i] < t[i]) return true; }
        return false;
    } catch { return true; }
}
function dialog_show_wrapper(html) {
    if (typeof html === "string") {
        if(html.includes("IMPACT-PACK-SIGNAL: STOP CONTROL BRIDGE")) return;
        this.textElement.innerHTML = html;
    } else {
        this.textElement.replaceChildren(html);
    }
    this.element.style.display = "flex";
}
app.ui.dialog.show = dialog_show_wrapper;

// --- 【核心 1】：带详细日志的 Handler (兼容旧版带空格的节点) ---
function nodeFeedbackHandler(event) {
    const targetId = String(event.detail.node_id).trim();
    const targetWidgetName = String(event.detail.widget_name).trim();
    const newValue = event.detail.value;

    console.log(`[PW-Trigger] 📩 收到反馈 -> NodeID: ${targetId}, Widget: "${targetWidgetName}", 新值: ${newValue}`);

    let targetNode = null;
    for (let node of app.graph._nodes) {
        if (String(node.id).trim() === targetId) {
            targetNode = node;
            break;
        }
    }
    
    if (!targetNode) {
        console.error(`[PW-Trigger] ❌ 致命错误：在 Graph 中找不到 ID 为 ${targetId} 的节点！`);
        return;
    }

    let targetWidget = null;
    for (let w of targetNode.widgets) {
        if (String(w.name).trim() === targetWidgetName) {
            targetWidget = w;
            break;
        }
    }

    if (!targetWidget) {
        console.error(`[PW-Trigger] ❌ 致命错误：在节点 ${targetId} 中找不到名为 "${targetWidgetName}" 的 Widget！`);
        return;
    }

    targetWidget.value = newValue;
    if (targetWidget.callback) targetWidget.callback(newValue, app.canvas, targetNode);
    
    const idx = targetNode.widgets.indexOf(targetWidget);
    if (idx !== -1 && targetNode.widgets_values) targetNode.widgets_values[idx] = newValue;
    
    targetNode.setDirtyCanvas(true, true);
    console.log(`[PW-Trigger] ✅ 成功将 UI 上的 "${targetWidgetName}" 更新为 ${newValue}`);
}

// --- 归零函数 ---
function resetAllTriggerNodes() {
    for (let node of app.graph._nodes) {
        if (node.comfyClass === "Queue_Trigger_PW" || node.type === "Queue Trigger PW" || node.type === "flow_QueueTrigger") {
            for (let w of node.widgets) {
                if (String(w.name).trim() === "Index") {
                    w.value = 0;
                    if (w.callback) w.callback(0, app.canvas, node);
                    const idx = node.widgets.indexOf(w);
                    if (idx !== -1 && node.widgets_values) node.widgets_values[idx] = 0;
                    node.setDirtyCanvas(true, true);
                }
            }
        }
    }
}

// --- 拦截手动 Queue ---
const originalQueuePrompt = app.queuePrompt.bind(app);
app.queuePrompt = async function(...args) {
    console.log("[PW-Trigger] 🛑 拦截到手动 Queue，执行归零...");
    resetAllTriggerNodes();
    return originalQueuePrompt(...args);
};

// --- 【终极杀器】：序列化拦截器 (彻底解决底层忽略 w.value 的 Bug) ---
const originalGraphToPrompt = app.graphToPrompt.bind(app);
app.graphToPrompt = async function() {
    const res = await originalGraphToPrompt();
    const output = res.output;
    
    // 在数据包发出的最后一毫秒，强行注入真实的 Index 值！
    for (let node of app.graph._nodes) {
        if (node.comfyClass === "Queue_Trigger_PW" || node.type === "Queue Trigger PW" || node.type === "flow_QueueTrigger") {
            const nodeId = String(node.id);
            if (output[nodeId] && output[nodeId].inputs) {
                for (let w of node.widgets) {
                    if (String(w.name).trim() === "Index") {
                        output[nodeId].inputs["Index"] = w.value;
                        output[nodeId].inputs["Index "] = w.value; // 兼容旧版带空格的键
                        console.log(`[PW-Trigger] 🚀 序列化拦截器：强制注入 Node ${nodeId} 的 Index = ${w.value}`);
                    }
                }
            }
        }
    }
    return res;
};

// --- 自动 Queue ---
function addQueue(event) {
    console.log("[PW-Trigger] 🔄 收到 add-queue，触发自动队列...");
    if (typeof originalQueuePrompt === 'function') {
        originalQueuePrompt(); 
    }
}

// --- 中断/报错归零 ---
function handleInterruptOrError() {
    console.log("[PW-Trigger] ⚠️ 检测到中断或报错，执行归零...");
    resetAllTriggerNodes();
}

// --- 注册扩展 ---
const ext = {
    name: "PWUtility.QueueTriggerPW",
    async setup() {
        api.removeEventListener("node-feedback", nodeFeedbackHandler);
        api.removeEventListener("node-feedback ", nodeFeedbackHandler);
        api.addEventListener("node-feedback", nodeFeedbackHandler);
        api.addEventListener("node-feedback ", nodeFeedbackHandler);
        
        api.removeEventListener("add-queue", addQueue);
        api.removeEventListener("add-queue ", addQueue);
        api.addEventListener("add-queue", addQueue);
        api.addEventListener("add-queue ", addQueue);
        
        api.removeEventListener("execution_interrupted", handleInterruptOrError);
        api.addEventListener("execution_interrupted", handleInterruptOrError);
        
        api.removeEventListener("execution_error", handleInterruptOrError);
        api.addEventListener("execution_error", handleInterruptOrError);
    }
};
app.registerExtension(ext);