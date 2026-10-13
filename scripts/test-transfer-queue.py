#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('queue', ROOT / 'infra/transfer-queue.py')
q = importlib.util.module_from_spec(spec); spec.loader.exec_module(q)


class QueueTests(unittest.TestCase):
    def test_limits_largest_first_and_dynamic_claims(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); objects=root/'objects'; objects.mkdir()
            sizes=[5*1024*1024,3*1024*1024,2*1024*1024]+[1024]*100
            names=[]
            for i,size in enumerate(sizes):
                name=f'{i:064x}.gz'; names.append(name)
                with (objects/name).open('wb') as f: f.truncate(size)
            missing=root/'missing'; missing.write_text('\n'.join(reversed(names)))
            queue=root/'queue'; data=q.plan(missing,objects,queue)
            self.assertEqual(data['batches'][0]['files'],[names[0]])
            for batch in data['batches']:
                self.assertLessEqual(len(batch['files']),16)
                self.assertTrue(batch['bytes']<=4*1024*1024 or len(batch['files'])==1)
            # Hold one claimed batch open while the other workers drain the queue.
            # This models a slow stream without relying on OS lock timing.
            held=q.claim(queue,1)
            def worker(n):
                while (item:=q.claim(queue,n)) is not None:
                    index,size,file=item
                    time.sleep(0.002)
                    q.complete(queue,n,index,0.002,0,size)
            threads=[threading.Thread(target=worker,args=(i,)) for i in range(2,5)]
            for t in threads: t.start()
            for t in threads: t.join()
            index,size,file=held;q.complete(queue,1,index,10,0,size)
            state=json.loads((queue/'state.json').read_text())
            claims=[e for e in state['events'] if e['event']=='claim']
            self.assertEqual(len(claims),len(data['batches']))
            self.assertEqual(len({e['batch'] for e in claims}),len(claims))
            self.assertTrue(any(sum(e['worker']==i for e in claims)>1 for i in range(2,5)))
            snapshot=q.snapshot(queue)
            self.assertEqual(snapshot['transport_completed_bytes'],sum(sizes))

    def test_failed_transport_is_not_completed(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); objects=root/'objects'; objects.mkdir()
            name='a'*64+'.gz';(objects/name).write_bytes(b'payload')
            missing=root/'missing';missing.write_text(name+'\n')
            queue=root/'queue';q.plan(missing,objects,queue)
            index,size,file=q.claim(queue,1);q.complete(queue,1,index,1,23,3)
            self.assertEqual(q.snapshot(queue)['transport_completed_bytes'],0)
            self.assertEqual(q.snapshot(queue)['workers']['1']['failures'],1)

    def test_rejects_duplicate_and_escaping_names(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);missing=root/'missing'
            for text in ['../object.gz\n','a'*64+'.gz\n'+'a'*64+'.gz\n']:
                missing.write_text(text)
                with self.assertRaises(ValueError):q.plan(missing,root,root/'queue')


if __name__=='__main__': unittest.main()
