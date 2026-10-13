#!/usr/bin/env python3
"""Runner-local, locked batch queue. Never treats transport success as verified data."""
import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import time


@contextmanager
def lock(root):
    with (root / 'lock').open('a+b') as f:
        if os.name == 'nt':
            import msvcrt
            f.seek(0); f.write(b'0'); f.flush(); f.seek(0)
            msvcrt.locking(f.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            if os.name == 'nt':
                f.seek(0); msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(f, fcntl.LOCK_UN)


def plan(missing, objects, root):
    entries = []
    names = missing.read_text().splitlines()
    if len(names) != len(set(names)):
        raise ValueError('duplicate missing object')
    for name in names:
        if not re.fullmatch(r'[0-9a-f]{64}\.gz', name):
            raise ValueError('invalid missing object name')
        path = objects / name
        if path.is_symlink() or not path.is_file():
            raise ValueError('invalid local object')
        entries.append((name, path.stat().st_size))
    batches = []
    # A small release should still expose work to four streams rather than
    # becoming one 16-file batch. Larger releases retain the 4 MiB/16-file caps.
    byte_limit = min(4 * 1024 * 1024, max(1, (sum(n for _, n in entries) + 3) // 4))
    file_limit = min(16, max(1, (len(entries) + 3) // 4))
    files, size = [], 0
    for name, length in sorted(entries, key=lambda x: (-x[1], x[0])):
        if files and (len(files) >= file_limit or size + length > byte_limit):
            batches.append({'files': files, 'bytes': size}); files, size = [], 0
        files.append(name); size += length
    if files:
        batches.append({'files': files, 'bytes': size})
    root.mkdir(parents=True, exist_ok=True)
    data = {'batches': batches, 'bytes': sum(n for _, n in entries), 'objects': len(entries),
            'batch_byte_limit': byte_limit, 'batch_file_limit': file_limit}
    (root / 'plan.json').write_text(json.dumps(data))
    (root / 'state.json').write_text(json.dumps({'next': 0, 'events': []}))
    return data


def claim(root, worker):
    with lock(root):
        data = json.loads((root / 'plan.json').read_text())
        state = json.loads((root / 'state.json').read_text())
        index = state['next']
        if index == len(data['batches']):
            return None
        batch = data['batches'][index]
        state['next'] += 1
        state['events'].append({'event': 'claim', 'batch': index, 'worker': worker, 'at': time.time()})
        (root / 'state.json').write_text(json.dumps(state))
        file = root / f'batch-{index}.list'
        file.write_text(''.join(name + '\n' for name in batch['files']))
        return index, batch['bytes'], file


def complete(root, worker, batch, elapsed, result, sent):
    with lock(root):
        state = json.loads((root / 'state.json').read_text())
        state['events'].append({'event': 'complete', 'batch': batch, 'worker': worker,
                                'seconds': elapsed, 'result': result, 'sent_bytes': sent, 'at': time.time()})
        (root / 'state.json').write_text(json.dumps(state))


def snapshot(root):
    with lock(root):
        data = json.loads((root / 'plan.json').read_text())
        state = json.loads((root / 'state.json').read_text())
    completed = [e for e in state['events'] if e['event'] == 'complete']
    success = [e for e in completed if e['result'] == 0]
    workers = {}
    for event in completed:
        item = workers.setdefault(str(event['worker']), {'sent_bytes': 0, 'seconds': 0, 'batches': 0, 'failures': 0})
        item['sent_bytes'] += event['sent_bytes']; item['seconds'] += event['seconds']; item['batches'] += 1
        item['failures'] += event['result'] != 0
    for item in workers.values():
        item['bytes_per_second'] = round(item['sent_bytes'] / max(item['seconds'], 0.001), 2)
    return {'required_bytes': data['bytes'], 'objects': data['objects'], 'batches': len(data['batches']),
            'transport_completed_bytes': sum(data['batches'][e['batch']]['bytes'] for e in success),
            'completed_batches': len(completed), 'claimed_batches': state['next'], 'workers': workers}


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('command', choices=['plan', 'claim', 'complete', 'snapshot'])
    p.add_argument('--queue', type=Path, required=True)
    p.add_argument('--missing', type=Path); p.add_argument('--objects', type=Path)
    p.add_argument('--worker', type=int); p.add_argument('--batch', type=int)
    p.add_argument('--elapsed', type=float); p.add_argument('--result', type=int); p.add_argument('--sent', type=int, default=0)
    a = p.parse_args()
    if a.command == 'plan':
        data = plan(a.missing, a.objects, a.queue)
        print(min(4, len(data['batches'])), data['bytes'], data['objects'])
    elif a.command == 'claim':
        batch = claim(a.queue, a.worker)
        if batch:
            print(*batch, sep='\t')
    elif a.command == 'complete':
        complete(a.queue, a.worker, a.batch, a.elapsed, a.result, a.sent)
    else:
        print(json.dumps(snapshot(a.queue), sort_keys=True))
