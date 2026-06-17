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
    RETURN_NAMES = ("IMAGES",) + tuple(f"image_{i+1}" for i in range(50))
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
                pad_left = (width - new_width) //