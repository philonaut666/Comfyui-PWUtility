import torch
import numpy as np
from PIL import Image
import json
import os
import cv2
import subprocess
import re
import math
from comfy.utils import common_upscale

VAE_STRIDE = (4, 8, 8)
PATCH_SIZE = (1, 2, 2)


def parse_selection_and_get_item(selection_json_str: str, index: int, expected_type: str = None):
    try:
        selection_list = json.loads(selection_json_str)
        if not isinstance(selection_list, list) or not (0 <= index < len(selection_list)):
            return None

        item = selection_list[index]
        if expected_type is None or item.get("type") == expected_type:
            return item
        else:
            return None
    except (json.JSONDecodeError, TypeError):
        return None


def extract_prompts_and_seed(metadata):
    positive_prompts, negative_prompts = [], []
    seed = 0

    if not metadata:
        return "", "", 0

    parameters = metadata.get('parameters')
    if isinstance(parameters, str):
        neg_prompt_match = re.search(r'Negative prompt:\s*(.*)', parameters, re.DOTALL)
        if neg_prompt_match:
            negative = neg_prompt_match.group(1).split('Steps:')[0].strip()
            positive = parameters.split('Negative prompt:')[0].strip()
        else:
            positive = parameters.split('Steps:')[0].strip()
            negative = ""

        seed_match = re.search(r'Seed:\s*(\d+)', parameters)
        if seed_match:
            seed = int(seed_match.group(1))

        return positive.strip(), negative.strip(), seed

    workflow_str = metadata.get('workflow') or metadata.get('prompt')
    if not isinstance(workflow_str, str):
        return str(metadata.get('prompt', '')), "", 0

    try:
        workflow = json.loads(workflow_str)

        if 'nodes' not in workflow or not isinstance(workflow.get('nodes'), list):
            return str(workflow), "", 0

        nodes_by_id = {str(n['id']): n for n in workflow['nodes']}
        all_links = workflow.get('links', [])

        def find_ground_truth_from_source(origin_node_id, origin_slot_index):
            display_keywords = ['show', 'text', 'preview', 'any']

            for link in all_links:
                if str(link[1]) == str(origin_node_id) and link[2] == origin_slot_index:
                    target_node = nodes_by_id.get(str(link[3]))
                    if not target_node:
                        continue

                    node_type = target_node.get('type', '').lower()
                    prop_name = target_node.get('properties', {}).get('Node name for S&R', '').lower()

                    if any(k in node_type or k in prop_name for k in display_keywords):
                        val = target_node.get('widgets_values', [[""]])[0]
                        return val[0] if isinstance(val, list) else val

            return None

        def resolve_text_fallback(node):
            if not any('link' in i for i in node.get('inputs', []) if i.get('type') == 'STRING'):
                widgets = node.get('widgets_values', [])
                return next((w for w in widgets if isinstance(w, str)), "")

            combined_text = ""
            for inp in node.get('inputs', []):
                if inp.get('type') == 'STRING' and 'link' in inp:
                    link_info = next((l for l in all_links if str(l[0]) == str(inp['link'])), None)
                    if link_info:
                        combined_text += resolve_text_fallback(nodes_by_id[str(link_info[1])])

            return combined_text

        def is_sampler(node):
            return 'Sampler' in node.get('type', '')

        def check_downstream_for_sampler(start_node, visited=None):
            if visited is None:
                visited = set()

            start_node_id = str(start_node['id'])
            if start_node_id in visited:
                return False

            visited.add(start_node_id)

            if is_sampler(start_node):
                return True

            for output in start_node.get('outputs', []):
                for link_id in output.get('links', []):
                    link_info = next((l for l in all_links if str(l[0]) == str(link_id)), None)
                    if link_info:
                        target_node = nodes_by_id.get(str(link_info[3]))
                        if target_node and check_downstream_for_sampler(target_node, visited):
                            return True

            return False

        # Extract seed from KSampler nodes
        for node in workflow['nodes']:
            node_type = node.get('type', '')
            if 'KSampler' in node_type:
                widgets = node.get('widgets_values', [])
                if isinstance(widgets, list) and len(widgets) > 0:
                    seed_val = widgets[0]
                    if isinstance(seed_val, (int, float)):
                        seed = int(seed_val)
                        break

        for node in workflow['nodes']:
            if 'CLIPTextEncode' in node.get('type', ''):
                if check_downstream_for_sampler(node):
                    text_input = next((i for i in node.get('inputs', []) if i.get('name') == 'text'), None)
                    prompt_text = ""

                    if text_input and 'link' in text_input:
                        link_info = next((l for l in all_links if str(l[0]) == str(text_input['link'])), None)
                        if link_info:
                            origin_id, origin_slot = str(link_info[1]), link_info[2]
                            prompt_text = find_ground_truth_from_source(origin_id, origin_slot)
                            if prompt_text is None:
                                prompt_text = resolve_text_fallback(nodes_by_id[origin_id])
                    else:
                        prompt_text = (node.get('widgets_values') or [""])[0]

                    if 'negative' in node.get('title', '').lower():
                        negative_prompts.append(prompt_text)
                    else:
                        positive_prompts.append(prompt_text)

            elif 'CivitaiGalleryNode' in node.get('type', ''):
                properties = node.get('properties', {})
                if 'selection_data' in properties:
                    try:
                        selection_data = json.loads(properties['selection_data'])
                        meta = selection_data.get('item', {}).get('meta', {})
                        if 'prompt' in meta:
                            positive_prompts.append(meta['prompt'])
                        if 'negativePrompt' in meta:
                            negative_prompts.append(meta['negativePrompt'])
                    except (json.JSONDecodeError, AttributeError):
                        pass

        return " ".join(positive_prompts).strip(), " ".join(negative_prompts).strip(), seed

    except Exception as e:
        print(f"PW Utility Error: Failed to parse workflow. Error: {e}")
        return "", "", 0


