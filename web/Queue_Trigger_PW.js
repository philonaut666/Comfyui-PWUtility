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

// --- 【核心修复 1】：打破 ComfyUI 前端缓存的 Handler ---
function nodeFeedbackHandler(event) {
    let nodes = app.graph._nodes_by_id;
    let node = nodes[event.detail.node_id];
    if(node) {
        const w = node.widgets.find((w) => event.detail.widget_name === w.name);
        if(w) {
            w.value = event.detail.value;
            
            if (w.callback) {
                w.callback(w.value, app.canvas, node);
            }
            
            const widgetIndex = node.widgets.indexOf(w);
            if (widgetIndex !== -1) {
                if (!node.widgets_values) node.widgets_values = [];
                node.widgets_values[widgetIndex] = w.value;
            }
            
            node.setDirtyCanvas(true, true);
            // 【关键】：强制增加 graph 版本号，确保下次序列化时必定抓取最新值
            if(app.graph) {
                app.graph._version++;
            }
        }
    }
}
api.addEventListener("node-feedback", nodeFeedbackHandler);

// --- 【核心修复 2】：延迟触发 Queue，确保值已更新 ---
function addQueue(event) {
    // 【关键】：使用 setTimeout 确保 node-feedback 的值更新先生效，防止发送旧值给后端
    setTimeout(() => {
        if (typeof app.queuePrompt === 'function') {
            app.queuePrompt(); 
        }
    }, 100); // 延迟 100ms
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