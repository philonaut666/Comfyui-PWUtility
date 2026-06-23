class QueueCountPW:
    """
    Queue Count PW 节点
    功能：设置一个批次中 ComfyUI 运行的次数，并输出每次运行在该批次中的 index。
    """
    _current_index = 0
    
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "total_count": ("INT", {
                    "default": 1, 
                    "min": 1, 
                    "max": 10000, 
                    "step": 1,
                    "display": "number"
                }),
            }
        }
    
    RETURN_TYPES = ("INT", "INT")
    RETURN_NAMES = ("current_index", "total_count")
    FUNCTION = "execute"
    CATEGORY = "🔮PWUtility/Utility"

    @classmethod
    def IS_CHANGED(s, **kwargs):
        # 返回 NaN 强制忽略节点缓存
        return float("NaN")

    def execute(self, total_count):
        idx = QueueCountPW._current_index
        QueueCountPW._current_index += 1
        
        # 当达到批次总数时，自动重置为 0 
        if QueueCountPW._current_index >= total_count:
            QueueCountPW._current_index = 0
            
        return (idx, total_count)

NODE_CLASS_MAPPINGS = {
    "QueueCountPW": QueueCountPW
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "QueueCountPW": "Queue Count PW"
}