def get_audio(file_path, start_time=0, duration=0):
    args = ['ffmpeg', "-i", file_path, "-vn"]

    if start_time > 0:
        args += ["-ss", str(start_time)]

    if duration > 0:
        args += ["-t", str(duration)]

    args += ["-f", "f32le", "-acodec", "pcm_f32le", "-ar", "44100", "-ac", "2", "-"]

    try:
        proc = subprocess.run(args, capture_output=True, check=True)
        info_str = proc.stderr.decode('utf-8', 'replace')

        sample_rate = 44100
        channels = 2

        sr_match = re.search(r'(\d+)\s+Hz', info_str)
        if sr_match:
            sample_rate = int(sr_match.group(1))

        ch_match = re.search(r'Hz,\s+(mono|stereo)', info_str)
        if ch_match:
            channels = 1 if ch_match.group(1) == 'mono' else 2

        waveform = torch.from_numpy(np.frombuffer(proc.stdout, dtype=np.float32))
        waveform = waveform.reshape(-1, channels).permute(1, 0)

        return {'waveform': waveform.unsqueeze(0), 'sample_rate': sample_rate}

    except subprocess.CalledProcessError as e:
        print(f"PW Utility: Could not extract audio from {file_path}. Error: {e.stderr.decode('utf-8', 'replace')}")
        return {'waveform': torch.zeros(1, 2, 1), 'sample_rate': 44100}

    except Exception as e:
        print(f"PW Utility: An unexpected error occurred during audio extraction: {e}")
        return {'waveform': torch.zeros(1, 2, 1), 'sample_rate': 44100}


