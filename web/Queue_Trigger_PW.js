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
        const parse = (v) => { const p = v.split('.').map(Number); return p.length === 3 && p.every(n => !isNaN(n)) ? p : null; };
        const c = parse(frontendVersion), t = parse(compareVersion);
        if (!c || !t) return false;
        for (let i = 0; i < 3; i++) { if (c[i] > t[i]) return false; if (c[i] < t[i]) return true; }
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

// --- 【核心辅助】：强制将所有 Queue Trigger PW 节点的 Index 重置为 0 ---
function resetIndexToZero() {
    let nodes = app.graph._nodes;
    for(let node of nodes) {
        if(node.type === "Queue Trigger PW" || node.comfyClass === "Queue Trigger PW") {
            const w = node.widgets.find((w) => w.name === "Index");
            if(w && w.value !== 0) {
                w.value = 0;
                if (w.callback) w.callback(w.value, app.canvas, node);
                const widgetIndex = node.widgets.indexOf(w);
                if (widgetIndex !== -1 && node.widgets_values) node.widgets_values[widgetIndex] = w.value;
                node.setDirtyCanvas(true, true);
            }
        }
    }
}

// --- 【核心机制 1】：拦截 ComfyUI 的主运行按钮 ---
if (!window._pw_queue_prompt_patched) {
    window._pw_queue_prompt_patched = true;
    const originalQueuePrompt = app.queuePrompt ? app.queuePrompt.bind(app) : async () => {};
    app.queuePrompt = async function(number = 0, batchSize = 1, ...args) {
        if (!window._pw_auto_queue_flag) {
            resetIndexToZero(); 
        } else {
            window._pw_auto_queue_flag = false; 
        }
        return await originalQueuePrompt(number, batchSize, ...args);
    };
}

// --- 【核心机制 2】：处理后端发来的反馈和自动队列请求 ---
function nodeFeedbackHandler(event) {
    let nodes = app.graph._nodes_by_id;
    let node = nodes[event.detail.node_id];
    if(node) {
        const w = node.widgets.find((w) => event.detail.widget_name === w.name);
        if(w) {
            w.value = event.detail.value;
            if (w.callback) w.callback(w.value, app.canvas, node);
            const widgetIndex = node.widgets.indexOf(w);
            if (widgetIndex !== -1 && node.widgets_values) node.widgets_values[widgetIndex] = w.value;
            node.setDirtyCanvas(true, true);
        }
    }
}

function addQueue(event) {
    window._pw_auto_queue_flag = true;
    // 【核心修复 2】：强制传入 (0, 1)，锁定 Batch Size 为 1，防止因界面设置导致倍数执行
    if (typeof app.queuePrompt === 'function') {
        app.queuePrompt(0, 1); 
    }
}

// 【核心修复 3】：使用全局标志位防止事件监听器被重复注册
if (!window._pw_queue_trigger_listeners_registered) {
    window._pw_queue_trigger_listeners_registered = true;
    api.addEventListener("node-feedback", nodeFeedbackHandler);
    api.addEventListener("add-queue", addQueue);
    
    // 监听中途停止和报错，确保安全归零
    api.addEventListener("execution_interrupted", resetIndexToZero);
    api.addEventListener("execution_error", resetIndexToZero);
}

// --- 保留原有的 valueSendHandler ---
function valueSendHandler(event) {
    let nodes = app.graph._nodes;
    for(let i in nodes) {
        if(nodes[i].type == 'flow_ValueReceiver') {
            if(nodes[i].widgets[2].value == event.detail.link_id) {
                nodes[i].widgets[1].value = event.detail.value;
                let typ = typeof event.detail.value;
                if(typ == 'string') nodes[i].widgets[0].value = "STRING";
                else if(typ == "boolean") nodes[i].widgets[0].value = "BOOLEAN";
                else if(typ != "number") nodes[i].widgets[0].value = typeof event.detail.value;
                else if(Number.isInteger(event.detail.value)) nodes[i].widgets[0].value = "INT";
                else nodes[i].widgets[0].value = "FLOAT";
            }
        }
    }
}
if (!window._pw_value_send_registered) {
    window._pw_value_send_registered = true;
    api.addEventListener("value-send", valueSendHandler);
}

// --- 注册扩展 ---
const ext = {
    name: "PWUtility.QueueTriggerPW",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "Queue Trigger PW") {
            // 节点特定前端逻辑
        }
    }
};
app.registerExtension(ext);