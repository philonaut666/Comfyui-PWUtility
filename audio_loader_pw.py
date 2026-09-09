import folder_paths
import os
import re
import shutil
import torch
import av
import math
import subprocess
import tempfile
from server import PromptServer
from aiohttp import web


def f32_pcm(wav: torch.Tensor) -> torch.Tensor:
    if wav.dtype.is_floating_point:
        return wav
    elif wav.dtype == torch.int16:
        return wav.float() / (2 ** 15)
    elif wav.dtype == torch.int32:
        return wav.float() / (2 ** 31)
    raise ValueError(f"Unsupported wav dtype: {wav.dtype}")


def load_audio_file(filepath: str) -> tuple[torch.Tensor, int]:
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


# ==========================================================
# ffmpeg 查找与 AAC→MP3 转换（参考 VideoAudioSimpleUploaderPW）
# ==========================================================
def _find_ffmpeg():
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        return ffmpeg
    try:
        import imageio_ffmpeg
        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe and os.path.isfile(exe):
            return exe
    except Exception:
        pass
    import sys
    candidates = []
    if sys.platform.startswith("win"):
        candidates += [
            r"C:\ffmpeg\bin\ffmpeg.exe",
            r"C:\Program Files\ffmpeg\bin\ffmpeg.exe",
            r"C:\Program Files (x86)\ffmpeg\bin\ffmpeg.exe",
        ]
    else:
        candidates += [
            "/usr/bin/ffmpeg",
            "/usr/local/bin/ffmpeg",
            "/opt/homebrew/bin/ffmpeg",
            "/snap/bin/ffmpeg",
        ]
    for c in candidates:
        try:
            if os.path.isfile(c):
                return c
        except Exception:
            pass
    return None


def _get_audio_bitrate(path):
    try:
        c = av.open(path)
        if len(c.streams.audio) > 0:
            br = c.streams.audio[0].codec_context.bit_rate
            c.close()
            if br and br > 0:
                return int(br)
        else:
            c.close()
    except Exception:
        pass
    return None


def _convert_to_mp3_ffmpeg(ffmpeg_path, input_path, output_path, bitrate=None):
    cmd = [
        ffmpeg_path, "-y",
        "-i", input_path,
        "-map", "0:a:0",
        "-vn",
        "-map_metadata", "0",
        "-c:a", "libmp3lame",
    ]
    if bitrate:
        cmd += ["-b:a", str(bitrate)]
    cmd.append(output_path)
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    except subprocess.TimeoutExpired:
        raise ValueError("ffmpeg 转换超时")
    if result.returncode != 0 or not os.path.exists(output_path) or os.path.getsize(output_path) == 0:
        err = (result.stderr or "")[-800:]
        raise ValueError(f"ffmpeg 转换失败: {err}")


@PromptServer.instance.routes.post("/AudioLoaderPW/aac_to_mp3_upload")
async def aac_to_mp3_upload(request):
    tmp_path = None
    try:
        post = await request.post()
        file = post.get("file")
        if file is None or not hasattr(file, "file"):
            return web.json_response({"error": "未提供文件"}, status=400)

        filename = str(post.get("filename", "") or "").strip() or "audio.aac"
        subfolder = str(post.get("subfolder", "") or "").strip()

        filename = os.path.basename(filename)
        base = os.path.splitext(filename)[0] or "audio"
        base = re.sub(r'[^\w\-.]+', '_', base).strip() or "audio"

        tmp_file = tempfile.NamedTemporaryFile(delete=False, suffix=".aac")
        tmp_path = tmp_file.name
        with tmp_file as tmp:
            while True:
                chunk = file.file.read(1024 * 1024)
                if not chunk:
                    break
                tmp.write(chunk)

        audio_bitrate = _get_audio_bitrate(tmp_path)
        if audio_bitrate:
            audio_bitrate = max(32000, min(320000, audio_bitrate))

        ffmpeg = _find_ffmpeg()
        if not ffmpeg:
            return web.json_response({"error": "未找到 ffmpeg，无法将 AAC 转换为 MP3"}, status=500)

        input_dir = folder_paths.get_input_directory()
        if subfolder:
            out_dir = os.path.join(input_dir, subfolder)
            os.makedirs(out_dir, exist_ok=True)
        else:
            out_dir = input_dir

        out_name = f"{base}.mp3"
        out_path = os.path.join(out_dir, out_name)
        counter = 1
        while os.path.exists(out_path):
            out_name = f"{base}_{counter}.mp3"
            out_path = os.path.join(out_dir, out_name)
            counter += 1

        _convert_to_mp3_ffmpeg(ffmpeg, tmp_path, out_path, audio_bitrate)

        try:
            if tmp_path and os.path.exists(tmp_path):
                os.remove(tmp_path)
        except Exception:
            pass
        tmp_path = None

        rel = f"{subfolder}/{out_name}" if subfolder else out_name
        rel = rel.replace(os.sep, "/")
        return web.json_response({"name": rel})
    except Exception as e:
        try:
            if tmp_path and os.path.exists(tmp_path):
                os.remove(tmp_path)
        except Exception:
            pass
        print(f"[AudioLoaderPW] aac_to_mp3_upload 错误: {e}")
        return web.json_response({"error": str(e)}, status=500)


