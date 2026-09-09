import os
import json
import time
import torch
import numpy as np
from PIL import Image
import folder_paths
from comfy.utils import common_upscale
from server import PromptServer
from aiohttp import web

import av


# 模块级存储：node_id -> 最近一次执行的 preview slots（供前端 HTTP 兜底通道拉取）
PREVIEW_SLOTS_STORE = {}

THUMB_MAX_SIDE = 512


def _make_thumbnail(uid_str, slot_index, path):
    """生成 UI 图片格子缩略图，固定文件名覆盖写入，避免 temp 目录堆积"""
    temp_dir = folder_paths.get_temp_directory()
    os.makedirs(temp_dir, exist_ok=True)
    filename = f"pw_mm3x3_{uid_str}_slot{slot_index}.jpg"
    filepath = os.path.join(temp_dir, filename)
    with Image.open(path) as img:
        img = img.convert("RGB")
        thumb = img.copy()
        thumb.thumbnail((THUMB_MAX_SIDE, THUMB_MAX_SIDE), Image.LANCZOS)
        thumb.save(filepath, "JPEG", quality=88)
    return filename


def _materialize_slots(data):
    """将 lazy 的图片槽位按需补生成缩略图（Preview 开关从 false 切回 true 时使用）"""
    if not isinstance(data, dict):
        return data
    uid_str = str(data.get("uid", "0"))
    for item in data.get("images", []):
        if isinstance(item, dict) and item.get("lazy") and item.get("path") and not item.get("filename"):
            try:
                filename = _make_thumbnail(uid_str, item.get("slot", 0), item["path"])
                item["filename"] = filename
                item["subfolder"] = ""
                item["type"] = "temp"
                item["ts"] = int(time.time() * 1000)
                item.pop("lazy", None)
            except Exception as e:
                print(f"[MiniMaxH3MediaPreviewPW] materialize thumbnail failed: {item.get('path')}: {e}")
    return data


@PromptServer.instance.routes.get("/pw_media_file_view")
async def pw_media_file_view(request):
    """为前端 video / audio 格子提供原始文件流"""
    file_path = request.query.get("filename", "")
    if os.path.exists(file_path) and os.path.isfile(file_path):
        return web.FileResponse(file_path)
    return web.Response(status=404, text="File not found")


@PromptServer.instance.routes.get("/pw_media_preview_slots")
async def pw_media_preview_slots(request):
    """前端兜底通道：按 node_id 查询最近一次执行的 preview slots；materialize=1 时按需补生成缩略图"""
    node_id = str(request.query.get("node_id", ""))
    materialize = str(request.query.get("materialize", "0")) == "1"
    data = PREVIEW_SLOTS_STORE.get(node_id, None)
    if data is None:
        return web.json_response({"slots": None})
    if materialize:
        data = _materialize_slots(data)
        PREVIEW_SLOTS_STORE[node_id] = data
    return web.json_response({"slots": data})


IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tiff", ".tif")
VIDEO_EXTS = (".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".mpg", ".mpeg", ".ts")
AUDIO_EXTS = (".mp3", ".wav", ".flac", ".aac", ".ogg", ".m4a", ".wma", ".opus")


class MiniMaxH3MediaPreviewPW:
    MAX_IMAGES = 9
    MAX_VIDEOS = 3
    MAX_AUDIO = 3

    CELL_SIZE = 512

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "paths": ("LMM_ALL_PATHS",),
                "Preview": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "Enable or disable the preview panel. Does NOT affect the media pack output."
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID"
            }
        }

    RETURN_TYPES = ("PW_MEDIA_PACK",)
    RETURN_NAMES = ("media pack",)
    FUNCTION = "preview_and_pack"
    CATEGORY = "🔮PWUtility/Media"
    OUTPUT_NODE = True

    # ---------- 解析与分类 ----------
    @staticmethod
    def _parse_selection(paths):
        """兼容：JSON 字符串 / list / 包装 dict"""
        data = paths
        if isinstance(data, str):
            try:
                data = json.loads(data)
            except Exception:
                print(f"[MiniMaxH3MediaPreviewPW] paths JSON 解析失败, raw preview: {data[:500]}")
                return []
        if isinstance(data, dict):
            collected = []
            for key in ("items", "files", "paths", "selection", "images", "videos", "audio", "audios"):
                v = data.get(key)
                if isinstance(v, list):
                    collected.extend(v)
            return collected if collected else [data]
        if isinstance(data, list):
            return data
        return []

    @staticmethod
    def _classify_item(item):
        """优先使用 type 字段，缺失时按扩展名兜底分类"""
        if not isinstance(item, dict) or "path" not in item:
            return None
        t = str(item.get("type", "")).lower()
        if t in ("image", "video", "audio"):
            return t
        ext = os.path.splitext(str(item.get("path", "")).lower())[1]
        if ext in IMAGE_EXTS:
            return "image"
        if ext in VIDEO_EXTS:
            return "video"
        if ext in AUDIO_EXTS:
            return "audio"
        return None

    # ---------- 工具方法 ----------
    def resize_and_pad(self, tensor, target_size=512):
        """等比例缩放并居中填充黑边，确保图片不会变形或被裁剪"""
        h, w = tensor.shape[1], tensor.shape[2]
        if h == 0 or w == 0:
            return torch.zeros((1, target_size, target_size, 3), dtype=torch.float32)

        scale = min(target_size / h, target_size / w)
        new_h, new_w = int(h * scale), int(w * scale)

        if new_h == 0 or new_w == 0:
            return torch.zeros((1, target_size, target_size, 3), dtype=torch.float32)

        tensor_chw = tensor.movedim(-1, 1)
        tensor_resized = common_upscale(tensor_chw, new_w, new_h, "lanczos", "disabled")
        tensor_resized = tensor_resized.movedim(1, -1)

        pad_top = (target_size - new_h) // 2
        pad_left = (target_size - new_w) // 2

        padded = torch.zeros((1, target_size, target_size, 3), dtype=torch.float32)
        padded[:, pad_top:pad_top+new_h, pad_left:pad_left+new_w, :] = tensor_resized
        return padded

    def _load_video_object(self, path):
        """使用 ComfyUI 官方原生 VIDEO 实现（含画面与音轨），与官方 LoadVideo 节点一致"""
        try:
            from comfy_api.latest import InputImpl
        except Exception:
            raise RuntimeError(
                "[MiniMaxH3MediaPreviewPW] 当前 ComfyUI 版本不支持原生 VIDEO 类型（缺少 comfy_api.latest），请升级 ComfyUI。"
            )
        if not hasattr(InputImpl, "VideoFromFile"):
            raise RuntimeError(
                "[MiniMaxH3MediaPreviewPW] 当前 ComfyUI 版本缺少 InputImpl.VideoFromFile，请升级 ComfyUI。"
            )
        return InputImpl.VideoFromFile(path)

    def _load_audio_dict(self, path):
        """解码音频文件为 ComfyUI 标准 AUDIO 字典：{"waveform": (1,C,N), "sample_rate": int}"""
        with av.open(path) as container:
            if len(container.streams.audio) == 0:
                return None
            stream = container.streams.audio[0]
            sample_rate = int(getattr(stream, "rate", 44100) or 44100)

            resampler = av.AudioResampler(format="fltp")
            chunks = []
            for frame in container.decode(stream):
                for rf in resampler.resample(frame):
                    chunks.append(torch.from_numpy(rf.to_ndarray()))
            try:
                for rf in resampler.resample(None):
                    chunks.append(torch.from_numpy(rf.to_ndarray()))
            except Exception:
                pass

            if not chunks:
                return None

            waveform = torch.cat(chunks, dim=1).float()  # (C, N)
            return {"waveform": waveform.unsqueeze(0), "sample_rate": sample_rate}

    # ---------- 主函数 ----------
    def preview_and_pack(self, paths, Preview=True, unique_id=None):
        preview_on = bool(Preview)

        selection_list = self._parse_selection(paths)

        image_items, video_items, audio_items = [], [], []
        for item in selection_list:
            kind = self._classify_item(item)
            if kind == "image":
                image_items.append(item)
            elif kind == "video":
                video_items.append(item)
            elif kind == "audio":
                audio_items.append(item)

        print(f"[MiniMaxH3MediaPreviewPW] parsed items: images={len(image_items)}, videos={len(video_items)}, audio={len(audio_items)}, preview_on={preview_on}")
        if not selection_list:
            print(f"[MiniMaxH3MediaPreviewPW] raw paths preview: {str(paths)[:500]}")

        # 超量检查：打断工作流并弹窗提示
        over_i = max(0, len(image_items) - self.MAX_IMAGES)
        over_v = max(0, len(video_items) - self.MAX_VIDEOS)
        over_a = max(0, len(audio_items) - self.MAX_AUDIO)
        if over_i or over_v or over_a:
            parts = []
            if over_i:
                parts.append(f"图片多了 {over_i} 张（最多 {self.MAX_IMAGES} 张）")
            if over_v:
                parts.append(f"视频多了 {over_v} 个（最多 {self.MAX_VIDEOS} 个）")
            if over_a:
                parts.append(f"音频多了 {over_a} 个（最多 {self.MAX_AUDIO} 个）")
            raise RuntimeError("[MiniMaxH3MediaPreviewPW] 选择数量超出限制：" + "；".join(parts))

        uid_str = str(unique_id) if unique_id is not None else "0"
        ts = int(time.time() * 1000)

        media_pack = {"images": [], "videos": [], "audio": []}
        preview_slots = {"images": [], "videos": [], "audio": [], "uid": uid_str, "preview_on": preview_on}

        # 图片槽位 0-8（media pack 不受 Preview 开关影响；缩略图仅在开关开启时生成）
        for slot_index, item in enumerate(image_items):
            img_path = item["path"]
            if not os.path.exists(img_path):
                continue
            try:
                with Image.open(img_path) as img:
                    img = img.convert("RGB")
                    img_array = np.array(img).astype(np.float32) / 255.0
                    tensor = torch.from_numpy(img_array)[None, ]
                    tensor_resized = self.resize_and_pad(tensor, self.CELL_SIZE)

                media_pack["images"].append({
                    "type": "image",
                    "tensor": tensor_resized,
                    "path": img_path,
                    "metadata": item.get("metadata", {})
                })

                if preview_on:
                    filename = _make_thumbnail(uid_str, slot_index, img_path)
                    preview_slots["images"].append({
                        "slot": slot_index,
                        "filename": filename,
                        "subfolder": "",
                        "type": "temp",
                        "path": img_path,
                        "ts": ts,
                    })
                else:
                    # lazy：不生成缩略图，等开关切回 true 时按需补生成
                    preview_slots["images"].append({
                        "slot": slot_index,
                        "path": img_path,
                        "lazy": True,
                    })
            except Exception as e:
                print(f"[MiniMaxH3MediaPreviewPW] Failed to load image {img_path}: {e}")
                continue

        # 视频槽位 0-2（官方原生 VIDEO 对象，含画面+音轨）
        for slot_index, item in enumerate(video_items):
            video_path = item["path"]
            if not os.path.exists(video_path):
                continue
            try:
                video_obj = self._load_video_object(video_path)
                media_pack["videos"].append({
                    "type": "video",
                    "video": video_obj,
                    "path": video_path,
                    "metadata": item.get("metadata", {})
                })
                preview_slots["videos"].append({
                    "slot": slot_index,
                    "path": video_path,
                })
            except Exception as e:
                print(f"[MiniMaxH3MediaPreviewPW] Failed to load video {video_path}: {e}")
                continue

        # 音频槽位 0-2（标准 AUDIO 字典）
        for slot_index, item in enumerate(audio_items):
            audio_path = item["path"]
            if not os.path.exists(audio_path):
                continue
            try:
                audio_dict = self._load_audio_dict(audio_path)
                if audio_dict is None:
                    print(f"[MiniMaxH3MediaPreviewPW] No audio stream in {audio_path}")
                    continue
                media_pack["audio"].append({
                    "type": "audio",
                    "audio": audio_dict,
                    "path": audio_path,
                    "metadata": item.get("metadata", {})
                })
                preview_slots["audio"].append({
                    "slot": slot_index,
                    "path": audio_path,
                })
            except Exception as e:
                print(f"[MiniMaxH3MediaPreviewPW] Failed to load audio {audio_path}: {e}")
                continue

        # 写入模块级存储，供前端 HTTP 兜底通道拉取
        PREVIEW_SLOTS_STORE[uid_str] = preview_slots

        print(f"[MiniMaxH3MediaPreviewPW] preview slots: images={len(preview_slots['images'])}, videos={len(preview_slots['videos'])}, audio={len(preview_slots['audio'])}")

        return {
            "ui": {"pw_preview_slots": preview_slots},
            "result": (media_pack,),
        }


NODE_CLASS_MAPPINGS = {
    "MiniMaxH3MediaPreviewPW": MiniMaxH3MediaPreviewPW
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxH3MediaPreviewPW": "MiniMax H3 Media Preview PW"
}
