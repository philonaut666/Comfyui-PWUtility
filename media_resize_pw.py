import os
import io
from fractions import Fraction

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

import comfy.utils
from comfy.utils import common_upscale


class MediaResizePW:
    """
    对 PW_MEDIA_PACK 中的 image / video 画面进行缩放。
    缩放模块与 Image Loader PW 完全一致（scale_mode / width / height / longer_size /
    shorter_size / interpolation / resize_method / pad_color / crop_position / multiple_of / img_compression）。

    - 输入/输出均为 media_pack，所有资产只在内存中处理，不落盘。
    - img_compression 仅作用于 image（JPEG 质量往返），视频不做压缩。
    - video 开关开启时同步缩放 video_imgs（保留原音轨与帧率）；关闭时视频原样。
    - 所有 audio 始终保持原样。
    - 不修改上游 pack 对象（逐项浅拷贝），避免污染 ComfyUI 执行缓存。
    """

    CELL_SIZE = 512  # 与 MiniMaxH3MediaPreviewPW 的图片 tensor 规格一致

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "media_pack": ("PW_MEDIA_PACK",),
                "scale_mode": (["none", "scale dimensions", "scale longer", "scale shorter"],),
                "width": ("INT", {"default": 0, "min": 0, "max": 8192, "step": 1}),
                "height": ("INT", {"default": 0, "min": 0, "max": 8192, "step": 1}),
                "longer_size": ("INT", {"default": 1024, "min": 0, "max": 8192, "step": 1}),
                "shorter_size": ("INT", {"default": 1024, "min": 0, "max": 8192, "step": 1}),
                "interpolation": (["lanczos", "nearest", "bilinear", "bicubic", "area", "nearest-exact"],),
                "resize_method": (["keep proportion", "stretch", "pad", "crop"],),
                "pad_color": ("STRING", {"default": "0,0,0"}),
                "crop_position": (["center", "top", "bottom", "left", "right"],),
                "multiple_of": ("INT", {"default": 32, "min": 0, "max": 512, "step": 1}),
                "img_compression": ("INT", {"default": 0, "min": 0, "max": 100, "step": 1}),
                "video": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "开启后 video_imgs 同步缩放（不做 img_compression）；关闭则视频原样输出。"
                }),
            },
        }

    RETURN_TYPES = ("PW_MEDIA_PACK",)
    RETURN_NAMES = ("media pack",)
    FUNCTION = "resize_media"
    CATEGORY = "🔮PWUtility/Media"
    OUTPUT_NODE = False

    # ---------- 缩放引擎（与 ImageLoaderPW.resize_image 一致） ----------
    def resize_image(self, image, width, height, resize_method="keep proportion", interpolation="nearest", multiple_of=0, pad_color=(0.0, 0.0, 0.0), crop_position="center"):
        MAX_RESOLUTION = 8192
        _, oh, ow, _ = image.shape
        x = y = x2 = y2 = 0
        pad_left = pad_right = pad_top = pad_bottom = 0

        if multiple_of > 1:
            width = width - (width % multiple_of)
            height = height - (height % multiple_of)

        if resize_method == 'keep proportion' or resize_method == 'pad':
            if width == 0 and oh < height:
                width = MAX_RESOLUTION
            elif width == 0 and oh >= height:
                width = ow

            if height == 0 and ow < width:
                height = MAX_RESOLUTION
            elif height == 0 and ow >= width:
                height = oh

            ratio = min(width / ow, height / oh)
            new_width = round(ow * ratio)
            new_height = round(oh * ratio)

            if resize_method == 'pad':
                pad_left = (width - new_width) // 2
                pad_right = width - new_width - pad_left
                pad_top = (height - new_height) // 2
                pad_bottom = height - new_height - pad_top

            width = new_width
            height = new_height

        elif resize_method == 'crop':
            width = width if width > 0 else ow
            height = height if height > 0 else oh

            ratio = max(width / ow, height / oh)
            new_width = round(ow * ratio)
            new_height = round(oh * ratio)

            if crop_position == "center":
                x = (new_width - width) // 2
                y = (new_height - height) // 2
            elif crop_position == "top":
                x = (new_width - width) // 2
                y = 0
            elif crop_position == "bottom":
                x = (new_width - width) // 2
                y = new_height - height
            elif crop_position == "left":
                x = 0
                y = (new_height - height) // 2
            elif crop_position == "right":
                x = new_width - width
                y = (new_height - height) // 2
            else:
                x = (new_width - width) // 2
                y = (new_height - height) // 2

            x2 = x + width
            y2 = y + height
            if x2 > new_width:
                x -= (x2 - new_width)
            if x < 0:
                x = 0
            if y2 > new_height:
                y -= (y2 - new_height)
            if y < 0:
                y = 0
            width = new_width
            height = new_height

        else:  # stretch
            width = width if width > 0 else ow
            height = height if height > 0 else oh

        outputs = image.permute(0, 3, 1, 2)

        if interpolation == "lanczos":
            outputs = comfy.utils.lanczos(outputs, width, height)
        else:
            outputs = F.interpolate(outputs, size=(height, width), mode=interpolation)

        if resize_method == 'pad':
            if pad_left > 0 or pad_right > 0 or pad_top > 0 or pad_bottom > 0:
                B, C, H_New, W_New = outputs.shape
                H_target = H_New + pad_top + pad_bottom
                W_target = W_New + pad_left + pad_right

                r, g, b = pad_color
                background = torch.zeros((B, C, H_target, W_target), device=outputs.device, dtype=outputs.dtype)
                background[:, 0, :, :] = r
                background[:, 1, :, :] = g
                background[:, 2, :, :] = b

                background[:, :, pad_top:pad_top+H_New, pad_left:pad_left+W_New] = outputs
                outputs = background

        outputs = outputs.permute(0, 2, 3, 1)

        if resize_method == 'crop':
            if x > 0 or y > 0 or x2 > 0 or y2 > 0:
                outputs = outputs[:, y:y2, x:x2, :]

        if multiple_of > 1 and (outputs.shape[2] % multiple_of != 0 or outputs.shape[1] % multiple_of != 0):
            w = outputs.shape[2]
            h = outputs.shape[1]
            cx = (w % multiple_of) // 2
            cy = (h % multiple_of) // 2
            cx2 = w - ((w % multiple_of) - cx)
            cy2 = h - ((h % multiple_of) - cy)
            outputs = outputs[:, cy:cy2, cx:cx2, :]

        outputs = torch.clamp(outputs, 0, 1)
        return outputs

    # ---------- 颜色解析（与 ImageLoaderPW.parse_color 一致） ----------
    @staticmethod
    def _parse_color(color_str):
        try:
            parts = [int(x.strip()) for x in color_str.split(",")]
            if len(parts) == 3:
                return tuple(max(0, min(255, p)) / 255.0 for p in parts)
            elif len(parts) == 1:
                val = max(0, min(255, parts[0])) / 255.0
                return (val, val, val)
        except Exception:
            pass
        return (0.0, 0.0, 0.0)

    # ---------- 各缩放模式的目标尺寸计算（逐分支镜像 ImageLoaderPW.load_images） ----------
    def _apply_scale(self, t, scale_mode, width, height, longer_size, shorter_size,
                     interpolation, resize_method, multiple_of, pad_color_rgb, crop_position):
        _, oh, ow, _ = t.shape

        def align(v):
            if multiple_of <= 1:
                return v
            return round(v / multiple_of) * multiple_of

        target_w, target_h = width, height
        actual_resize_method = resize_method
        use_internal_multiple = multiple_of

        if scale_mode == "scale longer":
            base_size = longer_size if longer_size > 0 else max(oh, ow)
            if oh >= ow:
                target_h = align(base_size)
                target_w = align(ow * (target_h / oh))
            else:
                target_w = align(base_size)
                target_h = align(oh * (target_w / ow))
            target_w, target_h = int(max(1, target_w)), int(max(1, target_h))
            if resize_method == "keep proportion":
                actual_resize_method = "stretch"
            use_internal_multiple = 0

        elif scale_mode == "scale shorter":
            base_size = shorter_size if shorter_size > 0 else min(oh, ow)
            if oh <= ow:
                target_h = align(base_size)
                target_w = align(ow * (target_h / oh))
            else:
                target_w = align(base_size)
                target_h = align(oh * (target_w / ow))
            target_w, target_h = int(max(1, target_w)), int(max(1, target_h))
            if resize_method == "keep proportion":
                actual_resize_method = "stretch"
            use_internal_multiple = 0

        elif scale_mode == "scale dimensions":
            if width == 0 and height == 0:
                use_internal_multiple = 0

        return self.resize_image(t, target_w, target_h, actual_resize_method, interpolation,
                                 use_internal_multiple, pad_color_rgb, crop_position)

    # ---------- JPEG 压缩往返（与 ImageLoaderPW 一致，仅用于 image） ----------
    @staticmethod
    def _jpeg_compress(t, img_compression):
        img_np = (t[0].numpy() * 255).clip(0, 255).astype(np.uint8)
        img_pil = Image.fromarray(img_np)
        buf = io.BytesIO()
        img_pil.save(buf, format="JPEG", quality=max(1, 100 - img_compression))
        buf.seek(0)
        img_pil = Image.open(buf)
        return torch.from_numpy(np.array(img_pil).astype(np.float32) / 255.0)[None,]

    # ---------- 512 缩放+pad（与 MiniMaxH3MediaPreviewPW 一致） ----------
    def _resize_and_pad(self, tensor, target_size=512):
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
        padded[:, pad_top:pad_top + new_h, pad_left:pad_left + new_w, :] = tensor_resized
        return padded

    # ---------- 读取图片原分辨率 tensor ----------
    @staticmethod
    def _load_full_image(item):
        path = item.get("path")
        if path and os.path.exists(path):
            try:
                with Image.open(path) as img:
                    img = img.convert("RGB")
                    arr = np.array(img).astype(np.float32) / 255.0
                    return torch.from_numpy(arr)[None,]
            except Exception as e:
                print(f"[MediaResizePW] Failed to load image from path {path}: {e}")
        tf = item.get("tensor_full")
        if isinstance(tf, torch.Tensor) and tf.numel() > 0:
            return tf
        t = item.get("tensor")
        if isinstance(t, torch.Tensor) and t.numel() > 0:
            return t
        return None

    # ---------- 视频分量工具（与官方 Create Video / Repack 一致） ----------
    @staticmethod
    def _get_components(video_obj):
        if video_obj is None or not hasattr(video_obj, "get_components"):
            return None
        try:
            return video_obj.get_components()
        except Exception as e:
            print(f"[MediaResizePW] Failed to get video components: {e}")
            return None

    @staticmethod
    def _build_video(images, audio, frame_rate):
        try:
            from comfy_api.latest import InputImpl, Types
        except Exception:
            raise RuntimeError("[MediaResizePW] 当前 ComfyUI 版本不支持原生 VIDEO 类型（缺少 comfy_api.latest），请升级 ComfyUI。")
        if not hasattr(InputImpl, "VideoFromComponents"):
            raise RuntimeError("[MediaResizePW] 当前 ComfyUI 版本缺少 InputImpl.VideoFromComponents，请升级 ComfyUI。")
        return InputImpl.VideoFromComponents(
            Types.VideoComponents(images=images, audio=audio, frame_rate=frame_rate)
        )

    # ---------- 主函数 ----------
    def resize_media(self, media_pack, scale_mode, width, height, longer_size, shorter_size,
                     interpolation, resize_method, pad_color, crop_position, multiple_of,
                     img_compression, video):
        if not isinstance(media_pack, dict):
            raise ValueError(
                "[MediaResizePW] media_pack 输入不是有效的 PW_MEDIA_PACK，"
                "请连接 MiniMax H3 Media Preview PW / Media Repack PW / Media Resize PW 的输出。"
            )

        out_pack = dict(media_pack)
        images = [dict(x) if isinstance(x, dict) else x for x in (media_pack.get("images") or [])]
        videos = [dict(x) if isinstance(x, dict) else x for x in (media_pack.get("videos") or [])]
        audios = [dict(x) if isinstance(x, dict) else x for x in (media_pack.get("audio") or [])]  # audio 永远原样

        do_resize = (scale_mode != "none")
        do_compress = (img_compression > 0)
        pad_color_rgb = self._parse_color(pad_color)

        # ========== 1. 图片：缩放 + 可选压缩 ==========
        if do_resize or do_compress:
            for i, item in enumerate(images):
                if not isinstance(item, dict):
                    continue
                t = self._load_full_image(item)
                if t is None:
                    print(f"[MediaResizePW] Warning: image 槽位 {i} 无法读取图像数据，保持原样。")
                    continue
                if t.shape[-1] == 4:
                    t = t[..., :3]
                t = t.float()
                if do_resize:
                    t = self._apply_scale(t, scale_mode, width, height, longer_size, shorter_size,
                                          interpolation, resize_method, multiple_of, pad_color_rgb, crop_position)
                if do_compress:
                    t = self._jpeg_compress(t, img_compression)
                images[i] = {
                    "type": "image",
                    "tensor": self._resize_and_pad(t, self.CELL_SIZE),
                    "tensor_full": t,
                    "path": "",  # 内存处理，不落盘
                    "metadata": item.get("metadata", {}),
                }

        # ========== 2. 视频：仅当开关开启且需要缩放时处理画面（不压缩、不动音轨/帧率） ==========
        if video and do_resize:
            for i, item in enumerate(videos):
                if not isinstance(item, dict):
                    continue
                comps = self._get_components(item.get("video"))
                frames = getattr(comps, "images", None) if comps is not None else None
                if not isinstance(frames, torch.Tensor) or frames.numel() == 0:
                    print(f"[MediaResizePW] Warning: video 槽位 {i} 无法获取画面，保持原样。")
                    continue
                if frames.shape[-1] == 4:
                    frames = frames[..., :3]
                frames = frames.float()
                resized = self._apply_scale(frames, scale_mode, width, height, longer_size, shorter_size,
                                            interpolation, resize_method, multiple_of, pad_color_rgb, crop_position)

                fr = getattr(comps, "frame_rate", None)
                try:
                    if fr is None or float(fr) <= 0:
                        fr = Fraction(24, 1)
                except Exception:
                    fr = Fraction(24, 1)

                new_video = self._build_video(resized, getattr(comps, "audio", None), fr)
                videos[i] = {
                    "type": "video",
                    "video": new_video,
                    "path": "",
                    "metadata": item.get("metadata", {}),
                }

        out_pack["images"] = images
        out_pack["videos"] = videos
        out_pack["audio"] = audios

        print(f"[MediaResizePW] scale_mode={scale_mode}, method={resize_method}, multiple_of={multiple_of}, "
              f"img_compression={img_compression}, video={video}")

        return (out_pack,)


NODE_CLASS_MAPPINGS = {
    "MediaResizePW": MediaResizePW
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MediaResizePW": "Media Resize PW"
}