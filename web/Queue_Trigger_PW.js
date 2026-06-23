import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";

// --- 全局状态管理 ---
window._pwTriggerStates = window._pwTriggerStates || {};
window._isPWAutoQueue = false; // 核心标志位：区分手动还是自动

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

// --- 1. 接收后端反馈，更新全局状态和 UI ---
function nodeFeedbackHandler(event) {
    const targetId = String(event.detail.node_id).trim();
    const targetWidgetName = String(event.detail.widget_name).trim();
    const newValue = event.detail.value;

    // 更新全局真实状态
    window._pwTriggerStates[targetId] = newValue;

    // 更新 UI
    for (let node of app.graph._nodes) {
        if (String(node.id).trim() === targetId) {
            for (let w of node.widgets) {
                if (String(w.name).trim() === targetWidgetName) {
                    w.value = newValue;
                    if (w.callback) w.callback(newValue, app.canvas, node);
                    const idx = node.widgets.indexOf(w);
                    if (idx !== -1 && node.widgets_values) node.widgets_values[idx] = newValue;
                    node.setDirtyCanvas(true, true);
                    break;
                }
            }
            break;
        }
    }
}

// --- 2. 【终极杀器】：序列化拦截器 (在数据包发出的最后一毫秒注入真实值) ---
const originalGraphToPrompt = app.graphToPrompt.bind(app);
app.graphToPrompt = async function() {
    const res = await originalGraphToPrompt();
    const output = res.output;
    
    for (let node of app.graph._nodes) {
        if (node.comfyClass === "Queue_Trigger_PW" || node.type === "Queue Trigger PW") {
            const nodeId = String(node.id);
            if (output[nodeId] && output[nodeId].inputs) {
                
                let injectValue = 0;
                
                if (window._isPWAutoQueue) {
                    // 【自动触发】：使用全局状态中的真实值 (1, 2, 3...)
                    injectValue = window._pwTriggerStates[nodeId] !== undefined ? window._pwTriggerStates[nodeId] : 0;
                    // 重置标志位，为下一次手动点击做准备
                    window._isPWAutoQueue = false; 
                    console.log(`[PW-Trigger] 🚀 自动循环：注入 Node ${nodeId} 的 Index = ${injectValue}`);
                } else {
                    // 【手动触发】：强制归零，并更新全局状态
                    injectValue = 0;
                    window._pwTriggerStates[nodeId] = 0;
                    console.log(`[PW-Trigger] 🛑 手动触发：强制归零 Node ${nodeId} 的 Index = 0`);
                }
                
                // 强行注入到发给后端的 JSON 数据包中
                output[nodeId].inputs["Index"] = injectValue;
                
                // 同步更新 UI，防止显示不一致
                for (let w of node.widgets) {
                    if (String(w.name).trim() === "Index") {
                        w.value = injectValue;
                        if (w.callback) w.callback(injectValue, app.canvas, node);
                        const idx = node.widgets.indexOf(w);
                        if (idx !== -1 && node.widgets_values) node.widgets_values[idx] = injectValue;
                        node.setDirtyCanvas(true, true);
                        break;
                    }
                }
            }
        }
    }
    return res;
};

// --- 3. 自动队列指令 ---
function addQueue(event) {
    // 标记为自动触发
    window._isPWAutoQueue = true;
    // 直接调用原生的 queuePrompt，不经过任何拦截！
    if (typeof app.queuePrompt === 'function') {
        app.queuePrompt(); 
    }
}

// --- 4. 监听中断和报错，强制归零 ---
function handleInterruptOrError() {
    console.log("[PW-Trigger] ⚠️ 检测到中断或报错，全局归零...");
    for (let key in window._pwTriggerStates) {
        window._pwTriggerStates[key] = 0;
    }
    // 同步 UI
    for (let node of app.graph._nodes) {
        if (node.comfyClass === "Queue_Trigger_PW" || node.type === "Queue Trigger PW") {
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