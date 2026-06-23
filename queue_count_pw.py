class QueueCountPW:
    """
    Queue Count PW 节点
    功能：设置一个批次中 ComfyUI 运行的次数，并输出每次运行在该批次中的 index。
    特性：
    1. 忽略 ComfyUI 的节点缓存，确保每次运行都真实执行。
    2. 当运行次数达到设定的 total_count 后，自动重置 index 为 0（相当于运行停止后清空缓存）。
    3. 每个新批次自动从 index=0 开始。
    """
    # 使用类变量来维护跨执行的状态
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
    # 按照要求设置分类
    CATEGORY = "🔮PWUtility/Utility"

    @classmethod
    def IS_CHANGED(s, **kwargs):
        # 返回 NaN (Not a Number)。因为 NaN != NaN，ComfyUI 会认为该节点每次都在变化，
        # 从而强制节点每次都被执行，完美实现“忽略该节点的节点缓存”。
        return float("NaN")

    def execute(self, total_count):
        # 获取当前的 index
        idx = QueueCountPW._current_index
        
        # 递增 index
        QueueCountPW._current_index += 1
        
        # 当达到批次总数时，自动重置为 0 
        # 这实现了“在comfyui运行停止后（批次结束），自动清空/重置”的需求
        if QueueCountPW._current_index >= total_count:
            QueueCountPW._current_index = 0
            
        return (idx, total_count)


# 节点映射注册
NODE_CLASS_MAPPINGS = {
    "QueueCountPW": QueueCountPW
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "QueueCountPW": "Queue Count PW"
}