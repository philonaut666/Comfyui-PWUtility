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

// --- 【核心辅助】：强制更新 Widget 值并确保 ComfyUI 序列化时能读到 ---
function setWidgetValue(node, widgetName, value) {
    const w = node.widgets.find(w => w.name === widgetName);
    if (w) {
        w.value = value;
        // 1. 触发 LiteGraph 的回调
        if (w.callback) w.callback(value, app.canvas, node, app.canvas.graph_mouse);
        
        // 2. 强制更新 widgets_values (序列化时读取)
        const idx = node.widgets.indexOf(w);
        if (idx !== -1 && node.widgets_values) node.widgets_values[idx] = value;
        
        // 3. 强制更新 DOM 元素 (防止 UI 显示不一致)
        if (w.inputEl) {
            w.inputEl.value = value;
            w.inputEl.dispatchEvent(new Event('input'));
            w.inputEl.dispatchEvent(new Event('change'));
        }
        
        // 4. 标记节点脏，强制刷新
        node.setDirtyCanvas(true, true);
    }
}

function resetAllIndexes() {
    let nodes = app.graph._nodes;
    for(let node of nodes) {
        if(node.type === "Queue Trigger PW" || node.comfyClass === "Queue Trigger PW") {
            setWidgetValue(node, "Index", 0);
        }
    }
}

// --- 全局状态管理 ---
window._pw_queue_state = {
    isRunning: false,
    currentIndex: 0,
    total: 4,
    nodeId: null
};

// --- 【核心机制 1】：拦截手动 Run 按钮 ---
if (!window._pw_queue_prompt_patched) {
    window._pw_queue_prompt_patched = true;
    const originalQueuePrompt = app.queuePrompt ? app.queuePrompt.bind(app) : async () => {};
    app.queuePrompt = async function(number = 0, batchCount = 1, ...args) {
        // 如果没有自动运行标记，说明是用户手动点击了 Run 按钮！
        if (!window._pw_auto_queue_flag) {
            let nodes = app.graph._nodes;
            for(let node of nodes) {
                if(node.type === "Queue Trigger PW" || node.comfyClass === "Queue Trigger PW") {
                    const wMode = node.widgets.find(w => w.name === "mode");
                    // 只有当 mode 为 True 时才启动循环
                    if (wMode && wMode.value === true) {
                        setWidgetValue(node, "Index", 0);
                        window._pw_queue_state.isRunning = true;
                        window._pw_queue_state.currentIndex = 0;
                        const wTotal = node.widgets.find(w => w.name === "total");
                        window._pw_queue_state.total = wTotal ? wTotal.value : 4;
                        window._pw_queue_state.nodeId = node.id;
                        break; // 只处理第一个找到的节点
                    }
                }
            }
        } else {
            window._pw_auto_queue_flag = false; // 消耗掉标记
        }
        return await originalQueuePrompt(number, batchCount, ...args);
    };
}

// --- 【核心机制 2】：监听节点执行完成事件 (严格串行控制) ---
if (!window._pw_executed_listener_registered) {
    window._pw_executed_listener_registered = true;
    
    // 监听 ComfyUI 的 executed 事件 (每当一个节点执行完毕时触发)
    api.addEventListener("executed", (event) => {
        if (window._pw_queue_state.isRunning && event.detail && String(event.detail.node) === String(window._pw_queue_state.nodeId)) {
            // 我们的节点执行完了！
            let nextIndex = window._pw_queue_state.currentIndex + 1;
            
            if (nextIndex < window._pw_queue_state.total) {
                // 还需要继续运行
                window._pw_queue_state.currentIndex = nextIndex;
                let node = app.graph.getNodeById(window._pw_queue_state.nodeId);
                if (node) {
                    // 强制更新 Index 值
                    setWidgetValue(node, "Index", nextIndex);
                }
                
                // 延迟 100ms 再触发下一次，确保 ComfyUI 内部状态清理完毕，防止队列堆积
                setTimeout(() => {
                    window._pw_auto_queue_flag = true;
                    if (typeof app.queuePrompt === 'function') {
                        // 强制锁定 batchCount = 1，彻底解决执行 7 次的问题
                        app.queuePrompt(0, 1); 
                    }
                }, 100);
            } else {
                // 运行完毕，重置状态并归零
                window._pw_queue_state.isRunning = false;
                let node = app.graph.getNodeById(window._pw_queue_state.nodeId);
                if (node) {
                    setWidgetValue(node, "Index", 0);
                }
            }
        }
    });

    // 监听中途停止和报错，确保安全归零
    api.addEventListener("execution_interrupted", () => {
        window._pw_queue_state.isRunning = false;
        resetAllIndexes();
    });

    api.addEventListener("execution_error", () => {
        window._pw_queue_state.isRunning = false;
        resetAllIndexes();
    });
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