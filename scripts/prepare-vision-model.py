"""Prepare a pinned ONNX artifact BEFORE deployment. Production never downloads model weights.

Export dependencies: torch==2.7.1 (CPU), transformers==4.52.4, onnx==1.18.0,
plus apps/vision/requirements.txt. Set HF_ENDPOINT=https://hf-mirror.com when needed.
"""
import argparse
import hashlib
import json
import os
import urllib.request
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from transformers import AutoModel

REVISION = "ed25f3a31f01632728cabb09d1542f84ab7b0056"
MODEL = "dinov2-small-ed25f3a-cls-rgb-contain224-v1"
parser = argparse.ArgumentParser()
parser.add_argument("--output", default="data/vision-models")
parser.add_argument("--download-direct", action="store_true", help="Use pinned HTTPS files when Hub HEAD requests are blocked")
args = parser.parse_args()
destination = Path(args.output)
destination.mkdir(parents=True, exist_ok=True)
torch.set_num_threads(1)
torch.manual_seed(20261011)
source = "facebook/dinov2-small"
if args.download_direct:
    source_dir = destination / "source"
    source_dir.mkdir(exist_ok=True)
    endpoint = os.environ.get("HF_ENDPOINT", "https://huggingface.co").rstrip("/")
    for name in ["config.json", "model.safetensors"]:
        target = source_dir / name
        if not target.exists():
            with urllib.request.urlopen(f"{endpoint}/facebook/dinov2-small/resolve/{REVISION}/{name}", timeout=120) as response:
                temporary = target.with_suffix(".partial")
                with temporary.open("wb") as out:
                    while chunk := response.read(1024 * 1024):
                        out.write(chunk)
                temporary.replace(target)
    source = str(source_dir)
backbone = AutoModel.from_pretrained(source, revision=REVISION, attn_implementation="eager", local_files_only=args.download_direct).eval()


class Encoder(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.backbone = backbone

    def forward(self, pixel_values):
        result = self.backbone(pixel_values=pixel_values).last_hidden_state[:, 0, :]
        return torch.nn.functional.normalize(result, dim=-1)


encoder = Encoder().eval()
sample = torch.randn(1, 3, 224, 224)
output = destination / "dinov2-small.onnx"
with torch.no_grad():
    torch.onnx.export(encoder, (sample,), str(output), input_names=["pixel_values"],
                      output_names=["embedding"], opset_version=17, dynamo=False)
    expected = encoder(sample).numpy()
session = ort.InferenceSession(str(output), providers=["CPUExecutionProvider"])
actual = session.run(None, {"pixel_values": sample.numpy()})[0]
error = float(np.max(np.abs(expected - actual)))
if error > 5e-5:
    raise RuntimeError(f"ONNX export parity failed: {error}")
manifest = {"model": MODEL, "revision": REVISION, "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
            "input": [1, 3, 224, 224], "dim": 384, "export_max_abs_error": error}
(destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
print(json.dumps(manifest))
