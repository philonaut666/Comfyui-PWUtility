import torch
import torch.nn.functional as F
import numpy as np
from PIL import Image, ImageOps
import os
import folder_paths
import io
import comfy.utils
import time
import base64
import re
from server import PromptServer
from aiohttp import web

# --- Crop Endpoint Registration ---
@PromptServer.instance.routes.post("/ImageLoaderPW/crop")
async def crop_image(request):
    try:
        data = await request.json()
        original_filename = data.get("filename")
        image_data_url = data.get("image")
        
        if not original_filename or not image_data_url:
            return web.json_response({"error": "Missing data"}, status=400)
            
        subfolder = ""
        if "/" in original_filename:
            parts = original_filename.split("/")
            subfolder = "/".join(parts[:-1])
            original_filename = parts[-1]
            
        header, encoded = image_data_url.split(",", 1)
        binary_data = base64.b64decode(encoded)
        
        input_dir = folder_paths.get_input_directory()
        if subfolder:
            save_dir = os.path.join(input_dir, subfolder)
            os.makedirs(save_dir, exist_ok=True)
        else:
            save_dir = input_dir
            
        base, ext = os.path.splitext(original_filename)
        if not ext:
            ext = ".png"
            
        base = re.sub(r'_cropped_\d+.*$', '', base)
        new_filename = f"{base}_cropped_{int(time.time())}{ext}"
        
        save_path = os.path.join(save_dir, new_filename)
        
        counter = 1
        while os.path.exists(save_path):
            new_filename = f"{base}_cropped_{int(time.time())}_{counter}{ext}"
            save_path = os.path.join(save_dir, new_filename)
            counter += 1
            
        with open(save_path, "wb") as f:
            f.write(binary_data)
            
        relative_path = os.path.join(subfolder, new_filename).replace("\\", "/")
        
        return web.json_response({
            "filename": relative_path
        })
    except Exception as e:
        print(f"Error cropping image: {e}")
        return web.json_response({"error": str(e)}, status=500)

