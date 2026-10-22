'use strict';
// Optional source-side browser host. No MCP tool is registered by this file.
// Uses the real served UI and its existing ordered text measurement transport.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const PROTOCOL='fgui-browser-preview-host/1',MAX_RESULT=8*1024*1024,MAX_PNG=16*1024*1024;
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
class PreviewError extends Error{constructor(code){super(code);this.code=code;}}
const fail=code=>{throw new PreviewError(code);};
function fields(x,names,required=names){
 if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).some(k=>!names.includes(k))||required.some(k=>!Object.hasOwn(x,k)))fail('PREVIEW_CONFIG');
}
function plainString(x,max=256){return typeof x==='string'&&x.length>0&&x.length<=max&&!/[\u0000-\u001f\u007f]/u.test(x);}
function localPath(p){
 if(!path.isAbsolute(p))fail('PREVIEW_PATH');
 const resolved=path.resolve(p);let cursor=resolved;
 while(true){if(fs.existsSync(cursor)&&fs.lstatSync(cursor).isSymbolicLink())fail('PREVIEW_PATH');const parent=path.dirname(cursor);if(parent===cursor)break;cursor=parent;}
 return resolved;
}
function validateConfig(c){
 fields(c,['origin','token','session','revision','projectFile','playwrightModule','browserExecutable','timeoutMs']);
 if(typeof c.origin!=='string'||!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(c.origin)||Number(c.origin.slice(c.origin.lastIndexOf(':')+1))>65535)fail('PREVIEW_ORIGIN');
 if(!plainString(c.token,256)||!/^[-_A-Za-z0-9]{16,256}$/.test(c.token)||typeof c.session!=='string'||!/^[-_A-Za-z0-9]{16,128}$/.test(c.session)||!Number.isSafeInteger(c.revision)||c.revision<0)fail('PREVIEW_IDENTITY');
 if(!Number.isSafeInteger(c.timeoutMs)||c.timeoutMs<1000||c.timeoutMs>120000)fail('PREVIEW_DEADLINE');
 if(!plainString(c.projectFile,1024)||!fs.statSync(localPath(c.projectFile)).isFile())fail('PREVIEW_PROJECT');
 for(const k of ['playwrightModule','browserExecutable'])if(!plainString(c[k],1024)||!fs.existsSync(localPath(c[k])))fail('PREVIEW_DEPENDENCY');
 return {...c};
}
function validateRequest(r){
 fields(r,['package','component','args']);
 if(!plainString(r.package)||!plainString(r.component,128))fail('PREVIEW_SELECTOR');
 fields(r.args,['events','host','max_steps','branch','variables','random_values','stage_profile','custom_ease_profile'],[]);
 let text;try{text=JSON.stringify(r.args);}catch{fail('PREVIEW_ARGUMENTS');}
 if(Buffer.byteLength(text)>512*1024)fail('PREVIEW_INPUT_LIMIT');
 // Reject non-JSON values and pathological nesting before browser serialization.
 let count=0;function visit(x,depth){if(depth>64||++count>100000)fail('PREVIEW_INPUT_LIMIT');if(x===null||typeof x==='boolean'||typeof x==='string')return;if(typeof x==='number'){if(!Number.isFinite(x))fail('PREVIEW_ARGUMENTS');return;}if(typeof x!=='object'||!x)fail('PREVIEW_ARGUMENTS');for(const v of Object.values(x))visit(v,depth+1);}
 visit(r.args,0);return JSON.parse(JSON.stringify(r));
}
function errorCode(error){return error instanceof PreviewError?error.code:'PREVIEW_BROWSER_FAILED';}

