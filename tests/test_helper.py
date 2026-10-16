import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('helper_under_test',ROOT/'helper.py')
h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)

class HelperTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir=ROOT/'tests/tmp')
        self.root=Path(self.temp.name);self.project=self.root/'project';self.project.mkdir()
        (self.project/'sample.fairy').write_text('{}')
        self.config=self.root/'config.json'
        self.value=dict(projectPath=str(self.project),editorPath=str(ROOT/'helper.py'),python=str(Path(os.sys.executable)),host='127.0.0.1',port=18123,token='x'*64,publishDir=str(self.root/'published'),screenshotDir=str(self.root/'screens'))
        self.save();self.helper=h.Helper(self.config)
    def tearDown(self):self.temp.cleanup()
    def save(self):self.config.write_text(json.dumps(self.value))
    def test_no_demo_dependency(self):self.assertEqual(self.helper.project,self.project)
    def test_reject_unknown_config(self):
        self.value['extra']=True;self.save()
        with self.assertRaises(ValueError):h.Helper(self.config)
    def test_reject_invalid_port(self):
        for port in [True,0,65536,1.5]:
            self.value['port']=port;self.save()
            with self.assertRaises(ValueError):h.Helper(self.config)
    def test_reject_token(self):
        self.value['token']='short';self.save()
        with self.assertRaises(ValueError):h.Helper(self.config)
    def test_reject_overlapping_output(self):
        self.value['publishDir']=str(self.project/'out');self.save()
        with self.assertRaises(ValueError):h.Helper(self.config)
    def test_reject_output_parent(self):
        self.value['publishDir']=str(self.root);self.save()
        with self.assertRaises(ValueError):h.Helper(self.config)
    def test_duplicate_json(self):
        with self.assertRaises(ValueError):h.decode('{"x":1,"x":2}')
    def test_nonfinite_json(self):
        with self.assertRaises(ValueError):h.decode('{"x":NaN}')
    def test_install_idempotent(self):
        self.helper.install();self.helper.install()
        config=h.read_json(self.project/'plugins/fgui-agent-bridge-custom/config.json')
        self.assertNotIn('python',config);self.assertEqual(config['port'],18123)
    def test_conflicting_plugin_untouched(self):
        d=self.project/'plugins/fgui-agent-bridge-custom';d.mkdir(parents=True);(d/'main.js').write_text('existing')
        with self.assertRaises(h.HelperError):self.helper.install()
        self.assertEqual((d/'main.js').read_text(),'existing');self.assertFalse((d/'config.json').exists())
    def fixture(self):
        package=self.project/'assets/Arbitrary';package.mkdir(parents=True)
        (package/'package.xml').write_text('<packageDescription id="12345678"/>')
        self.helper.publish.mkdir();out=self.helper.publish/'Arbitrary.bytes';out.write_bytes(b'FGUI'+(7).to_bytes(4,'big')+b'\x00\x00\x0812345678'+b'\x00'*20)
        return out
    def test_general_package_manifest(self):
        self.fixture();result=self.helper.verify_publish({'pkg':'12345678','startedAtMs':int(time.time()*1000)})
        self.assertTrue(result['verified']);self.assertFalse(result['semanticDecoded'])
    def test_native_fui_suffix(self):
        file=self.fixture();file.rename(file.with_name('Arbitrary_fui.bytes'))
        self.assertTrue(self.helper.verify_publish({'pkg':'Arbitrary','startedAtMs':int(time.time()*1000)})['verified'])
    def test_wrong_package_id(self):
        file=self.fixture();file.write_bytes(file.read_bytes().replace(b'12345678',b'87654321'))
        with self.assertRaises(h.HelperError):self.helper.verify_publish({'pkg':'Arbitrary','startedAtMs':int(time.time()*1000)})
    def test_stale_artifact_rejected(self):
        file=self.fixture();os.utime(file,(1,1))
        with self.assertRaises(h.HelperError):self.helper.verify_publish({'pkg':'Arbitrary','startedAtMs':int(time.time()*1000)})
    def test_wrong_magic_rejected(self):
        self.fixture().write_bytes(b'nope')
        with self.assertRaises(h.HelperError):self.helper.verify_publish({'pkg':'Arbitrary','startedAtMs':int(time.time()*1000)})
    def test_mismatched_package_rejected(self):
        self.fixture()
        with self.assertRaises(h.HelperError):self.helper.verify_publish({'pkg':'Other','startedAtMs':int(time.time()*1000)})
    def test_attaches_without_install_or_launch(self):
        if os.name!='nt':self.skipTest('Windows launcher')
        with patch.object(self.helper,'ping',return_value={'ready':True}),patch.object(self.helper,'install') as install,patch.object(h.subprocess,'Popen') as popen:
            self.assertTrue(self.helper.start()['attached']);install.assert_not_called();popen.assert_not_called()

if __name__=='__main__':
    (ROOT/'tests/tmp').mkdir(parents=True,exist_ok=True)
    unittest.main()
