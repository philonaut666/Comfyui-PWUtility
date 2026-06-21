import os
import torch
import numpy as np
import folder_paths
import av
import json
import math
from server import PromptServer
from aiohttp import web
import comfy.utils

@PromptServer.instance.routes.get("/video_ui_custom_view")
async def custom_view(request):
    file_path = request.query.get("filename", "")
    if os.path.exists(file_path) and os.path.isfile(file_path):
        return web.FileResponse(file_path)
    return web.Response(status=404, text="File not found")

@PromptServer.instance.routes.post("/video_ui_upload_chunk")
async def upload_chunk(request):
    post = await request.post()
    file = post.get("file")
    filename = post.get("filename")
    chunk_index = int(post.get("chunk_index"))
    total_chunks = int(post.get("total_chunks"))
    upload_dir = folder_paths.get_input_directory()
    file_path = os.path.join(upload_dir, filename)
    mode = "ab" if chunk_index > 0 else "wb"
    with open(file_path, mode) as f:
        f.write(file.file.read())
    if chunk_index == total_chunks - 1:
        return web.json_response({"name": filename})
    return web.json_response({"status": "ok"})

class VideoLoaderPW:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "video": ("STRING", {"default": ""}),
                "start_time": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100000.0, "step": 0.01}),
                "end_time": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100000.0, "step": 0.01}),
                "start_frame": ("INT", {"default": 0, "min": 0, "max": 10000000, "step": 1}),
                "end_frame": ("INT", {"default": 0, "min": 0, "max": 10000000, "step": 1, "tooltip": "0 means to the end"}),
                "frame_rate": ("FLOAT", {"default": 25.0, "min": 1.0, "max": 120.0, "step": 0.1, "tooltip": "Force the video to a specific frame rate for extraction."}),
                "display_mode": (["seconds", "frames"], {"default": "frames"}),
                "crop_x": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.001}),
                "crop_y": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.001}),
                "crop_w": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.001}),
                "crop_h": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.001}),
                "align_8n+1": ("BOOLEAN", {"default": True, "tooltip": "Align generate segment to 8n+1 frames by adjusting split points or repeating end frames."}),
                "split_count": ("INT", {"default": 0, "min": 0, "max": 2, "step": 1, "tooltip": "0: No split, 1: Purple only, 2: Purple & Green"}),
                "split_purple_point": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100000.0, "step": 0.01}),
                "split_purple_point_idx": ("INT", {"default": 0, "min": 0, "max": 10000000, "step": 1}),
                "split_green_point": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100000.0, "step": 0.01}),
                "split_green_point_idx": ("INT", {"default": 0, "min": 0, "max": 10000000, "step": 1}),
                "select_generate": (["blue", "purple"], {"default": "blue", "tooltip": "Which segment to use as generate when split_count=1"}),
            },
            "optional": {
                "path": ("STRING", {"forceInput": True, "tooltip": "Path from LocalMedia Manager to auto-load video"}),
            }
        }

    RETURN_TYPES = ("IMAGE", "AUDIO", "INT", "FLOAT", "FLOAT", "STRING", "INT", "STRING")
    RETURN_NAMES = ("images", "audio", "frame_count", "duration", "fps", "video_info", "repeat_last_frame_count", "split_info")
    FUNCTION = "load_video"
    CATEGORY = "🔮PWUtility/Video"

    def load_video(self, video, frame_rate, display_mode, start_time, end_time, start_frame, end_frame, crop_x=0.0, crop_y=0.0, crop_w=1.0, crop_h=1.0, split_count=0, split_purple_point=0.0, split_purple_point_idx=0, split_green_point=0.0, split_green_point_idx=0, select_generate="blue", path=None, **kwargs):
        align_8n_plus_1 = kwargs.get("align_8n+1", True)
        video_to_load = path.strip() if (path and isinstance(path, str) and path.strip()) else video

        if not video_to_load:
            empty_image = torch.zeros((1, 512, 512, 3), dtype=torch.float32)
            return {"ui": {"video_path": [""], "video_info": ["{}"]}, "result": (empty_image, None, 0, 0.0, float(frame_rate), "{}", 0, "{}")}

        video_path = video_to_load
        if not os.path.exists(video_path):
            video_path_annotated = folder_paths.get_annotated_filepath(video_to_load)
            if os.path.exists(video_path_annotated):
                video_path = video_path_annotated
            else:
                video_path_input = os.path.join(folder_paths.get_input_directory(), video_to_load)
                if os.path.exists(video_path_input):
                    video_path = video_path_input
                else:
                    raise FileNotFoundError(f"Video file not found: {video_to_load}")

        container = av.open(video_path)
        video_stream = container.streams.video[0] if len(container.streams.video) > 0 else None
        video_duration = 0
        if video_stream and video_stream.duration and video_stream.time_base:
            video_duration = float(video_stream.duration * video_stream.time_base)

        orig_w = video_stream.codec_context.width if video_stream else 512
        orig_h = video_stream.codec_context.height if video_stream else 512

        source_fps = 0.0
        if video_stream:
            avg_rate = getattr(video_stream, 'average_rate', None) or getattr(video_stream, 'guessed_rate', None)
            if avg_rate:
                source_fps = float(avg_rate)
        source_frame_count = int(video_stream.frames) if video_stream and video_stream.frames else 0
        source_duration = video_duration

        try:
            from av.video.reformatter import Colorspace, ColorRange
            fallback_cs = Colorspace.ITU709 if max(orig_w, orig_h) >= 720 else Colorspace.ITU601
            fallback_cr = ColorRange.MPEG
            dst_range = ColorRange.JPEG
        except ImportError:
            fallback_cs = "itu709" if max(orig_w, orig_h) >= 720 else "itu601"
            fallback_cr = "mpeg"
            dst_range = "jpeg"
            
        src_colorspace = fallback_cs
        src_color_range = fallback_cr
        
        if video_stream and video_stream.codec_context:
            cc = video_stream.codec_context
            c_space = getattr(cc, 'colorspace', getattr(cc, 'color_space', None))
            if c_space and hasattr(c_space, 'name') and c_space.name != "UNSPECIFIED":
                src_colorspace = c_space
            elif c_space and isinstance(c_space, str) and "unspecified" not in c_space.lower():
                src_colorspace = c_space
                
            c_range = getattr(cc, 'color_range', None)
            if c_range and hasattr(c_range, 'name') and c_range.name != "UNSPECIFIED":
                src_color_range = c_range
            elif c_range and isinstance(c_range, str) and "unspecified" not in c_range.lower():
                src_color_range = c_range

        manual_crop_left = int(orig_w * crop_x)
        manual_crop_top = int(orig_h * crop_y)
        manual_crop_right = orig_w - int(orig_w * (crop_x + crop_w))
        manual_crop_bottom = orig_h - int(orig_h * (crop_y + crop_h))
        
        manual_crop_left = max(0, min(manual_crop_left, orig_w - 1))
        manual_crop_top = max(0, min(manual_crop_top, orig_h - 1))
        manual_crop_right = max(0, min(manual_crop_right, orig_w - manual_crop_left - 1))
        manual_crop_bottom = max(0, min(manual_crop_bottom, orig_h - manual_crop_top - 1))

        fr = float(frame_rate) if frame_rate > 0 else 25.0
        
        s_frame_0 = max(0, start_frame)
        e_frame_0 = end_frame if end_frame > 0 else 0
        
        if display_mode == "frames":
            actual_start_time = float(s_frame_0) / fr
            actual_end_time = float(e_frame_0 + 1) / fr if e_frame_0 > 0 else video_duration
        else:
            actual_start_time = start_time
            actual_end_time = end_time if (end_time > 0 and end_time > start_time) else video_duration

        if actual_end_time <= 0:
            actual_end_time = float('inf')

        # FIX 1: 修复 target_frame_count 计算逻辑
        target_frame_count = -1
        if display_mode == "frames":
            if end_frame > 0:
                target_frame_count = end_frame - start_frame + 1
                if target_frame_count < 0: 
                    target_frame_count = 0

        frames = []
        image_tensor = None
        frames_loaded = 0
        
        if video_stream:
            video_stream.thread_type = "AUTO"
            if video_stream.time_base:
                seek_pts = int(actual_start_time / float(video_stream.time_base))
            else:
                seek_pts = int(actual_start_time * av.time_base)
            
            container.seek(seek_pts, stream=video_stream, backward=True)
            
            frame_interval = 1.0 / fr
            expected_target_time = actual_start_time
            
            alloc_end_time = actual_end_time if actual_end_time != float('inf') else video_duration
            expected_frames = 0
            if alloc_end_time > 0:
                duration_to_extract = alloc_end_time - actual_start_time
                if duration_to_extract > 0:
                    expected_frames = int(np.ceil(duration_to_extract / frame_interval)) + 2
                    
            pbar = comfy.utils.ProgressBar(expected_frames) if expected_frames > 0 else None

            for frame in container.decode(video_stream):
                frame_time = frame.time
                if frame_time is None:
                    frame_time = float(frame.pts * float(video_stream.time_base)) if frame.pts and video_stream.time_base else 0.0

                if frame_time < actual_start_time - 1e-5:
                    continue
                    
                if actual_end_time != float('inf') and frame_time >= actual_end_time - 1e-5:
                    break
                    
                try:
                    frame = frame.reformat(
                        format="rgb24",
                        src_colorspace=src_colorspace,
                        src_color_range=src_color_range,
                        dst_color_range=dst_range
                    )
                    frame_rgb = frame.to_ndarray(format='rgb24')
                except Exception as e:
                    print(f"[VideoLoaderPW] Color reformat failed, using default: {e}")
                    frame_rgb = frame.to_ndarray(format='rgb24')
                
                if manual_crop_left > 0 or manual_crop_top > 0 or manual_crop_right > 0 or manual_crop_bottom > 0:
                    frame_rgb = frame_rgb[manual_crop_top:orig_h-manual_crop_bottom, manual_crop_left:orig_w-manual_crop_right, :]
                
                while expected_target_time <= frame_time + 1e-5:
                    if actual_end_time != float('inf') and expected_target_time >= actual_end_time - 1e-5:
                        break
                        
                    if target_frame_count > 0 and frames_loaded >= target_frame_count:
                        break
                        
                    if image_tensor is None and expected_frames > 0:
                        height, width = frame_rgb.shape[:2]
                        alloc_frames = expected_frames + 50
                        try:
                            image_tensor = torch.zeros((alloc_frames, height, width, 3), dtype=torch.float32)
                        except Exception as e:
                            print(f"[VideoLoaderPW] Pre-allocation failed, falling back to list: {e}")
                            expected_frames = 0
                            
                    if image_tensor is not None:
                        if frames_loaded >= image_tensor.shape[0]:
                            extension = torch.zeros((50, image_tensor.shape[1], image_tensor.shape[2], 3), dtype=torch.float32)
                            image_tensor = torch.cat((image_tensor, extension), dim=0)
                            
                        image_tensor[frames_loaded] = torch.from_numpy(frame_rgb).float().div_(255.0)
                        frames_loaded += 1
                    else:
                        frames.append(frame_rgb)
                        
                    if pbar:
                        pbar.update(1)
                        
                    expected_target_time += frame_interval

        if image_tensor is not None:
            if frames_loaded > 0:
                image_tensor = image_tensor[:frames_loaded]
            else:
                image_tensor = torch.zeros((1, 512, 512, 3), dtype=torch.float32)
        elif len(frames) > 0:
            frames_np = np.array(frames, dtype=np.float32) / 255.0
            image_tensor = torch.from_numpy(frames_np)
        else:
            image_tensor = torch.zeros((1, 512, 512, 3), dtype=torch.float32)

        audio_dict = None
        if len(container.streams.audio) > 0:
            try:
                audio_stream = container.streams.audio[0]
                audio_stream.thread_type = "AUTO"
                sample_rate = getattr(audio_stream, 'rate', 44100) or 44100
                
                if audio_stream.time_base:
                    seek_pts = int(actual_start_time / float(audio_stream.time_base))
                else:
                    seek_pts = int(actual_start_time * av.time_base)
                    
                container.seek(seek_pts, stream=audio_stream, backward=True)
                resampler = av.AudioResampler(format='fltp')
                
                audio_data = []
                first_frame_time = None
                
                for frame in container.decode(audio_stream):
                    frame_time = frame.time
                    if frame_time is None:
                        frame_time = float(frame.pts * float(audio_stream.time_base)) if frame.pts and audio_stream.time_base else 0.0
                        
                    if frame_time > actual_end_time + 1.0:
                        break
                        
                    if first_frame_time is None:
                        first_frame_time = frame_time
                           
                    resampled_frames = resampler.resample(frame)
                    for r_frame in resampled_frames:
                        audio_data.append(r_frame.to_ndarray())
                          
                if audio_data:
                    waveform_np = np.concatenate(audio_data, axis=1)
                    waveform = torch.from_numpy(waveform_np).float()
                     
                    if first_frame_time is None:
                        first_frame_time = 0.0
                         
                    offset_sec = max(0.0, actual_start_time - first_frame_time)
                    start_sample = int(offset_sec * sample_rate)
                    duration_sec_audio = actual_end_time - actual_start_time
                    end_sample = start_sample + int(duration_sec_audio * sample_rate)
                    
                    if end_sample > start_sample:
                        waveform = waveform[:, start_sample:end_sample]
                    else:
                        waveform = waveform[:, start_sample:]
                           
                    waveform = waveform.unsqueeze(0)
                    audio_dict = {"waveform": waveform, "sample_rate": sample_rate}
            except Exception as e:
                print(f"[VideoLoaderPW] Audio track extraction skipped or failed: {e}")

        container.close()
        
        frame_count = image_tensor.shape[0] if (frames_loaded > 0 or len(frames) > 0) else 0
        final_duration_sec = round(float(frame_count / fr), 2)

        loaded_h = int(image_tensor.shape[1]) if image_tensor is not None and image_tensor.shape[0] > 0 else 0
        loaded_w = int(image_tensor.shape[2]) if image_tensor is not None and image_tensor.shape[0] > 0 else 0
        
        video_info = json.dumps({
            "source_fps": round(source_fps, 2),
            "source_frame_count": source_frame_count,
            "source_duration": round(source_duration, 2),
            "source_width": orig_w,
            "source_height": orig_h,
            "loaded_fps": round(fr, 2),
            "loaded_frame_count": frame_count,
            "loaded_duration": final_duration_sec,
            "loaded_width": loaded_w,
            "loaded_height": loaded_h,
        }, indent=4)

        # FIX 2: 修复 g_end_frame 计算，使用目标fps而非原始fps
        if display_mode == "frames":
            g_start_frame = s_frame_0
            if e_frame_0 > 0:
                g_end_frame = e_frame_0
            else:
                g_end_frame = int(round(video_duration * fr)) - 1
        else:
            g_start_frame = int(round(actual_start_time * fr))
            if actual_end_time == float('inf'):
                g_end_frame = int(round(video_duration * fr)) - 1
            else:
                g_end_frame = max(g_start_frame, int(round(actual_end_time * fr)) - 1)
                
        g_start_frame = max(0, g_start_frame)
        g_end_frame = max(g_start_frame, g_end_frame)
        g_end_local = g_end_frame - g_start_frame
        
        repeat_last_frame_count = 0

        def calc_segment(seg_start_local, seg_end_local):
            if seg_end_local < seg_start_local:
                return {
                    "start_time_sec": round(seg_start_local / fr, 2),
                    "start_frame": seg_start_local,
                    "end_time_sec": round(max(0, seg_start_local - 1) / fr, 2),
                    "end_frame": max(0, seg_start_local - 1),
                    "time_sec": 0.00,
                    "frame": 0
                }
            
            frames = seg_end_local - seg_start_local + 1
            t_sec = frames / fr
            return {
                "start_time_sec": round(seg_start_local / fr, 2),
                "start_frame": seg_start_local,
                "end_time_sec": round(seg_end_local / fr, 2),
                "end_frame": seg_end_local,
                "time_sec": round(t_sec, 2),
                "frame": frames
            }

        split_info_dict = {}
        
        if split_count == 0:
            total_frames = g_end_local + 1
            if align_8n_plus_1 and (total_frames - 1) % 8 != 0:
                new_total_frames = math.ceil((total_frames - 1) / 8) * 8 + 1
                repeat_last_frame_count = new_total_frames - total_frames
                
                if image_tensor is not None and image_tensor.shape[0] > 0 and repeat_last_frame_count > 0:
                    last_frame = image_tensor[-1:]
                    repeat_frames = last_frame.repeat(repeat_last_frame_count, 1, 1, 1)
                    image_tensor = torch.cat([image_tensor, repeat_frames], dim=0)
                    
                if audio_dict and "waveform" in audio_dict and audio_dict["waveform"].shape[-1] > 0 and repeat_last_frame_count > 0:
                    sample_rate = audio_dict.get("sample_rate", 44100)
                    samples_to_add = int(round(repeat_last_frame_count / fr * sample_rate))
                    if samples_to_add > 0:
                        waveform = audio_dict["waveform"]
                        padding = torch.zeros((*waveform.shape[:-1], samples_to_add), dtype=waveform.dtype, device=waveform.device)
                        audio_dict["waveform"] = torch.cat([waveform, padding], dim=-1)
                        
                g_end_local = new_total_frames - 1
                frame_count = new_total_frames
                final_duration_sec = round(float(frame_count / fr), 2)
                
        elif split_count == 1:
            p_abs_0 = max(0, split_purple_point_idx)
            p_local = p_abs_0 - g_start_frame
            
            p_local = max(1, min(p_local, g_end_local - 1))
            if p_local < 1: p_local = 1
            if p_local > g_end_local - 1: p_local = g_end_local - 1
            
            select_gen = (select_generate == "purple")
            
            if align_8n_plus_1:
                if not select_gen:
                    N = g_end_local - p_local + 1
                    target_N = math.ceil((N - 1) / 8) * 8 + 1
                    p_local = max(1, g_end_local - target_N + 1)
                else:
                    N = p_local
                    target_N = math.ceil((N - 1) / 8) * 8 + 1
                    p_local = min(g_end_local - 1, target_N)
                    
            if not select_gen:
                split_info_dict["split_front"] = calc_segment(0, p_local - 1)
                split_info_dict["split_generate"] = calc_segment(p_local, g_end_local)
            else:
                split_info_dict["split_generate"] = calc_segment(0, p_local - 1)
                split_info_dict["split_back"] = calc_segment(p_local, g_end_local)
                
        elif split_count == 2:
            p_abs_0 = max(0, split_purple_point_idx)
            g_abs_0 = max(0, split_green_point_idx)
            
            p_local = p_abs_0 - g_start_frame
            g_local = g_abs_0 - g_start_frame
            
            p_local = max(1, min(p_local, g_end_local - 2))
            g_local = max(p_local + 1, min(g_local, g_end_local - 1))
            
            if p_local < 1: p_local = 1
            if g_local < p_local + 1: g_local = p_local + 1
            if g_local > g_end_local - 1: g_local = g_end_local - 1
            
            if align_8n_plus_1:
                N = g_local - p_local
                if N < 1: N = 1
                target_N = math.ceil((N - 1) / 8) * 8 + 1
                g_local = min(g_end_local - 1, p_local + target_N)
                
            split_info_dict["split_front"] = calc_segment(0, p_local - 1)
            split_info_dict["split_generate"] = calc_segment(p_local, g_local - 1)
            split_info_dict["split_back"] = calc_segment(g_local, g_end_local)
            
        split_info_str = json.dumps(split_info_dict)

        return {
            "ui": {"video_path": [str(video_to_load)], "video_info": [video_info]},
            "result": (image_tensor, audio_dict, frame_count, final_duration_sec, float(frame_rate), video_info, repeat_last_frame_count, split_info_str)
        }

NODE_CLASS_MAPPINGS = {"VideoLoaderPW": VideoLoaderPW}
NODE_DISPLAY_NAME_MAPPINGS = {"VideoLoaderPW": "Video Loader PW"}