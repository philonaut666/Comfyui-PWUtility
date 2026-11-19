from fractions import Fraction

import torch

from comfy.utils import common_upscale


class MediaRepackPW:
    """
    替换 PW_MEDIA_PACK 中的资产（槽位与 Media Unpack PW 的 18 个输出口一一对应）。

    规则：
    - media_pack 为必选输入；其余 18 个输入口全部可选。
    - 某个可选口有有效输入时，替换 pack 中对应槽位的资产；
      未连接或输入为 None/空数据的槽位，原资产保持原样输出。
    - video_imgsN / video_audioN 按"分量"替换：只连画面则保留原音轨，
      只连音轨则保留原画面；帧率沿用原视频（无法获取时回退 24）。
    - 全程不落盘：替换图片以原分辨率 tensor_full 存入 pack（tensor 仍按 pack
      约定存 512 缩放+pad 版本）；替换音频/视频均为内存对象；path 一律置空。
      需配合 Media Unpack PW 的 tensor_full 回退分支使用。
    - 不修改上游 pack 对象（逐项浅拷贝），避免污染 ComfyUI 的执行缓存。
    - 槽位超出 pack 现有数量时打印警告并跳过（不会新增资产）。
    """

    CELL_SIZE = 512  # 与 MiniMaxH3MediaPreviewPW 的图片 tensor 规格一致

    @classmethod
    def INPUT_TYPES(cls):
        optional = {}
        for i in range(9):
            optional[f"image{i}"] = ("IMAGE",)
        for i in range(3):
            optional[f"video_imgs{i}"] = ("IMAGE",)
        for i in range(3):
            optional[f"video_audio{i}"] = ("AUDIO",)
        for i in range(3):
            optional[f"audio{i}"] = ("AUDIO",)
        return {
            "required": {
                "media_pack": ("PW_MEDIA_PACK",),
            },
            "optional": optional,
        }

    RETURN_TYPES = ("PW_MEDIA_PACK",)
    RETURN_NAMES = ("media pack",)
    FUNCTION = "repack"
    CATEGORY = "🔮PWUtility/Media"
    OUTPUT_NODE = False

    # ---------- 校验与归一化工具 ----------
    @staticmethod
    def _is_valid_image(t):
        return isinstance(t, torch.Tensor) and t.dim() == 4 and t.numel() > 0 and t.shape[-1] in (3, 4)

    @staticmethod
    def _is_valid_audio(a):
        return (
            isinstance(a, dict)
            and isinstance(a.get("waveform"), torch.Tensor)
            and a["waveform"].numel() > 0
        )

    @staticmethod
    def _to_rgb_float(t):
        """IMAGE -> float32 RGB（4 通道时丢弃 alpha，与 pack 的 RGB 约定一致）。"""
        if t.shape[-1] == 4:
            t = t[..., :3]
        return t.float()

    @staticmethod
    def _normalize_audio_dict(a):
        """统一为标准 AUDIO dict：waveform (1, C, N)。"""
        waveform = a["waveform"]
        if waveform.dim() == 1:
            waveform = waveform.unsqueeze(0).unsqueeze(0)
        elif waveform.dim() == 2:
            waveform = waveform.unsqueeze(0)
        elif waveform.dim() == 3 and waveform.shape[0] > 1:
            waveform = waveform[0:1]
        return {"waveform": waveform, "sample_rate": int(a.get("sample_rate", 44100))}

    # ---------- 图片 tensor 规格（与 MiniMaxH3MediaPreviewPW.resize_and_pad 一致） ----------
    def _resize_and_pad(self, tensor, target_size=512):
        """等比例缩放并居中填充黑边，确保图片不会变形或被裁剪。"""
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

    # ---------- 视频分量工具 ----------
    @staticmethod
    def _get_original_components(video_obj):
        if video_obj is None or not hasattr(video_obj, "get_components"):
            return None
        try:
            return video_obj.get_components()
        except Exception as e:
            print(f"[MediaRepackPW] Failed to get original video components: {e}")
            return None

    @staticmethod
    def _resolve_frame_rate(comps):
        fr = getattr(comps, "frame_rate", None) if comps is not None else None
        try:
            if fr is not None and float(fr) > 0:
                return fr if isinstance(fr, Fraction) else Fraction(float(fr)).limit_denominator(1000000)
        except Exception:
            pass
        return Fraction(24, 1)

    @staticmethod
    def _build_video_from_components(images, audio, frame_rate):
        """与官方 Create Video 节点一致：用画面 + 音轨 + 帧率构造原生 VIDEO 对象。"""
        try:
            from comfy_api.latest import InputImpl, Types
        except Exception:
            raise RuntimeError(
                "[MediaRepackPW] 当前 ComfyUI 版本不支持原生 VIDEO 类型（缺少 comfy_api.latest），请升级 ComfyUI。"
            )
        if not hasattr(InputImpl, "VideoFromComponents"):
            raise RuntimeError(
                "[MediaRepackPW] 当前 ComfyUI 版本缺少 InputImpl.VideoFromComponents，请升级 ComfyUI。"
            )
        return InputImpl.VideoFromComponents(
            Types.VideoComponents(images=images, audio=audio, frame_rate=frame_rate)
        )

    # ---------- 主函数 ----------
    def repack(self, media_pack, **kwargs):
        if not isinstance(media_pack, dict):
            raise ValueError(
                "[MediaRepackPW] media_pack 输入不是有效的 PW_MEDIA_PACK，"
                "请连接 MiniMax H3 Media Preview PW 或 Media Repack PW 的输出。"
            )

        # 浅拷贝顶层与三个资产列表/条目，避免改动上游缓存对象
        out_pack = dict(media_pack)
        images = [dict(x) if isinstance(x, dict) else x for x in (media_pack.get("images") or [])]
        videos = [dict(x) if isinstance(x, dict) else x for x in (media_pack.get("videos") or [])]
        audios = [dict(x) if isinstance(x, dict) else x for x in (media_pack.get("audio") or [])]

        replaced = []

        # ========== 1. 图片槽位 image0~image8 ==========
        for i in range(9):
            t = kwargs.get(f"image{i}", None)
            if t is None:
                continue
            if not self._is_valid_image(t):
                print(f"[MediaRepackPW] Warning: image{i} 输入不是有效的 IMAGE，已跳过。")
                continue
            if i >= len(images):
                print(f"[MediaRepackPW] Warning: image{i} 有输入，但 pack 中只有 {len(images)} 张图片（槽位不存在），已跳过。")
                continue

            t = self._to_rgb_float(t)[0:1]  # 批量输入只取第一帧
            images[i] = {
                "type": "image",
                "tensor": self._resize_and_pad(t, self.CELL_SIZE),
                "tensor_full": t,  # 原分辨率内存 tensor，供 Media Unpack PW 回退读取
                "path": "",        # 不落盘，无对应磁盘文件
                "metadata": {},
            }
            replaced.append(f"image{i}")

        # ========== 2. 视频槽位 video_imgs0~2 / video_audio0~2（按分量替换） ==========
        for i in range(3):
            new_imgs = kwargs.get(f"video_imgs{i}", None)
            new_aud = kwargs.get(f"video_audio{i}", None)
            if new_imgs is not None and not self._is_valid_image(new_imgs):
                print(f"[MediaRepackPW] Warning: video_imgs{i} 输入不是有效的 IMAGE，已忽略该口。")
                new_imgs = None
            if new_aud is not None and not self._is_valid_audio(new_aud):
                print(f"[MediaRepackPW] Warning: video_audio{i} 输入不是有效的 AUDIO，已忽略该口。")
                new_aud = None

            has_imgs = new_imgs is not None
            has_aud = new_aud is not None
            if not has_imgs and not has_aud:
                continue
            if i >= len(videos) or not isinstance(videos[i], dict):
                print(f"[MediaRepackPW] Warning: video 槽位 {i} 有输入，但 pack 中只有 {len(videos)} 个视频（槽位不存在），已跳过。")
                continue

            comps = self._get_original_components(videos[i].get("video"))

            # 画面：有新输入用新的，否则保留原视频画面
            frames = self._to_rgb_float(new_imgs) if has_imgs else (getattr(comps, "images", None) if comps is not None else None)
            if not isinstance(frames, torch.Tensor) or frames.numel() == 0:
                print(f"[MediaRepackPW] Warning: video_audio{i} 有输入，但槽位 {i} 无法获取原始视频画面，已跳过。")
                continue

            # 音轨：有新输入用新的，否则保留原视频音轨
            if has_aud:
                audio = self._normalize_audio_dict(new_aud)
            else:
                audio = getattr(comps, "audio", None) if comps is not None else None

            frame_rate = self._resolve_frame_rate(comps)
            new_video = self._build_video_from_components(frames, audio, frame_rate)

            videos[i] = {
                "type": "video",
                "video": new_video,
                "path": "",  # 内存 VIDEO 对象，无对应磁盘文件
                "metadata": {},
            }
            parts = []
            if has_imgs:
                parts.append(f"video_imgs{i}")
            if has_aud:
                parts.append(f"video_audio{i}")
            replaced.append("+".join(parts))

        # ========== 3. 独立音频槽位 audio0~audio2 ==========
        for i in range(3):
            a = kwargs.get(f"audio{i}", None)
            if a is None:
                continue
            if not self._is_valid_audio(a):
                print(f"[MediaRepackPW] Warning: audio{i} 输入不是有效的 AUDIO，已跳过。")
                continue
            if i >= len(audios):
                print(f"[MediaRepackPW] Warning: audio{i} 有输入，但 pack 中只有 {len(audios)} 个音频（槽位不存在），已跳过。")
                continue

            audio_dict = self._normalize_audio_dict(a)
            audios[i] = {
                "type": "audio",
                "audio": audio_dict,
                "path": "",  # 不落盘，音频数据以内存 dict 为准
                "metadata": {},
            }
            replaced.append(f"audio{i}")

        out_pack["images"] = images
        out_pack["videos"] = videos
        out_pack["audio"] = audios

        if replaced:
            print(f"[MediaRepackPW] Replaced slots: {', '.join(replaced)}")
        else:
            print("[MediaRepackPW] No replacement inputs connected, media pack passed through unchanged.")

        return (out_pack,)


NODE_CLASS_MAPPINGS = {
    "MediaRepackPW": MediaRepackPW
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MediaRepackPW": "Media Repack PW"
}