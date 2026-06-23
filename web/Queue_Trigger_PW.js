import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";

// --- 全局状态存储：记录每个节点真实的 Index，彻底摆脱 LiteGraph 序列化坑 ---
window._pwTriggerStates = window._pwTriggerStates || {};

// --- 保留原有的工具函数 ---
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

// --- 【核心 1】：接收后端反馈，更新全局状态和 UI ---
function nodeFeedbackHandler(event) {
    const targetId = event.detail.node_id.toString(); // 强制转字符串，解决类型匹配 Bug
    const newValue = event.detail.value;

    // 1. 更新全局真实状态 (这是后续序列化的唯一真理来源)
    window._pwTriggerStates[targetId] = newValue;

    // 2. 遍历查找节点 (彻底抛弃 _nodes_by_id，杜绝找不到节点的问题)
    for (let node of app.graph._nodes) {
        if (node.id.toString() === targetId) {
            const w = node.widgets.find(w => w.name === "Index");
            if (w) {
                w.value = newValue; // 仅用于 UI 显示
                if (w.callback) w.callback(newValue, app.canvas, node);
                node.setDirtyCanvas(true, true);
            }
            break;
        }
    }
}

// --- 【核心 2】：归零函数 ---
function resetAllTriggerNodes() {
    for (let node of app.graph._nodes) {
        if (node.comfyClass === "Queue_Trigger_PW" || node.type === "Queue Trigger PW") {
            const nodeId = node.id.toString();
            window._pwTriggerStates[nodeId] = 0; // 归零全局状态
            const w = node.widgets.find(w => w.name === "Index");
            if (w) {
                w.value = 0;
                if (w.callback) w.callback(0, app.canvas, node);
                node.setDirtyCanvas(true, true);
            }
        }
    }
}

// --- 【核心 3】：序列化拦截器 (终极杀器) ---
function injectRealIndex() {
    for (let node of app.graph._nodes) {
        if (node.comfyClass === "Queue_Trigger_PW" || node.type === "Queue Trigger PW") {
            const nodeId = node.id.toString();
            const realIndex = window._pwTriggerStates[nodeId];
            
            // 强行将真实的 Index 塞进 ComfyUI 的序列化数组中
            if (realIndex !== undefined && node.widgets_values) {
                const w = node.widgets.find(w => w.name === "Index");
                if (w) {
                    const idx = node.widgets.indexOf(w);
                    if (idx !== -1) {
                        node.widgets_values[idx] = realIndex;
                    }
                }
            }
        }
    }
}

// --- 保存原始函数 ---
const originalQueuePrompt = app.queuePrompt.bind(app);

// --- 重写 app.queuePrompt (仅拦截用户手动点击 UI 按钮) ---
app.queuePrompt = async function(...args) {
    // 1. 手动触发，强制归零
    resetAllTriggerNodes();
    // 2. 注入真实值 (此时全是 0)
    injectRealIndex();
    // 3. 发送
    return originalQueuePrompt(...args);
};

// --- 自动队列指令 (绕过拦截器，不触发归零) ---
function addQueue(event) {
    // 1. 注入真实值 (此时是递增的 1, 2, 3...)
    injectRealIndex();
    // 2. 直接调用原始函数，完全绕过上面的归零逻辑！彻底杜绝死循环！
    if (typeof originalQueuePrompt === 'function') {
        originalQueuePrompt(); 
    }
}

// --- 监听中断和报错 ---
function handleInterruptOrError() {
    resetAllTriggerNodes();
}

// --- 注册扩展 (防重复绑定) ---
const ext = {
    name: "PWUtility.QueueTriggerPW",
    async setup() {
        api.removeEventListener("node-feedback", nodeFeedbackHandler);
        api.addEventListener("node-feedback", nodeFeedbackHandler);
        
        api.removeEventListener("add-queue", addQueue);
        api.addEventListener("add-queue", addQueue);
        
        api.removeEventListener("execution_interrupted", handleInterruptOrError);
        api.addEventListener("execution_interrupted", handleInterruptOrError);
        
        api.removeEventListener("execution_error", handleInterruptOrError);
        api.addEventListener("execution_error", handleInterruptOrError);
    }
};
app.registerExtension(ext);