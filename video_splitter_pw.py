import torch
import json

class VideoSplitterPW:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "images": ("IMAGE",),
                "fps": ("FLOAT", {"default": 25.000, "min": 0.001, "max": 1000.0, "step": 0.001, "tooltip": "FPS used for frame-to-time conversion to align audio."}),
                "split_count": ("INT", {"default": 0, "min": 0, "max": 2, "step": 1, "tooltip": "0: No split, 1: Front only, 2: Front & Back"}),
                "align_8n_1": ("BOOLEAN", {"default": True, "label_on": "8n+1", "label_off": "8n+1", "tooltip": "Align split_generate frames to 8n+1 standard by borrowing frames from front/back."}),
                "split_front_point_idx": ("INT", {"default": 1, "min": 0, "max": 10000000, "step": 1, "tooltip": "First frame index of the Generate segment."}),
                "split_back_point_idx": ("INT", {"default": 2, "min": -10000000, "max": 10000000, "step": 1, "tooltip": "First frame index of the Back segment. Negative values count from the end."}),
            },
            "optional": {
                "audio": ("AUDIO",),
                "split_info": ("STRING", {"forceInput": True, "tooltip": "Connect from Video Loader PW to auto split."}),
            }
        }

    RETURN_TYPES = ("IMAGE", "AUDIO", "INT", "IMAGE", "AUDIO", "INT", "IMAGE", "AUDIO", "INT")
    RETURN_NAMES = ("images_generate", "audio_generate", "frame_generate", "images_front", "audio_front", "frame_front", "images_back", "audio_back", "frame_back")
    FUNCTION = "split_video"
    CATEGORY = "🔮PWUtility/Video"

    def split_video(self, images, fps, split_count, align_8n_1, split_front_point_idx, split_back_point_idx, audio=None, split_info=None):
        total_frames = images.shape[0]
        
        has_audio = audio is not None and isinstance(audio, dict) and "waveform" in audio and audio["waveform"] is not None
        waveform = audio.get("waveform") if has_audio else None
        sample_rate = audio.get("sample_rate", 44100) if has_audio else 44100
        end_frame_idx = max(0, total_frames - 1)
        
        def get_empty_segment():
            empty_img = torch.zeros((1, images.shape[1], images.shape[2], images.shape[3]), dtype=images.dtype)
            empty_aud = None
            return empty_img, empty_aud, 0

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
                
        else:
            if split_count == 0:
                img_f, aud_f, cnt_f = get_empty_segment()
                img_b, aud_b, cnt_b = get_empty_segment()
                return (images, audio, total_frames, img_f, aud_f, cnt_f, img_b, aud_b, cnt_b)
                
            elif split_count == 1:
                p = split_front_point_idx
                if p < 1:
                    raise ValueError(f"边界约束违反: split_front_point_idx ({p}) 不可小于 1。")
                if p > end_frame_idx:
                    raise ValueError(f"边界约束违反: split_front_point_idx ({p}) 不可大于视频最后一帧的索引 ({end_frame_idx})。")
                
                front_start, front_end = 0, p - 1
                gen_start, gen_end = p, end_frame_idx
                back_start, back_end = 0, -1
                
            elif split_count == 2:
                p = split_front_point_idx
                g = split_back_point_idx
                
                if g < 0:
                    g = total_frames + g
                
                if p < 1:
                    raise ValueError(f"边界约束违反: split_front_point_idx ({p}) 不可小于 1。")
                if g <= p:
                    raise ValueError(f"边界约束违反: split_back_point_idx (原始值: {split_back_point_idx}, 转换后: {g}) 必须严格大于 split_front_point_idx ({p})。")
                if g > end_frame_idx:
                    raise ValueError(f"边界约束违反: split_back_point_idx (原始值: {split_back_point_idx}, 转换后: {g}) 不可大于视频最后一帧的索引 ({end_frame_idx})。")
                
                if g == end_frame_idx:
                    front_start, front_end = 0, p - 1
                    gen_start, gen_end = p, end_frame_idx
                    back_start, back_end = 0, -1 
                else:
                    front_start, front_end = 0, p - 1
                    gen_start, gen_end = p, g - 1
                    back_start, back_end = g, end_frame_idx

            # 【8n+1 对齐逻辑】仅在手动切分时生效
            if align_8n_1 and split_count > 0:
                gen_frames = gen_end - gen_start + 1
                if gen_frames < 1:
                    target_frames = 1
                else:
                    # 计算大于等于当前帧数且最近的 8n+1 目标帧数
                    target_frames = ((gen_frames + 6) // 8) * 8 + 1
                    
                diff = target_frames - gen_frames
                
                if diff > 0:
                    if split_count == 1:
                        front_frames = front_end - front_start + 1
                        if front_frames < diff:
                            raise ValueError(f"8n+1 对齐失败: split_front 可用帧数 ({front_frames}) 不足以提供所需的 {diff} 帧。")
                        # 从 front 末尾拿 diff 帧给 generate 前端
                        gen_start -= diff
                        front_end -= diff
                        
                    elif split_count == 2:
                        back_frames = back_end - back_start + 1
                        if back_frames < diff:
                            raise ValueError(f"8n+1 对齐失败: split_back 可用帧数 ({back_frames}) 不足以提供所需的 {diff} 帧。")
                        # 从 back 开头拿 diff 帧给 generate 后端
                        gen_end += diff
                        back_start += diff

        def slice_segment(start_f, end_f):
            if end_f < start_f or start_f >= total_frames:
                return get_empty_segment()
                
            s = max(0, start_f)
            e = min(end_f, end_frame_idx)
            
            seg_imgs = images[s : e + 1]
            frames = seg_imgs.shape[0]
            
            if has_audio and waveform is not None and fps > 0:
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
                seg_aud = None
                
            return seg_imgs, seg_aud, frames

        img_f, aud_f, cnt_f = slice_segment(front_start, front_end)
        img_g, aud_g, cnt_g = slice_segment(gen_start, gen_end)
        img_b, aud_b, cnt_b = slice_segment(back_start, back_end)
        
        return (img_g, aud_g, cnt_g, img_f, aud_f, cnt_f, img_b, aud_b, cnt_b)

NODE_CLASS_MAPPINGS = {"VideoSplitterPW": VideoSplitterPW}
NODE_DISPLAY_NAME_MAPPINGS = {"VideoSplitterPW": "Video Splitter PW"}