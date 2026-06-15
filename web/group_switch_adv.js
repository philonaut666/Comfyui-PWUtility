import { app } from "../../../scripts/app.js";

const NODE_NAME = "GroupSwitchADV";

const i18n = {
    zh: {
        title: "组开关管理器", allColors: "所有", refresh: "刷新", settings: "设置", cancel: "取消", confirm: "确定",
        enable: "开启", disable: "关闭", modeLabel: "运行模式", modeDisable: "Mute", modeBypass: "Bypass",
        colorRed: "红色", colorBrown: "棕色", colorGreen: "绿色", colorBlue: "蓝色", colorPaleBlue: "浅蓝色",
        colorCyan: "青色", colorPurple: "紫色", colorYellow: "黄色", colorBlack: "黑色",
        matchMode: "匹配模式", matchColors: "按颜色", matchTitle: "按标题", matchNone: "无(显示全部)",
        colorFilter: "颜色过滤", matchTitleLabel: "标题关键词(逗号分隔)", toggleRestriction: "切换限制",
        restrictionUnlimited: "无限制", restrictionAlwaysOne: "始终仅开启一个", navigateIndicator: "定位按钮",
        show: "显示", hide: "隐藏", linkageConfig: "联动配置：", whenGroupOn: "组开启时", whenGroupOff: "组关闭时",
        searchGroup: "搜索组...",
        helpTitle: "Group Switch ADV", helpDesc: "极简版组管理器。支持跨节点全局联动、拖拽排序、条件过滤。"
    },
    en: {
        title: "Group Switch ADV", allColors: "All", refresh: "Refresh", settings: "Settings", cancel: "Cancel", confirm: "Confirm",
        enable: "Enable", disable: "Disable", modeLabel: "Execution Mode", modeDisable: "Mute", modeBypass: "Bypass",
        colorRed: "Red", colorBrown: "Brown", colorGreen: "Green", colorBlue: "Blue", colorPaleBlue: "Pale Blue",
        colorCyan: "Cyan", colorPurple: "Purple", colorYellow: "Yellow", colorBlack: "Black",
        matchMode: "Match Mode", matchColors: "By Color", matchTitle: "By Title", matchNone: "None(Show All)",
        colorFilter: "Color Filter", matchTitleLabel: "Title Keywords(comma separated)", toggleRestriction: "Toggle Restriction",
        restrictionUnlimited: "Unlimited", restrictionAlwaysOne: "Always One Active", navigateIndicator: "Navigate Button",
        show: "Show", hide: "Hide", linkageConfig: "Linkage Config: ", whenGroupOn: "When Group ON", whenGroupOff: "When Group OFF",
        searchGroup: "Search group...",
        helpTitle: "Group Switch ADV", helpDesc: "Minimalist Group Manager. Supports global cross-node linkage, drag-sort, and filtering."
    }
};

function getLocale() {
    const comfyLocale = app?.ui?.settings?.getSettingValue?.('Comfy.Locale');
    return comfyLocale === 'zh-CN' || comfyLocale === 'zh' ? 'zh' : 'en';
}
function t(key) { return i18n[getLocale()][key] || i18n['en'][key] || key; }

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

function getNodesInGroupGlobal(group) {
    if (!group || !app.graph) return [];
    try { if (typeof group.recomputeInsideNodes === "function") group.recomputeInsideNodes(); } catch (e) {}
    return Array.from(group._children || []).filter((c) => c instanceof LGraphNode);
}

class GroupSwitchService {
    constructor() { 
        this.nodes = []; 
        this.runScheduledForMs = null;
        this.runScheduleTimeout = null;
        this.runScheduleAnimation = null;
    }
    addNode(node) { 
        this.nodes.push(node); 
        this.scheduleRun(300); 
    }
    removeNode(node) {
        const i = this.nodes.indexOf(node);
        if (i > -1) this.nodes.splice(i, 1);
        if (!this.nodes.length) this.clearScheduledRun();
    }
    run() {
        if (!this.runScheduledForMs) return;
        for (const node of this.nodes) node.refreshWidgets();
        this.clearScheduledRun();
        this.scheduleRun(300);
    }
    scheduleRun(ms = 300) {
        if (this.runScheduledForMs && ms < this.runScheduledForMs) this.clearScheduledRun();
        if (!this.runScheduledForMs && this.nodes.length) {
            this.runScheduledForMs = ms;
            this.runScheduleTimeout = setTimeout(() => {
                this.runScheduleAnimation = requestAnimationFrame(() => this.run());
            }, ms);
        }
    }
    clearScheduledRun() { 
        if (this.runScheduleTimeout) clearTimeout(this.runScheduleTimeout);
        if (this.runScheduleAnimation) cancelAnimationFrame(this.runScheduleAnimation);
        this.runScheduleTimeout = null;
        this.runScheduleAnimation = null;
        this.runScheduledForMs = null; 
    }
}
const GSA_SERVICE = new GroupSwitchService();

