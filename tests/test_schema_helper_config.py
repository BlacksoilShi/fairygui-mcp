import importlib.util,json,sys,tempfile,unittest,os
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from helper import Helper
class SchemaHelperConfigTests(unittest.TestCase):
    def setUp(self):
        work=Path(os.environ.get('FGUI_DIAGNOSTICS_WORK',ROOT/'tests/tmp'));work.mkdir(parents=True,exist_ok=True)
        self.tmp=tempfile.TemporaryDirectory(dir=work);self.addCleanup(self.tmp.cleanup);self.w=Path(self.tmp.name);p=self.w/'project';p.mkdir()
        self.path=self.w/'config.json';self.base=dict(projectPath=str(p),editorPath=str(ROOT/'helper.py'),python=sys.executable,host='127.0.0.1',port=17931,token='x'*64,publishDir=str(self.w/'out'),screenshotDir=str(self.w/'screens'))
    def load(self,**values):self.path.write_text(json.dumps(dict(self.base,**values)));return Helper(self.path)
    def source(self):return dict(sourceHelper=str(self.w/'backend.py'),sourceConfig=str(self.w/'backend.json'),sourceProtocol='fgui-rebuild-http/1')
    def test_absent_legacy(self):self.load()
    def test_false_without_source(self):self.load(sourceSchemas=False)
    def test_true_with_matching_source(self):self.load(sourceSchemas=True,**self.source())
    def test_true_without_matching_source(self):
        with self.assertRaises(ValueError):self.load(sourceSchemas=True)
    def test_nonboolean_with_matching_source(self):
        for v in ['true',1,None]:
            with self.subTest(value=v),self.assertRaises(ValueError):self.load(sourceSchemas=v,**self.source())
    def test_config_never_modified(self):
        self.path.write_text(json.dumps(dict(self.base,sourceSchemas=True,**self.source())));before=self.path.read_bytes();Helper(self.path);self.assertEqual(before,self.path.read_bytes())
if __name__=='__main__':unittest.main(verbosity=2)
