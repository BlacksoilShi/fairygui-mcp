"""Bounded, read-only configured-native bridge diagnosis. Never starts or edits."""
from pathlib import Path
import hashlib,json,os,re,socket,time,urllib.error,urllib.request,uuid
from helper import NoRedirect,decode,read_json,current_process

FILES=('main.js','package.json','LICENSE')
FILE_LIMIT=4*1024*1024

def _file(path):
    with path.open('rb') as stream:raw=stream.read(FILE_LIMIT+1)
    if len(raw)>FILE_LIMIT:raise ValueError('Artifact bound')
    return hashlib.sha256(raw).hexdigest()

def _plugin(h):
    root=h.project/'plugins/fgui-agent-bridge-custom'
    if not root.exists():return dict(status='missing',matches=False)
    try:
        if not root.resolve().is_relative_to(h.project):return dict(status='path_conflict',matches=False)
        rows=[]
        for name in FILES:
            actual=root/name;expected=Path(__file__).resolve().parent/'plugin'/name
            if not actual.resolve().is_relative_to(h.project):return dict(status='path_conflict',matches=False)
            if not actual.is_file():rows.append(dict(name=name,status='missing'));continue
            a,b=_file(actual),_file(expected)
            rows.append(dict(name=name,status='match' if a==b else 'different',installedSHA256=a,expectedSHA256=b))
        config=root/'config.json'
        if not config.resolve().is_relative_to(h.project):return dict(status='path_conflict',matches=False)
        keys=('projectPath','publishDir','screenshotDir','host','port','token')
        private=read_json(config) if config.is_file() else None
        # Never return credential, its hash or the private configuration.
        private_match=private=={k:h.cfg[k] for k in keys}
        ok=all(r['status']=='match' for r in rows) and private_match
        return dict(status='match' if ok else 'different',matches=ok,files=rows,privateConfigMatches=private_match)
    except (OSError,ValueError,TypeError):
        return dict(status='invalid_or_unreadable',matches=False)

def _owner(h,reader):
    state=h.work/'state/editor-start.json'
    if not state.exists():return dict(status='not_recorded')
    try:
        if not state.resolve().is_relative_to(h.work):return dict(status='path_conflict')
        recorded=read_json(state);pid=recorded.get('pid')
        if type(pid) is not int or not 0<pid<2**32:return dict(status='invalid_record')
        if reader is None and os.name!='nt':return dict(status='unverified',pid=pid)
        actual=(reader or current_process)(pid)
        if actual is None:return dict(status='stopped',pid=pid)
        matches=(Path(actual['path']).resolve()==Path(h.cfg['editorPath']).resolve()
                 and type(recorded.get('processCreationTime')) is int
                 and recorded['processCreationTime']==actual['creationTime']
                 and recorded.get('projectPath')==str(h.project))
        return dict(status='identity_match' if matches else 'identity_conflict',pid=pid)
    except (OSError,ValueError,TypeError,KeyError,AttributeError):
        return dict(status='invalid_record')

