#!/usr/bin/env node
// Fork of wingcd/fairygui-agent-bridge @4b3abc16da973b4a1d54325f61d2522455349168.
// Original MIT copyright (c)2026 fgui-agent-bridge contributors; see server.UPSTREAM-LICENSE.
// Retains the upstream 17-tool catalogue and stdio JSON-RPC structure; replaces
// global discovery/transport with strict configured-project/session/token routing.
import process from 'node:process';
import {readLines} from './lib/lines.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {BridgeError,MAX_BYTES,parseJsonStrict,validate,loadConfig,confinedPath,ProjectBridge} from './lib/core.mjs';
const DIR=path.dirname(fileURLToPath(import.meta.url));
let configPath=process.env.FGUI_MCP_CONFIG||path.join(DIR,'config.json');
if(process.argv.length>2){if(process.argv.length!==4||process.argv[2]!=='--config'){process.stderr.write('Usage: node server.mjs [--config absolute-config-path]\n');process.exit(2);}configPath=process.argv[3];}
let config;
try{config=loadConfig(configPath);}catch(error){process.stderr.write('[fgui-mcp] configuration rejected: '+(error.code||'CONFIG_INVALID')+'\n');process.exit(2);}
const bridge=new ProjectBridge(config,configPath,{helperPath:path.join(DIR,'helper.py')});
// ---- tool catalogue: name -> { description, inputSchema } ----
const obj = (properties, required) => ({
    type: "object",
    properties,
    ...(required ? { required } : {}),
});
const S = String;

