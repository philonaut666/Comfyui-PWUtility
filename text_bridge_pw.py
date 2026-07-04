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
                # 核心修复：放在 optional 中确保 100% 被前端序列化到 Prompt 中
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

    def bridge_text(self, text, update_trigger=0, unique_id=None, **kwargs):
        input_text = kwargs.get('input_text', None)
        
        if unique_id is None:
            unique_id = "default"
            
        state = self.node_states.get(unique_id, {"last_input": None, "last_trigger": -1})
        last_input = state.get("last_input")
        last_trigger = state.get("last_trigger")
        
        # 判断是否是由前端 Update 按钮触发的强制更新
        is_update_triggered = (update_trigger != last_trigger)
        
        if is_update_triggered:
            # 强制从输入端获取文本
            if input_text is not None:
                text = input_text
            state["last_trigger"] = update_trigger
        else:
            # 普通运行：只有当输入有数据且发生变化时，才覆盖当前文本
            if input_text is not None:
                if last_input != input_text:
                    text = input_text
                    
        if input_text is not None:
            state["last_input"] = input_text
            
        self.node_states[unique_id] = state
        
        # 发送消息给前端，更新 text widget 的显示值
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