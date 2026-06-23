import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";

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

// --- 提取公共的归零函数 ---
function resetAllTriggerNodes() {
    if (!app.graph || !app.graph._nodes) return;
    for (let node of app.graph._nodes) {
        if (node.comfyClass === "Queue_Trigger_PW" || node.type === "Queue Trigger PW") {
            const w = node.widgets.find(w => w.name === "Index");
            if (w && w.value !== 0) {
                w.value = 0;
                if (w.callback) w.callback(w.value, app.canvas, node);
                const widgetIndex = node.widgets.indexOf(w);
                if (widgetIndex !== -1 && node.widgets_values) {
                    node.widgets_values[widgetIndex] = w.value;
                }
                node.setDirtyCanvas(true, true);
            }
        }
    }
}

// --- 【核心修复】：恢复最稳妥的 _nodes_by_id 查找方式，确保 UI 能正确更新 ---
function nodeFeedbackHandler(event) {
    // 使用 _nodes_by_id 字典查找，避免 getNodeById 的类型匹配问题
    let nodes = app.graph._nodes_by_id;
    let node = nodes[event.detail.node_id];
    
    if(node) {
        const w = node.widgets.find((w) => event.detail.widget_name === w.name);
        if(w) {
            w.value = event.detail.value;
            
            // 触发 callback 通知 LiteGraph
            if (w.callback) {
                w.callback(w.value, app.canvas, node);
            }
            
            // 【关键】：同步更新 widgets_values，这是序列化发送给后端的核心数据！
            const widgetIndex = node.widgets.indexOf(w);
            if (widgetIndex !== -1 && node.widgets_values) {
                node.widgets_values[widgetIndex] = w.value;
            }
            
            // 标记脏数据，强制刷新 UI
            node.setDirtyCanvas(true, true);
        }
    }
}

// --- 保存原始函数并拦截手动触发 ---
const originalQueuePrompt = app.queuePrompt.bind(app);

// 重写 app.queuePrompt，仅用于拦截“用户手动点击 UI 按钮”
app.queuePrompt = async function(...args) {
    // 只要是通过 app.queuePrompt 调用的，一律视为手动触发，强制归零
    resetAllTriggerNodes();
    return originalQueuePrompt(...args);
};

// --- 自动队列指令（绕过拦截器，不触发归零） ---
function addQueue(event) {
    // 直接调用原始函数引用，完全绕过上面重写的 app.queuePrompt
    // 从而保证 Index 能够正常递增，不会陷入死循环。
    if (typeof originalQueuePrompt === 'function') {
        originalQueuePrompt(); 
    }
}

// --- 监听中断和报错事件，强制归零 ---
function handleInterruptOrError() {
    resetAllTriggerNodes();
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

// --- 使用 setup 钩子防止事件重复绑定 ---
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

        api.removeEventListener("value-send", valueSendHandler);
        api.addEventListener("value-send", valueSendHandler);
    },
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "Queue Trigger PW") {
            // 节点特定前端逻辑预留
        }
    }
};
app.registerExtension(ext);