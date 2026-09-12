import json
from server import PromptServer

class TextBridgePW:
    node_states = {}

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {
                    "multiline": True, 
                    "default": "", 
                    "dynamicPrompts": False
                }),
            },
            "optional": {
                "input_text": ("STRING", {"forceInput": True}),
                "update_trigger": ("INT", {"default": 0}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "bridge_text"
    CATEGORY = "🔮PWUtility/Utility"
    OUTPUT_NODE = True

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        # 跳过默认的类型验证，防止 update_trigger 为 None 时报错
        return True

    def bridge_text(self, text, update_trigger=None, unique_id=None, **kwargs):
        input_text = kwargs.get('input_text', None)
        
        # 核心修复：处理 update_trigger 为 None 的情况
        if update_trigger is None:
            update_trigger = 0
        
        if unique_id is None:
            unique_id = "default"
            
        state = self.node_states.get(unique_id, {"last_input": None, "last_trigger": -1})
        last_input = state.get("last_input")
        last_trigger = state.get("last_trigger")
        
        is_update_triggered = (update_trigger != last_trigger)
        
        if is_update_triggered:
            if input_text is not None:
                text = input_text
            state["last_trigger"] = update_trigger
        else:
            if input_text is not None:
                if last_input != input_text:
                    text = input_text
                    
        if input_text is not None:
            state["last_input"] = input_text
            
        self.node_states[unique_id] = state
        
        if unique_id != "default":
            PromptServer.instance.send_sync("pw_text_bridge_processed", {
                "node": unique_id, 
                "widget": "text", 
                "text": text
            })
        
        return {"ui": {"text": [text]}, "result": (text,)}

NODE_CLASS_MAPPINGS = {
    "Text Bridge PW": TextBridgePW
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "Text Bridge PW": "Text Bridge PW"
}