from server import PromptServer

# 参考 C_viewIO.py 中的 updateTextWidget 实现，用于实时同步前端 Widget
def updateTextWidget(node, widget, text):
    PromptServer.instance.send_sync("view_Data_text_processed", {"node": node, "widget": widget, "text": text})

class TextBridgePW:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                # 连线输入端口
                "text": ("STRING", {"forceInput": True}),
                # UI 上的多行文本框，用于展示和手动编辑
                "display": ("STRING", {"default": "", "multiline": True}),
                # 【新增】强制更新开关（充当按钮）
                "force_update": ("BOOLEAN", {
                    "default": False, 
                    "label_on": "Force Update", 
                    "label_off": " "
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    OUTPUT_NODE = True
    FUNCTION = "process"
    CATEGORY = "🔮PWUtility/Utility"

    def __init__(self):
        self.last_text = None
        # 标记是否是首次执行（解决第一次无显示问题）
        self.is_first_run = True

    def process(self, text=None, display="", force_update=False, unique_id=None):
        # 兼容 ComfyUI 有时会将 optional 参数作为 list 传入的情况
        if isinstance(text, list):
            current_text = text[0] if text else None
        else:
            current_text = text

        # 判断是否有实际的连线输入 
        has_input = current_text is not None

        if self.is_first_run:
            self.is_first_run = False
            if has_input:
                input_text = current_text
                self.last_text = current_text
            else:
                # 首次运行且无输入，使用 display 的默认值或手动修改值
                input_text = display if display else ""
                self.last_text = None
        else:
            # 【核心逻辑】如果强制更新开关被打开
            if force_update:
                if has_input:
                    # 强制使用输入端的最新文本，并更新历史记录
                    input_text = current_text
                    self.last_text = current_text
                else:
                    # 如果没连线，强制更新无意义，保留当前 display
                    input_text = display
            else:
                # 正常模式：无数据输入时保留 display
                if not has_input:
                    input_text = display
                else:
                    # 有数据输入时，判断是否变化
                    if current_text == self.last_text:
                        # 输入没变化，使用 UI 上手动修改的 display
                        input_text = display
                    else:
                        # 输入有变化，使用新的输入
                        input_text = current_text
                        self.last_text = current_text

        displayText = self.render(input_text)
        
        # 同步前端 Widget (复用 view_Data_text_processed 事件，兼容现有前端 JS)
        if unique_id is not None:
            updateTextWidget(unique_id, "display", displayText)
            
        # 返回结果并更新 UI
        return {"ui": {"display": displayText}, "result": (input_text,)}

    def render(self, input_val):
        if not isinstance(input_val, list):
            return str(input_val) if input_val is not None else ""
        listLen = len(input_val)
        if listLen == 0:
            return ""
        if listLen == 1:
            return str(input_val[0])
        result = "List:\n"
        for i, element in enumerate(input_val):
            result += f">>{i}<< {element}\n"
        return result

# 节点映射
NODE_CLASS_MAPPINGS = {
    "Text Bridge PW": TextBridgePW
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "Text Bridge PW": "Text Bridge PW"
}