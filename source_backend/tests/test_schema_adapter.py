"""Adapter-only contract tests; fake endpoint responses, real dispatch and error classes."""
from pathlib import Path
import copy,json,sys,unittest,os
O=Path(__file__).resolve().parents[1];sys.path.insert(0,os.environ.get('FGUI_SCHEMA_ADAPTER_ROOT',str(O)))
from backend import BackendError
from operation_schemas import query

class Fake:
    token='private_schema_secret_'+'x'*40
    def __init__(self):
        self.calls=[];self.session='schema-session-12345';self.ops=['alpha','beta']
        self.ad=dict(protocol='fgui-operation-schemas/1',route='/api/operation-schema',readOnly=True,totalOperations=2,maximumPageOperations=10,schemaDigest='a'*64)
        self.meta=dict(ok=True,session=self.session,revision=0,result=dict(capabilities=dict(operations=self.ops,operationSchemas=self.ad)))
        self.value=dict(ok=True,session=self.session,revision=0,result=dict(protocol='fgui-operation-schemas/1',schemaDigest='a'*64,readOnly=True,complete=False,total=2,typedStructureCount=0,operations=[self.row(n) for n in self.ops],offset=0,nextOffset=None,limitations=['Nested schemas pending']))
    @staticmethod
    def row(n):return dict(operation=n,inputSchema=dict(type='object',properties={'planToken':{}}),topLevelFieldsComplete=True,fullValueConstraintsComplete=False,sourceValidationRequired=True)
    def metadata(self):self.calls.append('metadata');return copy.deepcopy(self.meta)
    def http(self,method,route):self.calls.append((method,route));return copy.deepcopy(self.value)
    def wrap(self,value):return dict(contract='fgui-rebuild-http/1',layer='independent-source-http',nativeEditorExecuted=False,**value)

