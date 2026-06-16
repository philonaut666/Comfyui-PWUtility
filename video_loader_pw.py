import os
import torch
import numpy as np
import folder_paths
import av
import json
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
                "duration": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100000.0, "step": 0.01}),
                "start_frame": ("INT", {"default": 0, "min": 0, "max": 10000000, "step": 1}),
                "end_frame": ("INT", {"default": 0, "min": 0, "max": 10000000, "step": 1}),
                "duration_frames": ("INT", {"default": 0, "min": 0, "max": 10000000, "step": 1}),
                "frame_rate": ("INT", {"default": 24, "min": 1, "max": 120, "step": 1, "tooltip": "Force the video to a specific frame rate for extraction."}),
                "display_mode": (["seconds", "frames"], {"default": "seconds"}),
                "crop_x": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.001}),
                "crop_y": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.001}),
                "crop_w": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.001}),
                "crop_h": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.001}),
            },
            "optional": {
                "path": ("STRING", {"forceInput": True, "tooltip": "Path from LocalMedia Manager to auto-load video"}),
            }
        }

    RETURN_TYPES = ("IMAGE", "AUDIO", "FLOAT", "INT", "STRING")
    RETURN_NAMES = ("images", "audio", "duration", "frame_count", "video_info")
    FUNCTION = "load_video"
    CATEGORY = "PW/Video"

    def load_video(self, video, frame_rate, display_mode, start_time, end_time, duration, start_frame, end_frame, duration_frames, crop_x=0.0, crop_y=0.0, crop_w=1.0, crop_h=1.0, path=None, **kwargs):
        video_to_load = path.strip() if (path and isinstance(path, str) and path.strip()) else video

        if not video_to_load:
            empty_image = torch.zeros((1, 512, 512, 3), dtype=torch.float32)
            empty_audio = {"waveform": torch.zeros((1, 1, 44100)), "sample_rate": 44100}
            return {"ui": {"video_path": [""], "video_info": ["{}"]}, "result": (empty_image, empty_audio, 0.0, 0, "{}")}

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

        if display_mode == "frames":
            fr = float(frame_rate) if frame_rate > 0 else 24.0
            actual_start_time = float(start_frame) / fr
            actual_end_time = float(end_frame) / fr if (end_frame > 0 and end_frame > start_frame) else video_duration
        else:
            actual_start_time = start_time
            actual_end_time = end_time if (end_time > 0 and end_time > start_time) else video_duration

        if actual_end_time <= 0:
            actual_end_time = float('inf')

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
            
            frame_interval = 1.0 / float(frame_rate) if frame_rate > 0 else 1.0/24.0
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

                if frame_time < actual_start_time:
                    continue
                    
                if frame_time > actual_end_time + frame_interval: 
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
                
                # FIX: Relaxed floating point boundary conditions to prevent dropping the exact last frame
                while expected_target_time <= frame_time + 1e-5 and expected_target_time <= actual_end_time + 1e-5:
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

        audio_dict = {"waveform": torch.zeros((1, 1, 44100)), "sample_rate": 44100}
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
        
        final_duration_sec = float(max(0.0, actual_end_time - actual_start_time))
        frame_count = image_tensor.shape[0] if (frames_loaded > 0 or len(frames) > 0) else 0
        if frame_count == 0 and final_duration_sec > 0:
            calc_fr = float(frame_rate) if frame_rate > 0 else 24.0
            frame_count = int(np.floor(final_duration_sec * calc_fr))

        loaded_h = int(image_tensor.shape[1]) if image_tensor is not None and image_tensor.shape[0] > 0 else 0
        loaded_w = int(image_tensor.shape[2]) if image_tensor is not None and image_tensor.shape[0] > 0 else 0
        loaded_fps = float(frame_rate) if frame_rate > 0 else 24.0
        
        video_info = json.dumps({
             "source_fps":         source_fps,
             "source_frame_count": source_frame_count,
             "source_duration":    source_duration,
             "source_width":       orig_w,
             "source_height":      orig_h,
             "loaded_fps":         loaded_fps,
             "loaded_frame_count": frame_count,
             "loaded_duration":    final_duration_sec,
             "loaded_width":       loaded_w,
             "loaded_height":      loaded_h,
        }, indent=4)

        # FIX: Include video_info in the 'ui' dictionary so the frontend 'executed' event can reliably access it
        return {
            "ui": {"video_path": [str(video_to_load)], "video_info": [video_info]}, 
            "result": (image_tensor, audio_dict, final_duration_sec, frame_count, video_info)
        }

NODE_CLASS_MAPPINGS = {"VideoLoaderPW": VideoLoaderPW}
NODE_DISPLAY_NAME_MAPPINGS = {"VideoLoaderPW": "Video Loader PW"}