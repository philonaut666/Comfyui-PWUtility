import json
from server import PromptServer

class BoolGroupSwitch:
    # ... (保持您之前的 BoolGroupSwitch 代码完全不变) ...
    @classmethod
    def INPUT_TYPES(s):
        inputs = {
            "required": {
                "condition": ("BOOLEAN", {"default": True, "label_on": "True", "label_off": "False"}),
                "group_count": ("INT", {"default": 1, "min": 1, "max": 12, "step": 1, "display": "number"}),
                "interrupt_node_id": ("INT", {"default": 0, "min": 0, "max": 999999, "step": 1, "display": "number"}),
            },
            "optional": {
                "trigger": ("*",), 
                "group_targets_json": ("STRING", {"default": "[]", "multiline": False}),
            }
        }
        for i in range(1, 13):
            inputs["optional"][f"group_{i}"] = ("STRING", {"default": "<none>", "multiline": False})
            inputs["optional"][f"group_{i}_state_true"] = ("STRING", {"default": "active", "multiline": False})
            inputs["optional"][f"group_{i}_state_false"] = ("STRING", {"default": "mute", "multiline": False})
        return inputs
    
    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("data_out",)
    FUNCTION = "process"
    CATEGORY = "Comfyui-PWUtility"

    def process(self, condition, group_count, interrupt_node_id=0, group_targets_json="[]", trigger=None, **kwargs):
        targets = []
        try: targets = json.loads(group_targets_json)
        except Exception: targets = []
        apply_list = []
        for t in targets:
            title = t.get("title", "")
            node_ids = t.get("node_ids", [])
            node_keys = t.get("node_keys", [])
            if not title or not node_ids: continue
            action = t.get("action_true") if condition else t.get("action_false")
            if not action: action = "mute"
            apply_list.append({"title": title, "action": action, "node_ids": node_ids, "node_keys": node_keys})
        if apply_list or int(interrupt_node_id) > 0:
            try:
                PromptServer.instance.send_sync("bool-group-switch-apply", {"targets": apply_list, "interrupt_node_id": int(interrupt_node_id)})
            except Exception as e:
                print(f"[BoolGroupSwitch] Failed to send apply event: {e}")
        return (trigger,)


# ================= Group Switch ADV 后端 =================
class GroupSwitchADV:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {},
            "optional": {},
            # 【核心修复 1】加入 hidden 字段，确保 ComfyUI 触发完整的序列化生命周期
            "hidden": {
                "unique_id": "UNIQUE_ID"
            }
        }
    
    RETURN_TYPES = ()
    FUNCTION = "do_nothing"
    CATEGORY = "Comfyui-PWUtility"

    def do_nothing(self, **kwargs):
        return ()
# ==============================================================================


NODE_CLASS_MAPPINGS = {
    "BoolGroupSwitch": BoolGroupSwitch,
    "GroupSwitchADV": GroupSwitchADV, 
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BoolGroupSwitch": "Bool Group Switch",
    "GroupSwitchADV": "Group Switch ADV",
}