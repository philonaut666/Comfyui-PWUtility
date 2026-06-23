from server import PromptServer

class Queue_Trigger_PW:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "Index": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "total": ("INT", {"default": 4, "min": 1, "max": 0xffffffffffffffff}),
                "mode": ("BOOLEAN", {"default": True, "label_on": "Trigger", "label_off": "Don't trigger"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"}
        }
    
    FUNCTION = "doit"
    CATEGORY = "🔮PWUtility/utility"
    RETURN_TYPES = ("INT", "INT")
    RETURN_NAMES = ("Index", "total")
    OUTPUT_NODE = True     

    def doit(self, Index, total, mode, unique_id):  
        if mode:
            if Index < total - 1:
                # 还没到总次数，Index + 1 并触发下一次运行
                PromptServer.instance.send_sync("node-feedback", {
                    "node_id": unique_id, 
                    "widget_name": "Index", 
                    "type": "int", 
                    "value": Index + 1
                })
                PromptServer.instance.send_sync("add-queue", {})
            else:
                # 达到总次数，将 Index 重置为 0，且不触发 add-queue（停止运行）
                PromptServer.instance.send_sync("node-feedback", {
                    "node_id": unique_id, 
                    "widget_name": "Index", 
                    "type": "int", 
                    "value": 0
                })

        return (Index, total)

NODE_CLASS_MAPPINGS = {
    "Queue_Trigger_PW": Queue_Trigger_PW
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "Queue_Trigger_PW": "Queue Trigger PW"
}