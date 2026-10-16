// Project-confined transport for the fork of wingcd/fairygui-agent-bridge.
// Upstream MIT notice: ../server.UPSTREAM-LICENSE. No SDK/editor is imported.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';

export const MAX_BYTES=65536;
export class BridgeError extends Error {
  constructor(code,message,details){super(message);this.code=code;if(details!==undefined)this.details=details;}
}
export function parseJsonStrict(text){
  // Reject duplicate object keys before JSON.parse discards their first values.
  let i=0;const ws=()=>{while(/\s/.test(text[i]||'')&&i<text.length)i++;};
  const string=()=>{let start=i++;while(i<text.length){const c=text[i++];if(c==='\\')i++;else if(c==='"')return JSON.parse(text.slice(start,i));}throw Error('Unterminated JSON string');};
  const value=()=>{ws();if(text[i]==='"'){string();return;}
    if(text[i]==='{'){i++;ws();const keys=new Set();if(text[i]==='}'){i++;return;}while(i<text.length){ws();if(text[i]!=='"')throw Error('JSON object key expected');const key=string();if(keys.has(key))throw Error('Duplicate JSON key');keys.add(key);ws();if(text[i++]!==':')throw Error('JSON colon expected');value();ws();const c=text[i++];if(c==='}')return;if(c!==',')throw Error('JSON comma expected');}throw Error('Unterminated JSON object');}
    if(text[i]==='['){i++;ws();if(text[i]===']'){i++;return;}while(i<text.length){value();ws();const c=text[i++];if(c===']')return;if(c!==',')throw Error('JSON comma expected');}throw Error('Unterminated JSON array');}
    const m=text.slice(i).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);if(!m)throw Error('JSON value expected');i+=m[0].length;
  };value();ws();if(i!==text.length)throw Error('Trailing JSON data');return JSON.parse(text);
}
export function validate(schema,value,label='arguments'){
  if(schema.type==='object'){
    if(value===null||Array.isArray(value)||typeof value!=='object')throw new BridgeError('INVALID_ARGUMENTS',label+' must be an object');
    for(const key of Object.keys(value))if(!Object.hasOwn(schema.properties||{},key))throw new BridgeError('INVALID_ARGUMENTS',label+': unknown key '+key);
    for(const key of schema.required||[])if(!Object.hasOwn(value,key))throw new BridgeError('INVALID_ARGUMENTS',label+': missing '+key);
    if(schema.minProperties!==undefined&&Object.keys(value).length<schema.minProperties)throw new BridgeError('INVALID_ARGUMENTS',label+' has too few properties');
    for(const [key,v]of Object.entries(value))validate(schema.properties[key],v,label+'.'+key);
  }else if(schema.type==='array'){
    if(!Array.isArray(value)||value.length<(schema.minItems??0)||value.length>(schema.maxItems??100))throw new BridgeError('INVALID_ARGUMENTS',label+' invalid array');
    value.forEach((v,i)=>validate(schema.items,v,label+'['+i+']'));
  }else if(schema.type==='string'){
    if(typeof value!=='string'||value.length<(schema.minLength??0)||value.length>(schema.maxLength??4096))throw new BridgeError('INVALID_ARGUMENTS',label+' invalid string length/type');
    if(schema.pattern&&!new RegExp(schema.pattern).test(value))throw new BridgeError('INVALID_ARGUMENTS',label+' invalid format');
    // Strings travel through editor XML and C#; reject unpaired UTF16/control chars.
    if(!value.isWellFormed()||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(value))throw new BridgeError('INVALID_ARGUMENTS',label+' is not XML 1.0 text');
  }else if(schema.type==='boolean'){
    if(typeof value!=='boolean')throw new BridgeError('INVALID_ARGUMENTS',label+' must be boolean');
  }else if(schema.type==='number'||schema.type==='integer'){
    if(typeof value!=='number'||!Number.isFinite(value)||(schema.type==='integer'&&!Number.isInteger(value))||value<(schema.minimum??-Infinity)||value>(schema.maximum??Infinity))throw new BridgeError('INVALID_ARGUMENTS',label+' invalid number');
  }else throw new BridgeError('SCHEMA_ERROR','Unsupported schema type');
  if(schema.enum&&!schema.enum.includes(value))throw new BridgeError('INVALID_ARGUMENTS',label+' is not an allowed value');
  if(Object.hasOwn(schema,'const')&&value!==schema.const)throw new BridgeError('INVALID_ARGUMENTS',label+' differs from configured value');
}
export function normalizedProject(value){let p=path.resolve(value);if(/\.fairy$/i.test(p))p=path.dirname(p);return process.platform==='win32'?p.toLowerCase():p;}
export function loadConfig(configPath){
  const raw=fs.readFileSync(configPath);if(raw.length>MAX_BYTES)throw new BridgeError('CONFIG_INVALID','Config size limit');const c=parseJsonStrict(raw.toString('utf8'));
  const required=['projectPath','port','host','token','publishDir','screenshotDir','python','editorPath'];
  const keys=[...required,'sourceProject','node','sourceHelper','sourceConfig'];
  if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).some(k=>!keys.includes(k))||required.some(k=>!Object.hasOwn(c,k)))throw new BridgeError('CONFIG_INVALID','Config keys differ from fixed project schema');
  if(c.host!=='127.0.0.1'||!Number.isInteger(c.port)||c.port<1024||c.port>65535||typeof c.token!=='string'||!/^[A-Za-z0-9_-]{32,256}$/.test(c.token))throw new BridgeError('CONFIG_INVALID','Loopback host, valid port and token required');
  for(const key of keys.filter(k=>Object.hasOwn(c,k)&&!['port','host','token'].includes(k)))if(typeof c[key]!=='string'||!path.isAbsolute(c[key])||c[key].includes('\0'))throw new BridgeError('CONFIG_INVALID','Config '+key+' must be an absolute path');
  if(Boolean(c.sourceHelper)!==Boolean(c.sourceConfig))throw new BridgeError('CONFIG_INVALID','sourceHelper and sourceConfig must be configured together');
  return Object.freeze(c);
}
export function confinedPath(candidate,root,extension){
  if(typeof candidate!=='string'||candidate.includes('\0')||!path.isAbsolute(candidate))throw new BridgeError('PATH_REJECTED','An absolute configured output path is required');
  const target=path.resolve(candidate),base=path.resolve(root),rel=path.relative(base,target);
  if(rel===''||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel)||extension&&path.extname(target).toLowerCase()!==extension)throw new BridgeError('PATH_REJECTED','Output is outside the configured directory');
  // Reject existing symlinks/junction escapes in ancestors. OS ACL/TOCTOU is not a sandbox.
  let cur=target;
  while(!fs.existsSync(cur)){const par=path.dirname(cur);if(cur===par)break;cur=par;}
  if(fs.existsSync(base)&&fs.existsSync(cur)){
    const realBase=fs.realpathSync(base),real=fs.realpathSync(cur),rp=path.relative(realBase,real);
    if(rp==='..'||rp.startsWith('..'+path.sep)||path.isAbsolute(rp))throw new BridgeError('PATH_REJECTED','Output resolves through an escaping link');
  }
  return target;
}
export class ProjectBridge {
  constructor(config,configPath,{fetchImpl=globalThis.fetch,helperPath}={}){this.config=config;this.configPath=path.resolve(configPath);this.fetch=fetchImpl;this.sessionId=null;this.revision=null;this.pingSerial=0;this.acceptedPing=0;this.helperPath=helperPath;}
  async http(cmd,args={},duration=30000){
    const c=this.config,requestId=crypto.randomUUID(),pingSerial=cmd==='ping'?++this.pingSerial:0;
    if(cmd!=='ping'&&!this.sessionId)await this.ping();
    duration=Math.min(120000,Math.max(1000,duration));
    const envelope={cmd,args,requestId,deadlineMs:Date.now()+duration};if(cmd!=='ping')envelope.sessionId=this.sessionId;
    if(['relation_set','relation_remove','controller_create','controller_update','controller_select','controller_remove','create_component','delete_item','insert_object','set_property','remove_object','save_all','refresh','publish','close_doc'].includes(cmd)){
      if(!Number.isSafeInteger(this.revision))throw new BridgeError('REVISION_REQUIRED','Explicit ping/read required before editing');
      envelope.expectedRevision=this.revision;
    }
    const body=JSON.stringify(envelope);if(Buffer.byteLength(body)>MAX_BYTES)throw new BridgeError('REQUEST_TOO_LARGE','HTTP JSON exceeds 64KiB');
    let response;
    try{response=await this.fetch(`http://${c.host}:${c.port}/`,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','Authorization':'Bearer '+c.token},body,signal:AbortSignal.timeout(Math.max(1000,envelope.deadlineMs-Date.now())+5000)});}catch(error){throw new BridgeError(error.name==='TimeoutError'?'HTTP_TIMEOUT':'BRIDGE_UNREACHABLE','Configured editor bridge request failed');}
    let n=0,chunks=[];
    if(Number(response.headers.get('content-length')||0)>MAX_BYTES){await response.body?.cancel();throw new BridgeError('RESPONSE_TOO_LARGE','HTTP JSON exceeds 64KiB');}
    for await(const part of response.body){n+=part.length;if(n>MAX_BYTES)throw new BridgeError('RESPONSE_TOO_LARGE','HTTP JSON exceeds 64KiB');chunks.push(part);}
    let out;try{out=parseJsonStrict(Buffer.concat(chunks).toString('utf8'));}catch{throw new BridgeError('RESPONSE_INVALID','Bridge response is not strict JSON');}
    if(!out||typeof out!=='object'||Array.isArray(out)||out.requestId!==requestId||typeof out.sessionId!=='string'||!out.sessionId)throw new BridgeError('RESPONSE_IDENTITY','Response request/session identity mismatch');
    if(!response.ok||out.ok!==true){const code=typeof out.error?.code==='string'?out.error.code:'EDITOR_COMMAND_FAILED';if(code==='SESSION_MISMATCH'&&this.sessionId===envelope.sessionId){this.sessionId=null;this.revision=null;}throw new BridgeError(code,typeof out.error?.message==='string'?out.error.message:'Editor rejected request',{requestId,sessionId:out.sessionId});}
    if(cmd==='ping'){
      const d=out.data;if(!d||typeof d.projectPath!=='string'||normalizedProject(d.projectPath)!==normalizedProject(c.projectPath)||d.sessionId!==out.sessionId||!Number.isInteger(d.frame)||!Number.isFinite(d.updatedAtMs)||Math.abs(Date.now()-d.updatedAtMs)>10000)throw new BridgeError('PROJECT_IDENTITY','Ping does not prove the configured live project');
      if(pingSerial<this.acceptedPing)throw new BridgeError('STALE_OBSERVATION','A newer ping observation has already been accepted; read fresh state');
      this.acceptedPing=pingSerial;
      if(this.sessionId!==out.sessionId)this.revision=null;
      this.sessionId=out.sessionId;
    }else if(out.sessionId!==envelope.sessionId||(this.sessionId&&out.sessionId!==this.sessionId))throw new BridgeError('SESSION_MISMATCH','Editor session changed; explicit ping required before another edit');
    if(out.data?.isSuccess===false)throw new BridgeError('PUBLISH_FAILED','Native publisher reported isSuccess=false',{requestId,sessionId:out.sessionId});
    if(Number.isSafeInteger(out.revision)&&out.revision>=0)this.revision=Math.max(this.revision??0,out.revision);
    return out;
  }
  ping(){return this.http('ping',{},10000);}
  async helper(command,args={},timeout=30000){
    const source=command.startsWith('source_');
    if(source&&!this.config.sourceHelper)throw new BridgeError('SOURCE_BACKEND_DISABLED','Configure an explicit external source backend first');
    const file=source?this.config.sourceHelper:this.helperPath;
    const helperConfig=source?this.config.sourceConfig:this.configPath;const argv=[file,command,JSON.stringify(args)];
    return new Promise((resolve,reject)=>{
      let stdout=[],stderr=[],bytes=0,done=false;
      const child=spawn(this.config.python,argv,{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,FGUI_MCP_CONFIG:helperConfig,PYTHONIOENCODING:'utf-8'}});
      const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(result);};
      const timer=setTimeout(()=>{child.kill();finish(new BridgeError('HELPER_TIMEOUT','Configured helper exceeded its deadline'));},timeout);
      child.on('error',()=>finish(new BridgeError('HELPER_START_FAILED','Configured helper could not start')));
      child.stdout.on('data',b=>{bytes+=b.length;if(bytes>MAX_BYTES){child.kill();finish(new BridgeError('HELPER_OUTPUT_LIMIT','Helper output exceeds64KiB'));}else stdout.push(b);});
      child.stderr.on('data',b=>{if(stderr.reduce((a,x)=>a+x.length,0)<MAX_BYTES)stderr.push(b);});
      child.on('close',code=>{if(done)return;let result;try{result=parseJsonStrict(Buffer.concat(stdout).toString('utf8').trim());}catch{return finish(new BridgeError('HELPER_RESPONSE_INVALID','Helper stdout must be one JSON value'));}
        if(code!==0||result.ok!==true)return finish(new BridgeError(result.error?.code||'HELPER_FAILED',result.error?.message||'Configured helper failed'));
        finish(null,result.result);
      });
    });
  }
}
