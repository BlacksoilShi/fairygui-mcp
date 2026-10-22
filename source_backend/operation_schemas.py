"""Read-only schema query over the configured independent endpoint; no command ledger use."""
import re
from urllib.parse import urlencode
from backend import encode,MAX_OUTPUT

PROTOCOL='fgui-operation-schemas/1'
MAX_SCHEMA=48*1024

def query(backend,args,Error):
    if not isinstance(args,dict) or set(args)-{'operation','offset','limit','schemaDigest'}:
        raise Error('INVALID_ARGUMENTS','Unexpected schema query fields')
    operation=args.get('operation')
    if operation is not None and (not isinstance(operation,str) or not re.fullmatch(r'[a-z][a-z0-9_]{0,63}',operation)):
        raise Error('INVALID_ARGUMENTS','Expected bounded operation name')
    if 'operation' in args and operation is None:raise Error('INVALID_ARGUMENTS','operation cannot be null')
    if operation is not None and any(k in args for k in ('offset','limit')):raise Error('INVALID_ARGUMENTS','Single operation and pagination are mutually exclusive')
    offset=args.get('offset',0);limit=args.get('limit',10);digest=args.get('schemaDigest')
    if type(offset) is not int or not 0<=offset<=256 or type(limit) is not int or not 1<=limit<=10:raise Error('INVALID_ARGUMENTS','Expected schema offset0..256 and limit1..10')
    if 'schemaDigest' in args and (not isinstance(digest,str) or not re.fullmatch('[a-f0-9]{64}',digest)):
        raise Error('INVALID_ARGUMENTS','Expected schemaDigest SHA256')
    if offset and digest is None:raise Error('INVALID_ARGUMENTS','Continuation requires matching schemaDigest')
    meta=backend.metadata()
    if not meta['ok']:return backend.wrap(meta)
    try:
        capabilities=meta['result']['capabilities'];ops=capabilities['operations'];advertised=capabilities.get('operationSchemas')
        if advertised is None:raise Error('SCHEMA_UNAVAILABLE','Configured backend does not advertise operation schemas')
        if (not isinstance(advertised,dict) or advertised.get('protocol')!=PROTOCOL or advertised.get('route')!='/api/operation-schema'
            or advertised.get('readOnly') is not True or advertised.get('totalOperations')!=len(ops)
            or type(advertised.get('totalOperations')) is not int or advertised.get('maximumPageOperations')!=10
            or type(advertised.get('maximumPageOperations')) is not int
            or not isinstance(advertised.get('schemaDigest'),str) or not re.fullmatch('[a-f0-9]{64}',advertised['schemaDigest'])):
            raise ValueError()
    except (TypeError,KeyError,ValueError):raise Error('SCHEMA_PROTOCOL','Schema advertisement is invalid')
    if digest is not None and digest!=advertised['schemaDigest']:raise Error('SCHEMA_CONFLICT','Schema digest changed; restart discovery')
    value=backend.http('GET','/api/operation-schema'+('?' + urlencode(args) if args else ''))
    if value['session']!=meta['session']:raise Error('SCHEMA_SESSION_CHANGED','Editor session changed during schema identity check')
    if not value['ok']:return backend.wrap(value)
    try:
        result=value['result'];rows=result['operations'];total=result['total'];next_=result['nextOffset'];typed=result['typedStructureCount']
        if (result.get('protocol')!=PROTOCOL or result.get('readOnly') is not True or type(result.get('complete')) is not bool
            or result.get('schemaDigest')!=advertised['schemaDigest'] or type(total) is not int or total!=len(ops)
            or type(typed) is not int or not 0<=typed<=total or type(result.get('offset')) is not int or result['offset']!=offset
            or not isinstance(rows,list) or len(rows)>(1 if operation is not None else limit)):
            raise ValueError()
        names=[]
        for row in rows:
            if (not isinstance(row,dict) or not isinstance(row.get('operation'),str) or row['operation'] not in ops
                or not isinstance(row.get('inputSchema'),dict) or type(row.get('topLevelFieldsComplete')) is not bool
                or type(row.get('fullValueConstraintsComplete')) is not bool or row.get('sourceValidationRequired') is not True):
                raise ValueError()
            names.append(row['operation'])
        if operation is not None:
            if names!=[operation] or next_ is not None:raise ValueError()
        else:
            if offset>total or names!=ops[offset:offset+len(names)] or (not rows and offset<total):raise ValueError()
            end=offset+len(rows)
            if (next_ is not None and (type(next_) is not int or next_!=end or not offset<next_<total)) or (next_ is None and end!=total):raise ValueError()
        limits=result.get('limitations')
        if not isinstance(limits,list) or len(limits)>16 or any(not isinstance(x,str) or len(x)>2048 for x in limits):raise ValueError()
    except (KeyError,TypeError,ValueError):raise Error('SCHEMA_PROTOCOL','Schema response identity, shape or pagination is invalid')
    if len(encode(value))>MAX_SCHEMA:raise Error('SCHEMA_RESPONSE_LIMIT','Schema page exceeds48KiB HTTP-envelope budget')
    if backend.token.encode('utf-8') in encode(value):raise Error('SCHEMA_PROTOCOL','Schema response contains a configured private credential')
    wrapped=backend.wrap(value)
    if len(encode(wrapped))>MAX_OUTPUT:raise Error('RESPONSE_LIMIT','Schema helper response exceeds60KiB')
    return wrapped
