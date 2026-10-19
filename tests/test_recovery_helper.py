"""Real OS share-none locking and authenticated proof publication, no editor launch."""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import patch
import test_helper as helpers
h=helpers.h
ROOT=helpers.ROOT

@unittest.skipUnless(os.name == 'nt', 'External Windows proof helper')
class RecoveryHelperTests(unittest.TestCase):
    tearDown=helpers.HelperTests.tearDown
    save=helpers.HelperTests.save
    def setUp(self):
        (ROOT/'tests/tmp').mkdir(parents=True,exist_ok=True)
        helpers.HelperTests.setUp(self)
        self.value['editorPath']=h.current_process(os.getpid())['path'];self.save()
        self.helper=h.Helper(self.config)
        self.directory=self.project/'plugins/fgui-agent-bridge-custom';self.directory.mkdir(parents=True)
        self.lease=self.directory/'publish-lease.json'
        self.proof=self.directory/'publish-owner-proof.json'
        self.raw=json.dumps(dict(schema=1,project=str(self.project).replace('\\','/').lower(),
          pid=0xffffffff,startedFileTime=None,sessionId='old',
          requestId='81e6ec57-6792-4bee-90ee-4037f326f3b1',before=0,effective=1),
          ensure_ascii=False,separators=(',',':'))
        self.lease.write_text(self.raw,encoding='utf-8')
        self.heartbeat=dict(sessionId='fresh-session',publishRecovery=dict(blocked=True),
          publishRecoveryChallenge=dict(schema=1,sessionId='fresh-session',hostPid=os.getpid(),
          project=str(self.project).replace('\\','/').lower(),
          leaseSha256=hashlib.sha256(self.raw.encode()).hexdigest()))
        self.ping=patch.object(self.helper,'ping',side_effect=lambda:self.heartbeat)
        self.ping.start();self.addCleanup(self.ping.stop)
    def test_prepares_authenticated_proof_without_restoring_or_deleting_lease(self):
        value=self.helper.recover_publish()
        self.assertTrue(value['prepared']);self.assertTrue(value['recoveryPermitted'])
        self.assertFalse(value['nativeRestored']);self.assertEqual(value['ownerState'],'absent')
        self.assertEqual(self.lease.read_text(encoding='utf-8'),self.raw)
        proof=h.decode(self.proof.read_text())
        self.assertEqual(set(proof),{'payload','signature'})
        self.assertNotIn(self.value['token'],self.proof.read_text())
        self.assertFalse(list(self.directory.glob('.owner-proof-*')))
    def test_live_host_pid_as_owner_never_permits_recovery(self):
        lease=json.loads(self.raw);lease['pid']=os.getpid()
        self.raw=json.dumps(lease,ensure_ascii=False,separators=(',',':'))
        self.lease.write_text(self.raw,encoding='utf-8')
        self.heartbeat['publishRecoveryChallenge']['leaseSha256']=hashlib.sha256(self.raw.encode()).hexdigest()
        result=self.helper.recover_publish()
        self.assertEqual(result['ownerState'],'live')
        self.assertFalse(result['recoveryPermitted'])
        self.assertTrue(self.lease.exists())
    def test_wrong_host_image_is_rejected(self):
        with patch.object(h,'current_process',return_value={'path':str(ROOT/'helper.py'),'creationTime':1}):
            with self.assertRaises(h.HelperError) as e:self.helper.recover_publish()
        self.assertEqual(e.exception.code,'PUBLISH_HOST_IDENTITY');self.assertFalse(self.proof.exists())
    def test_stale_recorded_host_birth_is_rejected(self):
        state=self.helper.work/'state';state.mkdir()
        (state/'editor-start.json').write_text(json.dumps(dict(pid=os.getpid(),processCreationTime=1,projectPath=str(self.project))))
        with self.assertRaises(h.HelperError) as e:self.helper.recover_publish()
        self.assertEqual(e.exception.code,'PUBLISH_HOST_IDENTITY');self.assertFalse(self.proof.exists())
    def test_no_authenticated_ping_never_prepares_proof(self):
        self.heartbeat=None
        with self.assertRaises(h.HelperError) as e:self.helper.recover_publish()
        self.assertEqual(e.exception.code,'BRIDGE_UNREACHABLE');self.assertFalse(self.proof.exists())
    def test_fresh_proof_is_not_overwritten(self):
        self.helper.recover_publish();before=self.proof.read_bytes()
        with self.assertRaises(h.HelperError) as e:self.helper.recover_publish()
        self.assertEqual(e.exception.code,'PUBLISH_OWNER_PROOF_BUSY')
        self.assertEqual(self.proof.read_bytes(),before)
    def test_malformed_existing_proof_is_preserved(self):
        self.proof.write_bytes(b'{')
        with self.assertRaises(Exception):self.helper.recover_publish()
        self.assertEqual(self.proof.read_bytes(),b'{')
    def test_wrong_lease_challenge_is_rejected(self):
        self.heartbeat['publishRecoveryChallenge']['leaseSha256']='0'*64
        with self.assertRaises(h.HelperError) as e:self.helper.recover_publish()
        self.assertEqual(e.exception.code,'PUBLISH_LEASE_CHANGED');self.assertFalse(self.proof.exists())
    def test_real_share_none_handle_blocks_then_releases_preparation(self):
        from ctypes import wintypes as W
        k=ctypes.WinDLL('kernel32',use_last_error=True)
        k.CreateFileW.argtypes=[W.LPCWSTR,W.DWORD,W.DWORD,ctypes.c_void_p,W.DWORD,W.DWORD,W.HANDLE]
        k.CreateFileW.restype=W.HANDLE;k.CloseHandle.argtypes=[W.HANDLE]
        handle=k.CreateFileW(str(self.directory/'publish-proof.lock'),0xc0000000,0,None,4,128,None)
        self.assertNotEqual(handle,ctypes.c_void_p(-1).value)
        try:
            with self.assertRaises(h.HelperError) as e:self.helper.recover_publish()
            self.assertEqual(e.exception.code,'PUBLISH_OWNER_PROOF_BUSY')
            self.assertFalse(self.proof.exists())
        finally:k.CloseHandle(handle)
        self.assertTrue(self.helper.recover_publish()['prepared'])
    def test_unblocked_bridge_is_a_noop(self):
        self.heartbeat['publishRecovery']={'blocked':False}
        result=self.helper.recover_publish()
        self.assertFalse(result['prepared']);self.assertFalse(result['nativeRestored'])
        self.assertFalse(self.proof.exists())

if __name__=='__main__':unittest.main(verbosity=2)

