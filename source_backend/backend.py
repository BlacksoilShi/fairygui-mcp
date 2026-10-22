"""Explicit independent-editor backend contract. No native-editor execution.

CLI: FGUI_MCP_CONFIG=/absolute/config.json python backend.py COMMAND JSON_ARGS
Optional HTTP adapter shipped with fairygui-mcp; the editor service is external.
"""
from pathlib import Path
import hashlib
import http.client
import json
import math
import os
import re
import secrets
import sys
import tempfile
import time
from urllib.parse import urlencode

CONTRACT = 'fgui-rebuild-http/1'
MAX_INPUT = 60 * 1024
MAX_HTTP = 8 * 1024 * 1024
MAX_OUTPUT = 60 * 1024
MAX_PAGE_CHARACTERS = 65536
DEFAULT_PAGE_CHARACTERS = MAX_PAGE_CHARACTERS
STORE_BUDGET = 64 * 1024 * 1024
MAX_RECEIPTS = 256
MAX_LEDGER_DEPTH = 36  # HTTP depth32 plus internal response/record envelopes.
SNAPSHOT_TTL = 120
MAX_SNAPSHOTS = 8
SNAPSHOT_BUDGET = 32 * 1024 * 1024
REQUEST_ID = re.compile(r'^[a-f0-9]{32}$')


class BackendError(Exception):
    def __init__(self, code, message, **details):
        super().__init__(message)
        self.code, self.details = code, details


def encode(value):
    try:
        return json.dumps(value, ensure_ascii=False, allow_nan=False,
                          separators=(',', ':')).encode('utf-8')
    except (ValueError, TypeError, UnicodeError, RecursionError) as e:
        raise BackendError('INVALID_JSON', 'JSON value is invalid') from e


