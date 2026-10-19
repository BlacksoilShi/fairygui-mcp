import copy
import ctypes
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('publish_owner_under_test', ROOT/'publish_owner.py')
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)

BIRTH = '134368646872905623'
OTHER = '134368646872905624'
NOW = 1792395000000
TOKEN = 'private-test-token-not-a-real-credential_123456789'
PROJECT = 'F:/娴嬭瘯/owner-project'
LEASE = dict(schema=1, project=owner.canonical_project(PROJECT), pid=42001,
             startedFileTime=BIRTH, sessionId='old-session',
             requestId='81e6ec57-6792-4bee-90ee-4037f326f3b1', before=0, effective=1)


class Fake:
    def __init__(self, *, handle=17, open_error=0, wait=258, wait_error=0,
                 birth=BIRTH, times_error=0, close_error=0, absent=True):
        self.handle, self.open_error = handle, open_error
        self.wait_value, self.wait_error = wait, wait_error
        self.birth, self.times_error, self.close_error = birth, times_error, close_error
        self.absence = absent
        self.closed, self.opened, self.census_calls = [], [], []
    def open(self, pid):
        self.opened.append(pid)
        return self.handle, self.open_error
    def wait(self, handle):
        return self.wait_value, self.wait_error
    def creation(self, handle):
        return self.birth, self.times_error
    def close(self, handle):
        self.closed.append(handle)
        return self.close_error
    def absent(self, pid):
        self.census_calls.append(pid)
        return self.absence


def raw(lease=None):
    return owner.canonical_json(LEASE if lease is None else lease)


def proof(probe=None, lease=None, **changes):
    args = dict(lease_raw=raw(lease), project=PROJECT, host_session='fresh-session',
                host_pid=42002, token=TOKEN, probe=probe or Fake(), now_ms=NOW)
    args.update(changes)
    return owner.make_owner_proof(**args)


def verify(value, lease=None, **changes):
    args = dict(lease_raw=raw(lease), project=PROJECT, host_session='fresh-session',
                host_pid=42002, token=TOKEN, now_ms=NOW)
    args.update(changes)
    return owner.verify_owner_proof(value, **args)


def resign(value, change):
    result = copy.deepcopy(value)
    payload = json.loads(result['payload'])
    change(payload)
    result['payload'] = owner.canonical_json(payload, ascii=True)
    result['signature'] = hmac.new(TOKEN.encode(), owner.DOMAIN+result['payload'].encode(),
                                    hashlib.sha256).hexdigest()
    return result


