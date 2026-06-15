import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const NODE_NAME = "BoolGroupSwitch";
const MAX_GROUP_SLOTS = 12;
const NONE_OPTION = "<none>";
const ACTION_VALUES = ["active", "mute", "bypass"];

function getWidget(node, name) {
    return (node.widgets || []).find((w) => w.name === name);
}

function getWidgetByLabel(node, label) {
    return (node.widgets || []).find((w) => String(w?.name || w?.label || "") === label);
}

function getSlotPair(node, index) {
    const slots = node.__vrgdgSlotWidgets || {};
    return slots[index] || null;
}

function setWidgetVisible(widget, visible) {
    if (!widget) return;
    if (!Object.prototype.hasOwnProperty.call(widget, "__vrgdgOriginalType")) {
        widget.__vrgdgOriginalType = widget.type;
        widget.__vrgdgOriginalComputeSize = widget.computeSize;
    }
    if (visible) {
        widget.type = widget.__vrgdgOriginalType;
        widget.hidden = false;
        if (widget.__vrgdgOriginalComputeSize) {
            widget.computeSize = widget.__vrgdgOriginalComputeSize;
        } else {
            delete widget.computeSize;
        }
    } else {
        widget.type = "hidden";
        widget.hidden = true;
        widget.computeSize = () => [0, -4];
    }
}

function toArrayMaybe(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    try { if (typeof value.values === "function") return Array.from(value.values()); } catch (e) {}
    try { if (typeof value[Symbol.iterator] === "function") return Array.from(value); } catch (e) {}
    if (typeof value === "object") { try { return Object.values(value); } catch (e) {} }
    return [];
}

function collectGroupsFromGraph(graph) {
    if (!graph) return [];
    const groups = [];
    const seen = new Set();
    const pushGroups = (arr, ownerGraph) => {
        if (!Array.isArray(arr)) return;
        for (const g of arr) {
            if (!g) continue;
            const key = `${g.id ?? ""}|${String(g.title ?? "")}|${JSON.stringify(g._bounding ?? g.bounding ?? [])}`;
            if (seen.has(key)) continue;
            seen.add(key);
            try { g.__vrgdgOwnerGraph = ownerGraph || g.__vrgdgOwnerGraph || graph; } catch (e) {}
            groups.push(g);
        }
    };
    pushGroups(toArrayMaybe(graph._groups), graph);
    pushGroups(toArrayMaybe(graph.groups), graph);
    const subgraphs = graph.subgraphs?.values?.();
    if (subgraphs) {
        let sg;
        while ((sg = subgraphs.next().value)) {
            pushGroups(toArrayMaybe(sg._groups), sg);
            pushGroups(toArrayMaybe(sg.groups), sg);
        }
    }
    return groups;
}

function getGroupsSortedAlpha(node) {
    const groups = [];
    const seen = new Set();
    const candidateGraphs = [node?.graph, app?.canvas?.getCurrentGraph?.(), app?.canvas?.graph, app?.graph].filter(Boolean);
    for (const graph of candidateGraphs) {
        for (const g of collectGroupsFromGraph(graph)) {
            const key = `${g?.id ?? ""}|${String(g?.title ?? "")}|${JSON.stringify(g?._bounding ?? g?.bounding ?? [])}`;
            if (seen.has(key)) continue;
            seen.add(key);
            groups.push(g);
        }
    }
    groups.sort((a, b) => String(a?.title || "").localeCompare(String(b?.title || "")));
    return groups;
}

function getNodesInGroupGlobal(group) {
    if (!group || !app.graph) return [];
    try { if (typeof group.recomputeInsideNodes === "function") group.recomputeInsideNodes(); } catch (e) {}
    return Array.from(group._children || []).filter((c) => c instanceof LGraphNode);
}

function reduceNodesDepthFirst(nodeOrNodes, reduceFn, reduceTo) {
    const nodes = Array.isArray(nodeOrNodes) ? nodeOrNodes : [nodeOrNodes];
    const stack = nodes.map((node) => ({ node }));
    while (stack.length > 0) {
        const { node } = stack.pop();
        const result = reduceFn(node, reduceTo);
        if (result !== undefined && result !== reduceTo) reduceTo = result;
        if (node.isSubgraphNode?.() && node.subgraph) {
            const children = node.subgraph.nodes;
            for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i] });
        }
    }
    return reduceTo;
}