const TOOLS = {
    discover_projects: {
        description: 'List all online FairyGUI editor projects with absolute paths and ports. Each editor command accepts project, port, or bridge_url.',
        inputSchema: obj({}),
    },
    ping: {
        description: "Check the bridge and editor status. Start here.",
        inputSchema: obj({}),
    },
    project_info: {
        description: "Get the currently open FairyGUI project (name, packages).",
        inputSchema: obj({}),
    },
    list_packages: {
        description: "List all UI packages (id, name, basePath) in the project.",
        inputSchema: obj({}),
    },
    list_items: {
        description:
            "List the resource tree of a package: components, images, fonts with ids/paths. " +
            "Item URLs are 'ui://<pkgId><itemId>'.",
        inputSchema: obj(
            {
                pkg: { type: S("string"), description: "package name or id" },
                depth: { type: S("number"), description: "tree depth (default 3, 1=flat top level)" },
            },
            ["pkg"],
        ),
    },
    read_component: {
        description:
            "Return the raw component XML source (the .xml under assets/<pkg>/). " +
            "Read this before editing to learn child ids/names.",
        inputSchema: obj(
            {
                pkg: { type: S("string") },
                name: { type: S("string"), description: "component resource name" },
            },
            ["pkg", "name"],
        ),
    },
    create_component: {
        description:
            "Create a new component in a package (CreateComponentItem). Only FairyGUI-supported types: " +
            "extention must be one of Button/Label/ComboBox/ProgressBar/Slider/ScrollBar/List/Tree (or omit for a plain component; " +
            "CheckBox/Radio do NOT exist - they are Button mode Check/Radio). Split by responsibility - never dump all resources into one component (STANDARDS 2/2.6).",
        inputSchema: obj(
            {
                pkg: { type: S("string") },
                name: { type: S("string") },
                width: { type: S("number") },
                height: { type: S("number") },
                path: { type: S("string"), description: "folder path inside package, '' = root" },
                extention: { type: S("string"), description: "Button/Label/ComboBox/ProgressBar/Slider/ScrollBar/List/Tree" },
                exported: { type: S("boolean") },
            },
            ["pkg", "name", "width", "height"],
        ),
    },
    delete_item: {
        description: "Delete a resource item from a package (use with care).",
        inputSchema: obj({ pkg: { type: S("string") }, name: { type: S("string") } }, ["pkg", "name"]),
    },
    list_children: {
        description: "Open a component and list its stage children (name/id/type).",
        inputSchema: obj({ pkg: { type: S("string") }, name: { type: S("string") } }, ["pkg", "name"]),
    },
    insert_object: {
        description:
            "Insert a library item onto a component's stage. Reference it by url, or by ref_pkg+ref_name. " +
            "Optionally set props right away (same keys as set-property).",
        inputSchema: obj(
            {
                pkg: { type: S("string") },
                name: { type: S("string"), description: "target component being edited" },
                url: { type: S("string"), description: "ui:// url of the item to insert" },
                ref_pkg: { type: S("string") },
                ref_name: { type: S("string") },
                x: { type: S("number") },
                y: { type: S("number") },
                index: { type: S("number"), description: "z-order index" },
                props: { type: S("object") },
            },
            ["pkg", "name"],
        ),
    },
    set_property: {
        description:
            "Set properties of a child inside a component via editor API (undo-aware). " +
            "props keys are FairyGUI editor property names, e.g. xy/size/title/text/icon/fontSize/visible. " +
            "Vector-like values use 'x,y' string form, e.g. {\"xy\":\"100,200\"}.",
        inputSchema: obj(
            {
                pkg: { type: S("string") },
                name: { type: S("string") },
                target: { type: S("string"), description: "child name or 'a/b' path; omit = component root" },
                props: { type: S("object"), description: "e.g. {\"title\":\"Start\",\"xy\":\"50,60\"}" },
            },
            ["pkg", "name", "props"],
        ),
    },
    remove_object: {
        description: "Remove a child from a component's stage.",
        inputSchema: obj(
            { pkg: { type: S("string") }, name: { type: S("string") }, target: { type: S("string") } },
            ["pkg", "name", "target"],
        ),
    },
    save_all: {
        description: "Save all open documents.", inputSchema: obj({}) },
    refresh: {
        description: "Refresh the project view (pick up external file changes).",
        inputSchema: obj({}),
    },
    publish: {
        description:
            "Publish a package (PublishHandler). out_path optional - defaults to the project publish setting. " +
            "Output is byte-identical to clicking Publish in the editor (works on the free editor).",
        inputSchema: obj(
            {
                pkg: { type: S("string") },
                branch: { type: S("string") },
                out_path: { type: S("string"), description: "absolute output directory (overrides publish setting)" },
                timeout_ms: { type: S("number") },
            },
            ["pkg"],
        ),
    },
    screenshot: {
        description: "Capture the editor window to a png (UnityEngine.ScreenCapture).",
        inputSchema: obj({ path: { type: S("string") } }, ["path"]),
    },
    bridge_log: {
        description: "Tail of the bridge log inside the editor (debugging).",
        inputSchema: obj({ tail: { type: S("number") } }),
    },
};