class ObservationTests(unittest.TestCase):
    def test_exact_birth_live_and_handle_closed_once(self):
        f = Fake()
        value = owner.observe_owner(42001, BIRTH, probe=f)
        self.assertEqual(value['state'], 'live')
        self.assertEqual(value['observedStartedFileTime'], BIRTH)
        self.assertEqual(f.closed, [17])
    def test_pid_reuse_requires_exact_decimal_birth_difference(self):
        value = owner.observe_owner(42001, BIRTH, probe=Fake(birth=OTHER))
        self.assertEqual(value['state'], 'replaced')
        self.assertEqual(int(OTHER)-int(BIRTH), 1)  # Above JS safe-integer range.
    def test_unknown_birth_is_live_conservative_not_replaced(self):
        value = owner.observe_owner(42001, None, probe=Fake())
        self.assertEqual(value['state'], 'live')
        self.assertEqual(value['reason'], 'pid-presence-conservative')
    def test_signaled_process_is_exited_without_exit_code_query(self):
        f = Fake(wait=0, birth=None)
        value = owner.observe_owner(42001, BIRTH, probe=f)
        self.assertEqual(value['state'], 'exited')
        self.assertEqual(f.closed, [17])
    def test_absent_requires_error87_and_confirmed_complete_census(self):
        f = Fake(handle=None, open_error=87)
        value = owner.observe_owner(42001, None, probe=f)
        self.assertEqual(value['state'], 'absent')
        self.assertEqual(f.closed, [])
        self.assertEqual(f.census_calls, [42001])
    def test_error87_without_census_proof_stays_unknown(self):
        for absent in (False, None, 1, 'yes'):
            with self.subTest(absent=absent):
                value = owner.observe_owner(42001, None, probe=Fake(handle=None, open_error=87, absent=absent))
                self.assertEqual(value['state'], 'unknown')
                self.assertEqual(value['reason'], 'census-unconfirmed')
    def test_access_denied_is_unknown_no_census_guess(self):
        f = Fake(handle=None, open_error=5)
        value = owner.observe_owner(42001, BIRTH, probe=f)
        self.assertEqual(value['state'], 'unknown')
        self.assertEqual(value['win32Error'], 5)
        self.assertEqual(f.census_calls, [])
    def test_unexpected_open_error_is_unknown(self):
        for error in (0, 6, 8, 299):
            self.assertEqual(owner.observe_owner(42001, BIRTH, probe=Fake(handle=None, open_error=error))['state'], 'unknown')
    def test_wait_failure_and_abandoned_are_unknown(self):
        for value in (0xffffffff, 0x80, 2):
            f = Fake(wait=value, wait_error=6)
            result = owner.observe_owner(42001, BIRTH, probe=f)
            self.assertEqual(result['state'], 'unknown')
            self.assertEqual(f.closed, [17])
    def test_times_failure_is_unknown_even_when_wait_is_live(self):
        value = owner.observe_owner(42001, BIRTH, probe=Fake(birth=None, times_error=5))
        self.assertEqual(value['state'], 'unknown')
        self.assertEqual(value['reason'], 'times-failed')
    def test_close_failure_downgrades_to_unknown(self):
        for wait in (0, 258):
            value = owner.observe_owner(42001, BIRTH, probe=Fake(wait=wait, close_error=6))
            self.assertEqual(value['state'], 'unknown')
            self.assertEqual(value['reason'], 'close-failed')
    def test_binding_exception_closes_handle_and_remains_unknown(self):
        f = Fake()
        with patch.object(f, 'wait', side_effect=RuntimeError('Do not expose exception details')):
            value = owner.observe_owner(42001, BIRTH, probe=f)
        self.assertEqual(value['reason'], 'probe-failed')
        self.assertEqual(f.closed, [17])
        self.assertNotIn('exception details', json.dumps(value))
    def test_invalid_pid_and_birth_reject_before_process_api(self):
        for pid in (0, -1, True, 1.0, '42', 2**32):
            f = Fake()
            with self.assertRaises(owner.OwnerProofError):
                owner.observe_owner(pid, BIRTH, probe=f)
            self.assertEqual(f.opened, [])
        for birth in (134368646872905623, True, '123', '1e17', '134368646872905623 ', '0134368646872905623', '9999999999999999999999'):
            with self.assertRaises(owner.OwnerProofError):
                owner.observe_owner(42001, birth, probe=Fake())
    def test_platform_unavailable_is_unknown(self):
        with patch.object(owner.os, 'name', 'posix'):
            self.assertEqual(owner.observe_owner(42001, BIRTH)['reason'], 'platform-unavailable')