function changeModeOfNodes(nodeOrNodes, mode) {
    reduceNodesDepthFirst(nodeOrNodes, (n) => { n.mode = mode; });
}

// ================= 全局防死锁与分阶段执行 (Multi-pass) 逻辑 =================
let __bgsIsApplyingStates = false;
let executedNodesInCurrentPrompt = new Set();
let pendingInterrupts = new Set();
let isInterrupting = false;

function triggerInterruptAndRerun(nodeId) {
    if (isInterrupting) return;
    isInterrupting = true;
    pendingInterrupts.clear();
    console.log(`[BoolGroupSwitch] 🛑 第一次运行：Node ${nodeId} 执行完毕，打断并重跑...`);
    api.interrupt();
    setTimeout(() => {
        console.log(`[BoolGroupSwitch] 🔄 开启第二次运行...`);
        if (typeof app.queuePrompt === "function") {
            app.queuePrompt(0, 1).catch(e => console.warn("Queue prompt failed:", e));
        } else {
            const queueBtn = document.querySelector('.comfy-queue-btn');
            if (queueBtn) queueBtn.click();
        }
    }, 1000); 
}

async function applyNodeModesEvent(event) {
    if (__bgsIsApplyingStates) return;
    __bgsIsApplyingStates = true;

    try {
        const data = event?.detail || {};
        const targets = Array.isArray(data.targets) ? data.targets : [];
        const interruptNodeId = String(data.interrupt_node_id || "0").trim();
        
        const graphs = [app?.canvas?.getCurrentGraph?.(), app?.canvas?.graph, app?.graph].filter(Boolean);
        const graphById = new Map(graphs.map((g) => [String(g.id ?? ""), g]));
        
        let statesMismatch = false; 

        // 【核心动作】检查并应用状态
        const applyModeAndCheck = (n, expectedMode) => {
            if (!n) return;
            const currentMode = n.mode !== undefined ? n.mode : 0;
            if (currentMode !== expectedMode) {
                statesMismatch = true; // 发现不一致
            }
            n.mode = expectedMode; // 应用状态
            
            if (n.isSubgraphNode?.() && n.subgraph) {
                for (const child of n.subgraph.nodes) {
                    applyModeAndCheck(child, expectedMode);
                }
            }
        };

        for (const target of targets) {
            if (!target || typeof target !== "object") continue;
            const action = String(target.action || "mute").toLowerCase();
            let mode = 2; 
            if (action === "active") mode = 0;
            if (action === "bypass") mode = 4;

            const nodeKeys = Array.isArray(target.node_keys) ? target.node_keys : [];
            const nodeIds = Array.isArray(target.node_ids) ? target.node_ids : [];

            for (const key of nodeKeys) {
                const text = String(key || "");
                const sep = text.indexOf(":");
                if (sep < 0) continue;
                const graphId = text.slice(0, sep);
                const nodeId = Number(text.slice(sep + 1));
                if (!Number.isInteger(nodeId)) continue;
                const graph = graphById.get(graphId);
                if (!graph) continue;
                const n = graph.getNodeById ? graph.getNodeById(nodeId) : graph?._nodes_by_id?.[nodeId];
                if (n) applyModeAndCheck(n, mode);
            }

            for (const rawId of nodeIds) {
                const nodeId = Number(rawId);
                if (!Number.isInteger(nodeId)) continue;
                for (const graph of graphs) {
                    const n = graph.getNodeById ? graph.getNodeById(nodeId) : graph?._nodes_by_id?.[nodeId];
                    if (n) { applyModeAndCheck(n, mode); break; }
                }
            }
        }
        
        if (targets.length > 0) {
            app.graph?.setDirtyCanvas?.(true, true);
        }

        // ================= 严格遵循您的 3 条分阶段执行逻辑 =================
        if (interruptNodeId !== "0" && interruptNodeId !== "") {
            if (!statesMismatch) {
                // 【逻辑 1 & 第二次运行】状态完全一致，直接输出 trigger，不做任何改变和打断
                console.log(`[BoolGroupSwitch] ✨ 状态已一致，直接输出 trigger，不进行分阶段执行。`);
            } else {
                // 【逻辑 2】状态不一致，需要分阶段执行
                console.log(`[BoolGroupSwitch] ⏳ 状态不一致，已变更组状态。准备在 Node ${interruptNodeId} 执行后打断...`);
                if (!isInterrupting) {
                    if (executedNodesInCurrentPrompt.has(interruptNodeId)) {
                        triggerInterruptAndRerun(interruptNodeId);
                    } else {
                        pendingInterrupts.add(interruptNodeId);
                    }
                }
            }
        } else {
            // 【逻辑 3】Node ID = 0，不进行打断，由 ComfyUI 继续执行当前工作流
            if (statesMismatch) {
                console.log(`[BoolGroupSwitch] 🔄 状态不一致，但 Node ID=0，不打断，由 ComfyUI 继续执行当前工作流。`);
            }
        }
        // ====================================================================

    } finally {
        __bgsIsApplyingStates = false;
    }
}

