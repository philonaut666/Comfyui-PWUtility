import os
import re
import io
import shutil
import hashlib
import tempfile
import subprocess
import folder_paths
from server import PromptServer
from aiohttp import web


PW_AUDIO_EXTS = {".mp3", ".flac", ".aac", ".m4a", ".wav", ".ogg", ".oga", ".opus", ".wma", ".aiff", ".aif", ".amr"}

_AUDIO_FFMPEG_CODEC = {
    ".mp3": "libmp3lame",
    ".flac": "flac",
    ".aac": "aac",
    ".m4a": "aac",
    ".wav": "pcm_s16le",
    ".ogg": "libvorbis",
    ".oga": "libvorbis",
    ".opus": "libopus",
}


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
        import av
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


def _trim_video_ffmpeg(ffmpeg_path, input_path, output_path, start_sec, end_sec):
    duration = max(0.01, end_sec - start_sec)
    cmd = [
        ffmpeg_path, "-y",
        "-ss", f"{start_sec:.3f}",
        "-i", input_path,
        "-t", f"{duration:.3f}",
        "-map", "0:v:0",
        "-map", "0:a:0?",
        "-map_metadata", "0",
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
        "-c:a", "aac",
        "-movflags", "+faststart",
        "-avoid_negative_ts", "make_zero",
        output_path
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    except subprocess.TimeoutExpired:
        raise ValueError("ffmpeg 剪辑超时")
    if result.returncode != 0:
        err = (result.stderr or "")[-800:]
        raise ValueError(f"ffmpeg 剪辑失败: {err}")
    if not os.path.exists(output_path) or os.path.getsize(output_path) == 0:
        raise ValueError("ffmpeg 未生成有效输出文件")


def _trim_audio_ffmpeg(ffmpeg_path, input_path, output_path, start_sec, end_sec, out_ext, bitrate=None):
    duration = max(0.01, end_sec - start_sec)
    base_cmd = [
        ffmpeg_path, "-y",
        "-ss", f"{start_sec:.3f}",
        "-i", input_path,
        "-t", f"{duration:.3f}",
        "-map", "0:a:0",
        "-vn",
        "-map_metadata", "0",
        "-avoid_negative_ts", "make_zero",
    ]
    codec = _AUDIO_FFMPEG_CODEC.get(out_ext)
    attempts = []
    if codec:
        cmd = base_cmd + ["-c:a", codec]
        if bitrate and out_ext == ".mp3":
            cmd += ["-b:a", str(bitrate)]
        attempts.append(cmd + [output_path])
    attempts.append(base_cmd + [output_path])

    last_err = ""
    for cmd in attempts:
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
        except subprocess.TimeoutExpired:
            raise ValueError("ffmpeg 音频剪辑超时")
        if result.returncode == 0 and os.path.exists(output_path) and os.path.getsize(output_path) > 0:
            return
        last_err = (result.stderr or "")[-800:]
    raise ValueError(f"ffmpeg 音频剪辑失败: {last_err}")


def _trim_video_pyav(input_path, output_path, start_sec, end_sec):
    import av
    from fractions import Fraction

    if end_sec <= start_sec:
        raise ValueError("剪辑终点必须大于起点")

    input_container = av.open(input_path)
    output_container = None
    try:
        video_in = input_container.streams.video[0] if len(input_container.streams.video) > 0 else None
        audio_in = input_container.streams.audio[0] if len(input_container.streams.audio) > 0 else None
        if video_in is None:
            raise ValueError("无视频流")

        fps = video_in.average_rate
        if fps is None or float(fps) <= 0:
            fps = Fraction(30, 1)
        fps_int = max(1, int(round(float(fps))))

        out_w = int(video_in.codec_context.width)
        out_h = int(video_in.codec_context.height)
        if out_w % 2 != 0:
            out_w += 1
        if out_h % 2 != 0:
            out_h += 1

        output_container = av.open(output_path, mode="w")

        video_out = output_container.add_stream("libx264", rate=fps_int)
        video_out.width = out_w
        video_out.height = out_h
        video_out.pix_fmt = "yuv420p"
        try:
            video_out.options = {"crf": "18", "preset": "veryfast"}
        except Exception:
            pass
        try:
            video_out.codec_context.time_base = Fraction(1, fps_int)
        except Exception:
            pass

        audio_out = None
        if audio_in is not None:
            try:
                ar = int(audio_in.codec_context.sample_rate or 44100)
                audio_out = output_container.add_stream("aac", rate=ar)
            except Exception:
                audio_out = None

        if start_sec > 0:
            try:
                input_container.seek(int(start_sec * 1000000), any_frame=False, backward=True)
            except Exception:
                pass

        video_idx = 0
        audio_idx = 0
        streams = [s for s in [video_in, audio_in] if s is not None]
        stop = False
        for packet in input_container.demux(streams):
            if stop:
                break
            for frame in packet.decode():
                t = frame.time
                if t is None:
                    continue
                if t < start_sec - 0.001:
                    continue
                if t > end_sec + 0.5:
                    stop = True
                    break
                if isinstance(frame, av.VideoFrame):
                    try:
                        frame = frame.reformat(width=out_w, height=out_h, format="yuv420p")
                        frame.pts = video_idx
                        frame.time_base = Fraction(1, fps_int)
                        video_idx += 1
                        for pkt in video_out.encode(frame):
                            output_container.mux(pkt)
                    except Exception as e:
                        print(f"[VideoAudioSimpleUploaderPW] pyav video encode error: {e}")
                elif isinstance(frame, av.AudioFrame) and audio_out is not None:
                    try:
                        frame.pts = audio_idx
                        audio_idx += frame.samples
                        for pkt in audio_out.encode(frame):
                            output_container.mux(pkt)
                    except Exception as e:
                        print(f"[VideoAudioSimpleUploaderPW] pyav audio encode error: {e}")

        try:
            for pkt in video_out.encode(None):
                output_container.mux(pkt)
        except Exception:
            pass
        if audio_out is not None:
            try:
                for pkt in audio_out.encode(None):
                    output_container.mux(pkt)
            except Exception:
                pass
        if video_idx == 0:
            raise ValueError("剪辑未产生任何视频帧")
    finally:
        if output_container is not None:
            output_container.close()
        input_container.close()


def _trim_audio_pyav(input_path, output_path, start_sec, end_sec, out_ext):
    import av
    from fractions import Fraction

    if end_sec <= start_sec:
        raise ValueError("剪辑终点必须大于起点")

    codec_map = {".mp3": "mp3", ".flac": "flac", ".aac": "aac", ".m4a": "aac",
                 ".wav": "pcm_s16le", ".ogg": "libvorbis", ".oga": "libvorbis", ".opus": "libopus"}
    codec_name = codec_map.get(out_ext, "aac")

    input_container = av.open(input_path)
    output_container = None
    try:
        if len(input_container.streams.audio) == 0:
            raise ValueError("无音频流")
        audio_in = input_container.streams.audio[0]
        rate = int(audio_in.codec_context.sample_rate or 44100)

        output_container = av.open(output_path, mode="w")
        audio_out = output_container.add_stream(codec_name, rate=rate)
        try:
            audio_out.codec_context.time_base = Fraction(1, rate)
        except Exception:
            pass

        if start_sec > 0:
            try:
                input_container.seek(int(start_sec * 1000000), any_frame=False, backward=True, stream=audio_in)
            except Exception:
                pass

        sample_idx = 0
        stop = False
        for packet in input_container.demux(audio_in):
            if stop:
                break
            for frame in packet.decode():
                t = frame.time
                if t is None:
                    continue
                if t < start_sec - 0.001:
                    continue
                if t > end_sec + 0.5:
                    stop = True
                    break
                try:
                    frame.pts = sample_idx
                    frame.time_base = Fraction(1, rate)
                    sample_idx += frame.samples
                    for pkt in audio_out.encode(frame):
                        output_container.mux(pkt)
                except Exception as e:
                    print(f"[VideoAudioSimpleUploaderPW] pyav audio encode error: {e}")

        try:
            for pkt in audio_out.encode(None):
                output_container.mux(pkt)
        except Exception:
            pass
        if sample_idx == 0:
            raise ValueError("剪辑未产生任何音频采样")
    finally:
        if output_container is not None:
            output_container.close()
        input_container.close()


def _trim_media_file(input_path, output_path, start_sec, end_sec, is_audio, out_ext, bitrate=None):
    ffmpeg = _find_ffmpeg()
    if is_audio:
        if ffmpeg:
            _trim_audio_ffmpeg(ffmpeg, input_path, output_path, start_sec, end_sec, out_ext, bitrate)
        else:
            print("[VideoAudioSimpleUploaderPW] 未找到 ffmpeg，使用 PyAV 回退方案（建议安装 ffmpeg）")
            _trim_audio_pyav(input_path, output_path, start_sec, end_sec, out_ext)
    else:
        if ffmpeg:
            _trim_video_ffmpeg(ffmpeg, input_path, output_path, start_sec, end_sec)
        else:
            print("[VideoAudioSimpleUploaderPW] 未找到 ffmpeg，使用 PyAV 回退方案（建议安装 ffmpeg）")
            _trim_video_pyav(input_path, output_path, start_sec, end_sec)


def _get_thumb_cache_dir():
    d = os.path.join(folder_paths.get_temp_directory(), "pw_video_thumbs")
    os.makedirs(d, exist_ok=True)
    return d


def _generate_video_thumbnail(video_path):
    import av
    container = av.open(video_path)
    try:
        if len(container.streams.video) == 0:
            raise ValueError("No video stream")
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"

        first_img = None
        chosen_img = None
        checked = 0
        max_check = 90

        for frame in container.decode(stream):
            if frame.time is not None and frame.time > 3.0:
                break
            try:
                img = frame.to_image()
            except Exception:
                continue
            if first_img is None:
                first_img = img
            try:
                small = img.resize((16, 16)).convert("L")
                pixels = list(small.getdata())
                avg = sum(pixels) / len(pixels)
                if avg > 16:
                    chosen_img = img
                    break
            except Exception:
                chosen_img = img
                break
            checked += 1
            if checked >= max_check:
                break

        img = chosen_img if chosen_img is not None else first_img
        if img is None:
            raise ValueError("无法解码出任何帧用于缩略图")

        max_w = 480
        if img.width > max_w:
            ratio = max_w / img.width
            img = img.resize((max_w, int(img.height * ratio)))
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=80)
        return buf.getvalue()
    finally:
        container.close()


