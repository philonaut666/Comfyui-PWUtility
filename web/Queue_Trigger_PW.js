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

// --- 【核心修复】：打破 ComfyUI 执行缓存的 Handler ---
function nodeFeedbackHandler(event) {
    let node = app.graph.getNodeById(event.detail.node_id);
    if(node) {
        const w = node.widgets.find((w) => event.detail.widget_name === w.name);
        if(w) {
            w.value = event.detail.value;
            if (w.callback) w.callback(w.value, app.canvas, node);
            const widgetIndex = node.widgets.indexOf(w);
            if (widgetIndex !== -1 && node.widgets_values) {
                node.widgets_values[widgetIndex] = w.value;
            }
            node.setDirtyCanvas(true, true);
        }
    }
}
api.addEventListener("node-feedback", nodeFeedbackHandler);

// --- 【新增核心功能】：拦截 QueuePrompt 实现手动归零 ---
const originalQueuePrompt = app.queuePrompt;
window._isPWAutoQueue = false; // 全局标志位

app.queuePrompt = async function(...args) {
    // 如果不是自动触发的队列（即用户手动点击 Queue 按钮），则强制归零
    if (!window._isPWAutoQueue) {
        for (let node of app.graph._nodes) {
            // 匹配节点类名
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
    return originalQueuePrompt.apply(this, args);
};

function addQueue(event) {
    // 标记为自动触发，防止归零逻辑生效
    window._isPWAutoQueue = true; 
    if (typeof originalQueuePrompt === 'function') {
        originalQueuePrompt(); 
    }
    // 异步重置标志位
    setTimeout(() => {
        window._isPWAutoQueue = false;
    }, 100);
}
api.addEventListener("add-queue", addQueue);

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
api.addEventListener("value-send", valueSendHandler);

// --- 注册扩展 ---
const ext = {
    name: "PWUtility.QueueTriggerPW",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "Queue Trigger PW") {
            // 可在此处添加节点特定的前端逻辑
        }
    }
};
app.registerExtension(ext);