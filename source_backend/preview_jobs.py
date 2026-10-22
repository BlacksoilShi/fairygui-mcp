"""Bounded, source-read-only browser jobs, separate from write receipts/snapshots.

An explicit job ID makes a lost admission response queryable. Jobs are never
automatically restarted; an interrupted worker is reported, not replayed.
"""
from pathlib import Path
import base64,contextlib,ctypes,hashlib,json,os,re,secrets,shutil,subprocess,sys,tempfile,time

PROTOCOL='fgui-preview-job/1';MAX_JOBS=8;MAX_ACTIVE=2;TTL_MS=180000;BUDGET=64*1024*1024;RESERVE=25*1024*1024
ID=re.compile(r'^[a-f0-9]{32}$');TERMINAL={'completed','failed','cancelled','interrupted','expired'}

def raw(v):return json.dumps(v,ensure_ascii=False,allow_nan=False,separators=(',',':')).encode('utf-8')
def load(p,limit=65536):
    for attempt in range(8):
        try:
            if os.name!='nt':f=p.open('rb')
            else:
                from ctypes import wintypes as W
                import msvcrt
                k=ctypes.WinDLL('kernel32',use_last_error=True);k.CreateFileW.argtypes=[W.LPCWSTR,W.DWORD,W.DWORD,ctypes.c_void_p,W.DWORD,W.DWORD,W.HANDLE];k.CreateFileW.restype=W.HANDLE;k.CloseHandle.argtypes=[W.HANDLE]
                # Share read/write/delete so concurrent atomic replacement is allowed.
                h=k.CreateFileW(str(p),0x80000000,7,None,3,0x80,None)
                if h==W.HANDLE(-1).value:raise ctypes.WinError(ctypes.get_last_error())
                try:fd=msvcrt.open_osfhandle(h,os.O_RDONLY)
                except Exception:k.CloseHandle(h);raise
                f=os.fdopen(fd,'rb')
            with f:data=f.read(limit+1)
            if len(data)>limit:raise ValueError('record limit')
            return json.loads(data.decode('utf-8'))
        except PermissionError:
            if attempt==7:raise
            time.sleep(min(.005*2**attempt,.08))
def digest(v):return hashlib.sha256(json.dumps(v,sort_keys=True,ensure_ascii=False,allow_nan=False,separators=(',',':')).encode('utf-8')).hexdigest()
def now():return int(time.time()*1000)
def no_links(p):
    p=Path(p)
    for x in [p,*p.parents]:
        if x.is_symlink() or getattr(x,'is_junction',lambda:False)():raise ValueError('linked store path')
    return p.resolve()
def atomic(p,value):
    fd,n=tempfile.mkstemp(prefix='.job-',dir=p.parent)
    try:
        with os.fdopen(fd,'wb') as f:f.write(raw(value));f.flush();os.fsync(f.fileno())
        for attempt in range(8):
            try:os.replace(n,p);break
            except PermissionError:
                if attempt==7:raise
                time.sleep(min(.005*2**attempt,.08))
    finally:Path(n).unlink(missing_ok=True)

def private_fd(path):
    if os.name!='nt':return os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    from ctypes import wintypes as W
    import msvcrt
    class SA(ctypes.Structure):_fields_=[('nLength',W.DWORD),('lpSecurityDescriptor',ctypes.c_void_p),('bInheritHandle',W.BOOL)]
    a=ctypes.WinDLL('advapi32',use_last_error=True);k=ctypes.WinDLL('kernel32',use_last_error=True)
    convert=a.ConvertStringSecurityDescriptorToSecurityDescriptorW;convert.argtypes=[W.LPCWSTR,W.DWORD,ctypes.POINTER(ctypes.c_void_p),ctypes.POINTER(W.DWORD)];convert.restype=W.BOOL
    create=k.CreateFileW;create.argtypes=[W.LPCWSTR,W.DWORD,W.DWORD,ctypes.POINTER(SA),W.DWORD,W.DWORD,W.HANDLE];create.restype=W.HANDLE
    k.LocalFree.argtypes=[ctypes.c_void_p];k.CloseHandle.argtypes=[W.HANDLE]
    d=ctypes.c_void_p()
    if not convert('D:P(A;;FA;;;OW)',1,ctypes.byref(d),None):raise ctypes.WinError(ctypes.get_last_error())
    try:
        sa=SA(ctypes.sizeof(SA),d,False);h=create(str(path),0x40000000,0,ctypes.byref(sa),1,0x80,None)
        if h==W.HANDLE(-1).value:raise ctypes.WinError(ctypes.get_last_error())
        try:return msvcrt.open_osfhandle(h,os.O_WRONLY)
        except Exception:k.CloseHandle(h);raise
    finally:k.LocalFree(d)

