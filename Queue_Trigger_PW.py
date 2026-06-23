import math

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

    @classmethod
    def IS_CHANGED(cls, Index, total, mode, unique_id):
        # 强制返回 NaN，确保 ComfyUI 后端永远不命中缓存
        return math.nan

    def doit(self, Index, total, mode, unique_id):  
        # Python 端只做透传，循环逻辑由前端 JS 控制
        return (Index, total)

NODE_CLASS_MAPPINGS = {
    "Queue_Trigger_PW": Queue_Trigger_PW
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "Queue_Trigger_PW": "Queue Trigger PW"
}