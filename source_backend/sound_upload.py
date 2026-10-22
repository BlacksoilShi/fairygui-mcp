"""Opt-in bounded local Sound file -> binary HTTP, with durable non-replay receipts."""
from pathlib import Path
import hashlib,json,os,re,stat
MAX_FILE=64*1024*1024
EXTENSIONS=('.wav','.mp3','.ogg')
def links(path,E):
 for p in (path,*path.parents):
  if p.exists() or p.is_symlink():
   s=p.lstat()
   if stat.S_ISLNK(s.st_mode) or getattr(s,'st_file_attributes',0)&0x400:raise E('UPLOAD_PATH_REJECTED','Linked or reparse upload paths are not admitted')
def roots(value,E):
 if not isinstance(value,list) or len(value)>16:raise E('CONFIG_INVALID','uploadRoots requires at most16 explicit directories')
 result=[]
 for name in value:
  if not isinstance(name,str) or not Path(name).is_absolute() or len(name)>2048 or '\0' in name:raise E('CONFIG_INVALID','Upload root requires an absolute directory')
  path=Path(name).absolute();links(path,E)
  if not path.is_dir() or path.resolve()!=path or os.name=='nt' and (len(path.drive)!=2 or path.drive[1]!=':'):raise E('CONFIG_INVALID','Upload roots must be existing canonical local directories')
  if path in result:raise E('CONFIG_INVALID','Duplicate upload root')
  result.append(path)
 return tuple(result)
def file_path(value,allowed,E):
 if not isinstance(value,str) or len(value)>2048 or '\0' in value or not Path(value).is_absolute():raise E('UPLOAD_PATH_REJECTED','Absolute configured-root Sound file required')
 path=Path(value).absolute()
 if '..' in Path(value).parts or path.suffix.lower() not in EXTENSIONS:raise E('UPLOAD_PATH_REJECTED','Expected WAV/MP3/OGG source file, not a traversal')
 if not any(path!=root and path.is_relative_to(root) for root in allowed):raise E('UPLOAD_PATH_REJECTED','Upload file is outside explicit import roots')
 links(path,E)
 if path.resolve()!=path:raise E('UPLOAD_PATH_REJECTED','Noncanonical upload path')
 return path
def identity(s):return (s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns)
class Stream:
 def __init__(self,file,size,sha,E):self.file=file;self.remaining=size;self.sha=sha;self.digest=hashlib.sha256();self.E=E
 def read(self,size=65536):
  if size==0:return b''
  if not self.remaining:return b''
  raw=self.file.read(min(size if size>0 else 65536,65536,self.remaining))
  if not raw:raise self.E('UPLOAD_SOURCE_CHANGED','Source ended during binary upload')
  self.remaining-=len(raw);self.digest.update(raw);return raw
 def verify(self):
  if self.remaining or self.digest.hexdigest()!=self.sha:raise self.E('UPLOAD_SOURCE_CHANGED','Source bytes changed between hashing and upload')
