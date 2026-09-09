import os
import torch
import numpy as np
from PIL import Image

class MediaUnpackPW:
    """
    将 MiniMax H3 Media Preview PW 节点输出的 media pack 进行解包。
    - 空槽位返回 None，下游节点视为无数据/未连接。
    - 图片直接从原路径读取，保持原始分辨率和比例。
    """
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "media_pack": ("PW_MEDIA_PACK",),
            }
        }
    
    RETURN_TYPES = (
        # 9 个图片
        "IMAGE", "IMAGE", "IMAGE", "IMAGE", "IMAGE", "IMAGE", "IMAGE", "IMAGE", "IMAGE",
        # 3 个视频画面 (image batch)
        "IMAGE", "IMAGE", "IMAGE",
        # 3 个视频音频
        "AUDIO", "AUDIO", "AUDIO",
        # 3 个独立音频
        "AUDIO", "AUDIO", "AUDIO",
    )
    RETURN_NAMES = (
        "image0", "image1", "image2", "image3", "image4", "image5", "image6", "image7", "image8",
        "video_imgs0", "video_imgs1", "video_imgs2",
        "video_audio0", "video_audio1", "video_audio2",
        "audio0", "audio1", "audio2",
    )
    FUNCTION = "unpack"
    CATEGORY = "🔮PWUtility/Media"
    OUTPUT_NODE = False
    
    def unpack(self, media_pack):
        # 初始化 18 个输出为 None。
        # 在 ComfyUI 中，返回 None 代表该端口无数据输出，下游节点会将其视为未连接或无数据。
        results = [None] * 18
        
        if not isinstance(media_pack, dict):
            return tuple(results)
        
        # ==========================================
        # 1. 处理图片 image0~image8 (索引 0-8)
        # 需求：输出原图，不使用 media_pack 中已缩放和 pad 的 tensor
        # ==========================================
        images = media_pack.get("images", [])
        if isinstance(images, list):
            for i, img_item in enumerate(images[:9]):
                if isinstance(img_item, dict):
                    path = img_item.get("path")
                    # 直接从原路径读取原图，保持原始分辨率和比例
                    if path and os.path.exists(path):
                        try:
                            with Image.open(path) as img:
                                img = img.convert("RGB")
                                img_array = np.array(img).astype(np.float32) / 255.0
                                tensor = torch.from_numpy(img_array)[None, ] # Shape: (1, H, W, 3)
                                results[i] = tensor
                        except Exception as e:
                            print(f"[MediaUnpackPW] Failed to load original image {path}: {e}")
        
        # ==========================================
        # 2. 处理视频 video_imgs0~video_imgs2 和 video_audio0~video_audio2
        # ==========================================
        videos = media_pack.get("videos", [])
        if isinstance(videos, list):
            for i, vid_item in enumerate(videos[:3]):
                if isinstance(vid_item, dict) and "video" in vid_item:
                    video_obj = vid_item["video"]
                    try:
                        # 使用 ComfyUI 官方 API 提取视频组件
                        components = video_obj.get_components()
                        
                        # video_imgs 索引 9-11
                        if hasattr(components, 'images') and components.images is not None:
                            results[9 + i] = components.images
                        
                        # video_audio 索引 12-14
                        if hasattr(components, 'audio') and components.audio is not None:
                            audio_obj = components.audio
                            # 兼容 AudioInput 对象 (V3 API) 和 dict (V1 API)
                            if hasattr(audio_obj, 'waveform') and hasattr(audio_obj, 'sample_rate'):
                                results[12 + i] = {
                                    "waveform": audio_obj.waveform,
                                    "sample_rate": audio_obj.sample_rate
                                }
                            elif isinstance(audio_obj, dict):
                                results[12 + i] = audio_obj
                    except Exception as e:
                        print(f"[MediaUnpackPW] Failed to extract video components for video {i}: {e}")
        
        # ==========================================
        # 3. 处理独立音频 audio0~audio2 (索引 15-17)
        # ==========================================
        audios = media_pack.get("audio", [])
        if isinstance(audios, list):
            for i, aud_item in enumerate(audios[:3]):
                if isinstance(aud_item, dict) and "audio" in aud_item:
                    audio_data = aud_item["audio"]
                    if isinstance(audio_data, dict) and "waveform" in audio_data and "sample_rate" in audio_data:
                        results[15 + i] = audio_data
                        
        return tuple(results)


NODE_CLASS_MAPPINGS = {
    "MediaUnpackPW": MediaUnpackPW
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MediaUnpackPW": "Media Unpack PW"
}