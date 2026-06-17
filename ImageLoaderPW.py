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
                "width": ("INT", {"default": 0, "min": 0, "max": 8192, "step": 1}),
                "height": ("INT", {"default": 0, "min": 0, "max": 8192, "step": 1}),
                "interpolation": (["lanczos", "nearest", "bilinear", "bicubic", "area", "nearest-exact"],),
                "resize_method": (["keep proportion", "stretch", "pad", "crop"],),
                "multiple_of": ("INT", {"default": 32, "min": 0, "max": 512, "step": 1}),
                "img_compression": ("INT", {"default": 18, "min": 0, "max": 100, "step": 1}),
            },
        }

    # Keep 51 outputs in backend to prevent ComfyUI execution engine crashes when JS dynamically adds outputs
    RETURN_TYPES = ("IMAGE",) * 51
    RETURN_NAMES = ("multi_output",) + tuple(f"image_{i+1}" for i in range(50))
    FUNCTION = "load_images"
    CATEGORY = "PWUtility"

    def resize_image(self, image, width, height, resize_method="keep proportion", interpolation="nearest", multiple_of=0):
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
            
        else:
            width = width if width > 0 else ow
            height = height if height > 0 else oh

        outputs = image.permute(0, 3, 1, 2)

        if interpolation == "lanczos":
            outputs = comfy.utils.lanczos(outputs, width, height)
        else:
            outputs = F.interpolate(outputs, size=(height, width), mode=interpolation)

        if resize_method == 'pad':
            if pad_left > 0 or pad_right > 0 or pad_top > 0 or pad_bottom > 0:
                outputs = F.pad(outputs, (pad_left, pad_right, pad_top, pad_bottom), value=0)

        outputs = outputs.permute(0, 2, 3, 1)

        if resize_method == 'crop':
            if x > 0 or y > 0 or x2 > 0 or y2 > 0:
                outputs = outputs[:, y:y2, x:x2, :]

        if multiple_of > 1 and (outputs.shape[2] % multiple_of != 0 or outputs.shape[1] % multiple_of != 0):
            width = outputs.shape[2]
            height = outputs.shape[1]
            x = (width % multiple_of) // 2
            y = (height % multiple_of) // 2
            x2 = width - ((width % multiple_of) - x)
            y2 = height - ((height % multiple_of) - y)
            outputs = outputs[:, y:y2, x:x2, :]
        
        outputs = torch.clamp(outputs, 0, 1)

        return outputs

    def load_images(self, image_paths, width, height, interpolation, resize_method, multiple_of, img_compression):
        results = []
        valid_paths = [p.strip() for p in image_paths.split("\n") if p.strip()]

        for path in valid_paths:
            try:
                full_path = path
                if not os.path.exists(full_path):
                     full_path = os.path.join(folder_paths.get_input_directory(), path)
                    
                if not os.path.exists(full_path):
                    print(f"Warning: Image path not found: {path}")
                    continue

                image = Image.open(full_path)
                image = ImageOps.exif_transpose(image)
                image = image.convert("RGB")

                image_np = np.array(image).astype(np.float32) / 255.0
                image_tensor = torch.from_numpy(image_np)[None,]

                image_tensor = self.resize_image(image_tensor, width, height, resize_method, interpolation, multiple_of)
     
                if img_compression > 0:
                    img_np = (image_tensor[0].numpy() * 255).clip(0, 255).astype(np.uint8)
                    img_pil = Image.fromarray(img_np)
                    img_byte_arr = io.BytesIO()
                    img_pil.save(img_byte_arr, format="JPEG", quality=max(1, 100 - img_compression))
                    img_pil = Image.open(img_byte_arr)
                    image_tensor = torch.from_numpy(np.array(img_pil).astype(np.float32) / 255.0)[None,]

                results.append(image_tensor)
            except Exception as e:
                print(f"Error loading {path}: {e}")

        # 1. Changed multi_output to be a Python LIST of tensors instead of a batched tensor
        if len(results) > 0:
            multi_output = results 
        else:
            multi_output = []

        # Pad individual outputs exactly to length 50 as defined in RETURN_TYPES
        padded_results = results + [torch.zeros((1, 64, 64, 3))] * (50 - len(results))

        return (multi_output, *padded_results[:50])

NODE_CLASS_MAPPINGS = {
    "ImageLoaderPW": ImageLoaderPW
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ImageLoaderPW": "Image Loader PW"
}