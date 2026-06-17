import folder_paths
import os
import shutil
import torch
import av
import math

def f32_pcm(wav: torch.Tensor) -> torch.Tensor:
    """Convert audio to float 32 bits PCM format."""
    if wav.dtype.is_floating_point:
        return wav
    elif wav.dtype == torch.int16:
        return wav.float() / (2 ** 15)
    elif wav.dtype == torch.int32:
        return wav.float() / (2 ** 31)
    raise ValueError(f"Unsupported wav dtype: {wav.dtype}")

def load_audio_file(filepath: str) -> tuple[torch.Tensor, int]:
    """Uses the latest ComfyUI av-based decoding for maximum compatibility."""
    with av.open(filepath) as af:
        if not af.streams.audio:
            raise ValueError("No audio stream found in the file.")
        stream = af.streams.audio[0]
        sr = stream.codec_context.sample_rate
        n_channels = stream.channels

        frames = []
        for frame in af.decode(streams=stream.index):
            buf = torch.from_numpy(frame.to_ndarray())
            if buf.shape[0] != n_channels:
                buf = buf.view(-1, n_channels).t()
            frames.append(buf)

        if not frames:
            raise ValueError("No audio frames decoded.")

        wav = torch.cat(frames, dim=1)
        wav = f32_pcm(wav)
        return wav, sr

class AudioLoaderPW:
    @classmethod
    def INPUT_TYPES(s):
        try:
            files = folder_paths.get_filename_list("audio")
        except:
            files = []
        if not files:
            input_dir = folder_paths.get_input_directory()
            if os.path.exists(input_dir):
                all_files = [f for f in os.listdir(input_dir) if os.path.isfile(os.path.join(input_dir, f))]
                try:
                    files = sorted(folder_paths.filter_files_content_types(all_files, ["audio", "video"]))
                except:
                    files = sorted(all_files)
        
        if not files or len(files) == 0:
            files = ["none"]

        return {
            "required": {
                # 移除 audio 的默认值，仅保留上传功能
                "audio": (files, {"audio_upload": True}),
                # 默认值设置为 0.0 (前端配合 step 0.01 会显示为 0.00)
                "start_time": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100000.0, "step": 0.01}),
                "end_time": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100000.0, "step": 0.01}),
                "duration": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100000.0, "step": 0.01}),
                "fps": ("FLOAT", {"default": 25.0, "min": 0.0, "max": 1000.0, "step": 0.001, "tooltip": "Frames per second"}),
                "pre_silence": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100000.0, "step": 0.01, "tooltip": "Silence in seconds to add before the audio"}),
                "post_silence": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100000.0, "step": 0.01, "tooltip": "Silence in seconds to add after the audio"}),
                "align_8n+1": ("BOOLEAN", {"default": False, "tooltip": "Pad audio to make total frames equal to 8n+1 based on fps"}),
            },
            "optional": {
                "audioUI": ("AUDIO_UI",),
                "path": ("STRING", {"forceInput": True, "tooltip": "Path from LocalMedia Manager to auto-load audio"}),
            }
        }

    CATEGORY = "PWUtility/Audio"
    RETURN_TYPES = ("AUDIO", "FLOAT")
    RETURN_NAMES = ("audio", "duration")
    FUNCTION = "load_audio"

    @classmethod
    def VALIDATE_INPUTS(cls, audio, **kwargs):
        return True

    def load_audio(self, audio, start_time, end_time, duration, fps, pre_silence, post_silence, path=None, **kwargs):
        align_flag = kwargs.get("align_8n+1", False)
        audio_to_load = path.strip() if (path and isinstance(path, str) and path.strip()) else audio

        try:
            if audio_to_load and audio_to_load != "none" and os.path.isabs(audio_to_load):
                audio_path = audio_to_load
                if os.path.exists(audio_path):
                    input_dir = folder_paths.get_input_directory()
                    dest_name = os.path.basename(audio_path)
                    dest_path = os.path.join(input_dir, dest_name)
                    if not os.path.exists(dest_path):
                        shutil.copy2(audio_path, dest_path)
                    audio_to_load = dest_name
            else:
                audio_path = folder_paths.get_annotated_filepath(audio_to_load) if audio_to_load != "none" else ""
        except:
            audio_path = ""
        
        if audio_to_load == "none" or not audio_path or not os.path.exists(audio_path):
            missing_info = audio_to_load if audio_to_load != "none" else "None selected"
            print(f"!!! [AudioLoaderPW] Warning: Audio file '{missing_info}' not found. Outputting 1 second of silence.")
            sample_rate = 44100
            waveform = torch.zeros((2, 44100))
        else:
            try:
                waveform, sample_rate = load_audio_file(audio_path)
            except Exception as e:
                print(f"!!! [AudioLoaderPW] Error decoding {audio}: {e}. Falling back to silence.")
                sample_rate = 44100
                waveform = torch.zeros((2, 44100))

        start_frame = int(start_time * sample_rate)
        if end_time > 0:
            end_frame = int(end_time * sample_rate)
            end_frame = min(end_frame, waveform.shape[1])
        else:
            end_frame = waveform.shape[1]
            
        start_frame = min(start_frame, end_frame)
        trimmed_waveform = waveform[:, start_frame:end_frame]
        
        if trimmed_waveform.shape[1] == 0:
            trimmed_waveform = torch.zeros((waveform.shape[0], 1), dtype=waveform.dtype, device=waveform.device)
        
        pre_silence_frames = int(pre_silence * sample_rate)
        post_silence_frames = int(post_silence * sample_rate)
        
        pre_silence_waveform = torch.zeros((waveform.shape[0], pre_silence_frames), dtype=trimmed_waveform.dtype, device=trimmed_waveform.device)
        post_silence_waveform = torch.zeros((waveform.shape[0], post_silence_frames), dtype=trimmed_waveform.dtype, device=trimmed_waveform.device)
        
        final_waveform = torch.cat((pre_silence_waveform, trimmed_waveform, post_silence_waveform), dim=1)
        
        # ==========================================
        # 8n+1 帧对齐逻辑 (严格遵循：仅不符合时才计算和补齐)
        # ==========================================
        if align_flag and fps > 0:
            audio_length_sec = final_waveform.shape[1] / sample_rate
            total_frames = audio_length_sec * fps
            
            n = (total_frames - 1) / 8
            is_valid = abs(n - round(n)) < 1e-5
            
            if not is_valid:
                new_total_frames = math.ceil(total_frames / 8) * 8 + 1
                diff_frames = new_total_frames - total_frames
                diff_samples = int(diff_frames * sample_rate / fps)
                
                if diff_samples > 0:
                    pad_waveform = torch.zeros((final_waveform.shape[0], diff_samples), dtype=final_waveform.dtype, device=final_waveform.device)
                    final_waveform = torch.cat((final_waveform, pad_waveform), dim=1)
                
                final_duration = float(new_total_frames / fps)
            else:
                final_duration = float(audio_length_sec)
        else:
            final_duration = float(final_waveform.shape[1] / sample_rate)
        
        audio_output = {"waveform": final_waveform.unsqueeze(0), "sample_rate": sample_rate}
        
        return {"ui": {"audio_path": [str(audio_to_load)]}, "result": (audio_output, final_duration)}