def private_dir(path):
    if os.name!='nt':path.mkdir(mode=0o700);return
    from ctypes import wintypes as W
    class SA(ctypes.Structure):_fields_=[('nLength',W.DWORD),('lpSecurityDescriptor',ctypes.c_void_p),('bInheritHandle',W.BOOL)]
    a=ctypes.WinDLL('advapi32',use_last_error=True);k=ctypes.WinDLL('kernel32',use_last_error=True)
    convert=a.ConvertStringSecurityDescriptorToSecurityDescriptorW;convert.argtypes=[W.LPCWSTR,W.DWORD,ctypes.POINTER(ctypes.c_void_p),ctypes.POINTER(W.DWORD)];convert.restype=W.BOOL
    create=k.CreateDirectoryW;create.argtypes=[W.LPCWSTR,ctypes.POINTER(SA)];create.restype=W.BOOL;k.LocalFree.argtypes=[ctypes.c_void_p]
    d=ctypes.c_void_p()
    if not convert('D:P(A;OICI;FA;;;OW)',1,ctypes.byref(d),None):raise ctypes.WinError(ctypes.get_last_error())
    try:
        sa=SA(ctypes.sizeof(SA),d,False)
        if not create(str(path),ctypes.byref(sa)):raise ctypes.WinError(ctypes.get_last_error())
    finally:k.LocalFree(d)

