// MIT fork of wingcd/fairygui-agent-bridge @4b3abc16da973b4a1d54325f61d2522455349168.
// See LICENSE. Upstream command handlers remain below; transport and bounds are adapted.
// No JS callbacks run on worker threads: completed managed I/O tasks are polled onUpdate.
"use strict";
var CS = require("csharp");
var FairyGUI = CS.FairyGUI, FairyEditor = CS.FairyEditor, App = FairyEditor.App;
var VERSION = "0.5.0-dev.2";
var PluginDir = String(App.pluginManager.basePath) + "/fgui-agent-bridge-custom";
var Config = null;
var SESSION = "custom-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
var Bridge = {listener:null,pendingAccept:null,queue:[],readers:[],writers:[],current:null,logLines:[],frame:0,updatedAtMs:Date.now(),port:null,backgroundOriginal:null,backgroundEffective:false,backgroundCaptured:false,backgroundHold:false,backgroundHoldAttempted:false,backgroundHoldReleased:false,backgroundFallback:false,stopped:false,subscribed:false,seen:Object.create(null),seenCount:0,completed:[],itemCount:0,appEntries:0,timerEntries:0,lastUnityFrame:-1,pumping:false,timerSubscribed:false,nextPumpDiagAt:0};
var LIMIT = {body:65536,response:65536,queue:32,readers:8,writers:32,bodyMs:5000,maxMs:120000,seen:4096,cache:64};
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function norm(p) { return String(p).replace(/\\/g,"/").replace(/\/+$/g,"").toLowerCase(); }
function canonical(p) { return norm(CS.System.IO.Path.GetFullPath(String(p))); }
function requireWithin(p,base) {
    var a=canonical(p),b=canonical(base);
    if (a !== b && a.indexOf(b+"/") !== 0) throw bridgeError("PATH_NOT_ALLOWED","Path must remain within configured directory");
    // Refuse existing reparse ancestors so junctions do not silently bypass the lexical bound.
    var cursor=String(CS.System.IO.Path.GetFullPath(String(p)));
    for(var n=0;n<128;n++) {
        if(CS.System.IO.File.Exists(cursor) || CS.System.IO.Directory.Exists(cursor)) {
            if((Number(CS.System.IO.File.GetAttributes(cursor)) & 1024)!==0) throw bridgeError("PATH_NOT_ALLOWED","Reparse ancestors are not supported");
        }
        var parent=String(CS.System.IO.Path.GetDirectoryName(cursor) || "");
        if(!parent || norm(parent)===norm(cursor)) break;
        cursor=parent;
    }
    return String(p);
}
function bridgeError(code,message) { var e=new Error(message);e.bridgeCode=code;return e; }
function ok(data) { return {ok:true,data:data===undefined?null:data,error:null}; }
function fail(message,code) { return {ok:false,data:null,error:{code:code||"EDITOR_API_ERROR",message:String(message)}}; }
function safeError(error) {
    if(!error)return null;
    var name="Error",message="";
    try{name=String(error.name || "ManagedOrBindingError");message=String(error.message || error).split("\n")[0];}catch(_){}
    if(Config && Config.token)message=message.split(Config.token).join("[redacted]");
    message=message.replace(/Bearer\s+[^\s"']+/ig,"Bearer [redacted]").replace(/[A-Za-z]:[\\/][^\s"']+/g,"[path]");
    return {type:name.replace(/[^A-Za-z0-9_.]/g,"").slice(0,80),message:message.slice(0,240)};
}
function plog(code,error,detail) {
    // Never record arbitrary exception text, paths, request arguments or the token.
    if(!/^[A-Z][A-Z0-9_]{1,63}$/.test(String(code))) code="UPSTREAM_HANDLER_DIAGNOSTIC";
    var row={updatedAtMs:Date.now(),sessionId:SESSION,frame:Bridge.frame,code:code,error:safeError(error),detail:detail || null};
    Bridge.logLines.push(row);if(Bridge.logLines.length>100)Bridge.logLines.shift();
    try { CS.System.IO.File.AppendAllText(PluginDir+"/diag.log",JSON.stringify(row)+"\n"); } catch(_) {}
}
function backgroundPolicy() {
    var actual=null;try{actual=!!CS.UnityEngine.Application.runInBackground;}catch(_){}
    Bridge.backgroundEffective=actual;
    return {original:Bridge.backgroundOriginal,effective:actual,holdActive:Bridge.backgroundHold,holdAttempted:Bridge.backgroundHoldAttempted,holdReleased:Bridge.backgroundHoldReleased,fallback:Bridge.backgroundFallback,restoreOnUnload:true};
}
function acquireBackgroundHold() {
    try{Bridge.backgroundOriginal=!!CS.UnityEngine.Application.runInBackground;Bridge.backgroundCaptured=true;}catch(error){plog("BACKGROUND_CAPTURE_FAILED",error);}
    // One reference per module lifetime. Never repeat Start after an uncertain native failure.
    Bridge.backgroundHoldAttempted=true;
    try{App.StartBackgroundJob();Bridge.backgroundHold=true;plog("BACKGROUND_HOLD_ACQUIRED",null,backgroundPolicy());}
    catch(error){
        Bridge.backgroundFallback=true;plog("BACKGROUND_HOLD_START_FAILED",error);
        try{CS.UnityEngine.Application.runInBackground=true;}catch(setError){plog("BACKGROUND_FALLBACK_FAILED",setError);}
    }
}
function projectDirectory() { return App.project ? String(App.project.basePath) : null; }
function projectLabel() { return App.project ? String(App.project.name) : ""; }
function projectAllowed() { return !!(Config && !App.batchMode && App.project && App.project.opened && canonical(App.project.basePath)===canonical(Config.projectPath)); }
function assertProject() { if(!projectAllowed())throw bridgeError("PROJECT_NOT_ALLOWED","Only the configured ordinary-GUI project is available"); }
function readProjectXml(p) {
    requireWithin(p,Config.projectPath);
    if(Number(new CS.System.IO.FileInfo(p).Length)>LIMIT.body)throw bridgeError("RESULT_LIMIT","Component source exceeds64KiB");
    return String(CS.System.IO.File.ReadAllText(p));
}
var PROP_NAMES=["text","title","icon","x","y","width","height","xy","size","fontSize","color","visible","touchable","grayed","alpha","rotation","bold","italic"];
var BOOL_PROPS=["visible","touchable","grayed","bold","italic"], STRING_PROPS=["text","title","icon","color"];
function object(v) { return v && typeof v==="object" && !Array.isArray(v); }
function parseVector(key,value) {
    if(typeof value!=="string" || value.length>80 || !/^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/.test(value))throw bridgeError("INVALID_ARGUMENTS","Vector must contain exactly two decimal numbers");
    var parts=value.split(","),x=Number(parts[0]),y=Number(parts[1]);
    if(parts.length!==2 || !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x)>1000000 || Math.abs(y)>1000000 || (key==="size" && (x<0 || y<0)))throw bridgeError("INVALID_ARGUMENTS","Vector values must be finite, bounded and dimensions nonnegative");
    return [x,y];
}
function validateProps(props) {
    if(!object(props) || Object.keys(props).length>32)throw bridgeError("INVALID_ARGUMENTS","props must be a bounded object");
    Object.keys(props).forEach(function(k){
        var v=props[k];if(PROP_NAMES.indexOf(k)<0)throw bridgeError("PROPERTY_NOT_ALLOWED","Property is not in supported allowlist");
        if(BOOL_PROPS.indexOf(k)>=0) { if(typeof v!=="boolean")throw bridgeError("INVALID_ARGUMENTS","Boolean property required"); }
        else if(STRING_PROPS.indexOf(k)>=0) { if(typeof v!=="string" || v.length>4096)throw bridgeError("INVALID_ARGUMENTS","Bounded string property required"); }
        else if(k==="xy" || k==="size") { parseVector(k,v); }
        else if(typeof v!=="number" || !Number.isFinite(v) || Math.abs(v)>1000000)throw bridgeError("INVALID_ARGUMENTS","Finite numeric property required");
    });
}
function validateItemUrl(url) {
    if(typeof url!=="string" || !/^ui:\/\/[A-Za-z0-9]+$/.test(url) || url.length>256)throw bridgeError("INVALID_ARGUMENTS","Only project ui item URLs supported");
    var pkg=App.project.GetPackage(url.slice(5,13));if(!pkg)throw bridgeError("OBJECT_NOT_ALLOWED","URL package not in current project");
    requireWithin(pkg.basePath,Config.projectPath);
}
var ARG_KEYS={relation_list:["pkg","name","objectId","offset","limit"],relation_set:["pkg","name","objectId","targetId","definitions"],relation_remove:["pkg","name","objectId","targetId"],controller_list:["pkg","name","controller","offset","limit"],controller_create:["pkg","name","controller","pages","exported"],controller_update:["pkg","name","controller","newName","pageNames","exported"],controller_select:["pkg","name","controller","index"],controller_remove:["pkg","name","controller"],list_items_page:["pkg","limit","cursor"],ping:[],project_info:[],list_packages:[],list_items:["pkg","depth"],read_component:["pkg","name"],create_component:["pkg","name","width","height","path","exported","extention"],delete_item:["pkg","name"],open_doc:["pkg","name"],close_doc:["pkg","name"],list_children:["pkg","name"],insert_object:["pkg","name","url","ref_pkg","ref_name","x","y","index","props"],set_property:["pkg","name","target","props","prop","value"],remove_object:["pkg","name","target"],save_all:[],refresh:[],screenshot:["path"],bridge_log:["tail"],publish:["pkg","branch","out_path","timeout_ms"]};
function validateArgs(cmd,a) {
    if(!object(a))throw bridgeError("INVALID_ARGUMENTS","args must be object");
    Object.keys(a).forEach(function(k){if(ARG_KEYS[cmd].indexOf(k)<0)throw bridgeError("INVALID_ARGUMENTS","Unsupported argument key");});
    ["pkg","name","ref_pkg","ref_name","target"].forEach(function(k){if(a[k]!==undefined && (typeof a[k]!=="string" || !a[k].length || a[k].length>256 || /[\u0000-\u001f]/.test(a[k])))throw bridgeError("INVALID_ARGUMENTS","Bounded nonempty identifier required");});
    if(ARG_KEYS[cmd].indexOf("pkg")>=0 && !a.pkg)throw bridgeError("INVALID_ARGUMENTS","pkg required");
    if(ARG_KEYS[cmd].indexOf("name")>=0 && !a.name)throw bridgeError("INVALID_ARGUMENTS","name required");
    if(a.limit!==undefined && (!Number.isInteger(a.limit)||a.limit<1||a.limit>100))throw bridgeError("INVALID_ARGUMENTS","limit1..100 required");
    if(a.cursor!==undefined && (typeof a.cursor!=="string"||a.cursor.length<1||a.cursor.length>160))throw bridgeError("INVALID_ARGUMENTS","Bounded cursor string required");
    if(cmd.indexOf("relation_")===0)validateRelationArgs(cmd,a);
    if(cmd.indexOf("controller_")===0)validateControllerArgs(cmd,a);
    if(a.props!==undefined)validateProps(a.props);
    if(a.prop!==undefined){var x={};x[a.prop]=a.value;validateProps(x);}
    ["width","height","x","y"].forEach(function(k){if(a[k]!==undefined && (typeof a[k]!=="number" || !Number.isFinite(a[k]) || Math.abs(a[k])>1000000))throw bridgeError("INVALID_ARGUMENTS","Finite bounded geometry required");});
    if(a.index!==undefined && (!Number.isInteger(a.index)||a.index<0||a.index>32767))throw bridgeError("INVALID_ARGUMENTS","index0..32767 required");
    if(a.depth!==undefined && (!Number.isInteger(a.depth)||a.depth<0||a.depth>8))throw bridgeError("INVALID_ARGUMENTS","depth0..8 required");
    if(a.tail!==undefined && (!Number.isInteger(a.tail)||a.tail<1||a.tail>100))throw bridgeError("INVALID_ARGUMENTS","tail1..100 required");
    if(a.timeout_ms!==undefined && (!Number.isInteger(a.timeout_ms)||a.timeout_ms<1000||a.timeout_ms>120000))throw bridgeError("INVALID_ARGUMENTS","timeout_ms1000..120000 required");
    if(a.branch!==undefined && (typeof a.branch!=="string" || a.branch.length>64 || !/^[A-Za-z0-9_-]*$/.test(a.branch)))throw bridgeError("INVALID_ARGUMENTS","Invalid branch");
    if(a.extention!==undefined && ["Button","Label","ComboBox","ProgressBar","Slider","ScrollBar","List","Tree"].indexOf(a.extention)<0)throw bridgeError("INVALID_ARGUMENTS","Unsupported extension");
    if(a.path!==undefined && cmd==="create_component" && (typeof a.path!=="string" || a.path.length>256 || /(^[\/\\]|:|\.\.|[\u0000-\u001f])/.test(a.path)))throw bridgeError("PATH_NOT_ALLOWED","Component path must be relative without traversal");
    if(cmd==="create_component" && /[\/\\:.]/.test(a.name))throw bridgeError("INVALID_ARGUMENTS","Component name must be a simple name");
    if(cmd==="screenshot" && a.path!==undefined)requireWithin(a.path,Config.screenshotDir);
    if(cmd==="publish" && a.out_path!==undefined && canonical(a.out_path)!==canonical(Config.publishDir))throw bridgeError("PATH_NOT_ALLOWED","Publish path must equal configured publishDir");
}
