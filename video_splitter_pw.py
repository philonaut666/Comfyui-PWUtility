import torch
import json

class VideoSplitterPW:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "images": ("IMAGE",),
                "audio": ("AUDIO",),
                "split_count": ("INT", {"default": 0, "min": 0, "max": 2, "step": 1, "tooltip": "0: No split, 1: Front only, 2: Front & Back"}),
                "split_front_point_frame": ("INT", {"default": 0, "min": 0, "max": 10000000, "step": 1}),
                "split_back_point_frame": ("INT", {"default": 0, "min": 0, "max": 10000000, "step": 1}),
                "fps": ("FLOAT", {"default": 25.000, "min": 0.001, "max": 1000.0, "step": 0.001, "tooltip": "FPS used for frame-to-time conversion to align audio."}),
            },
            "optional": {
                "split_info": ("STRING", {"forceInput": True, "tooltip": "Connect from Video Loader PW to auto split."}),
            }
        }

    # 输出顺序：Front (前), Generate (中), Back (后)
    RETURN_TYPES = ("IMAGE", "AUDIO", "INT", "IMAGE", "AUDIO", "INT", "IMAGE", "AUDIO", "INT")
    RETURN_NAMES = ("images_front", "audio_front", "frame_front", "images_generate", "audio_generate", "frame_generate", "images_back", "audio_back", "frame_back")
    FUNCTION = "split_video"
    CATEGORY = "🔮PWUtility/Video"

    def split_video(self, images, audio, split_count, split_front_point_frame, split_back_point_frame, fps, split_info=None):
        total_frames = images.shape[0]
        waveform = audio.get("waveform") if audio else None
        sample_rate = audio.get("sample_rate", 44100) if audio else 44100
        
        # 初始化默认切分点 (全段属于 Generate)
        front_start, front_end = 0, -1
        gen_start, gen_end = 0, total_frames - 1
        back_start, back_end = 0, -1
        
        use_info = False
        
        # 1. 优先尝试解析 split_info
        if split_info and split_info.strip() not in ["", "{}"]:
            try:
                info = json.loads(split_info)
                use_info = True
                
                if "split_front" in info:
                    front_start = info["split_front"].get("start_frame", 0)
                    front_end = info["split_front"].get("end_frame", -1)
                if "split_generate" in info:
                    gen_start = info["split_generate"].get("start_frame", 0)
                    gen_end = info["split_generate"].get("end_frame", total_frames - 1)
                if "split_back" in info:
                    back_start = info["split_back"].get("start_frame", 0)
                    back_end = info["split_back"].get("end_frame", -1)
            except Exception as e:
                print(f"[VideoSplitterPW] Failed to parse split_info: {e}")
                use_info = False
                
        # 2. 如果未连接 split_info，则使用手动输入的帧数参数
        if not use_info:
            if split_count == 0:
                front_start, front_end = 0, -1
                gen_start, gen_end = 0, total_frames - 1
                back_start, back_end = 0, -1
            elif split_count == 1:
                p = split_front_point_frame
                front_start, front_end = 0, p - 1
                gen_start, gen_end = p, total_frames - 1
                back_start, back_end = 0, -1
            elif split_count == 2:
                p = split_front_point_frame
                g = split_back_point_frame
                front_start, front_end = 0, p - 1
                gen_start, gen_end = p, g - 1
                back_start, back_end = g, total_frames - 1

        # 3. 定义空段占位符生成器 (防止下游节点因 0 帧报错)
        def get_empty_segment():
            empty_img = torch.zeros((1, images.shape[1], images.shape[2], images.shape[3]), dtype=images.dtype)
            samples_1f = max(1, int(round((1.0 / fps) * sample_rate)))
            empty_aud = {"waveform": torch.zeros((1, 1, samples_1f)), "sample_rate": sample_rate}
            return empty_img, empty_aud, 0

        # 4. 核心切分函数 (音画严格对齐)
        def slice_segment(start_f, end_f):
            if end_f < start_f or start_f >= total_frames:
                return get_empty_segment()
                
            s = max(0, start_f)
            e = min(end_f, total_frames - 1)
            
            seg_imgs = images[s : e + 1]
            frames = seg_imgs.shape[0]
            
            if waveform is not None and fps > 0:
                start_sec = s / fps
                end_sec = (e + 1) / fps
                start_sample = int(round(start_sec * sample_rate))
                end_sample = int(round(end_sec * sample_rate))
                
                T = waveform.shape[-1]
                start_sample = max(0, min(start_sample, T))
                end_sample = max(start_sample, min(end_sample, T))
                
                if waveform.dim() == 3:
                    seg_aud_w = waveform[:, :, start_sample:end_sample]
                elif waveform.dim() == 2:
                    seg_aud_w = waveform[:, start_sample:end_sample]
                else:
                    seg_aud_w = waveform[start_sample:end_sample]
                    
                if seg_aud_w.shape[-1] == 0:
                    samples_1f = max(1, int(round((1.0 / fps) * sample_rate)))
                    if waveform.dim() == 3:
                        seg_aud_w = torch.zeros((waveform.shape[0], waveform.shape[1], samples_1f), dtype=waveform.dtype)
                    elif waveform.dim() == 2:
                        seg_aud_w = torch.zeros((waveform.shape[0], samples_1f), dtype=waveform.dtype)
                    else:
                        seg_aud_w = torch.zeros((samples_1f,), dtype=waveform.dtype)
                        
                seg_aud = {"waveform": seg_aud_w, "sample_rate": sample_rate}
            else:
                seg_aud = audio if audio else {"waveform": torch.zeros((1, 1, 0)), "sample_rate": sample_rate}
                
            return seg_imgs, seg_aud, frames

        # 5. 执行切分
        img_f, aud_f, cnt_f = slice_segment(front_start, front_end)
        img_g, aud_g, cnt_g = slice_segment(gen_start, gen_end)
        img_b, aud_b, cnt_b = slice_segment(back_start, back_end)
        
        return (img_f, aud_f, cnt_f, img_g, aud_g, cnt_g, img_b, aud_b, cnt_b)

NODE_CLASS_MAPPINGS = {"VideoSplitterPW": VideoSplitterPW}
NODE_DISPLAY_NAME_MAPPINGS = {"VideoSplitterPW": "Video Splitter PW"}