@PromptServer.instance.routes.get("/VideoAudioSimpleUploaderPW/thumbnail")
async def get_video_thumbnail(request):
    try:
        filename = request.query.get("filename", "")
        if not filename:
            return web.Response(status=400, text="No filename")

        video_path = filename
        if not os.path.isabs(video_path) or not os.path.exists(video_path):
            cand = os.path.join(folder_paths.get_input_directory(), filename)
            if os.path.exists(cand):
                video_path = cand
        if not os.path.exists(video_path):
            return web.Response(status=404, text="Video not found")

        st = os.stat(video_path)
        key_src = f"{video_path}|{st.st_mtime}|{st.st_size}"
        key = hashlib.md5(key_src.encode("utf-8")).hexdigest()
        cache_dir = _get_thumb_cache_dir()
        cache_path = os.path.join(cache_dir, key + ".jpg")

        if not os.path.exists(cache_path):
            jpeg_bytes = _generate_video_thumbnail(video_path)
            with open(cache_path, "wb") as f:
                f.write(jpeg_bytes)

        return web.FileResponse(cache_path, headers={
            "Content-Type": "image/jpeg",
            "Cache-Control": "public, max-age=86400"
        })
    except Exception as e:
        print(f"[VideoAudioSimpleUploaderPW] thumbnail error: {e}")
        return web.Response(status=500, text=str(e))


