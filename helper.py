"""Portable Windows editor lifecycle and artifact checks. Python stdlib only.

No reconstruction sources, editor binaries, credentials or fixtures are shipped.
The optional source backend is dispatched separately by lib/core.mjs.
"""
from __future__ import annotations
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import struct
import subprocess
import sys
import time
import urllib.request
import uuid
import zlib

ROOT = Path(__file__).resolve().parent
MAX_BYTES = 65536

class HelperError(Exception):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)

def pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError('Duplicate JSON key')
        result[key] = value
    return result

def decode(raw):
    return json.loads(raw, object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Nonfinite JSON')))

def read_json(path):
    with Path(path).open('rb') as stream:
        data = stream.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError('JSON size limit')
    return decode(data.decode('utf8'))

def within(path, root):
    resolved = Path(path).resolve()
    if not resolved.is_relative_to(Path(root).resolve()):
        raise HelperError('PATH_SCOPE', 'Path resolves outside configured directory')
    return resolved

def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name('.' + path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with temp.open('x', encoding='utf8') as stream:
            json.dump(value, stream, ensure_ascii=False, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)

def current_process(pid):
    if os.name != 'nt' or type(pid) is not int or not 0 < pid < 2**32:
        return None
    from ctypes import wintypes as W
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.argtypes = [W.DWORD, W.BOOL, W.DWORD]
    kernel.OpenProcess.restype = W.HANDLE
    kernel.CloseHandle.argtypes = [W.HANDLE]
    kernel.QueryFullProcessImageNameW.argtypes = [W.HANDLE, W.DWORD, W.LPWSTR, ctypes.POINTER(W.DWORD)]
    kernel.GetProcessTimes.argtypes = [W.HANDLE] + [ctypes.POINTER(W.FILETIME)] * 4
    kernel.GetExitCodeProcess.argtypes = [W.HANDLE, ctypes.POINTER(W.DWORD)]
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        return None
    try:
        code = W.DWORD()
        if not kernel.GetExitCodeProcess(handle, ctypes.byref(code)) or code.value != 259:
            return None
        size, buf = W.DWORD(32768), ctypes.create_unicode_buffer(32768)
        if not kernel.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
            return None
        times = [W.FILETIME() for _ in range(4)]
        if not kernel.GetProcessTimes(handle, *[ctypes.byref(t) for t in times]):
            return None
        return {'path': buf.value, 'creationTime': (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime}
    finally:
        kernel.CloseHandle(handle)

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

class Helper:
    def __init__(self, config_path=None):
        self.config_path = Path(config_path or os.environ.get('FGUI_MCP_CONFIG') or ROOT/'config.json').resolve()
        self.work = self.config_path.parent
        self.cfg = read_json(self.config_path)
        required = {'projectPath', 'editorPath', 'python', 'host', 'port', 'token', 'publishDir', 'screenshotDir'}
        optional = {'node', 'sourceProject', 'sourceHelper', 'sourceConfig'}
        c = self.cfg
        if not isinstance(c, dict) or not required <= c.keys() or c.keys() - required - optional:
            raise ValueError('Invalid configuration fields')
        if c['host'] != '127.0.0.1' or type(c['port']) is not int or not 1024 <= c['port'] <= 65535:
            raise ValueError('Invalid loopback port')
        if not isinstance(c['token'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{32,256}', c['token']):
            raise ValueError('Invalid token format')
        for key in required - {'host', 'port', 'token'}:
            if not isinstance(c[key], str) or not Path(c[key]).is_absolute():
                raise ValueError('Absolute configured paths required')
        self.project = Path(c['projectPath']).resolve()
        self.publish = Path(c['publishDir']).resolve()
        screens = Path(c['screenshotDir']).resolve()
        if self.project == self.work or self.work.is_relative_to(self.project):
            raise ValueError('Keep runtime configuration outside the project')
        # The plugin currently confines outputs to siblings beneath project.parent.
        for output in [self.publish, screens]:
            within(output, self.project.parent)
            if output == self.project.parent or output.is_relative_to(self.project) or self.project.is_relative_to(output):
                raise ValueError('Outputs must not overlap project source')

    def ping(self):
        request_id = str(uuid.uuid4())
        body = {'cmd': 'ping', 'args': {}, 'requestId': request_id, 'deadlineMs': int(time.time()*1000)+2000}
        req = urllib.request.Request(f"http://127.0.0.1:{self.cfg['port']}/", data=json.dumps(body).encode(),
              headers={'Authorization': 'Bearer '+self.cfg['token'], 'Content-Type': 'application/json'})
        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
            with opener.open(req, timeout=2) as response:
                raw = response.read(MAX_BYTES+1)
            if len(raw) > MAX_BYTES:
                return None
            result = decode(raw.decode('utf8'))
            data = result.get('data', {})
            if result.get('ok') is not True or result.get('requestId') != request_id or data.get('ready') is not True:
                return None
            if Path(data.get('projectPath', '')).resolve() != self.project or not data.get('sessionId') or data['sessionId'] != result.get('sessionId'):
                return None
            if type(data.get('updatedAtMs')) is not int or abs(time.time()*1000-data['updatedAtMs']) > 5000:
                return None
            return data
        except (OSError, ValueError, TypeError, KeyError):
            return None

    def install(self):
        dest = within(self.project/'plugins/fgui-agent-bridge-custom', self.project)
        # Do not silently overwrite an unrelated plugin or private configuration.
        sources = {name: (ROOT/'plugin'/name).read_bytes() for name in ['main.js', 'package.json', 'LICENSE']}
        public_keys = ['projectPath', 'publishDir', 'screenshotDir', 'host', 'port', 'token']
        sources['config.json'] = (json.dumps({k: self.cfg[k] for k in public_keys}, indent=2)+'\n').encode()
        for name, raw in sources.items():
            target = within(dest/name, self.project)
            if target.exists() and target.read_bytes() != raw:
                raise HelperError('PLUGIN_CONFLICT', 'Existing plugin differs; back it up and review the update explicitly')
        dest.mkdir(parents=True, exist_ok=True)
        for name, raw in sources.items():
            target = dest/name
            if not target.exists():
                with target.open('xb') as stream:
                    stream.write(raw)
        return {'installed': True, 'directory': str(dest), 'files': list(sources), 'editorBinariesModified': False}

    def start(self):
        if os.name != 'nt':
            raise HelperError('PLATFORM_UNVERIFIED', 'Automatic startup is currently implemented for Windows only')
        heartbeat = self.ping()
        if heartbeat:
            return {'started': False, 'attached': True, 'ready': True, 'ping': heartbeat}
        state = within(self.work/'state', self.work)
        state.mkdir(exist_ok=True)
        lock = state/'editor-start.lock'
        try:
            fd = os.open(lock, os.O_CREAT|os.O_EXCL|os.O_WRONLY)
        except FileExistsError:
            raise HelperError('START_BUSY', 'Startup lock exists; inspect it rather than automatically retrying')
        os.close(fd)
        try:
            prior = state/'editor-start.json'
            if prior.is_file():
                old = read_json(prior)
                process = current_process(old.get('pid'))
                if process:
                    if Path(process['path']).resolve() != Path(self.cfg['editorPath']).resolve() or process['creationTime'] != old.get('processCreationTime') or old.get('projectPath') != str(self.project):
                        raise HelperError('PROCESS_IDENTITY', 'Recorded process identity differs; no duplicate launch')
                    return {'started': False, 'reused': True, 'pid': old['pid'], 'ready': False}
            with socket.socket() as sock:
                if sock.connect_ex(('127.0.0.1', self.cfg['port'])) == 0:
                    raise HelperError('PORT_BUSY', 'Configured port is occupied by an unverified bridge; no launch')
            projects = list(self.project.glob('*.fairy'))
            if len(projects) != 1:
                raise HelperError('PROJECT_INVALID', 'Project directory must contain exactly one .fairy file')
            within(projects[0], self.project)
            editor = Path(self.cfg['editorPath'])
            if not editor.is_file():
                raise HelperError('EDITOR_MISSING', 'Configured editor executable is missing')
            installed = self.install()
            logs = within(self.work/'logs'/str(time.time_ns()), self.work)
            logs.mkdir(parents=True)
            command = [str(editor), str(projects[0]), '-logFile', str(logs/'player.log')]
            startup = subprocess.STARTUPINFO()
            startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startup.wShowWindow = 4  # GUI remains visible, without a foreground request.
            with (logs/'stdout.txt').open('wb') as out, (logs/'stderr.txt').open('wb') as err:
                proc = subprocess.Popen(command, cwd=editor.parent, stdout=out, stderr=err, startupinfo=startup)
            process = current_process(proc.pid)
            write_json(prior, {'pid': proc.pid, 'processCreationTime': process['creationTime'] if process else None,
                       'projectPath': str(self.project), 'command': command, 'editorSha256': digest(editor)})
            deadline = time.monotonic()+30
            while time.monotonic() < deadline:
                if proc.poll() is not None:
                    raise HelperError('EDITOR_EXITED', 'Editor exited before the plugin became ready; inspect local logs')
                heartbeat = self.ping()
                if heartbeat:
                    return {'started': True, 'ready': True, 'pid': proc.pid, 'ping': heartbeat, 'plugin': installed}
                time.sleep(.2)
            return {'started': True, 'ready': False, 'pid': proc.pid, 'note': 'Readiness deadline elapsed; process left running, no automatic retry'}
        finally:
            lock.unlink(missing_ok=True)

    def verify_screenshot(self, args):
        if set(args) != {'path'} or not isinstance(args['path'], str):
            raise ValueError('Expected screenshot path')
        file = within(args['path'], self.cfg['screenshotDir'])
        if file.suffix.lower() != '.png' or not 57 <= file.stat().st_size <= 64*1024*1024:
            raise ValueError('PNG path or size invalid')
        raw = file.read_bytes()
        if raw[:8] != b'\x89PNG\r\n\x1a\n':
            raise ValueError('PNG signature')
        pos, chunks, payload, width, height, bands, finished = 8, 0, [], 0, 0, 0, False
        while pos < len(raw):
            if pos+12 > len(raw) or chunks > 10000:
                raise ValueError('PNG chunk bounds')
            length = struct.unpack_from('>I', raw, pos)[0]
            kind = raw[pos+4:pos+8]; end = pos+8+length
            if end+4 > len(raw):
                raise ValueError('PNG chunk length')
            data = raw[pos+8:end]
            if zlib.crc32(kind+data) & 0xffffffff != struct.unpack_from('>I', raw, end)[0]:
                raise ValueError('PNG CRC')
            if chunks == 0:
                if kind != b'IHDR' or length != 13:
                    raise ValueError('PNG header')
                width,height,depth,color,compression,filtering,interlace = struct.unpack('>IIBBBBB', data)
                if not 0 < width <= 4096 or not 0 < height <= 4096 or depth != 8 or color not in (2,6) or compression or filtering or interlace:
                    raise ValueError('Unsupported PNG profile')
                bands = 3 if color == 2 else 4
            elif kind == b'IHDR':
                raise ValueError('Duplicate PNG header')
            if kind == b'IDAT':payload.append(data)
            if kind == b'IEND':
                if length or end+4 != len(raw):raise ValueError('PNG end')
                finished = True
            pos = end+4; chunks += 1
        if not finished or not payload:raise ValueError('Incomplete PNG')
        expected = (width*bands+1)*height
        inflater = zlib.decompressobj()
        pixels = inflater.decompress(b''.join(payload),expected+1)
        if len(pixels) != expected or not inflater.eof or inflater.unused_data or inflater.unconsumed_tail:
            raise ValueError('PNG pixel stream bounds')
        if any(pixels[y*(width*bands+1)] > 4 for y in range(height)):
            raise ValueError('PNG filter code')
        return {'verified':True,'path':str(file),'width':width,'height':height,'bytes':len(raw),
                'sha256':hashlib.sha256(raw).hexdigest(),'scope':'PNG chunks/CRC, bounded decompression, dimensions and filter codes; not visual-content interpretation'}

    def verify_publish(self, args):
        if set(args) != {'pkg', 'startedAtMs'} or not isinstance(args['pkg'], str) or type(args['startedAtMs']) is not int:
            raise ValueError('Expected package and publication start timestamp')
        # Resolve ID/name through XML, with no demo-specific package or component IDs.
        import xml.etree.ElementTree as ET
        matches = []
        for package in (self.project/'assets').glob('*/package.xml'):
            within(package, self.project)
            if package.stat().st_size > 4*1024*1024:
                raise ValueError('Package XML size limit')
            raw = package.read_bytes()
            if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():
                raise ValueError('DTD is not supported')
            root = ET.fromstring(raw)
            if args['pkg'] in (package.parent.name, root.get('id')):
                matches.append((root.find('publish').get('name') if root.find('publish') is not None and root.find('publish').get('name') else package.parent.name, root.get('id')))
        if len(matches) != 1:
            raise HelperError('PACKAGE_IDENTITY', 'Expected one source package matching publish request')
        name, package_id = matches[0]
        rows = []
        total = 0
        for file in self.publish.rglob('*'):
            if not file.is_file():
                continue
            within(file, self.publish)
            if file.stem not in {name, name+'_fui'} or file.suffix.lower() not in {'.bytes', '.fui'}:
                continue
            stat = file.stat()
            total += stat.st_size
            if not 4 <= stat.st_size <= 64*1024*1024 or total > 128*1024*1024 or len(rows) >= 32:
                raise ValueError('Package artifact size/count limit')
            with file.open('rb') as stream:
                magic = stream.read(4)
                version = int.from_bytes(stream.read(4), 'big')
                compressed = stream.read(1)
                length = int.from_bytes(stream.read(2), 'big')
                actual_id = stream.read(length).decode('utf8') if 0 < length <= 256 else None
            if magic != b'FGUI' or version not in (6, 7) or compressed not in (b'\x00', b'\x01') or actual_id != package_id:
                continue
            if stat.st_mtime_ns//1000000 < args['startedAtMs']-2000:
                continue
            rows.append({'path': str(file), 'bytes': stat.st_size, 'sha256': digest(file), 'packageId': actual_id, 'formatVersion': version})
        if not rows:
            raise HelperError('PUBLISH_ARTIFACT_MISSING', 'No recent matching binary package found; native publication may already have run')
        return {'verified': True, 'artifacts': rows, 'semanticDecoded': False,
                'scope': 'Native success plus package name/ID, FGUI header/version, recent timestamp, size and SHA256; not full semantic equality'}

def main():
    helper = None
    try:
        if len(sys.argv) not in (2, 3):
            raise ValueError('Expected command and optional JSON object')
        args = decode(sys.argv[2]) if len(sys.argv) == 3 else {}
        if not isinstance(args, dict):
            raise ValueError('Arguments must be an object')
        command = sys.argv[1]
        if command not in {'start', 'install', 'verify_publish', 'verify_screenshot'} or (command not in {'verify_publish','verify_screenshot'} and args):
            raise ValueError('Unknown command or arguments')
        helper = Helper()
        result = getattr(helper, command)(args) if command in {'verify_publish','verify_screenshot'} else getattr(helper, command)()
        output, code = {'ok': True, 'result': result}, 0
    except HelperError as error:
        output, code = {'ok': False, 'error': {'code': error.code, 'message': str(error)}}, 1
    except Exception as error:
        output, code = {'ok': False, 'error': {'code': 'HELPER_INVALID', 'message': 'Local helper validation failed: '+type(error).__name__}}, 1
    raw = json.dumps(output, ensure_ascii=False, allow_nan=False)
    if helper:
        raw = raw.replace(helper.cfg['token'], '[redacted]')
    sys.stdout.buffer.write((raw+'\n').encode('utf8'))
    return code

if __name__ == '__main__':
    raise SystemExit(main())
