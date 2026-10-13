#!/usr/bin/env python3
import copy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

s=importlib.util.spec_from_file_location('resolver',Path(__file__).with_name('resolve-verified-run.py'))
r=importlib.util.module_from_spec(s);s.loader.exec_module(r)


class ResolverTests(unittest.TestCase):
    def setUp(self):
        self.repo='owner/project';self.sha='a'*40
        self.run={'id':123,'head_sha':self.sha,'head_repository':{'full_name':self.repo},'status':'completed','conclusion':'success','event':'push','path':'.github/workflows/ci.yml'}
        self.jobs=[{'name':'verify / '+n,'status':'completed','conclusion':'success'} for n in r.REQUIRED]
        self.artifact={'name':'verified-images-'+self.sha,'expired':False,'size_in_bytes':42}

    def fake(self,path):
        if path.endswith('/jobs?per_page=100'):return {'jobs':self.jobs}
        if path.endswith('/artifacts?per_page=100'):return {'artifacts':[self.artifact]}
        if 'head_sha=' in path:return {'workflow_runs':[self.run]}
        return self.run

    def test_reuses_only_complete_same_sha_checks(self):
        with patch.object(r,'api',side_effect=self.fake):self.assertEqual(r.resolve(self.repo,self.sha),'123')
        self.jobs[0]['conclusion']='skipped'
        with patch.object(r,'api',side_effect=self.fake):self.assertEqual(r.resolve(self.repo,self.sha),'')

    def test_rejects_wrong_sha_fork_failed_and_untrusted_events(self):
        for change in [{'head_sha':'b'*40},{'head_repository':{'full_name':'fork/project'}},{'conclusion':'failure'},{'status':'in_progress'},{'event':'pull_request'},{'path':'.github/workflows/other.yml'}]:
            original=copy.deepcopy(self.run);self.run.update(change)
            with patch.object(r,'api',side_effect=self.fake):self.assertEqual(r.resolve(self.repo,self.sha),'')
            self.run=original

    def test_rejects_expired_artifact_and_explicit_invalid_run(self):
        self.artifact['expired']=True
        with patch.object(r,'api',side_effect=self.fake):
            self.assertEqual(r.resolve(self.repo,self.sha),'')
            with self.assertRaises(ValueError):r.resolve(self.repo,self.sha,'123')
        with self.assertRaises(ValueError):r.resolve(self.repo,self.sha,'../runs')


if __name__=='__main__':unittest.main()
