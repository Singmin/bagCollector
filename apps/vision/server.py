"""Offline-only, single-session CPU inference. Receives canonical 224x224 RGB PNGs from bag-vision."""
import asyncio
import hashlib
import io
import json
import os
from pathlib import Path

import numpy as np
import onnxruntime as ort
from fastapi import FastAPI, HTTPException, Request
from PIL import Image

MODEL = "dinov2-small-ed25f3a-cls-rgb-contain224-v1"
REVISION = "ed25f3a31f01632728cabb09d1542f84ab7b0056"
model_dir = Path(os.environ.get("VISION_MODEL_DIR", "/models"))
manifest = json.loads((model_dir / "manifest.json").read_text(encoding="utf-8"))
model_path = model_dir / "dinov2-small.onnx"
if manifest["model"] != MODEL or manifest["revision"] != REVISION:
    raise RuntimeError("Model manifest version mismatch")
if hashlib.sha256(model_path.read_bytes()).hexdigest() != manifest["sha256"]:
    raise RuntimeError("Model checksum mismatch")
options = ort.SessionOptions()
options.intra_op_num_threads = 1
options.inter_op_num_threads = 1
options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
options.add_session_config_entry("session.intra_op.allow_spinning", "0")
session = ort.InferenceSession(str(model_path), options, providers=["CPUExecutionProvider"])
gate = asyncio.Semaphore(1)
app = FastAPI()
Image.MAX_IMAGE_PIXELS = 224 * 224


def encode(body: bytes):
    with Image.open(io.BytesIO(body)) as image:
        if image.size != (224, 224) or image.mode != "RGB" or image.format != "PNG":
            raise ValueError("Expected canonical 224x224 RGB PNG")
        tensor = np.asarray(image, dtype=np.float32) / 255.0
    tensor = ((tensor - np.array([0.485, 0.456, 0.406], dtype=np.float32)) /
              np.array([0.229, 0.224, 0.225], dtype=np.float32)).transpose(2, 0, 1)[None]
    vector = session.run(None, {"pixel_values": tensor})[0][0]
    if vector.shape != (384,) or not np.isfinite(vector).all() or np.linalg.norm(vector) < 1e-8:
        raise RuntimeError("Invalid model output")
    return (vector / np.linalg.norm(vector)).tolist()


@app.get("/health/ready")
async def health():
    return {"model": MODEL, "revision": REVISION, "sha256": manifest["sha256"]}


@app.post("/embed")
async def embed(request: Request):
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 1_048_576:
            raise HTTPException(413, "Image too large")
    async with gate:
        try:
            vector = await asyncio.to_thread(encode, bytes(body))
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        return {"model": MODEL, "vector": vector}
