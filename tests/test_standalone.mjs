import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),temp=path.join(root,'tests/tmp');fs.mkdirSync(temp,{recursive:true});
const dir=fs.mkdtempSync(path.join(temp,'standalone-')),project=path.join(dir,'project'),calls=[];
const httpServer=http.createServer(async(req,res)=>{
  let raw='';for await(const b of req)raw+=b;const data=JSON.parse(raw);calls.push(data.cmd);
  if(data.cmd==='list_packages')await new Promise(r=>setTimeout(r,200));
  res.end(JSON.stringify({ok:true,revision:0,requestId:data.requestId,sessionId:'standalone-session',data:data.cmd==='ping'?{projectPath:project,sessionId:'standalone-session',frame:1,updatedAtMs:Date.now()}:[]}));
});
await new Promise(r=>httpServer.listen(0,'127.0.0.1',r));
fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({projectPath:project,publishDir:path.join(dir,'published'),screenshotDir:path.join(dir,'screenshots'),python:process.execPath,editorPath:process.execPath,host:'127.0.0.1',port:httpServer.address().port,token:'a'.repeat(64)}));
const child=spawn(process.execPath,[path.join(root,'server.mjs'),'--config',path.join(dir,'config.json')],{stdio:['pipe','pipe','pipe'],windowsHide:true});
let text='',stderr='',id=0;const pending=new Map(),errors=[];
child.stderr.on('data',b=>stderr+=b);
child.stdout.on('data',b=>{text+=b;let n;while((n=text.indexOf('\n'))>=0){const out=JSON.parse(text.slice(0,n));text=text.slice(n+1);if(out.id===null)errors.push(out);else{pending.get(out.id)?.(out);pending.delete(out.id);}}});
const rpc=(method,params={})=>{const seq=++id;return {id:seq,promise:new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('RPC timeout')),5000);pending.set(seq,out=>{clearTimeout(timer);resolve(out);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:seq,method,params})+'\n');})};};
let checks=0;const check=fn=>{fn();checks++;};
try{
  const init=await rpc('initialize',{protocolVersion:'2025-06-18'}).promise;check(()=>assert.equal(init.result.serverInfo.version,'0.7.1'));
  const list=await rpc('tools/list').promise;check(()=>assert.equal(list.result.tools.length,35));
  check(()=>assert(list.result.tools.every(x=>!x.name.startsWith('source_'))));
  check(()=>assert(list.result.tools.find(x=>x.name==='read_component').annotations.readOnlyHint));
  check(()=>assert(list.result.tools.find(x=>x.name==='delete_item').annotations.destructiveHint));
  const disabled=await rpc('tools/call',{name:'source_inspect'}).promise;check(()=>assert.equal(disabled.error.code,-32602));
  // Large unterminated input must be rejected before its eventual delimiter.
  child.stdin.write('x'.repeat(100000));
  const deadline=Date.now()+2000;while(!errors.length&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
  check(()=>assert.equal(errors[0]?.error.code,-32700));
  child.stdin.write('\n');const pong=await rpc('ping').promise;check(()=>assert.deepEqual(pong.result,{}));
  const first=rpc('tools/call',{name:'list_packages'}),second=rpc('tools/call',{name:'save_all'});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:second.id}})+'\n');
  await first.promise;const cancelled=await second.promise;check(()=>assert.equal(JSON.parse(cancelled.result.content[0].text).error.code,'REQUEST_CANCELLED'));
  check(()=>assert(!calls.includes('save_all')));
  child.stdin.end();const code=await new Promise(r=>child.on('exit',r));check(()=>assert.equal(code,0));check(()=>assert.equal(text,''));
  console.log(JSON.stringify({checks,passed:checks,failed:0,scope:'Standalone optional catalogue, bounded framing, queued cancellation, no editor execution'}));
}finally{child.kill();httpServer.closeAllConnections();await new Promise(r=>httpServer.close(r));}
