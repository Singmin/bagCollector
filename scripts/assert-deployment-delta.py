#!/usr/bin/env python3
import argparse
import importlib.util
import json
from pathlib import Path

spec=importlib.util.spec_from_file_location('delta',Path(__file__).with_name('image-delta-report.py'))
delta=importlib.util.module_from_spec(spec);spec.loader.exec_module(delta)
p=argparse.ArgumentParser()
p.add_argument('--before',type=Path,required=True);p.add_argument('--after',type=Path,required=True)
p.add_argument('--objects',type=Path,required=True);p.add_argument('--case',required=True);p.add_argument('--output',type=Path,required=True)
a=p.parse_args();result=delta.report([a.before],a.after,a.objects)
large=lambda root:{m['sha256'] for m in delta.b.load(root/'production-images')['members'] if m.get('sha256') and m['size']>=10*1024*1024}
result['case']=a.case;result['stable_large_layers_equal']=large(a.before)==large(a.after)
a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(result,indent=2)+'\n')
print(f"{a.case}: {result['new_objects']} new objects, {result['new_upload_bytes']} bytes, stable large layers equal={result['stable_large_layers_equal']}")
assert result['stable_large_layers_equal'],'stable dependency/native-engine layers changed'
assert result['new_upload_bytes']<=10*1024*1024,'incremental transfer exceeds 10 MiB; inspect the changed_members report'
