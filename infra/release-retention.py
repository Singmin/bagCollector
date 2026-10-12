#!/usr/bin/env python3
"""Record successful releases; collect only this project's owned, unreferenced data."""
import argparse
import importlib.util
import json
import re
import shutil
import subprocess
import time
from pathlib import Path

spec = importlib.util.spec_from_file_location("bundle", Path(__file__).with_name("image-bundle.py"))
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)


def run():
    p = argparse.ArgumentParser()
    p.add_argument("--root", type=Path, required=True)
    p.add_argument("--release", type=Path, required=True)
    p.add_argument("--sha", required=True)
    args = p.parse_args()
    root = args.root.resolve()
    release = args.release.resolve()
    if not bundle.SHA.fullmatch(args.sha) or not release.is_relative_to(root / "releases"):
        raise ValueError("invalid retention target")
    state = root / ".image-cache/v2/history.json"
    records = json.loads(state.read_text()) if state.exists() else []
    # Include the prior running version seeded from legacy archives on first migration.
    if not records:
        for file in (state.parent / "bootstrap").glob("*"):
            old = json.loads(file.read_text())
            if bundle.SHA.fullmatch(old["source_sha"]) and not any(r["sha"] == old["source_sha"] for r in records):
                records.append({"sha": old["source_sha"], "release": old["release"], "time": 0})
    records = [r for r in records if r["sha"] != args.sha]
    records.append({"sha": args.sha, "release": str(release), "time": time.time()})
    retained = records[-3:]
    protected_shas = {r["sha"] for r in retained}
    ids = subprocess.check_output(["docker", "ps", "-aq"], text=True).split()
    protected_images = set()
    if ids:
        protected_images.update(subprocess.check_output(["docker", "inspect", "--format", "{{.Config.Image}}", *ids], text=True).splitlines())
    for image in protected_images:
        sha = image.rsplit(":", 1)[-1]
        if bundle.SHA.fullmatch(sha):
            protected_shas.add(sha)
    referenced = set()
    expired = []
    for file in (state.parent / "bootstrap").glob("*"):
        old = json.loads(file.read_text())
        if old["source_sha"] in protected_shas:
            referenced.update(old.get("objects", []))
    releases = root / "releases"
    for directory in releases.iterdir():
        if directory.is_symlink() or not directory.is_dir():
            continue
        manifests = list(directory.glob("*-images/manifest.json"))
        if not manifests:
            continue
        loaded = [bundle.load(path.parent) for path in manifests]
        sha = loaded[0]["source_sha"]
        recent_pending = (directory / ".v2-release").is_file() and directory.stat().st_mtime > time.time() - 7 * 86400
        if sha in protected_shas or recent_pending:
            for m in loaded:
                referenced.update(bundle.chunks(m))
        elif (directory / ".v2-release").is_file() and (directory / ".v2-release").read_text().strip() == sha and directory.name.startswith(sha + "-"):
            expired.append((sha, directory))
    # Update history before cleanup; every recorded release has completed health checks.
    bundle.atomic(state, (json.dumps(retained, sort_keys=True) + "\n").encode())
    removed = 0
    objects = state.parent / "objects"
    for file in objects.glob("*.gz"):
        if not file.is_symlink() and bundle.HEX.fullmatch(file.stem) and file.stem not in referenced:
            file.unlink()
            removed += 1
    for sha, directory in expired:
        if directory.is_symlink() or not directory.resolve().is_relative_to(releases):
            continue
        for name in ("api", "admin", "vision"):
            image = "bagcollect-" + name + ":" + sha
            if image not in protected_images:
                subprocess.run(["docker", "image", "rm", image], check=False, stdout=subprocess.DEVNULL)
        shutil.rmtree(directory)
    print(f"Retention: {len(retained)} successful versions; removed {removed} unreferenced cached objects")


if __name__ == "__main__":
    run()
