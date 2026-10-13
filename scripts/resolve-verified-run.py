#!/usr/bin/env python3
"""Reuse only a successful, same-repository, same-SHA verified image run."""
import argparse
import json
import os
import subprocess

REQUIRED={'verify','code-checks','image-build-api','image-build-vision','image-store-compat'}


def api(path):
    result=subprocess.run(['gh','api',path],text=True,capture_output=True,check=True)
    return json.loads(result.stdout)


def eligible(run, repo, sha):
    return (run.get('head_sha')==sha and (run.get('head_repository') or {}).get('full_name','').lower()==repo.lower()
            and run.get('status')=='completed' and run.get('conclusion')=='success'
            and run.get('event') in ('push','workflow_dispatch')
            and run.get('path') in ('.github/workflows/ci.yml','.github/workflows/deploy.yml'))


def resolve(repo,sha,run_id=None):
    if run_id:
        if not run_id.isdigit(): raise ValueError('verified run ID must be numeric')
        runs=[api(f'repos/{repo}/actions/runs/{run_id}')]
    else:
        runs=api(f'repos/{repo}/actions/runs?head_sha={sha}&status=completed&per_page=30')['workflow_runs']
    for run in runs:
        if not eligible(run,repo,sha): continue
        jobs=api(f'repos/{repo}/actions/runs/{run["id"]}/jobs?per_page=100')['jobs']
        passed={j['name'].split(' / ')[-1] for j in jobs if j.get('status')=='completed' and j.get('conclusion')=='success'}
        if not REQUIRED<=passed: continue
        artifacts=api(f'repos/{repo}/actions/runs/{run["id"]}/artifacts?per_page=100')['artifacts']
        matching=[a for a in artifacts if a['name']==f'verified-images-{sha}' and not a['expired'] and a['size_in_bytes']>0]
        if len(matching)==1: return str(run['id'])
    if run_id: raise ValueError('run is not a completed, fully verified same-SHA image source')
    return ''


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--repo',required=True);p.add_argument('--sha',required=True)
    p.add_argument('--run-id');p.add_argument('--force-cold',action='store_true');a=p.parse_args()
    source=''
    if not a.force_cold:
        try: source=resolve(a.repo,a.sha,a.run_id)
        except subprocess.CalledProcessError:
            if a.run_id: raise
            print('Verified-run lookup unavailable; run fresh CI validation')
    print(f'Verified artifact source: {source or "fresh CI"}; SHA={a.sha}')
    if os.getenv('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'],'a') as f:
            f.write(f'reuse={str(bool(source)).lower()}\nrun_id={source}\n')
