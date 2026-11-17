import json
from sqlmodel import Session, select

from app.config import settings
from app.models import AppSetting, Category, WorkflowTemplate

DEFAULT_CATEGORIES = [
    {
        "name": "Text-to-Image",
        "slug": "text-to-image",
        "description": "High-resolution diffusion workflows for stills and concept art.",
        "sort_order": 1,
    },
    {
        "name": "Image-to-Video",
        "slug": "image-to-video",
        "description": "Temporal video synthesis workflows outputting MP4/WEBM via VHS_VideoCombine.",
        "sort_order": 2,
    },
    {
        "name": "Upscaling",
        "slug": "upscaling",
        "description": "ESRGAN and tiled latent upscaling pipelines for detail restoration.",
        "sort_order": 3,
    },
]

DEFAULT_WORKFLOWS = [
    {
        "name": "SDXL Studio Portrait",
        "description": "Standard SDXL Base 1.0 text-to-image pipeline with configurable sampler, steps, CFG, and seed.",
        "category_slug": "text-to-image",
        "output_type": "image",
        "comfy_api_json": {
            "3": {
                "class_type": "KSampler",
                "_meta": {"title": "KSampler"},
                "inputs": {
                    "seed": 482910384,
                    "steps": 28,
                    "cfg": 6.5,
                    "sampler_name": "dpmpp_2m",
                    "scheduler": "karras",
                    "denoise": 1.0,
                    "model": ["4", 0],
                    "positive": ["6", 0],
                    "negative": ["7", 0],
                    "latent_image": ["5", 0],
                },
            },
            "4": {
                "class_type": "CheckpointLoaderSimple",
                "_meta": {"title": "Load Checkpoint"},
                "inputs": {"ckpt_name": "sd_xl_base_1.0.safetensors"},
            },
            "5": {
                "class_type": "EmptyLatentImage",
                "_meta": {"title": "Empty Latent Image"},
                "inputs": {"width": 1024, "height": 1024, "batch_size": 1},
            },
            "6": {
                "class_type": "CLIPTextEncode",
                "_meta": {"title": "Positive Prompt"},
                "inputs": {
                    "text": "Architectural concrete atrium bathed in crisp morning sunlight, Leica 35mm f/2, natural shadows, editorial photography",
                    "clip": ["4", 1],
                },
            },
            "7": {
                "class_type": "CLIPTextEncode",
                "_meta": {"title": "Negative Prompt"},
                "inputs": {
                    "text": "blurry, lowres, deformed, watermark, text, oversaturated, plastic skin",
                    "clip": ["4", 1],
                },
            },
            "8": {
                "class_type": "VAEDecode",
                "_meta": {"title": "VAE Decode"},
                "inputs": {"samples": ["3", 0], "vae": ["4", 2]},
            },
            "9": {
                "class_type": "SaveImage",
                "_meta": {"title": "Save Image"},
                "inputs": {"filename_prefix": "ComfyCentre_SDXL", "images": ["8", 0]},
            },
        },
        "ui_inputs": [
            {
                "id": "6:text",
                "node_id": "6",
                "class_type": "CLIPTextEncode",
                "field_name": "text",
                "label": "Positive Prompt",
                "widget": "textarea",
                "value_type": "string",
                "default_value": "Architectural concrete atrium bathed in crisp morning sunlight, Leica 35mm f/2, natural shadows, editorial photography",
                "order": 1,
            },
            {
                "id": "7:text",
                "node_id": "7",
                "class_type": "CLIPTextEncode",
                "field_name": "text",
                "label": "Negative Prompt",
                "widget": "textarea",
                "value_type": "string",
                "default_value": "blurry, lowres, deformed, watermark, text, oversaturated, plastic skin",
                "order": 2,
            },
            {
                "id": "5:width",
                "node_id": "5",
                "class_type": "EmptyLatentImage",
                "field_name": "width",
                "label": "Width",
                "widget": "select",
                "value_type": "int",
                "default_value": 1024,
                "options": ["768", "896", "1024", "1152", "1280", "1344"],
                "order": 3,
            },
            {
                "id": "5:height",
                "node_id": "5",
                "class_type": "EmptyLatentImage",
                "field_name": "height",
                "label": "Height",
                "widget": "select",
                "value_type": "int",
                "default_value": 1024,
                "options": ["768", "896", "1024", "1152", "1280", "1344"],
                "order": 4,
            },
            {
                "id": "3:steps",
                "node_id": "3",
                "class_type": "KSampler",
                "field_name": "steps",
                "label": "Sampling Steps",
                "widget": "slider",
                "value_type": "int",
                "default_value": 28,
                "min": 10,
                "max": 60,
                "step": 1,
                "order": 5,
            },
            {
                "id": "3:cfg",
                "node_id": "3",
                "class_type": "KSampler",
                "field_name": "cfg",
                "label": "CFG Scale",
                "widget": "slider",
                "value_type": "float",
                "default_value": 6.5,
                "min": 1,
                "max": 15,
                "step": 0.5,
                "order": 6,
            },
            {
                "id": "3:seed",
                "node_id": "3",
                "class_type": "KSampler",
                "field_name": "seed",
                "label": "Seed",
                "widget": "seed_randomizer",
                "value_type": "int",
                "default_value": 482910384,
                "order": 7,
            },
        ],
    },
    {
        "name": "Image-to-Video (VHS MP4)",
        "description": "Animates an uploaded reference image using SVD/Wan temporal conditioning and encodes H.264 MP4 via VHS_VideoCombine.",
        "category_slug": "image-to-video",
        "output_type": "video",
        "comfy_api_json": {
            "10": {
                "class_type": "LoadImage",
                "_meta": {"title": "Load Reference Image"},
                "inputs": {"image": "reference_frame.png", "upload": "image"},
            },
            "12": {
                "class_type": "ImageOnlyCheckpointLoader",
                "_meta": {"title": "Load Video Model"},
                "inputs": {"ckpt_name": "svd_xt_1_1.safetensors"},
            },
            "14": {
                "class_type": "SVD_img2vid_Conditioning",
                "_meta": {"title": "SVD Conditioning"},
                "inputs": {
                    "width": 1024,
                    "height": 576,
                    "video_frames": 25,
                    "motion_bucket_id": 127,
                    "fps": 12,
                    "augmentation_level": 0.0,
                    "clip_vision": ["12", 1],
                    "init_image": ["10", 0],
                    "vae": ["12", 2],
                },
            },
            "15": {
                "class_type": "KSampler",
                "_meta": {"title": "Video KSampler"},
                "inputs": {
                    "seed": 910428172,
                    "steps": 20,
                    "cfg": 2.5,
                    "sampler_name": "euler",
                    "scheduler": "karras",
                    "denoise": 1.0,
                    "model": ["12", 0],
                    "positive": ["14", 0],
                    "negative": ["14", 1],
                    "latent_image": ["14", 2],
                },
            },
            "16": {
                "class_type": "VAEDecode",
                "_meta": {"title": "VAE Decode Frames"},
                "inputs": {"samples": ["15", 0], "vae": ["12", 2]},
            },
            "18": {
                "class_type": "VHS_VideoCombine",
                "_meta": {"title": "VHS Video Combine"},
                "inputs": {
                    "frame_rate": 12,
                    "loop_count": 0,
                    "filename_prefix": "ComfyCentre_Video",
                    "format": "video/h264-mp4",
                    "pingpong": False,
                    "save_output": True,
                    "images": ["16", 0],
                },
            },
        },
        "ui_inputs": [
            {
                "id": "10:image",
                "node_id": "10",
                "class_type": "LoadImage",
                "field_name": "image",
                "label": "Reference Frame",
                "widget": "image_upload",
                "value_type": "media",
                "default_value": "",
                "order": 1,
            },
            {
                "id": "14:video_frames",
                "node_id": "14",
                "class_type": "SVD_img2vid_Conditioning",
                "field_name": "video_frames",
                "label": "Frame Count",
                "widget": "slider",
                "value_type": "int",
                "default_value": 25,
                "min": 14,
                "max": 49,
                "step": 1,
                "order": 2,
            },
            {
                "id": "14:motion_bucket_id",
                "node_id": "14",
                "class_type": "SVD_img2vid_Conditioning",
                "field_name": "motion_bucket_id",
                "label": "Motion Intensity",
                "widget": "slider",
                "value_type": "int",
                "default_value": 127,
                "min": 10,
                "max": 255,
                "step": 1,
                "order": 3,
            },
            {
                "id": "18:frame_rate",
                "node_id": "18",
                "class_type": "VHS_VideoCombine",
                "field_name": "frame_rate",
                "label": "Output FPS",
                "widget": "number",
                "value_type": "int",
                "default_value": 12,
                "min": 6,
                "max": 60,
                "step": 1,
                "order": 4,
            },
            {
                "id": "18:format",
                "node_id": "18",
                "class_type": "VHS_VideoCombine",
                "field_name": "format",
                "label": "Container Format",
                "widget": "select",
                "value_type": "string",
                "default_value": "video/h264-mp4",
                "options": ["video/h264-mp4", "video/webm", "image/gif"],
                "order": 5,
            },
            {
                "id": "15:steps",
                "node_id": "15",
                "class_type": "KSampler",
                "field_name": "steps",
                "label": "Sampling Steps",
                "widget": "slider",
                "value_type": "int",
                "default_value": 20,
                "min": 10,
                "max": 40,
                "step": 1,
                "order": 6,
            },
            {
                "id": "15:seed",
                "node_id": "15",
                "class_type": "KSampler",
                "field_name": "seed",
                "label": "Seed",
                "widget": "seed_randomizer",
                "value_type": "int",
                "default_value": 910428172,
                "order": 7,
            },
        ],
    },
    {
        "name": "4x UltraSharp Upscaler",
        "description": "Enhances resolution and micro-texture detail on any uploaded image using 4x-UltraSharp ESRGAN.",
        "category_slug": "upscaling",
        "output_type": "image",
        "comfy_api_json": {
            "1": {
                "class_type": "LoadImage",
                "_meta": {"title": "Input Image"},
                "inputs": {"image": "input.png", "upload": "image"},
            },
            "2": {
                "class_type": "UpscaleModelLoader",
                "_meta": {"title": "Load Upscale Model"},
                "inputs": {"model_name": "4x-UltraSharp.pth"},
            },
            "3": {
                "class_type": "ImageUpscaleWithModel",
                "_meta": {"title": "Upscale Image"},
                "inputs": {"upscale_model": ["2", 0], "image": ["1", 0]},
            },
            "4": {
                "class_type": "SaveImage",
                "_meta": {"title": "Save Upscaled Image"},
                "inputs": {"filename_prefix": "ComfyCentre_4xUpscale", "images": ["3", 0]},
            },
        },
        "ui_inputs": [
            {
                "id": "1:image",
                "node_id": "1",
                "class_type": "LoadImage",
                "field_name": "image",
                "label": "Source Image",
                "widget": "image_upload",
                "value_type": "media",
                "default_value": "",
                "order": 1,
            },
            {
                "id": "2:model_name",
                "node_id": "2",
                "class_type": "UpscaleModelLoader",
                "field_name": "model_name",
                "label": "Upscale Model",
                "widget": "select",
                "value_type": "string",
                "default_value": "4x-UltraSharp.pth",
                "options": [
                    "4x-UltraSharp.pth",
                    "4x_NMKD-Siax_200k.pth",
                    "RealESRGAN_x4plus.pth",
                ],
                "order": 2,
            },
            {
                "id": "4:filename_prefix",
                "node_id": "4",
                "class_type": "SaveImage",
                "field_name": "filename_prefix",
                "label": "Output Prefix",
                "widget": "text",
                "value_type": "string",
                "default_value": "ComfyCentre_4xUpscale",
                "order": 3,
            },
        ],
    },
]


def seed_database(session: Session) -> None:
    setting = session.get(AppSetting, "comfyui_url")
    if not setting:
        session.add(
            AppSetting(key="comfyui_url", value=settings.comfyui_url.rstrip("/"))
        )
        session.commit()

    existing_cats = session.exec(select(Category)).all()
    if not existing_cats:
        for cat in DEFAULT_CATEGORIES:
            session.add(Category(**cat))
        session.commit()

    existing_wfs = session.exec(select(WorkflowTemplate)).all()
    if not existing_wfs:
        cats_by_slug = {
            c.slug: c.id for c in session.exec(select(Category)).all() if c.id is not None
        }
        for wf in DEFAULT_WORKFLOWS:
            cat_id = cats_by_slug.get(wf["category_slug"])
            if cat_id is None:
                continue
            session.add(
                WorkflowTemplate(
                    name=wf["name"],
                    description=wf["description"],
                    category_id=cat_id,
                    output_type=wf["output_type"],
                    comfy_api_json=json.dumps(wf["comfy_api_json"]),
                    ui_inputs_json=json.dumps(wf["ui_inputs"]),
                )
            )
        session.commit()
