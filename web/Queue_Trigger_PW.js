import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";

// --- 保留原有的工具函数 ---
export function customAlert(message) {
    try {
        app.extensionManager.toast.addAlert(message);
    } catch {
        alert(message);
    }
}

export function isBeforeFrontendVersion(compareVersion) {
    try {
        const frontendVersion = window['COMFYUI_FRONTEND_VERSION'];
        if (typeof frontendVersion !== 'string') return false;
        function parseVersion(versionString) {
            const parts = versionString.split('.').map(Number);
            return parts.length === 3 && parts.every(part => !isNaN(part)) ? parts : null;
        }
        const currentVersion = parseVersion(frontendVersion);
        const comparisonVersion = parseVersion(compareVersion);
        if (!currentVersion || !comparisonVersion) return false;
        for (let i = 0; i < 3; i++) {
            if (currentVersion[i] > comparisonVersion[i]) return false;
            else if (currentVersion[i] < comparisonVersion[i]) return true;
        }
        return false;
    } catch {
        return true;
    }
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
    let nodes = app.graph._nodes_by_id;
    let node = nodes[event.detail.node_id];
    if(node) {
        const w = node.widgets.find((w) => event.detail.widget_name === w.name);
        if(w) {
            w.value = event.detail.value;
            
            // 1. 触发 widget 的 callback，通知 LiteGraph 值已改变
            if (w.callback) {
                w.callback(w.value, app.canvas, node);
            }
            
            // 2. 同步更新 widgets_values，确保序列化发送给后端时包含新值
            const widgetIndex = node.widgets.indexOf(w);
            if (widgetIndex !== -1 && node.widgets_values) {
                node.widgets_values[widgetIndex] = w.value;
            }
            
            // 3. 标记节点为脏，强制刷新 UI 并打破 ComfyUI 的执行缓存
            node.setDirtyCanvas(true, true);
        }
    }
}
api.addEventListener("node-feedback", nodeFeedbackHandler);

function addQueue(event) {
    if (typeof app.queuePrompt === 'function') {
        app.queuePrompt(); 
    }
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