import os
import torch
import numpy as np
import folder_paths
import json
import av
from server import PromptServer
from aiohttp import web
import comfy.utils

class VideoSplitterPW:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "images": ("IMAGE",),
                "视频分段": ("INT", {"default": 0, "min": 0, "max": 1, "step": 1, "tooltip": "0=不分割, 1=分割为两段"}),
                "start_time": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100000.0, "step": 0.01}),
                "end_time": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100000.0, "step": 0.01}),
                "duration": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100000.0, "step": 0.01}),
                "start_frame": ("INT", {"default": 0, "min": 0, "max": 10000000, "step": 1}),
                "end_frame": ("INT", {"default": 0, "min": 0, "max": 10000000, "step": 1}),
                "duration_frames": ("INT", {"default": 0, "min": 0, "max": 10000000, "step": 1}),
                "frame_rate": ("INT", {"default": 25, "min": 1, "max": 120, "step": 1, "tooltip": "强制视频使用特定的帧率"}),
                "display_mode": (["seconds", "frames"], {"default": "seconds"}),
                "split_point": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100000.0, "step": 0.01, "tooltip": "紫色分段点的时间位置"}),
            },
            "optional": {
                "audio": ("AUDIO",),
            }
        }
    
    RETURN_TYPES = ("IMAGE", "AUDIO", "FLOAT", "INT", "STRING", "IMAGE", "AUDIO", "INT")
    RETURN_NAMES = ("images", "audio", "duration", "frame_count", "video_info", "front_imgs", "front_audio", "front_frames")
    FUNCTION = "split_video"
    CATEGORY = "🔮PWUtility/Video"
    
    def split_video(self, images, 视频分段, frame_rate, display_mode, start_time, end_time, duration, start_frame, end_frame, duration_frames, split_point, audio=None):
        num_frames = images.shape[0]
        height = images.shape[1]
        width = images.shape[2]
        
        fr = float(frame_rate) if frame_rate > 0 else 25.0
        total_duration = num_frames / fr
        
        # 确定起始和结束帧
        if display_mode == "frames":
            actual_start_frame = start_frame
            actual_end_frame = end_frame if (end_frame > 0 and end_frame > start_frame) else num_frames
        else:
            actual_start_frame = int(start_time * fr)
            actual_end_frame = int(end_time * fr) if (end_time > 0 and end_time > start_time) else num_frames
        
        actual_start_frame = max(0, min(actual_start_frame, num_frames - 1))
        actual_end_frame = max(actual_start_frame + 1, min(actual_end_frame, num_frames))
        
        # 切片图像
        sliced_images = images[actual_start_frame:actual_end_frame]
        sliced_frame_count = sliced_images.shape[0]
        sliced_duration = sliced_frame_count / fr
        
        # 处理分段
        empty_image = torch.zeros((1, height, width, 3), dtype=torch.float32)
        empty_audio = {"waveform": torch.zeros((1, 1, 44100)), "sample_rate": 44100}
        
        if 视频分段 == 1 and split_point > 0:
            split_frame = min(int(split_point * fr), sliced_frame_count)
            front_images = sliced_images[:split_frame]
            back_images = sliced_images[split_frame:]
            front_frame_count = front_images.shape[0]
            
            if front_frame_count == 0:
                front_images = empty_image
        else:
            front_images = empty_image
            back_images = sliced_images
            front_frame_count = 0
        
        # 处理音频
        if audio is not None:
            waveform = audio["waveform"]
            sample_rate = audio["sample_rate"]
            
            # 确保波形有3个维度
            if waveform.dim() == 2:
                waveform = waveform.unsqueeze(0)
            
            start_sample = int(actual_start_frame / fr * sample_rate)
            end_sample = int(actual_end_frame / fr * sample_rate)
            
            if waveform.shape[-1] > end_sample:
                sliced_waveform = waveform[:, :, start_sample:end_sample]
            else:
                sliced_waveform = waveform[:, :, start_sample:]
            
            sliced_audio = {"waveform": sliced_waveform, "sample_rate": sample_rate}
            
            if 视频分段 == 1 and split_point > 0:
                split_sample = int(split_point * sample_rate)
                front_waveform = sliced_waveform[:, :, :split_sample]
                back_waveform = sliced_waveform[:, :, split_sample:]
                
                if front_waveform.shape[-1] == 0:
                    front_audio = empty_audio
                else:
                    front_audio = {"waveform": front_waveform, "sample_rate": sample_rate}
                
                if back_waveform.shape[-1] == 0:
                    back_audio = empty_audio
                else:
                    back_audio = {"waveform": back_waveform, "sample_rate": sample_rate}
            else:
                front_audio = empty_audio
                back_audio = sliced_audio
        else:
            sliced_audio = empty_audio
            front_audio = empty_audio
            back_audio = empty_audio
        
        # 创建预览视频
        temp_dir = folder_paths.get_temp_directory()
        os.makedirs(temp_dir, exist_ok=True)
        video_filename = f"split_preview_{id(self)}_{os.getpid()}.mp4"
        video_path = os.path.join(temp_dir, video_filename)
        
        try:
            frames_np = (sliced_images.cpu().numpy() * 255).astype(np.uint8)
            container = av.open(video_path, mode='w')
            stream = container.add_stream('h264', rate=fr)
            stream.width = width
            stream.height = height
            stream.pix_fmt = 'yuv420p'
            
            for frame_data in frames_np:
                frame = av.VideoFrame.from_ndarray(frame_data, format='rgb24')
                for packet in stream.encode(frame):
                    container.mux(packet)
            
            for packet in stream.encode():
                container.mux(packet)
            
            container.close()
        except Exception as e:
            print(f"[VideoSplitterPW] 创建预览视频失败: {e}")
            video_path = ""
        
        video_info = json.dumps({
            "source_fps": fr,
            "source_frame_count": num_frames,
            "source_duration": total_duration,
            "source_width": width,
            "source_height": height,
            "loaded_fps": fr,
            "loaded_frame_count": sliced_frame_count,
            "loaded_duration": sliced_duration,
            "loaded_width": width,
            "loaded_height": height,
            "split_enabled": 视频分段,
        }, indent=4)
        
        return {
            "ui": {"video_path": [video_path], "video_info": [video_info]},
            "result": (back_images, back_audio, sliced_duration, sliced_frame_count, video_info, front_images, front_audio, front_frame_count)
        }

NODE_CLASS_MAPPINGS = {"VideoSplitterPW": VideoSplitterPW}
NODE_DISPLAY_NAME_MAPPINGS = {"VideoSplitterPW": "Video Splitter PW"}