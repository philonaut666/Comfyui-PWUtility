from server import PromptServer

class Queue_Trigger_PW:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "Index": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "total": ("INT", {"default": 10, "min": 1, "max": 0xffffffffffffffff}),
                "mode": ("BOOLEAN", {"default": True, "label_on": "Trigger", "label_off": "Don't trigger"}),
            },
            "optional": {},
            "hidden": {"unique_id": "UNIQUE_ID"}
        }
    
    FUNCTION = "doit"
    CATEGORY = "🔮PWUtility/utility"
    RETURN_TYPES = ("INT", "INT")
    RETURN_NAMES = ("Index", "total")
    OUTPUT_NODE = True     

    # 【核心机制 1】：强制该节点永不使用 ComfyUI 执行缓存
    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # 返回 NaN (Not a Number)，在 Python 中 NaN != NaN
        # ComfyUI 校验缓存时发现签名不同，就会跳过缓存，每次都强制执行此节点。
        # 前方节点不受影响，依然正常享受缓存。
        return float("NaN")

    def doit(self, Index, total, mode, unique_id):  
        if mode:
            if Index < total - 1:
                # 没到总次数，Index+1 并触发下一次队列
                PromptServer.instance.send_sync("node-feedback", {
                    "node_id": unique_id, 
                    "widget_name": "Index", 
                    "type": "int", 
                    "value": Index + 1
                })
                PromptServer.instance.send_sync("add-queue", {})
            elif Index >= total - 1:
                # 达到总次数，循环结束，通知前端归零
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