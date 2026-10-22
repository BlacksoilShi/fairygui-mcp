import hashlib,json,os,pathlib,sys,unittest,threading,time,ctypes
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))
from test_preview_jobs import Backend,Error
import preview_jobs as j
import tempfile
class MaintenanceTests(unittest.TestCase):
 def setUp(self):
  self.t=tempfile.TemporaryDirectory(dir=os.environ.get('FGUI_PREVIEW_TEST_ROOT'));self.addCleanup(self.t.cleanup);self.root=pathlib.Path(self.t.name);self.b=Backend(self.root);self.jobs=j.Jobs(self.b,Error)
 def record(self,state='completed'):
  p=self.jobs.path('e'*32);p.mkdir();r={'protocol':j.PROTOCOL,'kind':'preview','projectPath':str(self.b.project),'jobId':p.name,'state':state,'session':'s'*32,'revision':0,'requestDigest':'0'*64,'createdAtMs':j.now()-10000,'deadlineAtMs':j.now()-1000,'expiresAtMs':j.now()+10000,'phase':'terminal','worker':None,'node':None,'artifacts':[]};j.atomic(p/'state.json',r);return p,r
 def test_empty_inspection(self):
  v=self.jobs.execute({'action':'inspect'})['result'];self.assertEqual(v['active'],0);self.assertEqual(v['retained'],0);self.assertEqual(v['limits']['active'],2)
 def test_inspect_has_no_private_config(self):
  p,r=self.record();v=self.jobs.execute({'action':'inspect'})['result'];self.assertEqual(v['retained'],1);self.assertNotIn(self.b.token,json.dumps(v));self.assertNotIn('projectPath',v['jobs'][0])
 def test_cleanup_refuses_live_worker(self):
  p,r=self.record('running');r['worker']=j.identity(os.getpid());j.atomic(p/'state.json',r)
  with self.assertRaises(Error) as e:self.jobs.execute({'action':'cleanup','jobId':p.name})
  self.assertEqual(e.exception.code,'PREVIEW_BUSY')
 def test_unbound_profile_preserved(self):
  p,r=self.record('interrupted');(p/'browser-profile').mkdir();(p/'browser-profile/user.txt').write_bytes(b'keep')
  with self.assertRaises(Error) as e:self.jobs.execute({'action':'cleanup','jobId':p.name})
  self.assertEqual(e.exception.code,'PREVIEW_OWNERSHIP');self.assertEqual((p/'browser-profile/user.txt').read_bytes(),b'keep')
 def test_bound_cleanup_does_not_claim_remote_zero(self):
  p,r=self.record('interrupted');profile=p/'browser-profile';profile.mkdir();(profile/'cache').write_bytes(b'owned')
  marker=p/'browser-owner.json';j.atomic(marker,{'protocol':'fgui-browser-preview-host/1','owner':'a'*48,'profile':str(profile)});r.update(containment='win32-kill-on-close/1',browserMarkerSHA256=j.sha_file(marker),ownedProcesses=[],cleanupConfirmed=False);j.atomic(p/'state.json',r)
  v=self.jobs.execute({'action':'cleanup','jobId':p.name})['result'];self.assertTrue(v['localCleanup']);self.assertFalse(v['remoteCleanupConfirmed']);self.assertFalse(profile.exists())
 def test_changed_marker_preserved(self):
  p,r=self.record('interrupted');(p/'browser-profile').mkdir();marker=p/'browser-owner.json';marker.write_bytes(b'changed');r.update(containment='win32-kill-on-close/1',browserMarkerSHA256='0'*64);j.atomic(p/'state.json',r)
  with self.assertRaises(Error):self.jobs.execute({'action':'cleanup','jobId':p.name})
  self.assertTrue((p/'browser-profile').exists())
 def test_cleanup_keeps_unknown_root_files(self):
  p,r=self.record();(p/'user.txt').write_bytes(b'keep');self.jobs.execute({'action':'cleanup','jobId':p.name});self.assertEqual((p/'user.txt').read_bytes(),b'keep')
 def test_inspect_rejects_unknown_fields(self):
  with self.assertRaises(Error):self.jobs.execute({'action':'inspect','jobId':'e'*32})
 def test_shared_reader_and_replacements(self):
  p=self.root/'shared.json';j.atomic(p,{'n':0});fail=[]
  def reader():
   try:
    for _ in range(200):self.assertIn('n',j.load(p))
   except Exception as e:fail.append(e)
  t=threading.Thread(target=reader);t.start()
  for i in range(50):j.atomic(p,{'n':i})
  t.join(3);self.assertFalse(t.is_alive());self.assertEqual(fail,[])
 def test_external_nondelete_handle_retried(self):
  if os.name!='nt':self.skipTest('Windows sharing mode execution')
  from ctypes import wintypes as W
  p=self.root/'locked.json';j.atomic(p,{'n':0});k=ctypes.WinDLL('kernel32',use_last_error=True);k.CreateFileW.argtypes=[W.LPCWSTR,W.DWORD,W.DWORD,ctypes.c_void_p,W.DWORD,W.DWORD,W.HANDLE];k.CreateFileW.restype=W.HANDLE;k.CloseHandle.argtypes=[W.HANDLE]
  h=k.CreateFileW(str(p),0x80000000,3,None,3,0x80,None);self.assertNotEqual(h,W.HANDLE(-1).value);fail=[]
  def writer():
   try:j.atomic(p,{'n':1})
   except Exception as e:fail.append(e)
  t=threading.Thread(target=writer);t.start();time.sleep(.05);k.CloseHandle(h);t.join(3);self.assertFalse(t.is_alive());self.assertEqual(fail,[]);self.assertEqual(j.load(p),{'n':1})
if __name__=='__main__':unittest.main()
