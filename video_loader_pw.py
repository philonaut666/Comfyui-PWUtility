import os
import torch
import numpy as np
import folder_paths
import av
import json
import math
import gc
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
    # path-only source cache
    _source_cache = {}
    _source_cache_order = []
    _max_source_cache_entries = max(1, int(os.environ.get("PW_VIDEO_LOADER_SOURCE_CACHE_ENTRIES", "1")))

    # per-node last path record
    _node_last_path = {}

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "path": ("STRING", {"default": "", "forceInput": True, "tooltip": "Path to the video file"}),
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
            "hidden": {
                "unique_id": "UNIQUE_ID"
            }
        }

    RETURN_TYPES = ("IMAGE", "AUDIO", "INT", "FLOAT", "FLOAT", "STRING", "INT", "STRING")
    RETURN_NAMES = ("images", "audio", "frame_count", "duration", "fps", "video_info", "repeat_last_frame_count", "split_info")
    FUNCTION = "load_video"
    CATEGORY = "🔮PWUtility/Video"

    @staticmethod
    def _resolve_video_path(video_to_load, raise_error=True):
        if not video_to_load:
            if raise_error:
                raise FileNotFoundError("Video path is empty")
            return ""

        candidates = [video_to_load]

        try:
            candidates.append(folder_paths.get_annotated_filepath(video_to_load))
        except Exception:
            pass

        try:
            candidates.append(os.path.join(folder_paths.get_input_directory(), video_to_load))
        except Exception:
            pass

        for c in candidates:
            try:
                if c and os.path.exists(c):
                    return os.path.abspath(c)
            except Exception:
                pass

        if raise_error:
            raise FileNotFoundError(f"Video file not found: {video_to_load}")

        return video_to_load

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        """
        Help ComfyUI cache distinguish:
        - normal execution
        - path just changed execution, where internal parameters are reset before output
        """
        uid = kwargs.get("unique_id", "__global__")
        if uid is None:
            uid = "__global__"
        uid = str(uid)

        path = kwargs.get("path", "")
        if not path or not isinstance(path, str) or not path.strip():
            last = cls._node_last_path.get(uid, None)
            return f"{uid}|empty|{last is not None and last != ''}"

        resolved = cls._resolve_video_path(path.strip(), raise_error=False)
        last = cls._node_last_path.get(uid, None)
        path_changed = last is not None and last != resolved

        return f"{uid}|{resolved}|{path_changed}"

    @classmethod
    def _get_source_cache(cls, video_path):
        key = os.path.abspath(video_path)

        if key in cls._source_cache:
            if key in cls._source_cache_order:
                cls._source_cache_order.remove(key)
            cls._source_cache_order.append(key)
            return cls._source_cache[key]

        max_entries = max(1, int(cls._max_source_cache_entries))
        while len(cls._source_cache_order) >= max_entries:
            old_key = cls._source_cache_order.pop(0)
            cls._source_cache.pop(old_key, None)
            gc.collect()

        entry = cls._decode_full_source(video_path)
        cls._source_cache[key] = entry
        cls._source_cache_order.append(key)
        return entry

    @classmethod
    def _decode_full_source(cls, video_path):
        container = av.open(video_path)

        video_stream = container.streams.video[0] if len(container.streams.video) > 0 else None

        orig_w = video_stream.codec_context.width if video_stream else 512
        orig_h = video_stream.codec_context.height if video_stream else 512

        source_fps = 0.0
        if video_stream:
            avg_rate = getattr(video_stream, "average_rate", None) or getattr(video_stream, "guessed_rate", None)
            if avg_rate:
                source_fps = float(avg_rate)

        video_duration = 0.0
        if video_stream and video_stream.duration and video_stream.time_base:
            video_duration = float(video_stream.duration * video_stream.time_base)

        if video_duration <= 0 and getattr(container, "duration", None):
            try:
                video_duration = float(container.duration) / 1_000_000.0
            except Exception:
                pass

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

            c_space = getattr(cc, "colorspace", getattr(cc, "color_space", None))
            if c_space and hasattr(c_space, "name") and c_space.name != "UNSPECIFIED":
                src_colorspace = c_space
            elif c_space and isinstance(c_space, str) and "unspecified" not in c_space.lower():
                src_colorspace = c_space

            c_range = getattr(cc, "color_range", None)
            if c_range and hasattr(c_range, "name") and c_range.name != "UNSPECIFIED":
                src_color_range = c_range
            elif c_range and isinstance(c_range, str) and "unspecified" not in c_range.lower():
                src_color_range = c_range

        frames = []
        times = []
        last_time = 0.0

        if video_stream:
            video_stream.thread_type = "AUTO"

            expected_total = int(getattr(video_stream, "frames", 0) or 0)
            pbar = comfy.utils.ProgressBar(expected_total) if expected_total > 0 else None

            fallback_interval = 1.0 / source_fps if source_fps > 0 else 1.0 / 25.0

            for frame in container.decode(video_stream):
                t = frame.time
                if t is None:
                    if frame.pts is not None and video_stream.time_base:
                        t = float(frame.pts * float(video_stream.time_base))
                    else:
                        t = last_time + fallback_interval

                t = float(t)
                if t < last_time:
                    t = last_time + 1e-6

                try:
                    frame = frame.reformat(
                        format="rgb24",
                        src_colorspace=src_colorspace,
                        src_color_range=src_color_range,
                        dst_color_range=dst_range
                    )
                    frame_rgb = frame.to_ndarray(format="rgb24")
                except Exception as e:
                    print(f"[VideoLoaderPW] Color reformat failed, using default: {e}")
                    frame_rgb = frame.to_ndarray(format="rgb24")

                frames.append(torch.from_numpy(np.ascontiguousarray(frame_rgb)))
                times.append(float(t))
                last_time = float(t)

                if pbar:
                    pbar.update(1)

        container.close()

        if len(times) > 1 and source_fps <= 0:
            dt = times[-1] - times[0]
            if dt > 0:
                source_fps = float(len(times) - 1) / dt

        if video_duration <= 0 and len(times) > 0:
            video_duration = float(times[-1])

        if len(frames) > 0:
            frames_tensor = torch.stack(frames, dim=0).to(torch.uint8)
        else:
            frames_tensor = torch.empty((0, orig_h, orig_w, 3), dtype=torch.uint8)

        times_np = np.asarray(times, dtype=np.float64)

        source_frame_count = len(times)
        if source_frame_count == 0 and video_stream and getattr(video_stream, "frames", 0):
            source_frame_count = int(video_stream.frames)

        audio_waveform = None
        audio_sample_rate = 44100
        audio_first_time = 0.0

        try:
            container_a = av.open(video_path)
            if len(container_a.streams.audio) > 0:
                audio_stream = container_a.streams.audio[0]
                audio_stream.thread_type = "AUTO"
                audio_sample_rate = int(getattr(audio_stream, "rate", 44100) or 44100)

                resampler = av.AudioResampler(format="fltp")
                audio_data = []
                first_frame_time = None

                for frame in container_a.decode(audio_stream):
                    ft = frame.time
                    if ft is None:
                        if frame.pts is not None and audio_stream.time_base:
                            ft = float(frame.pts * float(audio_stream.time_base))
                        else:
                            ft = 0.0

                    if first_frame_time is None:
                        first_frame_time = float(ft)

                    resampled_frames = resampler.resample(frame)
                    for r_frame in resampled_frames:
                        audio_data.append(r_frame.to_ndarray())

                try:
                    flush_frames = resampler.resample(None)
                    for r_frame in flush_frames:
                        audio_data.append(r_frame.to_ndarray())
                except Exception:
                    pass

                if audio_data:
                    waveform_np = np.concatenate(audio_data, axis=1)
                    audio_waveform = torch.from_numpy(waveform_np).float()
                    audio_first_time = float(first_frame_time if first_frame_time is not None else 0.0)

            container_a.close()
        except Exception as e:
            print(f"[VideoLoaderPW] Audio track extraction skipped or failed: {e}")

        return {
            "frames": frames_tensor,
            "frame_times": times_np,
            "width": int(orig_w),
            "height": int(orig_h),
            "source_fps": float(source_fps),
            "duration": float(video_duration),
            "source_frame_count": int(source_frame_count),
            "audio_waveform": audio_waveform,
            "audio_sample_rate": int(audio_sample_rate),
            "audio_first_time": float(audio_first_time),
        }

    @staticmethod
    def _sample_frame_indices(frame_times_np, start_time, end_time, frame_rate, target_frame_count):
        n = int(frame_times_np.size)
        if n == 0 or frame_rate <= 0:
            return []

        if target_frame_count == 0:
            return []

        interval = 1.0 / float(frame_rate)
        eps = 1e-5

        start_search = float(start_time) - eps
        i = int(np.searchsorted(frame_times_np, start_search, side="left"))
        if i >= n:
            return []

        expected = float(start_time)
        indices = []

        end_inf = (end_time is None) or (isinstance(end_time, float) and math.isinf(end_time))
        max_outputs = target_frame_count if target_frame_count > 0 else 10_000_000

        while len(indices) < max_outputs:
            if not end_inf and expected >= float(end_time) - eps:
                break

            while i + 1 < n and frame_times_np[i] < expected - eps:
                i += 1

            if frame_times_np[i] < expected - eps:
                break

            indices.append(i)
            expected += interval

        return indices

    @staticmethod
    def _compute_waveform_peaks(audio_dict):
        waveform_peaks = []

        if not audio_dict or "waveform" not in audio_dict:
            return waveform_peaks

        waveform = audio_dict.get("waveform", None)
        if waveform is None or waveform.numel() == 0:
            return waveform_peaks

        if waveform.dim() == 3:
            w_tensor = waveform[0]
        else:
            w_tensor = waveform

        if w_tensor.dim() == 2:
            w_tensor = w_tensor.mean(dim=0)

        num_samples = w_tensor.shape[0]
        target_peaks = 800

        if num_samples <= 0:
            return waveform_peaks

        chunk_size = max(1, num_samples // target_peaks)
        usable_samples = (num_samples // chunk_size) * chunk_size

        if usable_samples <= 0:
            return waveform_peaks

        w_reshaped = w_tensor[:usable_samples].reshape(-1, chunk_size)
        mins = w_reshaped.min(dim=1).values
        maxs = w_reshaped.max(dim=1).values

        global_max = max(float(maxs.max()), abs(float(mins.min())))
        scale_factor = 1.0
        if global_max > 0 and global_max < 0.2:
            scale_factor = 0.2 / global_max

        mins = (mins * scale_factor).clamp(-1.0, 1.0)
        maxs = (maxs * scale_factor).clamp(-1.0, 1.0)

        waveform_peaks = [[round(mn, 3), round(mx, 3)] for mn, mx in zip(mins.tolist(), maxs.tolist())]

        return waveform_peaks

    def load_video(
        self,
        path,
        frame_rate,
        display_mode,
        start_time,
        end_time,
        start_frame,
        end_frame,
        crop_x=0.0,
        crop_y=0.0,
        crop_w=1.0,
        crop_h=1.0,
        split_count=0,
        split_purple_point=0.0,
        split_purple_point_idx=0,
        split_green_point=0.0,
        split_green_point_idx=0,
        select_generate="blue",
        **kwargs
    ):
        align_8n_plus_1 = kwargs.get("align_8n+1", True)
        unique_id = kwargs.get("unique_id", "__global__")
        if unique_id is None:
            unique_id = "__global__"
        node_key = str(unique_id)

        video_to_load = path.strip() if (path and isinstance(path, str) and path.strip()) else ""

        if not video_to_load:
            self.__class__._node_last_path[node_key] = ""
            empty_image = torch.zeros((1, 512, 512, 3), dtype=torch.float32)
            return {
                "ui": {"video_path": [""], "video_info": ["{}"]},
                "result": (empty_image, None, 0, 0.0, float(frame_rate), "{}", 0, "{}")
            }

        video_path = self._resolve_video_path(video_to_load, raise_error=True)
        cache_key = os.path.abspath(video_path)

        last_path = self.__class__._node_last_path.get(node_key, None)
        path_changed = last_path is not None and last_path != cache_key

        # When path changes, reset adjustable parameters BEFORE computing outputs.
        # When path does not change, keep current parameters and current cache.
        if path_changed:
            start_time = 0.0
            end_time = 0.0
            start_frame = 0
            end_frame = 0

            crop_x = 0.0
            crop_y = 0.0
            crop_w = 1.0
            crop_h = 1.0

            split_count = 0
            split_purple_point = 0.0
            split_purple_point_idx = 0
            split_green_point = 0.0
            split_green_point_idx = 0
            select_generate = "blue"

        self.__class__._node_last_path[node_key] = cache_key

        cache = self._get_source_cache(cache_key)

        orig_w = int(cache.get("width", 512))
        orig_h = int(cache.get("height", 512))
        source_fps = float(cache.get("source_fps", 0.0))
        source_duration = float(cache.get("duration", 0.0))
        source_frame_count = int(cache.get("source_frame_count", 0))

        fr = float(frame_rate) if frame_rate > 0 else 25.0

        manual_crop_left = int(orig_w * crop_x)
        manual_crop_top = int(orig_h * crop_y)
        manual_crop_right = orig_w - int(orig_w * (crop_x + crop_w))
        manual_crop_bottom = orig_h - int(orig_h * (crop_y + crop_h))

        manual_crop_left = max(0, min(manual_crop_left, orig_w - 1))
        manual_crop_top = max(0, min(manual_crop_top, orig_h - 1))
        manual_crop_right = max(0, min(manual_crop_right, orig_w - manual_crop_left - 1))
        manual_crop_bottom = max(0, min(manual_crop_bottom, orig_h - manual_crop_top - 1))

        s_frame_0 = max(0, int(start_frame))
        e_frame_0 = int(end_frame) if end_frame > 0 else 0

        if display_mode == "frames":
            actual_start_time = float(s_frame_0) / fr
            actual_end_time = float(e_frame_0 + 1) / fr if e_frame_0 > 0 else (source_duration if source_duration > 0 else float("inf"))
        else:
            actual_start_time = float(start_time)
            actual_end_time = float(end_time) if (end_time > 0 and end_time > start_time) else (source_duration if source_duration > 0 else float("inf"))

        if actual_end_time <= 0:
            actual_end_time = float("inf")

        target_frame_count = -1
        if display_mode == "frames" and e_frame_0 > 0:
            target_frame_count = e_frame_0 - s_frame_0 + 1
            if target_frame_count < 0:
                target_frame_count = 0

        frame_times_np = cache.get("frame_times", np.asarray([], dtype=np.float64))
        indices = self._sample_frame_indices(
            frame_times_np,
            actual_start_time,
            actual_end_time,
            fr,
            target_frame_count
        )

        frames_loaded = 0
        if len(indices) > 0:
            idx_tensor = torch.from_numpy(np.asarray(indices, dtype=np.int64))
            frames_uint = cache["frames"].index_select(0, idx_tensor)

            if manual_crop_left > 0 or manual_crop_top > 0 or manual_crop_right > 0 or manual_crop_bottom > 0:
                frames_uint = frames_uint[
                    :,
                    manual_crop_top:orig_h - manual_crop_bottom,
                    manual_crop_left:orig_w - manual_crop_right,
                    :
                ]

            image_tensor = frames_uint.float().div_(255.0)
            frames_loaded = int(image_tensor.shape[0])
        else:
            image_tensor = torch.zeros((1, 512, 512, 3), dtype=torch.float32)

        audio_dict = None

        wave_full = cache.get("audio_waveform", None)
        if wave_full is not None and wave_full.numel() > 0:
            sample_rate = int(cache.get("audio_sample_rate", 44100))
            first_frame_time = float(cache.get("audio_first_time", 0.0))

            offset_sec = max(0.0, actual_start_time - first_frame_time)
            start_sample = int(offset_sec * sample_rate)

            if actual_end_time == float("inf"):
                end_sample = wave_full.shape[1]
            else:
                duration_sec_audio = actual_end_time - actual_start_time
                end_sample = start_sample + int(duration_sec_audio * sample_rate)

            total_samples = wave_full.shape[1]
            start_sample = max(0, min(start_sample, total_samples))
            end_sample = max(start_sample, min(end_sample, total_samples))

            waveform = wave_full[:, start_sample:end_sample].unsqueeze(0)
            audio_dict = {"waveform": waveform, "sample_rate": sample_rate}

        frame_count = image_tensor.shape[0] if frames_loaded > 0 else 0
        final_duration_sec = round(float(frame_count / fr), 2)

        if display_mode == "frames":
            g_start_frame = s_frame_0
            if e_frame_0 > 0:
                g_end_frame = e_frame_0
            else:
                g_end_frame = g_start_frame + max(0, frame_count - 1)
        else:
            g_start_frame = int(round(actual_start_time * fr))
            if actual_end_time == float("inf"):
                g_end_frame = g_start_frame + max(0, frame_count - 1)
            else:
                g_end_frame = max(g_start_frame, int(round(actual_end_time * fr)) - 1)

        g_start_frame = max(0, g_start_frame)
        g_end_frame = max(g_start_frame, g_end_frame)

        # Use actual output frame count as local end index.
        g_end_local = max(0, frame_count - 1)

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
            if p_local < 1:
                p_local = 1
            if p_local > g_end_local - 1:
                p_local = g_end_local - 1

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

            if p_local < 1:
                p_local = 1
            if g_local < p_local + 1:
                g_local = p_local + 1
            if g_local > g_end_local - 1:
                g_local = g_end_local - 1

            if align_8n_plus_1:
                N = g_local - p_local
                if N < 1:
                    N = 1
                target_N = math.ceil((N - 1) / 8) * 8 + 1
                g_local = min(g_end_local - 1, p_local + target_N)

            split_info_dict["split_front"] = calc_segment(0, p_local - 1)
            split_info_dict["split_generate"] = calc_segment(p_local, g_local - 1)
            split_info_dict["split_back"] = calc_segment(g_local, g_end_local)

        split_info_str = json.dumps(split_info_dict)

        # Final waveform peaks after all audio adjustments.
        waveform_peaks = self._compute_waveform_peaks(audio_dict)

        loaded_h = int(image_tensor.shape[1]) if frame_count > 0 and image_tensor is not None else 0
        loaded_w = int(image_tensor.shape[2]) if frame_count > 0 and image_tensor is not None else 0

        full_frame_count_at_loaded_fps = int(round(source_duration * fr)) if source_duration > 0 else frame_count

        # Final video_info after all calculations.
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
            "full_duration": round(source_duration, 2),
            "full_frame_count_at_loaded_fps": full_frame_count_at_loaded_fps,
            "waveform_peaks": waveform_peaks,
        }, indent=4)

        return {
            "ui": {"video_path": [str(video_to_load)], "video_info": [video_info]},
            "result": (
                image_tensor,
                audio_dict,
                frame_count,
                final_duration_sec,
                float(frame_rate),
                video_info,
                repeat_last_frame_count,
                split_info_str
            )
        }


NODE_CLASS_MAPPINGS = {"VideoLoaderPW": VideoLoaderPW}
NODE_DISPLAY_NAME_MAPPINGS = {"VideoLoaderPW": "Video Loader PW"}