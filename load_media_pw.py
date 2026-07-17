import torch
import numpy as np
from PIL import Image
import json
import os
import cv2
import subprocess
import re
from comfy.utils import common_upscale

VAE_STRIDE = (4, 8, 8)
PATCH_SIZE = (1, 2, 2)

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
                    if not target_node: continue
                    
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
            if visited is None: visited = set()
            start_node_id = str(start_node['id'])
            if start_node_id in visited: return False
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
        target_frame_time = base_frame_time if base_frame_time > 0 else 1.0/30.0

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
                "paths": ("LMM_ALL_PATHS",),
                "index": ("INT", {"default": 0, "min": 0, "step": 1}),
                "批量": ("BOOLEAN", {"default": False}),
            },
        }

    RETURN_TYPES = ("IMAGE", "INT", "INT", "STRING", "STRING", "INT",)
    RETURN_NAMES = ("image", "width", "height", "positive_prompt", "negative_prompt", "seed",)
    FUNCTION = "get_original_image"
    CATEGORY = "🔮PWUtility/Local Media"

    def get_original_image(self, paths, index, 批量):
        try:
            selection_list = json.loads(paths)
            if not isinstance(selection_list, list):
                selection_list = []
        except (json.JSONDecodeError, TypeError):
            selection_list = []

        # 过滤出所有图片类型的 item
        image_items = [item for item in selection_list if item.get("type") == "image"]

        if not 批量:
            # 单张模式：根据 index 获取具体某一张
            if not (0 <= index < len(image_items)):
                return (torch.zeros(1, 1, 1, 3), 0, 0, "", "", 0)
            
            selected_item = image_items[index]
            return self._process_single_image(selected_item)
        else:
            # 批量模式：忽略 index，将所有读入并输出为 list
            images_list = []
            widths_list = []
            heights_list = []
            pos_prompts_list = []
            neg_prompts_list = []
            seeds_list = []

            for item in image_items:
                img, w, h, pos, neg, seed = self._process_single_image(item)
                images_list.append(img)
                widths_list.append(w)
                heights_list.append(h)
                # 遇到无数据时，字符串返回空字符，INT 返回 0 防止 ComfyUI 类型报错
                pos_prompts_list.append(pos if pos else "")
                neg_prompts_list.append(neg if neg else "")
                seeds_list.append(seed if seed is not None else 0)

            return (images_list, widths_list, heights_list, pos_prompts_list, neg_prompts_list, seeds_list)

    def _process_single_image(self, selected_item):
        empty_return = (torch.zeros(1, 1, 1, 3), 0, 0, "", "", 0)

        if not selected_item or 'path' not in selected_item or not os.path.exists(selected_item['path']):
            return empty_return

        selected_path = selected_item['path']

        try:
            with Image.open(selected_path) as img:
                H_orig, W_orig = img.height, img.width
                
                img_out = img.convert("RGBA") if 'A' in img.getbands() else img.convert("RGB")
                img_array = np.array(img_out).astype(np.float32) / 255.0
                # 保持 4D tensor 格式 (Batch, Height, Width, Channels)
                image_tensor = torch.from_numpy(img_array)[None,] 

                metadata = selected_item.get('metadata', {})
                if not metadata:
                    try:
                        if 'parameters' in img.info: metadata['parameters'] = img.info['parameters']
                        if 'prompt' in img.info: metadata['prompt'] = img.info['prompt']
                        if 'workflow' in img.info: metadata['workflow'] = img.info['workflow']
                    except Exception:
                        pass
                        
                positive_prompt, negative_prompt, seed = extract_prompts_and_seed(metadata)
                
                return (image_tensor, W_orig, H_orig, positive_prompt, negative_prompt, seed)
        except Exception as e:
            print(f"PW Utility: Error loading or processing image {selected_path}: {e}")
            return empty_return


