#!/usr/bin/env python3
"""Version 2 Docker archive transport. No extraction of archive paths onto the host."""
import argparse
import gzip
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import zlib
from pathlib import Path, PurePosixPath

CHUNK = 4 * 1024 * 1024
HEX = re.compile(r"^[0-9a-f]{64}$")
SHA = re.compile(r"^[0-9a-f]{40}$")
METADATA = ("source-sha", "architecture", "images.ids", "images.fingerprints", "manifest.json")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def atomic(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink() or path.parent.is_symlink():
        raise ValueError("symlink in cache destination")
    fd, temporary = tempfile.mkstemp(prefix=".writing-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def safe_name(name):
    p = PurePosixPath(name)
    if not name or p.is_absolute() or ".." in p.parts or "\\" in name or "\0" in name:
        raise ValueError("invalid archive member path")
    return name


def object_path(directory, sha):
    if not HEX.fullmatch(sha):
        raise ValueError("invalid object digest")
    directory = Path(directory)
    if directory.is_symlink():
        raise ValueError("symlink object directory")
    path = directory / (sha + ".gz")
    if path.is_symlink():
        raise ValueError("symlink object")
    return path


def read_object(directory, chunk, incoming=False):
    path = object_path(directory, chunk["sha256"])
    # Bound both compressed input and expansion, including concatenated gzip streams.
    if not path.is_file() or path.stat().st_size > CHUNK + 65536:
        raise ValueError("missing or invalid object " + chunk["sha256"])
    if incoming and file_digest(path) != chunk["compressed_sha256"]:
        raise ValueError("compressed object checksum mismatch")
    with gzip.open(path, "rb") as f:
        data = f.read(CHUNK + 1)
    if len(data) != chunk["size"] or digest(data) != chunk["sha256"]:
        raise ValueError("object content checksum mismatch")
    return data


def store_object(directory, data):
    sha = digest(data)
    encoded = gzip.compress(data, compresslevel=6, mtime=0)
    chunk = {"sha256": sha, "size": len(data), "compressed_sha256": digest(encoded), "compressed_size": len(encoded)}
    path = object_path(directory, sha)
    if not path.exists() or path.read_bytes() != encoded:
        atomic(path, encoded)
    return chunk


def pack(archive, bundle, objects):
    members = []
    names = set()
    with tarfile.open(archive, "r|*") as tar:
        for info in tar:
            safe_name(info.name)
            if info.name in names:
                raise ValueError("duplicate archive member")
            names.add(info.name)
            if info.type not in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE, tarfile.SYMTYPE, tarfile.LNKTYPE):
                raise ValueError("unsupported archive member type")
            if info.linkname:
                safe_name(info.linkname)
            member = {"name": info.name, "mode": info.mode, "uid": info.uid, "gid": info.gid,
                      "mtime": info.mtime, "type": info.type.decode("ascii"), "linkname": info.linkname,
                      "size": info.size if info.isfile() else 0, "chunks": []}
            if info.isfile():
                f = tar.extractfile(info)
                h = hashlib.sha256()
                size = 0
                while True:
                    data = f.read(CHUNK)
                    if not data:
                        break
                    h.update(data)
                    size += len(data)
                    member["chunks"].append(store_object(objects, data))
                if size != info.size:
                    raise ValueError("truncated archive member")
                member["sha256"] = h.hexdigest()
            members.append(member)
    manifest = {"version": 2, "source_sha": (bundle / "source-sha").read_text().strip(),
                "architecture": (bundle / "architecture").read_text().strip(), "members": members}
    atomic(bundle / "manifest.json", (json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n").encode())
    sums = "".join(f"{file_digest(bundle / name)}  {name}\n" for name in METADATA)
    atomic(bundle / "SHA256SUMS", sums.encode())
    print(f"Packed {len(members)} archive members, {len(chunks(manifest))} unique objects", file=sys.stderr)


def load(bundle, expected_sha=None, architecture=None):
    bundle = Path(bundle)
    manifest_path = bundle / "manifest.json"
    if manifest_path.stat().st_size > 32 * 1024 * 1024:
        raise ValueError("manifest too large")
    sums = {}
    for line in (bundle / "SHA256SUMS").read_text().splitlines():
        value, name = line.split("  ", 1)
        if name not in METADATA or name in sums or not HEX.fullmatch(value):
            raise ValueError("invalid metadata checksum list")
        sums[name] = value
    if set(sums) != set(METADATA):
        raise ValueError("incomplete metadata checksums")
    for name, value in sums.items():
        if (bundle / name).is_symlink() or file_digest(bundle / name) != value:
            raise ValueError("metadata checksum mismatch: " + name)
    m = json.loads(manifest_path.read_text())
    if m.get("version") != 2 or not SHA.fullmatch(m.get("source_sha", "")):
        raise ValueError("invalid artifact version or SHA")
    if m["source_sha"] != (bundle / "source-sha").read_text().strip() or (expected_sha and m["source_sha"] != expected_sha):
        raise ValueError("source SHA mismatch")
    if m["architecture"] not in ("amd64", "arm64") or m["architecture"] != (bundle / "architecture").read_text().strip():
        raise ValueError("invalid architecture")
    if architecture and m["architecture"] != architecture:
        raise ValueError("architecture mismatch")
    if not isinstance(m.get("members"), list) or not 1 <= len(m["members"]) <= 20000:
        raise ValueError("invalid members")
    names = set()
    total = 0
    for member in m["members"]:
        name = safe_name(member["name"])
        if name in names or member["type"] not in ("0", "\0", "5", "1", "2"):
            raise ValueError("invalid member name or type")
        names.add(name)
        if member["linkname"]:
            safe_name(member["linkname"])
        if not isinstance(member["size"], int) or not 0 <= member["size"] <= 8 * 1024**3:
            raise ValueError("invalid member size")
        if member["type"] in ("0", "\0"):
            if not HEX.fullmatch(member["sha256"]) or sum(c["size"] for c in member["chunks"]) != member["size"]:
                raise ValueError("invalid member content")
        elif member["size"] or member["chunks"]:
            raise ValueError("non-file has content")
        total += member["size"]
    if total > 8 * 1024**3:
        raise ValueError("archive too large")
    chunks(m)  # Also validates every object descriptor and duplicate consistency.
    return m


def chunks(manifest):
    result = {}
    for member in manifest["members"]:
        for chunk in member["chunks"]:
            sha = chunk["sha256"]
            if not HEX.fullmatch(sha) or not HEX.fullmatch(chunk["compressed_sha256"]):
                raise ValueError("invalid digest")
            if not isinstance(chunk["size"], int) or not 1 <= chunk["size"] <= CHUNK:
                raise ValueError("invalid chunk size")
            if not isinstance(chunk["compressed_size"], int) or not 1 <= chunk["compressed_size"] <= CHUNK + 65536:
                raise ValueError("invalid compressed size")
            if sha in result and result[sha]["size"] != chunk["size"]:
                raise ValueError("inconsistent shared object")
            result[sha] = chunk
    return result


def required_space(manifests, cache, stage):
    objects = {}
    raw = 0
    for m in manifests:
        objects.update(chunks(m))
        raw += sum(member["size"] for member in m["members"])
    # Compressed receive + reconstructed archive + new daemon layers + 1 GiB headroom.
    encoded = sum(c["compressed_size"] for c in objects.values())
    needed = encoded + 2 * raw + 1024**3
    stage = Path(stage)
    stage.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(stage).free < needed:
        raise ValueError(f"insufficient disk space: need {needed} bytes including reserve")
    print(f"Space reserve: {needed} bytes", file=sys.stderr)


class MemberReader:
    def __init__(self, member, objects):
        self.member, self.objects = member, objects
        self.index, self.data, self.offset = 0, b"", 0
        self.hash = hashlib.sha256()

    def read(self, size):
        output = bytearray()
        while len(output) < size:
            if self.offset == len(self.data):
                if self.index >= len(self.member["chunks"]):
                    break
                self.data = read_object(self.objects, self.member["chunks"][self.index])
                self.index += 1
                self.offset = 0
            amount = min(size - len(output), len(self.data) - self.offset)
            output.extend(self.data[self.offset:self.offset + amount])
            self.offset += amount
        self.hash.update(output)
        return bytes(output)


def rebuild(m, objects, output):
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".part")
    if output.is_symlink() or temporary.is_symlink():
        raise ValueError("symlink output")
    try:
        with open(temporary, "wb") as f, gzip.GzipFile(fileobj=f, mode="wb", mtime=0) as encoded:
            with tarfile.open(fileobj=encoded, mode="w|", format=tarfile.PAX_FORMAT) as tar:
                for member in m["members"]:
                    info = tarfile.TarInfo(member["name"])
                    for field in ("mode", "uid", "gid", "mtime", "linkname", "size"):
                        setattr(info, field, member[field])
                    info.type = member["type"].encode("ascii")
                    reader = MemberReader(member, objects) if info.isfile() else None
                    tar.addfile(info, reader)
                    if reader and reader.hash.hexdigest() != member["sha256"]:
                        raise ValueError("reconstructed member checksum mismatch")
        os.replace(temporary, output)
    finally:
        if temporary.exists():
            temporary.unlink()


def bootstrap(root, cache):
    # Only seed archives belonging to images currently used by this project's containers.
    running = set()
    for container in ("infra-api-1", "infra-admin-1", "infra-vision-1"):
        r = subprocess.run(["docker", "inspect", "--format", "{{.Config.Image}}", container], capture_output=True, text=True)
        tag = r.stdout.strip().rsplit(":", 1)[-1]
        if r.returncode == 0 and SHA.fullmatch(tag):
            running.add(tag)
    for release in sorted((Path(root) / "releases").glob("*"), key=lambda p: p.stat().st_mtime, reverse=True):
        if release.is_symlink():
            continue
        for name in ("production-images", "vision-images"):
            bundle = release / name
            archive = bundle / "images.tar.gz"
            if not archive.is_file() or (bundle / "manifest.json").exists():
                continue
            if not (bundle / "source-sha").is_file() or (bundle / "source-sha").read_text().strip() not in running:
                continue
            try:
                checks = (bundle / "SHA256SUMS").read_text().splitlines()
                for check in checks:
                    sha, filename = check.split("  ", 1)
                    if filename not in (*METADATA, "images.tar.gz") or file_digest(bundle / filename) != sha:
                        raise ValueError("invalid legacy checksum")
                archive_sha = file_digest(archive)
                mark = cache.parent / "bootstrap" / archive_sha
                if mark.exists():
                    continue
                with tarfile.open(archive, "r|*") as tar:
                    seeded = set()
                    for info in tar:
                        if info.isfile():
                            f = tar.extractfile(info)
                            while True:
                                data = f.read(CHUNK)
                                if not data:
                                    break
                                seeded.add(store_object(cache, data)["sha256"])
                atomic(mark, json.dumps({"source_sha": (bundle / "source-sha").read_text().strip(), "release": str(release.resolve()), "objects": sorted(seeded)}).encode())
                print("Seeded legacy archive: " + str(bundle), file=sys.stderr)
            except (OSError, ValueError, tarfile.TarError) as e:
                print("Skipped invalid legacy archive: " + str(e), file=sys.stderr)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("command", choices=("pack", "have", "install", "ingest", "rebuild", "verify", "bootstrap", "space"))
    p.add_argument("--bundle", action="append", default=[])
    p.add_argument("--objects", required=True, type=Path)
    p.add_argument("--archive", type=Path)
    p.add_argument("--incoming", type=Path)
    p.add_argument("--output", type=Path)
    p.add_argument("--root", type=Path)
    p.add_argument("--sha")
    p.add_argument("--architecture")
    args = p.parse_args()
    if args.command == "pack":
        pack(args.archive, Path(args.bundle[0]), args.objects)
        return
    if args.command == "bootstrap":
        bootstrap(args.root, args.objects)
        return
    manifests = [load(b, args.sha, args.architecture) for b in args.bundle]
    if not manifests:
        raise ValueError("no selected bundles")
    objects = {}
    for m in manifests:
        objects.update(chunks(m))
    if args.command == "space":
        required_space(manifests, args.objects, args.root)
    elif args.command == "have":
        missing = []
        for sha, chunk in sorted(objects.items()):
            try:
                read_object(args.objects, chunk)
            except (OSError, ValueError, EOFError, zlib.error):
                missing.append(sha)
        for sha in missing:
            print(sha + ".gz")
        print(json.dumps({"objects": len(objects), "missing": len(missing), "upload_bytes": sum(objects[s]["compressed_size"] for s in missing)}), file=sys.stderr)
    elif args.command in ("install", "ingest"):
        for sha, chunk in objects.items():
            try:
                read_object(args.objects, chunk)
                continue
            except (OSError, ValueError, EOFError, zlib.error):
                pass
            if args.command == "ingest" and not object_path(args.incoming, sha).is_file():
                continue
            read_object(args.incoming, chunk, incoming=True)
            atomic(object_path(args.objects, sha), object_path(args.incoming, sha).read_bytes())
            object_path(args.incoming, sha).unlink()
    elif args.command == "rebuild":
        if len(manifests) != 1:
            raise ValueError("rebuild accepts one bundle")
        rebuild(manifests[0], args.objects, args.output)
    else:
        for chunk in objects.values():
            read_object(args.objects, chunk)
        print("Verified bundle SHA, architecture, metadata and all objects")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, EOFError, tarfile.TarError, zlib.error) as error:
        print("Image bundle rejected: " + str(error), file=sys.stderr)
        sys.exit(1)