def _transport(h,opener,now_ms):
    request_id=str(uuid.uuid4());now=now_ms if now_ms is not None else int(time.time()*1000)
    payload=dict(cmd='ping',args={},requestId=request_id,deadlineMs=now+2000)
    request=urllib.request.Request(f"http://127.0.0.1:{h.cfg['port']}/",
        data=json.dumps(payload).encode('utf-8'),
        headers={'Authorization':'Bearer '+h.cfg['token'],'Content-Type':'application/json'})
    client=opener or urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    try:
        with client.open(request,timeout=2) as response:
            status=response.status;raw=response.read(65537)
        if len(raw)>65536:return dict(status='response_limit')
        if status!=200:return dict(status='http_error',httpStatus=status)
        try:result=decode(raw.decode('utf-8'))
        except (ValueError,UnicodeError,RecursionError):return dict(status='invalid_response')
        if not isinstance(result,dict):return dict(status='invalid_response')
        if result.get('requestId')!=request_id:return dict(status='request_identity')
        data=result.get('data')
        if result.get('ok') is not True or not isinstance(data,dict):return dict(status='bridge_error')
        project=data.get('projectPath')
        if not isinstance(project,str) or not Path(project).is_absolute() or Path(project).resolve()!=h.project:
            return dict(status='project_identity')
        session=data.get('sessionId')
        if not isinstance(session,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',session) or session!=result.get('sessionId'):
            return dict(status='session_identity')
        heartbeat=data.get('updatedAtMs')
        if type(heartbeat) is not int or abs(int(time.time()*1000 if now_ms is None else now_ms)-heartbeat)>5000:
            return dict(status='stale_heartbeat')
        if data.get('ready') is not True:return dict(status='not_ready')
        revision=result.get('revision',data.get('revision'))
        if type(revision) is not int or not 0<=revision<=2**53-1:return dict(status='invalid_revision')
        version=data.get('version')
        if not isinstance(version,str) or not re.fullmatch(r'[A-Za-z0-9._-]{1,64}',version):return dict(status='invalid_version')
        return dict(status='connected',session=session,revision=revision,pluginVersion=version,busy=data.get('busy') is True,projectConfirmed=True)
    except urllib.error.HTTPError as error:
        error.close()
        return dict(status='authentication_rejected' if error.code in (401,403) else 'redirect_rejected' if 300<=error.code<400 else 'http_error',httpStatus=error.code)
    except (TimeoutError,socket.timeout):return dict(status='timeout')
    except urllib.error.URLError as error:
        return dict(status='timeout' if isinstance(error.reason,(TimeoutError,socket.timeout)) else 'endpoint_unreachable')
    except (OSError,ValueError,TypeError):return dict(status='endpoint_unreachable')

def diagnose(h,*,opener=None,process_reader=None,now_ms=None):
    plugin=_plugin(h);owner=_owner(h,process_reader);transport=_transport(h,opener,now_ms)
    projects=0
    if h.project.is_dir():
        # No inventory scan: stop immediately at the second .fairy.
        for p in h.project.glob('*.fairy'):
            projects+=1
            if projects==2:break
    actions=[]
    if not Path(h.cfg['editorPath']).is_file():actions.append('review_configured_editor_path')
    if projects!=1:actions.append('review_single_configured_project')
    if plugin['status']!='match':actions.append('review_plugin_before_explicit_update')
    if owner['status'] in ('identity_conflict','path_conflict','invalid_record'):actions.append('review_owner_identity')
    if transport['status']=='endpoint_unreachable':
        actions.append('explicit_start_available' if owner['status'] in ('stopped','not_recorded') else 'inspect_running_editor_and_plugin')
    elif transport['status']=='authentication_rejected':actions.append('review_private_auth_configuration')
    elif transport['status'] in ('project_identity','session_identity','request_identity'):actions.append('review_endpoint_identity')
    elif transport['status']!='connected':actions.append('inspect_current_endpoint_without_write_retry')
    return dict(protocol='fgui-native-diagnostics/1',layer='native-editor',readOnly=True,
        ready=transport['status']=='connected',configuration=dict(projectPath=str(h.project),host='127.0.0.1',port=h.cfg['port'],editorExists=Path(h.cfg['editorPath']).is_file(),projectFileCountBounded=projects),
        plugin=plugin,owner=owner,connection=transport,recommendedActions=actions,
        execution=dict(editorStarted=False,pluginInstalled=False,sourceFilesWritten=False,processesStopped=False,sourceBackendProbed=False),
        limits=dict(httpMilliseconds=2000,responseBytes=65536,artifactFileBytes=FILE_LIMIT,projectFileCountStop=2),
        scope='Configured native endpoint only. A connected endpoint does not prove all edit/save/publish functions, and recorded-owner state may be historical.')