class ProofTests(unittest.TestCase):
    def test_absent_exited_and_replaced_proofs_allow_recovery(self):
        for f in (Fake(handle=None, open_error=87), Fake(wait=0), Fake(birth=OTHER)):
            with self.subTest(f=f):
                self.assertTrue(verify(proof(f))['recoveryPermitted'])
    def test_live_and_unknown_proofs_do_not_allow_recovery(self):
        for f in (Fake(), Fake(handle=None, open_error=5), Fake(birth=None, times_error=6)):
            self.assertFalse(verify(proof(f))['recoveryPermitted'])
    def test_weak_live_owner_stays_blocked(self):
        lease = dict(LEASE, startedFileTime=None)
        self.assertFalse(verify(proof(lease=lease), lease=lease)['recoveryPermitted'])
    def test_same_pid_reload_absence_assertion_still_blocked(self):
        value = proof(Fake(handle=None, open_error=87), host_pid=LEASE['pid'])
        self.assertFalse(verify(value, host_pid=LEASE['pid'])['recoveryPermitted'])
    def test_same_pid_with_strong_replacement_is_distinguishable(self):
        value = proof(Fake(birth=OTHER), host_pid=LEASE['pid'])
        self.assertTrue(verify(value, host_pid=LEASE['pid'])['recoveryPermitted'])
    def test_signature_is_reference_hmac_and_payload_ascii(self):
        value = proof()
        self.assertTrue(value['payload'].isascii())
        self.assertEqual(value['signature'], hmac.new(TOKEN.encode('ascii'),
              owner.DOMAIN+value['payload'].encode('ascii'), hashlib.sha256).hexdigest())
        self.assertNotIn(TOKEN, json.dumps(value))
        self.assertNotIn('private', value['payload'])
    def test_wrong_token_and_payload_tamper_rejected(self):
        value = proof()
        with self.assertRaises(owner.OwnerProofError):
            verify(value, token='wrong-token-from-another-project_123456789')
        altered = dict(value, payload=value['payload'].replace('"live"', '"absent"'))
        with self.assertRaises(owner.OwnerProofError):
            verify(altered)
    def test_different_lease_bytes_even_same_request_rejected(self):
        value = proof()
        for key, replacement in (('before', 1), ('effective', 0), ('pid', 42003),
                                  ('sessionId', 'different-old-session'), ('startedFileTime', OTHER)):
            lease = dict(LEASE, **{key: replacement})
            with self.subTest(key=key), self.assertRaises(owner.OwnerProofError):
                verify(value, lease=lease)
    def test_host_session_pid_project_rebinding_rejected(self):
        value = proof()
        for changes in ({'host_session': 'another-session'}, {'host_pid': 42003},
                        {'project': 'F:/another/project'}):
            with self.assertRaises(owner.OwnerProofError):
                verify(value, **changes)
    def test_5000ms_exact_expiry_and_clock_checks(self):
        value = proof()
        verify(value, now_ms=NOW+4999)
        for now in (NOW+5000, NOW+5001, NOW-251, True):
            with self.assertRaises(owner.OwnerProofError):
                verify(value, now_ms=now)
    def test_signed_oversized_ttl_negative_ttl_and_future_rejected(self):
        for changes in ({'expiresAtMs': NOW+5001}, {'expiresAtMs': NOW},
                        {'issuedAtMs': NOW+1000, 'expiresAtMs': NOW+2000},
                        {'issuedAtMs': True}):
            value = resign(proof(), lambda p:p.update(changes))
            with self.assertRaises(owner.OwnerProofError):
                verify(value)
    def test_signed_inconsistent_replaced_or_live_evidence_rejected(self):
        for changes in (
            {'state': 'replaced', 'reason': 'creation-time-differs'},
            {'expectedStartedFileTime': None},
            {'observedStartedFileTime': OTHER},
            {'state': [], 'reason': {}},
            {'state':'absent','reason':'open-invalid-parameter-complete-census-absent','win32Error':5},
            {'win32Error': True},
        ):
            value = resign(proof(), lambda p:p['owner'].update(changes))
            with self.subTest(changes=changes), self.assertRaises(owner.OwnerProofError):
                verify(value)
    def test_signed_observation_pid_or_birth_must_match_lease(self):
        for changes in ({'pid':42003}, {'expectedStartedFileTime':OTHER,'observedStartedFileTime':OTHER}):
            value = resign(proof(), lambda p:p['owner'].update(changes))
            with self.assertRaises(owner.OwnerProofError):
                verify(value)
    def test_envelope_schema_and_bounded_invalid_json(self):
        value = proof()
        for bad in ({**value,'extra':0}, {'payload':'x'*4097,'signature':value['signature']},
                    {'payload':value['payload'],'signature':'0'*64},
                    {'payload':value['payload'],'signature':True},
                    {'payload':'{"x":1,"x":2}','signature':'0'*64}):
            with self.assertRaises(owner.OwnerProofError):
                verify(bad)
    def test_signed_extra_payload_and_observation_keys_rejected(self):
        for fn in (lambda p:p.update(extra=1),lambda p:p['owner'].update(extra=1)):
            with self.assertRaises(owner.OwnerProofError):
                verify(resign(proof(), fn))
    def test_lease_duplicate_noncanonical_extra_and_nonfinite_rejected(self):
        for lease_raw in (raw().replace('"schema":1','"schema":1,"schema":1'),
                          raw()+' ', raw().replace('"before":0','"before":NaN'),
                          owner.canonical_json({**LEASE,'extra':0}),
                          owner.canonical_json(dict(LEASE,before=True))):
            with self.assertRaises(owner.OwnerProofError):
                proof(lease_raw=lease_raw)
    def test_no_control_or_drive_relative_project_allowed(self):
        for project in ('F:relative','../relative','//host/share','F:/ok\nbad'):
            with self.assertRaises(owner.OwnerProofError):
                owner.canonical_project(project)
    def test_token_session_and_clock_validation(self):
        for changes in ({'token':'short'},{'token':' ' * 64},{'host_session':'bad\nsession'},
                        {'host_pid':True},{'now_ms':0}):
            with self.assertRaises(owner.OwnerProofError):
                proof(**changes)