app.registerExtension({
    name: "comfyui-pwutility.group.switch.adv",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== NODE_NAME) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);
            this._gsaId = `gsa_${Date.now()}`;
            
            this.properties = this.properties || {};
            this.properties.groups = this.properties.groups || [];
            this.properties.groupOrder = this.properties.groupOrder || [];
            this.properties.switchMode = this.properties.switchMode || 'bypass';
            this.properties.matchMode = this.properties.matchMode || 'none';
            this.properties.selectedColorFilter = this.properties.selectedColorFilter || '';
            this.properties.titleKeywords = this.properties.titleKeywords || '';
            this.properties.toggleRestriction = this.properties.toggleRestriction || 'unlimited';
            this.properties.showNavigate = this.properties.showNavigate !== false;
            
            this.groupReferences = new WeakMap();
            this.size = [300, 400];
            this.createMinimalUI();
            
            this._evtHandler = (e) => {
                if (e.detail && e.detail.sourceId !== this._gsaId) this.refreshWidgets();
            };
            window.addEventListener('group-mute-changed', this._evtHandler);
            return r;
        };

        const onAdded = nodeType.prototype.onAdded;
        nodeType.prototype.onAdded = function (graph) {
            onAdded?.apply(this, arguments);
            GSA_SERVICE.addNode(this);
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            GSA_SERVICE.removeNode(this);
            if (this._evtHandler) window.removeEventListener('group-mute-changed', this._evtHandler);
            onRemoved?.apply(this, arguments);
        };

        nodeType.prototype.createMinimalUI = function () {
            if (!document.querySelector('#gsa-styles')) {
                const style = document.createElement('style');
                style.id = 'gsa-styles';
                style.textContent = `
                    .gsa-container { width: 100%; height: 100%; display: flex; flex-direction: column; font-family: sans-serif; font-size: 12px; color: #333; background: #f8f9fa; overflow: hidden; }
                    .gsa-header { display: flex; gap: 5px; padding: 5px; border-bottom: 2px solid #dee2e6; align-items: center; }
                    .gsa-list { flex: 1; overflow-y: auto; padding: 2px 5px; }
                    
                    .gsa-item { display: flex; align-items: center; gap: 4px; padding: 3px 2px; border-bottom: 1px solid #e9ecef; }
                    
                    .gsa-item button, .gsa-header button, .gsa-dialog button { background: #ffffff; color: #495057; border: 1px solid #ced4da; padding: 0 6px; cursor: pointer; border-radius: 3px; font-size: 11px; transition: all 0.15s ease-in-out; height: 24px; display: flex; align-items: center; justify-content: center; box-sizing: border-box; }
                    .gsa-item button:hover, .gsa-header button:hover, .gsa-dialog button:hover { background: #e9ecef; border-color: #adb5bd; }
                    .gsa-item.active button.gsa-toggle { background: #4caf50; border-color: #388e3c; color: #fff; }
                    .gsa-item button.gsa-link-active { background: #4caf50; border-color: #388e3c; color: #fff; }
                    
                    .gsa-dialog { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: #ffffff; border: 1px solid #ced4da; padding: 16px 20px; z-index: 10000; color: #333; min-width: 420px; max-width: 500px; box-shadow: 0 8px 24px rgba(0,0,0,0.15); border-radius: 8px; display: flex; flex-direction: column; }
                    .gsa-dialog h3 { margin: 0 0 16px 0; font-size: 15px; border-bottom: 2px solid #e9ecef; padding-bottom: 10px; color: #212529; font-weight: 600; }
                    .gsa-dialog label { display: block; margin: 10px 0 4px; font-size: 11px; color: #6c757d; font-weight: 500; }
                    .gsa-dialog select, .gsa-dialog input { width: 100%; background: #ffffff; color: #212529; border: 1px solid #ced4da; padding: 4px 8px; height: 28px; box-sizing: border-box; margin-bottom: 5px; border-radius: 3px; outline: none; font-size: 11px; }
                    .gsa-dialog select:focus, .gsa-dialog input:focus { border-color: #80bdff; box-shadow: 0 0 0 2px rgba(0,123,255,.25); }
                    
                    .gsa-section-header { display: flex; align-items: center; justify-content: space-between; margin: 14px 0 6px 0; }
                    .gsa-section-header span { font-size: 12px; font-weight: 600; color: #495057; }
                    .gsa-add-rule { width: 22px; height: 22px; border-radius: 4px; background: #4caf50; border: 1px solid #388e3c; color: white; font-size: 14px; font-weight: bold; line-height: 20px; text-align: center; cursor: pointer; padding: 0; display: flex; align-items: center; justify-content: center; transition: all 0.15s ease; }
                    .gsa-add-rule:hover { background: #43a047; border-color: #2e7d32; }
                    
                    .gsa-rules-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 4px; }
                    
                    .gsa-dialog-footer { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; padding-top: 14px; border-top: 1px solid #e9ecef; }
                    .gsa-btn-primary { background: #4caf50 !important; border-color: #388e3c !important; color: #fff !important; }
                    .gsa-btn-primary:hover { background: #43a047 !important; border-color: #2e7d32 !important; }
                    
                    .gsa-rule { 
                        display: flex; 
                        gap: 5px; 
                        margin: 0; 
                        align-items: center;
                    }

                    .gsa-rule .gsa-search-input, 
                    .gsa-rule select.r-action, 
                    .gsa-rule button.r-del, 
                    .gsa-rule button.r-mirror-add {
                        height: 26px !important;
                        box-sizing: border-box !important;
                        margin: 0 !important;
                        border-radius: 3px !important;
                        border: 1px solid #ced4da !important;
                        font-family: sans-serif !important;
                        font-size: 11px !important;
                        outline: none !important;
                        vertical-align: middle !important;
                    }

                    .gsa-rule .gsa-search-input {
                        width: 100%;
                        padding: 0 8px !important;
                        background: #fff !important;
                        color: #212529 !important;
                        line-height: 24px !important;
                        appearance: none !important;
                        -webkit-appearance: none !important;
                    }
                    .gsa-rule .gsa-search-input:focus { 
                        border-color: #80bdff !important; 
                        box-shadow: 0 0 0 2px rgba(0,123,255,.25) !important; 
                    }

                    .gsa-rule select.r-action {
                        flex: 1;
                        padding: 0 28px 0 8px !important;
                        background-color: #fff !important;
                        background-image: url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3e%3cpath fill='none' stroke='%23343a40' stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M2 5l6 6 6-6'/%3e%3c/svg%3e") !important;
                        background-repeat: no-repeat !important;
                        background-position: right 8px center !important;
                        background-size: 12px 12px !important;
                        color: #212529 !important;
                        line-height: 24px !important;
                        appearance: none !important;
                        -webkit-appearance: none !important;
                    }

                    .gsa-rule button.r-del, 
                    .gsa-rule button.r-mirror-add {
                        width: 26px !important;
                        padding: 0 !important;
                        display: inline-flex !important;
                        align-items: center !important;
                        justify-content: center !important;
                        line-height: 1 !important;
                        flex-shrink: 0 !important;
                        cursor: pointer !important;
                    }

                    .gsa-rule button.r-del {
                        background: #fff !important;
                        color: #dc3545 !important;
                        font-size: 16px !important;
                        font-weight: bold !important;
                    }
                    .gsa-rule button.r-del:hover {
                        background: #f8d7da !important;
                        border-color: #f5c2c7 !important;
                    }

                    .gsa-rule button.r-mirror-add {
                        background: #f8f9fa !important;
                        color: #495057 !important;
                        font-size: 18px !important;
                        font-weight: bold !important;
                        transition: all 0.15s ease !important;
                    }
                    .gsa-rule button.r-mirror-add:hover:not(.added) { 
                        background: #4caf50 !important; 
                        color: white !important; 
                        border-color: #388e3c !important; 
                    }
                    /* 【修改】优化 - 号的显示，使其更粗且完美居中 */
                    .gsa-rule button.r-mirror-add.added { 
                        background: #e9ecef !important; 
                        color: #4caf50 !important; 
                        border-color: #e9ecef !important; 
                        cursor: default !important; 
                        pointer-events: none !important;
                        font-size: 24px !important;
                        font-weight: 900 !important;
                        line-height: 22px !important;
                    }
                    
                    .gsa-search-dropdown { position: relative; flex: 2; min-width: 140px; }
                    
                    .gsa-search-menu { display: none; position: absolute; top: 100%; left: 0; right: 0; background: #fff; border: 1px solid #ced4da; border-top: none; border-radius: 0 0 3px 3px; max-height: 160px; overflow-y: auto; z-index: 10001; box-shadow: 0 4px 8px rgba(0,0,0,0.1); }
                    .gsa-search-dropdown.open .gsa-search-menu { display: block; }
                    .gsa-search-option { padding: 6px 8px; cursor: pointer; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #333; border-bottom: 1px solid #f1f3f5; line-height: 1.4; }
                    .gsa-search-option:last-child { border-bottom: none; }
                    .gsa-search-option:hover { background: #e9ecef; }
                    .gsa-search-option.selected { background: #4caf50; color: #fff; font-weight: bold; }
                `;
                document.head.appendChild(style);
            }

            const container = document.createElement('div');
            container.className = 'gsa-container';
            container.innerHTML = `
                <div class="gsa-header">
                    <span id="gsa-mode" style="flex:1;"></span>
                    <button id="gsa-btn-set">⚙️</button>
                    <button id="gsa-btn-ref">🔄</button>
                </div>
                <div class="gsa-list" id="gsa-list"></div>
            `;
            this.addDOMWidget("gsa_ui", "div", container);
            this.ui = container;
            
            this.ui.querySelector('#gsa-btn-set').onclick = () => this.showSettings();
            this.ui.querySelector('#gsa-btn-ref').onclick = () => this.refreshWidgets();
            
            this.updateModeText();
            this.refreshWidgets();
        };

        nodeType.prototype.updateModeText = function () {
            const el = this.ui?.querySelector('#gsa-mode');
            if (el) el.textContent = this.properties.switchMode === 'bypass' ? t('modeBypass') : t('modeDisable');
        };

        nodeType.prototype.getWorkflowGroups = function () {
            if (!app.graph || !app.graph._groups) return [];
            return app.graph._groups.filter(g => g && g.title);
        };

        nodeType.prototype.sortGroups = function (groups) {
            if (!this.properties.groupOrder.length) return groups.slice().sort((a, b) => a.title.localeCompare(b.title));
            const map = new Map(this.properties.groupOrder.map((n, i) => [n, i]));
            const ordered = [], unordered = [];
            groups.forEach(g => (map.has(g.title) ? ordered : unordered).push(g));
            ordered.sort((a, b) => map.get(a.title) - map.get(b.title));
            unordered.sort((a, b) => a.title.localeCompare(b.title));
            return [...ordered, ...unordered];
        };

        nodeType.prototype.filterGroups = function (groups) {
            if (this.properties.matchMode === 'title' && this.properties.titleKeywords) {
                const kws = this.properties.titleKeywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
                if (kws.length) groups = groups.filter(g => kws.some(k => (g.title || '').toLowerCase().includes(k)));
            } else if (this.properties.matchMode === 'colors' && this.properties.selectedColorFilter) {
                let targetHex = this.getHexColor(this.properties.selectedColorFilter);
                if (targetHex) groups = groups.filter(g => this.getHexColor(g.color) === targetHex);
            }
            return groups;
        };

        nodeType.prototype.getHexColor = function (colorName) {
            if (!colorName) return null;
            if (colorName.startsWith('#')) return colorName.toLowerCase();
            if (typeof LGraphCanvas !== 'undefined' && LGraphCanvas.node_colors) {
                const map = LGraphCanvas.node_colors;
                const c = map[colorName] || map[colorName.replace(/\s+/g, '_')] || map[colorName.replace(/\s+/g, '')];
                if (c && c.groupcolor) return c.groupcolor.toLowerCase();
            }
            return null;
        };

        nodeType.prototype.isGroupEnabled = function (group) {
            const nodes = getNodesInGroupGlobal(group);
            if (!nodes.length) return false;
            let active = false;
            reduceNodesDepthFirst(nodes, (n) => { if (n.mode === 0) active = true; });
            return active;
        };

        nodeType.prototype.refreshWidgets = function () {
            const list = this.ui?.querySelector('#gsa-list');
            if (!list) return;

            let groups = this.getWorkflowGroups();
            groups = this.filterGroups(groups);
            groups = this.sortGroups(groups);

            groups.forEach(group => {
                let cfg = this.properties.groups.find(g => g.group_name === group.title);
                const isEnabled = this.isGroupEnabled(group);
                if (!cfg) {
                    cfg = { group_name: group.title, enabled: isEnabled, linkage: { on_enable: [], on_disable: [] } };
                    this.properties.groups.push(cfg);
                } else {
                    cfg.enabled = isEnabled;
                }
            });
            this.properties.groups = this.properties.groups.filter(c => groups.some(g => g.title === c.group_name));

            let index = 0;
            for (const group of groups) {
                const cfg = this.properties.groups.find(g => g.group_name === group.title);
                const isEnabled = cfg ? cfg.enabled : false;
                const hasLinkage = cfg && cfg.linkage && ((cfg.linkage.on_enable && cfg.linkage.on_enable.length > 0) || (cfg.linkage.on_disable && cfg.linkage.on_disable.length > 0));
                const colorHex = this.getHexColor(group.color) || '#adb5bd';

                let item = list.children[index];
                const expectedName = group.title;

                if (!item || item.dataset.name !== expectedName) {
                    const newItem = this.createGroupItem(cfg, group);
                    if (item) list.insertBefore(newItem, item);
                    else list.appendChild(newItem);
                    item = newItem;
                }

                const toggleBtn = item.querySelector('.gsa-toggle');
                if (toggleBtn) {
                    const isActive = toggleBtn.classList.contains('active');
                    if (isActive !== isEnabled) {
                        toggleBtn.classList.toggle('active', isEnabled);
                        toggleBtn.textContent = isEnabled ? 'ON' : 'OFF';
                        item.classList.toggle('active', isEnabled);
                    }
                }

                const linkBtn = item.querySelector('.gsa-link');
                if (linkBtn) {
                    const isLinkActive = linkBtn.classList.contains('gsa-link-active');
                    if (isLinkActive !== hasLinkage) linkBtn.classList.toggle('gsa-link-active', hasLinkage);
                }
                
                const navBtn = item.querySelector('.gsa-nav');
                if (navBtn) {
                    const shouldShow = this.properties.showNavigate;
                    const isShown = navBtn.style.display !== 'none';
                    if (isShown !== shouldShow) navBtn.style.display = shouldShow ? '' : 'none';
                }
                
                const colorSpan = item.querySelector('.gsa-color-indicator');
                if (colorSpan) colorSpan.style.backgroundColor = colorHex;

                index++;
            }

            while (list.children[index]) list.removeChild(list.children[index]);
        };

        nodeType.prototype.createGroupItem = function (cfg, group) {
            const item = document.createElement('div');
            item.className = 'gsa-item' + (cfg.enabled ? ' active' : '');
            item.draggable = true;
            item.dataset.name = group.title;
            
            const colorHex = this.getHexColor(group.color) || '#adb5bd';
            const hasLinkage = cfg.linkage && ((cfg.linkage.on_enable && cfg.linkage.on_enable.length > 0) || (cfg.linkage.on_disable && cfg.linkage.on_disable.length > 0));

            item.innerHTML = `
                <span class="gsa-drag-handle" style="cursor:grab; color:#adb5bd;">⠿</span>
                <span class="gsa-color-indicator" style="width:10px; height:10px; background:${colorHex}; border:1px solid #adb5bd; border-radius:2px; display:inline-block;"></span>
                <span class="gsa-title" style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${group.title}">${group.title}</span>
                <button class="gsa-toggle ${cfg.enabled ? 'active' : ''}">${cfg.enabled ? 'ON' : 'OFF'}</button>
                <button class="gsa-link ${hasLinkage ? 'gsa-link-active' : ''}" title="Linkage">🔗</button>
                <button class="gsa-nav" title="Navigate" style="display: ${this.properties.showNavigate ? '' : 'none'}">→</button>
            `;

            item.querySelector('.gsa-toggle').onclick = (e) => { e.stopPropagation(); this.toggleGroup(group.title, !cfg.enabled); };
            item.querySelector('.gsa-link').onclick = (e) => { e.stopPropagation(); this.showLinkage(cfg); };
            item.querySelector('.gsa-nav').onclick = (e) => { e.stopPropagation(); this.navigateTo(group); };

            item.ondragstart = (e) => { this._dragName = group.title; e.dataTransfer.effectAllowed = 'move'; item.style.opacity = '0.5'; };
            item.ondragend = () => { item.style.opacity = '1'; this._dragName = null; };
            item.ondragover = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; };
            item.ondrop = (e) => {
                e.preventDefault();
                if (this._dragName && this._dragName !== group.title) {
                    const order = this.sortGroups(this.getWorkflowGroups()).map(g => g.title);
                    const fromIdx = order.indexOf(this._dragName);
                    const toIdx = order.indexOf(group.title);
                    if (fromIdx > -1 && toIdx > -1) {
                        order.splice(fromIdx, 1);
                        order.splice(toIdx, 0, this._dragName);
                        this.properties.groupOrder = order;
                        this.refreshWidgets();
                        app.graph.setDirtyCanvas(true, true);
                    }
                }
            };

            return item;
        };

        nodeType.prototype.toggleGroup = function (groupName, enable, opts = {}) {
            const group = app.graph._groups.find(g => g.title === groupName);
            if (!group) return;
            const nodes = getNodesInGroupGlobal(group);
            if (nodes.length === 0) return;

            if (enable && this.properties.toggleRestriction === 'always_one' && !opts.skipAlwaysOne) {
                const filteredNames = this.filterGroups(this.getWorkflowGroups()).map(g => g.title);
                const enabledOthers = this.properties.groups.filter(g => g.enabled && g.group_name !== groupName && filteredNames.includes(g.group_name));
                const switchMode = this.properties.switchMode || 'bypass';
                const muteMode = switchMode === 'bypass' ? 4 : 2;
                enabledOthers.forEach(g => {
                    const otherGroup = app.graph._groups.find(grp => grp.title === g.group_name);
                    if (otherGroup) { changeModeOfNodes(getNodesInGroupGlobal(otherGroup), muteMode); g.enabled = false; }
                });
            }

            const switchMode = this.properties.switchMode || 'bypass';
            const mode = enable ? 0 : (switchMode === 'bypass' ? 4 : 2);
            changeModeOfNodes(nodes, mode);
            
            const config = this.properties.groups.find(g => g.group_name === groupName);
            if (config) config.enabled = enable;

            if (!opts.skipLinkage) {
                const allAdvNodes = app.graph._nodes.filter(n => n.type === "GroupSwitchADV" || n.comfyClass === "GroupSwitchADV");
                const globalRules = {};
                for (const node of allAdvNodes) {
                    if (!node.properties || !node.properties.groups) continue;
                    for (const cfg of node.properties.groups) {
                        if (!globalRules[cfg.group_name]) globalRules[cfg.group_name] = { on_enable: [], on_disable: [] };
                        if (cfg.linkage) {
                            globalRules[cfg.group_name].on_enable.push(...(cfg.linkage.on_enable || []));
                            globalRules[cfg.group_name].on_disable.push(...(cfg.linkage.on_disable || []));
                        }
                    }
                }

                const finalStates = {};
                const pendingActions = [];
                const sourceRules = globalRules[groupName];
                if (sourceRules) {
                    const rules = enable ? sourceRules.on_enable : sourceRules.on_disable;
                    for (const rule of rules) pendingActions.push({ name: rule.target_group, enabled: rule.action === 'enable', depth: 1 });
                }
                
                let head = 0;
                while(head < pendingActions.length) {
                    const action = pendingActions[head++];
                    const { name, enabled, depth } = action;
                    if (finalStates[name] && finalStates[name].depth <= depth) continue;
                    finalStates[name] = { enabled, depth };
                    const rules = globalRules[name];
                    if (rules) {
                        const nextRules = enabled ? rules.on_enable : rules.on_disable;
                        for (const rule of nextRules) pendingActions.push({ name: rule.target_group, enabled: rule.action === 'enable', depth: depth + 1 });
                    }
                }
                
                for (const [name, state] of Object.entries(finalStates)) {
                    const targetGroup = app.graph._groups.find(g => g.title === name);
                    if (targetGroup) {
                        const targetNodes = getNodesInGroupGlobal(targetGroup);
                        if (targetNodes.length > 0) {
                            let targetSwitchMode = 'bypass';
                            for (const node of allAdvNodes) {
                                const cfg = node.properties.groups.find(g => g.group_name === name);
                                if (cfg) { targetSwitchMode = node.properties.switchMode || 'bypass'; break; }
                            }
                            const targetMode = state.enabled ? 0 : (targetSwitchMode === 'bypass' ? 4 : 2);
                            changeModeOfNodes(targetNodes, targetMode);
                            for (const node of allAdvNodes) {
                                const cfg = node.properties.groups.find(g => g.group_name === name);
                                if (cfg) cfg.enabled = state.enabled;
                            }
                        }
                    }
                }
            }
            
            const allAdvNodes = app.graph._nodes.filter(n => n.type === "GroupSwitchADV" || n.comfyClass === "GroupSwitchADV");
            for (const node of allAdvNodes) node.refreshWidgets();
            app.graph.setDirtyCanvas(true, true);
            window.dispatchEvent(new CustomEvent('group-mute-changed', { detail: { sourceId: this._gsaId } }));
        };

        nodeType.prototype.navigateTo = function (group) {
            app.canvas.centerOnNode(group);
            app.canvas.setDirty(true, true);
        };

        nodeType.prototype.showSettings = function () {
            const dlg = document.createElement('div');
            dlg.className = 'gsa-dialog';
            const colors = ['red', 'brown', 'green', 'blue', 'pale blue', 'cyan', 'purple', 'yellow', 'black'];
            const colorKeys = { 'red': 'colorRed', 'brown': 'colorBrown', 'green': 'colorGreen', 'blue': 'colorBlue', 'pale blue': 'colorPaleBlue', 'cyan': 'colorCyan', 'purple': 'colorPurple', 'yellow': 'colorYellow', 'black': 'colorBlack' };
            const colorOpts = `<option value="">${t('allColors')}</option>` + colors.map(c => `<option value="${c}" ${this.properties.selectedColorFilter === c ? 'selected' : ''}>${t(colorKeys[c]) || c}</option>`).join('');
            
            dlg.innerHTML = `
                <h3>${t('settings')}</h3>
                <label>${t('modeLabel')}</label>
                <select id="s-mode"><option value="ignore" ${this.properties.switchMode === 'ignore' ? 'selected' : ''}>${t('modeDisable')}</option><option value="bypass" ${this.properties.switchMode === 'bypass' ? 'selected' : ''}>${t('modeBypass')}</option></select>
                <label>${t('matchMode')}</label>
                <select id="s-match"><option value="none" ${this.properties.matchMode === 'none' ? 'selected' : ''}>${t('matchNone')}</option><option value="colors" ${this.properties.matchMode === 'colors' ? 'selected' : ''}>${t('matchColors')}</option><option value="title" ${this.properties.matchMode === 'title' ? 'selected' : ''}>${t('matchTitle')}</option></select>
                <div id="s-color-wrap" style="display:${this.properties.matchMode === 'colors' ? 'block' : 'none'}"><label>${t('colorFilter')}</label><select id="s-color">${colorOpts}</select></div>
                <div id="s-title-wrap" style="display:${this.properties.matchMode === 'title' ? 'block' : 'none'}"><label>${t('matchTitleLabel')}</label><input type="text" id="s-title" value="${this.properties.titleKeywords || ''}"></div>
                <label>${t('toggleRestriction')}</label>
                <select id="s-rest"><option value="unlimited" ${this.properties.toggleRestriction === 'unlimited' ? 'selected' : ''}>${t('restrictionUnlimited')}</option><option value="always_one" ${this.properties.toggleRestriction === 'always_one' ? 'selected' : ''}>${t('restrictionAlwaysOne')}</option></select>
                <label>${t('navigateIndicator')}</label>
                <select id="s-nav"><option value="true" ${this.properties.showNavigate ? 'selected' : ''}>${t('show')}</option><option value="false" ${!this.properties.showNavigate ? 'selected' : ''}>${t('hide')}</option></select>
                <div class="gsa-dialog-footer"><button id="s-cancel">${t('cancel')}</button><button id="s-save" class="gsa-btn-primary">${t('confirm')}</button></div>
            `;
            document.body.appendChild(dlg);
            dlg.querySelector('#s-match').onchange = (e) => { dlg.querySelector('#s-color-wrap').style.display = e.target.value === 'colors' ? 'block' : 'none'; dlg.querySelector('#s-title-wrap').style.display = e.target.value === 'title' ? 'block' : 'none'; };
            const close = () => dlg.remove();
            dlg.querySelector('#s-cancel').onclick = close;
            dlg.querySelector('#s-save').onclick = () => {
                this.properties.switchMode = dlg.querySelector('#s-mode').value;
                this.properties.matchMode = dlg.querySelector('#s-match').value;
                this.properties.selectedColorFilter = dlg.querySelector('#s-color').value;
                this.properties.titleKeywords = dlg.querySelector('#s-title').value;
                this.properties.toggleRestriction = dlg.querySelector('#s-rest').value;
                this.properties.showNavigate = dlg.querySelector('#s-nav').value === 'true';
                this.updateModeText(); this.refreshWidgets(); 
                app.graph.setDirtyCanvas(true, true);
                close();
            };
            
            setTimeout(() => {
                const closeOnOutsideClick = (e) => {
                    const path = e.composedPath ? e.composedPath() : [];
                    const isInsideDialog = path.includes(dlg) || dlg.contains(e.target);
                    if (!isInsideDialog && document.body.contains(dlg)) {
                        close();
                        document.removeEventListener('click', closeOnOutsideClick);
                    }
                };
                document.addEventListener('click', closeOnOutsideClick);
            }, 100);
        };

        nodeType.prototype.showLinkage = function (cfg) {
            const dlg = document.createElement('div');
            dlg.className = 'gsa-dialog';
            const temp = JSON.parse(JSON.stringify(cfg));
            
            const renderRules = (type) => {
                const list = dlg.querySelector(`#l-${type}`);
                list.innerHTML = '';
                (temp.linkage[type] || []).forEach((rule, idx) => list.appendChild(this.createRuleItem(dlg, temp, type, rule, idx)));
            };

            dlg.innerHTML = `
                <h3>${t('linkageConfig')} ${cfg.group_name}</h3>
                <div class="gsa-section-header">
                    <span>${t('whenGroupOn')}</span>
                    <button class="gsa-add-rule" id="l-add-on" title="Add Rule">+</button>
                </div>
                <div id="l-on_enable" class="gsa-rules-list"></div>
                
                <div class="gsa-section-header">
                    <span>${t('whenGroupOff')}</span>
                    <button class="gsa-add-rule" id="l-add-off" title="Add Rule">+</button>
                </div>
                <div id="l-on_disable" class="gsa-rules-list"></div>
                
                <div class="gsa-dialog-footer">
                    <button id="l-cancel">${t('cancel')}</button>
                    <button id="l-save" class="gsa-btn-primary">${t('confirm')}</button>
                </div>
            `;
            document.body.appendChild(dlg);

            renderRules('on_enable');
            renderRules('on_disable');

            dlg.querySelector('#l-add-on').onclick = () => { 
                const allGroups = this.getWorkflowGroups().filter(g => g.title !== cfg.group_name);
                if(allGroups.length) { temp.linkage.on_enable.push({target_group: allGroups[0].title, action: 'enable'}); renderRules('on_enable'); } 
            };
            dlg.querySelector('#l-add-off').onclick = () => { 
                const allGroups = this.getWorkflowGroups().filter(g => g.title !== cfg.group_name);
                if(allGroups.length) { temp.linkage.on_disable.push({target_group: allGroups[0].title, action: 'enable'}); renderRules('on_disable'); } 
            };
            
            const close = () => dlg.remove();
            dlg.querySelector('#l-cancel').onclick = close;
            dlg.querySelector('#l-save').onclick = () => { 
                cfg.linkage = temp.linkage; 
                this.refreshWidgets(); 
                app.graph.setDirtyCanvas(true, true);
                close(); 
            };

            setTimeout(() => {
                const closeOnOutsideClick = (e) => {
                    const path = e.composedPath ? e.composedPath() : [];
                    const isInsideDialog = path.includes(dlg) || dlg.contains(e.target);
                    const isInsideDropdown = path.some(el => el.classList && el.classList.contains('gsa-search-dropdown')) || (e.target && e.target.closest && e.target.closest('.gsa-search-dropdown'));

                    if (!isInsideDialog && !isInsideDropdown) {
                        if (document.body.contains(dlg)) {
                            close();
                            document.removeEventListener('click', closeOnOutsideClick);
                        }
                    }
                    
                    if (!isInsideDropdown) {
                        dlg.querySelectorAll('.gsa-search-dropdown.open').forEach(d => d.classList.remove('open'));
                    }
                };
                document.addEventListener('click', closeOnOutsideClick);
            }, 100);
        };

        nodeType.prototype.createRuleItem = function (dialog, config, type, rule, index) {
            const item = document.createElement('div');
            item.className = 'gsa-rule';
            
            const allGroups = this.getWorkflowGroups()
                .filter(g => g.title !== config.group_name)
                .map(g => g.title)
                .sort((a, b) => a.localeCompare(b));

            item.innerHTML = `
                <button class="r-mirror-add" title="Add reverse rule">+</button>
                <div class="gsa-search-dropdown">
                    <input type="text" class="gsa-search-input" placeholder="${t('searchGroup')}" value="${rule.target_group || ''}">
                    <div class="gsa-search-menu"></div>
                </div>
                <select class="r-action">
                    <option value="enable" ${rule.action === 'enable' ? 'selected' : ''}>${t('enable')}</option>
                    <option value="disable" ${rule.action === 'disable' ? 'selected' : ''}>${t('disable')}</option>
                </select>
                <button class="r-del">X</button>
            `;

            const searchDropdown = item.querySelector('.gsa-search-dropdown');
            const searchInput = item.querySelector('.gsa-search-input');
            const searchMenu = item.querySelector('.gsa-search-menu');
            
            const oppositeType = type === 'on_enable' ? 'on_disable' : 'on_enable';
            const mirrorBtn = item.querySelector('.r-mirror-add');

            const updateMirrorBtnState = () => {
                const exists = (config.linkage[oppositeType] || []).some(r => r.target_group === rule.target_group);
                if (exists) {
                    mirrorBtn.classList.add('added');
                    // 【修改】将 ✓ 改为 -
                    mirrorBtn.innerHTML = '-';
                    mirrorBtn.title = "Reverse rule exists";
                } else {
                    mirrorBtn.classList.remove('added');
                    mirrorBtn.innerHTML = '+';
                    mirrorBtn.title = "Add reverse rule";
                }
            };
            updateMirrorBtnState();

            mirrorBtn.onclick = (e) => {
                e.stopPropagation();
                if (mirrorBtn.classList.contains('added')) return;
                
                const oppositeAction = rule.action === 'enable' ? 'disable' : 'enable';
                if (!config.linkage[oppositeType]) config.linkage[oppositeType] = [];
                
                config.linkage[oppositeType].push({
                    target_group: rule.target_group,
                    action: oppositeAction
                });
                
                const oppositeListId = oppositeType === 'on_enable' ? 'l-on_enable' : 'l-on_disable';
                const oppositeList = dialog.querySelector(`#${oppositeListId}`);
                if (oppositeList) {
                    oppositeList.innerHTML = '';
                    config.linkage[oppositeType].forEach((r, idx) => {
                        oppositeList.appendChild(this.createRuleItem(dialog, config, oppositeType, r, idx));
                    });
                }
                
                updateMirrorBtnState();
            };

            const renderOptions = (filterText = '') => {
                const lowerFilter = filterText.toLowerCase();
                const filtered = allGroups.filter(g => g.toLowerCase().includes(lowerFilter));
                searchMenu.innerHTML = filtered.map(g => 
                    `<div class="gsa-search-option ${g === rule.target_group ? 'selected' : ''}" data-value="${g}" title="${g}">${g}</div>`
                ).join('');
                
                searchMenu.querySelectorAll('.gsa-search-option').forEach(opt => {
                    opt.addEventListener('mousedown', (e) => { e.preventDefault(); });
                    opt.addEventListener('click', (e) => {
                        e.stopPropagation(); 
                        const val = opt.dataset.value;
                        rule.target_group = val;
                        searchInput.value = val;
                        searchDropdown.classList.remove('open');
                        updateMirrorBtnState();
                    });
                });
            };

            searchInput.onfocus = () => {
                dialog.querySelectorAll('.gsa-search-dropdown.open').forEach(d => {
                    if (d !== searchDropdown) d.classList.remove('open');
                });
                searchDropdown.classList.add('open');
                searchInput.value = ''; 
                renderOptions(''); 
            };

            searchInput.oninput = () => {
                renderOptions(searchInput.value);
                searchDropdown.classList.add('open');
            };
            
            searchInput.onblur = () => {
                setTimeout(() => {
                    if (!searchDropdown.contains(document.activeElement)) {
                        searchInput.value = rule.target_group || '';
                        searchDropdown.classList.remove('open');
                    }
                }, 100);
            };

            item.querySelector('.r-action').onchange = (e) => rule.action = e.target.value;
            
            item.querySelector('.r-del').onclick = (e) => { 
                e.stopPropagation();
                config.linkage[type].splice(index, 1); 
                
                const currentListId = type === 'on_enable' ? 'l-on_enable' : 'l-on_disable';
                const currentList = dialog.querySelector(`#${currentListId}`);
                if (currentList) {
                    currentList.innerHTML = '';
                    (config.linkage[type] || []).forEach((r, idx) => {
                        currentList.appendChild(this.createRuleItem(dialog, config, type, r, idx));
                    });
                }
                
                const oppositeListId = oppositeType === 'on_enable' ? 'l-on_enable' : 'l-on_disable';
                const oppositeList = dialog.querySelector(`#${oppositeListId}`);
                if (oppositeList) {
                    oppositeList.innerHTML = '';
                    (config.linkage[oppositeType] || []).forEach((r, idx) => {
                        oppositeList.appendChild(this.createRuleItem(dialog, config, oppositeType, r, idx));
                    });
                }
            };

            return item;
        };

        const origOnSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (info) {
            const data = origOnSerialize?.apply?.(this, arguments);
            info.groups = this.properties.groups || [];
            info.groupOrder = this.properties.groupOrder || [];
            info.switchMode = this.properties.switchMode || 'bypass';
            info.matchMode = this.properties.matchMode || 'none';
            info.selectedColorFilter = this.properties.selectedColorFilter || '';
            info.titleKeywords = this.properties.titleKeywords || '';
            info.toggleRestriction = this.properties.toggleRestriction || 'unlimited';
            info.showNavigate = this.properties.showNavigate !== false;
            return data;
        };

        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            origOnConfigure?.apply?.(this, arguments);
            if (info.groups && Array.isArray(info.groups)) this.properties.groups = info.groups;
            if (info.groupOrder && Array.isArray(info.groupOrder)) this.properties.groupOrder = info.groupOrder;
            if (info.switchMode !== undefined) this.properties.switchMode = info.switchMode;
            if (info.matchMode !== undefined) this.properties.matchMode = info.matchMode;
            if (info.selectedColorFilter !== undefined) this.properties.selectedColorFilter = info.selectedColorFilter;
            if (info.titleKeywords !== undefined) this.properties.titleKeywords = info.titleKeywords;
            if (info.toggleRestriction !== undefined) this.properties.toggleRestriction = info.toggleRestriction;
            if (info.showNavigate !== undefined) this.properties.showNavigate = info.showNavigate;

            if (this.ui) {
                setTimeout(() => {
                    this.updateModeText();
                    this.refreshWidgets();
                }, 100);
            }
        };
    }
});