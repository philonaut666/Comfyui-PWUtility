import json
from server import PromptServer

class BoolGroupSwitch:
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
    CATEGORY = "🔮PWUtility/Group"

    def process(self, condition, group_count, interrupt_node_id=0, group_targets_json="[]", trigger=None, **kwargs):
        targets = []
        try: 
            targets = json.loads(group_targets_json)
        except Exception: 
            targets = []
            
        apply_list = []
        for t in targets:
            title = t.get("title", "")
            node_ids = t.get("node_ids", [])
            node_keys = t.get("node_keys", [])
            if not title or not node_ids: 
                continue
                
            action = t.get("action_true") if condition else t.get("action_false")
            if not action: 
                action = "mute"
            apply_list.append({"title": title, "action": action, "node_ids": node_ids, "node_keys": node_keys})
            
        if apply_list or int(interrupt_node_id) > 0:
            try:
                PromptServer.instance.send_sync("bool-group-switch-apply", {"targets": apply_list, "interrupt_node_id": int(interrupt_node_id)})
            except Exception as e:
                print(f"[BoolGroupSwitch] Failed to send apply event: {e}")
                
        return (trigger,)

NODE_CLASS_MAPPINGS = {
    "BoolGroupSwitch": BoolGroupSwitch,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BoolGroupSwitch": "Bool Group Switch",
}