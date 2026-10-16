import assert from 'node:assert/strict';
import {ProjectBridge} from '../lib/core.mjs';
const config={projectPath:process.cwd(),host:'127.0.0.1',port:17931,token:'fixture'};
let session='first',revision=0,hold=false,release,seen=[];
const bridge=new ProjectBridge(config,process.cwd(),{fetchImpl:async(_url,options)=>{
  const body=JSON.parse(options.body);seen.push(body);
  const response=new Response(JSON.stringify({ok:true,revision,sessionId:session,requestId:body.requestId,data:body.cmd==='ping'?{projectPath:config.projectPath,sessionId:session,frame:1,updatedAtMs:Date.now()}: {}}));
  if(hold){hold=false;return new Promise(resolve=>{release=()=>resolve(response);});}
  return response;
}});
await bridge.ping();assert.equal(bridge.revision,0);
hold=true;const stalePing=bridge.ping();revision=1;
await bridge.http('controller_select',{});assert.equal(seen.at(-1).expectedRevision,0);
release();await stalePing;assert.equal(bridge.revision,1,'delayed read must not regress revision');
await bridge.http('controller_remove',{});assert.equal(seen.at(-1).expectedRevision,1);
session='second';revision=0;await bridge.ping();assert.equal(bridge.revision,0,'new session resets revision');
hold=true;const oldRead=bridge.http('project_info',{});session='third';revision=0;await bridge.ping();
release();await assert.rejects(oldRead,e=>e.code==='SESSION_MISMATCH');assert.equal(bridge.sessionId,'third');
hold=true;const oldPing=bridge.ping();session='fourth';revision=0;await bridge.ping();
release();await assert.rejects(oldPing,e=>e.code==='STALE_OBSERVATION');assert.equal(bridge.sessionId,'fourth');assert.equal(bridge.revision,0);
console.log(JSON.stringify({checks:9,passed:9,scope:'Mocked delayed HTTP responses; no native execution'}));