@PromptServer.instance.routes.post("/VideoAudioSimpleUploaderPW/trim_upload")
async def trim_upload_video(request):
    tmp_path = None
    try:
        post = await request.post()
        file = post.get("file")
        if file is None or not hasattr(file, "file"):
            return web.json_response({"error": "未提供文件"}, status=400)
        try:
            start_sec = float(post.get("start", 0))
        except Exception:
            start_sec = 0.0
        try:
            end_sec = float(post.get("end", 0))
        except Exception:
            end_sec = 0.0
        filename = str(post.get("filename", "") or "").strip() or "trimmed_media.mp4"
        subfolder = str(post.get("subfolder", "") or "").strip()

        if end_sec <= start_sec:
            return web.json_response({"error": "剪辑区间无效"}, status=400)

        filename = os.path.basename(filename)
        base = os.path.splitext(filename)[0] or "trimmed_media"
        base = re.sub(r'[^\w\-. ]+', '_', base).strip() or "trimmed_media"

        src_ext = os.path.splitext(filename)[1].lower() or ".mp4"
        is_audio = src_ext in PW_AUDIO_EXTS

        if src_ext == ".aac":
            out_ext = ".mp3"
        elif is_audio:
            out_ext = src_ext
        else:
            out_ext = ".mp4"

        tmp_file = tempfile.NamedTemporaryFile(delete=False, suffix=src_ext)
        tmp_path = tmp_file.name
        with tmp_file as tmp:
            while True:
                chunk = file.file.read(1024 * 1024)
                if not chunk:
                    break
                tmp.write(chunk)

        audio_bitrate = None
        if src_ext == ".aac":
            audio_bitrate = _get_audio_bitrate(tmp_path)
            if audio_bitrate:
                audio_bitrate = max(32000, min(320000, audio_bitrate))

        input_dir = folder_paths.get_input_directory()
        if subfolder:
            out_dir = os.path.join(input_dir, subfolder)
            os.makedirs(out_dir, exist_ok=True)
        else:
            out_dir = input_dir

        out_name = f"{base}{out_ext}"
        out_path = os.path.join(out_dir, out_name)
        counter = 1
        while os.path.exists(out_path):
            out_name = f"{base}_{counter}{out_ext}"
            out_path = os.path.join(out_dir, out_name)
            counter += 1

        _trim_media_file(tmp_path, out_path, start_sec, end_sec, is_audio, out_ext, audio_bitrate)

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
        print(f"[VideoAudioSimpleUploaderPW] trim_upload 错误: {e}")
        return web.json_response({"error": str(e)}, status=500)


