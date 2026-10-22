"""Diagnostics uses a fake HTTP response here; real stdio/live checks are separate."""
import copy,hashlib,io,json,os,sys,tempfile,time,unittest,urllib.error
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from helper import Helper
import diagnostics as d

class Response:
    status=200
    def __init__(self,raw,status=200):self.raw=raw;self.status=status
    def __enter__(self):return self
    def __exit__(self,*a):pass
    def read(self,n):return self.raw[:n]

class Client:
    def __init__(self,test,mutate=None,error=None,raw=None,status=200):
        self.test=test;self.mutate=mutate;self.error=error;self.raw=raw;self.status=status;self.calls=[]
    def open(self,request,timeout):
        self.calls.append((request,timeout))
        if self.error:raise self.error
        args=json.loads(request.data);value=dict(ok=True,requestId=args['requestId'],sessionId='native-test-session',revision=3,data=dict(ready=True,busy=False,version='0.6.0',revision=3,sessionId='native-test-session',projectPath=str(self.test.project),updatedAtMs=self.test.now))
        if self.mutate:self.mutate(value)
        return Response(self.raw if self.raw is not None else json.dumps(value).encode(),self.status)

class DiagnosticsTests(unittest.TestCase):
    def setUp(self):
        work=Path(os.environ.get('FGUI_DIAGNOSTICS_WORK',ROOT/'tests/tmp'));work.mkdir(parents=True,exist_ok=True)
        self.tmp=tempfile.TemporaryDirectory(dir=work);self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.project=self.root/'project';self.project.mkdir();(self.project/'demo.fairy').write_text('{}')
        self.config=self.root/'config.json';self.token='secret'+'x'*58
        self.cfg=dict(projectPath=str(self.project),editorPath=str(ROOT/'helper.py'),python=sys.executable,host='127.0.0.1',port=17933,token=self.token,publishDir=str(self.root/'published'),screenshotDir=str(self.root/'screens'))
        self.config.write_text(json.dumps(self.cfg));self.h=Helper(self.config);self.h.install();self.now=1000000
    def result(self,**kw):return d.diagnose(self.h,opener=Client(self,**kw),now_ms=self.now)
    def state(self,**kw):
        p=self.root/'state/editor-start.json';p.parent.mkdir(exist_ok=True);p.write_text(json.dumps(dict(pid=123,processCreationTime=99,projectPath=str(self.project),**kw)));return p
    def test_connected_identity_and_no_source_probe(self):
        c=Client(self);r=d.diagnose(self.h,opener=c,now_ms=self.now)
        self.assertTrue(r['ready']);self.assertEqual(r['connection']['revision'],3);self.assertTrue(r['plugin']['matches'])
        request,timeout=c.calls[0];self.assertEqual(timeout,2);self.assertEqual(request.full_url,'http://127.0.0.1:17933/');self.assertEqual(json.loads(request.data)['cmd'],'ping')
        self.assertFalse(r['execution']['sourceBackendProbed'])
    def test_no_mutation_or_auto_start_or_install(self):
        before={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in self.root.rglob('*') if p.is_file()}
        with patch.object(self.h,'start',side_effect=AssertionError('No launch')),patch.object(self.h,'install',side_effect=AssertionError('No install')):
            self.result()
        self.assertEqual(before,{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in self.root.rglob('*') if p.is_file()})
    def test_credential_not_returned(self):
        raw=json.dumps(self.result());self.assertNotIn(self.token,raw);self.assertNotIn(hashlib.sha256(self.token.encode()).hexdigest(),raw)
    def test_closed_port_classified(self):self.assertEqual(self.result(error=urllib.error.URLError(ConnectionRefusedError()))['connection']['status'],'endpoint_unreachable')
    def test_direct_timeout_classified(self):self.assertEqual(self.result(error=TimeoutError())['connection']['status'],'timeout')
    def test_url_timeout_classified(self):self.assertEqual(self.result(error=urllib.error.URLError(TimeoutError()))['connection']['status'],'timeout')
    def test_auth401(self):self.assertEqual(self.result(error=urllib.error.HTTPError('x',401,'',{},None))['connection']['status'],'authentication_rejected')
    def test_auth403(self):self.assertEqual(self.result(error=urllib.error.HTTPError('x',403,'',{},None))['connection']['status'],'authentication_rejected')
    def test_redirect(self):self.assertEqual(self.result(error=urllib.error.HTTPError('x',302,'',{},None))['connection']['status'],'redirect_rejected')
    def test_http_error(self):self.assertEqual(self.result(error=urllib.error.HTTPError('x',500,'',{},None))['connection']['httpStatus'],500)
    def test_bad_json(self):self.assertEqual(self.result(raw=b'not JSON')['connection']['status'],'invalid_response')
    def test_duplicate_json(self):self.assertEqual(self.result(raw=b'{"ok":true,"ok":false}')['connection']['status'],'invalid_response')
    def test_array_json(self):self.assertEqual(self.result(raw=b'[]')['connection']['status'],'invalid_response')
    def test_response_limit(self):self.assertEqual(self.result(raw=b'x'*65537)['connection']['status'],'response_limit')
    def test_request_identity(self):self.assertEqual(self.result(mutate=lambda v:v.update(requestId='other'))['connection']['status'],'request_identity')
    def test_project_identity(self):self.assertEqual(self.result(mutate=lambda v:v['data'].update(projectPath=str(self.root/'other')))['connection']['status'],'project_identity')
    def test_session_identity(self):self.assertEqual(self.result(mutate=lambda v:v['data'].update(sessionId='other'))['connection']['status'],'session_identity')
    def test_stale_heartbeat(self):self.assertEqual(self.result(mutate=lambda v:v['data'].update(updatedAtMs=self.now-5001))['connection']['status'],'stale_heartbeat')
    def test_boolean_heartbeat_rejected(self):self.assertEqual(self.result(mutate=lambda v:v['data'].update(updatedAtMs=True))['connection']['status'],'stale_heartbeat')
    def test_not_ready(self):self.assertFalse(self.result(mutate=lambda v:v['data'].update(ready=False))['ready'])
    def test_boolean_revision_rejected(self):self.assertEqual(self.result(mutate=lambda v:v.update(revision=True))['connection']['status'],'invalid_revision')
    def test_unsafe_version_not_echoed(self):
        r=self.result(mutate=lambda v:v['data'].update(version='sensitive<>'));self.assertEqual(r['connection']['status'],'invalid_version');self.assertNotIn('sensitive',json.dumps(r))
    def test_bridge_error_no_raw_response_echo(self):
        r=self.result(mutate=lambda v:v.update(ok=False,error={'secret':self.token}));self.assertEqual(r['connection']['status'],'bridge_error');self.assertNotIn(self.token,json.dumps(r))
    def test_plugin_changed(self):
        (self.project/'plugins/fgui-agent-bridge-custom/main.js').write_text('different')
        r=self.result();self.assertEqual(r['plugin']['status'],'different');self.assertIn('review_plugin_before_explicit_update',r['recommendedActions'])
    def test_plugin_missing(self):
        import shutil
        shutil.rmtree(self.project/'plugins');self.assertEqual(self.result()['plugin']['status'],'missing')
    def test_private_config_mismatch_no_leak(self):
        p=self.project/'plugins/fgui-agent-bridge-custom/config.json';v=json.loads(p.read_text());v['token']='other-private-value';p.write_text(json.dumps(v));r=self.result()
        self.assertFalse(r['plugin']['privateConfigMatches']);self.assertNotIn('other-private-value',json.dumps(r))
    def test_plugin_artifact_bound(self):
        with patch.object(d,'FILE_LIMIT',1):self.assertEqual(self.result()['plugin']['status'],'invalid_or_unreadable')
    def test_project_count_bounded(self):
        (self.project/'two.fairy').write_text('{}');(self.project/'three.fairy').write_text('{}')
        self.assertEqual(self.result()['configuration']['projectFileCountBounded'],2)
    def test_owner_absent(self):self.assertEqual(self.result()['owner']['status'],'not_recorded')
    def test_owner_stopped(self):
        self.state();r=d.diagnose(self.h,opener=Client(self),process_reader=lambda p:None,now_ms=self.now);self.assertEqual(r['owner']['status'],'stopped')
    def test_owner_match(self):
        self.state();r=d.diagnose(self.h,opener=Client(self),process_reader=lambda p:dict(path=self.cfg['editorPath'],creationTime=99),now_ms=self.now);self.assertEqual(r['owner']['status'],'identity_match')
    def test_owner_birth_mismatch(self):
        self.state();r=d.diagnose(self.h,opener=Client(self),process_reader=lambda p:dict(path=self.cfg['editorPath'],creationTime=100),now_ms=self.now);self.assertEqual(r['owner']['status'],'identity_conflict')
    def test_owner_image_mismatch(self):
        self.state();r=d.diagnose(self.h,opener=Client(self),process_reader=lambda p:dict(path=str(self.root/'other.exe'),creationTime=99),now_ms=self.now);self.assertEqual(r['owner']['status'],'identity_conflict')
    def test_owner_invalid_record(self):
        p=self.state();p.write_text('[]');self.assertEqual(self.result()['owner']['status'],'invalid_record')
    def test_owner_boolean_pid(self):
        p=self.state();v=json.loads(p.read_text());v['pid']=True;p.write_text(json.dumps(v));self.assertEqual(self.result()['owner']['status'],'invalid_record')
    def test_offline_stopped_owner_suggests_explicit_start(self):
        self.state();r=d.diagnose(self.h,opener=Client(self,error=urllib.error.URLError('down')),process_reader=lambda p:None,now_ms=self.now);self.assertIn('explicit_start_available',r['recommendedActions']);self.assertFalse(r['execution']['editorStarted'])
if __name__=='__main__':unittest.main(verbosity=2)
