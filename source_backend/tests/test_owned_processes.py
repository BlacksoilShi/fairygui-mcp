import os,pathlib,subprocess,sys,tempfile,time,unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]))
from owned_processes import OwnedProcesses
from preview_jobs import identity,alive
class OwnedProcessTests(unittest.TestCase):
 def test_windows_contained_child_and_unrelated_owned_control(self):
  if os.name!='nt':self.skipTest('Windows Job Object execution only')
  exe=getattr(sys,'_base_executable',sys.executable);job=OwnedProcesses();a=b=None
  try:
   a=subprocess.Popen([exe,'-c','import time;time.sleep(30)'],creationflags=subprocess.CREATE_NO_WINDOW)
   b=subprocess.Popen([exe,'-c','import time;time.sleep(30)'],creationflags=subprocess.CREATE_NO_WINDOW)
   node=identity(a.pid);control=identity(b.pid);job.assign(a)
   self.assertIn(a.pid,job.pids());self.assertNotIn(b.pid,job.pids())
   job.close();self.assertIsNotNone(a.wait(timeout=5));self.assertFalse(alive(node));self.assertTrue(alive(control));self.assertIsNone(b.poll())
  finally:
   job.close()
   for child in [a,b]:
    if child and child.poll() is None:child.terminate();child.wait(timeout=5)
 def test_close_idempotent(self):
  j=OwnedProcesses();self.assertEqual(j.pids(),[]);j.close();j.close()
if __name__=='__main__':unittest.main()