class VideoAudioSimpleUploaderPW:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "video_paths": ("STRING", {"default": "", "multiline": True}),
                "input/": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "tooltip": "Upload sub-folder under input/ for uploaded videos"
                }),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("info",)
    FUNCTION = "load_videos"
    CATEGORY = "🔮PWUtility/Video"

    def load_videos(self, video_paths, **kwargs):
        valid_paths = [p.strip() for p in video_paths.split("\n") if p.strip()]
        input_dir = folder_paths.get_input_directory()

        total = len(valid_paths)
        if total == 0:
            return ("ℹ️ 当前节点中没有媒体。",)

        ready = 0
        problems = []
        for path in valid_paths:
            if path.startswith("local://"):
                problems.append((path, "local"))
                continue
            if os.path.exists(path):
                ready += 1
                continue
            candidate = os.path.join(input_dir, path)
            if os.path.exists(candidate):
                ready += 1
            else:
                problems.append((path, "missing"))

        if not problems:
            info = f"✅ 上传成功：{ready} / {total} 个媒体全部上传并就绪。"
        else:
            lines = [f"⚠️ 上传未完全成功：就绪 {ready} / 共 {total}。"]
            for path, kind in problems:
                if kind == "local":
                    rest = path[len("local://"):]
                    parts = rest.split("/", 1)
                    name = parts[1] if len(parts) > 1 else rest
                    lines.append(f"  ✗ {name}（本地媒体，未上传/上传失败）")
                else:
                    lines.append(f"  ✗ {path}（文件未找到）")
            info = "\n".join(lines)

        return (info,)


NODE_CLASS_MAPPINGS = {
    "VideoAudioSimpleUploaderPW": VideoAudioSimpleUploaderPW
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VideoAudioSimpleUploaderPW": "Video Audio Simple uploader PW"
}