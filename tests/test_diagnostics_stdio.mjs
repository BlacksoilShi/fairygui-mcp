import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const PY=process.env.FGUI_TEST_PYTHON;
assert(PY,'FGUI_TEST_PYTHON must pin the interpreter for this test');
const base=process.env.FGUI_DIAGNOSTICS_WORK||path.join(ROOT,'tests/tmp');
fs.mkdirSync(base,{recursive:true});
const W=fs.mkdtempSync(path.join(base,'diag-stdio-'));
let checks=0;const check=(a,b)=>{assert.deepEqual(a,b);checks++;};
const project=path.join(W,'project');fs.mkdirSync(project);
fs.writeFileSync(path.join(project,'Fixture.fairy'),'{}');
const token=crypto.randomBytes(32).toString('hex');
let mode='connected',calls=0;
const endpoint=http.createServer(async(req,res)=>{
 let raw='';for await(const b of req)raw+=b;
 const body=JSON.parse(raw);calls++;
 check(body.cmd,'ping');check(req.headers.authorization,'Bearer '+token);
 if(mode==='auth'){res.writeHead(401);res.end('private-error-not-returned');return;}
 if(mode==='reset'){res.destroy();return;}
 if(mode==='redirect'){res.writeHead(302,{Location:'http://127.0.0.1:1/never'});res.end();return;}
 const data={version:'0.6.0',revision:0,ready:true,busy:false,sessionId:'fixture-stdio-session',projectPath:mode==='wrong-project'?path.join(W,'other'):project,updatedAtMs:Date.now()};
 res.end(JSON.stringify({ok:true,requestId:body.requestId,revision:0,sessionId:data.sessionId,data}));
});
await new Promise(r=>endpoint.listen(0,'127.0.0.1',r));
const config={projectPath:project,editorPath:PY,python:PY,host:'127.0.0.1',port:endpoint.address().port,token,publishDir:path.join(W,'published'),screenshotDir:path.join(W,'screens')};
const cfg=path.join(W,'config.json');fs.writeFileSync(cfg,JSON.stringify(config));
const child=spawn(process.execPath,[path.join(ROOT,'server.mjs'),'--config',cfg],{stdio:['pipe','pipe','pipe'],windowsHide:true});
let buffer='',stderr='',id=0;const pending=new Map();let closed;
const exited=new Promise(r=>{closed=r;child.on('close',r);});
child.stderr.on('data',b=>stderr+=b.toString());
child.stdout.on('data',b=>{buffer+=b;let n;while((n=buffer.indexOf('\n'))>=0){const s=buffer.slice(0,n);buffer=buffer.slice(n+1);const j=JSON.parse(s);const p=pending.get(j.id);if(p){clearTimeout(p.timer);pending.delete(j.id);p.resolve(j);}}});
function rpc(method,params={}){return new Promise((resolve,reject)=>{const seq=++id;const timer=setTimeout(()=>{pending.delete(seq);reject(Error('RPC deadline'));},10000);pending.set(seq,{resolve,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:seq,method,params})+'\n');});}
async function call(args={}){const raw=await rpc('tools/call',{name:'bridge_diagnostics',arguments:args});return {raw,value:JSON.parse(raw.result.content[0].text)};}
try{
 const initial=fs.readFileSync(cfg);
 await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'diagnostic-stdio-test',version:'1'}});
 const list=await rpc('tools/list');check(list.result.tools.length,35);
 const schema=list.result.tools.find(t=>t.name==='bridge_diagnostics');
 check(schema.inputSchema.additionalProperties,false);check(schema.annotations.readOnlyHint,true);check(schema.annotations.destructiveHint,false);
 const good=await call();check(good.raw.result.isError,false);check(good.value.data.connection.status,'connected');check(good.value.data.execution.editorStarted,false);check(good.value.data.plugin.status,'missing');
 check(JSON.stringify(good).includes(token),false);check(fs.existsSync(path.join(project,'plugins')),false);
 const count=calls;const bad=await call({project:'arbitrary'});check(bad.raw.result.isError,true);check(calls,count);
 mode='auth';const auth=await call();check(auth.value.data.connection.status,'authentication_rejected');check(JSON.stringify(auth).includes('private-error-not-returned'),false);
 mode='wrong-project';check((await call()).value.data.connection.status,'project_identity');
 mode='redirect';check((await call()).value.data.connection.status,'redirect_rejected');
 mode='reset';check((await call()).value.data.connection.status,'endpoint_unreachable');
 await new Promise(r=>endpoint.close(r));const offline=(await call()).value.data.connection.status;check(['endpoint_unreachable','timeout'].includes(offline),true);
 check(fs.readFileSync(cfg).equals(initial),true);check(stderr,'[fgui-mcp] fixed-project stdio ready; transport is loopback/Bearer, no global discovery\n');
 child.stdin.end();check(await exited,0);
 console.log(JSON.stringify({passed:true,checks,scope:'Actual stdio server and Python helper with real loopback HTTP; fixture endpoint, not original editor',configurationUnchanged:true,work:W}));
}finally{
 for(const p of pending.values())clearTimeout(p.timer);
 if(child.exitCode===null){child.kill();await exited;}
 if(endpoint.listening)await new Promise(r=>endpoint.close(r));
}