def identity(pid):
    if type(pid) is not int or pid<=0:return None
    if os.name!='nt':
        try:return {'pid':pid,'birth':Path('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].split()[19]}
        except OSError:return None
    from ctypes import wintypes as W
    k=ctypes.WinDLL('kernel32',use_last_error=True);k.OpenProcess.argtypes=[W.DWORD,W.BOOL,W.DWORD];k.OpenProcess.restype=W.HANDLE;k.CloseHandle.argtypes=[W.HANDLE];k.GetProcessTimes.argtypes=[W.HANDLE]+[ctypes.POINTER(W.FILETIME)]*4;k.GetExitCodeProcess.argtypes=[W.HANDLE,ctypes.POINTER(W.DWORD)]
    h=k.OpenProcess(0x1000,False,pid)
    if not h:return None
    try:
        code=W.DWORD();ts=[W.FILETIME() for _ in range(4)]
        if not k.GetExitCodeProcess(h,ctypes.byref(code)) or code.value!=259:return None
        if not k.GetProcessTimes(h,*[ctypes.byref(t) for t in ts]):raise OSError('birth unavailable')
        return {'pid':pid,'birth':(ts[0].dwHighDateTime<<32)|ts[0].dwLowDateTime}
    finally:k.CloseHandle(h)
def alive(record):return bool(record) and identity(record.get('pid'))==record

def configure(value,project,receipts,Error):
    if value is None:return None
    expected={'node','playwrightModule','browserExecutable','jobDir','timeoutMs'}
    if not isinstance(value,dict) or set(value)!=expected:raise Error('CONFIG_INVALID','browserPreview keys differ')
    try:
        out=dict(value)
        for key in expected-{'timeoutMs'}:
            if not isinstance(value[key],str) or not Path(value[key]).is_absolute():raise ValueError()
            out[key]=str(no_links(Path(value[key])))
        if not Path(out['node']).is_file() or not Path(out['browserExecutable']).is_file() or not Path(out['playwrightModule']).is_dir():raise ValueError()
        if type(out['timeoutMs']) is not int or not 1000<=out['timeoutMs']<=120000:raise ValueError()
        root=Path(out['jobDir'])
        for p in [project.parent,receipts]:
            if root.is_relative_to(p) or p.is_relative_to(root):raise ValueError()
        return out
    except (ValueError,OSError):raise Error('CONFIG_INVALID','Invalid browserPreview fixed paths, timeout or store boundary')

class Jobs:
    def __init__(self,backend,Error):
        self.b,self.E=backend,Error;self.cfg=backend.browser_preview
        if self.cfg is None:raise Error('PREVIEW_DISABLED','Explicit browserPreview configuration required')
        self.root=no_links(Path(self.cfg['jobDir']))
        if not self.root.exists():
            self.root.parent.mkdir(parents=True,exist_ok=True);private_dir(self.root)
            atomic(self.root/'.owner.json',{'protocol':PROTOCOL,'projectPath':str(backend.project)})
        try:
            owner=load(self.root/'.owner.json')
            if owner!={'protocol':PROTOCOL,'projectPath':str(backend.project)}:raise ValueError()
        except (ValueError,OSError):raise Error('PREVIEW_STORE_OWNERSHIP','Existing preview directory is not the configured owned store')
    def error(self,code,message):raise self.E(code,message)
    @contextlib.contextmanager
    def lock(self):
        f=(self.root/'.preview.lock').open('a+b')
        try:
            if f.seek(0,2)==0:f.write(b'0');f.flush()
            f.seek(0)
            try:
                if os.name=='nt':
                    import msvcrt
                    msvcrt.locking(f.fileno(),msvcrt.LK_NBLCK,1)
                else:
                    import fcntl
                    fcntl.flock(f.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
            except OSError:self.error('PREVIEW_STORE_BUSY','Preview store admission is busy; no new job admitted')
            yield
        finally:f.close() # OS releases the lock on close/crash.
    def path(self,identifier):
        if not isinstance(identifier,str) or not ID.fullmatch(identifier):self.error('INVALID_ARGUMENTS','Expected jobId32 lowercase hex')
        p=no_links(self.root/identifier)
        if p.parent!=self.root:self.error('PREVIEW_PATH','Job path differs')
        return p
    def record(self,p):
        try:
            r=load(p/'state.json')
            if r.get('protocol')!=PROTOCOL or r.get('kind')!='preview' or r.get('projectPath')!=str(self.b.project) or r.get('jobId')!=p.name or r.get('state') not in TERMINAL|{'queued','running','cancel_requested'} or type(r.get('expiresAtMs')) is not int:raise ValueError()
            return r
        except (OSError,ValueError,TypeError):self.error('PREVIEW_STORE_INVALID','Job record is absent, corrupt or belongs to another project')
    def reconcile(self,p,r):
        if not r.get('worker') and (p/'launch.json').is_file():
            launch=load(p/'launch.json')
            if alive(launch.get('worker')):return r
        if r['state'] not in TERMINAL and not alive(r.get('worker')):
            # A new queued job has a short, explicit admission window.
            if r['state']=='queued' and now()-r['createdAtMs']<5000:return r
            if alive(r.get('node')):self.error('PREVIEW_OWNERSHIP','Runner stopped while owned browser worker is still live; inspect job without replay')
            r.update(state='interrupted',phase='worker-missing',cleanupConfirmed=False,remoteCleanup='unconfirmed-use-source-TTL');atomic(p/'state.json',r)
        return r
    def pointer(self,r,**extra):
        value={k:r[k] for k in ['protocol','jobId','state','session','revision','createdAtMs','deadlineAtMs','expiresAtMs','phase']}
        value.update(readOnly=True,sourceFilesModified=False,readWith='source_preview',**extra)
        for k in ['sequence','measurements','scope','profile','cleanupConfirmed','processCleanupConfirmed','profileRemoved','remoteCleanup','error','artifacts']:
            if k in r:value[k]=r[k]
        return self.b.wrap({'ok':True,'session':r['session'],'revision':r['revision'],'result':value})
    def release(self,p,r):
        if r['state'] not in TERMINAL or alive(r.get('worker')) or alive(r.get('node')):self.error('PREVIEW_BUSY','Cancel and wait for worker terminal before release')
        if (p/'browser-profile').exists():self.error('PREVIEW_CLEANUP_UNCONFIRMED','Owned profile remains; preserve it for explicit cleanup')
        allowed={'state.json','input.json','cancel.json','launch.json','node-owned.json','browser-owner.json','preview.json','preview.png','preview.receipt.json'}
        files=list(p.iterdir())
        if any(no_links(f).parent!=p or not f.is_file() or f.name not in allowed for f in files):self.error('PREVIEW_FOREIGN_FILE','Unexpected job files preserved; no recursive deletion')
        for f in files:f.unlink()
        p.rmdir()
    def inspect(self,args):
        if set(args)!={'action'}:self.error('INVALID_ARGUMENTS','inspect takes no job selector')
        with self.lock():
            rows=[];active=0;used=0
            for p in self.root.iterdir():
                if p.name in {'.owner.json','.preview.lock'}:continue
                if not p.is_dir() or not ID.fullmatch(p.name):self.error('PREVIEW_STORE_INVALID','Unexpected preview entry preserved')
                p=self.path(p.name);r=self.record(p)
                try:r=self.reconcile(p,r);attention=None
                except self.E as e:
                    if e.code!='PREVIEW_OWNERSHIP':raise
                    attention=e.code
                live=alive(r.get('worker')) or alive(r.get('node'));active+=int(live or r['state'] not in TERMINAL)
                used+=RESERVE if live or r['state'] not in TERMINAL else sum(f.stat().st_size for f in p.iterdir() if f.is_file())
                row=self.pointer(r)['result'];row.update(workerAlive=alive(r.get('worker')),nodeAlive=alive(r.get('node')),expired=now()>=r['expiresAtMs'],profileRemains=(p/'browser-profile').exists(),needsAttention=attention)
                rows.append(row)
                if len(rows)>MAX_JOBS:self.error('PREVIEW_STORE_INVALID','Preview record count exceeds configured maximum')
            return self.b.wrap({'ok':True,'result':{'protocol':PROTOCOL,'kind':'preview-store-inspection','readOnly':True,'sourceFilesModified':False,'jobs':sorted(rows,key=lambda r:r['createdAtMs']),'active':active,'retained':len(rows),'limits':{'active':MAX_ACTIVE,'retained':MAX_JOBS,'outputBudgetBytes':BUDGET,'activeReservationBytes':RESERVE,'ttlMs':TTL_MS},'chargedOutputBytes':used,'processOwnership':'pid-and-birth; kernel containment on new Windows jobs'}})
    def cleanup(self,p,r):
        if r['state'] not in TERMINAL or alive(r.get('worker')) or alive(r.get('node')):self.error('PREVIEW_BUSY','Owned workers must be stopped before cleanup')
        members=r.get('ownedProcesses',[])
        if not isinstance(members,list) or len(members)>128 or any(alive(x) for x in members):self.error('PREVIEW_BUSY','Owned descendants still live or unverified')
        profile=p/'browser-profile'
        if profile.exists():
            marker=p/'browser-owner.json'
            if r.get('containment')!='win32-kill-on-close/1' or not marker.is_file() or sha_file(marker)!=r.get('browserMarkerSHA256'):self.error('PREVIEW_OWNERSHIP','Profile cleanup lacks matching Windows ownership evidence')
            data=load(marker)
            if data.get('protocol')!='fgui-browser-preview-host/1' or data.get('profile')!=str(profile) or not re.fullmatch('[a-f0-9]{48}',data.get('owner','')):self.error('PREVIEW_OWNERSHIP','Profile marker differs')
            profile=no_links(profile)
            if profile.parent!=p:self.error('PREVIEW_PATH','Profile leaves job root')
            files=list(profile.rglob('*'))
            if len(files)>8192:self.error('PREVIEW_CLEANUP_LIMIT','Owned profile exceeds explicit cleanup walk bound')
            for f in files:
                if not no_links(f).is_relative_to(profile):self.error('PREVIEW_PATH','Linked profile content preserved')
            shutil.rmtree(profile) # exact resolved owned path checked above; never job/root/project.
        (p/'input.json').unlink(missing_ok=True)
        r.update(processCleanupConfirmed=True,profileRemoved=True);atomic(p/'state.json',r)
        return self.pointer(r,localCleanup=True,remoteCleanupConfirmed=r.get('cleanupConfirmed',False))
    def start(self,args):
        required={'action','jobId','session','expectedRevision','package','component','args'}
        if set(args)!=required:self.error('INVALID_ARGUMENTS','start fields differ')
        if not isinstance(args['session'],str) or type(args['expectedRevision']) is not int or args['expectedRevision']<0 or not isinstance(args['package'],str) or not args['package'] or not isinstance(args['component'],str) or not args['component'] or len(args['package'])>256 or len(args['component'])>128 or not isinstance(args['args'],dict):self.error('INVALID_ARGUMENTS','Invalid preview owner/selectors/args')
        if set(args['args'])-{'events','host','max_steps','branch','variables','random_values','stage_profile','custom_ease_profile'}:self.error('INVALID_ARGUMENTS','Preview option is not supported')
        if len(raw(args))>48*1024:self.error('PREVIEW_INPUT_LIMIT','Preview start exceeds48KiB')
        p=self.path(args['jobId']);request={k:args[k] for k in args if k!='action'};d=digest(request)
        with self.lock():
            if p.exists():
                r=self.reconcile(p,self.record(p))
                if r['requestDigest']!=d:self.error('PREVIEW_ID_CONFLICT','jobId already belongs to different arguments')
                return self.pointer(r,idempotentAdmission=True)
            meta=self.b.metadata()
            if not meta['ok']:return self.b.wrap(meta)
            if meta['session']!=args['session'] or meta['revision']!=args['expectedRevision']:self.error('PREVIEW_CONFLICT','Preview session/revision changed')
            cap=meta['result']['capabilities'].get('browserText')
            if not isinstance(cap,dict) or cap.get('transport')!='editor-session-challenge-receipt/1':self.error('PREVIEW_UNAVAILABLE','Configured source does not advertise browser text preview')
            records=[];charge=0
            for child in self.root.iterdir():
                if child.name in {'.preview.lock','.owner.json'}:continue
                if not child.is_dir() or not ID.fullmatch(child.name):self.error('PREVIEW_STORE_INVALID','Unexpected preview store entry')
                child=self.path(child.name);r=self.reconcile(child,self.record(child))
                if now()>=r['expiresAtMs'] and r['state'] in TERMINAL:self.release(child,r);continue
                records.append(r);charge+=RESERVE if r['state'] not in TERMINAL else sum(f.stat().st_size for f in child.iterdir() if f.is_file())
            if len(records)>=MAX_JOBS or sum(r['state'] not in TERMINAL for r in records)>=MAX_ACTIVE or charge+RESERVE>BUDGET:self.error('PREVIEW_CAPACITY','Preview cache/worker capacity exhausted')
            p.mkdir();created=now();r={'protocol':PROTOCOL,'kind':'preview','projectPath':str(self.b.project),'jobId':p.name,'requestDigest':d,'session':args['session'],'revision':args['expectedRevision'],'createdAtMs':created,'deadlineAtMs':created+self.cfg['timeoutMs'],'expiresAtMs':created+TTL_MS,'phase':'queued','state':'queued','worker':None,'node':None}
            atomic(p/'state.json',r)
            config={'deadlineAtMs':r['deadlineAtMs'],'node':self.cfg['node'],'host':{'origin':'http://127.0.0.1:'+str(self.b.port),'token':self.b.token,'session':args['session'],'revision':args['expectedRevision'],'projectFile':str(self.b.project),'playwrightModule':self.cfg['playwrightModule'],'browserExecutable':self.cfg['browserExecutable'],'timeoutMs':self.cfg['timeoutMs']},'request':{'package':args['package'],'component':args['component'],'args':args['args']}}
            try:
                with os.fdopen(private_fd(p/'input.json'),'wb') as f:f.write(raw(config));f.flush();os.fsync(f.fileno())
                flags=(subprocess.CREATE_NO_WINDOW|subprocess.DETACHED_PROCESS) if os.name=='nt' else 0
                # Windows venv launchers can exit after spawning a different PID.
                # Pin the real stdlib interpreter so admission birth == runner PID.
                interpreter=str(Path(getattr(sys,'_base_executable',sys.executable)).resolve())
                child=subprocess.Popen([interpreter,str(Path(__file__).resolve()),'--run',str(p)],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=flags,start_new_session=os.name!='nt')
                atomic(p/'launch.json',{'worker':identity(child.pid)})
                # Runner owns all later state mutations. It binds its own birth.
            except OSError:
                r.update(state='failed',phase='launch-failed',error={'code':'PREVIEW_START_FAILED'});atomic(p/'state.json',r);(p/'input.json').unlink(missing_ok=True)
            return self.pointer(r)
    def execute(self,args):
        if not isinstance(args,dict):self.error('INVALID_ARGUMENTS','Expected preview request object')
        action=args.get('action')
        if action=='inspect':return self.inspect(args)
        if action=='start':return self.start(args)
        allowed={'status':{'action','jobId'},'cancel':{'action','jobId'},'release':{'action','jobId'},'cleanup':{'action','jobId'},'read':{'action','jobId','artifact','offset','limit'}}
        if action not in allowed or set(args)-allowed[action] or not {'action','jobId'}<=set(args):self.error('INVALID_ARGUMENTS','Preview action/fields differ')
        p=self.path(args['jobId'])
        with self.lock():
            if not p.exists():
                if action=='release':return self.b.wrap({'ok':True,'result':{'protocol':PROTOCOL,'jobId':args['jobId'],'state':'released','existed':False}})
                self.error('PREVIEW_NOT_FOUND','Preview job is absent or released')
            r=self.reconcile(p,self.record(p))
            if action=='cleanup':return self.cleanup(p,r)
            if action=='release':self.release(p,r);return self.pointer(r,released=True)
            if now()>=r['expiresAtMs']:self.error('PREVIEW_EXPIRED','Preview cache expired; release it and start a new explicit job')
            if action=='cancel':
                if r['state'] in TERMINAL:return self.pointer(r,cancelHadNoEffect=True)
                atomic(p/'cancel.json',{'requestedAtMs':now()});return self.pointer(r,cancelRequested=True)
            if action=='read':
                if r['state']!='completed':self.error('PREVIEW_NOT_COMPLETE','Preview artifacts require a completed job')
                artifact=args.get('artifact','result');name={'result':'preview.json','png':'preview.png'}.get(artifact)
                offset=args.get('offset',0);limit=args.get('limit',16384)
                if name is None or type(offset) is not int or offset<0 or type(limit) is not int or not 1<=limit<=16384:self.error('INVALID_ARGUMENTS','Read artifact and byte range differ')
                f=no_links(p/name);entry=next((a for a in r['artifacts'] if a['name']==name),None)
                if not entry or f.parent!=p or not f.is_file() or f.stat().st_size!=entry['bytes'] or sha_file(f)!=entry['sha256']:self.error('PREVIEW_ARTIFACT_CHANGED','Preview artifact identity changed')
                if offset>entry['bytes']:self.error('INVALID_ARGUMENTS','Offset exceeds artifact byte length')
                if self.b.token.encode('utf-8') in f.read_bytes():self.error('PREVIEW_PRIVATE_CONTENT','Configured credential appeared in artifact; artifact not transported')
                with f.open('rb') as stream:stream.seek(offset);data=stream.read(limit)
                end=offset+len(data)
                return self.pointer(r,artifact=artifact,encoding='base64',data=base64.b64encode(data).decode('ascii'),offset=offset,nextOffset=end if end<entry['bytes'] else None,utf8OrPNGBytes=entry['bytes'],sha256=entry['sha256'])
            return self.pointer(r)

def sha_file(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def runner(p):
    p=no_links(p);r=load(p/'state.json');config=load(p/'input.json',65536)
    start=time.monotonic()
    while not (p/'launch.json').exists() and time.monotonic()-start<3:time.sleep(.01)
    if load(p/'launch.json').get('worker')!=identity(os.getpid()):raise ValueError('worker admission birth changed')
    r.update(state='running',phase='starting',worker=identity(os.getpid()));atomic(p/'state.json',r)
    from owned_processes import OwnedProcesses
    process=None;receipt=None;count=0;owned=None;members={};stage='create-container'
    def observe_owned():
        if owned:
            for pid in owned.pids():
                info=identity(pid)
                if info:members[(info['pid'],info['birth'])]=info
        r['ownedProcesses']=list(members.values())
        marker=p/'browser-owner.json'
        if marker.is_file():r['browserMarkerSHA256']=sha_file(marker)
    try:
        owned=OwnedProcesses();r['containment']='win32-kill-on-close/1' if owned.windows else 'cooperative-only/1';stage='spawn-node'
        process=subprocess.Popen([config['node'],str(Path(__file__).with_name('preview_job.cjs')),str(p/'input.json'),str(p)],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        owned.assign(process);r['node']=identity(process.pid);observe_owned();atomic(p/'state.json',r)
        atomic(p/'node-owned.json',{'node':r['node'],'jobId':r['jobId'],'containment':r['containment']})
        stage='read-events'
        for line in iter(process.stdout.readline,b''):
            count+=len(line)
            if len(line)>65536 or count>1024*1024:raise ValueError('worker stream bound')
            value=json.loads(line)
            if value.get('event')=='progress':
                phase=value.get('phase');seq=value.get('sequence')
                if phase not in {'load','navigate','replay','measure','capture','closed'} or seq is not None and (type(seq) is not int or not 0<=seq<=256):raise ValueError('worker progress')
                stage='write-progress';r.update(phase=phase,sequence=seq);observe_owned();atomic(p/'state.json',r);stage='read-events'
            elif value.get('event')=='result':receipt=value.get('receipt')
            else:raise ValueError('worker event')
        stage='validate-result';code=process.wait(timeout=10)
        if code!=0 or not isinstance(receipt,dict):raise ValueError('worker terminal')
        success=receipt.get('state')=='complete' and receipt.get('close',{}).get('contextClosed') is True and receipt['close'].get('profileRemoved') is True
        r.update(state='completed' if success else 'cancelled' if receipt.get('state')=='cancelled' else 'failed',phase='terminal',cleanupConfirmed=receipt.get('cleanup',{}).get('confirmed',False),error=receipt.get('error'))
        if success:
            scope=receipt['scope']
            if scope.get('session')!=r['session'] or scope.get('revision')!=r['revision']:raise ValueError('terminal owner')
            artifacts=receipt.get('artifacts')
            if not isinstance(artifacts,list) or len(artifacts)!=2:raise ValueError('artifact list')
            for a in artifacts:
                if a.get('name') not in ['preview.json','preview.png'] or type(a.get('bytes')) is not int or not 0<a['bytes']<=16*1024*1024 or sha_file(p/a['name'])!=a.get('sha256'):raise ValueError('artifact identity')
            if {a['name'] for a in artifacts}!={'preview.json','preview.png'}:raise ValueError('artifact names')
            if scope.get('package')!=config['request']['package'] or scope.get('component')!=config['request']['component'] or not re.fullmatch('[a-f0-9]{64}',scope.get('sourceDigest','')):raise ValueError('terminal scope')
            if type(receipt.get('measurements')) is not int or not 0<=receipt['measurements']<=256:raise ValueError('measurement total')
            r.update(artifacts=artifacts,scope=scope,measurements=receipt['measurements'],profile=receipt.get('profile'))
    except Exception as error:
        # Never replay this read-only job or source writes after an unknown exit.
        name=type(error).__name__;r.update(state='failed',phase='worker-failed',cleanupConfirmed=False,error={'code':'PREVIEW_JOB_FAILURE','stage':stage,'exceptionType':name if re.fullmatch('[A-Za-z_]{1,64}',name) else 'Error'})
    finally:
        if process and process.poll() is None:
            # Signal cooperative cancellation rather than killing an unverified PID.
            atomic(p/'cancel.json',{'requestedAtMs':now()})
            try:process.wait(timeout=10)
            except subprocess.TimeoutExpired:r.update(phase='cleanup-unconfirmed')
        if owned:
            try:
                observe_owned();owned.close();limit=time.monotonic()+5
                while any(alive(x) for x in members.values()) and time.monotonic()<limit:time.sleep(.05)
                r['processCleanupConfirmed']=not any(alive(x) for x in members.values())
            except Exception:r['processCleanupConfirmed']=False
        r['profileRemoved']=not (p/'browser-profile').exists()
        (p/'input.json').unlink(missing_ok=True);atomic(p/'state.json',r)

if __name__=='__main__':
    if len(sys.argv)!=3 or sys.argv[1]!='--run':raise SystemExit(2)
    runner(Path(sys.argv[2]))