def cv_frame_generator(video_path, force_rate, frame_load_cap, skip_first_frames, select_every_nth):
    video_cap = cv2.VideoCapture(video_path)
    if not video_cap.isOpened():
        raise IOError(f"Cannot open video file: {video_path}")

    fps = video_cap.get(cv2.CAP_PROP_FPS)
    width = int(video_cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(video_cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(video_cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = total_frames / fps if fps > 0 else 0

    yield {"width": width, "height": height, "fps": fps, "total_frames": total_frames, "duration": duration}

    base_frame_time = 1.0 / fps if fps > 0 else 0
    target_frame_time = 1.0 / force_rate if force_rate > 0 else base_frame_time

    if target_frame_time <= 0:
        target_frame_time = base_frame_time if base_frame_time > 0 else 1.0 / 30.0

    video_cap.set(cv2.CAP_PROP_POS_FRAMES, skip_first_frames)

    time_offset = target_frame_time
    frames_yielded = 0
    total_frames_evaluated = -1

    while video_cap.isOpened():
        current_pos_frames = skip_first_frames + frames_yielded
        if total_frames > 0 and current_pos_frames >= total_frames:
            break

        if force_rate > 0:
            while time_offset < target_frame_time:
                if not video_cap.grab():
                    video_cap.release()
                    return
                time_offset += base_frame_time

            time_offset -= target_frame_time
            ret, frame = video_cap.retrieve()
        else:
            ret, frame = video_cap.read()

        if not ret:
            break

        total_frames_evaluated += 1
        if total_frames_evaluated % select_every_nth != 0:
            continue

        yield cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

        frames_yielded += 1
        if frame_load_cap > 0 and frames_yielded >= frame_load_cap:
            break

    video_cap.release()


class LMMSelectImagePW:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "index": ("INT", {"default": 0, "min": 0, "step": 1}),
            },
            "optional": {
                "paths": ("LMM_ALL_PATHS",),
                "image(list)": ("IMAGE",),
            },
        }

    RETURN_TYPES = ("IMAGE", "INT", "INT", "STRING", "STRING", "INT",)
    RETURN_NAMES = ("image", "width", "height", "positive_prompt", "negative_prompt", "seed",)
    FUNCTION = "get_original_image"
    CATEGORY = "🔮PWUtility/Local Media"

    def _empty_return(self):
        return (torch.zeros(1, 1, 1, 3), 0, 0, "", "", 0)

    def _merge_metadata(self, base, extra):
        merged = dict(base or {})
        if isinstance(extra, dict) and extra:
            merged.update(extra)
        return merged

    def _normalize_image_tensor(self, tensor):
        if tensor is None or tensor.numel() == 0:
            return None

        if tensor.dim() == 2:
            tensor = tensor.unsqueeze(-1).unsqueeze(0)
        elif tensor.dim() == 3:
            # 兼容 CHW / HWC
            if tensor.shape[0] in (1, 3, 4) and tensor.shape[-1] not in (1, 3, 4):
                tensor = tensor.permute(1, 2, 0)
            tensor = tensor.unsqueeze(0)
        elif tensor.dim() == 4:
            # 兼容 B, C, H, W
            if tensor.shape[1] in (1, 3, 4) and tensor.shape[-1] not in (1, 3, 4):
                tensor = tensor.permute(0, 2, 3, 1)
        else:
            return None

        if tensor.dtype in (torch.uint8, torch.int8, torch.int16, torch.int32, torch.int64):
            tensor = tensor.float() / 255.0
        else:
            tensor = tensor.float()
            try:
                if tensor.numel() > 0 and float(tensor.max()) > 1.5:
                    tensor = tensor / 255.0
            except Exception:
                pass

        tensor = torch.clamp(tensor, 0.0, 1.0)

        if tensor.dim() != 4:
            return None

        # 通道处理
        if tensor.shape[-1] == 1:
            tensor = tensor.repeat(1, 1, 1, 3)
        elif tensor.shape[-1] == 2:
            tensor = tensor[..., :1].repeat(1, 1, 1, 3)
        elif tensor.shape[-1] > 4:
            tensor = tensor[..., :3]
        elif tensor.shape[-1] not in (3, 4):
            return None

        return tensor

    def _tensor_from_image_item(self, item):
        try:
            if item is None:
                return None

            if isinstance(item, torch.Tensor):
                tensor = item
            elif isinstance(item, np.ndarray):
                tensor = torch.from_numpy(item)
            elif isinstance(item, Image.Image):
                img = item.convert("RGBA") if 'A' in item.getbands() else item.convert("RGB")
                tensor = torch.from_numpy(np.array(img).astype(np.float32) / 255.0)
            else:
                return None

            return self._normalize_image_tensor(tensor)

        except Exception as e:
            print(f"PW Utility: Error converting image item to tensor: {e}")
            return None

    def _metadata_from_dict(self, data):
        metadata = {}

        if not isinstance(data, dict):
            return metadata

        md = data.get("metadata", {})
        if isinstance(md, dict):
            metadata.update(md)

        for k in ("parameters", "prompt", "workflow"):
            if k in data and k not in metadata:
                metadata[k] = data[k]

        return metadata

    def _load_tensor_and_metadata_from_path(self, path, metadata=None):
        if isinstance(path, os.PathLike):
            path = os.fspath(path)

        if not isinstance(path, str) or not path or not os.path.exists(path):
            return None, (metadata if isinstance(metadata, dict) else {})

        metadata = dict(metadata) if isinstance(metadata, dict) else {}

        try:
            with Image.open(path) as img:
                img_out = img.convert("RGBA") if 'A' in img.getbands() else img.convert("RGB")
                img_array = np.array(img_out).astype(np.float32) / 255.0
                image_tensor = torch.from_numpy(img_array)[None, ]

                if not metadata:
                    try:
                        if 'parameters' in img.info:
                            metadata['parameters'] = img.info['parameters']
                        if 'prompt' in img.info:
                            metadata['prompt'] = img.info['prompt']
                        if 'workflow' in img.info:
                            metadata['workflow'] = img.info['workflow']
                    except Exception:
                        pass

                return image_tensor, metadata

        except Exception as e:
            print(f"PW Utility: Error loading or processing image {path}: {e}")
            return None, metadata

    def _load_image_result_from_path(self, path, metadata=None):
        tensor, md = self._load_tensor_and_metadata_from_path(path, metadata)
        return self._result_from_tensor(tensor, md)

    def _result_from_tensor(self, tensor, metadata=None):
        empty_return = self._empty_return()

        if tensor is None:
            return empty_return

        tensor = self._normalize_image_tensor(tensor)
        if tensor is None or tensor.shape[0] == 0:
            return empty_return

        # 保持单张图片输出
        if tensor.shape[0] > 1:
            tensor = tensor[0:1]

        H_orig = int(tensor.shape[1])
        W_orig = int(tensor.shape[2])

        if not isinstance(metadata, dict):
            metadata = {}

        positive_prompt, negative_prompt, seed = extract_prompts_and_seed(metadata)
        return (tensor, W_orig, H_orig, positive_prompt, negative_prompt, seed,)

    def _is_single_image_like(self, obj):
        return isinstance(obj, (torch.Tensor, np.ndarray, Image.Image, str, os.PathLike))

    def _iter_image_items(self, image_input, metadata=None, depth=0):
        """
        将 image(list) 输入展平为单张图片序列。
        支持：
        - 单张 IMAGE tensor
        - IMAGE batch tensor
        - list / tuple of IMAGE
        - 嵌套 list / tuple
        - dict 包装的 image / images / tensor / path
        - (image, metadata_dict) 结构
        - 路径字符串 / PathLike
        """
        if depth > 8 or image_input is None:
            return

        if not isinstance(metadata, dict):
            metadata = {}

        # dict 包装结构
        if isinstance(image_input, dict):
            metadata = self._merge_metadata(metadata, self._metadata_from_dict(image_input))

            for key in ("image", "images", "image_list", "tensor", "frames", "items", "list"):
                if key in image_input:
                    yield from self._iter_image_items(image_input[key], metadata, depth + 1)
                    return

            if "path" in image_input:
                tensor, md = self._load_tensor_and_metadata_from_path(image_input["path"], metadata)
                if tensor is not None and tensor.shape[0] > 0:
                    for i in range(tensor.shape[0]):
                        yield tensor[i:i + 1], md
                return

            return

        # (payload, metadata_dict) 结构
        if (
            isinstance(image_input, (list, tuple))
            and len(image_input) == 2
            and isinstance(image_input[1], dict)
            and not isinstance(image_input[0], dict)
        ):
            metadata = self._merge_metadata(metadata, self._metadata_from_dict(image_input[1]))
            yield from self._iter_image_items(image_input[0], metadata, depth + 1)
            return

        # torch.Tensor：单张或 batch
        if isinstance(image_input, torch.Tensor):
            normalized = self._normalize_image_tensor(image_input)
            if normalized is None or normalized.shape[0] == 0:
                return

            for i in range(normalized.shape[0]):
                yield normalized[i:i + 1], metadata
            return

        # 路径字符串 / PathLike
        if isinstance(image_input, (str, os.PathLike)):
            path = image_input if isinstance(image_input, str) else os.fspath(image_input)
            tensor, md = self._load_tensor_and_metadata_from_path(path, metadata)
            if tensor is not None and tensor.shape[0] > 0:
                for i in range(tensor.shape[0]):
                    yield tensor[i:i + 1], md
            return

        # list / tuple / 其它可迭代对象
        seq = None
        if isinstance(image_input, (list, tuple)):
            seq = image_input
        elif not isinstance(image_input, (bytes, dict, np.ndarray, Image.Image)) and hasattr(image_input, "__iter__"):
            try:
                seq = list(image_input)
            except Exception:
                seq = None

        if seq is not None:
            for item in seq:
                yield from self._iter_image_items(item, metadata, depth + 1)
            return

        # 单张图片对象 / ndarray / PIL.Image 等
        tensor = self._tensor_from_image_item(image_input)
        if tensor is not None and tensor.shape[0] > 0:
            for i in range(tensor.shape[0]):
                yield tensor[i:i + 1], metadata

    def _get_image_from_image_input(self, image_input, index):
        empty_return = self._empty_return()

        try:
            index = int(index)
        except Exception:
            index = 0

        if index < 0 or image_input is None:
            return empty_return

        for current_index, (tensor, md) in enumerate(self._iter_image_items(image_input, {})):
            if current_index == index:
                return self._result_from_tensor(tensor, md)

        return empty_return

    def get_original_image(self, index, paths=None, **kwargs):
        image_input = kwargs.get("image(list)", None)
        empty_return = self._empty_return()

        # image(list) 优先级更高：只要该端口有输入，就忽略 paths
        if image_input is not None:
            return self._get_image_from_image_input(image_input, index)

        # 回退到 paths 模式
        selected_item = parse_selection_and_get_item(paths, index, "image")
        if not selected_item or 'path' not in selected_item or not os.path.exists(selected_item['path']):
            return empty_return

        selected_path = selected_item['path']
        metadata = selected_item.get('metadata', {})
        return self._load_image_result_from_path(selected_path, metadata)


class LMMSelectVideoPW:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "paths": ("LMM_ALL_PATHS",),
                "index": ("INT", {"default": 0, "min": 0, "step": 1}),
                "generation_width": ("INT", {"default": 1024, "min": 64, "max": 8096, "step": 8, "tooltip": "Expected video width"}),
                "generation_height": ("INT", {"default": 1024, "min": 64, "max": 8096, "step": 8, "tooltip": "Expected video height"}),
                "aspect_ratio_preservation": (
                    ["original", "keep_input", "stretch_to_new", "crop_to_new"],
                    {
                        "tooltip": "Zoom Mode：\n- keep_input: Maintain the aspect ratio of the original video\n- stretch_to_new: Stretch to fit the new size\n- crop_to_new: Cropped to fit new sizes\n- original: No processing is performed, use the original video size"
                    }
                ),
                "force_rate": ("FLOAT", {"default": 0, "min": 0, "max": 240, "step": 1}),
                "frame_load_cap": ("INT", {"default": 0, "min": 0, "step": 1}),
                "skip_first_frames": ("INT", {"default": 0, "min": 0, "step": 1}),
                "select_every_nth": ("INT", {"default": 1, "min": 1, "step": 1}),
            },
        }

    RETURN_TYPES = ("IMAGE", "INT", "INT", "INT", "FLOAT", "AUDIO", "STRING",)
    RETURN_NAMES = ("IMAGE", "frame_count", "width", "height", "fps", "audio", "video_info",)
    FUNCTION = "get_original_video"
    CATEGORY = "🔮PWUtility/Local Media"

    def get_original_video(
        self,
        paths,
        index,
        generation_width,
        generation_height,
        aspect_ratio_preservation,
        force_rate,
        frame_load_cap,
        skip_first_frames,
        select_every_nth
    ):
        selected_item = parse_selection_and_get_item(paths, index, "video")
        empty_audio = {'waveform': torch.zeros(1, 2, 1), 'sample_rate': 44100}
        empty_return = (torch.zeros(1, 1, 1, 3), 0, 0, 0, 0.0, empty_audio, "{}")

        if not selected_item or 'path' not in selected_item or not os.path.exists(selected_item['path']):
            return empty_return

        selected_path = selected_item['path']

        audio_fps_estimate = force_rate if force_rate > 0 else 30
        audio_data = get_audio(selected_path, start_time=skip_first_frames / audio_fps_estimate)

        try:
            frame_generator = cv_frame_generator(
                selected_path,
                force_rate,
                frame_load_cap,
                skip_first_frames,
                select_every_nth
            )
            source_info = next(frame_generator)

            H_orig = source_info.get("height", 0)
            W_orig = source_info.get("width", 0)
            video_fps = source_info.get("fps", 0.0)

            should_resize = True
            crop = "disabled"

            if aspect_ratio_preservation != "original":
                max_area = generation_width * generation_height

                if aspect_ratio_preservation == "keep_input":
                    aspect_ratio = H_orig / W_orig if W_orig > 0 else 1.0
                else:
                    aspect_ratio = generation_height / generation_width if generation_width > 0 else 1.0
                    if aspect_ratio_preservation == "crop_to_new":
                        crop = "center"

                lat_h = round(np.sqrt(max_area * aspect_ratio) / VAE_STRIDE[1] / PATCH_SIZE[1]) * PATCH_SIZE[1]
                lat_w = round(np.sqrt(max_area / aspect_ratio) / VAE_STRIDE[2] / PATCH_SIZE[2]) * PATCH_SIZE[2]

                output_h = int(lat_h * VAE_STRIDE[1])
                output_w = int(lat_w * VAE_STRIDE[2])
            else:
                output_h = H_orig
                output_w = W_orig
                should_resize = False

            output_fps = force_rate if force_rate > 0 else video_fps

            frames = list(frame_generator)
            if not frames:
                return (
                    torch.zeros(1, 1, 1, 3),
                    0,
                    output_w,
                    output_h,
                    output_fps,
                    audio_data,
                    json.dumps(source_info)
                )

            processed_frames = []
            for frame in frames:
                tensor_frame = torch.from_numpy(frame).float() / 255.0
                tensor_frame = tensor_frame.unsqueeze(0)

                if should_resize:
                    resized_frame = common_upscale(
                        tensor_frame.movedim(-1, 1),
                        output_w,
                        output_h,
                        "lanczos",
                        crop
                    ).movedim(1, -1)
                else:
                    resized_frame = tensor_frame

                processed_frames.append(resized_frame.squeeze(0))

            final_tensor = torch.stack(processed_frames)

            return (
                final_tensor,
                final_tensor.shape[0],
                output_w,
                output_h,
                output_fps,
                audio_data,
                json.dumps(source_info, indent=4)
            )

        except Exception as e:
            print(f"PW Utility: Error loading or resizing video frames from {selected_path}: {e}")
            return empty_return


