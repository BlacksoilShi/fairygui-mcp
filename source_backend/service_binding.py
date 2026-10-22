"""Read one explicit shared legacy service binding without copying rotating credentials."""
from pathlib import Path
import os

PROTOCOL = 'fgui-service-binding/1'
BASE_FIELDS = {'contract','projectPath','receiptDir','port','token','timeoutSeconds','uploadRoots'}
BASE_REQUIRED = {'contract','projectPath','receiptDir','port','token'}
def _plain_path(value, error):
 if not isinstance(value,str) or not value or '\x00' in value or not Path(value).is_absolute():
  raise error('CONFIG_BINDING_INVALID','Binding paths must be explicit absolute paths')
 path=Path(value)
 for p in [path,*path.parents]:
  if p.exists() or p.is_symlink():
   if p.is_symlink() or getattr(p.lstat(),'st_file_attributes',0)&0x400:
    raise error('CONFIG_BINDING_INVALID','Linked binding paths are not supported')
 return path.resolve()
def resolve(config, decode, error):
 if not isinstance(config,dict) or 'serviceBinding' not in config:return config
 if set(config)-{'serviceBinding','browserPreview'}:
  raise error('CONFIG_BINDING_INVALID','Bound profile cannot override service fields')
 binding=config['serviceBinding']
 if not isinstance(binding,dict) or set(binding)!={'protocol','configPath','projectPath','receiptDir'} or binding['protocol']!=PROTOCOL:
  raise error('CONFIG_BINDING_INVALID','Expected an explicit single-service binding')
 try:
  path=_plain_path(binding['configPath'],error)
  project=_plain_path(binding['projectPath'],error);receipts=_plain_path(binding['receiptDir'],error)
  # A bounded read of a single atomic-file generation. No environment fallback, recursion or retry.
  with path.open('rb') as stream:raw=stream.read(60*1024+1)
  _plain_path(binding['configPath'],error)
  try:base=decode(raw)
  except Exception:
   raise error('CONFIG_BINDING_INVALID','Shared service binding contains invalid JSON') from None
  if not isinstance(base,dict) or set(base)-BASE_FIELDS or not BASE_REQUIRED<=set(base):
   raise error('CONFIG_BINDING_INVALID','Shared service binding must be a literal legacy configuration')
  if _plain_path(base['projectPath'],error)!=project or _plain_path(base['receiptDir'],error)!=receipts:
   raise error('CONFIG_BINDING_MISMATCH','Shared service project or receipt identity changed')
  result=dict(base)
  if 'browserPreview' in config:result['browserPreview']=config['browserPreview']
  return result
 except OSError:
  raise error('CONFIG_BINDING_UNAVAILABLE','Shared service binding could not be read; no command dispatched') from None