def decode(raw, limit=MAX_INPUT, *, max_depth=32):
    if len(raw) > limit:
        raise BackendError('INPUT_LIMIT', 'JSON byte bound exceeded')
    def pairs(items):
        result = {}
        for k, v in items:
            if k in result:
                raise ValueError('duplicate')
            result[k] = v
        return result
    try:
        value = json.loads(raw.decode('utf-8'), object_pairs_hook=pairs,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        pending = [(value, 0)]
        while pending:
            item, depth = pending.pop()
            if depth > max_depth or (isinstance(item, float) and not math.isfinite(item)):
                raise ValueError('bound')
            if isinstance(item, dict):
                pending.extend((v, depth + 1) for v in item.values())
            elif isinstance(item, list):
                pending.extend((v, depth + 1) for v in item)
        encode(value)  # Reject unpaired Unicode surrogates before HTTP/file writes.
        return value
    except (ValueError, UnicodeError, RecursionError) as e:
        raise BackendError('INVALID_JSON', 'Invalid, duplicate, nonfinite or deeply nested JSON') from e


def fields(value, allowed, required=()):
    if not isinstance(value, dict) or set(value) - set(allowed) or set(required) - set(value):
        raise BackendError('INVALID_ARGUMENTS', 'Unexpected or missing fields')


def selector(value):
    if value is not None and (not isinstance(value, str) or not value or
                              len(value) > 256 or any(ord(c) < 32 for c in value)):
        raise BackendError('INVALID_ARGUMENTS', 'Selector must be null or a bounded nonempty name/ID')
    return value


class StoreLock:
    """OS-released lock; a crashed process does not leave a permanent lock."""
    def __init__(self, directory):
        self.path = directory / '.ledger.lock'
    def __enter__(self):
        self.file = self.path.open('a+b')
        if self.file.seek(0, 2) == 0:
            self.file.write(b'0'); self.file.flush()
        self.file.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as e:
            self.file.close()
            raise BackendError('RECEIPT_STORE_BUSY', 'Receipt admission is busy; no command admitted') from e
        return self
    def __exit__(self, *args):
        try:
            self.file.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(self.file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.file.fileno(), fcntl.LOCK_UN)
        finally:
            self.file.close()


class Backend:
    def __init__(self, config):
        fields(config, ('contract', 'projectPath', 'port', 'token', 'receiptDir', 'timeoutSeconds', 'uploadRoots', 'browserPreview'),
               ('contract', 'projectPath', 'port', 'token', 'receiptDir'))
        if config['contract'] != CONTRACT:
            raise BackendError('CONFIG_INVALID', 'Unsupported backend contract')
        if type(config['port']) is not int or not 1024 <= config['port'] <= 65535:
            raise BackendError('CONFIG_INVALID', 'Expected a fixed nonprivileged loopback port')
        token = config['token']
        if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{32,256}', token):
            raise BackendError('CONFIG_INVALID', 'Expected a bounded private Bearer token')
        paths = []
        for key in ('projectPath', 'receiptDir'):
            if not isinstance(config[key], str) or not Path(config[key]).is_absolute():
                raise BackendError('CONFIG_INVALID', 'Expected absolute project and receipt paths')
            paths.append(Path(config[key]).resolve())
        self.project, self.directory = paths
        if not self.project.is_file() or self.project.suffix.lower() != '.fairy':
            raise BackendError('CONFIG_INVALID', 'Pin one existing .fairy project file')
        root = self.project.parent
        if self.directory.is_relative_to(root) or root.is_relative_to(self.directory):
            raise BackendError('CONFIG_INVALID', 'Receipts and source must be separate trees')
        timeout = config.get('timeoutSeconds', 15)
        if type(timeout) is not int or not 1 <= timeout <= 120:
            raise BackendError('CONFIG_INVALID', 'Timeout must be an integer from1 to120')
        self.port, self.token, self.timeout = config['port'], token, timeout
        from sound_upload import roots
        self.upload_roots = roots(config.get('uploadRoots', []), BackendError)
        self.directory.mkdir(parents=True, exist_ok=True)
        from preview_jobs import configure
        self.browser_preview = configure(config.get('browserPreview'), self.project, self.directory, BackendError)

    def http(self, method, route, body=None, *, binary=None):
        raw = None if body is None else encode(body)
        if raw is not None and len(raw) > MAX_INPUT:
            raise BackendError('INPUT_LIMIT', 'Command exceeds backend byte bound')
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=self.timeout)
        try:
            headers = {'Authorization': 'Bearer ' + self.token, 'Accept': 'application/json'}
            if raw is not None:
                headers['Content-Type'] = 'application/json'
            if binary is None:
                conn.request(method, route, body=raw, headers=headers)
            else:
                headers.update({'Content-Type': 'application/octet-stream', 'Content-Length': str(binary['bytes']),
                                'X-FGUI-Session': binary['session'], 'X-FGUI-Revision': str(binary['revision']),
                                'X-Content-SHA256': binary['sha256']})
                conn.request(method, route, body=binary['stream'], headers=headers)
                binary['stream'].verify()
            response = conn.getresponse()
            lengths = response.headers.get_all('Content-Length')
            if response.headers.get_all('Transfer-Encoding') is not None or not lengths or len(lengths) != 1 or not re.fullmatch(r'[0-9]{1,9}', lengths[0]):
                raise BackendError('BACKEND_PROTOCOL', 'Expected bounded fixed-length HTTP response')
            length = int(lengths[0])
            if length > MAX_HTTP:
                raise BackendError('BACKEND_RESPONSE_LIMIT', 'Editor response exceeds8MiB')
            if response.headers.get_content_type() != 'application/json':
                raise BackendError('BACKEND_PROTOCOL', 'Expected JSON response')
            data = response.read(length + 1)
            if len(data) != length:
                raise BackendError('BACKEND_PROTOCOL', 'Incomplete or excess HTTP body')
            value = decode(data, MAX_HTTP)
            if (not isinstance(value, dict) or type(value.get('ok')) is not bool or
                type(value.get('revision')) is not int or value['revision'] < 0 or
                not isinstance(value.get('session'), str) or
                not re.fullmatch(r'[A-Za-z0-9_-]{16,128}', value['session'])):
                raise BackendError('BACKEND_PROTOCOL', 'Invalid editor response envelope')
            if (200 <= response.status < 300) != value['ok']:
                raise BackendError('BACKEND_PROTOCOL', 'HTTP/envelope status mismatch')
            if value['ok'] and 'result' not in value:
                raise BackendError('BACKEND_PROTOCOL', 'Missing result')
            if not value['ok'] and not isinstance(value.get('error'), dict):
                raise BackendError('BACKEND_PROTOCOL', 'Missing structured error')
            return value
        except (OSError, http.client.HTTPException) as e:
            # Do not echo URLs, tokens or low-level request material.
            raise BackendError('BACKEND_UNREACHABLE', 'Configured independent editor request failed') from e
        finally:
            conn.close()

    def state(self, package=None, component=None):
        selector(package); selector(component)
        query = urlencode({k: v for k, v in [('package', package), ('component', component)] if v is not None})
        value = self.http('GET', '/api/state' + ('?' + query if query else ''))
        return self.identity(value)

    def metadata(self):
        value = self.http('GET', '/api/capabilities')
        self.identity(value)
        if value['ok'] and value['result'].get('metadataProtocol') != 'fgui-rebuild-metadata/1':
            raise BackendError('BACKEND_PROTOCOL', 'Expected scene-independent metadata protocol')
        if value['ok'] and not isinstance(value['result'].get('limits'), dict):
            raise BackendError('BACKEND_PROTOCOL', 'Expected metadata limits object')
        return value

    def identity(self, value):
        if value['ok']:
            try:
                actual = value['result']['project']['path']
                if not isinstance(actual, str) or Path(actual).resolve() != self.project:
                    raise ValueError()
                caps = value['result']['capabilities']
                if not isinstance(caps, dict) or caps.get('independentEditor') is not True or caps.get('nativeEditor') is not False:
                    raise ValueError()
                operations = caps.get('operations')
                if (not isinstance(operations, list) or not 1 <= len(operations) <= 256 or
                    any(not isinstance(op, str) or not re.fullmatch(r'[a-z][a-z0-9_]{0,63}', op) for op in operations) or
                    len(set(operations)) != len(operations)):
                    raise ValueError()
            except (KeyError, TypeError, ValueError, OSError) as e:
                raise BackendError('PROJECT_MISMATCH', 'Configured project identity or execution layer differs') from e
        return value

    def wrap(self, value, **extra):
        return dict(contract=CONTRACT, layer='independent-source-http', nativeEditorExecuted=False,
                    **value, **extra)

    def atomic(self, path, value):
        raw = encode(value)
        fd, temp = tempfile.mkstemp(dir=self.directory, prefix='.write-')
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(raw); stream.flush(); os.fsync(stream.fileno())
            os.replace(temp, path)
        finally:
            if os.path.exists(temp): os.unlink(temp)

    def id(self, value):
        if not isinstance(value, str) or not REQUEST_ID.fullmatch(value):
            raise BackendError('INVALID_ARGUMENTS', 'requestId must be32 lowercase hexadecimal characters')
        return value

    def admission(self, rid, digest):
        path = self.directory / (rid + '.json')
        with StoreLock(self.directory):
            if path.exists():
                record = decode(path.read_bytes(), MAX_HTTP + 65536, max_depth=MAX_LEDGER_DEPTH)
                if record.get('inputSha256') != digest:
                    raise BackendError('REQUEST_ID_CONFLICT', 'requestId already binds different arguments')
                if record.get('state') == 'done':
                    return record['response']
                raise BackendError('OUTCOME_UNKNOWN', 'Admitted command has no complete receipt; inspect editor state, do not replay', requestId=rid)
            existing = list(self.directory.glob('*.json'))
            reserved = 0
            for file in existing:
                if not REQUEST_ID.fullmatch(file.stem):
                    raise BackendError('RECEIPT_STORE_INVALID', 'Unexpected ledger JSON file')
                old = decode(file.read_bytes(), MAX_HTTP + 65536, max_depth=MAX_LEDGER_DEPTH)
                reserved += file.stat().st_size if old.get('state') == 'done' else MAX_HTTP + 65536
            if len(existing) >= MAX_RECEIPTS or reserved + MAX_HTTP + 65536 > STORE_BUDGET:
                raise BackendError('RECEIPT_STORE_FULL', 'Receipt capacity exhausted before dispatch')
            self.atomic(path, dict(state='pending', inputSha256=digest))
            return None

    def deliver(self, response, rid):
        # A large post-mutation receipt is durable and retrievable, never discarded.
        if len(encode(response)) <= MAX_OUTPUT:
            return response
        raw = encode(response)
        return self.wrap(dict(ok=True, result=dict(receiptOnly=True, requestId=rid,
                         utf8Bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest(),
                         readWith='source_receipt_read', operationOk=response['ok'])), requestId=rid)

    def command(self, args):
        fields(args, ('requestId', 'session', 'expectedRevision', 'package', 'component', 'operation', 'args'),
               ('requestId', 'session', 'expectedRevision', 'package', 'component', 'operation', 'args'))
        rid = self.id(args['requestId'])
        if not isinstance(args['session'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,128}', args['session']):
            raise BackendError('INVALID_ARGUMENTS', 'Expected explicit editor session')
        if type(args['expectedRevision']) is not int or args['expectedRevision'] < 0:
            raise BackendError('INVALID_ARGUMENTS', 'Expected explicit nonnegative integer revision')
        selector(args['package']); selector(args['component'])
        if not isinstance(args['operation'], str) or not re.fullmatch(r'[a-z][a-z0-9_]{0,63}', args['operation']) or not isinstance(args['args'], dict):
            raise BackendError('INVALID_ARGUMENTS', 'Expected advertised operation and object arguments')
        raw = encode(args)
        if len(raw) > MAX_INPUT:
            raise BackendError('INPUT_LIMIT', 'Command exceeds backend byte bound')
        digest = hashlib.sha256(json.dumps(dict(projectPath=str(self.project), request=args),
                                sort_keys=True, ensure_ascii=False, allow_nan=False,
                                separators=(',', ':')).encode('utf-8')).hexdigest()
        previous = self.admission(rid, digest)
        if previous is not None:
            return self.deliver(previous, rid)
        dispatched = False
        try:
            state = self.metadata()
            if not state['ok']:
                response = self.wrap(state, requestId=rid, dispatchAttempted=False)
            elif state['session'] != args['session']:
                raise BackendError('SESSION_CONFLICT', 'Observed independent editor session changed')
            elif args['operation'] not in state['result']['capabilities']['operations']:
                raise BackendError('UNKNOWN_OPERATION', 'Operation is not advertised by this backend')
            else:
                body = {k: v for k, v in args.items() if k != 'requestId'}
                # Never repeat this POST on timeout, disconnect or parse failure.
                dispatched = True
                response = self.wrap(self.http('POST', '/api/command', body), requestId=rid, dispatchAttempted=True)
        except BackendError as error:
            response = self.wrap(dict(ok=False, error=dict(code='OUTCOME_UNKNOWN' if dispatched else error.code,
                                      message='Command dispatch outcome is unconfirmed; inspect fresh state and receipt' if dispatched else str(error),
                                      cause=error.code, **error.details)), requestId=rid, dispatchAttempted=dispatched)
        try:
            self.atomic(self.directory / (rid + '.json'), dict(state='done', inputSha256=digest, response=response))
        except OSError as error:
            raise BackendError('OUTCOME_UNKNOWN', 'Receipt persistence failed after admission; inspect editor state', requestId=rid) from error
        return self.deliver(response, rid)

    def execute(self, command, args):
        encode(args)
        if command == 'source_preview':
            from preview_jobs import Jobs
            return Jobs(self, BackendError).execute(args)
        if command == 'source_operation_schema':
            from operation_schemas import query
            return query(self, args, BackendError)
        if command == 'source_sound_upload':
            from sound_upload import execute
            return execute(self, args, BackendError)
        if command == 'source_command':
            return self.command(args)
        if command == 'source_receipt_read':
            fields(args, ('requestId', 'offset', 'limit'), ('requestId',))
            rid = self.id(args['requestId']); offset = args.get('offset', 0); limit = args.get('limit', DEFAULT_PAGE_CHARACTERS)
            if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= MAX_PAGE_CHARACTERS:
                raise BackendError('INVALID_ARGUMENTS', 'Expected Unicode offset and1..65536 character limit')
            path = self.directory / (rid + '.json')
            if not path.is_file(): raise BackendError('RECEIPT_NOT_FOUND', 'No receipt for requestId')
            record = decode(path.read_bytes(), MAX_HTTP + 65536, max_depth=MAX_LEDGER_DEPTH)
            if record.get('state') != 'done':
                raise BackendError('OUTCOME_UNKNOWN', 'Admitted command has no complete receipt', requestId=rid)
            raw = encode(record['response']); text = raw.decode('utf-8')
            if offset > len(text): raise BackendError('INVALID_ARGUMENTS', 'Offset exceeds receipt length')
            digest = hashlib.sha256(raw).hexdigest()
            return self.byte_page(text, offset, limit, lambda end: self.wrap(dict(ok=True,
                    result=dict(requestId=rid, text=text[offset:end], offset=offset,
                    nextOffset=end if end < len(text) else None, unicodeCharacters=len(text),
                    utf8Bytes=len(raw), sha256=digest, requestedCharacterLimit=limit,
                    pageCharacters=end-offset, helperJSONByteLimit=MAX_OUTPUT))))
        if command in ('source_state', 'source_capabilities'):
            if command == 'source_state' and isinstance(args, dict) and 'snapshotId' in args:
                return self.snapshot_read(args)
            fields(args, ('package', 'component', 'snapshot') if command == 'source_state' else ())
            if 'snapshot' in args and type(args['snapshot']) is not bool:
                raise BackendError('INVALID_ARGUMENTS', 'snapshot requires an explicit boolean')
            value = self.metadata() if command == 'source_capabilities' else self.state(**{k:v for k,v in args.items() if k != 'snapshot'})
            if command == 'source_state' and not value['ok'] and value.get('error', {}).get('code') == 'response_limit':
                from upstream_snapshots import create as upstream_create
                return upstream_create(self, {k:v for k,v in args.items() if k != 'snapshot'})
            if value['ok'] and command == 'source_capabilities':
                value = dict(value, result=dict(metadataProtocol=value['result']['metadataProtocol'],
                                               capabilities=value['result']['capabilities'],
                                               limits=value['result']['limits'], backendContract=CONTRACT,
                                               adapter=dict(stateSnapshots=True, automaticLargeStateSnapshot=True,
                                               snapshotTTLSeconds=SNAPSHOT_TTL, snapshotLimit=MAX_SNAPSHOTS,
                                               snapshotBytes=SNAPSHOT_BUDGET, pageCharacters=MAX_PAGE_CHARACTERS,
                                               defaultPageCharacters=DEFAULT_PAGE_CHARACTERS, helperJSONBytes=MAX_OUTPUT,
                                               httpJSONDepth=32, ledgerJSONDepth=MAX_LEDGER_DEPTH,
                                               upstreamStateSnapshots=True, upstreamSnapshotTTLSeconds=600,
                                               upstreamSnapshotUTF8Bytes=32*1024*1024,
                                               upstreamPointerCount=8, upstreamPageJSONBytes=58*1024,
                                               soundFileUploads=bool(self.upload_roots), soundUploadMaximumBytes=64*1024*1024,
                                               soundUploadRootCount=len(self.upload_roots), soundUploadNoAutomaticRetry=True)))
            result = self.wrap(value)
            if command == 'source_state' and value['ok'] and (args.get('snapshot') is True or len(encode(result)) > MAX_OUTPUT):
                result = self.snapshot_create(result)
            if len(encode(result)) > MAX_OUTPUT:
                raise BackendError('RESPONSE_LIMIT', 'Backend response metadata exceeds60KiB')
            return result
        raise BackendError('UNKNOWN_COMMAND', 'Unknown independent-backend contract command')

    def snapshot_directory(self):
        directory = self.directory / 'snapshots'
        directory.mkdir(exist_ok=True)
        if not directory.resolve().is_relative_to(self.directory.resolve()):
            raise BackendError('SNAPSHOT_STORE_INVALID', 'Snapshot cache boundary differs')
        return directory

    def snapshot_record(self, path):
        if path.stat().st_size > MAX_HTTP + 65536:
            raise BackendError('SNAPSHOT_STORE_INVALID', 'Snapshot record exceeds byte bound')
        record = decode(path.read_bytes(), MAX_HTTP + 65536, max_depth=MAX_LEDGER_DEPTH)
        if (not isinstance(record, dict) or record.get('projectPath') != str(self.project) or
            type(record.get('expiresAtMs')) is not int or not isinstance(record.get('response'), dict) or
            not isinstance(record.get('sha256'), str)):
            raise BackendError('SNAPSHOT_STORE_INVALID', 'Snapshot metadata differs from configured project')
        raw = encode(record['response'])
        if hashlib.sha256(raw).hexdigest() != record['sha256']:
            raise BackendError('SNAPSHOT_STORE_INVALID', 'Snapshot content hash changed')
        return record, raw

    def snapshot_pointer(self, identifier, record, raw, **extra):
        value = record['response']
        return self.wrap(dict(ok=True, session=value['session'], revision=value['revision'],
                    result=dict(stateOnly=True, snapshotId=identifier,
                    readWith='source_state', startOffset=0,
                    capturedSession=value['session'], capturedRevision=value['revision'],
                    consistency='immutable-snapshot-not-current-state', live=False,
                    expiresAtMs=record['expiresAtMs'], sha256=record['sha256'],
                    utf8Bytes=len(raw), unicodeCharacters=len(raw.decode('utf-8')), **extra)))

    def snapshot_create(self, response):
        directory = self.snapshot_directory(); raw = encode(response)
        record = dict(projectPath=str(self.project), expiresAtMs=int(time.time()*1000)+SNAPSHOT_TTL*1000,
                      sha256=hashlib.sha256(raw).hexdigest(), response=response)
        data = encode(record)
        if len(data) > MAX_HTTP + 65536:
            raise BackendError('SNAPSHOT_STORE_FULL', 'Selected state exceeds snapshot byte bound')
        with StoreLock(directory):
            used = count = 0
            for path in directory.glob('*.json'):
                if not REQUEST_ID.fullmatch(path.stem) or not path.resolve().is_relative_to(directory.resolve()):
                    raise BackendError('SNAPSHOT_STORE_INVALID', 'Unexpected snapshot file')
                previous, _ = self.snapshot_record(path)
                if int(time.time()*1000) >= previous['expiresAtMs']:
                    path.unlink()  # Only expired owned snapshot files; never command tombstones.
                else:
                    count += 1; used += path.stat().st_size
            if count >= MAX_SNAPSHOTS or used + len(data) > SNAPSHOT_BUDGET:
                raise BackendError('SNAPSHOT_STORE_FULL', 'Snapshot capacity exhausted; no source change')
            identifier = secrets.token_hex(16)
            target = directory / (identifier + '.json')
            if target.exists() or (self.directory / 'upstream-snapshots' / (identifier + '.json')).exists():
                raise BackendError('SNAPSHOT_ID_CONFLICT', 'Generated snapshot identity already exists')
            self.atomic(target, record)
        return self.snapshot_pointer(identifier, record, raw)

    def snapshot_read(self, args):
        fields(args, ('snapshotId', 'offset', 'limit'), ('snapshotId',))
        identifier = self.id(args['snapshotId']); offset = args.get('offset', 0); limit = args.get('limit', DEFAULT_PAGE_CHARACTERS)
        if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= MAX_PAGE_CHARACTERS:
            raise BackendError('INVALID_ARGUMENTS', 'Expected Unicode offset and1..65536 character limit')
        if (self.directory / 'upstream-snapshots' / (identifier + '.json')).is_file():
            from upstream_snapshots import read as upstream_read
            return upstream_read(self, args)
        directory = self.snapshot_directory(); path = directory / (identifier + '.json')
        with StoreLock(directory):
            if not path.is_file():
                raise BackendError('SNAPSHOT_NOT_FOUND', 'Snapshot is absent; request a fresh state')
            record, raw = self.snapshot_record(path)
            if int(time.time()*1000) >= record['expiresAtMs']:
                raise BackendError('SNAPSHOT_EXPIRED', 'Snapshot expired; request a fresh state')
            text = raw.decode('utf-8')
            if offset > len(text):
                raise BackendError('INVALID_ARGUMENTS', 'Offset exceeds snapshot length')
            return self.byte_page(text, offset, limit, lambda end: self.snapshot_pointer(
                    identifier, record, raw, text=text[offset:end], offset=offset,
                    nextOffset=end if end < len(text) else None, requestedCharacterLimit=limit,
                    pageCharacters=end-offset, helperJSONByteLimit=MAX_OUTPUT))

    def byte_page(self, text, offset, limit, build):
        """Fit the entire encoded helper envelope, not only raw text bytes."""
        end = min(len(text), offset + limit)
        response = build(end)
        if len(encode(response)) <= MAX_OUTPUT:
            return response
        low, high = offset, end-1
        best = None
        while low <= high:
            middle = (low+high)//2
            response = build(middle)
            if len(encode(response)) <= MAX_OUTPUT:
                best = response; low = middle+1
            else:
                high = middle-1
        if best is None or (offset < len(text) and best['result']['pageCharacters'] == 0):
            raise BackendError('RESPONSE_LIMIT', 'Page metadata or one Unicode character exceeds helper byte bound')
        return best


def main():
    try:
        if len(sys.argv) != 3:
            raise BackendError('INVALID_ARGUMENTS', 'Expected COMMAND and JSON_ARGS')
        config = os.environ.get('FGUI_MCP_CONFIG')
        if not config or not Path(config).is_absolute():
            raise BackendError('CONFIG_INVALID', 'Set an absolute private backend config path')
        backend = Backend(decode(Path(config).read_bytes()))
        if sys.argv[1]=='source_preview' and sys.argv[2]=='--stdin-json':
            arguments=decode(sys.stdin.buffer.read(MAX_INPUT+1))
        else:
            arguments=decode(sys.argv[2].encode('utf-8'))
        value = backend.execute(sys.argv[1], arguments)
    except BackendError as e:
        value = dict(ok=False, contract=CONTRACT, layer='independent-source-http', nativeEditorExecuted=False,
                     error=dict(code=e.code, message=str(e), **e.details))
    except Exception:
        value = dict(ok=False, contract=CONTRACT, layer='independent-source-http', nativeEditorExecuted=False,
                     error=dict(code='BACKEND_FAILURE', message='Backend local operation failed; no automatic retry'))
    sys.stdout.buffer.write(encode(value) + b'\n'); sys.stdout.buffer.flush()
    return 0 if value['ok'] else 1


if __name__ == '__main__':
    sys.modules['backend'] = sys.modules[__name__]
    raise SystemExit(main())
