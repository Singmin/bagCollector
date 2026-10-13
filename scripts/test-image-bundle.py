#!/usr/bin/env python3
import gzip
import importlib.util
import io
import json
import os
import shutil
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("bundle", ROOT / "infra/image-bundle.py")
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)


class BundleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Random dependency layer prevents a tiny compressed fixture hiding transfer cost.
        cls.dependencies = os.urandom(b.CHUNK * 2 + 791)

    def setUp(self):
        (ROOT / ".runtime").mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="image-bundle-", dir=ROOT / ".runtime")
        self.root = Path(self.temp.name)
        self.objects = self.root / "runner-objects"
        self.cache = self.root / "server-cache"

    def tearDown(self):
        if not self.root.resolve().is_relative_to((ROOT / ".runtime").resolve()):
            raise ValueError("test cleanup outside workspace")
        self.temp.cleanup()

    def fixture(self, sha="a" * 40, code=b"old application"):
        folder = self.root / sha
        folder.mkdir()
        for name, data in {"source-sha": sha, "architecture": "amd64", "images.ids": "id", "images.fingerprints": "fingerprint"}.items():
            (folder / name).write_text(data)
        archive = folder / "original.tar.gz"
        with tarfile.open(archive, "w:gz") as tar:
            for name, data in {"dependencies/layer.tar": self.dependencies, "app/layer.tar": code, "manifest.json": json.dumps({"tag": sha}).encode()}.items():
                info = tarfile.TarInfo(name)
                info.size, info.mode, info.uid, info.gid, info.mtime = len(data), 0o644, 1000, 1000, 123456
                tar.addfile(info, io.BytesIO(data))
            info = tarfile.TarInfo("app/link")
            info.type, info.linkname = tarfile.LNKTYPE, "app/layer.tar"
            tar.addfile(info)
        b.pack(archive, folder, self.objects)
        return folder, b.load(folder, sha, "amd64")

    def populate(self, m):
        self.cache.mkdir(exist_ok=True)
        for sha in b.chunks(m):
            shutil.copyfile(b.object_path(self.objects, sha), b.object_path(self.cache, sha))

    def rewrite(self, folder, m):
        (folder / "manifest.json").write_text(json.dumps(m))
        (folder / "SHA256SUMS").write_text("".join(f"{b.file_digest(folder / n)}  {n}\n" for n in b.METADATA))

    def test_raw_round_trip_preserves_members_and_content(self):
        folder, m = self.fixture()
        self.populate(m)
        rebuilt = self.root / 'raw.tar'
        b.rebuild(m, self.cache, rebuilt, compressed=False)
        with tarfile.open(folder / 'original.tar.gz') as before, tarfile.open(rebuilt) as after:
            self.assertEqual(before.getnames(), after.getnames())
            for member in before:
                if member.isfile():
                    self.assertEqual(before.extractfile(member).read(), after.extractfile(member.name).read())

    def test_round_trip_preserves_members_and_metadata(self):
        folder, m = self.fixture()
        self.populate(m)
        rebuilt = self.root / "rebuilt.tar.gz"
        b.rebuild(m, self.cache, rebuilt)
        with tarfile.open(folder / "original.tar.gz") as left, tarfile.open(rebuilt) as right:
            for first, second in zip(left.getmembers(), right.getmembers()):
                self.assertEqual((first.name, first.size, first.mode, first.uid, first.gid, first.mtime, first.type, first.linkname),
                                 (second.name, second.size, second.mode, second.uid, second.gid, second.mtime, second.type, second.linkname))
                if first.isfile():
                    self.assertEqual(left.extractfile(first).read(), right.extractfile(second).read())

    def test_business_change_reuses_dependency_objects(self):
        _, first = self.fixture()
        self.populate(first)
        _, second = self.fixture("b" * 40, b"changed application")
        needed = [c for sha, c in b.chunks(second).items() if not b.object_path(self.cache, sha).exists()]
        self.assertEqual(len(needed), 2)
        self.assertLess(sum(c["compressed_size"] for c in needed), 1024)
        self.assertEqual(first["members"][0]["chunks"], second["members"][0]["chunks"])

    def test_chunk_bounds_and_dedup(self):
        _, m = self.fixture()
        self.assertTrue(all(0 < c["size"] <= 4 * 1024 * 1024 for c in b.chunks(m).values()))
        first = b.store_object(self.objects, b"shared")
        self.assertEqual(first, b.store_object(self.objects, b"shared"))

    def test_missing_and_corrupt_cache_are_detected(self):
        _, m = self.fixture()
        chunk = next(iter(b.chunks(m).values()))
        with self.assertRaises(ValueError): b.read_object(self.cache, chunk)
        self.populate(m)
        b.object_path(self.cache, chunk["sha256"]).write_bytes(b"corrupt")
        with self.assertRaises((ValueError, OSError, EOFError)): b.read_object(self.cache, chunk)

    def test_transport_checksum_checked_before_caching(self):
        _, m = self.fixture()
        chunk = next(iter(b.chunks(m).values()))
        path = b.object_path(self.objects, chunk["sha256"])
        path.write_bytes(path.read_bytes() + b"transport corruption")
        with self.assertRaisesRegex(ValueError, "compressed object checksum"): b.read_object(self.objects, chunk, incoming=True)

    def test_legacy_seed_with_different_gzip_encoding_is_reusable(self):
        _, m = self.fixture()
        chunk = next(iter(b.chunks(m).values()))
        raw = b.read_object(self.objects, chunk)
        self.cache.mkdir()
        b.object_path(self.cache, chunk["sha256"]).write_bytes(gzip.compress(raw, compresslevel=1))
        self.assertEqual(b.read_object(self.cache, chunk), raw)

    def test_wrong_sha_architecture_and_metadata_rejected(self):
        folder, _ = self.fixture()
        with self.assertRaisesRegex(ValueError, "SHA mismatch"): b.load(folder, "b" * 40)
        with self.assertRaisesRegex(ValueError, "architecture mismatch"): b.load(folder, architecture="arm64")
        (folder / "images.fingerprints").write_text("tampered")
        with self.assertRaisesRegex(ValueError, "metadata checksum"): b.load(folder)

    def test_traversal_manifest_rejected(self):
        folder, m = self.fixture()
        m["members"][0]["name"] = "../../outside"
        self.rewrite(folder, m)
        with self.assertRaisesRegex(ValueError, "member path"): b.load(folder)

    def test_gzip_expansion_bounded(self):
        raw = b"x" * (b.CHUNK + 1)
        sha = b.digest(raw)
        self.cache.mkdir()
        b.object_path(self.cache, sha).write_bytes(gzip.compress(raw))
        with self.assertRaisesRegex(ValueError, "content checksum"): b.read_object(self.cache, {"sha256": sha, "size": b.CHUNK})

    def test_failed_rebuild_keeps_previous_archive(self):
        _, m = self.fixture()
        self.populate(m)
        output = self.root / "archive.gz"
        output.write_bytes(b"previous archive")
        b.object_path(self.cache, next(iter(b.chunks(m)))).unlink()
        with self.assertRaises(ValueError): b.rebuild(m, self.cache, output)
        self.assertEqual(output.read_bytes(), b"previous archive")
        self.assertFalse(output.with_suffix(".gz.part").exists())

    def test_disk_reserve_failure_before_rebuild(self):
        _, m = self.fixture()
        with patch.object(b.shutil, "disk_usage", return_value=shutil._ntuple_diskusage(100, 100, 0)):
            with self.assertRaisesRegex(ValueError, "insufficient disk"): b.required_space([m], self.cache, self.root)


if __name__ == "__main__":
    unittest.main()
