from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from .video_loader_pw import NODE_CLASS_MAPPINGS as VIDEO_LOADER_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS as VIDEO_LOADER_DISPLAY
from .video_info_pw import NODE_CLASS_MAPPINGS as VIDEO_INFO_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS as VIDEO_INFO_DISPLAY
from .audio_loader_pw import AudioLoaderPW
from .ImageLoaderPW import NODE_CLASSES as IMAGE_LOADER_PW_CLASSES

# ==========================================
# V1 传统节点注册
# ==========================================
NODE_CLASS_MAPPINGS.update(VIDEO_LOADER_MAPPINGS)
NODE_CLASS_MAPPINGS.update(VIDEO_INFO_MAPPINGS)
NODE_CLASS_MAPPINGS["Audio Loader PW"] = AudioLoaderPW

NODE_DISPLAY_NAME_MAPPINGS.update(VIDEO_LOADER_DISPLAY)
NODE_DISPLAY_NAME_MAPPINGS.update(VIDEO_INFO_DISPLAY)
NODE_DISPLAY_NAME_MAPPINGS["Audio Loader PW"] = "Audio Loader PW"

# ==========================================
# V3 API 节点注册 (ComfyUI V3 Architecture)
# ==========================================
NODE_CLASSES = []
NODE_CLASSES.extend(IMAGE_LOADER_PW_CLASSES)

# ==========================================
# 前端 Web 目录配置
# ==========================================
WEB_DIRECTORY = "./web" 

# ==========================================
# 模块导出列表
# ==========================================
__all__ = [
    "NODE_CLASS_MAPPINGS", 
    "NODE_DISPLAY_NAME_MAPPINGS", 
    "NODE_CLASSES",
    "WEB_DIRECTORY"
]
