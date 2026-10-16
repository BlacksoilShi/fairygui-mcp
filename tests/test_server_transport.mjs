// Own mock transport tests. No original editor/SDK/plugin or upstream test code runs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseJsonStrict,validate,loadConfig,confinedPath,ProjectBridge} from '../lib/core.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),ROOT=path.dirname(HERE),TMP=path.join(HERE,'tmp');fs.mkdirSync(TMP,{recursive:true});
const work=fs.mkdtempSync(path.join(TMP,'transport-')),project=path.join(work,'project'),publish=path.join(work,'published'),screens=path.join(work,'screens');
for(const p of [project,publish,screens])fs.mkdirSync(p,{recursive:true});
const token=crypto.randomBytes(32).toString('hex'),session=crypto.randomUUID(),seen=[],checks=[];let mode='normal',active=0,maxActive=0;
const check=(name,fn)=>{fn();checks.push(name);if(process.env.FGUI_TRANSPORT_TEST_TRACE)console.error('CHECK '+checks.length+' '+name);};
const rejects=async(name,fn,code)=>{await assert.rejects(fn,e=>e.code===code);checks.push(name);if(process.env.FGUI_TRANSPORT_TEST_TRACE)console.error('CHECK '+checks.length+' '+name);};
check('strict JSON rejects duplicate',()=>assert.throws(()=>parseJsonStrict('{"a":1,"a":2}')));
check('strict JSON nested duplicate',()=>assert.throws(()=>parseJsonStrict('{"a":{"b":1,"b":2}}')));
check('strict JSON valid escaping/nesting',()=>assert.deepEqual(parseJsonStrict('{"a":[1,true,null,"a\\\"b"]}'),{a:[1,true,null,'a"b']}));
const closed={type:'object',properties:{text:{type:'string',maxLength:8}},required:['text'],additionalProperties:false};
check('schema rejects unknown keys',()=>assert.throws(()=>validate(closed,{text:'ok',path:'arbitrary'}),e=>e.code==='INVALID_ARGUMENTS'));
check('schema rejects malformed XML text',()=>assert.throws(()=>validate(closed,{text:'\u0000'})));
check('schema rejects lone UTF16 surrogate',()=>assert.throws(()=>validate(closed,{text:'\ud800'})));
check('schema rejects prototype keys',()=>assert.throws(()=>validate(closed,JSON.parse('{"text":"x","__proto__":{}}'))));
check('confined PNG path accepts',()=>assert.equal(confinedPath(path.join(screens,'ok.png'),screens,'.png'),path.join(screens,'ok.png')));
check('confined PNG rejects traversal',()=>assert.throws(()=>confinedPath(path.join(screens,'../else.png'),screens,'.png')));
check('confined PNG rejects extension',()=>assert.throws(()=>confinedPath(path.join(screens,'bad.exe'),screens,'.png')));
const server=http.createServer(async(req,res)=>{
 let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);seen.push({body,authorization:req.headers.authorization});
 if(req.headers.authorization!=='Bearer '+token){res.statusCode=401;res.end(JSON.stringify({ok:false,error:{code:'AUTH_FAILED'},requestId:body.requestId,sessionId:session}));return;}
 const data=body.cmd==='ping'?{frame:10,updatedAtMs:Date.now(),sessionId:session,projectPath:mode==='wrong-project'?path.join(work,'other'):project}:body.cmd==='publish'?{isSuccess:mode!=='publish-false',files:[]}: {command:body.cmd};
 if(body.cmd!=='ping'){active++;maxActive=Math.max(maxActive,active);await new Promise(r=>setTimeout(r,40));active--;}
 const reply={ok:true,revision:0,data,requestId:mode==='bad-request-id'?'wrong':body.requestId,sessionId:session};
 if(mode==='large'){res.end(JSON.stringify({...reply,padding:'x'.repeat(70000)}));return;}
 if(mode==='bad-json'){res.end('{broken');return;}
 res.end(JSON.stringify(reply));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const config={projectPath:project,port:server.address().port,host:'127.0.0.1',token,publishDir:publish,screenshotDir:screens,sourceProject:project,python:process.execPath,node:process.execPath,editorPath:process.execPath};
const configFile=path.join(work,'config.json');fs.writeFileSync(configFile,JSON.stringify(config));
const bridge=new ProjectBridge(loadConfig(configFile),configFile);
try{
 check('config fixed host/token',()=>{assert.equal(loadConfig(configFile).host,'127.0.0.1');});
 const invalid=path.join(work,'invalid.json');fs.writeFileSync(invalid,JSON.stringify({...config,host:'example.com'}));check('remote config rejected',()=>assert.throws(()=>loadConfig(invalid)));
 fs.writeFileSync(invalid,JSON.stringify({...config,bridge_url:'http://example.com/'}));check('config unknown selector rejected',()=>assert.throws(()=>loadConfig(invalid)));
 await bridge.http('project_info',{});check('first edit handshakes once',()=>assert.deepEqual(seen.slice(-2).map(x=>x.body.cmd),['ping','project_info']));
 await bridge.http('list_packages',{});check('cached session avoids per-call ping',()=>assert.equal(seen.at(-1).body.cmd,'list_packages'));
 check('UUID/session/Bearer/deadline actually sent',()=>{const e=seen.at(-1);assert.match(e.body.requestId,/^[0-9a-f-]{36}$/);assert.equal(e.body.sessionId,session);assert.equal(e.authorization,'Bearer '+token);assert(e.body.deadlineMs>Date.now());});
 await bridge.http('publish',{},120000);check('publish budget unified120s',()=>{const d=seen.at(-1).body.deadlineMs-Date.now();assert(d>119000&&d<=120000);});
 mode='publish-false';await rejects('inner publisher false is failure',()=>bridge.http('publish',{}),'PUBLISH_FAILED');
 mode='wrong-project';await rejects('wrong project identity rejected',()=>bridge.ping(),'PROJECT_IDENTITY');
 mode='bad-request-id';await rejects('response request ID checked',()=>bridge.ping(),'RESPONSE_IDENTITY');
 mode='large';await rejects('response byte limit',()=>bridge.ping(),'RESPONSE_TOO_LARGE');
 mode='bad-json';await rejects('response JSON checked',()=>bridge.ping(),'RESPONSE_INVALID');mode='normal';
 // Spawn a copy of our server with a deliberately local helper stub. This proves
 // process wiring/protocol only, not Python/source/native publishing behavior.
 const app=path.join(work,'app');fs.mkdirSync(app);fs.writeFileSync(path.join(app,'package.json'),JSON.stringify({type:'commonjs'}));fs.copyFileSync(path.join(ROOT,'server.mjs'),path.join(app,'server.mjs'));fs.mkdirSync(path.join(app,'lib'));fs.copyFileSync(path.join(ROOT,'lib/core.mjs'),path.join(app,'lib/core.mjs'));fs.copyFileSync(path.join(ROOT,'lib/lines.mjs'),path.join(app,'lib/lines.mjs'));
 config.sourceHelper=path.join(app,'helper.py');config.sourceConfig=configFile;fs.writeFileSync(configFile,JSON.stringify(config));
 fs.writeFileSync(path.join(app,'helper.py'),`const fs=require('node:fs'),path=require('node:path'),cmd=process.argv[2],args=JSON.parse(process.argv[3]);fs.appendFileSync(path.join(__dirname,'helper-calls.jsonl'),JSON.stringify({cmd,args})+'\\n');if(fs.existsSync(path.join(__dirname,'fail-verify.flag'))&&cmd==='verify_publish'){console.log(JSON.stringify({ok:false,error:{code:'OUTPUT_MISMATCH',message:'mock verification rejected'}}));process.exit(1);}console.log(JSON.stringify({ok:true,result:{mockHelper:true,command:cmd,args,configPath:process.env.FGUI_MCP_CONFIG}}));`);
 const child=spawn(process.execPath,[path.join(app,'server.mjs'),'--config',configFile],{stdio:['pipe','pipe','pipe'],windowsHide:true});
 let buffer='',stderr='',id=0;const pending=new Map(),responses=[];
 child.stderr.on('data',b=>stderr+=b);child.stdout.on('data',b=>{buffer+=b;let n;while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);const msg=JSON.parse(line);responses.push(msg);pending.get(msg.id)?.(msg);pending.delete(msg.id);}});
 const rpc=(method,params)=>new Promise((resolve,reject)=>{const seq=++id;const timer=setTimeout(()=>reject(Error('RPC test timeout')),6000);pending.set(seq,v=>{clearTimeout(timer);resolve(v);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:seq,method,params})+'\n');});
 const tool=async(name,args={})=>{const r=await rpc('tools/call',{name,arguments:args});return {raw:r,value:r.result?JSON.parse(r.result.content[0].text):null};};
 const init=await rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'transport-mock',version:'1'}});check('protocol negotiation preserves supported version',()=>assert.equal(init.result.protocolVersion,'2024-11-05'));
 check('stage2 server version0.5.0-dev.2',()=>assert.equal(init.result.serverInfo.version,'0.5.0-dev.2'));
 const latest=await rpc('initialize',{protocolVersion:'future-version'});check('protocol negotiation selects supported fallback',()=>assert.equal(latest.result.protocolVersion,'2025-06-18'));
 const list=await rpc('tools/list',{});check('actual fork exposes31tools',()=>assert.equal(list.result.tools.length,31));
 check('all root schemas closed',()=>assert(list.result.tools.every(t=>t.inputSchema.additionalProperties===false)));
 const expected=['relation_list','relation_set','relation_remove','controller_list','controller_create','controller_update','controller_select','controller_remove','discover_projects','ping','project_info','list_packages','list_items','read_component','create_component','delete_item','list_children','insert_object','set_property','remove_object','save_all','refresh','publish','screenshot','bridge_log','editor_start','source_inspect','source_text_set','source_publish','source_property_set','list_items_page'];check('31tool exact names',()=>assert.deepEqual(list.result.tools.map(t=>t.name).sort(),expected.sort()));
 const propertySchema=list.result.tools.find(t=>t.name==='source_property_set').inputSchema;
 check('source schema advertises default closed nonempty props and exact pairs',()=>{assert.equal(propertySchema.properties.objectId.default,'n1');assert.equal(propertySchema.properties.props.additionalProperties,false);assert.equal(propertySchema.properties.props.minProperties,1);assert.equal(propertySchema.properties.props.properties.xy.minItems,2);assert.equal(propertySchema.properties.props.properties.xy.maxItems,2);});
 const count=seen.length,bad=await tool('set_property',{pkg:'Gesture',name:'Main',props:{text:'ok'},bridge_url:'http://example.com'});check('unknown remote selector rejected before HTTP',()=>{assert(bad.raw.result.isError);assert.equal(seen.length,count);});
 const badNested=await tool('set_property',{pkg:'Gesture',name:'Main',props:{eval:'arbitrary'}});check('nested props closed',()=>assert(badNested.raw.result.isError));
 const good=await tool('set_property',{pkg:'Gesture',name:'Main',target:'n1',props:{xy:'12.5,-3',text:'测试'}});check('typed property edit works through mock HTTP',()=>assert.equal(good.raw.result.isError,false));
 const wrongPath=await tool('screenshot',{path:path.join(work,'escape.png')});check('screenshot directory policy enforced',()=>assert(wrongPath.raw.result.isError));
 const discovery=await tool('discover_projects');check('discovery only configured project',()=>assert.equal(discovery.value.data.instances[0].projectPath,project));
 const source=await tool('source_text_set',{text:'new',expectedText:'old',history:['undo','redo']});check('helper argv JSON wiring no shell',()=>{assert.equal(source.raw.result.isError,false);assert.equal(source.value.data.command,'source_text_set');assert.deepEqual(source.value.data.args.history,['undo','redo']);assert.equal(source.value.data.configPath,configFile);});
 const property=await tool('source_property_set',{props:{xy:[-2147483648,2147483647],size:[0,2147483647],text:'测试😀',fontSize:32767,color:'#01234567'},history:['undo','redo']});
 check('source_property_set default n1 and typed props use mock helper only',()=>{assert.equal(property.raw.result.isError,false);assert.equal(property.value.data.command,'source_property_set');assert.equal(property.value.data.args.objectId,'n1');assert.deepEqual(property.value.data.args.props.xy,[-2147483648,2147483647]);assert.deepEqual(property.value.data.args.history,['undo','redo']);assert.equal(property.value.data.configPath,configFile);});
 const graph=await tool('source_property_set',{objectId:'n0',props:{xy:[0,-1],size:[42,0],lineSize:2147483647,lineColor:'#aBcDef',fillColor:'#80123456'}});
 check('rect graph color and line properties preserve values in helper argv',()=>{assert.equal(graph.raw.result.isError,false);assert.equal(graph.value.data.args.objectId,'n0');assert.equal(graph.value.data.args.props.fillColor,'#80123456');});
 const propertyInvalid=[
  ['missing props',{}],['empty props',{props:{}}],['unknown top key',{props:{text:'x'},path:'arbitrary'}],['unknown props key',{props:{eval:'arbitrary'}}],['bad objectId',{objectId:'n2',props:{text:'x'}}],
  ['xy short',{props:{xy:[1]}}],['xy empty',{props:{xy:[]}}],['xy long',{props:{xy:[1,2,3]}}],['xy string',{props:{xy:'1,2'}}],['xy bool',{props:{xy:[true,2]}}],['xy fraction',{props:{xy:[0.5,2]}}],['xy below int32',{props:{xy:[-2147483649,0]}}],['xy above int32',{props:{xy:[2147483648,0]}}],
  ['size negative',{props:{size:[-1,0]}}],['size short',{props:{size:[0]}}],['size fraction',{props:{size:[0,1.5]}}],['size above int32',{props:{size:[0,2147483648]}}],
  ['font zero',{props:{fontSize:0}}],['font above bound',{props:{fontSize:32768}}],['line negative',{props:{lineSize:-1}}],['line above int32',{props:{lineSize:2147483648}}],['line bool',{props:{lineSize:true}}],
  ['color short',{props:{color:'#abc'}}],['color wrong length',{props:{color:'#1234567'}}],['lineColor nonhex',{props:{lineColor:'#gggggg'}}],['fillColor absent hash',{props:{fillColor:'123456'}}],
  ['color trailing newline',{props:{color:'#123456\n'}}],['color trailing carriage return',{props:{color:'#123456\r'}}],
  ['text malformed XML',{props:{text:'\u0000'}}],['text lone surrogate',{props:{text:'\ud800'}}],['text above4096',{props:{text:'x'.repeat(4097)}}],['history unknown action',{props:{text:'x'},history:['save']}],['history33',{props:{text:'x'},history:Array(33).fill('undo')}],['props null',{props:null}],['pair null',{props:{xy:null}}]
 ];
 const helperLog=path.join(app,'helper-calls.jsonl');
 for(const [label,args] of propertyInvalid){const before=fs.readFileSync(helperLog,'utf8'),httpCount=seen.length;const bad=await tool('source_property_set',args);check('source property rejects '+label+' before helper/HTTP',()=>{assert(bad.raw.result.isError);assert.equal(bad.value.error.code,'INVALID_ARGUMENTS');assert.equal(fs.readFileSync(helperLog,'utf8'),before);assert.equal(seen.length,httpCount);});}
 for(const [label,value]of [['NaN',NaN],['Infinity',Infinity],['negativeInfinity',-Infinity]])check('source int pair pure validator rejects '+label,()=>assert.throws(()=>validate(propertySchema,{props:{xy:[value,0]}}),e=>e.code==='INVALID_ARGUMENTS'));
 for(const [name,args] of [['controller_create',{pkg:'Gesture',name:'Main',controller:'State',pages:['Idle','Run'],exported:false}],['controller_update',{pkg:'Gesture',name:'Main',controller:'State',exported:false}],['controller_select',{pkg:'Gesture',name:'Main',controller:'State',index:0}],['controller_remove',{pkg:'Gesture',name:'Main',controller:'State'}]]){const r=await tool(name,args);check(name+' routes with expectedRevision preserving zero/false',()=>{assert(!r.raw.result.isError);const body=seen.at(-1).body;assert.equal(body.cmd,name);assert.equal(body.expectedRevision,0);assert.deepEqual(body.args,args);});}
 for(const args of [{controller:'bad,name',pages:['Idle']},{controller:'State',pages:[]},{controller:'State',pages:['\ud800']},{controller:'State',pages:['Idle'],exported:'false'}]){const before=seen.length,r=await tool('controller_create',{pkg:'Gesture',name:'Main',...args});check('controller invalid schema rejected before HTTP',()=>{assert(r.raw.result.isError);assert.equal(seen.length,before);});}
 for(const [name,args] of [['relation_list',{pkg:'Gesture',name:'Main',objectId:'n1',offset:0,limit:1}],['relation_set',{pkg:'Gesture',name:'Main',objectId:'n1',targetId:'$parent',definitions:[{type:'Width',percent:false}]}],['relation_remove',{pkg:'Gesture',name:'Main',objectId:'n1',targetId:'$parent'}]]){const r=await tool(name,args);check(name+' schema routes exact arguments',()=>{assert(!r.raw.result.isError);assert.deepEqual(seen.at(-1).body.args,args);if(name!=='relation_list')assert.equal(seen.at(-1).body.expectedRevision,0);});}
 for(const definitions of [[],[{type:11}],[{type:'runtime.Width'}],[{type:'Width',percent:0}]]){const before=seen.length,r=await tool('relation_set',{pkg:'Gesture',name:'Main',objectId:'n1',targetId:'$parent',definitions});check('invalid relation schema before HTTP',()=>{assert(r.raw.result.isError);assert.equal(seen.length,before);});}
 const started=await tool('editor_start');check('editor_start maps helper start only',()=>assert.equal(started.value.data.command,'start'));
 const pub=await tool('publish',{pkg:'Gesture'});check('native publish invokes independent helper verify',()=>{assert.equal(pub.raw.result.isError,false);assert.equal(pub.value.data.verification.command,'verify_publish');});
 const failFlag=path.join(app,'fail-verify.flag');fs.writeFileSync(failFlag,'1');const verifyFail=await tool('publish',{pkg:'Gesture'});fs.unlinkSync(failFlag);check('verification failure keeps native outcome but reports error',()=>{assert(verifyFail.raw.result.isError);assert.equal(verifyFail.value.error.code,'OUTPUT_MISMATCH');assert.equal(verifyFail.value.error.details.native.isSuccess,true);});
 const inspect=await tool('source_inspect'),sourcePublish=await tool('source_publish');check('independent source inspection and publication routes',()=>{assert.equal(inspect.value.data.command,'source_inspect');assert.equal(sourcePublish.value.data.command,'source_publish');});
 mode='publish-false';const failed=await tool('publish',{pkg:'Gesture'});check('MCP failed native publish isError true',()=>{assert(failed.raw.result.isError);assert.equal(failed.value.error.code,'PUBLISH_FAILED');});mode='normal';
 maxActive=0;await Promise.all([tool('set_property',{pkg:'Gesture',name:'Main',props:{text:'a'}}),tool('set_property',{pkg:'Gesture',name:'Main',props:{text:'b'}})]);check('editing operations serialized',()=>assert.equal(maxActive,1));
 const edit=tool('publish',{pkg:'Gesture'});await new Promise(r=>setTimeout(r,10));const before=Date.now();const pong=await rpc('ping');check('protocol ping not blocked by publish',()=>{assert.deepEqual(pong.result,{});assert(Date.now()-before<1000);});await edit;
 const busyEdit=tool('publish',{pkg:'Gesture'});await new Promise(r=>setTimeout(r,10));const nativePing=await tool('ping');check('native ping can bypass serial edit lane',()=>assert.equal(nativePing.raw.result.isError,false));await busyEdit;
 check('stdout contains no token',()=>assert(!JSON.stringify(responses).includes(token)));
 child.stdin.end();const code=await new Promise(r=>child.on('exit',r));check('EOF exit0',()=>assert.equal(code,0));check('stdout only protocol frames',()=>assert.equal(buffer,''));
 const artifact={scope:'Own Node transport/schema/stdio/helper-spawn tests using loopback HTTP and helper mocks; not editor/plugin/SDK execution.',summary:{checks:checks.length,passed:checks.length,failed:0},checks,sourceFiles:['server.mjs','lib/core.mjs','tests/test_server_transport.mjs'].map(v=>{const p=path.join(ROOT,v);return{path:p,sha256:crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')};}),mockRequests:seen.map(x=>({cmd:x.body.cmd,requestId:x.body.requestId,hasSession:!!x.body.sessionId,deadlineMs:x.body.deadlineMs,authenticated:x.authorization==='Bearer '+token})),serverStderr:stderr,originalEditorExecuted:false,upstreamCodeExecuted:false,helperBoundary:'Node JS helper stub injected only in an isolated copy of our app. Real helper.py tested by its owner.'};
 fs.mkdirSync(path.join(ROOT,'verification'),{recursive:true});fs.writeFileSync(path.join(ROOT,'verification/server-stage2-transport-tests.json'),JSON.stringify(artifact,null,2)+'\n');console.log(JSON.stringify(artifact.summary));
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
