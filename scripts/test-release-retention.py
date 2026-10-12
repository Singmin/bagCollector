import importlib.util
import json
import os
import sys
import time
from pathlib import Path
from unittest.mock import patch

repo = Path(__file__).resolve().parents[1]
def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

fixtures = module('fixtures', repo / 'scripts/test-image-bundle.py')
retention = module('retention', repo / 'infra/release-retention.py')
fixtures.BundleTests.dependencies = b'large dependency stand-in'
for protected in (False, True):
    test = fixtures.BundleTests()
    test.setUp()
    try:
        root = test.root
        releases = root / 'releases'
        releases.mkdir()
        cache = root / '.image-cache/v2/objects'
        cache.mkdir(parents=True)
        records = []
        hashes = {}
        for letter in 'abcd':
            sha = letter * 40
            folder, manifest = test.fixture(sha, ('application ' + letter).encode())
            release = releases / (sha + '-owned')
            release.mkdir()
            folder = folder.rename(release / 'production-images')
            (release / '.v2-release').write_text(sha)
            os.utime(release, (time.time() - 10 * 86400,) * 2)
            hashes[letter] = set(fixtures.b.chunks(manifest))
            for obj in hashes[letter]:
                (cache / (obj + '.gz')).write_bytes((test.objects / (obj + '.gz')).read_bytes())
            records.append({'sha': sha, 'release': str(release), 'time': 0})
        history = cache.parent / 'history.json'
        history.write_text(json.dumps(records[:3]))
        duplicate, duplicate_manifest = test.fixture('d' * 40, b'earlier prepare of same SHA')
        duplicate_release = releases / ('d' * 40 + '-earlier-prepare')
        duplicate_release.mkdir()
        duplicate.rename(duplicate_release / 'production-images')
        (duplicate_release / '.v2-release').write_text('d' * 40)
        pending, pending_manifest = test.fixture('e' * 40, b'new unfinished release')
        pending_release = releases / ('e' * 40 + '-pending')
        pending_release.mkdir()
        pending.rename(pending_release / 'production-images')
        (pending_release / '.v2-release').write_text('e' * 40)
        for manifest in (duplicate_manifest, pending_manifest):
            for obj in fixtures.b.chunks(manifest):
                (cache / (obj + '.gz')).write_bytes((test.objects / (obj + '.gz')).read_bytes())
        unrelated = releases / 'unrelated-directory'
        unrelated.mkdir()
        (unrelated / 'keep.txt').write_text('preserve other data')
        rogue = cache / ('f' * 64 + '.gz')
        rogue.write_bytes(b'unreferenced')
        def docker_read(args, **kwargs):
            if args[1] == 'ps':
                return 'container' if protected else ''
            return 'bagcollect-api:' + 'a' * 40 + '\n'
        with patch.object(sys, 'argv', ['retention', '--root', str(root), '--release', str(releases / ('d' * 40 + '-owned')), '--sha', 'd' * 40]), patch.object(retention.subprocess, 'check_output', side_effect=docker_read), patch.object(retention.subprocess, 'run') as removed:
            retention.run()
        assert [r['sha'] for r in json.loads(history.read_text())] == [c * 40 for c in 'bcd']
        assert unrelated.is_dir() and not rogue.exists()
        assert not duplicate_release.exists() and pending_release.exists()
        assert all((cache / (h + '.gz')).exists() for h in fixtures.b.chunks(pending_manifest))
        old_release = releases / ('a' * 40 + '-owned')
        assert old_release.exists() == protected
        unique_old = hashes['a'] - set.union(*(hashes[c] for c in 'bcd'))
        assert all((cache / (h + '.gz')).exists() == protected for h in unique_old)
        if protected:
            removed.assert_not_called()
        else:
            assert len(removed.call_args_list) == 3
            assert all(call.args[0][:3] == ['docker', 'image', 'rm'] and call.args[0][-1].endswith('a' * 40) for call in removed.call_args_list)
        print('Retention protection passed:', protected)
    finally:
        test.tearDown()