async function createHost(raw,workdir,{signal,onProgress=()=>{}}={}){
 const cfg=validateConfig(raw),work=localPath(workdir);
 if(signal?.aborted)fail('PREVIEW_CANCELLED');
 if(!fs.statSync(work).isDirectory())fail('PREVIEW_PATH');
 const profile=path.join(work,'browser-profile');if(fs.existsSync(profile))fail('PREVIEW_PROFILE_EXISTS');
 const owner=crypto.randomBytes(24).toString('hex'),marker=path.join(work,'browser-owner.json');
 fs.writeFileSync(marker,JSON.stringify({protocol:PROTOCOL,owner,profile}),{flag:'wx',mode:0o600});
 const {chromium}=require(cfg.playwrightModule);let context,page,closed=false,active=null;
 const pendingResponses=new Set(),counts={get:0,start:0,step:0,cancel:0,blocked:0},browserErrors=[];
 const isScope=(s,job)=>s&&s.session===cfg.session&&s.revision===cfg.revision&&s.package===job.request.package&&s.component===job.request.component;
 const stopCode=(job=active)=>signal?.aborted?'PREVIEW_CANCELLED':job?.deadlineExpired?'PREVIEW_DEADLINE':job?.protocolError||job?.stopReason;
 const checkpoint=job=>{const code=stopCode(job);if(code)fail(code);};
 function phase(name,sequence=null){try{onProgress({phase:name,sequence});}catch{ /* A progress sink cannot take ownership of source writes. */ }}
 async function drain(){while(pendingResponses.size)await Promise.allSettled([...pendingResponses]);}
 async function cancelRemote(job){
  if(!job||job.complete||job.startSent===0)return {confirmed:true,reason:job?.complete?'complete':'not-started'};
  if(!job.ticket)return {confirmed:false,reason:'ticket-not-observed',remoteTTLSeconds:120};
  try{
   const r=await context.request.post(cfg.origin+'/api/command',{timeout:5000,headers:{Authorization:'Bearer '+cfg.token},data:{session:cfg.session,expectedRevision:cfg.revision,package:job.request.package,component:job.request.component,operation:'text_preview_cancel',args:{ticket:job.ticket}}});
   const v=await r.json();const ok=r.status()===200&&v?.ok===true&&v.session===cfg.session&&v.revision===cfg.revision&&v.result?.state==='cancelled';
   return {confirmed:ok,reason:ok?'cancel-acknowledged':'cancel-not-acknowledged',...(!ok?{remoteTTLSeconds:120}:{})};
  }catch{return {confirmed:false,reason:'cancel-transport-unconfirmed',remoteTTLSeconds:120};}
 }
 async function reset(job){
  if(page&&!page.isClosed())await page.evaluate(()=>{if(typeof textPreview!=='undefined')textPreview.reset();}).catch(()=>{});
  await drain();return cancelRemote(job);
 }
 const abortHandler=()=>{if(active)void reset(active);};
 try{
  const initAbort=()=>{if(context)void context.close().catch(()=>{});};
  signal?.addEventListener('abort',initAbort,{once:true});
  fs.mkdirSync(profile);const browserTemp=path.join(profile,'owned-temp');fs.mkdirSync(browserTemp);
  context=await chromium.launchPersistentContext(profile,{headless:true,executablePath:cfg.browserExecutable,viewport:{width:1850,height:1250},deviceScaleFactor:1,env:{...process.env,TEMP:browserTemp,TMP:browserTemp},timeout:Math.min(cfg.timeoutMs,30000)});
  if(signal?.aborted)fail('PREVIEW_CANCELLED');
  page=context.pages()[0]||await context.newPage();page.setDefaultTimeout(Math.min(cfg.timeoutMs,30000));
  await context.addInitScript(({origin,token})=>{if(location.origin===origin)sessionStorage.setItem('fgui-token',token);},{origin:cfg.origin,token:cfg.token});
  page.on('pageerror',()=>browserErrors.push('pageerror'));
  await page.route('**/*',async route=>{
   const req=route.request();let url;try{url=new URL(req.url());}catch{counts.blocked++;return route.abort();}
   if(url.origin!==cfg.origin){counts.blocked++;if(active)active.protocolError='PREVIEW_EXTERNAL_REQUEST';return route.abort();}
   if(req.method()==='GET'){counts.get++;return route.continue();}
   let b;try{b=req.postDataJSON();}catch{}
   const allowed=active&&url.pathname==='/api/command'&&!url.search&&req.method()==='POST'&&b?.session===cfg.session&&b.expectedRevision===cfg.revision&&b.package===active.request.package&&b.component===active.request.component&&['text_preview_start','text_preview_step','text_preview_cancel'].includes(b.operation);
   if(!allowed){counts.blocked++;if(active)active.protocolError='PREVIEW_WRITE_BLOCKED';return route.abort();}
   counts[{text_preview_start:'start',text_preview_step:'step',text_preview_cancel:'cancel'}[b.operation]]++;
   if(b.operation==='text_preview_start')active.startSent++;
   return route.continue();
  });
  page.on('response',response=>{
   if(response.url()!==cfg.origin+'/api/command'||response.request().method()!=='POST'||!active)return;
   const job=active;let b;try{b=response.request().postDataJSON();}catch{return;}
   if(!['text_preview_start','text_preview_step','text_preview_cancel'].includes(b.operation))return;
   const p=(async()=>{try{
    const v=await response.json();if(!v?.ok)return;
    if(v.session!==cfg.session||v.revision!==cfg.revision){job.protocolError='PREVIEW_RESPONSE_IDENTITY';return;}
    const r=v.result;if(b.operation==='text_preview_cancel')return;
    if(!isScope(r?.scope,job)){job.protocolError='PREVIEW_RESPONSE_SCOPE';return;}
    job.scope=r.scope;
    if(r.state==='measure'){
     if(!/^[-_A-Za-z0-9]{16,128}$/.test(r.ticket)||!Number.isSafeInteger(r.sequence)||r.sequence!==job.measurements||r.task?.profile!=='dom-browser-text/1')job.protocolError='PREVIEW_RESPONSE_ORDER';
     else{job.ticket=r.ticket;job.measurements++;phase('measure',r.sequence);}
    }else if(r.state==='complete')job.complete=true;
    else job.protocolError='PREVIEW_RESPONSE_PROTOCOL';
   }catch{ /* Missing response body means cleanup remains explicitly unconfirmed. */ }})();
   pendingResponses.add(p);void p.finally(()=>pendingResponses.delete(p));
  });
  // Authentication is injected into storage, never embedded in the navigated URL.
  phase('load');await page.goto(cfg.origin+'/',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>typeof state!=='undefined'&&state.viewReady&&!state.loading&&!state.busy&&state.data?.capabilities?.browserText);
  const identity=await page.evaluate(()=>({session:state.session,revision:state.revision,projectFile:state.data?.project?.path}));
  if(identity.session!==cfg.session||identity.revision!==cfg.revision||typeof identity.projectFile!=='string'||path.resolve(identity.projectFile)!==path.resolve(cfg.projectFile))fail('PREVIEW_SOURCE_IDENTITY');
  await page.locator('#zoom').selectOption('1');
  signal?.removeEventListener('abort',initAbort);
  signal?.addEventListener('abort',abortHandler);
 }catch(error){
  let acknowledged=false;if(context){try{await context.close();acknowledged=true;}catch{}}
  if(acknowledged)cleanupProfile();
  else if(fs.existsSync(profile))throw new PreviewError('PREVIEW_CLEANUP_UNCONFIRMED');
  throw new PreviewError(signal?.aborted?'PREVIEW_CANCELLED':errorCode(error));
 }

 function cleanupProfile(){
  // Delete only this host's newly created profile; never the work/config/artifacts.
  if(!fs.existsSync(profile))return true;
  const identity=JSON.parse(fs.readFileSync(marker,'utf8'));
  if(identity.owner!==owner||identity.profile!==profile||path.dirname(localPath(profile))!==work)fail('PREVIEW_PROFILE_OWNERSHIP');
  fs.rmSync(profile,{recursive:true,force:true});return !fs.existsSync(profile);
 }
 async function preview(rawRequest,stem='preview'){
  if(closed||active||page.isClosed())fail('PREVIEW_HOST_BUSY');
  const request=validateRequest(rawRequest);
  if(!/^[a-zA-Z0-9_-]{1,64}$/.test(stem))fail('PREVIEW_ARTIFACT_NAME');
  for(const suffix of ['.json','.png','.receipt.json'])if(fs.existsSync(path.join(work,stem+suffix)))fail('PREVIEW_ARTIFACT_EXISTS');
  const job={request,startSent:0,ticket:null,complete:false,measurements:0,scope:null,protocolError:null,deadlineExpired:false};active=job;
  let timer,abortReject;
  const abortPromise=new Promise((_,reject)=>{abortReject=()=>reject(new PreviewError('PREVIEW_CANCELLED'));signal?.addEventListener('abort',abortReject,{once:true});});
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{job.deadlineExpired=true;void reset(job);reject(new PreviewError('PREVIEW_DEADLINE'));},cfg.timeoutMs);});
  let result,cleanup={confirmed:false,reason:'not-yet-checked'},code=null;
  const execute=(async()=>{
   checkpoint(job);phase('navigate');
   await page.evaluate(async({pkg,id})=>{await navigate(pkg,id);if(!state.viewReady||state.loading||state.package!==pkg||state.component!==id)throw Error('scope');},{pkg:request.package,id:request.component});
   checkpoint(job);const id=await page.evaluate(()=>({session:state.session,revision:state.revision,projectFile:state.data?.project?.path}));if(id.session!==cfg.session||id.revision!==cfg.revision||path.resolve(id.projectFile)!==path.resolve(cfg.projectFile))fail('PREVIEW_SOURCE_IDENTITY');
   await page.locator('#text-runtime-enabled').check();checkpoint(job);phase('replay');
   const value=await page.evaluate(args=>command('preview',args),request.args);await drain();checkpoint(job);
   if(!job.complete||!job.scope||value?.textLayoutCapabilities?.transport!=='editor-session-challenge-receipt/1')fail('PREVIEW_NOT_COMPLETE');
   const identity=await page.evaluate(()=>({session:state.session,revision:state.revision,ready:state.viewReady,uncertain:state.commandUncertain,active:textPreview.active}));
   if(identity.session!==cfg.session||identity.revision!==cfg.revision||!identity.ready||identity.uncertain||identity.active)fail('PREVIEW_SOURCE_IDENTITY');
   const bytes=Buffer.from(JSON.stringify(value));if(bytes.length>MAX_RESULT)fail('PREVIEW_RESULT_LIMIT');
   await page.evaluate(async()=>{await document.fonts.ready;for(let i=0;i<2;i++)await new Promise(r=>requestAnimationFrame(r));});checkpoint(job);
   const canvas=page.locator('[data-fgui-dom-canvas]');if(await canvas.count()!==1)fail('PREVIEW_CANVAS');
   const clip=await page.evaluate(()=>{
    const s=document.querySelector('[data-fgui-dom-canvas]'),b=s.getBoundingClientRect(),v=document.getElementById('stage-viewport').getBoundingClientRect(),n=document.querySelector('.canvas-note').getBoundingClientRect();
    if(b.width<=0||b.height<=0||b.width>4096||b.height>4096||b.x<v.x||b.y<v.y||b.right>v.right||b.bottom>v.bottom||b.right>innerWidth||b.bottom>innerHeight||n.x<b.right&&n.right>b.x&&n.y<b.bottom&&n.bottom>b.y)throw Error('full component outside actual viewport');
    return {x:b.x,y:b.y,width:b.width,height:b.height};
   });
   phase('capture');const png=await page.screenshot({clip});checkpoint(job);if(png.length>MAX_PNG)fail('PREVIEW_PNG_LIMIT');
   const artifacts=[];for(const [suffix,data] of [['.json',bytes],['.png',png]]){const name=stem+suffix;fs.writeFileSync(path.join(work,name),data,{flag:'wx',mode:0o600});artifacts.push({name,bytes:data.length,sha256:sha(data)});}
   return {protocol:PROTOCOL,state:'complete',scope:job.scope,measurements:job.measurements,profile:{text:'dom-browser-text/1',font:'Arial',dpr:1,viewport:{width:1850,height:1250},userAgent:await page.evaluate(()=>navigator.userAgent)},clip,artifacts};
  })();
  // Always observe the in-flight evaluation, even after a cancellation won the race.
  void execute.catch(()=>{});
  try{result=await Promise.race([execute,abortPromise,deadline]);cleanup={confirmed:true,reason:'complete'};}
  catch(error){code=stopCode(job)||errorCode(error);job.stopReason=code;cleanup=await reset(job);code=stopCode(job)||code;await page.close().catch(()=>{});await execute.catch(()=>{});}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abortReject);await drain();active=null;}
  const receipt=result||{protocol:PROTOCOL,state:code==='PREVIEW_CANCELLED'?'cancelled':'failed',error:{code},measurements:job.measurements};
  receipt.cleanup=cleanup;receipt.sourceWritingAllowed=false;
  // Do not serialize exception messages/stacks, tokens, HTTP payloads or source XML.
  fs.writeFileSync(path.join(work,stem+'.receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
  return receipt;
 }
 async function close(){
  if(closed)return {contextClosed:true,profileRemoved:!fs.existsSync(profile)};
  const job=active;if(job)await reset(job);signal?.removeEventListener('abort',abortHandler);
  await context.close();closed=true;await drain();const profileRemoved=cleanupProfile();phase('closed');
  return {contextClosed:true,profileRemoved,browserErrors:browserErrors.length,requestCounts:{...counts}};
 }
 return {preview,close,get counts(){return {...counts};}};
}

async function cli(){
 let result={protocol:PROTOCOL,state:'failed',error:{code:'PREVIEW_CONFIG'}},host,close;
 try{
  if(process.argv.length!==4)fail('PREVIEW_CONFIG');
  const config=localPath(process.argv[2]),work=localPath(process.argv[3]);if(path.dirname(config)!==work||fs.statSync(config).size>600*1024)fail('PREVIEW_CONFIG');
  const job=JSON.parse(fs.readFileSync(config,'utf8'));fields(job,['host','request']);host=await createHost(job.host,work);result=await host.preview(job.request);
 }catch(error){result={protocol:PROTOCOL,state:'failed',error:{code:errorCode(error)}};}
 finally{if(host){try{close=await host.close();}catch{close={contextClosed:false,profileRemoved:false};process.exitCode=1;}}}
 // Only compact public receipt metadata goes to stdout. Result bodies stay local.
 process.stdout.write(JSON.stringify({...result,close})+'\n');if(result.state!=='complete'||close?.contextClosed!==true||close?.profileRemoved!==true)process.exitCode=1;
}
module.exports={createHost,validateConfig,validateRequest,PreviewError,PROTOCOL};
if(require.main===module)void cli();
