class TextBridgePW:
    # 类级别字典，用于存储每个节点的历史输入状态，以 unique_id 为键
    node_states = {}

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 这是一个可编辑的 Widget，用于展示和手动修改文本
                "text": ("STRING", {
                    "multiline": True, 
                    "default": "", 
                    "dynamicPrompts": False
                }),
            },
            "optional": {
                # 输入端口，用于接收外部连线
                "input_text": ("STRING", {"forceInput": True}),
            },
            "hidden": {
                # ComfyUI 官方支持的隐藏参数，用于获取节点在前端的唯一 ID
                "unique_id": "UNIQUE_ID"
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "bridge_text"
    CATEGORY = "🔮PWUtility/Utility"

    def bridge_text(self, text, unique_id=None, **kwargs):
        # 获取可选的输入端口数据，如果没有连线则为 None
        input_text = kwargs.get('input_text', None)
        
        if unique_id is None:
            unique_id = "default"
            
        # 获取当前节点的历史状态
        state = self.node_states.get(unique_id, {"last_input": None})
        last_input = state.get("last_input")
        
        # 核心逻辑：只有当有数据输入，且输入的数据与上一次不同时，才覆盖当前文本
        if input_text is not None:
            if last_input != input_text:
                text = input_text
            # 更新历史记录为当前输入
            state["last_input"] = input_text
        else:
            # 如果没有数据输入（断开连线），则什么都不做，保留当前的 text 和 last_input
            pass
            
        # 保存状态
        self.node_states[unique_id] = state
        
        return (text,)

# 节点映射
NODE_CLASS_MAPPINGS = {
    "Text Bridge PW": TextBridgePW
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "Text Bridge PW": "Text Bridge PW"
}