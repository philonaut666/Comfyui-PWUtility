import torch
import json

class VideoSplitterPW:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "images": ("IMAGE",),
                "audio": ("AUDIO",),
                "fps": ("FLOAT", {"default": 25.000, "min": 0.001, "max": 1000.0, "step": 0.001, "tooltip": "FPS used for frame-to-time conversion to align audio."}),
                "split_count": ("INT", {"default": 0, "min": 0, "max": 2, "step": 1, "tooltip": "0: No split, 1: Front only, 2: Front & Back"}),
                "split_front_point_frame": ("INT", {"default": 1, "min": 1, "max": 10000000, "step": 1, "tooltip": "First frame of the Generate segment."}),
                "split_back_point_frame": ("INT", {"default": 2, "min": 2, "max": 10000000, "step": 1, "tooltip": "First frame of the Back segment. If equal to last frame, splits into 2 segments only."}),
            },
            "optional": {
                "split_info": ("STRING", {"forceInput": True, "tooltip": "Connect from Video Loader PW to auto split."}),
            }
        }

    # 输出顺序：Generate (中) -> Front (前) -> Back (后)
    RETURN_TYPES = ("IMAGE", "AUDIO", "INT", "IMAGE", "AUDIO", "INT", "IMAGE", "AUDIO", "INT")
    RETURN_NAMES = ("images_generate", "audio_generate", "frame_generate", "images_front", "audio_front", "frame_front", "images_back", "audio_back", "frame_back")
    FUNCTION = "split_video"
    CATEGORY = "🔮PWUtility/Video"

    def split_video(self, images, audio, fps, split_count, split_front_point_frame, split_back_point_frame, split_info=None):
        total_frames = images.shape[0]
        waveform = audio.get("waveform") if audio else None
        sample_rate = audio.get("sample_rate", 44100) if audio else 44100
        end_frame_idx = max(0, total_frames - 1)
        
        # 1. 定义空段占位符生成器 (防止下游节点因 0 帧报错)
        def get_empty_segment():
            empty_img = torch.zeros((1, images.shape[1], images.shape[2], images.shape[3]), dtype=images.dtype)
            samples_1f = max(1, int(round((1.0 / fps) * sample_rate))) if fps > 0 else 1
            empty_aud = {"waveform": torch.zeros((1, 1, samples_1f)), "sample_rate": sample_rate}
            return empty_img, empty_aud, 0

        # 2. 判断 split_info 是否包含有效的分割信息
        use_info = False
        info_has_split = False
        
        if split_info and split_info.strip() not in ["", "{}"]:
            try:
                info = json.loads(split_info)
                use_info = True
                if "split_front" in info or "split_generate" in info or "split_back" in info:
                    info_has_split = True
            except Exception as e:
                print(f"[VideoSplitterPW] Failed to parse split_info: {e}")
                use_info = False

        # 3. 优先尝试解析 split_info (只要有分割信息，无论 split_count 为何值都按 info 切分)
        if use_info and info_has_split:
            if "split_front" in info:
                front_start = info["split_front"].get("start_frame", 0)
                front_end = info["split_front"].get("end_frame", -1)
            else:
                front_start, front_end = 0, -1

            if "split_generate" in info:
                gen_start = info["split_generate"].get("start_frame", 0)
                gen_end = info["split_generate"].get("end_frame", end_frame_idx)
            else:
                gen_start, gen_end = 0, end_frame_idx

            if "split_back" in info:
                back_start = info["split_back"].get("start_frame", 0)
                back_end = info["split_back"].get("end_frame", -1)
            else:
                back_start, back_end = 0, -1
                
        # 4. 如果未连接 split_info 或 split_info 为 {}，则使用手动输入的帧数参数
        else:
            if split_count == 0:
                # 直通输出：全段属于 generate，front 和 back 为空占位符
                img_f, aud_f, cnt_f = get_empty_segment()
                img_b, aud_b, cnt_b = get_empty_segment()
                return (images, audio, total_frames, img_f, aud_f, cnt_f, img_b, aud_b, cnt_b)
                
            elif split_count == 1:
                p = split_front_point_frame
                # 边界限制：不可小于1，不可大于视频的结束帧
                p = max(1, min(p, end_frame_idx))
                
                # 分割点 p 属于 split_generate 的首帧
                front_start, front_end = 0, p - 1
                gen_start, gen_end = p, end_frame_idx
                back_start, back_end = 0, -1
                
            elif split_count == 2:
                p = split_front_point_frame
                g = split_back_point_frame
                
                # 【边界限制】：g 最大允许等于视频的最后一帧 index
                g = min(g, end_frame_idx)
                
                if g == end_frame_idx:
                    # 【情况 A】：当 g 等于最后一帧时，忽略 g 的计算，退化为只被 p 分为两段
                    p = max(1, min(p, end_frame_idx))
                    front_start, front_end = 0, p - 1
                    gen_start, gen_end = p, end_frame_idx
                    back_start, back_end = 0, -1 # back 段为空
                else:
                    # 【情况 B】：g < end_frame_idx，正常分为三段
                    # 限制 p 必须小于 g，且 p >= 1
                    p = max(1, min(p, g - 1))
                    
                    # 极端情况兜底：如果视频太短，导致数学上无法保证 p < g
                    if g <= p:
                        g = p + 1
                        # 如果强制后 g 又等于或超过了 end_frame_idx，则再次退化为两段
                        if g >= end_frame_idx:
                            g = end_frame_idx
                            front_start, front_end = 0, p - 1
                            gen_start, gen_end = p, end_frame_idx
                            back_start, back_end = 0, -1
                        else:
                            front_start, front_end = 0, p - 1
                            gen_start, gen_end = p, g - 1
                            back_start, back_end = g, end_frame_idx
                    else:
                        front_start, front_end = 0, p - 1
                        gen_start, gen_end = p, g - 1
                        back_start, back_end = g, end_frame_idx

        # 5. 核心切分函数 (音画严格对齐，保持两位小数精度)
        def slice_segment(start_f, end_f):
            if end_f < start_f or start_f >= total_frames:
                return get_empty_segment()
                
            s = max(0, start_f)
            e = min(end_f, end_frame_idx)
            
            seg_imgs = images[s : e + 1]
            frames = seg_imgs.shape[0]
            
            if waveform is not None and fps > 0:
                # 【精度控制】：强制保留两位小数进行运算，避免浮点数溢出导致的音画错位
                start_sec = round(s / fps, 2)
                end_sec = round((e + 1) / fps, 2)
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

        # 6. 执行切分
        img_f, aud_f, cnt_f = slice_segment(front_start, front_end)
        img_g, aud_g, cnt_g = slice_segment(gen_start, gen_end)
        img_b, aud_b, cnt_b = slice_segment(back_start, back_end)
        
        # 按照新的顺序返回：Generate -> Front -> Back
        return (img_g, aud_g, cnt_g, img_f, aud_f, cnt_f, img_b, aud_b, cnt_b)

NODE_CLASS_MAPPINGS = {"VideoSplitterPW": VideoSplitterPW}
NODE_DISPLAY_NAME_MAPPINGS = {"VideoSplitterPW": "Video Splitter PW"}