// Tighten the forked catalog; schemas are enforced here, not merely advertised.
const str=(max=128)=>({type:'string',minLength:1,maxLength:max});
const text={type:'string',maxLength:4096};
const integer=(min,max)=>({type:'integer',minimum:min,maximum:max});
const boolean={type:'boolean'};
const closed=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const pair={type:'string',minLength:3,maxLength:64,pattern:'^-?\\d+(?:\\.\\d+)?,-?\\d+(?:\\.\\d+)?$'};
const props=closed({text,title:text,icon:{type:'string',maxLength:1024},x:{type:'number',minimum:-1000000,maximum:1000000},y:{type:'number',minimum:-1000000,maximum:1000000},width:integer(0,100000),height:integer(0,100000),xy:pair,size:pair,fontSize:integer(1,1000),color:{type:'string',pattern:'^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$'},visible:boolean,touchable:boolean,grayed:boolean,alpha:{type:'number',minimum:0,maximum:1},rotation:{type:'number',minimum:-36000,maximum:36000},bold:boolean,italic:boolean});props.minProperties=1;
const pkgName={pkg:str(),name:str()};
for(const name of ['discover_projects','ping','project_info','list_packages','save_all','refresh'])TOOLS[name].inputSchema=closed();
TOOLS.list_items.inputSchema=closed({pkg:str(),depth:integer(0,8)},['pkg']);
for(const name of ['read_component','delete_item','list_children'])TOOLS[name].inputSchema=closed(pkgName,['pkg','name']);
TOOLS.create_component.inputSchema=closed({...pkgName,width:integer(1,16384),height:integer(1,16384),path:{type:'string',maxLength:256},extention:{type:'string',enum:['Button','Label','ComboBox','ProgressBar','Slider','ScrollBar','List','Tree']},exported:boolean},['pkg','name','width','height']);
TOOLS.insert_object.inputSchema=closed({...pkgName,url:{type:'string',minLength:14,maxLength:256,pattern:'^ui://[A-Za-z0-9]+$'},ref_pkg:str(),ref_name:str(),x:{type:'number',minimum:-1000000,maximum:1000000},y:{type:'number',minimum:-1000000,maximum:1000000},index:integer(0,32767),props},['pkg','name']);
TOOLS.set_property.inputSchema=closed({...pkgName,target:str(256),props},['pkg','name','props']);
TOOLS.remove_object.inputSchema=closed({...pkgName,target:str(256)},['pkg','name','target']);
TOOLS.publish.inputSchema=closed({pkg:str(),branch:{type:'string',maxLength:64,pattern:'^[A-Za-z0-9_-]*$'},out_path:{type:'string',const:config.publishDir},timeout_ms:integer(1000,120000)},['pkg']);
TOOLS.publish.description='Publish via original editor API; require native success and reopen/hash fresh package output. Artifact verification, not full semantic decoding or byte-equality proof.';
TOOLS.screenshot.inputSchema=closed({path:str(1024)},['path']);
TOOLS.screenshot.description='Ask the configured editor ScreenCapture API for a PNG confined to screenshotDir. A trimmed API may return an explicit failure; no OS capture fallback is silently substituted.';
TOOLS.bridge_log.inputSchema=closed({tail:integer(1,100)});
TOOLS.discover_projects.description='Ping only the one explicitly configured project. Never reads a global registry or selects another editor.';
TOOLS.editor_start={description:'Start or attach only the configured normal-GUI original editor through the local helper; no headless/license bypass.',inputSchema:closed()};
TOOLS.source_inspect={description:'Inspect the configured independent source-model project, not the live original editor.',inputSchema:closed()};
TOOLS.source_text_set={description:'Modify fixed source Gesture/Main/n1 via independent model, optional same-call undo/redo then save. Separate from original-editor native operations.',inputSchema:closed({text,expectedText:text,history:{type:'array',items:{type:'string',enum:['undo','redo']},maxItems:32}},['text'])};
TOOLS.source_publish={description:'Run the reconstructed graph/text subset publisher on configured source project. Not the original native editor publisher.',inputSchema:closed()};
const int32=integer(-2147483648,2147483647),nonnegativeInt32=integer(0,2147483647);
const sourcePair=item=>({type:'array',items:item,minItems:2,maxItems:2});
// Absolute end: JavaScript's dollar anchor alone also accepts a final newline.
const sourceColor={type:'string',minLength:7,maxLength:9,pattern:'^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?(?![\\s\\S])'};
const sourceProps=closed({xy:sourcePair(int32),size:sourcePair(nonnegativeInt32),text,fontSize:integer(1,32767),color:sourceColor,lineSize:nonnegativeInt32,lineColor:sourceColor,fillColor:sourceColor});
sourceProps.minProperties=1;
TOOLS.source_property_set={description:'Modify fixed independent source Gesture/Main object n0 (rect graph) or n1 (text, default); integer xy/size arrays, text/fontSize/color, or graph lineSize/lineColor/fillColor. Same-call undo/redo then save. Not a live original-editor mutation.',inputSchema:closed({objectId:{type:'string',enum:['n0','n1'],default:'n1'},props:sourceProps,history:{type:'array',items:{type:'string',enum:['undo','redo']},maxItems:32}},['props'])};
if(!config.sourceHelper)for(const name of Object.keys(TOOLS))if(name.startsWith('source_'))delete TOOLS[name];
const readOnly=new Set(['discover_projects','ping','project_info','list_packages','list_items','read_component','bridge_log','source_inspect']);
for(const [name,tool] of Object.entries(TOOLS))tool.annotations={readOnlyHint:readOnly.has(name),destructiveHint:!readOnly.has(name),idempotentHint:readOnly.has(name),openWorldHint:false};
function sanitize(value){if(typeof value==='string')return value.replaceAll(config.token,'[redacted]');if(Array.isArray(value))return value.map(sanitize);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,/token|authorization/i.test(k)?'[redacted]':sanitize(v)]));return value;}
async function callBridge(cmd,args){
  if(cmd==='editor_start'){const data=await bridge.helper('start',{},45000);bridge.sessionId=null;return {ok:true,data};}
  if(cmd==='source_property_set')return {ok:true,data:await bridge.helper(cmd,{...args,objectId:args.objectId??'n1'},30000)};
  if(['source_inspect','source_text_set','source_publish'].includes(cmd))return {ok:true,data:await bridge.helper(cmd,args,30000)};
  if(cmd==='discover_projects'){const ping=await bridge.ping();return {ok:true,data:{configuredOnly:true,instances:[{projectPath:config.projectPath,port:config.port,...ping.data}]}};}
  if(cmd==='ping')return bridge.ping();
  args=structuredClone(args);
  if(cmd==='create_component'&&args.path&&(args.path.split(/[\\/]/).some(v=>v==='..')||path.isAbsolute(args.path)))throw new BridgeError('PATH_REJECTED','Resource folder must be a package-internal path');
  if(cmd==='insert_object'&&!(args.url||args.ref_name))throw new BridgeError('INVALID_ARGUMENTS','insert_object requires url or ref_name');
  if(cmd==='insert_object'&&((args.x===undefined)!==(args.y===undefined)))throw new BridgeError('INVALID_ARGUMENTS','insert_object x/y must be supplied together');
  if(cmd==='screenshot')args.path=confinedPath(args.path,config.screenshotDir,'.png');
  if(cmd==='publish')args.out_path=config.publishDir;
  const duration=cmd==='publish'?(args.timeout_ms??120000):30000;
  const startedAtMs=Date.now();
  const out=await bridge.http(cmd,args,duration);
  if(cmd==='publish'){
    let verification;
    try{verification=await bridge.helper('verify_publish',{pkg:args.pkg,startedAtMs},15000);}
    catch(error){throw new BridgeError(error.code||'PUBLISH_VERIFICATION_FAILED','Native publish finished, but independent output verification failed',{native:out.data,requestId:out.requestId,sessionId:out.sessionId,verificationError:{code:error.code||'HELPER_FAILED',message:error.message}});}
    return {...out,data:{native:out.data,verification}};
  }
  return out;
}
// Line-delimited JSON-RPC, as upstream, with bounded lines and strict arguments.

