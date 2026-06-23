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

// --- 1. 接收后端反馈，更新 UI ---
function nodeFeedbackHandler(event) {
    const targetId = String(event.detail.node_id).trim();
    const targetWidgetName = String(event.detail.widget_name).trim();
    const newValue = event.detail.value;

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

// --- 2. 【终极极简】序列化拦截器 (只读取 UI 真实值并注入，绝不做归零判断！) ---
const originalGraphToPrompt = app.graphToPrompt.bind(app);
app.graphToPrompt = async function() {
    const res = await originalGraphToPrompt();
    const output = res.output;
    
    for (let node of app.graph._nodes) {
        if (node.comfyClass === "Queue_Trigger_PW" || node.type === "Queue Trigger PW") {
            const nodeId = String(node.id);
            if (output[nodeId] && output[nodeId].inputs) {
                for (let w of node.widgets) {
                    if (String(w.name).trim() === "Index") {
                        // 核心：永远只读取 UI 上当前的真实值！
                        // 无论 ComfyUI 后台调用多少次 graphToPrompt，它读取的都是当前 UI 上的真实状态
                        output[nodeId].inputs["Index"] = w.value;
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
    if (typeof app.queuePrompt === 'function') {
        app.queuePrompt(); 
    }
}

// --- 4. 监听中断和报错，强制将 UI 归零 ---
function handleInterruptOrError() {
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

// --- 注册扩展 ---
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