def execute(backend,args,E):
 keys={'requestId','session','expectedRevision','filePath'}
 if not isinstance(args,dict) or set(args)!=keys:raise E('INVALID_ARGUMENTS','Sound upload requires exactly requestId/session/expectedRevision/filePath')
 rid=backend.id(args['requestId'])
 if not isinstance(args['session'],str) or re.fullmatch('[A-Za-z0-9_-]{16,128}',args['session']) is None:raise E('INVALID_ARGUMENTS','Explicit source session required')
 if type(args['expectedRevision']) is not int or not 0<=args['expectedRevision']<=9007199254740991:raise E('INVALID_ARGUMENTS','Explicit nonnegative safe-integer revision required')
 if not isinstance(args['filePath'],str) or len(args['filePath'])>2048:raise E('INVALID_ARGUMENTS','Bounded source file path required')
 if not backend.upload_roots:raise E('UPLOAD_DISABLED','Configure explicit backend uploadRoots first')
 digest=hashlib.sha256(json.dumps(dict(projectPath=str(backend.project),command='source_sound_upload',arguments=args),sort_keys=True,ensure_ascii=False,separators=(',',':')).encode('utf-8')).hexdigest()
 previous=backend.admission(rid,digest)
 if previous is not None:return backend.deliver(previous,rid)
 dispatched=False
 try:
  meta=backend.metadata()
  if not meta['ok']:response=backend.wrap(meta,requestId=rid,dispatchAttempted=False)
  else:
   if meta['session']!=args['session']:raise E('SESSION_CONFLICT','Independent source session changed')
   if meta['revision']!=args['expectedRevision']:raise E('REVISION_CONFLICT','Independent source revision changed')
   caps=meta['result']['capabilities'].get('soundDocuments',{})
   if caps.get('uploadRoute')!='/api/sound-upload' or caps.get('uploadSessionOwned') is not True or caps.get('uploadSingleUse') is not True:raise E('UPLOAD_UNSUPPORTED','Configured backend does not advertise this Sound upload contract')
   path=file_path(args['filePath'],backend.upload_roots,E);before=path.stat()
   if not stat.S_ISREG(before.st_mode) or before.st_size>MAX_FILE:raise E('UPLOAD_FILE_LIMIT','Expected regular Sound file within64MiB')
   with path.open('rb') as file:
    opened=os.fstat(file.fileno())
    if identity(opened)!=identity(before):raise E('UPLOAD_SOURCE_CHANGED','Source identity changed during open')
    hashed=hashlib.sha256();size=0
    while True:
     raw=file.read(65536)
     if not raw:break
     size+=len(raw)
     if size>MAX_FILE or size>before.st_size:raise E('UPLOAD_SOURCE_CHANGED','Source grew during hashing')
     hashed.update(raw)
    sha=hashed.hexdigest()
    if size!=before.st_size or identity(os.fstat(file.fileno()))!=identity(before):raise E('UPLOAD_SOURCE_CHANGED','Source changed during hashing')
    file.seek(0);stream=Stream(file,size,sha,E);dispatched=True
    value=backend.http('POST','/api/sound-upload',binary=dict(bytes=size,sha256=sha,session=args['session'],revision=args['expectedRevision'],stream=stream))
    stream.verify();links(path,E)
    if identity(os.fstat(file.fileno()))!=identity(before):raise E('UPLOAD_SOURCE_CHANGED','Source identity changed during transfer')
   if value['ok']:
    row=value.get('result',{})
    if value['session']!=args['session'] or value['revision']!=args['expectedRevision'] or row.get('sha256')!=sha or row.get('bytes')!=size or not isinstance(row.get('uploadId'),str) or re.fullmatch('[0-9a-f]{32}',row['uploadId']) is None:raise E('BACKEND_PROTOCOL','Sound upload receipt identity differs')
   response=backend.wrap(value,requestId=rid,dispatchAttempted=True,sourceFile=dict(name=path.name,bytes=size,sha256=sha),sourceFilesModified=False)
 except (E,OSError) as cause:
  response=backend.wrap(dict(ok=False,error=dict(code='OUTCOME_UNKNOWN' if dispatched else cause.code if isinstance(cause,E) else 'UPLOAD_SOURCE_UNAVAILABLE',message='Upload dispatch outcome is unconfirmed; inspect receipt, no automatic retry' if dispatched else str(cause) if isinstance(cause,E) else 'Local source file is unavailable',cause=cause.code if isinstance(cause,E) else 'FILE_IO')),requestId=rid,dispatchAttempted=dispatched,sourceFilesModified=False)
 try:backend.atomic(backend.directory/(rid+'.json'),dict(state='done',inputSha256=digest,response=response))
 except OSError as cause:raise E('OUTCOME_UNKNOWN','Upload receipt persistence failed; no automatic retry',requestId=rid) from cause
 return backend.deliver(response,rid)