let serial=Promise.resolve(),queueDepth=0,outputClosed=false;
const outstanding=new Set(),activeIds=new Set(),cancelled=new Set();
process.stdout.on('error',error=>{if(error.code==='EPIPE')outputClosed=true;else process.exitCode=1;});
function send(msg){if(!outputClosed)process.stdout.write(JSON.stringify(sanitize(msg))+'\n');}
function failure(id,code,message){send({jsonrpc:'2.0',id,error:{code,message}});}
async function toolCall(req){
  const name=req.params?.name,args=req.params?.arguments??{};
  if(!Object.hasOwn(TOOLS,name))return failure(req.id,-32602,'Unknown tool');
  try{
    validate(TOOLS[name].inputSchema,args);
    const invoke=async()=>{try{if(cancelled.has(req.id))throw new BridgeError('REQUEST_CANCELLED','Cancelled before dispatch; no editor call made');const out=await callBridge(name,args);send({jsonrpc:'2.0',id:req.id,result:{content:[{type:'text',text:JSON.stringify(sanitize(out),null,2)}],isError:false}});}catch(error){const out={ok:false,error:{code:error.code||'INTERNAL_ERROR',message:error instanceof BridgeError?error.message:'Local operation failed',...(error.details?{details:error.details}:{})}};send({jsonrpc:'2.0',id:req.id,result:{content:[{type:'text',text:JSON.stringify(sanitize(out),null,2)}],isError:true}});}};
    if(['ping','discover_projects'].includes(name))return await invoke();
    if(queueDepth>=32)throw new BridgeError('QUEUE_FULL','MCP operation queue is full');
    queueDepth++;const work=serial.then(invoke,invoke);serial=work.finally(()=>{queueDepth--;});await work;
  }catch(error){const out={ok:false,error:{code:error.code||'INVALID_ARGUMENTS',message:error instanceof BridgeError?error.message:'Arguments rejected'}};send({jsonrpc:'2.0',id:req.id,result:{content:[{type:'text',text:JSON.stringify(out)}],isError:true}});}
}
async function handle(req){
  if(!req||Array.isArray(req)||typeof req!=='object'||req.jsonrpc!=='2.0'||typeof req.method!=='string'||Object.keys(req).some(k=>!['jsonrpc','id','method','params'].includes(k)))return failure(req?.id??null,-32600,'Invalid request');
  if(req.id===undefined){if(req.method==='notifications/cancelled'&&activeIds.has(req.params?.requestId))cancelled.add(req.params.requestId);return;} // Active native effects are not rolled back by cancellation.
  if(req.id===null||!['string','number'].includes(typeof req.id)||typeof req.id==='number'&&!Number.isFinite(req.id))return failure(null,-32600,'Invalid request ID');
  if(activeIds.has(req.id))return failure(req.id,-32600,'Duplicate active request ID');
  activeIds.add(req.id);
  try{
    if(req.method==='initialize'){
      const offered=req.params?.protocolVersion;
      if(typeof offered!=='string')return failure(req.id,-32602,'protocolVersion required');
      const versions=['2025-06-18','2025-03-26','2024-11-05'];
      send({jsonrpc:'2.0',id:req.id,result:{protocolVersion:versions.includes(offered)?offered:versions[0],capabilities:{tools:{}},serverInfo:{name:'fgui-local-agent-bridge',version:'0.4.0'},instructions:'Single explicitly configured project. Native editor tools and independent source_* tools are separate execution layers.'}});
    }else if(req.method==='tools/list')send({jsonrpc:'2.0',id:req.id,result:{tools:Object.entries(TOOLS).map(([name,t])=>({name,...t}))}});
    else if(req.method==='tools/call')await toolCall(req);
    else if(req.method==='ping')send({jsonrpc:'2.0',id:req.id,result:{}});
    else failure(req.id,-32601,'Method not found');
  }finally{activeIds.delete(req.id);cancelled.delete(req.id);}
}
readLines(process.stdin,{maxBytes:MAX_BYTES,onOversize:()=>failure(null,-32700,'Input line exceeds64KiB'),onLine:line=>{
  if(!line.trim())return;
  if(Buffer.byteLength(line)>MAX_BYTES)return failure(null,-32700,'Input line exceeds64KiB');
  let req;try{req=parseJsonStrict(line);}catch{return failure(null,-32700,'Parse error');}
  if(outstanding.size>=64&&req?.id!==undefined)return failure(req.id,-32000,'Too many outstanding requests');
  const work=handle(req).catch(()=>failure(req?.id??null,-32603,'Internal error'));outstanding.add(work);work.finally(()=>outstanding.delete(work));
},onEnd:()=>{Promise.allSettled([...outstanding]).then(()=>{process.exitCode=0;});}});
process.stderr.write('[fgui-mcp] fixed-project stdio ready; transport is loopback/Bearer, no global discovery\n');
