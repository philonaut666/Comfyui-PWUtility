import torch
import json

class VideoSpliterPW:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "images": ("IMAGE",),
                "audio": ("AUDIO",),
                "split_info": ("STRING", {"forceInput": True}),
                "fps": ("FLOAT", {
                    "default": 25.000, 
                    "min": 0.001, 
                    "max": 1000.0, 
                    "step": 0.001,
                    "tooltip": "FPS used for frame-to-time conversion to align audio."
                }),
            }
        }

    RETURN_TYPES = ("IMAGE", "AUDIO", "INT", "IMAGE", "AUDIO", "INT")
    RETURN_NAMES = ("images1", "audio1", "frames1", "images2", "audio2", "frames2")
    FUNCTION = "split_video"
    CATEGORY = "🔮PWUtility/Video"

    def split_video(self, images, audio, split_info, fps):
        total_frames = images.shape[0]
        
        # 1. 解析分割点
        if not split_info or split_info.strip() == "{}":
            # 如果没有开启分割模式，则全部归入第一段
            cut_point = total_frames
        else:
            try:
                info = json.loads(split_info)
                split_idx = int(info.get("split_frame", 0))
                # 核心逻辑：分割点归属于第一段视频，因此第一段包含 split_idx 这一帧
                # cut_point 代表第一段视频拥有的总帧数
                cut_point = split_idx + 1
            except Exception as e:
                print(f"[VideoSpliterPW] Failed to parse split_info: {e}")
                cut_point = total_frames
                
        # 限制边界，防止越界
        cut_point = max(0, min(cut_point, total_frames))
        
        # 2. 视频分割
        images1 = images[:cut_point]
        images2 = images[cut_point:]
        
        frames1 = images1.shape[0]
        frames2 = images2.shape[0]
        
        # 防止空 Tensor (0帧) 导致下游部分节点报错，补充一帧黑场占位（但输出的 frames 仍为真实帧数 0）
        if images1.shape[0] == 0:
            images1 = torch.zeros((1, images.shape[1], images.shape[2], images.shape[3]), dtype=images.dtype)
        if images2.shape[0] == 0:
            images2 = torch.zeros((1, images.shape[1], images.shape[2], images.shape[3]), dtype=images.dtype)
            
        # 3. 音频分割 (基于帧数与 FPS 精确对齐采样点)
        waveform = audio.get("waveform")
        sample_rate = audio.get("sample_rate", 44100)
        
        if waveform is not None and fps > 0:
            # 第一段的时长(秒) = 第一段帧数 / FPS
            duration1_sec = cut_point / fps
            # 计算对应的音频采样点数量
            samples1 = int(round(duration1_sec * sample_rate))
            
            # 兼容 ComfyUI 音频张量维度 (B, C, T) 或 (C, T)
            if waveform.dim() == 3:
                T = waveform.shape[2]
                samples1 = min(samples1, T)
                wave1 = waveform[:, :, :samples1]
                wave2 = waveform[:, :, samples1:]
            elif waveform.dim() == 2:
                T = waveform.shape[1]
                samples1 = min(samples1, T)
                wave1 = waveform[:, :samples1]
                wave2 = waveform[:, samples1:]
            else:
                wave1 = waveform
                wave2 = waveform[:, :0]
                
            audio1 = {"waveform": wave1, "sample_rate": sample_rate}
            audio2 = {"waveform": wave2, "sample_rate": sample_rate}
        else:
            # 降级处理
            audio1 = audio
            audio2 = {"waveform": torch.zeros((1, 1, 0)), "sample_rate": sample_rate}
            
        return (images1, audio1, frames1, images2, audio2, frames2)

NODE_CLASS_MAPPINGS = {"VideoSpliterPW": VideoSpliterPW}
NODE_DISPLAY_NAME_MAPPINGS = {"VideoSpliterPW": "Video Spliter PW"}