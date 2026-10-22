from pathlib import Path
import copy, json, os, sys, tempfile, unittest
O=Path(__file__).resolve().parents[1];sys.path.insert(0,str(O))
from backend import Backend,BackendError,decode
from service_binding import resolve,PROTOCOL
class BindingTests(unittest.TestCase):
 def setUp(self):
  work=O.parent/'tests/tmp';work.mkdir(parents=True,exist_ok=True)
  self.tmp=tempfile.TemporaryDirectory(prefix='binding-',dir=work);self.root=Path(self.tmp.name)
  self.project=self.root/'project/A.fairy';self.project.parent.mkdir();self.project.write_text('{}')
  self.receipts=self.root/'receipts';self.path=self.root/'legacy.json'
  self.base=dict(contract='fgui-rebuild-http/1',projectPath=str(self.project),receiptDir=str(self.receipts),port=18180,token='private_'+'a'*40,timeoutSeconds=15,uploadRoots=[])
  self.profile=dict(serviceBinding=dict(protocol=PROTOCOL,configPath=str(self.path),projectPath=str(self.project),receiptDir=str(self.receipts)))
  self.write(self.base)
 def tearDown(self):self.tmp.cleanup()
 def write(self,value):
  temp=self.path.with_suffix('.new');temp.write_text(json.dumps(value),encoding='utf8');os.replace(temp,self.path)
 def result(self,p=None):return resolve(self.profile if p is None else p,decode,BackendError)
 def bad(self,code,profile=None):
  with self.assertRaises(BackendError) as cm:self.result(profile)
  self.assertEqual(cm.exception.code,code)
  self.assertNotIn(self.base['token'],str(cm.exception))
 def test_legacy_unchanged(self):self.assertIs(resolve(self.base,decode,BackendError),self.base)
 def test_literal_backend_constructs(self):
  b=Backend(self.base);self.assertEqual(b.token,self.base['token'])
 def test_bound_backend_constructs(self):
  b=Backend(self.profile);self.assertEqual(b.port,self.base['port']);self.assertEqual(b.project,self.project)
 def test_resolved_config_equal(self):self.assertEqual(self.result(),self.base)
 def test_single_read_inherits_token_rotation(self):
  before=self.result();self.base.update(port=18181,token='changed_'+'b'*40);self.write(self.base);after=self.result()
  self.assertNotEqual(before['token'],after['token']);self.assertEqual(after,self.base)
 def test_existing_instance_keeps_snapshot(self):
  b=Backend(self.profile);old=b.token;self.base['token']='rotated_'+'c'*40;self.write(self.base)
  self.assertEqual(b.token,old);self.assertNotEqual(Backend(self.profile).token,old)
 def test_browser_overlay_only_new_profile(self):
  self.profile['browserPreview']={'node':'fixture'};self.assertEqual(self.result()['browserPreview'],{'node':'fixture'});self.assertNotIn('browserPreview',json.loads(self.path.read_text()))
 def test_no_mutation(self):
  profile=copy.deepcopy(self.profile);raw=self.path.read_bytes();self.result()
  self.assertEqual(profile,self.profile);self.assertEqual(raw,self.path.read_bytes())
 def test_token_override_rejected(self):
  self.profile['token']='shadow_'+'d'*40;self.bad('CONFIG_BINDING_INVALID')
 def test_port_override_rejected(self):self.profile['port']=18182;self.bad('CONFIG_BINDING_INVALID')
 def test_project_override_rejected(self):self.profile['projectPath']=str(self.project);self.bad('CONFIG_BINDING_INVALID')
 def test_upload_override_rejected(self):self.profile['uploadRoots']=[];self.bad('CONFIG_BINDING_INVALID')
 def test_binding_unknown_field(self):self.profile['serviceBinding']['extra']=True;self.bad('CONFIG_BINDING_INVALID')
 def test_binding_missing_field(self):del self.profile['serviceBinding']['receiptDir'];self.bad('CONFIG_BINDING_INVALID')
 def test_binding_null(self):self.profile['serviceBinding']=None;self.bad('CONFIG_BINDING_INVALID')
 def test_wrong_protocol(self):self.profile['serviceBinding']['protocol']='other';self.bad('CONFIG_BINDING_INVALID')
 def test_relative_config(self):self.profile['serviceBinding']['configPath']='legacy.json';self.bad('CONFIG_BINDING_INVALID')
 def test_relative_project(self):self.profile['serviceBinding']['projectPath']='project/A.fairy';self.bad('CONFIG_BINDING_INVALID')
 def test_relative_receipts(self):self.profile['serviceBinding']['receiptDir']='receipts';self.bad('CONFIG_BINDING_INVALID')
 def test_missing_config(self):self.path.unlink();self.bad('CONFIG_BINDING_UNAVAILABLE')
 def test_directory_config(self):self.path.unlink();self.path.mkdir();self.bad('CONFIG_BINDING_UNAVAILABLE')
 def test_malformed_json(self):self.path.write_text('{broken:'+self.base['token']);self.bad('CONFIG_BINDING_INVALID')
 def test_duplicate_json(self):self.path.write_text('{"token":"a","token":"b"}');self.bad('CONFIG_BINDING_INVALID')
 def test_oversized_config(self):self.path.write_bytes(b' '*61441);self.bad('CONFIG_BINDING_INVALID')
 def test_base_not_object(self):self.write([]);self.bad('CONFIG_BINDING_INVALID')
 def test_base_field_missing(self):del self.base['token'];self.write(self.base);self.bad_without_secret('CONFIG_BINDING_INVALID')
 def bad_without_secret(self,code):
  with self.assertRaises(BackendError) as cm:self.result()
  self.assertEqual(cm.exception.code,code)
 def test_base_unknown_field(self):self.base['other']=True;self.write(self.base);self.bad('CONFIG_BINDING_INVALID')
 def test_base_recursive_binding(self):self.base['serviceBinding']=self.profile['serviceBinding'];self.write(self.base);self.bad('CONFIG_BINDING_INVALID')
 def test_base_browser_not_inherited(self):self.base['browserPreview']={};self.write(self.base);self.bad('CONFIG_BINDING_INVALID')
 def test_base_wrong_project(self):self.base['projectPath']=str(self.root/'other.fairy');self.write(self.base);self.bad('CONFIG_BINDING_MISMATCH')
 def test_base_wrong_receipts(self):self.base['receiptDir']=str(self.root/'other-receipts');self.write(self.base);self.bad('CONFIG_BINDING_MISMATCH')
 def test_base_relative_project(self):self.base['projectPath']='A.fairy';self.write(self.base);self.bad('CONFIG_BINDING_INVALID')
 def test_base_bad_token_still_validated(self):
  self.base['token']='short';self.write(self.base)
  with self.assertRaises(BackendError) as cm:Backend(self.profile)
  self.assertEqual(cm.exception.code,'CONFIG_INVALID')
 def test_base_wrong_contract_still_validated(self):
  self.base['contract']='other';self.write(self.base)
  with self.assertRaises(BackendError) as cm:Backend(self.profile)
  self.assertEqual(cm.exception.code,'CONFIG_INVALID')
 def test_base_bad_port_still_validated(self):
  self.base['port']=True;self.write(self.base)
  with self.assertRaises(BackendError) as cm:Backend(self.profile)
  self.assertEqual(cm.exception.code,'CONFIG_INVALID')
 def test_error_redacted(self):
  self.profile['serviceBinding']['configPath']=str(self.root/self.base['token']/'missing.json')
  self.bad('CONFIG_BINDING_UNAVAILABLE')
 def test_reparse_file_rejected(self):
  from unittest.mock import patch
  from types import SimpleNamespace
  original=Path.lstat
  def stat(p,*a,**k):return SimpleNamespace(st_file_attributes=0x400,st_mode=original(p,*a,**k).st_mode) if p==self.path else original(p,*a,**k)
  with patch.object(Path,'lstat',stat):self.bad('CONFIG_BINDING_INVALID')
 def test_symlink_marked_path_rejected(self):
  from unittest.mock import patch
  original=Path.is_symlink
  with patch.object(Path,'is_symlink',lambda p:True if p==self.path else original(p)):self.bad('CONFIG_BINDING_INVALID')
if __name__=='__main__':unittest.main(verbosity=2)
