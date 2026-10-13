#!/usr/bin/env python3
"""Compare v2 bundles using the same content keys as the server's have check."""
import argparse
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location('bundle', Path(__file__).resolve().parents[1] / 'infra/image-bundle.py')
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)


def read_json(member, members, objects):
    while member['linkname']:
        member = members[member['linkname']]
    reader = b.MemberReader(member, objects)
    return json.loads(reader.read(member['size']))


def report(before, after, objects=None):
    known = {}
    selected = []
    for root in before:
        for name in ('production-images', 'vision-images'):
            if (root / name / 'manifest.json').exists():
                known.update(b.chunks(b.load(root / name)))
    for name in ('production-images', 'vision-images'):
        if (after / name / 'manifest.json').exists():
            selected.append((name, b.load(after / name)))
    required = {}
    layers = []
    allocated = set()
    for name, manifest in selected:
        required.update(b.chunks(manifest))
        members = {m['name']: m for m in manifest['members']}
        associations = {}
        if objects and 'manifest.json' in members:
            for image in read_json(members['manifest.json'], members, objects):
                config = read_json(members[image['Config']], members, objects)
                history = [h.get('created_by', '') for h in config.get('history', []) if not h.get('empty_layer')]
                for index, layer in enumerate(image['Layers']):
                    associations.setdefault(layer, []).append({'image': image['RepoTags'], 'created_by': history[index] if index < len(history) else ''})
        for member in manifest['members']:
            changed = {c['sha256']: c for c in member['chunks'] if c['sha256'] not in known}
            unique = {s: c for s, c in changed.items() if s not in allocated}
            allocated.update(unique)
            if changed:
                layers.append({'bundle': name, 'member': member['name'], 'uncompressed_bytes': member['size'],
                               'new_objects': len(changed), 'new_compressed_bytes': sum(c['compressed_size'] for c in changed.values()),
                               'unique_upload_bytes': sum(c['compressed_size'] for c in unique.values()), 'images': associations.get(member['name'], [])})
    missing = {s: c for s, c in required.items() if s not in known}
    total = sum(c['compressed_size'] for c in required.values())
    upload = sum(c['compressed_size'] for c in missing.values())
    return {'source_sha': selected[0][1]['source_sha'], 'objects': len(required), 'new_objects': len(missing),
            'new_upload_bytes': upload, 'total_compressed_bytes': total, 'reuse_percent': round(100 * (total-upload) / total, 3),
            'changed_members': sorted(layers, key=lambda x: x['unique_upload_bytes'], reverse=True)}


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--before', type=Path, action='append', required=True)
    p.add_argument('--after', type=Path, required=True)
    p.add_argument('--objects', type=Path)
    p.add_argument('--output', type=Path)
    args = p.parse_args()
    result = report(args.before, args.after, args.objects)
    data = json.dumps(result, indent=2) + '\n'
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(data)
    print(data)
