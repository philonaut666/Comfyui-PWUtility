class GroupSwitchADV:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {},
            "optional": {},
            # 【核心修复 1】加入 hidden 字段，确保 ComfyUI 触发完整的序列化生命周期
            "hidden": {
                "unique_id": "UNIQUE_ID"
            }
        }

    RETURN_TYPES = ()
    FUNCTION = "do_nothing"
    CATEGORY = "🔮PWUtility/Group"

    def do_nothing(self, **kwargs):
        return ()

NODE_CLASS_MAPPINGS = {
    "GroupSwitchADV": GroupSwitchADV,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GroupSwitchADV": "Group Switch ADV",
}