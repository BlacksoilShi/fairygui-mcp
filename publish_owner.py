"""External Windows process evidence and short-lived authenticated proof.

Standard library only. This module never changes editor settings, removes a
lease, signals a process, or launches an editor. It is a recovery building block,
not a complete recovery implementation. The editor consumer must still verify
the proof and recheck its exact lease/settings before any restore.
"""
from __future__ import annotations
import ctypes
import hashlib
import hmac
import json
import ntpath
import os
import re
import time

MAX_BYTES = 4096
TTL_MS = 5000
DOMAIN = b'fgui-publish-owner-proof-v1\n'
BIRTH = re.compile(r'[0-9]{15,22}\Z')
UUID = re.compile(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\Z')
LEASE_KEYS = {'schema', 'project', 'pid', 'startedFileTime', 'sessionId',
              'requestId', 'before', 'effective'}
PAYLOAD_KEYS = {'schema', 'project', 'hostSession', 'hostPid', 'leaseSha256',
                'requestId', 'issuedAtMs', 'expiresAtMs', 'owner'}
OWNER_KEYS = {'pid', 'expectedStartedFileTime', 'observedStartedFileTime',
              'state', 'reason', 'win32Error'}
REASONS = {
    'absent': {'open-invalid-parameter-complete-census-absent'},
    'exited': {'signaled-process-handle'},
    'replaced': {'creation-time-differs'},
    'live': {'creation-time-matches', 'pid-presence-conservative'},
    'unknown': {'open-failed', 'census-unconfirmed', 'wait-failed', 'times-failed', 'close-failed',
                'probe-failed', 'platform-unavailable'},
}


class OwnerProofError(ValueError):
    """Deliberately bounded errors: never include a token or file contents."""


def canonical_json(value, *, ascii=False):
    return json.dumps(value, ensure_ascii=ascii, separators=(',', ':'),
                      allow_nan=False)


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise OwnerProofError('Duplicate proof key')
        result[key] = value
    return result


def _json(raw):
    if type(raw) is not str or len(raw.encode('utf-8')) > MAX_BYTES:
        raise OwnerProofError('Proof or lease exceeds bound')
    try:
        return json.loads(raw, object_pairs_hook=_pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(
                              OwnerProofError('Nonfinite proof number')))
    except (ValueError, UnicodeError, RecursionError) as e:
        raise OwnerProofError('Invalid bounded proof JSON') from e


def _pid(value):
    if type(value) is not int or not 0 < value < 2**32:
        raise OwnerProofError('Positive DWORD PID required')
    return value


def _birth(value):
    if value is not None and (type(value) is not str or not BIRTH.fullmatch(value)
            or str(int(value)) != value or not 0 < int(value) < 2**64):
        raise OwnerProofError('Exact decimal FILETIME string required')
    return value


def canonical_project(value):
    if type(value) is not str or not value or len(value) > 1024:
        raise OwnerProofError('Bounded absolute Windows project required')
    drive, tail = ntpath.splitdrive(value)
    if not re.fullmatch(r'[A-Za-z]:', drive) or not tail.startswith(('/', '\\')):
        raise OwnerProofError('Drive-absolute Windows project required')
    if any(ord(c) < 32 for c in value):
        raise OwnerProofError('Control characters in project')
    # This lexical normalization does not attest to reparse-point ownership.
    return ntpath.normpath(value).replace('\\', '/').rstrip('/').lower()


def _session(value):
    if (type(value) is not str or not 1 <= len(value) <= 160
            or any(ord(c) < 33 or ord(c) > 126 for c in value)):
        raise OwnerProofError('Bounded printable host session required')
    return value


def parse_lease(raw, project):
    value = _json(raw)
    if (type(value) is not dict or set(value) != LEASE_KEYS
            or raw != canonical_json(value) or type(value['schema']) is not int
            or value['schema'] != 1):
        raise OwnerProofError('Canonical schema1 lease required')
    if value['project'] != canonical_project(project):
        raise OwnerProofError('Lease project differs from configured project')
    _pid(value['pid'])
    _birth(value['startedFileTime'])
    _session(value['sessionId'])
    if type(value['requestId']) is not str or not UUID.fullmatch(value['requestId']):
        raise OwnerProofError('Lease request ID required')
    for key in ('before', 'effective'):
        if type(value[key]) is not int or value[key] not in (0, 1):
            raise OwnerProofError('Native branch processing mode required')
    return value


class Win32Probe:
    """One held handle: wait and creation time belong to the same process.

    OpenProcess uses SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION. Access
    denied, unexpected errors and binding failures are unknown, not termination.
    A signaled wait proves exit even for a process whose exit code is 259.
    """
    def __init__(self):
        if os.name != 'nt':
            raise OSError('Windows process evidence required')
        from ctypes import wintypes as W
        self.W = W
        self.k = ctypes.WinDLL('kernel32', use_last_error=True)
        self.k.OpenProcess.argtypes = [W.DWORD, W.BOOL, W.DWORD]
        self.k.OpenProcess.restype = W.HANDLE
        self.k.WaitForSingleObject.argtypes = [W.HANDLE, W.DWORD]
        self.k.WaitForSingleObject.restype = W.DWORD
        self.k.GetProcessTimes.argtypes = [W.HANDLE] + [ctypes.POINTER(W.FILETIME)]*4
        self.k.GetProcessTimes.restype = W.BOOL
        self.k.CloseHandle.argtypes = [W.HANDLE]
        self.k.CloseHandle.restype = W.BOOL
        self.k.K32EnumProcesses.argtypes = [ctypes.POINTER(W.DWORD), W.DWORD,
                                           ctypes.POINTER(W.DWORD)]
        self.k.K32EnumProcesses.restype = W.BOOL

    def open(self, pid):
        ctypes.set_last_error(0)
        handle = self.k.OpenProcess(0x100000 | 0x1000, False, pid)
        return handle, 0 if handle else ctypes.get_last_error()

    def wait(self, handle):
        ctypes.set_last_error(0)
        value = self.k.WaitForSingleObject(handle, 0)
        return value, ctypes.get_last_error() if value == 0xffffffff else 0

    def creation(self, handle):
        times = [self.W.FILETIME() for _ in range(4)]
        ctypes.set_last_error(0)
        if not self.k.GetProcessTimes(handle, *[ctypes.byref(t) for t in times]):
            return None, ctypes.get_last_error()
        return str((times[0].dwHighDateTime << 32) | times[0].dwLowDateTime), 0

    def close(self, handle):
        ctypes.set_last_error(0)
        return 0 if self.k.CloseHandle(handle) else ctypes.get_last_error() or 1

    def absent(self, pid):
        # Error87 alone is not the absence proof. Require a complete, nonempty
        # external OS PID census which includes this helper's own known PID.
        # Never export names/paths or unrelated process metadata.
        for size in (1024, 2048, 4096, 8192, 16384, 32768, 65536):
            pids = (self.W.DWORD * size)()
            needed = self.W.DWORD()
            if not self.k.K32EnumProcesses(pids, ctypes.sizeof(pids), ctypes.byref(needed)):
                return None
            if needed.value % ctypes.sizeof(self.W.DWORD):
                return None
            if needed.value < ctypes.sizeof(pids):
                values = set(pids[:needed.value//ctypes.sizeof(self.W.DWORD)])
                if os.getpid() not in values:
                    return None
                return pid not in values
        return None


def observe_owner(pid, expected_birth=None, *, probe=None):
    _pid(pid)
    _birth(expected_birth)
    result = dict(pid=pid, expectedStartedFileTime=expected_birth,
                  observedStartedFileTime=None, state='unknown',
                  reason='probe-failed', win32Error=0)
    handle = None
    try:
        if probe is None:
            if os.name != 'nt':
                result['reason'] = 'platform-unavailable'
                return result
            probe = Win32Probe()
        handle, error = probe.open(pid)
        if not handle:
            result.update(reason='open-failed', win32Error=error)
            if error == 87:
                if probe.absent(pid) is True:
                    result.update(state='absent', reason='open-invalid-parameter-complete-census-absent')
                else:
                    result['reason'] = 'census-unconfirmed'
        else:
            wait, error = probe.wait(handle)
            if wait == 0:
                result.update(state='exited', reason='signaled-process-handle')
            elif wait != 258:  # WAIT_TIMEOUT: live held process handle.
                result.update(reason='wait-failed', win32Error=error)
            else:
                actual, error = probe.creation(handle)
                if actual is None:
                    result.update(reason='times-failed', win32Error=error)
                else:
                    _birth(actual)
                    result['observedStartedFileTime'] = actual
                    if expected_birth is not None and expected_birth != actual:
                        result.update(state='replaced', reason='creation-time-differs')
                    else:
                        result.update(state='live', reason='creation-time-matches'
                                      if expected_birth is not None
                                      else 'pid-presence-conservative')
    except Exception:
        result.update(state='unknown', reason='probe-failed', win32Error=0)
    finally:
        if handle is not None and handle:
            try:
                error = probe.close(handle)
                if error:
                    result.update(state='unknown', reason='close-failed', win32Error=error)
            except Exception:
                result.update(state='unknown', reason='close-failed', win32Error=0)
    _validate_owner(result)
    return result


def _validate_owner(value):
    if type(value) is not dict or set(value) != OWNER_KEYS:
        raise OwnerProofError('Exact owner evidence schema required')
    _pid(value['pid'])
    expected = _birth(value['expectedStartedFileTime'])
    actual = _birth(value['observedStartedFileTime'])
    state, reason = value['state'], value['reason']
    if (type(state) is not str or type(reason) is not str
            or state not in REASONS or reason not in REASONS[state]):
        raise OwnerProofError('Inconsistent owner evidence reason')
    if type(value['win32Error']) is not int or not 0 <= value['win32Error'] < 2**32:
        raise OwnerProofError('Bounded Win32 error required')
    if state == 'replaced' and (expected is None or actual is None or actual == expected):
        raise OwnerProofError('PID replacement requires distinct exact creation times')
    if state == 'live':
        if actual is None or (expected is not None and actual != expected):
            raise OwnerProofError('Live owner requires consistent creation evidence')
        expected_reason = 'pid-presence-conservative' if expected is None else 'creation-time-matches'
        if reason != expected_reason:
            raise OwnerProofError('Invalid live evidence strength')
    if state == 'absent' and value['win32Error'] != 87:
        raise OwnerProofError('Absent owner requires ERROR_INVALID_PARAMETER')
    return state in ('absent', 'exited', 'replaced')


def _token(value):
    if type(value) is not str or not re.fullmatch(r'[A-Za-z0-9_-]{32,256}', value):
        raise OwnerProofError('Private configuration token required')
    return value.encode('ascii')


def _clock(value):
    if type(value) is not int or not 0 < value < 2**53:
        raise OwnerProofError('Exact bounded millisecond clock required')
    return value


def make_owner_proof(lease_raw, project, host_session, host_pid, token, *,
                     probe=None, now_ms=None):
    """Return signed evidence only; a live/unknown result is signed but blocked.

    host_session/host_pid must originate from a fresh authenticated bridge ping.
    The caller must additionally attest that host_pid is the configured editor
    process. This primitive does not accept a bare caller assertion as that
    attestation, nor does it publish or consume a proof file.
    """
    value = parse_lease(lease_raw, project)
    _session(host_session)
    _pid(host_pid)
    key = _token(token)
    now = _clock(now_ms if now_ms is not None else time.time_ns()//1000000)
    observation = observe_owner(value['pid'], value['startedFileTime'], probe=probe)
    payload = dict(schema=1, project=value['project'], hostSession=host_session,
                   hostPid=host_pid, leaseSha256=hashlib.sha256(lease_raw.encode('utf-8')).hexdigest(),
                   requestId=value['requestId'], issuedAtMs=now, expiresAtMs=now+TTL_MS,
                   owner=observation)
    # ASCII canonical payload is easy to HMAC unchanged in embedded JS. It is
    # the payload string, not a parsed/reserialized representation, that is signed.
    raw = canonical_json(payload, ascii=True)
    signature = hmac.new(key, DOMAIN+raw.encode('ascii'), hashlib.sha256).hexdigest()
    return {'payload': raw, 'signature': signature}


def verify_owner_proof(proof, lease_raw, project, host_session, host_pid, token, *,
                       now_ms=None):
    """Reference consumer, with exact lease/session/PID/time/schema binding."""
    _session(host_session)
    _pid(host_pid)
    key = _token(token)
    if (type(proof) is not dict or set(proof) != {'payload', 'signature'}
            or type(proof['payload']) is not str
            or not proof['payload'].isascii()
            or type(proof['signature']) is not str
            or not re.fullmatch('[0-9a-f]{64}', proof['signature'])):
        raise OwnerProofError('Bounded signed proof envelope required')
    raw = proof['payload']
    payload = _json(raw)
    signature = hmac.new(key, DOMAIN+raw.encode('ascii'), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, proof['signature']):
        raise OwnerProofError('Owner proof authentication failed')
    if (type(payload) is not dict or set(payload) != PAYLOAD_KEYS
            or raw != canonical_json(payload, ascii=True)
            or type(payload['schema']) is not int or payload['schema'] != 1):
        raise OwnerProofError('Exact proof payload schema required')
    lease = parse_lease(lease_raw, project)
    expected = {'project': lease['project'], 'hostSession': host_session,
                'hostPid': host_pid, 'requestId': lease['requestId'],
                'leaseSha256': hashlib.sha256(lease_raw.encode('utf-8')).hexdigest()}
    if any(type(payload[k]) is not type(v) or payload[k] != v for k, v in expected.items()):
        raise OwnerProofError('Owner proof rebound to a different lease or host')
    issued = _clock(payload['issuedAtMs'])
    expires = _clock(payload['expiresAtMs'])
    now = _clock(now_ms if now_ms is not None else time.time_ns()//1000000)
    if not 0 < expires-issued <= TTL_MS or issued > now+250 or now >= expires:
        raise OwnerProofError('Owner proof expired or clock invalid')
    permitted = _validate_owner(payload['owner'])
    owner = payload['owner']
    if (owner['pid'] != lease['pid']
            or owner['expectedStartedFileTime'] != lease['startedFileTime']):
        raise OwnerProofError('Owner observation does not match lease identity')
    # Same-PID reloads remain blocked even if a caller fabricates a signed
    # absent observation. A strong different birth may describe PID reuse.
    if lease['pid'] == host_pid and owner['state'] != 'replaced':
        permitted = False
    return {'recoveryPermitted': permitted, 'owner': owner,
            'leaseSha256': payload['leaseSha256'], 'expiresAtMs': expires}