class LMMSelectVideoPW:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "paths": ("LMM_ALL_PATHS",),
                "index": ("INT", {"default": 0, "min": 0, "step": 1}),
                "generation_width": ("INT", {"default": 1024, "min": 64, "max": 8096, "step": 8, "tooltip": "Expected video width"}),
                "generation_height": ("INT", {"default": 1024, "min": 64, "max": 8096, "step": 8, "tooltip": "Expected video height"}),
                "aspect_ratio_preservation": (["original", "keep_input", "stretch_to_new", "crop_to_new"], {"tooltip": "Zoom Mode：\n- keep_input: Maintain the aspect ratio of the original video\n- stretch_to_new: Stretch to fit the new size\n- crop_to_new: Cropped to fit new sizes\n- original: No processing is performed, use the original video size"}),
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

    def get_original_video(self, paths, index, generation_width, generation_height, aspect_ratio_preservation, force_rate, frame_load_cap, skip_first_frames, select_every_nth):
        try:
            selection_list = json.loads(paths)
            if not isinstance(selection_list, list): selection_list = []
        except:
            selection_list = []
            
        video_items = [item for item in selection_list if item.get("type") == "video"]
        if not (0 <= index < len(video_items)):
            empty_audio = {'waveform': torch.zeros(1, 2, 1), 'sample_rate': 44100}
            return (torch.zeros(1, 1, 1, 3), 0, 0, 0, 0.0, empty_audio, "{}")

        selected_item = video_items[index]
        selected_path = selected_item['path']

        if not os.path.exists(selected_path):
            empty_audio = {'waveform': torch.zeros(1, 2, 1), 'sample_rate': 44100}
            return (torch.zeros(1, 1, 1, 3), 0, 0, 0, 0.0, empty_audio, "{}")

        audio_fps_estimate = force_rate if force_rate > 0 else 30
        audio_data = get_audio(selected_path, start_time=skip_first_frames / audio_fps_estimate)
        try:
            frame_generator = cv_frame_generator(selected_path, force_rate, frame_load_cap, skip_first_frames, select_every_nth)
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
                return (torch.zeros(1, 1, 1, 3), 0, output_w, output_h, output_fps, audio_data, json.dumps(source_info))

            processed_frames = []
            for frame in frames:
                tensor_frame = torch.from_numpy(frame).float() / 255.0
                tensor_frame = tensor_frame.unsqueeze(0)
                
                if should_resize:
                    resized_frame = common_upscale(tensor_frame.movedim(-1, 1), output_w, output_h, "lanczos", crop).movedim(1, -1)
                else:
                    resized_frame = tensor_frame
                
                processed_frames.append(resized_frame.squeeze(0))

            final_tensor = torch.stack(processed_frames)
            return (final_tensor, final_tensor.shape[0], output_w, output_h, output_fps, audio_data, json.dumps(source_info, indent=4))
        except Exception as e:
            print(f"PW Utility: Error loading or resizing video frames from {selected_path}: {e}")
            empty_audio = {'waveform': torch.zeros(1, 2, 1), 'sample_rate': 44100}
            return (torch.zeros(1, 1, 1, 3), 0, 0, 0, 0.0, empty_audio, "{}")


class LMMSelectAudioPW:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "paths": ("LMM_ALL_PATHS",),
                "index": ("INT", {"default": 0, "min": 0, "step": 1}),
                "seek_seconds": ("FLOAT", {"default": 0, "min": 0, "max": 100000, "step": 0.01}),
                "duration": ("FLOAT", {"default": 0, "min": 0, "max": 100000, "step": 0.01}),
            },
        }

    RETURN_TYPES = ("AUDIO", "FLOAT",)
    RETURN_NAMES = ("audio", "duration",)
    FUNCTION = "get_original_audio"
    CATEGORY = "🔮PWUtility/Local Media"

    def get_original_audio(self, paths, index, seek_seconds, duration):
        try:
            selection_list = json.loads(paths)
            if not isinstance(selection_list, list): selection_list = []
        except:
            selection_list = []
            
        audio_items = [item for item in selection_list if item.get("type") == "audio"]
        if not (0 <= index < len(audio_items)):
            return (None, 0.0)

        selected_item = audio_items[index]
        selected_path = selected_item['path']

        if not os.path.exists(selected_path):
            return (None, 0.0)

        audio_data = get_audio(selected_path, start_time=seek_seconds, duration=duration)

        if audio_data and 'waveform' in audio_data and audio_data['waveform'] is not None:
            waveform = audio_data['waveform']
            sample_rate = audio_data['sample_rate']
            loaded_duration = waveform.shape[-1] / sample_rate
            return (audio_data, loaded_duration)
        else:
            return (None, 0.0)


NODE_CLASS_MAPPINGS = {
    "LMMSelectImagePW": LMMSelectImagePW,
    "LMMSelectVideoPW": LMMSelectVideoPW,
    "LMMSelectAudioPW": LMMSelectAudioPW,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LMMSelectImagePW": "LMM Select Image PW",
    "LMMSelectVideoPW": "LMM Select Video PW",
    "LMMSelectAudioPW": "LMM Select Audio PW",
}