class AudioLoaderPW:
    @staticmethod
    def _resolve_audio_path(audio_to_load, raise_error=True):
        """参考 VideoLoaderPW 的路径解析，支持相对/绝对路径与子文件夹。"""
        if not audio_to_load:
            if raise_error:
                raise FileNotFoundError("Audio path is empty")
            return ""
        candidates = [audio_to_load]
        try:
            candidates.append(folder_paths.get_annotated_filepath(audio_to_load))
        except Exception:
            pass
        try:
            candidates.append(os.path.join(folder_paths.get_input_directory(), audio_to_load))
        except Exception:
            pass
        for c in candidates:
            try:
                if c and os.path.exists(c):
                    return os.path.abspath(c)
            except Exception:
                pass
        if raise_error:
            raise FileNotFoundError(f"Audio file not found: {audio_to_load}")
        return audio_to_load

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "path": ("STRING", {
                    "default": "",
                    "tooltip": "Optional audio path. Can be empty if using upload/drag inside the node."
                }),
                "start_time": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100000.0, "step": 0.01}),
                "end_time": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100000.0, "step": 0.01}),
                "duration": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100000.0, "step": 0.01}),
                "fps": ("FLOAT", {"default": 24.0, "min": 0.0, "max": 1000.0, "step": 0.001, "tooltip": "Frames per second"}),
                "pre_silence": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100000.0, "step": 0.01}),
                "post_silence": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100000.0, "step": 0.01}),
                "align frames": (["none", "MH3-17n+5", "LTX2.3-8n+1"], {"default": "MH3-17n+5", "tooltip": "Frame alignment mode"}),
                "normalize": ("FLOAT", {"default": -16.0, "min": -100.0, "max": 100.0, "step": 0.1}),
                "upload_subfolder": ("STRING", {"default": "", "tooltip": "Subfolder inside input/ for uploads. Leave empty for input/ root."}),
            },
            "optional": {
                "audioUI": ("AUDIO_UI",),
            }
        }

    CATEGORY = "🔮PWUtility/Audio"
    RETURN_TYPES = ("AUDIO", "FLOAT", "INT", "AUDIO", "AUDIO")
    RETURN_NAMES = ("audio", "duration", "frame_count", "trimed_front_audio", "trimed_back_audio")
    FUNCTION = "load_audio"

    def load_audio(self, path, start_time, end_time, duration, fps,
                   pre_silence, post_silence, normalize, upload_subfolder,
                   **kwargs):
        align_mode = kwargs.get("align frames", "none")
        audio_to_load = path.strip() if (path and isinstance(path, str) and path.strip()) else ""

        if not audio_to_load:
            print("!!! [AudioLoaderPW] Warning: No audio path provided. Outputting 1 second of silence.")
            sample_rate = 44100
            waveform = torch.zeros((2, 44100))
        else:
            audio_path = ""
            try:
                audio_path = self._resolve_audio_path(audio_to_load, raise_error=True)
            except Exception as e:
                print(f"!!! [AudioLoaderPW] Warning: {e}. Outputting 1 second of silence.")
                sample_rate = 44100
                waveform = torch.zeros((2, 44100))

            if audio_path:
                # 执行时兜底：若加载到 .aac（.m4a 不受影响），尝试转为 .mp3
                file_ext = os.path.splitext(audio_path)[1].lower()
                if file_ext == '.aac':
                    mp3_path = os.path.splitext(audio_path)[0] + '.mp3'
                    if not os.path.exists(mp3_path):
                        ffmpeg = _find_ffmpeg()
                        if ffmpeg:
                            try:
                                br = _get_audio_bitrate(audio_path)
                                if br:
                                    br = max(32000, min(320000, br))
                                _convert_to_mp3_ffmpeg(ffmpeg, audio_path, mp3_path, br)
                                print(f"!!! [AudioLoaderPW] Converted AAC to MP3: {mp3_path}")
                            except Exception as e:
                                print(f"!!! [AudioLoaderPW] AAC→MP3 conversion failed: {e}")
                        else:
                            print("!!! [AudioLoaderPW] ffmpeg not found, cannot convert AAC to MP3.")
                    if os.path.exists(mp3_path):
                        audio_path = mp3_path
                        audio_to_load = os.path.splitext(audio_to_load)[0] + '.mp3'

                try:
                    waveform, sample_rate = load_audio_file(audio_path)
                except Exception as e:
                    print(f"!!! [AudioLoaderPW] Error decoding {audio_to_load}: {e}. Falling back to silence.")
                    sample_rate = 44100
                    waveform = torch.zeros((2, 44100))

        start_frame = int(start_time * sample_rate)
        if end_time > 0:
            end_frame = min(int(end_time * sample_rate), waveform.shape[1])
        else:
            end_frame = waveform.shape[1]
        start_frame = min(start_frame, end_frame)

        front_waveform = waveform[:, 0:start_frame]
        trimmed_waveform = waveform[:, start_frame:end_frame]
        back_waveform = waveform[:, end_frame:waveform.shape[1]]

        if front_waveform.shape[1] == 0:
            front_waveform = torch.zeros((waveform.shape[0], 1), dtype=waveform.dtype, device=waveform.device)
        if trimmed_waveform.shape[1] == 0:
            trimmed_waveform = torch.zeros((waveform.shape[0], 1), dtype=waveform.dtype, device=waveform.device)
        if back_waveform.shape[1] == 0:
            back_waveform = torch.zeros((waveform.shape[0], 1), dtype=waveform.dtype, device=waveform.device)

        def _apply_normalize(wav, target_db):
            if target_db != 0.0 and wav.shape[1] > 0:
                peak = torch.max(torch.abs(wav)).item()
                if peak > 1e-6:
                    gain_db = target_db - 20 * math.log10(peak)
                    return wav * (10 ** (gain_db / 20.0))
            return wav

        front_waveform = _apply_normalize(front_waveform, normalize)
        trimmed_waveform = _apply_normalize(trimmed_waveform, normalize)
        back_waveform = _apply_normalize(back_waveform, normalize)

        pre_frames = int(pre_silence * sample_rate)
        post_frames = int(post_silence * sample_rate)
        pre_w = torch.zeros((waveform.shape[0], pre_frames), dtype=trimmed_waveform.dtype, device=trimmed_waveform.device)
        post_w = torch.zeros((waveform.shape[0], post_frames), dtype=trimmed_waveform.dtype, device=trimmed_waveform.device)
        final_waveform = torch.cat((pre_w, trimmed_waveform, post_w), dim=1)

        frame_count = 0
        if align_mode == "LTX2.3-8n+1" and fps > 0:
            audio_length_sec = final_waveform.shape[1] / sample_rate
            total_frames = audio_length_sec * fps
            n = (total_frames - 1) / 8
            if abs(n - round(n)) >= 1e-5:
                new_total_frames = math.ceil(total_frames / 8) * 8 + 1
                diff_samples = int((new_total_frames - total_frames) * sample_rate / fps)
                if diff_samples > 0:
                    pad = torch.zeros((final_waveform.shape[0], diff_samples), dtype=final_waveform.dtype, device=final_waveform.device)
                    final_waveform = torch.cat((final_waveform, pad), dim=1)
                final_duration = float(new_total_frames / fps)
                frame_count = int(round(new_total_frames))
            else:
                final_duration = float(audio_length_sec)
                frame_count = int(round(total_frames))

        elif align_mode == "MH3-17n+5":
            audio_length_sec = final_waveform.shape[1] / sample_rate
            current_frames = round(audio_length_sec * 24)
            base = max(5, current_frames)
            target_frames = base + (5 - (base % 17)) % 17
            diff_frames = target_frames - current_frames
            if diff_frames > 0:
                diff_samples = int(diff_frames * sample_rate / 24)
                if diff_samples > 0:
                    pad = torch.zeros((final_waveform.shape[0], diff_samples), dtype=final_waveform.dtype, device=final_waveform.device)
                    final_waveform = torch.cat((final_waveform, pad), dim=1)
                final_duration = float(target_frames / 24)
            else:
                final_duration = float(audio_length_sec)
            frame_count = target_frames

        else:  # "none"
            final_duration = float(final_waveform.shape[1] / sample_rate)
            frame_count = int(round(final_duration * fps)) if fps > 0 else 0

        audio_output = {"waveform": final_waveform.unsqueeze(0), "sample_rate": sample_rate}
        front_out = {"waveform": front_waveform.unsqueeze(0), "sample_rate": sample_rate}
        back_out = {"waveform": back_waveform.unsqueeze(0), "sample_rate": sample_rate}

        return {
            "ui": {"audio_path": [str(audio_to_load)]},
            "result": (audio_output, final_duration, frame_count, front_out, back_out)
        }


NODE_CLASS_MAPPINGS = {
    "AudioLoaderPW": AudioLoaderPW
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "AudioLoaderPW": "Audio Loader PW"
}