class CensusTests(unittest.TestCase):
    def census(self, responses):
        from ctypes import wintypes as W
        f = owner.Win32Probe.__new__(owner.Win32Probe)
        f.W = W
        calls = []
        class Kernel:
            def K32EnumProcesses(self, pids, capacity, needed):
                calls.append(capacity)
                value = responses[min(len(calls)-1,len(responses)-1)]
                if value == 'fail':return 0
                if value == 'full':
                    needed._obj.value = capacity
                    return 1
                if value == 'unaligned':
                    needed._obj.value = 1
                    return 1
                for i,pid in enumerate(value):pids[i]=pid
                needed._obj.value = len(value)*ctypes.sizeof(W.DWORD)
                return 1
        f.k = Kernel()
        return f,calls
    def test_full_buffer_retried_until_complete(self):
        f,calls = self.census(['full',[os.getpid(),42]])
        self.assertTrue(f.absent(43))
        self.assertEqual(len(calls),2)
        self.assertEqual(calls[1],calls[0]*2)
    def test_permanently_full_buffer_is_unknown(self):
        f,calls = self.census(['full'])
        self.assertIsNone(f.absent(43))
        self.assertEqual(len(calls),7)
    def test_empty_missing_self_or_failed_census_is_unknown(self):
        for response in ([],[42],'fail','unaligned'):
            f,_ = self.census([response])
            self.assertIsNone(f.absent(43))
    def test_present_target_is_not_absent(self):
        f,_ = self.census([[os.getpid(),42]])
        self.assertIs(f.absent(42),False)
    def test_complete_valid_census_proves_target_absent(self):
        f,_ = self.census([[os.getpid(),42]])
        self.assertIs(f.absent(43),True)


@unittest.skipUnless(os.name == 'nt', 'Real Windows process evidence')
class WindowsProbeTests(unittest.TestCase):
    def test_current_helper_pid_is_live_with_exact_birth(self):
        value = owner.observe_owner(os.getpid())
        self.assertEqual(value['state'], 'live')
        self.assertTrue(owner.BIRTH.fullmatch(value['observedStartedFileTime']))
        same = owner.observe_owner(os.getpid(), value['observedStartedFileTime'])
        self.assertEqual(same['reason'], 'creation-time-matches')
    def test_complete_external_census_includes_self(self):
        probe = owner.Win32Probe()
        self.assertIs(probe.absent(os.getpid()), False)
        self.assertIs(probe.absent(0xffffffff), True)
    def test_owned_child_live_exact_replaced_and_signaled_exit259(self):
        p = subprocess.Popen([sys.executable, '-c',
          'import sys; print("ready",flush=True); sys.stdin.readline(); sys.exit(259)'],
          stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
          creationflags=subprocess.CREATE_NO_WINDOW)
        held = None
        try:
            self.assertEqual(p.stdout.readline(), b'ready\r\n')
            current = owner.observe_owner(p.pid)
            self.assertEqual(current['state'], 'live')
            birth = current['observedStartedFileTime']
            self.assertEqual(owner.observe_owner(p.pid,birth)['state'],'live')
            self.assertEqual(owner.observe_owner(p.pid,str(int(birth)+1))['state'],'replaced')
            f = owner.Win32Probe()
            held, error = f.open(p.pid)
            self.assertTrue(held)
            self.assertEqual(error, 0)
            p.stdin.write(b'\n');p.stdin.flush()
            self.assertEqual(p.wait(timeout=10), 259)
            class Held:
                def open(self, pid):return held,0
                def wait(self, handle):return f.wait(handle)
                def creation(self, handle):return f.creation(handle)
                def close(self, handle):return f.close(handle)
            value = owner.observe_owner(p.pid,birth,probe=Held())
            held = None
            self.assertEqual(value['state'],'exited')
            self.assertEqual(value['reason'],'signaled-process-handle')
        finally:
            if held:owner.Win32Probe().close(held)
            if p.poll() is None:
                p.stdin.close()
                p.wait(timeout=10)
            for stream in (p.stdin,p.stdout,p.stderr):
                if stream and not stream.closed:stream.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)