class LMMSelectAudioPW:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "index": ("INT", {"default": 0, "min": 0, "step": 1}),
                "trim_front": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100000.0, "step": 0.01, "tooltip": "Seconds to trim from the start"}),
                "duration": ("FLOAT", {"default": 25.00, "min": 0.0, "max": 100000.0, "step": 0.01, "tooltip": "Duration of the main audio to keep (0 = keep until end)"}),
                "pre_silence": ("FLOAT", {"default": 0.00, "min": 0.0, "max": 100000.0, "step": 0.01, "tooltip": "Add silence to the beginning of the main audio (in seconds)"}),
                "post_silence": ("FLOAT", {"default": 0.00, "min": 0.0, "max": 100000.0, "step": 0.01, "tooltip": "Add silence to the end of the main audio (in seconds)"}),
                "fps": ("FLOAT", {"default": 25.0, "min": 0.0, "max": 1000.0, "step": 0.1, "tooltip": "Frames per second, used to convert seconds to frames"}),
                "normalize": ("FLOAT", {"default": -16.0, "min": -100.0, "max": 100.0, "step": 0.1, "tooltip": "Target Peak dBFS for audio normalization"}),
                "align_8n+1": ("BOOLEAN", {"default": False, "tooltip": "Align final main audio length to 8n+1 video frames by appending silence"}),
            },
            "optional": {
                "paths": ("LMM_ALL_PATHS",),
                "audio": ("AUDIO",),
            }
        }

    RETURN_TYPES = ("AUDIO", "FLOAT", "INT", "AUDIO", "AUDIO",)
    RETURN_NAMES = ("audio", "duration", "frame_count", "trimed_front_audio", "trimed_back_audio",)
    FUNCTION = "get_original_audio"
    CATEGORY = "🔮PWUtility/Local Media"

    def get_original_audio(
        self,
        index,
        trim_front,
        duration,
        pre_silence,
        post_silence,
        fps,
        normalize,
        paths=None,
        audio=None,
        **kwargs
    ):
        align_8n_plus_1 = kwargs.get("align_8n+1", False)

        original_waveform = None
        sample_rate = 44100

        # 1. 获取音频源 (优先使用直连的 audio，否则回退到 paths)
        if audio and 'waveform' in audio and audio['waveform'] is not None and audio['waveform'].numel() > 0:
            original_waveform = audio['waveform']
            sample_rate = audio.get('sample_rate', 44100)
        elif paths:
            selected_item = parse_selection_and_get_item(paths, index, "audio")
            if selected_item and 'path' in selected_item and os.path.exists(selected_item['path']):
                # 获取完整原音频以便进行精确裁剪
                extracted_audio = get_audio(selected_item['path'], start_time=0, duration=0)
                if extracted_audio and 'waveform' in extracted_audio and extracted_audio['waveform'] is not None:
                    original_waveform = extracted_audio['waveform']
                    sample_rate = extracted_audio.get('sample_rate', 44100)

        empty_audio = {'waveform': torch.zeros(1, 2, 1), 'sample_rate': sample_rate}

        if original_waveform is None or original_waveform.numel() == 0:
            return (empty_audio, 0.0, 0, empty_audio, empty_audio)

        # 确保 original_waveform 是 3D (batch, channels, samples)
        if original_waveform.dim() == 2:
            original_waveform = original_waveform.unsqueeze(0)

        total_samples = original_waveform.shape[-1]
        channels = original_waveform.shape[1]

        # 2. 计算裁剪点
        front_samples = int(round(trim_front * sample_rate))
        front_samples = max(0, min(front_samples, total_samples))

        # duration 为 0 表示不限制（取到末尾），否则取指定长度
        if duration > 0:
            duration_samples = int(round(duration * sample_rate))
            # 确保不超过剩余长度
            duration_samples = min(duration_samples, total_samples - front_samples)
        else:
            duration_samples = total_samples - front_samples

        end_samples = front_samples + duration_samples

        # 3. 切分音频 (纯净原始波形)
        # 前段 (trimed_front_audio)
        if front_samples > 0:
            front_waveform = original_waveform[:, :, :front_samples]
        else:
            front_waveform = torch.zeros(1, channels, 1, dtype=original_waveform.dtype, device=original_waveform.device)

        # 后段 (trimed_back_audio)
        if end_samples < total_samples:
            back_waveform = original_waveform[:, :, end_samples:]
        else:
            back_waveform = torch.zeros(1, channels, 1, dtype=original_waveform.dtype, device=original_waveform.device)

        # 主音频 (保留部分)
        main_waveform = original_waveform[:, :, front_samples:end_samples]
        if main_waveform.shape[-1] == 0:
            main_waveform = torch.zeros(1, channels, 1, dtype=original_waveform.dtype, device=original_waveform.device)

        # 3.5 归一化处理 (基于原始完整音频的 Peak 计算增益，统一应用到所有切分片段)
        peak = torch.max(torch.abs(original_waveform))
        if peak > 0:
            current_db = 20 * math.log10(peak.item())
            gain_db = normalize - current_db
            gain_linear = 10 ** (gain_db / 20.0)

            front_waveform = torch.clamp(front_waveform * gain_linear, -1.0, 1.0)
            back_waveform = torch.clamp(back_waveform * gain_linear, -1.0, 1.0)
            main_waveform = torch.clamp(main_waveform * gain_linear, -1.0, 1.0)

        trimed_front_audio = {'waveform': front_waveform, 'sample_rate': sample_rate}
        trimed_back_audio = {'waveform': back_waveform, 'sample_rate': sample_rate}

        # 4. 对主音频应用 pre_silence, post_silence, align_8n+1
        waveform = main_waveform

        if pre_silence > 0:
            pre_samples = int(round(pre_silence * sample_rate))
            if pre_samples > 0:
                pre_tensor = torch.zeros(1, channels, pre_samples, dtype=waveform.dtype, device=waveform.device)
                waveform = torch.cat([pre_tensor, waveform], dim=-1)

        if post_silence > 0:
            post_samples = int(round(post_silence * sample_rate))
            if post_samples > 0:
                post_tensor = torch.zeros(1, channels, post_samples, dtype=waveform.dtype, device=waveform.device)
                waveform = torch.cat([waveform, post_tensor], dim=-1)

        if align_8n_plus_1:
            current_samples = waveform.shape[-1]
            current_duration_sec = current_samples / sample_rate
            current_frames = current_duration_sec * fps
            rounded_frames = round(current_frames)

            if (rounded_frames - 1) % 8 != 0:
                n = (rounded_frames - 1 + 7) // 8
                target_frames = 8 * n + 1

                if target_frames < rounded_frames:
                    n += 1
                    target_frames = 8 * n + 1

                target_duration_sec = target_frames / fps
                target_samples = int(round(target_duration_sec * sample_rate))

                if target_samples > current_samples:
                    pad_samples = target_samples - current_samples
                    pad_tensor = torch.zeros(1, channels, pad_samples, dtype=waveform.dtype, device=waveform.device)
                    waveform = torch.cat([waveform, pad_tensor], dim=-1)

        final_audio = {'waveform': waveform, 'sample_rate': sample_rate}

        final_samples = waveform.shape[-1]
        final_duration = final_samples / sample_rate
        final_frame_count = round(final_duration * fps)

        return (final_audio, final_duration, final_frame_count, trimed_front_audio, trimed_back_audio)


class LMMPathsExtractPW:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "paths": ("LMM_ALL_PATHS",),
                "index": ("INT", {"default": 0, "min": 0, "step": 1, "tooltip": "The sequence number of the path to extract (starts from 0)"}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("path",)
    FUNCTION = "extract_path"
    CATEGORY = "🔮PWUtility/Local Media"

    def extract_path(self, paths, index):
        selected_item = parse_selection_and_get_item(paths, index, expected_type=None)

        if not selected_item or 'path' not in selected_item:
            return ("",)

        return (selected_item['path'],)


NODE_CLASS_MAPPINGS = {
    "LMMSelectImagePW": LMMSelectImagePW,
    "LMMSelectVideoPW": LMMSelectVideoPW,
    "LMMSelectAudioPW": LMMSelectAudioPW,
    "LMMPathsExtractPW": LMMPathsExtractPW,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LMMSelectImagePW": "LMM Select Image PW",
    "LMMSelectVideoPW": "LMM Select Video PW",
    "LMMSelectAudioPW": "LMM Select Audio PW",
    "LMMPathsExtractPW": "LMM Paths Extract PW",
}