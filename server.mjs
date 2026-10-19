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
TOOLS.publish.inputSchema=closed({pkg:str(),branch:{type:'string',maxLength:64,pattern:'^[A-Za-z0-9_-]*$'},branchMode:{type:'string',enum:['configured','all','selected','trunk']},out_path:{type:'string',const:config.publishDir},timeout_ms:integer(1000,120000)},['pkg']);
TOOLS.publish.description='Publish through original editor. branchMode: configured (default), all, selected with branch, or trunk without branch (base resources only). A branch under configured all-mode is rejected rather than ignored. Timeout is not cancellation: native work drains before another queued command. Reopen/hash fresh output, not full semantic proof.';
TOOLS.screenshot.inputSchema=closed({path:str(1024)},['path']);
TOOLS.screenshot.description='Capture the editor root UI through its native display API, save PNG and validate the file; excludes desktop and window chrome.';
TOOLS.bridge_log.inputSchema=closed({tail:integer(1,100)});
TOOLS.discover_projects.description='Ping only the one explicitly configured project. Never reads a global registry or selects another editor.';
TOOLS.editor_start={description:'Start/attach configured normal-GUI editor. Optional recoverPublish=true prepares authenticated external owner proof and confirms native interrupted-publish recovery; live/unknown owners remain blocked.',inputSchema:closed({recoverPublish:{type:'boolean'}})};
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
TOOLS.list_items_page={description:'Bounded depth-first flat resource pages. Single-use session cursor expires after60s; bridge mutations invalidate it. Prefer over list_items for large packages.',inputSchema:closed({pkg:str(),limit:integer(1,100),cursor:str(160)},['pkg'])};
const controllerName={type:'string',minLength:1,maxLength:128,pattern:'^[^,\\r\\n]+$'};
TOOLS.controller_list={description:'Read bounded live controller pages and stable page IDs; nextOffset continues (not a snapshot). Optional controller reads one by name. Opens the document.',inputSchema:closed({...pkgName,controller:controllerName,offset:integer(0,100000),limit:integer(1,100)},['pkg','name'])};
TOOLS.controller_create={description:'Create a native controller, save, and read back generated page IDs. Rejects dirty documents and duplicate names.',inputSchema:closed({...pkgName,controller:controllerName,pages:{type:'array',items:controllerName,minItems:1,maxItems:100},exported:boolean},['pkg','name','controller','pages'])};
TOOLS.controller_update={description:'Rename/export a controller or rename existing pages by stable ID. Preserves page IDs, actions and unedited fields. Saves through the native facade. Renaming may break native Undo; returned history warning applies.',inputSchema:closed({...pkgName,controller:controllerName,newName:controllerName,exported:boolean,pageNames:{type:'array',items:closed({id:str(),name:controllerName},['id','name']),minItems:1,maxItems:100}},['pkg','name','controller'])};
TOOLS.controller_select={description:'Switch a live controller preview page through Document.SwitchPage; returns previous and observed selected index. Selection persistence is editor-defined.',inputSchema:closed({...pkgName,controller:controllerName,index:integer(0,99)},['pkg','name','controller','index'])};
TOOLS.controller_remove={description:'Remove a controller via the native document API and save. This may remove linked gears/actions; inspect the component first.',inputSchema:closed({...pkgName,controller:controllerName},['pkg','name','controller'])};
const transitionBase={...pkgName,transition:controllerName};
const transitionKey={...transitionBase,targetId:str(),type:{type:'string',enum:['XY','Size','Scale','Skew','Alpha','Rotation']},frame:integer(0,36000)};
const transitionRequired=['pkg','name','transition'];
const keyRequired=[...transitionRequired,'targetId','type','frame'];
TOOLS.transition_list={description:'List native transition summaries, or keyframes for a named transition, in bounded offset pages. Opens document; pages are not snapshots.',inputSchema:closed({...transitionBase,offset:integer(0,100000),limit:integer(1,100)},['pkg','name'])};
TOOLS.transition_create={description:'Create and save an empty native transition. No timeline playback. Rejects dirty documents and active timeline.',inputSchema:closed(transitionBase,transitionRequired)};
const transitionSettings=closed({frameRate:integer(1,120),autoPlay:boolean,autoPlayRepeat:integer(1,100),autoPlayDelay:{type:'number',minimum:0,maximum:60}});transitionSettings.minProperties=1;
TOOLS.transition_update={description:'Update native transition settings, preserving supported numeric keyframes and unedited metadata; rejects complex action/path/custom-ease transitions. Uses temporary timeline context then exits/restores design state and saves. No ordinary Undo guarantee.',inputSchema:closed({...transitionBase,settings:transitionSettings},[...transitionRequired,'settings'])};
TOOLS.transition_remove={description:'Remove a native transition and save. References from actions are editor-defined; inspect component first. No Undo guarantee.',inputSchema:closed(transitionBase,transitionRequired)};
TOOLS.transition_keyframe_set={description:'Upsert a direct-child keyframe by targetId/type/frame. values=[x,y] for XY/Size/Scale/Skew; [n] for Alpha/Rotation. Create a later same-track endpoint before setting tween=true. Paths/actions not edited. Saves via temporary native timeline; no Undo guarantee.',inputSchema:closed({...transitionKey,values:{type:'array',items:{type:'number',minimum:-1000000,maximum:1000000},minItems:1,maxItems:2},tween:boolean,label:{type:'string',maxLength:128}},[...keyRequired,'values'])};
TOOLS.transition_keyframe_remove={description:'Remove exactly one keyframe tuple; rejects removal leaving a tween without an endpoint. Saves native transition without replacing other transitions.',inputSchema:closed(transitionKey,keyRequired)};
TOOLS.transition_sample={description:'Evaluate a bounded numeric transition at one frame through native edit-mode playback, sample1..20 direct children, then stop and restore design geometry without saving. Rejects paths/actions/custom easing, dirty documents and active timelines. Revision-coordinated despite no save.',inputSchema:closed({...transitionBase,frame:integer(0,36000),targetIds:{type:'array',items:str(),minItems:1,maxItems:20}},[...transitionRequired,'frame','targetIds'])};
const relationTypes=["Left_Left", "Left_Center", "Left_Right", "Center_Center", "Right_Left", "Right_Center", "Right_Right", "LeftExt_Left", "LeftExt_Right", "RightExt_Left", "RightExt_Right", "Width", "Top_Top", "Top_Middle", "Top_Bottom", "Middle_Middle", "Bottom_Top", "Bottom_Middle", "Bottom_Bottom", "TopExt_Top", "TopExt_Bottom", "BottomExt_Top", "BottomExt_Bottom", "Height", "Size"];
TOOLS.relation_list={description:'Read bounded relations and geometry of a direct component child by ID. Offset pages are not snapshots.',inputSchema:closed({...pkgName,objectId:str(),offset:integer(0,100000),limit:integer(1,100)},['pkg','name','objectId'])};
TOOLS.relation_set={description:'Replace all relation definitions for one parent/sibling target only, using editor enums. targetId=$parent or direct child ID. Native layout write/save; no Undo guarantee.',inputSchema:closed({...pkgName,objectId:str(),targetId:str(),definitions:{type:'array',minItems:1,maxItems:25,items:closed({type:{type:'string',enum:relationTypes},percent:boolean},['type'])}},['pkg','name','objectId','targetId','definitions'])};
TOOLS.relation_remove={description:'Remove one parent/sibling relation target group and save. Does not remove other targets or restore past geometry.',inputSchema:closed({...pkgName,objectId:str(),targetId:str()},['pkg','name','objectId','targetId'])};
if(!config.sourceHelper)for(const name of Object.keys(TOOLS))if(name.startsWith('source_'))delete TOOLS[name];
const genericSourceNames=['source_capabilities','source_state','source_command','source_receipt_read','source_sound_upload'];
if(config.sourceProtocol==='fgui-rebuild-http/1'){
  for(const name of Object.keys(TOOLS))if(name.startsWith('source_'))delete TOOLS[name];
  const nullableSelector={anyOf:[{type:'null'},str(256)]};
  const requestId={type:'string',minLength:32,maxLength:32,pattern:'^[a-f0-9]{32}$'};
  TOOLS.source_capabilities={description:'Read actual capabilities and limits of the explicitly configured independent reconstructed editor. Separate from original/native editor tools.',inputSchema:closed()};
  TOOLS.source_state={description:'Read arbitrary configured reconstructed package/component state with session/revision. Large states automatically return an immutable snapshot pointer; snapshot=true forces one. Continue with snapshotId/offset/limit; limit1..65536 Unicode characters (default65536), automatically reduced to fit60KiB helper JSON. Follow actual nextOffset, verify UTF8 SHA256, and respect expiresAtMs (local120s; upstream600s). Above8MiB HTTP state automatically uses bounded upstream snapshot pages (32MiB UTF8 cache). Inspect payloadFormat: upstream pages contain the HTTP state envelope without adapter wrapper. Snapshots are not current state. No native-editor execution.',inputSchema:{type:'object',anyOf:[closed({package:nullableSelector,component:nullableSelector,snapshot:boolean}),closed({snapshotId:requestId,offset:integer(0,Number.MAX_SAFE_INTEGER),limit:integer(1,65536)},['snapshotId'])]}};
  TOOLS.source_command={description:'Execute an advertised operation in the persistent reconstructed editor using explicit session/revision and requestId. Operation-specific args are validated by that backend. No automatic retry. Receipts prevent duplicate dispatch; partial/unknown outcomes require inspection. Large receipts are durable and paged.',inputSchema:closed({requestId,session:{type:'string',minLength:16,maxLength:128,pattern:'^[A-Za-z0-9_-]+$'},expectedRevision:integer(0,Number.MAX_SAFE_INTEGER),package:nullableSelector,component:nullableSelector,operation:{type:'string',minLength:1,maxLength:64,pattern:'^[a-z][a-z0-9_]*$'},args:{type:'object',properties:{},additionalProperties:true}},['requestId','session','expectedRevision','package','component','operation','args'])};
  TOOLS.source_receipt_read={description:'Read a durable command receipt as byte-budgeted Unicode fragments by requestId; limit1..65536 characters, default65536, actual page may be smaller to fit60KiB. Follow nextOffset and verify full UTF8 SHA256; no command is replayed. Separate reconstructed layer.',inputSchema:closed({requestId,offset:integer(0,Number.MAX_SAFE_INTEGER),limit:integer(1,65536)},['requestId'])};
  if(config.sourceUploads===true)TOOLS.source_sound_upload={description:'Upload one local WAV/MP3/OGG source file only beneath explicitly configured backend uploadRoots. Requires opt-in sourceUploads=true. Streams up to64MiB without putting binary bytes in MCP JSON. Caller-generated requestId binds one intent; durable receipts prevent duplicate upload, including after helper restart. Completed replay returns historical metadata, not a new lease. Upload is session-owned and single-use; use returned uploadId in a separately revision-checked source_command sound_import/sound_replace. Raw-byte capture does not verify a decoder. No automatic retry or original-editor execution.',inputSchema:closed({requestId,session:{type:'string',minLength:16,maxLength:128,pattern:'^[A-Za-z0-9_-]+$'},expectedRevision:integer(0,Number.MAX_SAFE_INTEGER),filePath:str(2048)},['requestId','session','expectedRevision','filePath'])};
}
const readOnly=new Set(['discover_projects','ping','project_info','list_packages','list_items','list_items_page','read_component','bridge_log','source_inspect','source_capabilities','source_state','source_receipt_read']);
for(const [name,tool] of Object.entries(TOOLS))tool.annotations={readOnlyHint:readOnly.has(name),destructiveHint:!readOnly.has(name),idempotentHint:readOnly.has(name)&&name!=='list_items_page',openWorldHint:false};
function sanitize(value,planResult=false){
  if(typeof value==='string')return value.replaceAll(config.token,'[redacted]');
  if(Array.isArray(value))return value.map(item=>sanitize(item));
  if(value&&typeof value==='object'){
    const sourcePlan=value.contract==='fgui-rebuild-http/1'&&value.layer==='independent-source-http'&&value.nativeEditorExecuted===false&&value.ok===true&&Number.isSafeInteger(value.revision)&&value.revision>=0&&typeof value.session==='string'&&value.result&&typeof value.result==='object'&&!Array.isArray(value.result)&&typeof value.result.planToken==='string'&&/^[A-Za-z0-9_-]{32}$/.test(value.result.planToken)&&Number.isFinite(value.result.expiresInSeconds)&&value.result.expiresInSeconds>0&&value.result.expiresInSeconds<=120&&value.result.migration&&typeof value.result.migration==='object'&&typeof value.result.migration.planId==='string'&&/^[a-f0-9]{32}$/.test(value.result.migration.planId);
    return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,/token|authorization/i.test(k)&&!(planResult&&k==='planToken'&&typeof v==='string'&&/^[A-Za-z0-9_-]{32}$/.test(v))?'[redacted]':sanitize(v,!!sourcePlan&&k==='result')]));
  }
  return value;
}
async function callBridge(cmd,args){
  if(config.sourceProtocol==='fgui-rebuild-http/1'&&genericSourceNames.includes(cmd)){
    const data=await bridge.helper(cmd,args,250000);
    if(data.ok!==true||data.result?.receiptOnly&&data.result.operationOk===false)throw new BridgeError(data.error?.code||'SOURCE_OPERATION_FAILED',data.error?.message||'Independent operation failed; inspect its receipt',{sourceBackend:data});
    return {ok:true,data};
  }
  if(cmd==='editor_start'){
    const data=await bridge.helper('start',{},45000);bridge.sessionId=null;bridge.revision=null;
    if(args.recoverPublish===true){
      const prepared=await bridge.helper('recover_publish',{},15000);
      let observed=await bridge.ping();const deadline=Date.now()+6000;
      while(prepared.prepared&&prepared.recoveryPermitted&&observed.data.publishRecovery?.blocked&&Date.now()<deadline){await new Promise(r=>setTimeout(r,200));observed=await bridge.ping();}
      const state=observed.data.publishRecovery;
      if(state?.blocked)throw new BridgeError('PUBLISH_RECOVERY_PENDING','Native recovery remains blocked; inspect fresh ping without replaying a publish',{recovery:state,prepared});
      data.recovery={prepared,confirmed:true,state};data.ping=observed.data;
    }
    return {ok:true,data};
  }
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
  if(cmd==='screenshot'){const verification=await bridge.helper('verify_screenshot',{path:args.path},15000);return {...out,data:{...out.data,verified:true,verification}};}
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
      send({jsonrpc:'2.0',id:req.id,result:{protocolVersion:versions.includes(offered)?offered:versions[0],capabilities:{tools:{}},serverInfo:{name:'fgui-local-agent-bridge',version:'0.6.0'},instructions:'Single explicitly configured project. Native editor tools and independent source_* tools are separate execution layers.'}});
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
