import torch

class RemoveVideoFromEndPW:
    """
    从视频和音频的末尾移除指定数量的帧/采样。
    """
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "fps": ("FLOAT", {
                    "default": 30.0, 
                    "min": 0.01, 
                    "max": 1000.0, 
                    "step": 0.001, 
                    "round": 0.001,
                    "display": "number"
                }),
            },
            "optional": {
                "audio": ("AUDIO",),
                "n_frame_from_end": ("INT", {
                    "default": 0, 
                    "min": 0, 
                    "max": 999999, 
                    "step": 1
                }),
            }
        }

    RETURN_TYPES = ("IMAGE", "AUDIO")
    RETURN_NAMES = ("images", "audio")
    FUNCTION = "remove_from_end"
    CATEGORY = "🔮PWUtility/Video"

    def remove_from_end(self, images, fps, audio=None, n_frame_from_end=0):
        # 如果 n_frame_from_end 为 0、None 或负数，直接跳过计算并原样输出
        if not n_frame_from_end or n_frame_from_end <= 0:
            return (images, audio)

        # --- 处理视频 (Images) ---
        num_frames = images.shape[0]
        # 确保至少保留 1 帧视频，防止张量变空导致报错
        frames_to_remove = min(int(n_frame_from_end), max(0, num_frames - 1))

        if frames_to_remove > 0:
            images_out = images[:-frames_to_remove]
        else:
            images_out = images

        # --- 处理音频 (Audio) ---
        audio_out = audio
        if audio is not None:
            sample_rate = audio.get("sample_rate", 44100)
            waveform = audio.get("waveform")

            if waveform is not None and fps > 0:
                # 根据 fps 计算需要移除的音频时间（秒）
                duration_to_remove = frames_to_remove / fps
                # 根据采样率计算需要移除的精确采样数
                samples_to_remove = int(round(duration_to_remove * sample_rate))

                if samples_to_remove > 0:
                    num_samples = waveform.shape[-1]
                    # 确保至少保留 1 个音频采样点
                    actual_samples_to_remove = min(samples_to_remove, max(0, num_samples - 1))

                    if actual_samples_to_remove > 0:
                        # 兼容 ComfyUI 不同版本的 Audio Tensor 维度 (通常为 3D: [batch, channels, samples])
                        if waveform.dim() == 3:
                            trimmed_waveform = waveform[:, :, :-actual_samples_to_remove]
                        elif waveform.dim() == 2:
                            trimmed_waveform = waveform[:, :-actual_samples_to_remove]
                        else:
                            trimmed_waveform = waveform[:-actual_samples_to_remove]

                        audio_out = {
                            "waveform": trimmed_waveform,
                            "sample_rate": sample_rate
                        }

        return (images_out, audio_out)