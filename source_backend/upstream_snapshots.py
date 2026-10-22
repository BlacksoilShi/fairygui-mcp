"""Fixed-project proxy of immutable source HTTP snapshot pages; no state replay."""
from pathlib import Path
import hashlib,re,secrets,time
from urllib.parse import urlencode

PROTOCOL='fgui-state-snapshot/1'
MAX_REMOTE=32*1024*1024
MAX_CACHE=8
MAX_RECORD=16384
FIELDS=('stateOnly','snapshotId','protocol','projectPath','independentEditor','nativeEditor',
        'capturedSession','capturedRevision','expiresAtMs','utf8Bytes','unicodeCharacters',
        'sha256','payloadFormat','consistency','live')

def support(backend):
    # Loaded lazily from backend.py to avoid a second BackendError class under CLI.
    from types import SimpleNamespace
    values=backend.__class__.__init__.__globals__
    names=('BackendError','REQUEST_ID','decode','fields','StoreLock','encode',
           'DEFAULT_PAGE_CHARACTERS','MAX_PAGE_CHARACTERS','MAX_OUTPUT')
    return SimpleNamespace(**{key:values[key] for key in names})

def cache(backend):
    b=support(backend);directory=backend.directory/'upstream-snapshots';directory.mkdir(exist_ok=True)
    if not directory.resolve().is_relative_to(backend.directory.resolve()):raise b.BackendError('SNAPSHOT_STORE_INVALID','Upstream pointer cache boundary changed')
    return directory

def validate(backend,value):
    b=support(backend)
    if not value['ok']:return None
    row=value.get('result')
    try:
        if not isinstance(row,dict) or any(key not in row for key in FIELDS):raise ValueError()
        if (row['stateOnly'] is not True or row['protocol']!=PROTOCOL or row['independentEditor'] is not True or
            row['nativeEditor'] is not False or row['live'] is not False or
            row['payloadFormat']!='fgui-http-state-envelope/1' or row['consistency']!='immutable-snapshot-not-current-state'):
            raise ValueError()
        if not isinstance(row['projectPath'],str) or Path(row['projectPath']).resolve()!=backend.project:raise ValueError()
        if not isinstance(row['snapshotId'],str) or not b.REQUEST_ID.fullmatch(row['snapshotId']):raise ValueError()
        if row['capturedSession']!=value['session'] or row['capturedRevision']!=value['revision']:raise ValueError()
        if type(row['capturedRevision']) is not int or row['capturedRevision']<0:raise ValueError()
        if not isinstance(row['capturedSession'],str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,128}',row['capturedSession']):raise ValueError()
        if not isinstance(row['sha256'],str) or not re.fullmatch(r'[a-f0-9]{64}',row['sha256']):raise ValueError()
        if type(row['expiresAtMs']) is not int or not 0<=row['expiresAtMs']<=int(time.time()*1000)+605000:raise ValueError()
        if type(row['utf8Bytes']) is not int or not 1<=row['utf8Bytes']<=MAX_REMOTE:raise ValueError()
        if type(row['unicodeCharacters']) is not int or not 1<=row['unicodeCharacters']<=row['utf8Bytes']:raise ValueError()
    except (ValueError,TypeError,OSError,KeyError):
        raise b.BackendError('UPSTREAM_SNAPSHOT_INVALID','Snapshot identity, execution layer or bounds differ')
    return {key:row[key] for key in FIELDS}

def load(backend,path):
    b=support(backend)
    if not path.resolve().is_relative_to(path.parent.resolve()) or path.stat().st_size>MAX_RECORD:
        raise b.BackendError('SNAPSHOT_STORE_INVALID','Upstream pointer path or size differs')
    record=b.decode(path.read_bytes(),MAX_RECORD)
    b.fields(record,('projectPath','response'),('projectPath','response'))
    if record['projectPath']!=str(backend.project):raise b.BackendError('PROJECT_MISMATCH','Cached snapshot belongs to another project')
    value=record['response']
    if not isinstance(value,dict) or value.get('ok') is not True:raise b.BackendError('SNAPSHOT_STORE_INVALID','Invalid upstream pointer record')
    validate(backend,value)
    return value

def pointer(backend,identifier,value,**extra):
    row=validate(backend,value)
    result=dict(row,snapshotId=identifier,upstreamSnapshot=True,readWith='source_state',startOffset=0,**extra)
    # Only the adapter-local opaque ID is public; upstream ID stays in its cache.
    return backend.wrap(dict(ok=True,session=value['session'],revision=value['revision'],result=result))