if (!window.__boolGroupSwitchGlobalEventsBound) {
    api.addEventListener("execution_start", () => {
        executedNodesInCurrentPrompt.clear();
        pendingInterrupts.clear();
        isInterrupting = false;
    });
    api.addEventListener("executed", (e) => {
        const nodeId = String(e?.detail?.node || e?.detail?.display_node || "");
        if (!nodeId || nodeId === "undefined") return;
        executedNodesInCurrentPrompt.add(nodeId);
        if (pendingInterrupts.has(nodeId) && !isInterrupting) triggerInterruptAndRerun(nodeId);
    });
    api.addEventListener("execution_interrupted", () => {
        if (!isInterrupting) pendingInterrupts.clear();
    });
    window.__boolGroupSwitchGlobalEventsBound = true;
}
// ==============================================================================

app.registerExtension({
    name: "comfyui-pwutility.bool.group.switch",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== NODE_NAME) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);
            this._bgsId = `bgs_${Date.now()}`;
            
            this.groupReferences = new WeakMap();
            this._bgsSyncTimeout = null;
            
            this.size = [300, 400];
            this.createMinimalUI();
            this.bindCallbacks(); 
            this.refreshWidgets(); 
            
            const startBackgroundSync = () => {
                if (this._bgsSyncTimeout) clearTimeout(this._bgsSyncTimeout);
                this._bgsSyncTimeout = setTimeout(() => {
                    requestAnimationFrame(() => {
                        this.checkGroupRenames();
                        if (this.graph) startBackgroundSync();
                    });
                }, 1000);
            };
            startBackgroundSync();
            
            return r;
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            if (this._bgsSyncTimeout) clearTimeout(this._bgsSyncTimeout);
            onRemoved?.apply(this, arguments);
        };

        nodeType.prototype.bindCallbacks = function () {
            if (this.__bgsCallbacksBound) return;
            const countWidget = getWidget(this, "group_count");
            if (countWidget) {
                const oldCb = countWidget.callback;
                countWidget.callback = (...args) => {
                    if (oldCb) oldCb.apply(countWidget, args);
                    this.refreshWidgets();
                };
            }
            this.__bgsCallbacksBound = true;
        };

        nodeType.prototype.checkGroupRenames = function () {
            if (!app.graph || !app.graph._groups) return;
            let hasRename = false;

            for (const group of app.graph._groups) {
                if (!group || !group.title) continue;
                
                const cachedName = this.groupReferences.get(group);
                if (cachedName && cachedName !== group.title) {
                    for (let i = 1; i <= MAX_GROUP_SLOTS; i++) {
                        const hiddenGroupWidget = getWidget(this, `group_${i}`);
                        const slot = getSlotPair(this, i);
                        
                        if (hiddenGroupWidget && hiddenGroupWidget.value === cachedName) {
                            hiddenGroupWidget.value = group.title;
                            if (slot && slot.groupWidget) {
                                slot.groupWidget.value = group.title;
                            }
                            hasRename = true;
                        }
                    }
                    this.groupReferences.set(group, group.title);
                } else if (!cachedName) {
                    this.groupReferences.set(group, group.title);
                }
            }

            if (hasRename) {
                this.updateGroupOptions();
                this.updateTargets();
                app.graph.setDirtyCanvas(true, true);
            }
        };

        nodeType.prototype.createMinimalUI = function () {
            if (this.__bgsSlotWidgetsInitialized) return;
            this.__vrgdgSlotWidgets = {};

            setWidgetVisible(getWidget(this, "group_targets_json"), false);
            for (let i = 1; i <= MAX_GROUP_SLOTS; i++) {
                setWidgetVisible(getWidget(this, `group_${i}`), false);
                setWidgetVisible(getWidget(this, `group_${i}_state_true`), false);
                setWidgetVisible(getWidget(this, `group_${i}_state_false`), false);
            }

            for (let i = 1; i <= MAX_GROUP_SLOTS; i++) {
                const groupLabel = `Group ${i}`;
                const stateTrueLabel = `Group ${i} True`; 
                const stateFalseLabel = `Group ${i} False`;

                const syncAndRefresh = () => {
                    this.syncHiddenFromSlots();
                    this.updateTargets();
                    app.graph.setDirtyCanvas(true, true);
                };

                let groupWidget = getWidgetByLabel(this, groupLabel) || this.addWidget("combo", groupLabel, NONE_OPTION, syncAndRefresh, { values: [NONE_OPTION], serialize: false });
                let stateTrueWidget = getWidgetByLabel(this, stateTrueLabel) || this.addWidget("combo", stateTrueLabel, "active", syncAndRefresh, { values: ACTION_VALUES, serialize: false });
                let stateFalseWidget = getWidgetByLabel(this, stateFalseLabel) || this.addWidget("combo", stateFalseLabel, "mute", syncAndRefresh, { values: ACTION_VALUES, serialize: false });

                [groupWidget, stateTrueWidget, stateFalseWidget].forEach(w => {
                    w.__vrgdgCustom = true;
                    w.__vrgdgSlotIndex = i;
                    w.serializeValue = () => undefined;
                });

                this.__vrgdgSlotWidgets[i] = { groupWidget, stateTrueWidget, stateFalseWidget };
            }
            this.__bgsSlotWidgetsInitialized = true;
            this.syncSlotsFromHidden();
        };

        nodeType.prototype.syncSlotsFromHidden = function () {
            for (let i = 1; i <= MAX_GROUP_SLOTS; i++) {
                const slot = getSlotPair(this, i);
                if (!slot) continue;
                const bg = getWidget(this, `group_${i}`);
                const bt = getWidget(this, `group_${i}_state_true`);
                const bf = getWidget(this, `group_${i}_state_false`);
                if (bg && bg.value != null) slot.groupWidget.value = String(bg.value || NONE_OPTION);
                if (bt && bt.value != null) slot.stateTrueWidget.value = String(bt.value || "active");
                if (bf && bf.value != null) slot.stateFalseWidget.value = String(bf.value || "mute");
            }
        };

        nodeType.prototype.syncHiddenFromSlots = function () {
            for (let i = 1; i <= MAX_GROUP_SLOTS; i++) {
                const slot = getSlotPair(this, i);
                if (!slot) continue;
                const bg = getWidget(this, `group_${i}`);
                const bt = getWidget(this, `group_${i}_state_true`);
                const bf = getWidget(this, `group_${i}_state_false`);
                if (bg) bg.value = String(slot.groupWidget.value || NONE_OPTION);
                if (bt) bt.value = String(slot.stateTrueWidget.value || "active");
                if (bf) bf.value = String(slot.stateFalseWidget.value || "mute");
            }
        };

        nodeType.prototype.updateGroupOptions = function () {
            const allTitles = getGroupsSortedAlpha(this).map(g => String(g?.title || "").trim()).filter(t => t);
            const uniqueTitles = [...new Set(allTitles)];
            const values = [NONE_OPTION, ...uniqueTitles.sort()];
            
            for (let i = 1; i <= MAX_GROUP_SLOTS; i++) {
                const slot = getSlotPair(this, i);
                if (!slot) continue;
                if (!slot.groupWidget.options) slot.groupWidget.options = {};
                slot.groupWidget.options.values = values;
                if (!values.includes(String(slot.groupWidget.value || ""))) slot.groupWidget.value = NONE_OPTION;

                slot.stateTrueWidget.options.values = ACTION_VALUES;
                slot.stateFalseWidget.options.values = ACTION_VALUES;
            }
            this.syncHiddenFromSlots();
        };

        nodeType.prototype.updateTargets = function () {
            const countWidget = getWidget(this, "group_count");
            const count = Math.max(1, Math.min(MAX_GROUP_SLOTS, Number(countWidget?.value ?? 1)));
            const groups = getGroupsSortedAlpha(this);
            const selected = [];
            
            for (let i = 1; i <= count; i++) {
                const slot = getSlotPair(this, i);
                if (!slot) continue;
                const title = String(slot.groupWidget.value || "").trim();
                if (!title || title === NONE_OPTION) continue;
                
                const actionTrue = String(slot.stateTrueWidget?.value || "active").toLowerCase();
                const actionFalse = String(slot.stateFalseWidget?.value || "mute").toLowerCase();
                
                const matched = groups.filter((g) => String(g?.title || "").trim() === title);
                const nodeIds = [];
                const nodeKeys = [];
                
                for (const group of matched) {
                    const ownerGraph = group?.__vrgdgOwnerGraph;
                    const ownerGraphId = ownerGraph?.id != null ? String(ownerGraph.id) : null;
                    for (const groupNode of getNodesInGroupGlobal(group)) {
                        const nodeId = Number(groupNode?.id);
                        if (Number.isInteger(nodeId) && nodeId >= 0 && !nodeIds.includes(nodeId)) nodeIds.push(nodeId);
                        if (ownerGraphId != null && Number.isInteger(nodeId) && nodeId >= 0) {
                            const key = `${ownerGraphId}:${nodeId}`;
                            if (!nodeKeys.includes(key)) nodeKeys.push(key);
                        }
                    }
                }
                selected.push({ slot: i, title, action_true: actionTrue, action_false: actionFalse, node_ids: nodeIds, node_keys: nodeKeys });
            }
            
            const widget = getWidget(this, "group_targets_json");
            if (widget) widget.value = JSON.stringify(selected);
        };

        nodeType.prototype.refreshWidgets = function () {
            this.createMinimalUI();
            const countWidget = getWidget(this, "group_count");
            const count = Math.max(1, Math.min(MAX_GROUP_SLOTS, Number(countWidget?.value ?? 1)));

            for (let i = 1; i <= MAX_GROUP_SLOTS; i++) {
                const slot = getSlotPair(this, i);
                if (!slot) continue;
                
                setWidgetVisible(getWidget(this, `group_${i}`), false);
                setWidgetVisible(getWidget(this, `group_${i}_state_true`), false);
                setWidgetVisible(getWidget(this, `group_${i}_state_false`), false);

                const isVisible = i <= count;
                setWidgetVisible(slot.groupWidget, isVisible);
                setWidgetVisible(slot.stateTrueWidget, isVisible);
                setWidgetVisible(slot.stateFalseWidget, isVisible);

                const lastWidgetInSlot = slot.stateFalseWidget;
                if (lastWidgetInSlot) {
                    if (isVisible) {
                        const gap = i < count ? 6 : 0; 
                        const baseComputeSize = lastWidgetInSlot.__vrgdgOriginalComputeSize || lastWidgetInSlot.computeSize;
                        lastWidgetInSlot.computeSize = function (...args) {
                            const base = baseComputeSize ? baseComputeSize.apply(this, args) : [args?.[0] || 0, 20];
                            return [base[0], base[1] + gap];
                        };
                    } else {
                        lastWidgetInSlot.computeSize = () => [0, -4];
                    }
                }
            }
            
            setWidgetVisible(getWidget(this, "group_targets_json"), false);
            this.updateGroupOptions();
            this.updateTargets();
            
            const computedSize = this.computeSize();
            if (Math.abs(this.size[1] - computedSize[1]) > 1) {
                this.size[1] = computedSize[1]; 
            }
            app.graph.setDirtyCanvas(true, true);
        };

        const origOnSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (info) {
            const data = origOnSerialize?.apply?.(this, arguments);
            this.syncHiddenFromSlots();
            this.updateTargets();
            return data;
        };

        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            origOnConfigure?.apply?.(this, arguments);
            setTimeout(() => {
                this.bindCallbacks();
                this.refreshWidgets();
            }, 100);
        };
    }
});

if (!window.__boolGroupSwitchApplyBound) {
    api.addEventListener("bool-group-switch-apply", applyNodeModesEvent);
    window.__boolGroupSwitchApplyBound = true;
}