import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../',import.meta.url)),base=path.join(root,'tests/tmp');
fs.mkdirSync(base,{recursive:true});
const work=fs.mkdtempSync(path.join(base,'profiles-'));
const project=path.join(work,'project');fs.mkdirSync(project);fs.writeFileSync(path.join(project,'Fixture.fairy'),'{}');
const common={projectPath:project,editorPath:process.execPath,python:process.env.FGUI_TEST_PYTHON||process.execPath,host:'127.0.0.1',port:17931,token:'fixture_'+'a'.repeat(64),publishDir:path.join(work,'published'),screenshotDir:path.join(work,'screens')};
const source={sourceHelper:path.join(root,'source_backend/backend.py'),sourceConfig:path.join(work,'backend.json')};
const profiles=[['native',{},35],['legacy-source',source,39]];
for(let mask=0;mask<8;mask++)profiles.push(['generic-'+mask,{...source,sourceProtocol:'fgui-rebuild-http/1',sourceUploads:!!(mask&1),sourceSchemas:!!(mask&2),sourcePreviews:!!(mask&4)},39+((mask&1)?1:0)+((mask&2)?1:0)+((mask&4)?1:0)]);
const rows=[];
for(const [name,extra,count] of profiles){
 const cfg=path.join(work,name+'.json');fs.writeFileSync(cfg,JSON.stringify({...common,...extra}));
 const child=spawn(process.execPath,[path.join(root,'server.mjs'),'--config',cfg],{stdio:['pipe','pipe','pipe'],windowsHide:true});
 let text='',stderr='';const waiters=new Map();let id=0;
 const done=new Promise(resolve=>child.on('close',resolve));
 child.stderr.on('data',b=>stderr+=b);
 child.stdout.on('data',b=>{text+=b;let n;while((n=text.indexOf('\n'))>=0){const line=text.slice(0,n);text=text.slice(n+1);const reply=JSON.parse(line);const pending=waiters.get(reply.id);if(pending){waiters.delete(reply.id);clearTimeout(pending.timer);pending.resolve(reply);}}});
 const rpc=(method,params={})=>new Promise((resolve,reject)=>{const seq=++id;const timer=setTimeout(()=>reject(Error('RPC timeout '+name)),10000);waiters.set(seq,{resolve,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:seq,method,params})+'\n');});
 try{
  const init=await rpc('initialize',{protocolVersion:'2025-06-18'});assert.equal(init.result.serverInfo.version,'0.7.0');
  const list=await rpc('tools/list'),tools=list.result.tools,names=tools.map(t=>t.name);
  assert.equal(tools.length,count,name);assert.equal(new Set(names).size,count);
  assert(names.includes('bridge_diagnostics'));assert.equal(names.includes('source_operation_schema'),extra.sourceSchemas===true);
  assert.equal(names.includes('source_preview'),extra.sourcePreviews===true);
  assert.equal(names.includes('source_sound_upload'),extra.sourceUploads===true);
  assert.equal(tools.find(t=>t.name==='bridge_diagnostics').annotations.readOnlyHint,true);
  if(extra.sourceSchemas)assert.equal(tools.find(t=>t.name==='source_operation_schema').annotations.readOnlyHint,true);
  if(extra.sourcePreviews)assert.equal(tools.find(t=>t.name==='source_preview').annotations.readOnlyHint,false);
  rows.push({profile:name,tools:count,names});
 }finally{child.stdin.end();assert.equal(await done,0,stderr);}
}
console.log(JSON.stringify({passed:true,profiles:rows.length,rows,scope:'Actual tools/list across portable package profiles; no backend dispatch'}));