def create(backend,selectors):
    b=support(backend);query=urlencode({k:v for k,v in selectors.items() if v is not None})
    directory=cache(backend)
    with b.StoreLock(directory):
        count=0
        for path in directory.glob('*.json'):
            if not b.REQUEST_ID.fullmatch(path.stem) or not path.resolve().is_relative_to(directory.resolve()):
                raise b.BackendError('SNAPSHOT_STORE_INVALID','Unexpected upstream pointer file')
            previous=load(backend,path)
            if int(time.time()*1000)>=previous['result']['expiresAtMs']:path.unlink()
            else:count+=1
        if count>=MAX_CACHE:raise b.BackendError('SNAPSHOT_STORE_FULL','Upstream pointer count exhausted')
        identifier=secrets.token_hex(16);target=directory/(identifier+'.json')
        if target.exists() or (backend.directory/'snapshots'/(identifier+'.json')).exists():
            raise b.BackendError('SNAPSHOT_ID_CONFLICT','Generated local snapshot ID already exists')
        # Reserve pointer capacity/identity before asking the server to freeze a scene.
        value=backend.http('GET','/api/state-snapshot'+('?' +query if query else ''))
        if not value['ok']:return backend.wrap(value)
        row=validate(backend,value)
        # Freeze only the small pointer, not the large state or unbounded server data.
        stored=dict(ok=True,session=value['session'],revision=value['revision'],result=row)
        record=dict(projectPath=str(backend.project),response=stored)
        if len(b.encode(record))>MAX_RECORD:raise b.BackendError('SNAPSHOT_STORE_INVALID','Upstream pointer exceeds cache bound')
        backend.atomic(target,record)
    return pointer(backend,identifier,stored)

def read(backend,args):
    b=support(backend);b.fields(args,('snapshotId','offset','limit'),('snapshotId',))
    identifier=backend.id(args['snapshotId']);offset=args.get('offset',0);limit=args.get('limit',b.DEFAULT_PAGE_CHARACTERS)
    if type(offset) is not int or offset<0 or type(limit) is not int or not 1<=limit<=b.MAX_PAGE_CHARACTERS:
        raise b.BackendError('INVALID_ARGUMENTS','Expected Unicode offset and1..65536 character limit')
    directory=cache(backend);path=directory/(identifier+'.json')
    with b.StoreLock(directory):
        if not path.is_file():raise b.BackendError('SNAPSHOT_NOT_FOUND','Upstream pointer absent')
        stored=load(backend,path)
    original=stored['result']
    if int(time.time()*1000)>=original['expiresAtMs']:raise b.BackendError('SNAPSHOT_EXPIRED','Upstream snapshot expired; no live refresh')
    if offset>original['unicodeCharacters']:raise b.BackendError('INVALID_ARGUMENTS','Offset exceeds snapshot length')
    query=urlencode(dict(snapshotId=original['snapshotId'],offset=offset,limit=limit))
    value=backend.http('GET','/api/state-snapshot?'+query)
    if not value['ok']:return backend.wrap(value)
    row=validate(backend,value)
    if row!=original:raise b.BackendError('UPSTREAM_SNAPSHOT_CHANGED','Frozen upstream metadata changed; no live refresh')
    page=value['result'];part=page.get('text');end=offset+len(part) if isinstance(part,str) else -1
    if (not isinstance(part,str) or type(page.get('offset')) is not int or page['offset']!=offset or
        type(page.get('pageCharacters')) is not int or page['pageCharacters']!=len(part) or len(part)>limit or
        type(page.get('requestedCharacterLimit')) is not int or page['requestedCharacterLimit']!=limit or end>original['unicodeCharacters'] or
        (page.get('nextOffset') is not None and type(page['nextOffset']) is not int) or
        (offset<original['unicodeCharacters'] and not part) or
        page.get('nextOffset')!=(end if end<original['unicodeCharacters'] else None) or
        page.get('pageSha256')!=hashlib.sha256(part.encode('utf-8')).hexdigest()):
        raise b.BackendError('UPSTREAM_PAGE_INVALID','Snapshot page continuity or fragment hash differs')
    result=pointer(backend,identifier,stored,text=part,offset=offset,nextOffset=page['nextOffset'],
                   pageCharacters=len(part),requestedCharacterLimit=limit,pageSha256=page['pageSha256'],helperJSONByteLimit=b.MAX_OUTPUT)
    if len(b.encode(result))>b.MAX_OUTPUT:raise b.BackendError('RESPONSE_LIMIT','Forwarded snapshot page exceeds helper byte bound')
    return result