class ImageLoaderPW:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image_paths": ("STRING", {"default": "", "multiline": True}),
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
                "img_compression": ("INT", {"default": 18, "min": 0, "max": 100, "step": 1}),
            },
        }

    RETURN_TYPES = ("IMAGE",) * 51
    RETURN_NAMES = ("image_list",) + tuple(f"image_{i+1}" for i in range(50))
    OUTPUT_IS_LIST = (True,) + (False,) * 50 
    FUNCTION = "load_images"
    CATEGORY = "PWUtility/Image"

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
            
        else: # stretch
            width = width if width > 0 else ow
            height = height if height > 0 else oh

        outputs = image.permute(0, 3, 1, 2)

        if interpolation == "lanczos":
            outputs = comfy.utils.lanczos(outputs, width, height)
        else:
            outputs = F.interpolate(outputs, size=(height, width), mode=interpolation)

        if resize_method == 'pad':
            if pad_left > 0 or pad_right > 0 or pad_top > 0 or pad_bottom > 0:
                B, C, H_new, W_new = outputs.shape
                H_target = H_new + pad_top + pad_bottom
                W_target = W_new + pad_left + pad_right
                
                r, g, b = pad_color
                background = torch.zeros((B, C, H_target, W_target), device=outputs.device, dtype=outputs.dtype)
                background[:, 0, :, :] = r
                background[:, 1, :, :] = g
                background[:, 2, :, :] = b
                
                background[:, :, pad_top:pad_top+H_new, pad_left:pad_left+W_new] = outputs
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

    def load_images(self, image_paths, scale_mode, width, height, longer_size, shorter_size, interpolation, resize_method, pad_color, crop_position, multiple_of, img_compression):
        results = []
        metadata_list = []  # Store metadata for each image
        valid_paths = [p.strip() for p in image_paths.split("\n") if p.strip()]

        def align_to_multiple(val, multiple):
            if multiple <= 1:
                return val
            return round(val / multiple) * multiple

        def parse_color(color_str):
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

        pad_color_rgb = parse_color(pad_color)

        for path in valid_paths:
            try:
                full_path = path
                if not os.path.exists(full_path):
                     full_path = os.path.join(folder_paths.get_input_directory(), path)
                    
                if not os.path.exists(full_path):
                    print(f"Warning: Image path not found: {path}")
                    continue

                image = Image.open(full_path)
                
                # Read metadata from the image file
                image_metadata = {}
                if hasattr(image, 'info') and image.info:
                    # Convert metadata to a serializable format
                    for key, value in image.info.items():
                        try:
                            # Try to convert to string for serialization
                            image_metadata[str(key)] = str(value)
                        except Exception:
                            pass
                
                image = ImageOps.exif_transpose(image)
                image = image.convert("RGB")

                image_np = np.array(image).astype(np.float32) / 255.0
                image_tensor = torch.from_numpy(image_np)[None,]
                
                _, oh, ow, _ = image_tensor.shape
                
                # When scale_mode is "none", skip all resizing and keep the original dimensions
                if scale_mode != "none":
                    target_w, target_h = width, height
                    actual_resize_method = resize_method
                    use_internal_multiple = multiple_of

                    if scale_mode == "scale longer":
                        base_size = longer_size if longer_size > 0 else max(oh, ow)
                        if oh >= ow:
                            target_h = align_to_multiple(base_size, multiple_of)
                            target_w = align_to_multiple(ow * (target_h / oh), multiple_of)
                        else:
                            target_w = align_to_multiple(base_size, multiple_of)
                            target_h = align_to_multiple(oh * (target_w / ow), multiple_of)
                        target_w, target_h = int(max(1, target_w)), int(max(1, target_h))
                        
                        if resize_method == "keep proportion":
                            actual_resize_method = "stretch"
                        use_internal_multiple = 0
                        
                    elif scale_mode == "scale shorter":
                        base_size = shorter_size if shorter_size > 0 else min(oh, ow)
                        if oh <= ow:
                            target_h = align_to_multiple(base_size, multiple_of)
                            target_w = align_to_multiple(ow * (target_h / oh), multiple_of)
                        else:
                            target_w = align_to_multiple(base_size, multiple_of)
                            target_h = align_to_multiple(oh * (target_w / ow), multiple_of)
                        target_w, target_h = int(max(1, target_w)), int(max(1, target_h))
                        
                        if resize_method == "keep proportion":
                            actual_resize_method = "stretch"
                        use_internal_multiple = 0

                    elif scale_mode == "scale dimensions":
                        if width == 0 and height == 0:
                            use_internal_multiple = 0

                    image_tensor = self.resize_image(image_tensor, target_w, target_h, actual_resize_method, interpolation, use_internal_multiple, pad_color_rgb, crop_position)
     
                if img_compression > 0:
                    img_np = (image_tensor[0].numpy() * 255).clip(0, 255).astype(np.uint8)
                    img_pil = Image.fromarray(img_np)
                    img_byte_arr = io.BytesIO()
                    img_pil.save(img_byte_arr, format="JPEG", quality=max(1, 100 - img_compression))
                    img_pil = Image.open(img_byte_arr)
                    image_tensor = torch.from_numpy(np.array(img_pil).astype(np.float32) / 255.0)[None,]

                # Attach metadata to the tensor
                if image_metadata:
                    image_tensor._metadata = image_metadata
                
                results.append(image_tensor)
                metadata_list.append(image_metadata)
                
            except Exception as e:
                print(f"Error loading {path}: {e}")

        image_list = []
        for r in results:
            image_list.append(r)
            
        if not image_list:
            image_list = [] 

        padded_results = results + [torch.zeros((1, 64, 64, 3))] * (50 - len(results))

        # Prepare UI data with metadata
        ui_data = {
            "metadata": metadata_list
        }

        return (image_list, *padded_results[:50], {"ui": ui_data})

NODE_CLASS_MAPPINGS = {
    "ImageLoaderPW": ImageLoaderPW
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ImageLoaderPW": "Image Loader PW"
}