class SchemaAdapterTests(unittest.TestCase):
    def setUp(self):self.b=Fake()
    def error(self,code,args=None):
        with self.assertRaises(BackendError) as e:query(self.b,{} if args is None else args,BackendError)
        self.assertEqual(e.exception.code,code)
    def test_success_readonly_no_ledger(self):
        r=query(self.b,{},BackendError);self.assertTrue(r['ok']);self.assertEqual(self.b.calls,['metadata',('GET','/api/operation-schema')]);self.assertFalse(r['nativeEditorExecuted'])
    def test_single_preserves_token_property_schema(self):
        self.b.value['result']['operations']=[Fake.row('alpha')]
        r=query(self.b,dict(operation='alpha'),BackendError);self.assertIn('planToken',r['result']['operations'][0]['inputSchema']['properties'])
    def test_unknown_field(self):self.error('INVALID_ARGUMENTS',dict(target='remote'))
    def test_null_operation(self):self.error('INVALID_ARGUMENTS',dict(operation=None))
    def test_path_operation(self):self.error('INVALID_ARGUMENTS',dict(operation='../other'))
    def test_mixed_operation_paging(self):self.error('INVALID_ARGUMENTS',dict(operation='alpha',limit=1))
    def test_boolean_offset(self):self.error('INVALID_ARGUMENTS',dict(offset=True))
    def test_negative_offset(self):self.error('INVALID_ARGUMENTS',dict(offset=-1))
    def test_oversize_offset(self):self.error('INVALID_ARGUMENTS',dict(offset=257))
    def test_zero_limit(self):self.error('INVALID_ARGUMENTS',dict(limit=0))
    def test_boolean_limit(self):self.error('INVALID_ARGUMENTS',dict(limit=True))
    def test_limit11(self):self.error('INVALID_ARGUMENTS',dict(limit=11))
    def test_bad_digest(self):self.error('INVALID_ARGUMENTS',dict(schemaDigest='wrong'))
    def test_continuation_without_digest(self):self.error('INVALID_ARGUMENTS',dict(offset=1))
    def test_changed_digest_preflight_no_page(self):
        self.error('SCHEMA_CONFLICT',dict(schemaDigest='b'*64));self.assertEqual(self.b.calls,['metadata'])
    def test_metadata_unavailable(self):
        self.b.meta=dict(ok=False,session=self.b.session,revision=0,error=dict(code='unauthorized'))
        self.assertFalse(query(self.b,{},BackendError)['ok']);self.assertEqual(len(self.b.calls),1)
    def test_absent_advertisement(self):
        self.b.meta['result']['capabilities'].pop('operationSchemas');self.error('SCHEMA_UNAVAILABLE')
    def test_arbitrary_route_rejected(self):self.b.ad['route']='http://elsewhere';self.error('SCHEMA_PROTOCOL')
    def test_bad_advertisement_protocol(self):self.b.ad['protocol']='other';self.error('SCHEMA_PROTOCOL')
    def test_bool_total(self):self.b.ad['totalOperations']=True;self.error('SCHEMA_PROTOCOL')
    def test_changed_session(self):self.b.value['session']='changed-session';self.error('SCHEMA_SESSION_CHANGED')
    def test_backend_error_preserved(self):
        self.b.value=dict(ok=False,session=self.b.session,revision=0,error=dict(code='unknown_operation'))
        self.assertEqual(query(self.b,{},BackendError)['error']['code'],'unknown_operation')
    def test_missing_result_fields(self):self.b.value['result'].pop('schemaDigest');self.error('SCHEMA_PROTOCOL')
    def test_page_digest_mismatch(self):self.b.value['result']['schemaDigest']='b'*64;self.error('SCHEMA_PROTOCOL')
    def test_not_readonly(self):self.b.value['result']['readOnly']=False;self.error('SCHEMA_PROTOCOL')
    def test_boolean_total_page(self):self.b.value['result']['total']=True;self.error('SCHEMA_PROTOCOL')
    def test_nonbool_complete(self):self.b.value['result']['complete']=0;self.error('SCHEMA_PROTOCOL')
    def test_duplicate_rows(self):self.b.value['result']['operations']=[Fake.row('alpha'),Fake.row('alpha')];self.error('SCHEMA_PROTOCOL')
    def test_reordered_rows(self):self.b.value['result']['operations'].reverse();self.error('SCHEMA_PROTOCOL')
    def test_silent_truncation(self):self.b.value['result']['operations'].pop();self.error('SCHEMA_PROTOCOL')
    def test_zero_progress(self):self.b.value['result']['operations']=[];self.b.value['result']['nextOffset']=0;self.error('SCHEMA_PROTOCOL')
    def test_bad_schema_shape(self):self.b.value['result']['operations'][0]['inputSchema']='not-a-schema';self.error('SCHEMA_PROTOCOL')
    def test_invalid_coverage(self):self.b.value['result']['operations'][0]['fullValueConstraintsComplete']=None;self.error('SCHEMA_PROTOCOL')
    def test_valid_short_page(self):
        self.b.value['result'].update(operations=[Fake.row('alpha')],nextOffset=1);self.assertEqual(query(self.b,dict(limit=1),BackendError)['result']['nextOffset'],1)
    def test_valid_continuation(self):
        self.b.value['result'].update(operations=[Fake.row('beta')],offset=1);self.assertIsNone(query(self.b,dict(offset=1,schemaDigest='a'*64),BackendError)['result']['nextOffset'])
    def test_empty_terminal_page(self):
        self.b.value['result'].update(operations=[],offset=2);self.assertEqual(query(self.b,dict(offset=2,schemaDigest='a'*64),BackendError)['result']['operations'],[])
    def test_private_credential_not_returned(self):
        self.b.value['result']['operations'][0]['inputSchema']['const']=self.b.token;self.error('SCHEMA_PROTOCOL')
    def test_48k_budget(self):
        self.b.value['result']['operations'][0]['inputSchema']['description']='x'*50000;self.error('SCHEMA_RESPONSE_LIMIT')
if __name__=='__main__':unittest.main(verbosity=2)
