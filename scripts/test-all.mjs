// One offline entrypoint; no native editor, external backend or browser is launched.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const work=path.join(root,'tests','tmp');fs.mkdirSync(work,{recursive:true});
const requested=process.env.FGUI_TEST_PYTHON||'python';
const probe=spawnSync(requested,['-c','import sys; print(sys.executable)'],{encoding:'utf8',windowsHide:true,timeout:15000});
if(probe.status!==0)throw Error('Python 3.11+ required; set FGUI_TEST_PYTHON to its absolute path: '+probe.stderr);
const python=probe.stdout.trim();
const env={...process.env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',FGUI_TEST_PYTHON:python,FGUI_RELEASE_PYTHON:python,FGUI_DIAGNOSTICS_WORK:work,FGUI_PREVIEW_TEST_ROOT:work,TEMP:work,TMP:work};
delete env.PYTHONPATH;delete env.FGUI_SCHEMA_ADAPTER_ROOT;
env.PYTHONPYCACHEPREFIX=process.env.PYTHONPYCACHEPREFIX||path.join(work,'pycache');
const node=process.execPath;
const groups=[
 ['plugin-build',[node,'scripts/build-plugin.mjs','--check']],
 ...['test_lines.mjs','test_revision.mjs','test_server_transport.mjs','test_standalone.mjs'].map(n=>[n,[node,'tests/'+n]]),
 ['native-plugin-offline',[node,'plugin/tests/offline.cjs']],
 ['release-install',[node,'tests/test_release.mjs']],
 ...['test_helper.py','test_publish_owner.py','test_recovery_helper.py','test_diagnostics.py'].map(n=>[n,[python,'tests/'+n]]),
 ['diagnostics-stdio',[node,'tests/test_diagnostics_stdio.mjs']],
 ['schema-config',[node,'tests/test_schema_config.mjs']],
 ['schema-helper-config',[python,'tests/test_schema_helper_config.py']],
 ['preview-config',[node,'tests/test_preview_config.mjs']],
 ['preview-helper-config',[python,'tests/test_preview_helper_config.py']],
 ['adapter-unittest',[python,'-m','unittest','discover','-s','source_backend/tests','-p','test_*.py']],
 ['browser-host-validation',[node,'source_backend/tests/test_browser_preview.cjs']],
 ['tool-profile-matrix',[node,'tests/test_tool_profiles.mjs']],
];
const report={passed:false,scope:'offline protocol/configuration/ownership/packaging tests, not actual editor or browser parity',python,node,groups:[]};
const reportPath=process.env.FGUI_TEST_REPORT||path.join(work,'test-all-report.json');
for(const [name,argv] of groups){
 const p=spawnSync(argv[0],argv.slice(1),{cwd:root,env,encoding:'utf8',windowsHide:true,timeout:180000,maxBuffer:32*1024*1024});
 report.groups.push({name,argv,cwd:root,exitCode:p.status,signal:p.signal,error:p.error?.message||null,stdout:p.stdout,stderr:p.stderr});
 fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
 process.stdout.write(name+': '+(p.status===0?'PASS':'FAIL')+'\n');
 if(p.status!==0){process.stderr.write((p.stderr||'')+(p.error?.message||''));process.exit(1);}
}
report.passed=true;fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({passed:true,groups:groups.length,report:reportPath}));
