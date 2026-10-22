import hashlib,json,os,pathlib,sys,tempfile,time,unittest
from unittest import mock
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]))
import preview_jobs as j
class Error(Exception):
 def __init__(self,code,message,*args,**kwargs):self.code=code;super().__init__(message)
class Backend:
 def __init__(self,root):
  self.project=root/'project'/'test.fairy';self.project.parent.mkdir();self.project.write_bytes(b'<projectDescription/>');self.directory=root/'receipts';self.directory.mkdir();self.token='secret_'+'a'*32;self.port=12345
  self.browser_preview={'node':sys.executable,'playwrightModule':str(root),'browserExecutable':sys.executable,'jobDir':str(root/'jobs'),'timeoutMs':30000}
 def wrap(self,v):return v
 def metadata(self):return {'ok':True,'session':'s'*32,'revision':0,'result':{'capabilities':{'browserText':{'transport':'editor-session-challenge-receipt/1'}}}}
class Tests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(dir=os.environ.get('FGUI_PREVIEW_TEST_ROOT'));self.root=pathlib.Path(self.temp.name);self.b=Backend(self.root);self.jobs=j.Jobs(self.b,Error)
 def tearDown(self):self.temp.cleanup()
 def bad(self,args,code):
  with self.assertRaises(Error) as c:self.jobs.execute(args)
  self.assertEqual(c.exception.code,code)
 def record(self,identifier='a'*32,state='completed'):
  p=self.jobs.path(identifier);p.mkdir();r={'protocol':j.PROTOCOL,'kind':'preview','projectPath':str(self.b.project),'jobId':identifier,'state':state,'session':'s'*32,'revision':0,'requestDigest':'0'*64,'createdAtMs':j.now()-10000,'deadlineAtMs':j.now()+10000,'expiresAtMs':j.now()+60000,'phase':'terminal','worker':None,'node':None,'artifacts':[]};j.atomic(p/'state.json',r);return p,r
 def test_disabled(self):
  self.b.browser_preview=None
  with self.assertRaises(Error) as c:j.Jobs(self.b,Error)
  self.assertEqual(c.exception.code,'PREVIEW_DISABLED')
 def test_config_boundaries(self):
  c=self.b.browser_preview
  self.assertIsNone(j.configure(None,self.b.project,self.b.directory,Error))
  self.assertEqual(j.configure(c,self.b.project,self.b.directory,Error)['timeoutMs'],30000)
  for k,v in [('timeoutMs',True),('timeoutMs',999),('timeoutMs',120001),('jobDir',str(self.b.project.parent/'jobs')),('jobDir',str(self.b.directory/'jobs')),('node','relative'),('extra',True)]:
   with self.subTest(k=k,v=v),self.assertRaises(Error):j.configure(c|{k:v},self.b.project,self.b.directory,Error)
 def test_unowned_directory_preserved(self):
  other=self.root/'unowned';other.mkdir();(other/'user.txt').write_bytes(b'keep');self.b.browser_preview['jobDir']=str(other)
  with self.assertRaises(Error) as c:j.Jobs(self.b,Error)
  self.assertEqual(c.exception.code,'PREVIEW_STORE_OWNERSHIP');self.assertEqual((other/'user.txt').read_bytes(),b'keep')
 def test_argument_shapes(self):
  for value in [None,[],{}, {'action':'shell','jobId':'a'*32},{'action':'status','jobId':'../x'},{'action':'status','jobId':'A'*32},{'action':'status','jobId':'a'*32,'extra':1}]:self.bad(value,'INVALID_ARGUMENTS')
 def test_missing_and_idempotent_release(self):
  self.bad({'action':'status','jobId':'a'*32},'PREVIEW_NOT_FOUND');self.assertFalse(self.jobs.execute({'action':'release','jobId':'a'*32})['result']['existed'])
 def test_pending_read_and_release(self):
  p,r=self.record(state='running');r['createdAtMs']=j.now();r['worker']=j.identity(os.getpid());j.atomic(p/'state.json',r)
  self.bad({'action':'read','jobId':p.name},'PREVIEW_NOT_COMPLETE');self.bad({'action':'release','jobId':p.name},'PREVIEW_BUSY')
 def test_dead_worker_not_replayed(self):
  p,r=self.record(state='running');result=self.jobs.execute({'action':'status','jobId':p.name})['result'];self.assertEqual(result['state'],'interrupted');self.assertFalse(result['cleanupConfirmed'])
 def test_wrong_birth_not_alive(self):
  r=j.identity(os.getpid());self.assertTrue(j.alive(r));self.assertFalse(j.alive(r|{'birth':-1}))
 def test_job_record_mismatch(self):
  p,r=self.record();r['kind']='state-snapshot';j.atomic(p/'state.json',r);self.bad({'action':'status','jobId':p.name},'PREVIEW_STORE_INVALID')
 def test_expired(self):
  p,r=self.record();r['expiresAtMs']=j.now()-1;j.atomic(p/'state.json',r);self.bad({'action':'status','jobId':p.name},'PREVIEW_EXPIRED');self.assertTrue(self.jobs.execute({'action':'release','jobId':p.name})['result']['released'])
 def test_foreign_job_file_preserved(self):
  p,r=self.record();(p/'user.txt').write_bytes(b'keep');(p/'cv_debug.log').write_bytes(b'foreign root log');self.bad({'action':'release','jobId':p.name},'PREVIEW_FOREIGN_FILE');self.assertEqual((p/'user.txt').read_bytes(),b'keep');self.assertEqual((p/'cv_debug.log').read_bytes(),b'foreign root log')
 def test_unremoved_profile_preserved(self):
  p,r=self.record();(p/'browser-profile').mkdir();self.bad({'action':'release','jobId':p.name},'PREVIEW_CLEANUP_UNCONFIRMED')
 def test_known_artifacts(self):
  p,r=self.record();data='真实中文𐐀'.encode('utf-8');(p/'preview.json').write_bytes(data);r['artifacts']=[{'name':'preview.json','bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}];j.atomic(p/'state.json',r)
  first=self.jobs.execute({'action':'read','jobId':p.name,'limit':3})['result'];self.assertEqual(first['nextOffset'],3)
  import base64
  pieces=[base64.b64decode(first['data'])];offset=3
  while offset<len(data):
   v=self.jobs.execute({'action':'read','jobId':p.name,'offset':offset,'limit':3})['result'];pieces.append(base64.b64decode(v['data']));offset+=len(pieces[-1])
  self.assertEqual(b''.join(pieces),data)
  for extra in [{'artifact':'../input.json'},{'offset':True},{'offset':10000},{'limit':0},{'limit':16385}]:self.bad({'action':'read','jobId':p.name}|extra,'INVALID_ARGUMENTS')
 def test_changed_artifact(self):
  p,r=self.record();(p/'preview.json').write_bytes(b'changed');r['artifacts']=[{'name':'preview.json','bytes':7,'sha256':'0'*64}];j.atomic(p/'state.json',r);self.bad({'action':'read','jobId':p.name},'PREVIEW_ARTIFACT_CHANGED')
 def test_private_content_not_paged(self):
  p,r=self.record();data=self.b.token.encode();(p/'preview.json').write_bytes(data);r['artifacts']=[{'name':'preview.json','bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}];j.atomic(p/'state.json',r);self.bad({'action':'read','jobId':p.name},'PREVIEW_PRIVATE_CONTENT')
 def test_start_preflight(self):
  base={'action':'start','jobId':'b'*32,'session':'s'*32,'expectedRevision':0,'package':'P','component':'C','args':{}}
  for value in [base|{'extra':1},base|{'expectedRevision':True},base|{'args':{'group_profile':'x'}},base|{'package':''}]:self.bad(value,'INVALID_ARGUMENTS')
  self.bad(base|{'session':'other'},'PREVIEW_CONFLICT')
  self.b.metadata=lambda:{'ok':True,'session':'s'*32,'revision':0,'result':{'capabilities':{}}};self.bad(base,'PREVIEW_UNAVAILABLE')
 def test_start_deduplicated_no_spawn(self):
  args={'action':'start','jobId':'c'*32,'session':'s'*32,'expectedRevision':0,'package':'P','component':'C','args':{}}
  p,r=self.record(args['jobId']);r['requestDigest']=j.digest({k:v for k,v in args.items() if k!='action'});j.atomic(p/'state.json',r)
  with mock.patch.object(j.subprocess,'Popen',side_effect=AssertionError('not launched')):
   self.assertTrue(self.jobs.execute(args)['result']['idempotentAdmission']);self.assertTrue(self.jobs.execute(dict(reversed(list(args.items()))))['result']['idempotentAdmission'])
  self.bad(args|{'args':{'events':[]}},'PREVIEW_ID_CONFLICT')
 def test_admission_limits(self):
  args={'action':'start','jobId':'d'*32,'session':'s'*32,'expectedRevision':0,'package':'P','component':'C','args':{}}
  for i in range(j.MAX_JOBS):self.record(f'{i:032x}')
  self.bad(args,'PREVIEW_CAPACITY')
 def test_active_limit(self):
  args={'action':'start','jobId':'d'*32,'session':'s'*32,'expectedRevision':0,'package':'P','component':'C','args':{}}
  for i in range(j.MAX_ACTIVE):
   p,r=self.record(f'{i:032x}',state='running');r['worker']=j.identity(os.getpid());j.atomic(p/'state.json',r)
  self.bad(args,'PREVIEW_CAPACITY')
 def test_spawn_failure_no_retry_or_private_config_left(self):
  args={'action':'start','jobId':'d'*32,'session':'s'*32,'expectedRevision':0,'package':'P','component':'C','args':{}}
  with mock.patch.object(j.subprocess,'Popen',side_effect=OSError('launch failure')):r=self.jobs.execute(args)['result']
  self.assertEqual(r['state'],'failed');self.assertEqual(r['error']['code'],'PREVIEW_START_FAILED');self.assertFalse((self.jobs.path(args['jobId'])/'input.json').exists())
 def test_terminal_cancel_is_noop(self):
  p,r=self.record();self.assertTrue(self.jobs.execute({'action':'cancel','jobId':p.name})['result']['cancelHadNoEffect']);self.assertFalse((p/'cancel.json').exists())
 def test_running_cancel_is_signal_only(self):
  p,r=self.record(state='running');r['worker']=j.identity(os.getpid());j.atomic(p/'state.json',r);self.assertTrue(self.jobs.execute({'action':'cancel','jobId':p.name})['result']['cancelRequested']);self.assertTrue((p/'cancel.json').is_file());self.assertEqual(j.load(p/'state.json')['state'],'running')
if __name__=='__main__':unittest.main()
