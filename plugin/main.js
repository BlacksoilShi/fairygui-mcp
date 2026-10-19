// MIT fork of wingcd/fairygui-agent-bridge @4b3abc16da973b4a1d54325f61d2522455349168.
// See LICENSE. Upstream command handlers remain below; transport and bounds are adapted.
// No JS callbacks run on worker threads: completed managed I/O tasks are polled onUpdate.
"use strict";
var CS = require("csharp");
var FairyGUI = CS.FairyGUI, FairyEditor = CS.FairyEditor, App = FairyEditor.App;
var VERSION = "0.6.0";
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
var ARG_KEYS={transition_sample:["pkg","name","transition","frame","targetIds"],transition_list:["pkg", "name", "transition", "offset", "limit"],transition_create:["pkg", "name", "transition"],transition_update:["pkg", "name", "transition", "settings"],transition_remove:["pkg", "name", "transition"],transition_keyframe_set:["pkg", "name", "transition", "targetId", "type", "frame", "values", "tween", "label"],transition_keyframe_remove:["pkg", "name", "transition", "targetId", "type", "frame"],relation_list:["pkg","name","objectId","offset","limit"],relation_set:["pkg","name","objectId","targetId","definitions"],relation_remove:["pkg","name","objectId","targetId"],controller_list:["pkg","name","controller","offset","limit"],controller_create:["pkg","name","controller","pages","exported"],controller_update:["pkg","name","controller","newName","pageNames","exported"],controller_select:["pkg","name","controller","index"],controller_remove:["pkg","name","controller"],list_items_page:["pkg","limit","cursor"],ping:[],project_info:[],list_packages:[],list_items:["pkg","depth"],read_component:["pkg","name"],create_component:["pkg","name","width","height","path","exported","extention"],delete_item:["pkg","name"],open_doc:["pkg","name"],close_doc:["pkg","name"],list_children:["pkg","name"],insert_object:["pkg","name","url","ref_pkg","ref_name","x","y","index","props"],set_property:["pkg","name","target","props","prop","value"],remove_object:["pkg","name","target"],save_all:[],refresh:[],screenshot:["path"],bridge_log:["tail"],publish:["pkg","branch","branchMode","out_path","timeout_ms"]};
function validateArgs(cmd,a) {
    if(!object(a))throw bridgeError("INVALID_ARGUMENTS","args must be object");
    Object.keys(a).forEach(function(k){if(ARG_KEYS[cmd].indexOf(k)<0)throw bridgeError("INVALID_ARGUMENTS","Unsupported argument key");});
    ["pkg","name","ref_pkg","ref_name","target"].forEach(function(k){if(a[k]!==undefined && (typeof a[k]!=="string" || !a[k].length || a[k].length>256 || /[\u0000-\u001f]/.test(a[k])))throw bridgeError("INVALID_ARGUMENTS","Bounded nonempty identifier required");});
    if(ARG_KEYS[cmd].indexOf("pkg")>=0 && !a.pkg)throw bridgeError("INVALID_ARGUMENTS","pkg required");
    if(ARG_KEYS[cmd].indexOf("name")>=0 && !a.name)throw bridgeError("INVALID_ARGUMENTS","name required");
    if(a.limit!==undefined && (!Number.isInteger(a.limit)||a.limit<1||a.limit>100))throw bridgeError("INVALID_ARGUMENTS","limit1..100 required");
    if(a.cursor!==undefined && (typeof a.cursor!=="string"||a.cursor.length<1||a.cursor.length>160))throw bridgeError("INVALID_ARGUMENTS","Bounded cursor string required");
    if(cmd.indexOf("transition_")===0)validateTransitionArgs(cmd,a);
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
    if(cmd==="publish"){
        if(a.branchMode!==undefined && ["configured","all","selected","trunk"].indexOf(a.branchMode)<0)throw bridgeError("INVALID_ARGUMENTS","branchMode must be configured, all, selected or trunk");
        if(a.branchMode==="selected" && !a.branch)throw bridgeError("INVALID_ARGUMENTS","selected requires a nonempty branch");
        if((a.branchMode==="all" || a.branchMode==="trunk") && a.branch)throw bridgeError("INVALID_ARGUMENTS","all and trunk do not accept a selected branch");
    }
    if(a.extention!==undefined && ["Button","Label","ComboBox","ProgressBar","Slider","ScrollBar","List","Tree"].indexOf(a.extention)<0)throw bridgeError("INVALID_ARGUMENTS","Unsupported extension");
    if(a.path!==undefined && cmd==="create_component" && (typeof a.path!=="string" || a.path.length>256 || /(^[\/\\]|:|\.\.|[\u0000-\u001f])/.test(a.path)))throw bridgeError("PATH_NOT_ALLOWED","Component path must be relative without traversal");
    if(cmd==="create_component" && /[\/\\:.]/.test(a.name))throw bridgeError("INVALID_ARGUMENTS","Component name must be a simple name");
    if(cmd==="screenshot" && a.path!==undefined)requireWithin(a.path,Config.screenshotDir);
    if(cmd==="publish" && a.out_path!==undefined && canonical(a.out_path)!==canonical(Config.publishDir))throw bridgeError("PATH_NOT_ALLOWED","Publish path must equal configured publishDir");
}
function getPkg(nameOrId) {
    assertProject();
    var p = App.project.GetPackageByName(String(nameOrId));
    if (p == null) p = App.project.GetPackage(String(nameOrId));
    if (p == null) throw "package not found: " + nameOrId;
    // packages are lazily loaded: the item tree (rootItem.children) is only
    // populated after EnsureOpen, otherwise it looks empty
    try { if (!p.opened) p.EnsureOpen(); } catch (e) { plog("EnsureOpen(" + nameOrId + "): " + e); }
    requireWithin(p.basePath, Config.projectPath);
    return p;
}

function itemUrl(pkg, item) {
    // Encoded item URLs reserve exactly eight characters for the package ID.
    // A short handmade package ID silently eats the beginning of the item ID.
    if (String(pkg.id).length !== 8) {
        throw "invalid package id '" + pkg.id + "' in package '" + pkg.name +
            "': FairyGUI encoded URLs require 8 characters; repair package.xml and its ui:// references before editing";
    }
    return "ui://" + pkg.id + item.id;
}

function findItem(pkg, name, recursiveFrom) {
    var root = recursiveFrom || pkg.rootItem;
    if (root == null || root.name === name) return root;
    var ch = root.children;
    if (ch == null) return null;
    for (var i = 0; i < ch.Count; i++) {
        var r = findItem(pkg, name, ch.get_Item(i));
        if (r != null) return r;
    }
    return null;
}

function requireComponentItem(pkg, compName) {
    var it = findItem(pkg, compName);
    if (it == null) throw "component not found in package '" + pkg.name + "': " + compName;
    return it;
}

function ensureDocOpen(pkg, compName) {
    var item = requireComponentItem(pkg, compName), url = itemUrl(pkg,item);
    var doc = App.docView.FindDocument(url);
    // Restored inactive tabs can exist before their document content is loaded.
    if (doc == null || doc.content == null) doc = App.docView.OpenDocument(url,true);
    if (doc == null) throw bridgeError("DOCUMENT_OPEN_FAILED", "OpenDocument returned no document");
    return {doc:doc,item:item,url:url};
}

function itemInfo(pkg, item, depth) {
    if (++Bridge.itemCount > 1024) throw bridgeError("RESULT_LIMIT", "Item traversal limit reached");
    var o = {
        id: item.id,
        name: item.name,
        type: item.type,
        path: item.path,
        exported: false,
        width: item.width,
        height: item.height
    };
    try { o.exported = item.exported; } catch (e) { }
    try { o.file = item.file; } catch (e) { }
    if (depth > 0 && item.children != null) {
        o.children = [];
        var ch = item.children;
        for (var i = 0; i < ch.Count; i++) {
            o.children.push(itemInfo(pkg, ch.get_Item(i), depth - 1));
        }
    }
    return o;
}

function propValueIn(v) {
    // pass-through: numbers/bools as-is, everything else as string
    return v;
}

// ---------------- command implementations (sync) ----------------

var COMMANDS = {};

COMMANDS.ping = function (a) {
    return ok({
        version: VERSION,revision:Coordination.revision,coordination:"optimistic-revision-v1",
        frame: Bridge.frame, updatedAtMs: Bridge.updatedAtMs, sessionId: SESSION,
        ready: projectAllowed(), busy: Bridge.current != null,
        activeOperation: Bridge.current?{command:Bridge.current.cmd,phase:Bridge.current.phase,responseSent:!!Bridge.current.responded,nativeTaskCompleted:Bridge.current.handler?publishFinished(Bridge.current):null}:null,
        lastPublishCleanup: Bridge.lastPublishCleanup || null,
        publishRecovery: Bridge.publishRecovery || null,
        publishRecoveryChallenge: publishRecoveryChallenge(),
        backgroundPolicy: backgroundPolicy(),
        editor: "FairyGUI",
        port: Bridge.port,
        projectPath: projectDirectory(),
        projectOpen: App.project != null,
        project: projectLabel()
    });
};

COMMANDS.project_info = function (a) {
    if (App.project == null) throw "no project open";
    var p = App.project;
    var d = { port: Bridge.port, packages: p.allPackages.Count, packageNames: [] };
    d.projectPath = projectDirectory();
    try { d.name = p.name; } catch (e) { }
    try { d.path = p.projectPath; } catch (e) { }
    for (var i = 0; i < p.allPackages.Count; i++) {
        d.packageNames.push(p.allPackages.get_Item(i).name);
    }
    return ok(d);
};

COMMANDS.list_packages = function (a) {
    if (App.project == null) throw "no project open";
    var arr = [];
    var ps = App.project.allPackages;
    for (var i = 0; i < ps.Count; i++) {
        var p = ps.get_Item(i);
        arr.push({ id: p.id, name: p.name, basePath: p.basePath });
    }
    return ok(arr);
};

COMMANDS.list_items = function (a) {
    var pkg = getPkg(a.pkg);
    return ok(itemInfo(pkg, pkg.rootItem, a.depth === undefined ? 3 : a.depth));
};

COMMANDS.read_component = function (a) {
    var pkg = getPkg(a.pkg);
    var item = requireComponentItem(pkg, a.name);
    return ok({
        name: item.name,
        url: itemUrl(pkg, item),
        xml: readProjectXml(item.file)
    });
};

COMMANDS.create_component = function (a) {
    var pkg = getPkg(a.pkg);
    if (String(pkg.id).length !== 8) itemUrl(pkg, { id: "" });
    if (!(a.width > 0 && a.height > 0)) throw "positive component width and height required";
    if (!a.name || findItem(pkg, String(a.name))) throw "component name missing or already exists: " + a.name;
    // both path and extentionId must be null (not "") when unused - the
    // empty string breaks internal dictionary lookups in CreateComponentItem
    var path = a.path ? String(a.path) : null;
    var exported = a.exported === undefined ? true : !!a.exported;
    var ext = a.extention ? String(a.extention) : null;
    var it = pkg.CreateComponentItem(String(a.name), a.width | 0, a.height | 0, path, ext, exported, false);
    pkg.Save();
    // Do not report a usable component until the editor can load its document.
    var opened = ensureDocOpen(pkg, it.name);
    return ok({ id: it.id, name: it.name, url: opened.url, file: it.file, openable: true });
};

COMMANDS.delete_item = function (a) {
    var pkg = getPkg(a.pkg);
    var item = requireComponentItem(pkg, a.name);
    pkg.DeleteItem(item);
    pkg.Save();
    return ok({ deleted: a.name });
};

COMMANDS.open_doc = function (a) {
    var pkg = getPkg(a.pkg);
    var r = ensureDocOpen(pkg, a.name);
    return ok({ opened: a.name, url: r.url });
};

COMMANDS.close_doc = function (a) {
    var pkg = getPkg(a.pkg);
    var item = requireComponentItem(pkg, a.name);
    var doc = App.docView.FindDocument(itemUrl(pkg, item));
    if (doc != null && doc.isModified) throw bridgeError("UNSAVED_DOCUMENT", "Save document before closing");
    if (doc != null) App.docView.CloseDocument(doc);
    return ok({ closed: a.name });
};

COMMANDS.list_children = function (a) {
    var pkg = getPkg(a.pkg);
    var r = ensureDocOpen(pkg, a.name);
    var content = r.doc.content;
    var arr = [];
    var ch = content.children;
    if (ch.Count > 1024) throw bridgeError("RESULT_LIMIT", "Child list limit reached");
    for (var i = 0; i < ch.Count; i++) {
        var c = ch.get_Item(i);
        var o = { name: c.name };
        try { o.id = c.id; } catch (e) { }
        try { o.objType = c.objType; } catch (e) { }
        arr.push(o);
    }
    return ok({ component: a.name, children: arr });
};

// insert a library item (component/image/etc, referenced by url or pkg+name)
// into a component's stage
COMMANDS.insert_object = function (a) {
    var pkg = getPkg(a.pkg);
    var r = ensureDocOpen(pkg, a.name);
    var url = a.url || null;
    if (url) validateItemUrl(url);
    if (!url) {
        var refPkg = getPkg(a.ref_pkg || a.pkg);
        var refItem = requireComponentItem(refPkg, a.ref_name);
        url = itemUrl(refPkg, refItem);
    }
    var pos = null;
    if (a.x !== undefined && a.y !== undefined) {
        pos = new CS.UnityEngine.Vector2(a.x + 0.0, a.y + 0.0);
    }
    var obj;
    if (a.index === undefined) {
        obj = pos != null ? r.doc.InsertObject(url, pos) : r.doc.InsertObject(url);
    } else {
        obj = r.doc.InsertObject(url, pos, a.index | 0);
    }
    if (obj == null) throw "InsertObject returned null for url " + url;
    if (a.props) applyProps(obj, a.props);
    App.docView.SaveDocument(r.doc);
    return ok({ inserted: obj.name, url: url });
};

COMMANDS.set_property = function (a) {
    var pkg = getPkg(a.pkg);
    var r = ensureDocOpen(pkg, a.name);
    var target = a.target ? findChild(r.doc.content, a.target) : r.doc.content;
    if (target == null) throw "target not found: " + a.target;
    var props = a.props || null;
    if (props == null && a.prop !== undefined) props = {};
    if (props == null) throw "no props given (args.props={...} or args.prop/args.value)";
    if (a.prop !== undefined && props[a.prop] === undefined) props[a.prop] = a.value;
    var applied = applyProps(target, props);
    App.docView.SaveDocument(r.doc);
    return ok({ target: a.target || "$root", applied: applied });
};

COMMANDS.remove_object = function (a) {
    var pkg = getPkg(a.pkg);
    var r = ensureDocOpen(pkg, a.name);
    var target = findChild(r.doc.content, a.target);
    if (target == null) throw "target not found: " + a.target;
    r.doc.RemoveObject(target);
    App.docView.SaveDocument(r.doc);
    return ok({ removed: a.target });
};

COMMANDS.save_all = function (a) {
    App.docView.SaveAllDocuments();
    return ok({ saved: true });
};

COMMANDS.refresh = function (a) {
    if(App.docView.HasUnsavedDocuments())throw bridgeError("UNSAVED_DOCUMENTS","Save or discard documents before refresh");
    App.RefreshProject();
    return ok({ refreshed: true });
};

COMMANDS.screenshot = function(a) {
    var destination=a.path || Config.screenshotDir+"/capture.png";
    requireWithin(destination,Config.screenshotDir);
    if(!/\.png$/i.test(destination))throw bridgeError("PATH_NOT_ALLOWED","Screenshot must be PNG");
    if(CS.System.IO.File.Exists(destination))throw bridgeError("OUTPUT_EXISTS","Use a new screenshot path; existing images are preserved");
    var display=App.groot && App.groot.displayObject,texture=null,image=null;
    if(!display || typeof display.GetScreenShot!=="function")throw bridgeError("CAPTURE_UNSUPPORTED","Editor root display screenshot API is unavailable");
    try {
        var w=Math.ceil(Number(App.groot.width)),h=Math.ceil(Number(App.groot.height));
        if(w<=0||h<=0||w>4096||h>4096)throw bridgeError("CAPTURE_SIZE","Editor root must be at most4096x4096");
        texture=display.GetScreenShot(null,1);
        w=Number(texture.width);h=Number(texture.height);var format=Number(texture.format),bands=format===4?4:format===3?3:0;
        if(!bands||w<=0||h<=0||w>4096||h>4096)throw bridgeError("CAPTURE_FORMAT","Expected bounded RGB24 or RGBA32 texture");
        var raw=texture.GetRawTextureData(),stride=w*bands;
        if(Number(raw.Length)!==stride*h)throw bridgeError("CAPTURE_FORMAT","Unexpected raw pixel length");
        // Unity pixel rows start at bottom-left; VImage rows start at top-left.
        var flipped=CS.System.Array.CreateInstance(require("puerts").$typeof(CS.System.Byte),stride*h);
        for(var y=0;y<h;y++)CS.System.Array.Copy(raw,(h-y-1)*stride,flipped,y*stride,stride);
        image=FairyEditor.VImage.New(flipped,w,h,bands===4);
        CS.System.IO.Directory.CreateDirectory(Config.screenshotDir);
        image.Save(destination);
        return ok({screenshot:destination,width:w,height:h,method:"editor-root-display",scope:"Editor UI content only, not desktop/window chrome",async:false,verified:false});
    }finally{
        if(image)try{image.Dispose();}catch(error){plog("CAPTURE_DISPOSE_FAILED",error);}
        if(texture)try{CS.UnityEngine.Object.Destroy(texture);}catch(error){plog("CAPTURE_TEXTURE_RELEASE_FAILED",error);}
    }
};

// internal for tests: expose bridge log tail
COMMANDS.bridge_log = function (a) {
    var n = a && a.tail ? a.tail : 40;
    return ok(Bridge.logLines.slice(-n));
};

function findChild(content, target) {
    // supports plain name or "a/b/c" path
    if (target.indexOf("/") >= 0) return content.GetChildByPath(target);
    return content.GetChild(target);
}

function setOneProp(obj, k, v) {
    // Editor6.1.4 extension setter can silently accept unknown vector keys.
    // Resolve vectors first; otherwise that false success prevents scalar adaptation.
    if (["xy","size","pivot","scale","anchor"].indexOf(k)>=0) {
        var pair=parseVector(k,v),fields=k==="xy"?["x","y"]:k==="size"?["width","height"]:[k+"X",k+"Y"];
        obj.docElement.SetProperty(fields[0],pair[0]);
        obj.docElement.SetProperty(fields[1],pair[1]);
        for(var i=0;i<2;i++) {
            var actual=Number(obj[fields[i]]),epsilon=Math.max(0.0001,Math.abs(pair[i])*0.0000001);
            if(!Number.isFinite(actual) || Math.abs(actual-pair[i])>epsilon)throw bridgeError("PROPERTY_READBACK_MISMATCH","Native scalar vector readback mismatch; partial changes may remain");
        }
        return fields[0]+"/"+fields[1];
    }
    try { obj.docElement.SetProperty(k,v);return "set"; }
    catch(e1) { obj.docElement.SetExtensionProperty(k,v);return "ext"; }
}

function applyProps(obj, props) {
    validateProps(props);
    var applied = [];
    for (var k in props) {
        applied.push(k + ":" + setOneProp(obj, k, propValueIn(props[k])));
    }
    return applied;
}

// Native queue is the cross-process authority. A Node-process mutex is not enough.
var WRITE_COMMANDS=["transition_sample","transition_create","transition_update","transition_remove","transition_keyframe_set","transition_keyframe_remove","relation_set","relation_remove","controller_create","controller_update","controller_select","controller_remove","create_component","delete_item","insert_object","set_property","remove_object","save_all","refresh","publish","close_doc"];
var Coordination={revision:0,cursors:Object.create(null),serial:0};
function mutates(cmd){return WRITE_COMMANDS.indexOf(cmd)>=0;}
function claimWrite(job){
    if(!mutates(job.cmd)||job.writeClaimed)return;
    if(job.expectedRevision!==Coordination.revision)throw bridgeError("REVISION_CONFLICT","Project changed after this client observed it; inspect fresh state before editing again");
    // Conservative: even a partially failed operation invalidates old readers.
    Coordination.cursors=Object.create(null);job.writeClaimed=true;
}
function pruneCursors(){
    Object.keys(Coordination.cursors).forEach(function(k){if(Coordination.cursors[k].expires<=Date.now())delete Coordination.cursors[k];});
}
function itemFrame(item,depth,parentId){
    var children=item.children;
    return {item:item,id:String(item.id),depth:depth,parentId:parentId,emitted:false,index:0,count:children?Number(children.Count):0};
}
function pageRow(frame){
    var i=frame.item;
    return {id:String(i.id),name:String(i.name),type:typeof i.type==="number"?i.type:String(i.type),path:String(i.path||""),parentId:frame.parentId,depth:frame.depth,childCount:frame.count,width:Number(i.width),height:Number(i.height)};
}
COMMANDS.list_items_page=function(a){
    pruneCursors();var state,pkg=getPkg(a.pkg),cursor=a.cursor,limit=a.limit||50;
    if(cursor){
        state=Coordination.cursors[cursor];
        if(!state)throw bridgeError("CURSOR_EXPIRED","Cursor expired, was consumed, or was invalidated by an edit; restart pagination");
        if(state.pkgId!==String(pkg.id))throw bridgeError("CURSOR_SCOPE","Cursor belongs to a different package");
        delete Coordination.cursors[cursor];
    }else{
        if(Object.keys(Coordination.cursors).length>=16)throw bridgeError("CURSOR_CAPACITY","At most16 active traversals; finish or wait for expiry");
        state={pkgId:String(pkg.id),revision:Coordination.revision,stack:[itemFrame(pkg.rootItem,0,null)],offset:0};
    }
    var rows=[],bytes=0,steps=0;
    while(state.stack.length && rows.length<limit && steps++<512){
        var f=state.stack[state.stack.length-1],ch=f.item.children;
        if(String(f.item.id)!==f.id || (ch?Number(ch.Count):0)!==f.count)throw bridgeError("CURSOR_CHANGED","Resource tree changed during traversal; restart pagination");
        if(!f.emitted){
            var row=pageRow(f),size=utf8Length(JSON.stringify(row))+1;
            if(size>45000)throw bridgeError("ITEM_TOO_LARGE","A single resource exceeds the bounded page size");
            if(bytes+size>45000)break;
            rows.push(row);bytes+=size;f.emitted=true;continue;
        }
        if(f.index>=f.count){state.stack.pop();continue;}
        if(state.stack.length>=64)throw bridgeError("TREE_DEPTH_LIMIT","Resource tree depth exceeds64");
        state.stack.push(itemFrame(ch.get_Item(f.index++),f.depth+1,f.id));
    }
    var start=state.offset;state.offset+=rows.length;var next=null;
    if(state.stack.length){next=SESSION+"-page-"+(++Coordination.serial);state.expires=Date.now()+60000;Coordination.cursors[next]=state;}
    return ok({items:rows,offset:start,nextCursor:next,done:next===null,revision:state.revision,expiresInMs:next?60000:0,
        consistency:"Bridge writes invalidate cursors; observed ancestor identity/count changes are rejected. External GUI edits are not a transactional snapshot."});
};
// Native document facade owns serialization; history semantics are not guaranteed.
function controllerText(v) {
    return typeof v==="string" && v.length>0 && v.length<=128 && !/[,\u0000-\u001f\ufffe\uffff]/.test(v) && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v);
}
function validateControllerArgs(cmd,a) {
    if(cmd==="controller_list"){
        if(a.controller!==undefined&&!controllerText(a.controller))throw bridgeError("INVALID_ARGUMENTS","Invalid controller name");
        if(a.offset!==undefined&&(!Number.isInteger(a.offset)||a.offset<0||a.offset>100000))throw bridgeError("INVALID_ARGUMENTS","Invalid controller offset");
        return;
    }
    if(!controllerText(a.controller))throw bridgeError("INVALID_ARGUMENTS","Bounded controller name without commas required");
    if(a.newName!==undefined&&!controllerText(a.newName))throw bridgeError("INVALID_ARGUMENTS","Invalid new controller name");
    if(a.exported!==undefined&&typeof a.exported!=="boolean")throw bridgeError("INVALID_ARGUMENTS","exported must be boolean");
    if(cmd==="controller_create") {
        if(!Array.isArray(a.pages)||a.pages.length<1||a.pages.length>100||a.pages.some(function(x){return !controllerText(x);}))throw bridgeError("INVALID_ARGUMENTS","One to100 bounded page names required");
        if(new Set(a.pages).size!==a.pages.length)throw bridgeError("INVALID_ARGUMENTS","Duplicate page names");
    }
    if(cmd==="controller_select"&&(!Number.isInteger(a.index)||a.index<0||a.index>99))throw bridgeError("INVALID_ARGUMENTS","index0..99 required");
    if(cmd==="controller_update") {
        if(a.newName===undefined&&a.exported===undefined&&a.pageNames===undefined)throw bridgeError("INVALID_ARGUMENTS","At least one update required");
        if(a.pageNames!==undefined) {
            if(!Array.isArray(a.pageNames)||a.pageNames.length<1||a.pageNames.length>100)throw bridgeError("INVALID_ARGUMENTS","Bounded pageNames required");
            var seen=Object.create(null);
            a.pageNames.forEach(function(p){if(!object(p)||Object.keys(p).length!==2||typeof p.id!=="string"||!p.id.length||p.id.length>128||!controllerText(p.name)||seen[p.id])throw bridgeError("INVALID_ARGUMENTS","Unique page IDs and valid names required");seen[p.id]=true;});
        }
    }
}
function saveControllerDoc(doc) {
    App.docView.SaveDocument(doc);
    if(doc.isModified)throw bridgeError("SAVE_NOT_CONFIRMED","Editor still marks document modified after save; inspect unsaved changes, do not retry automatically");
}
function controllerInfo(c) {
    var pages=c.GetPages(),out=[];
    if(pages.Count>100)throw bridgeError("RESULT_LIMIT","Controller has more than100 pages");
    for(var i=0;i<pages.Count;i++){var p=pages.get_Item(i);out.push({id:String(p.id),name:String(p.name)});}
    return {name:String(c.name),exported:!!c.exported,selectedIndex:Number(c.selectedIndex),pages:out};
}
function controllerDoc(a,method) {
    var r=ensureDocOpen(getPkg(a.pkg),a.name);
    if(method&&typeof r.doc[method]!=="function")throw bridgeError("CAPABILITY_UNSUPPORTED","Native controller document method missing: "+method);
    if(method&&r.doc.isModified)throw bridgeError("UNSAVED_DOCUMENT","Save or discard document changes before controller editing");
    return r.doc;
}
function requireController(doc,name) {
    var c=doc.content.GetController(name);
    if(!c)throw bridgeError("CONTROLLER_NOT_FOUND","Controller not found: "+name);
    return c;
}
COMMANDS.controller_list=function(a) {
    var doc=controllerDoc(a),list=doc.content.controllers,out=[],offset=a.offset||0,limit=a.limit||10,bytes=0;
    if(a.controller)return ok({controllers:[controllerInfo(requireController(doc,a.controller))],nextOffset:null,total:1});
    for(var i=offset;i<list.Count&&out.length<limit;i++){
        var row=controllerInfo(list.get_Item(i)),size=utf8Length(JSON.stringify(row));
        if(bytes+size>45000){if(!out.length)throw bridgeError("RESULT_LIMIT","One controller exceeds response budget");break;}
        bytes+=size;out.push(row);
    }
    return ok({controllers:out,nextOffset:i<list.Count?i:null,total:Number(list.Count),consistency:"Offsets are not a snapshot; restart after revision or external changes"});
};
COMMANDS.controller_create=function(a) {
    var doc=controllerDoc(a,"AddController");
    if(doc.content.GetController(a.controller))throw bridgeError("CONTROLLER_EXISTS","Controller name exists");
    if(doc.content.controllers.Count>=100)throw bridgeError("RESULT_LIMIT","At most100 controllers supported");
    var draft=new FairyEditor.FController();draft.name=a.controller;
    if(a.exported!==undefined)draft.exported=a.exported;
    a.pages.forEach(function(name){draft.AddPage(name);});
    doc.AddController(draft.Write());
    var result=controllerInfo(requireController(doc,a.controller));
    if(result.pages.length!==a.pages.length||result.pages.some(function(p,i){return p.name!==a.pages[i];}))throw bridgeError("CONTROLLER_READBACK","Native created controller differs; inspect partial changes");
    saveControllerDoc(doc);return ok(result);
};
COMMANDS.controller_update=function(a) {
    var doc=controllerDoc(a,"UpdateController"),current=requireController(doc,a.controller),name=a.newName||a.controller;
    if(name!==a.controller&&doc.content.GetController(name))throw bridgeError("CONTROLLER_EXISTS","New name already exists");
    // Clone via native XML; never rebuild IDs or discard opaque actions.
    var draft=new FairyEditor.FController();draft.Read(current.Write());draft.name=name;
    if(a.exported!==undefined)draft.exported=a.exported;
    var pages=draft.GetPages(),byId=Object.create(null);
    for(var i=0;i<pages.Count;i++)byId[String(pages.get_Item(i).id)]=pages.get_Item(i);
    (a.pageNames||[]).forEach(function(p){if(!byId[p.id])throw bridgeError("PAGE_NOT_FOUND","Unknown page ID: "+p.id);byId[p.id].name=p.name;});
    var expected=controllerInfo(draft),names=expected.pages.map(function(p){return p.name;});
    if(new Set(names).size!==names.length)throw bridgeError("INVALID_ARGUMENTS","Resulting page names must be unique");
    doc.UpdateController(a.controller,draft.Write());
    var result=controllerInfo(requireController(doc,name));
    if(JSON.stringify(result.pages)!==JSON.stringify(expected.pages)||result.exported!==expected.exported)throw bridgeError("CONTROLLER_READBACK","Native controller update differs; inspect partial changes");
    saveControllerDoc(doc);
    result.history={nativeUndoVerified:false,renameUndoRisk:name!==a.controller};
    return ok(result);
};
COMMANDS.controller_select=function(a) {
    var doc=controllerDoc(a,"SwitchPage"),c=requireController(doc,a.controller);
    controllerInfo(c); // Validate bounded state before page switching can run actions.
    if(a.index>=c.pageCount)throw bridgeError("PAGE_NOT_FOUND","Page index out of range");
    var before=Number(c.selectedIndex);doc.SwitchPage(a.controller,a.index);
    var result=controllerInfo(c);
    if(result.selectedIndex!==a.index)throw bridgeError("CONTROLLER_READBACK","Native page selection differs");
    saveControllerDoc(doc);result.previousIndex=before;return ok(result);
};
COMMANDS.controller_remove=function(a) {
    var doc=controllerDoc(a,"RemoveController");requireController(doc,a.controller);
    doc.RemoveController(a.controller);
    if(doc.content.GetController(a.controller))throw bridgeError("CONTROLLER_READBACK","Controller remains after removal");
    saveControllerDoc(doc);return ok({removed:a.controller});
};
// Editor relation enums differ from runtime FairyGUI.RelationType ordinals.
var RELATION_TYPES=["Left_Left","Left_Center","Left_Right","Center_Center","Right_Left","Right_Center","Right_Right","LeftExt_Left","LeftExt_Right","RightExt_Left","RightExt_Right","Width","Top_Top","Top_Middle","Top_Bottom","Middle_Middle","Bottom_Top","Bottom_Middle","Bottom_Bottom","TopExt_Top","TopExt_Bottom","BottomExt_Top","BottomExt_Bottom","Height","Size"];
function validateRelationArgs(cmd,a) {
    ["objectId"].concat(cmd==="relation_list"?[]:["targetId"]).forEach(function(k){if(typeof a[k]!=="string"||!a[k].length||a[k].length>128||/[\u0000-\u001f]/.test(a[k]))throw bridgeError("INVALID_ARGUMENTS","Bounded object and target IDs required");});
    if(a.offset!==undefined&&(!Number.isInteger(a.offset)||a.offset<0||a.offset>100000))throw bridgeError("INVALID_ARGUMENTS","Invalid relation offset");
    if(cmd!=="relation_set")return;
    if(!Array.isArray(a.definitions)||a.definitions.length<1||a.definitions.length>25)throw bridgeError("INVALID_ARGUMENTS","One to25 definitions required");
    var seen=Object.create(null);
    a.definitions.forEach(function(d){
        if(!object(d)||Object.keys(d).some(function(k){return k!=="type"&&k!=="percent";})||RELATION_TYPES.indexOf(d.type)<0||d.percent!==undefined&&typeof d.percent!=="boolean")throw bridgeError("INVALID_ARGUMENTS","Known relation type and boolean percent required");
        (d.type==="Size"?["Width","Height"]:[d.type]).forEach(function(k){if(seen[k])throw bridgeError("INVALID_ARGUMENTS","Duplicate relation definitions including Size expansion");seen[k]=true;});
    });
}
function nativeRelationType(name) {
    var n=FairyEditor.FRelationType[name];
    if(typeof n!=="number"||!Number.isInteger(n))throw bridgeError("CAPABILITY_UNSUPPORTED","Editor relation type missing: "+name);
    return n;
}
function relationTypeName(n) {
    for(var i=0;i<RELATION_TYPES.length;i++)if(nativeRelationType(RELATION_TYPES[i])===n)return RELATION_TYPES[i];
    throw bridgeError("CAPABILITY_UNSUPPORTED","Unknown native relation type");
}
function relationOwner(a,write) {
    var doc=ensureDocOpen(getPkg(a.pkg),a.name).doc,owner=doc.content.GetChildById(a.objectId);
    if(!owner)throw bridgeError("OBJECT_NOT_FOUND","Direct child ID not found");
    if(write&&doc.isModified)throw bridgeError("UNSAVED_DOCUMENT","Save or discard document before editing relations");
    if(write&&(!owner.docElement||owner.docElement.isValid!==true))throw bridgeError("DOCUMENT_ELEMENT_INVALID","Object has no valid editable document element");
    if(write&&owner.docElement.relationsDisabled)throw bridgeError("RELATIONS_DISABLED","Object relations are disabled");
    return {doc:doc,owner:owner};
}
function relationTarget(doc,owner,id) {
    var target=id==="$parent"?owner.parent:doc.content.GetChildById(id);
    if(!target)throw bridgeError("OBJECT_NOT_FOUND","Parent or direct sibling ID not found");
    if(target===owner||id===String(owner.id))throw bridgeError("RELATION_SELF","Self relation rejected");
    return target;
}
function relationGeometry(obj) {return {id:String(obj.id),x:Number(obj.x),y:Number(obj.y),width:Number(obj.width),height:Number(obj.height)};}
function relationRow(item,owner) {
    var defs=item.defs,out=[];
    if(defs.Count>25)throw bridgeError("RESULT_LIMIT","Too many relation definitions");
    for(var i=0;i<defs.Count;i++){var d=defs.get_Item(i);out.push({type:relationTypeName(Number(d.type)),percent:!!d.percent});}
    return {targetId:item.target===owner.parent?"$parent":String(item.target.id),desc:String(item.desc),readOnly:!!item.readOnly,definitions:out};
}
function rejectRelationCycle(owner,target) {
    // Same-document bounded reachability; do not add feedback loops to layout.
    var stack=[target],seen=[],edges=0;
    while(stack.length){var obj=stack.pop();if(obj===owner)throw bridgeError("RELATION_CYCLE","Relation would create a dependency cycle");if(seen.indexOf(obj)>=0)continue;seen.push(obj);if(seen.length>256)throw bridgeError("RELATION_GRAPH_LIMIT","Relation graph exceeds inspection bound");var items=obj.relations.items;for(var i=0;i<items.Count;i++){if(++edges>1024)throw bridgeError("RELATION_GRAPH_LIMIT","Relation edge bound exceeded");var next=items.get_Item(i).target;if(next)stack.push(next);}}
}
COMMANDS.relation_list=function(a) {
    var r=relationOwner(a,false),items=r.owner.relations.items,offset=a.offset||0,limit=a.limit||20,out=[],bytes=0;
    for(var i=offset;i<items.Count&&out.length<limit;i++){var row=relationRow(items.get_Item(i),r.owner),size=utf8Length(JSON.stringify(row));if(bytes+size>45000)break;bytes+=size;out.push(row);}
    return ok({owner:relationGeometry(r.owner),relations:out,nextOffset:i<items.Count?i:null,total:Number(items.Count),consistency:"Offsets are not a snapshot; restart after revision/external edits"});
};
COMMANDS.relation_set=function(a) {
    var r=relationOwner(a,true),target=relationTarget(r.doc,r.owner,a.targetId),old=r.owner.relations.GetItem(target);
    if(old&&old.readOnly)throw bridgeError("RELATION_READ_ONLY","Inherited/read-only relation cannot be replaced");
    if(typeof r.owner.docElement.SetRelation!=="function")throw bridgeError("CAPABILITY_UNSUPPORTED","Native SetRelation missing");
    rejectRelationCycle(r.owner,target);
    var draft=new FairyEditor.FRelationItem(r.owner),desc;
    try{a.definitions.forEach(function(d){draft.AddDef(nativeRelationType(d.type),d.percent||false,true);});desc=String(draft.desc);}finally{draft.Dispose();}
    r.owner.docElement.SetRelation(target,desc);
    var current=r.owner.relations.GetItem(target);
    if(!current||String(current.desc)!==desc)throw bridgeError("RELATION_READBACK","Native relation differs; inspect partial changes");
    var row=relationRow(current,r.owner);saveControllerDoc(r.doc);
    return ok({relation:row,owner:relationGeometry(r.owner),history:{nativeUndoVerified:false},replacedTargetOnly:true});
};
COMMANDS.relation_remove=function(a) {
    var r=relationOwner(a,true),target=relationTarget(r.doc,r.owner,a.targetId),old=r.owner.relations.GetItem(target);
    if(!old)throw bridgeError("RELATION_NOT_FOUND","Relation target not present");
    if(old.readOnly)throw bridgeError("RELATION_READ_ONLY","Inherited/read-only relation cannot be removed");
    if(typeof r.owner.docElement.RemoveRelation!=="function")throw bridgeError("CAPABILITY_UNSUPPORTED","Native RemoveRelation missing");
    r.owner.docElement.RemoveRelation(target);
    if(r.owner.relations.GetItem(target))throw bridgeError("RELATION_READBACK","Relation remains after removal");
    saveControllerDoc(r.doc);return ok({removedTarget:a.targetId,owner:relationGeometry(r.owner),history:{nativeUndoVerified:false}});
};
// Native transition serialization, never caller-supplied XML or executable actions.
var TRANSITION_VALUE_TYPES=["XY","Size","Scale","Skew","Alpha","Rotation"];
function validateTransitionArgs(cmd,a) {
    if((cmd!=="transition_list"||a.transition!==undefined)&&!controllerText(a.transition))throw bridgeError("INVALID_ARGUMENTS","Bounded transition name required");
    if(a.offset!==undefined&&(!Number.isInteger(a.offset)||a.offset<0||a.offset>100000))throw bridgeError("INVALID_ARGUMENTS","Invalid transition offset");
    if(cmd==="transition_sample") {
        if(!Number.isInteger(a.frame)||a.frame<0||a.frame>36000||!Array.isArray(a.targetIds)||a.targetIds.length<1||a.targetIds.length>20||a.targetIds.some(function(id){return !controllerText(id);})||new Set(a.targetIds).size!==a.targetIds.length)throw bridgeError("INVALID_ARGUMENTS","Sample needs frame0..36000 and1..20 unique direct-child IDs");
    }
    if(cmd==="transition_update") {
        if(!object(a.settings)||!Object.keys(a.settings).length)throw bridgeError("INVALID_ARGUMENTS","Nonempty transition settings required");
        Object.keys(a.settings).forEach(function(k){var v=a.settings[k];
            if(k==="autoPlay"){if(typeof v!=="boolean")throw bridgeError("INVALID_ARGUMENTS","autoPlay must be boolean");}
            else if(k==="frameRate"){if(!Number.isInteger(v)||v<1||v>120)throw bridgeError("INVALID_ARGUMENTS","frameRate1..120 required");}
            else if(k==="autoPlayRepeat"){if(!Number.isInteger(v)||v<1||v>100)throw bridgeError("INVALID_ARGUMENTS","Finite repeat1..100 required");}
            else if(k==="autoPlayDelay"){if(typeof v!=="number"||!Number.isFinite(v)||v<0||v>60)throw bridgeError("INVALID_ARGUMENTS","Delay0..60 required");}
            else throw bridgeError("INVALID_ARGUMENTS","Unknown transition setting");
        });
    }
    if(cmd!=="transition_keyframe_set"&&cmd!=="transition_keyframe_remove")return;
    if(!controllerText(a.targetId)||TRANSITION_VALUE_TYPES.indexOf(a.type)<0||!Number.isInteger(a.frame)||a.frame<0||a.frame>36000)throw bridgeError("INVALID_ARGUMENTS","Direct target ID, supported value type, frame0..36000 required");
    if(cmd==="transition_keyframe_remove")return;
    var count=["Alpha","Rotation"].indexOf(a.type)>=0?1:2;
    if(!Array.isArray(a.values)||a.values.length!==count||a.values.some(function(v){return typeof v!=="number"||!Number.isFinite(v)||Math.abs(v)>1000000;}))throw bridgeError("INVALID_ARGUMENTS","Typed finite numeric values required");
    if(a.type==="Alpha"&&(a.values[0]<0||a.values[0]>1)||a.type==="Size"&&a.values.some(function(v){return v<0||v>100000;}))throw bridgeError("INVALID_ARGUMENTS","Value outside property range");
    if(a.tween!==undefined&&typeof a.tween!=="boolean")throw bridgeError("INVALID_ARGUMENTS","tween must be boolean");
    if(a.label!==undefined&&(typeof a.label!=="string"||a.label!==""&&!controllerText(a.label)))throw bridgeError("INVALID_ARGUMENTS","Invalid keyframe label");
}
function transitionDoc(a,write) {
    var doc=ensureDocOpen(getPkg(a.pkg),a.name).doc;
    if(!doc.content.transitions)throw bridgeError("CAPABILITY_UNSUPPORTED","Native transitions unavailable");
    if(write&&doc.isModified)throw bridgeError("UNSAVED_DOCUMENT","Save or discard document before transition editing");
    if(write&&doc.timelineMode)throw bridgeError("TIMELINE_ACTIVE","Exit the timeline before transition editing");
    return doc;
}
function requireTransition(doc,name) {
    var t=doc.content.transitions.GetItem(name);
    if(!t)throw bridgeError("TRANSITION_NOT_FOUND","Transition not found: "+name);
    if(t.playing)throw bridgeError("TRANSITION_PLAYING","Stop transition playback before inspecting or editing it");
    return t;
}
function transitionInfo(t) {
    return {name:String(t.name),frameRate:Number(t.frameRate),autoPlay:!!t.autoPlay,autoPlayRepeat:Number(t.autoPlayRepeat),autoPlayDelay:Number(t.autoPlayDelay),options:Number(t.options),maxFrame:Number(t.maxFrame),keyframeCount:Number(t.items.Count)};
}
function transitionItemInfo(item) {
    return {targetId:String(item.targetId),type:String(item.type),frame:Number(item.frame),value:String(item.encodedValue),tween:!!item.tween,easeType:String(item.easeType||""),easeInOutType:String(item.easeInOutType||""),repeat:Number(item.repeat),yoyo:!!item.yoyo,label:String(item.label||""),usePath:!!item.usePath};
}
function inspectEditableTransition(t,doc) {
    if(t.items.Count>1000)throw bridgeError("RESULT_LIMIT","At most1000 keyframes supported for editing/preview");
    if(!Number.isInteger(Number(t.frameRate))||t.frameRate<1||t.frameRate>120)throw bridgeError("TRANSITION_VALUE_UNSUPPORTED","Existing frameRate outside supported range");
    var rows=[];
    for(var i=0;i<t.items.Count;i++) {
        var item=t.items.get_Item(i);
        if(TRANSITION_VALUE_TYPES.indexOf(String(item.type))<0||item.usePath||item.customEaseData)throw bridgeError("TRANSITION_COMPLEX_UNSUPPORTED","This transition contains actions, paths or custom easing; use a specialized editor to preserve their semantics");
        var target=String(item.targetId||"")===""?doc.content:doc.content.GetChildById(String(item.targetId));
        if(!target||!FairyEditor.FTransition.GetAllowType(target,String(item.type)))throw bridgeError("TRANSITION_TARGET_INVALID","Existing transition target is missing or incompatible; repair it before editing");
        var values=String(item.encodedValue).split(","),count=["Alpha","Rotation"].indexOf(String(item.type))>=0?1:2;
        if(values.length!==count||values.some(function(v){return !v.length||!Number.isFinite(Number(v))||Math.abs(Number(v))>1000000;})||!Number.isInteger(Number(item.frame))||item.frame<0||item.frame>36000)throw bridgeError("TRANSITION_VALUE_UNSUPPORTED","Existing keyframe uses partial/percent/nonfinite or unbounded values");
        rows.push(transitionItemInfo(item));
    }
    validateTransitionTopology(t);return rows;
}
function validateTransitionTopology(t) {
    var tuples=Object.create(null),ends=Object.create(null);
    for(var i=0;i<t.items.Count;i++) {
        var key=t.items.get_Item(i),track=JSON.stringify([String(key.targetId),String(key.type)]),tuple=track+":"+key.frame;
        if(tuples[tuple])throw bridgeError("KEYFRAME_DUPLICATE","Duplicate target/type/frame tuple");
        tuples[tuple]=true;ends[track]=Math.max(ends[track]===undefined?-1:ends[track],Number(key.frame));
    }
    for(var j=0;j<t.items.Count;j++) {
        var item=t.items.get_Item(j);
        if(item.tween&&ends[JSON.stringify([String(item.targetId),String(item.type)])]<=Number(item.frame))throw bridgeError("TWEEN_ENDPOINT_REQUIRED","Each tween needs a later keyframe on the same target/type; create the endpoint first");
    }
}
function transitionPage(items,offset,limit,serialize) {
    var rows=[],bytes=0,i=offset;
    for(;i<items.Count&&rows.length<limit;i++){
        var row=serialize(items.get_Item(i)),size=utf8Length(JSON.stringify(row));
        if(size>45000)throw bridgeError("RESULT_LIMIT","One transition record exceeds the page budget");
        if(bytes+size>45000)break;
        bytes+=size;rows.push(row);
    }
    return {items:rows,nextOffset:i<items.Count?i:null,total:Number(items.Count),consistency:"Offsets are not snapshots; restart after revision or external changes"};
}
COMMANDS.transition_list=function(a) {
    var doc=transitionDoc(a,false),offset=a.offset||0,limit=a.limit||20;
    if(!a.transition)return ok(transitionPage(doc.content.transitions.items,offset,limit,transitionInfo));
    var t=requireTransition(doc,a.transition),out=transitionPage(t.items,offset,limit,transitionItemInfo);out.transition=transitionInfo(t);return ok(out);
};
COMMANDS.transition_create=function(a) {
    var doc=transitionDoc(a,true);
    if(typeof doc.AddTransition!=="function"||typeof doc.SetTransitionProperty!=="function")throw bridgeError("CAPABILITY_UNSUPPORTED","Native AddTransition/SetTransitionProperty unavailable");
    if(doc.content.transitions.GetItem(a.transition))throw bridgeError("TRANSITION_EXISTS","Transition name exists");
    if(doc.content.transitions.items.Count>=100)throw bridgeError("RESULT_LIMIT","At most100 transitions supported");
    // Native AddItem only initializes a name for its null/default argument.
    // Passing an explicit name creates an unnamed transition on 6.1.4/6.0.5.
    try{var created=doc.AddTransition();doc.SetTransitionProperty(created,"name",a.transition);}finally{if(doc.timelineMode)doc.ExitTimelineMode();}
    var t=requireTransition(doc,a.transition);saveControllerDoc(doc);
    return ok({transition:transitionInfo(t),history:{nativeUndoVerified:false}});
};
function editTransition(a,edit) {
    var doc=transitionDoc(a,true),current=requireTransition(doc,a.transition);
    ["EnterTimelineMode","ExitTimelineMode","UpdateTransition"].forEach(function(k){if(typeof doc[k]!=="function")throw bridgeError("CAPABILITY_UNSUPPORTED","Native "+k+" unavailable");});
    var originalItems=inspectEditableTransition(current,doc);
    var draft=new FairyEditor.FTransition(doc.content);
    try {
        draft.Read(current.Write(false));var clonedItems=[];
        for(var ci=0;ci<draft.items.Count;ci++)clonedItems.push(transitionItemInfo(draft.items.get_Item(ci)));
        if(JSON.stringify(clonedItems)!==JSON.stringify(originalItems)||JSON.stringify(transitionInfo(draft))!==JSON.stringify(transitionInfo(current)))throw bridgeError("TRANSITION_CLONE_LOSS","Native serialization changes existing transition semantics; no document update performed");
        edit(draft,doc);
        validateTransitionTopology(draft);
        var xml=draft.Write(false),expected=transitionInfo(draft),expectedItems=[];
        for(var i=0;i<draft.items.Count;i++)expectedItems.push(transitionItemInfo(draft.items.get_Item(i)));
        try {
            doc.EnterTimelineMode(a.transition);
            if(!doc.timelineMode||!doc.editingTransition||String(doc.editingTransition.name)!==a.transition)throw bridgeError("TIMELINE_CONTEXT","Native timeline did not select the requested transition");
            doc.UpdateTransition(xml);
        }finally{if(doc.timelineMode)doc.ExitTimelineMode();}
        current=requireTransition(doc,a.transition);var actualItems=[];
        for(var j=0;j<current.items.Count;j++)actualItems.push(transitionItemInfo(current.items.get_Item(j)));
        if(JSON.stringify(transitionInfo(current))!==JSON.stringify(expected)||JSON.stringify(actualItems)!==JSON.stringify(expectedItems))throw bridgeError("TRANSITION_READBACK","Native transition differs; inspect partial changes before retrying");
        saveControllerDoc(doc);return ok({transition:transitionInfo(current),history:{nativeUndoVerified:false},timelineExited:true});
    }finally{draft.Dispose();}
}
COMMANDS.transition_update=function(a) {
    return editTransition(a,function(draft){Object.keys(a.settings).forEach(function(k){draft[k]=a.settings[k];});});
};
COMMANDS.transition_keyframe_set=function(a) {
    return editTransition(a,function(draft,doc){
        var target=doc.content.GetChildById(a.targetId);
        if(!target)throw bridgeError("OBJECT_NOT_FOUND","Direct child ID not found");
        if(!FairyEditor.FTransition.GetAllowType(target,a.type))throw bridgeError("TRANSITION_TYPE_UNSUPPORTED","Native target rejects the transition type");
        var item=draft.FindItem(a.frame,a.targetId,a.type);
        if(!item){if(draft.items.Count>=1000)throw bridgeError("RESULT_LIMIT","At most1000 keyframes supported");item=draft.CreateItem(a.targetId,a.type,a.frame);}
        if(item.usePath)throw bridgeError("TRANSITION_PATH_UNSUPPORTED","Path keyframes need a path-aware editor");
        item.encodedValue=a.values.join(",");
        var values=String(item.encodedValue).split(",");
        for(var i=0;i<a.values.length;i++)if(!Number.isFinite(Number(values[i]))||Math.abs(Number(values[i])-a.values[i])>Math.max(0.0001,Math.abs(a.values[i])*0.000001))throw bridgeError("TRANSITION_VALUE_READBACK","Native value decoder differs from requested numeric values");
        if(a.tween!==undefined)item.tween=a.tween;
        if(a.label!==undefined)item.label=a.label;
    });
};
COMMANDS.transition_keyframe_remove=function(a) {
    return editTransition(a,function(draft){var item=draft.FindItem(a.frame,a.targetId,a.type);if(!item)throw bridgeError("KEYFRAME_NOT_FOUND","Keyframe tuple not found");draft.DeleteItem(item);});
};
function transitionGeometry(obj) {
    var out={id:String(obj.id)};
    ["x","y","width","height","scaleX","scaleY","skewX","skewY","rotation","alpha"].forEach(function(k){var v=Number(obj[k]);if(!Number.isFinite(v))throw bridgeError("TRANSITION_GEOMETRY","Nonfinite native geometry");out[k]=v;});return out;
}
function transitionDesignState(doc) {
    var children=doc.content.children;
    if(children.Count>2000)throw bridgeError("RESULT_LIMIT","Preview snapshot supports at most2000 direct children");
    var rows=[],objects=[doc.content],controllers=[];
    for(var i=0;i<children.Count;i++)objects.push(children.get_Item(i));
    objects.forEach(function(o){var row=transitionGeometry(o);if(typeof o._gearLocked!=="boolean"||typeof o.visible!=="boolean"||!Number.isFinite(Number(o.pivotX))||!Number.isFinite(Number(o.pivotY)))throw bridgeError("CAPABILITY_UNSUPPORTED","Native gear-lock/pivot/visibility state unavailable");row.gearLocked=o._gearLocked;row.visible=o.visible;row.pivotX=Number(o.pivotX);row.pivotY=Number(o.pivotY);rows.push(row);});
    if(doc.content.controllers.Count>1000)throw bridgeError("RESULT_LIMIT","Preview supports at most1000 controllers");
    for(var j=0;j<doc.content.controllers.Count;j++){var c=doc.content.controllers.get_Item(j);controllers.push({name:String(c.name),selectedIndex:Number(c.selectedIndex)});}
    return {objects:rows,controllers:controllers};
}
COMMANDS.transition_sample=function(a) {
    var doc=transitionDoc(a,true),t=requireTransition(doc,a.transition);inspectEditableTransition(t,doc);
    ["EnterTimelineMode","ExitTimelineMode"].forEach(function(k){if(typeof doc[k]!=="function")throw bridgeError("CAPABILITY_UNSUPPORTED","Native timeline unavailable");});
    if(typeof t.Play!=="function"||typeof t.Stop!=="function")throw bridgeError("CAPABILITY_UNSUPPORTED","Native transition preview unavailable");
    if(a.frame>t.maxFrame)throw bridgeError("INVALID_ARGUMENTS","Sample frame exceeds transition maxFrame");
    var targets=a.targetIds.map(function(id){var obj=doc.content.GetChildById(id);if(!obj)throw bridgeError("OBJECT_NOT_FOUND","Direct child ID not found");return obj;}),before=transitionDesignState(doc),sample,primaryError=null,cleanupError=null;
    try {
        doc.EnterTimelineMode(a.transition);
        if(!doc.timelineMode||!doc.editingTransition||String(doc.editingTransition.name)!==a.transition)throw bridgeError("TIMELINE_CONTEXT","Native timeline selected a different transition");
        // head/RefreshTransition only set a deferred flag. Native zero-duration
        // edit-mode playback seeks synchronously; finally kills retained tweeners.
        t.Play(null,1,0,a.frame,a.frame,true);
        sample=targets.map(transitionGeometry);
    }catch(e){primaryError=e;}
    // Even a failed Play/Stop/Exit must reach the remaining cleanup and checks.
    try{t.Stop(false,false);}catch(stopError){cleanupError=stopError;}
    try{if(doc.timelineMode)doc.ExitTimelineMode();}catch(exitError){cleanupError=exitError;}
    var after=null,tweenersRemain=false;
    try{after=transitionDesignState(doc);for(var i=0;i<t.items.Count;i++)if(t.items.get_Item(i).tweener)tweenersRemain=true;}catch(readError){cleanupError=readError;}
    if(cleanupError||JSON.stringify(before)!==JSON.stringify(after)||doc.isModified||doc.timelineMode||t.playing||tweenersRemain)throw bridgeError("TRANSITION_RESTORE_FAILED","Checked design fields or playback cleanup are unconfirmed after preview; inspect document before further edits");
    if(primaryError)throw primaryError;
    return ok({transition:a.transition,frame:a.frame,samples:sample,restoredSamples:targets.map(transitionGeometry),checkedStateRestored:true,checkedFields:["direct-child/root geometry, scale, skew, rotation, alpha, pivot, visibility, gear lock","root controller selected indices","document clean, timeline exited, playback and tweeners stopped"],saved:false});
};
COMMANDS.transition_remove=function(a) {
    var doc=transitionDoc(a,true);requireTransition(doc,a.transition);
    if(typeof doc.RemoveTransition!=="function")throw bridgeError("CAPABILITY_UNSUPPORTED","Native RemoveTransition unavailable");
    doc.RemoveTransition(a.transition);
    if(doc.content.transitions.GetItem(a.transition))throw bridgeError("TRANSITION_READBACK","Transition remains after removal");
    saveControllerDoc(doc);return ok({removed:a.transition,history:{nativeUndoVerified:false}});
};
// Bounded pure-JS SHA256/HMAC: no IL2CPP crypto/process-query bindings.
function proofBytes(text){
    var out=[];
    for(var i=0;i<text.length;i++){
        var c=text.charCodeAt(i);
        if(c>=0xd800&&c<=0xdbff){
            var d=text.charCodeAt(++i);if(!(d>=0xdc00&&d<=0xdfff))throw bridgeError("PUBLISH_OWNER_PROOF_INVALID","Invalid UTF8 scalar");
            c=0x10000+((c-0xd800)<<10)+(d-0xdc00);
        }else if(c>=0xdc00&&c<=0xdfff)throw bridgeError("PUBLISH_OWNER_PROOF_INVALID","Invalid UTF8 scalar");
        if(c<128)out.push(c);else if(c<2048)out.push(192|(c>>6),128|(c&63));
        else if(c<65536)out.push(224|(c>>12),128|((c>>6)&63),128|(c&63));
        else out.push(240|(c>>18),128|((c>>12)&63),128|((c>>6)&63),128|(c&63));
    }
    if(out.length>8192)throw bridgeError("PUBLISH_OWNER_PROOF_INVALID","Proof hashing bound exceeded");
    return out;
}
function proofShaBytes(input){
    var K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    var h=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19],a=input.slice(),bits=a.length*8;
    if(a.length>8320)throw bridgeError("PUBLISH_OWNER_PROOF_INVALID","Bounded SHA input required");
    a.push(128);while(a.length%64!==56)a.push(0);
    a.push(0,0,0,0,(bits>>>24)&255,(bits>>>16)&255,(bits>>>8)&255,bits&255);
    function r(x,n){return (x>>>n)|(x<<(32-n));}
    for(var p=0;p<a.length;p+=64){
        var w=[];for(var j=0;j<16;j++)w[j]=(a[p+j*4]<<24)|(a[p+j*4+1]<<16)|(a[p+j*4+2]<<8)|a[p+j*4+3];
        for(j=16;j<64;j++){var x=w[j-15],y=w[j-2];w[j]=(w[j-16]+(r(x,7)^r(x,18)^(x>>>3))+w[j-7]+(r(y,17)^r(y,19)^(y>>>10)))|0;}
        var A=h[0],B=h[1],C=h[2],D=h[3],E=h[4],F=h[5],G=h[6],H=h[7];
        for(j=0;j<64;j++){var t1=(H+(r(E,6)^r(E,11)^r(E,25))+((E&F)^((~E)&G))+K[j]+w[j])|0,t2=((r(A,2)^r(A,13)^r(A,22))+((A&B)^(A&C)^(B&C)))|0;H=G;G=F;F=E;E=(D+t1)|0;D=C;C=B;B=A;A=(t1+t2)|0;}
        h=[(h[0]+A)|0,(h[1]+B)|0,(h[2]+C)|0,(h[3]+D)|0,(h[4]+E)|0,(h[5]+F)|0,(h[6]+G)|0,(h[7]+H)|0];
    }
    var out=[];for(var i=0;i<8;i++)out.push((h[i]>>>24)&255,(h[i]>>>16)&255,(h[i]>>>8)&255,h[i]&255);return out;
}
function proofHex(bytes){return bytes.map(function(x){return ("0"+x.toString(16)).slice(-2);}).join("");}
function proofSha(text){return proofHex(proofShaBytes(proofBytes(text)));}
function proofHmac(key,message){
    var k=proofBytes(key);if(k.length>64)k=proofShaBytes(k);while(k.length<64)k.push(0);
    var i=k.map(function(b){return b^54;}),o=k.map(function(b){return b^92;});
    return proofHex(proofShaBytes(o.concat(proofShaBytes(i.concat(proofBytes(message))))));
}
function proofEqual(a,b){if(typeof a!=="string"||typeof b!=="string"||a.length!==64||b.length!==64)return false;var diff=0;for(var i=0;i<64;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0;}
function proofAscii(v){return JSON.stringify(v).replace(/[\u007f-\uffff]/g,function(c){return "\\u"+("0000"+c.charCodeAt(0).toString(16)).slice(-4);});}
function proofExact(v,keys){return object(v)&&Object.keys(v).length===keys.length&&Object.keys(v).every(function(k){return keys.indexOf(k)>=0;});}
function proofPid(v){return Number.isInteger(v)&&v>0&&v<4294967296;}
function proofBirth(v){return v===null||(typeof v==="string"&&/^[1-9][0-9]{14,19}$/.test(v)&&(v.length<20||v<="18446744073709551615"));}
function proofSession(v){return typeof v==="string"&&/^[!-~]{1,160}$/.test(v);}
function publishOwnerProofPath(){return requireWithin(PluginDir+"/publish-owner-proof.json",PluginDir);}
function publishRecoveryChallenge(){
    try{
        if(!Bridge.publishRecovery||!Bridge.publishRecovery.blocked)return null;
        var lease=readPublishLease(),actual=currentPublishOwner();
        return {schema:1,sessionId:SESSION,hostPid:actual.pid,project:canonical(Config.projectPath),leaseSha256:proofSha(lease.raw)};
    }catch(_){return null;}
}
function readPublishOwnerProof(lease,actual){
    function invalid(message){throw bridgeError("PUBLISH_OWNER_PROOF_INVALID",message);}
    var path=publishOwnerProofPath();
    if(!CS.System.IO.File.Exists(path))throw bridgeError("PUBLISH_OWNER_UNAVAILABLE","Fresh external Windows-helper owner proof required");
    var length=Number(new CS.System.IO.FileInfo(path).Length);
    if(!Number.isInteger(length)||length<2||length>8192)invalid("Bounded owner proof required");
    var raw=String(CS.System.IO.File.ReadAllText(path)).replace(/^\ufeff/,""),envelope,p;
    try{envelope=JSON.parse(raw);if(!proofExact(envelope,["payload","signature"])||raw!==JSON.stringify(envelope)||typeof envelope.payload!=="string"||envelope.payload.length>4096||/[^\x00-\x7f]/.test(envelope.payload)||typeof envelope.signature!=="string"||!/^[0-9a-f]{64}$/.test(envelope.signature))invalid("Canonical signed envelope required");p=JSON.parse(envelope.payload);}catch(_){invalid("Invalid owner proof JSON");}
    if(!proofEqual(proofHmac(Config.token,"fgui-publish-owner-proof-v1\n"+envelope.payload),envelope.signature))invalid("Owner proof authentication failed");
    if(!proofExact(p,["schema","project","hostSession","hostPid","leaseSha256","requestId","issuedAtMs","expiresAtMs","owner"])||envelope.payload!==proofAscii(p)||p.schema!==1)invalid("Exact owner proof schema required");
    if(p.project!==canonical(Config.projectPath)||p.hostSession!==SESSION||p.hostPid!==actual.pid||p.leaseSha256!==proofSha(lease.raw)||p.requestId!==lease.value.requestId)invalid("Proof differs from exact host/session/lease");
    var now=Date.now();
    if(!Number.isSafeInteger(p.issuedAtMs)||p.issuedAtMs<1||!Number.isSafeInteger(p.expiresAtMs)||p.expiresAtMs<=p.issuedAtMs||p.expiresAtMs-p.issuedAtMs>5000||p.issuedAtMs>now+250||now>=p.expiresAtMs)invalid("Owner proof expired or clock invalid");
    var o=p.owner;
    if(!proofExact(o,["pid","expectedStartedFileTime","observedStartedFileTime","state","reason","win32Error"])||!proofPid(o.pid)||o.pid!==lease.value.pid||!proofBirth(o.expectedStartedFileTime)||!proofBirth(o.observedStartedFileTime)||o.expectedStartedFileTime!==lease.value.startedFileTime||!Number.isInteger(o.win32Error)||o.win32Error<0||o.win32Error>=4294967296)invalid("Owner evidence identity differs");
    var reasons={absent:["open-invalid-parameter-complete-census-absent"],exited:["signaled-process-handle"],replaced:["creation-time-differs"],live:["creation-time-matches","pid-presence-conservative"],unknown:["open-failed","census-unconfirmed","wait-failed","times-failed","close-failed","probe-failed","platform-unavailable"]};
    if(typeof o.state!=="string"||!Object.prototype.hasOwnProperty.call(reasons,o.state)||reasons[o.state].indexOf(o.reason)<0)invalid("Inconsistent owner evidence");
    if(o.state==="absent"&&o.win32Error!==87)invalid("Absent owner evidence lacks positive absence");
    if(o.state==="replaced"&&(o.expectedStartedFileTime===null||o.observedStartedFileTime===null||o.expectedStartedFileTime===o.observedStartedFileTime))invalid("PID replacement requires distinct exact creation times");
    if(o.state==="live"&&(o.observedStartedFileTime===null||(o.expectedStartedFileTime!==null&&o.expectedStartedFileTime!==o.observedStartedFileTime)||o.reason!==(o.expectedStartedFileTime===null?"pid-presence-conservative":"creation-time-matches")))invalid("Live owner evidence differs");
    var blocked=o.state==="live"||o.state==="unknown"||(o.pid===actual.pid&&o.state!=="replaced");
    return {live:blocked,proof:o.reason==="times-failed"?"pid-presence-conservative":o.reason,unknown:o.state==="unknown"&&o.reason!=="times-failed",raw:raw,path:path};
}

// A durable lease is not cancellation. Same-process reloads never assume the
// old native Task ended; only a proven absent/replaced owner allows recovery.
function publishLeasePath(){return requireWithin(PluginDir+"/publish-lease.json",PluginDir);}
function publishProcessIdentity(p){
    var id=Number(p.Id),started=null;
    // Unity IL2CPP6.0.5 rejects GetProcessTimes. Missing birth evidence must
    // keep a matching PID blocked, never infer that its old owner exited.
    try{var value=String(p.StartTime.ToFileTimeUtc());if(/^[0-9]{15,22}$/.test(value))started=value;}catch(_){}
    if(!Number.isSafeInteger(id)||id<1)throw bridgeError("PUBLISH_OWNER_UNAVAILABLE","Native process identity unavailable");
    return {pid:id,startedFileTime:started};
}
function currentPublishOwner(){
    var p;
    try{p=CS.System.Diagnostics.Process.GetCurrentProcess();return publishProcessIdentity(p);}
    catch(_){throw bridgeError("PUBLISH_OWNER_UNAVAILABLE","Native process identity unavailable");}
    finally{try{if(p)p.Dispose();}catch(_){}}
}
function publishOwnerLive(lease){
    // Query only this host; other-process evidence comes from the signed helper.
    var actual=currentPublishOwner(),v=lease.value;
    if(actual.pid===v.pid){
        if(v.startedFileTime===null || (actual.startedFileTime!==null && actual.startedFileTime===v.startedFileTime))return {live:true,proof:v.startedFileTime===null?"pid-presence-conservative":"current-pid-and-creation"};
        if(actual.startedFileTime===null && !CS.System.IO.File.Exists(publishOwnerProofPath()))return {live:true,proof:"pid-presence-conservative"};
    }
    var evidence=readPublishOwnerProof(lease,actual);
    if(evidence.unknown)throw bridgeError("PUBLISH_OWNER_UNAVAILABLE","External helper reports unknown owner state; preserving interrupted publish");
    return evidence;
}
function savedPublishMode(){
    var path=requireWithin(Config.projectPath+"/settings/Publish.json",Config.projectPath),length=Number(new CS.System.IO.FileInfo(path).Length),v;
    if(!Number.isInteger(length)||length<2||length>262144)throw bridgeError("PUBLISH_SETTINGS_CONFLICT","Bounded persisted Publish settings required");
    try{v=JSON.parse(String(CS.System.IO.File.ReadAllText(path)).replace(/^\ufeff/,""));}catch(_){throw bridgeError("PUBLISH_SETTINGS_CONFLICT","Persisted Publish settings are invalid; preserved");}
    if(!object(v)||!Number.isInteger(v.branchProcessing))throw bridgeError("PUBLISH_SETTINGS_CONFLICT","Persisted native branch mode missing");
    return v.branchProcessing;
}
function readPublishLease(){
    var path=publishLeasePath(),length=Number(new CS.System.IO.FileInfo(path).Length);
    if(!Number.isInteger(length)||length<2||length>4096)throw bridgeError("PUBLISH_LEASE_INVALID","Bounded canonical publish lease required");
    var raw=String(CS.System.IO.File.ReadAllText(path)).replace(/^\ufeff/,""),v;
    try{v=JSON.parse(raw);}catch(_){throw bridgeError("PUBLISH_LEASE_INVALID","Malformed publish lease; preserved for inspection");}
    var keys=["schema","project","pid","startedFileTime","sessionId","requestId","before","effective"];
    if(!object(v)||raw!==JSON.stringify(v)||Object.keys(v).length!==keys.length||Object.keys(v).some(function(k){return keys.indexOf(k)<0;})||v.schema!==1||v.project!==canonical(Config.projectPath)||!Number.isSafeInteger(v.pid)||v.pid<1||!proofBirth(v.startedFileTime)||typeof v.sessionId!=="string"||v.sessionId.length<1||v.sessionId.length>160||typeof v.requestId!=="string"||!UUID.test(v.requestId)||(v.before!==0&&v.before!==1)||(v.effective!==0&&v.effective!==1))throw bridgeError("PUBLISH_LEASE_INVALID","Invalid publish lease identity/fields; preserved for inspection");
    return {value:v,raw:raw};
}
function claimPublishLease(job){
    var path=publishLeasePath(),owner=currentPublishOwner();
    var raw=JSON.stringify({schema:1,project:canonical(Config.projectPath),pid:owner.pid,startedFileTime:owner.startedFileTime,sessionId:SESSION,requestId:job.requestId,before:job.publishMode.previousBranchProcessing,effective:job.publishMode.effectiveBranchProcessing});
    if(CS.System.IO.File.Exists(path)){Bridge.publishRecovery={blocked:true,status:"existing-lease"};throw bridgeError("PUBLISH_RECOVERY_PENDING","An existing native publish lease requires recovery");}
    var stream,writer;
    try{
        // CreateNew is the cross-host claim, never truncate an existing lease.
        stream=CS.System.IO.File.Open(path,CS.System.IO.FileMode.CreateNew,CS.System.IO.FileAccess.Write,CS.System.IO.FileShare.None);
        writer=new CS.System.IO.StreamWriter(stream,CS.System.Text.Encoding.UTF8);writer.Write(raw);writer.Flush();stream.Flush();writer.Close();writer=null;stream=null;
        var checked=readPublishLease();if(checked.raw!==raw)throw Error("Lease readback mismatch");
        job.publishLeaseRaw=raw;
    }catch(e){plog("PUBLISH_LEASE_CLAIM_FAILED",e);Bridge.publishRecovery={blocked:true,status:"claim-failed",errorCode:"PUBLISH_LEASE_IO"};throw bridgeError("PUBLISH_LEASE_IO","Publish lease claim failed; preserve the record and inspect recovery status");}
    finally{try{if(writer)writer.Close();else if(stream)stream.Close();}catch(_){}}
}
function releasePublishLease(job){
    if(!job.publishLeaseRaw)return;
    try{
        var lease=readPublishLease();
        if(lease.raw!==job.publishLeaseRaw)throw bridgeError("PUBLISH_LEASE_CHANGED","Publish lease changed externally; preserved");
        CS.System.IO.File.Delete(publishLeasePath());
        if(CS.System.IO.File.Exists(publishLeasePath()))throw bridgeError("PUBLISH_LEASE_IO","Publish lease deletion did not persist");
        job.publishLeaseRaw=null;
    }catch(e){Bridge.publishRecovery={blocked:true,status:"release-failed",errorCode:e.bridgeCode || "PUBLISH_LEASE_IO"};throw e;}
}
function recoverPublishLease(){
    var recoveryLock;
    try{
        if(!CS.System.IO.File.Exists(publishLeasePath())){Bridge.publishRecovery={blocked:false,status:"clean"};return;}
        if(!projectAllowed()){Bridge.publishRecovery={blocked:true,status:"waiting-project"};return;}
        var lockPath=requireWithin(PluginDir+"/publish-proof.lock",PluginDir);
        try{recoveryLock=CS.System.IO.File.Open(lockPath,CS.System.IO.FileMode.OpenOrCreate,CS.System.IO.FileAccess.ReadWrite,CS.System.IO.FileShare.None);}catch(_){Bridge.publishRecovery={blocked:true,status:"waiting-proof-lock",errorCode:"PUBLISH_RECOVERY_PENDING"};return;}
        var lease=readPublishLease(),v=lease.value;
        var owner=publishOwnerLive(lease);
        if(owner.live){Bridge.publishRecovery={blocked:true,status:"owner-live",ownerPid:v.pid,ownerProof:owner.proof};return;}
        var g=App.project.GetSettings("Publish"),persisted=savedPublishMode();
        if((g.branchProcessing!==v.before && g.branchProcessing!==v.effective)||(persisted!==v.before&&persisted!==v.effective))throw bridgeError("PUBLISH_SETTINGS_CONFLICT","Settings differ from interrupted publish record; preserving both");
        if(readPublishLease().raw!==lease.raw)throw bridgeError("PUBLISH_LEASE_CHANGED","Publish lease changed during recovery");
        if(String(CS.System.IO.File.ReadAllText(owner.path)).replace(/^\ufeff/,"")!==owner.raw)throw bridgeError("PUBLISH_OWNER_PROOF_CHANGED","Recovery proof changed during verification");
        Coordination.revision++;Coordination.cursors=Object.create(null);
        if(g.branchProcessing!==v.before || persisted!==v.before){g.branchProcessing=v.before;if(g.branchProcessing!==v.before)throw bridgeError("PUBLISH_SETTINGS_READBACK","Interrupted mode restore readback mismatch");g.Touch();g.Save();}
        if(g.branchProcessing!==v.before || savedPublishMode()!==v.before)throw bridgeError("PUBLISH_SETTINGS_READBACK","Interrupted mode restore did not persist");
        // Remove the exact proof before its lease. A crash leaves either a
        // guarded pending lease needing fresh proof, or a fully clean pair.
        if(readPublishLease().raw!==lease.raw)throw bridgeError("PUBLISH_LEASE_CHANGED","Publish lease changed after native restore");
        if(String(CS.System.IO.File.ReadAllText(owner.path)).replace(/^\ufeff/,"")!==owner.raw)throw bridgeError("PUBLISH_OWNER_PROOF_CHANGED","Recovery proof changed after restore");
        CS.System.IO.File.Delete(owner.path);
        if(CS.System.IO.File.Exists(owner.path))throw bridgeError("PUBLISH_LEASE_IO","Proof cleanup did not persist");
        releasePublishLease({publishLeaseRaw:lease.raw});
        Bridge.publishRecovery={blocked:false,status:"recovered",oldOwnerPid:v.pid,restoredBranchProcessing:v.before};
        plog("PUBLISH_LEASE_RECOVERED",null,Bridge.publishRecovery);
    }catch(e){Bridge.publishRecovery={blocked:true,status:"recovery-failed",errorCode:e.bridgeCode || "PUBLISH_LEASE_IO"};plog("PUBLISH_RECOVERY_FAILED",e);}
    finally{try{if(recoveryLock)recoveryLock.Close();}catch(_){Bridge.publishRecovery={blocked:true,status:"lock-release-failed",errorCode:"PUBLISH_LEASE_IO"};}}
}
// ---------------- bounded asynchronous publish (upstream PublishHandler adapter) ----------------
function preparePublishMode(job,global) {
    var mode=job.args.branchMode || "configured",old=global.branchProcessing;
    if(typeof old!=="number" || (old!==0 && old!==1))throw bridgeError("CAPABILITY_UNSUPPORTED","Native branchProcessing must be supported numeric0/1");
    if(job.args.branch){
        var branches=App.project.allBranches,found=false;
        if(!branches || !Number.isInteger(Number(branches.Count)) || Number(branches.Count)>1000)throw bridgeError("CAPABILITY_UNSUPPORTED","Bounded native project branches unavailable");
        for(var i=0;i<Number(branches.Count);i++)if(String(branches.get_Item(i))===job.args.branch)found=true;
        if(!found)throw bridgeError("BRANCH_NOT_FOUND","Selected project branch does not exist");
    }
    if(mode==="configured" && old===0 && job.args.branch)throw bridgeError("PUBLISH_BRANCH_IGNORED","Current settings include all branches; use branchMode=selected or omit branch");
    var value=mode==="all"?0:(mode==="selected" || mode==="trunk")?1:old;
    job.publishMode={requested:mode,branch:job.args.branch || "",effectiveBranchProcessing:value,previousBranchProcessing:old,temporaryOverride:value!==old,restored:value===old};
    claimPublishLease(job);
    if(value!==old){
        job.publishSettings=global;
        global.branchProcessing=value;
        if(global.branchProcessing!==value)throw bridgeError("PUBLISH_SETTINGS_READBACK","branchProcessing override did not persist in native settings");
    }
}
function restorePublishMode(job) {
    if(!job.publishSettings || job.publishMode.restored){releasePublishLease(job);return;}
    var g=job.publishSettings,m=job.publishMode;
    if(g.branchProcessing!==m.effectiveBranchProcessing && g.branchProcessing!==m.previousBranchProcessing)throw bridgeError("PUBLISH_SETTINGS_CONFLICT","Publish settings changed externally; preserving that value");
    g.branchProcessing=m.previousBranchProcessing;
    if(g.branchProcessing!==m.previousBranchProcessing)throw bridgeError("PUBLISH_SETTINGS_READBACK","branchProcessing restore readback mismatch");
    g.Touch();g.Save();m.restored=true;releasePublishLease(job);
}
function recordPublishCleanup(job,error) {
    Bridge.lastPublishCleanup={requestId:job.requestId,ok:!error,branchMode:job.publishMode || null,errorCode:error?(error.bridgeCode || "PUBLISH_RESTORE_FAILED"):null};
}
function publishFinished(job) {
    // Run returns a managed Task. Completion callback alone is a fallback only
    // when a host binding omits that return value, never a claim of cancellation.
    if(job.publishTask)return !!job.publishTask.IsCompleted;
    return !!job.done;
}
function startPublish(job) {
    if(App.docView.HasUnsavedDocuments())throw bridgeError("UNSAVED_DOCUMENTS","Save documents before publish");
    var pkg=getPkg(job.args.pkg),global=App.project.GetSettings("Publish"),settings=pkg.publishSettings;
    Bridge.lastPublishCleanup=null;
    preparePublishMode(job,global);
    CS.System.IO.Directory.CreateDirectory(Config.publishDir);
    global.path=Config.publishDir;global.branchPath=Config.publishDir;global.binaryFormat=true;global.compressDesc=false;
    global.codeGeneration.allowGenCode=false;global.codeGeneration.codePath=Config.publishDir+"/code";global.Touch();global.Save();
    settings.path=Config.publishDir;settings.branchPath=Config.publishDir;settings.codePath=Config.publishDir+"/code";settings.genCode=false;pkg.SetChanged();pkg.Save();
    var handler=new FairyEditor.PublishHandler(pkg,job.args.branch || "");
    handler.exportPath=Config.publishDir;handler.exportCodePath=Config.publishDir+"/code";handler.genCode=false;
    if(canonical(handler.exportPath)!==canonical(Config.publishDir) || canonical(handler.exportCodePath)!==canonical(Config.publishDir+"/code") || handler.genCode)throw bridgeError("PUBLISH_CONFINEMENT_FAILED","Publish path/code settings readback mismatch");
    job.handler=handler;job.done=false;job.files=[];job.t0=Date.now();
    job.deadline=Math.min(job.deadline,job.t0+(job.args.timeout_ms || LIMIT.maxMs));
    job.publishCallback=function(){job.done=true;};
    handler.add_onComplete(job.publishCallback);
    job.nativeStarted=true;job.publishTask=handler.Run(); // Real async task, never treat Exit as synchronous cancellation.
}
function detachPublish(job) { try {if(job.handler && job.publishCallback)job.handler.remove_onComplete(job.publishCallback);}catch(_){plog("PUBLISH_DETACH_FAILED");} }
function stepPublish(job) {
    if(!publishFinished(job))return null;
    restorePublishMode(job);recordPublishCleanup(job,null);
    var handler=job.handler,success=!!handler.isSuccess,files=[];
    if(job.publishTask && (job.publishTask.IsFaulted || job.publishTask.IsCanceled))success=false;
    if(canonical(handler.exportPath)!==canonical(Config.publishDir))throw bridgeError("PUBLISH_PATH_CHANGED","Publish handler path changed");
    try {var found=CS.System.IO.Directory.GetFiles(Config.publishDir);for(var i=0;i<Math.min(Number(found.Length),1024);i++)files.push(String(found.GetValue(i)));}catch(_){plog("PUBLISH_LIST_FILES_FAILED");}
    var out={ok:success,data:{isSuccess:success,elapsedMs:Date.now()-job.t0,branchMode:job.publishMode,files:files,exportPath:Config.publishDir,verified:false},error:success?null:{code:"PUBLISH_FAILED",message:"Editor PublishHandler reported isSuccess=false"}};
    detachPublish(job);return out;
}
var ASYNC_STARTERS={publish:startPublish},ASYNC_STEPPERS={publish:stepPublish};
var DOCUMENT_COMMANDS=["transition_sample","transition_list","transition_create","transition_update","transition_remove","transition_keyframe_set","transition_keyframe_remove","relation_list","relation_set","relation_remove","controller_list","controller_create","controller_update","controller_select","controller_remove","open_doc","list_children","insert_object","set_property","remove_object"];
function utf8Length(s) { var n=0;for(var i=0;i<s.length;i++){var c=s.charCodeAt(i);if(c<128)n++;else if(c<2048)n+=2;else if(c>=0xd800&&c<=0xdbff&&i+1<s.length&&s.charCodeAt(i+1)>=0xdc00&&s.charCodeAt(i+1)<=0xdfff){n+=4;i++;}else n+=3;}return n; }
function stamp(out,job) {out.requestId=job && job.requestId || null;out.sessionId=SESSION;if(out.revision===undefined)out.revision=Coordination.revision;return out;}
function writeResponse(ctx,status,out,job) {
    out=stamp(out,job);
    var body=JSON.stringify(out);
    if(utf8Length(body)+1>LIMIT.response){out=stamp(fail("Response exceeds64KiB","RESULT_LIMIT"),job);body=JSON.stringify(out);}
    if(Bridge.writers.length>=LIMIT.writers){try{ctx.Response.Abort();}catch(_){}plog("RESPONSE_CAPACITY");return out;}
    try {
        var response=ctx.Response;response.StatusCode=status;response.ContentType="application/json; charset=utf-8";response.KeepAlive=false;response.SendChunked=false;response.ContentLength64=BigInt(utf8Length(body)+1);
        var writer=new CS.System.IO.StreamWriter(response.OutputStream);writer.NewLine="\n";
        var pending=writer.WriteLineAsync(body);
        Bridge.writers.push({ctx:ctx,writer:writer,pending:pending,phase:"write",deadline:Date.now()+5000});
    }catch(error){try{ctx.Response.Abort();}catch(__){}plog("RESPONSE_BINDING_OR_IO_FAILED",error);}
    return out;
}
function taskFailed(t) { return !!(t.IsFaulted || t.IsCanceled); }
function pumpWriters() {
    // At most32 bounded states; no waits or blocking Read/Write/Flush loop.
    for(var i=Bridge.writers.length-1;i>=0;i--){var w=Bridge.writers[i];
        try {
            if(Date.now()>=w.deadline)throw bridgeError("RESPONSE_TIMEOUT","Response timeout");
            if(!w.pending.IsCompleted)continue;
            if(taskFailed(w.pending))throw bridgeError("RESPONSE_IO","Response I/O failed");
            if(w.phase==="write"){w.pending=w.writer.FlushAsync();w.phase="flush";continue;}
            // Fixed length is fully flushed. Force-close avoids normal Close request-body draining.
            w.ctx.Response.Abort();Bridge.writers.splice(i,1);
        }catch(_){try{w.ctx.Response.Abort();}catch(__){}Bridge.writers.splice(i,1);plog("RESPONSE_IO_OR_TIMEOUT");}
    }
}
function safeToken(candidate) { if(typeof candidate!=="string")return false;var wanted="Bearer "+Config.token;var delta=candidate.length^wanted.length;for(var i=0;i<wanted.length;i++)delta|=(candidate.charCodeAt(i)||0)^wanted.charCodeAt(i);return delta===0; }
function admit(ctx) {
    var req=ctx.Request;
    try {
        var remote=String(req.RemoteEndPoint.Address);
        if(!req.IsLocal || (remote!=="127.0.0.1" && remote!=="::ffff:127.0.0.1"))throw bridgeError("LOOPBACK_REQUIRED","IPv4 loopback only");
        var origin=req.Headers.Get("Origin");if(origin!==null && origin!==undefined)throw bridgeError("ORIGIN_FORBIDDEN","Browser Origin is not accepted");
        if(String(req.Headers.Get("Host"))!==Config.host+":"+Config.port)throw bridgeError("HOST_NOT_ALLOWED","Exact configured Host required");
        if(!safeToken(req.Headers.Get("Authorization"))) {writeResponse(ctx,401,fail("Bearer authentication required","UNAUTHORIZED"));return;}
        if(req.HttpMethod!=="POST" || String(req.RawUrl)!=="/")throw bridgeError("METHOD_NOT_ALLOWED","Only POST / is accepted");
        if(!/^application\/json(?:;|$)/i.test(String(req.ContentType)))throw bridgeError("CONTENT_TYPE","application/json required");
        var length=Number(req.ContentLength64);
        if(!Number.isSafeInteger(length)||length<=0||length>LIMIT.body || req.Headers.Get("Transfer-Encoding"))throw bridgeError("BODY_LIMIT","Content-Length1..65536 required; chunked rejected");
        if(Bridge.readers.length>=LIMIT.readers || Bridge.queue.length>=LIMIT.queue){writeResponse(ctx,429,fail("Request queue capacity reached","QUEUE_FULL"));return;}
        var reader=new CS.System.IO.StreamReader(req.InputStream);
        var buffer=CS.System.Array.CreateInstance(require("puerts").$typeof(CS.System.Char),4096);
        var pending=reader.ReadAsync(buffer,0,4096);
        Bridge.readers.push({ctx:ctx,reader:reader,pending:pending,buffer:buffer,chunks:[],chars:0,deadline:Date.now()+LIMIT.bodyMs});
    }catch(e){plog(e.bridgeCode || "REQUEST_READ_BINDING_FAILED",e);writeResponse(ctx,400,fail(e.bridgeCode?e.message:"Request reader binding failed",e.bridgeCode || "BODY_IO_ERROR"));}
}
function pumpAccepts() {
    if(!Bridge.listener)return;
    if(!Bridge.pendingAccept){try{Bridge.pendingAccept=Bridge.listener.BeginGetContext(null,null);}catch(_){plog("ACCEPT_REARM_FAILED");}return;}
    if(!Bridge.pendingAccept.IsCompleted)return;
    var ctx=null;
    try{ctx=Bridge.listener.EndGetContext(Bridge.pendingAccept);}catch(_){plog("ACCEPT_FAILED");}
    Bridge.pendingAccept=null;
    try{Bridge.pendingAccept=Bridge.listener.BeginGetContext(null,null);}catch(_){plog("ACCEPT_REARM_FAILED");}
    if(ctx)admit(ctx);
}
function validateEnvelope(msg) {
    if(!object(msg))throw bridgeError("INVALID_REQUEST","Object body required");
    Object.keys(msg).forEach(function(k){if(["cmd","args","requestId","sessionId","deadlineMs","expectedRevision"].indexOf(k)<0)throw bridgeError("INVALID_REQUEST","Unexpected envelope key");});
    if(typeof msg.requestId!=="string" || !UUID.test(msg.requestId))throw bridgeError("INVALID_REQUEST","UUID requestId required");
    if(typeof msg.cmd!=="string" || !Object.prototype.hasOwnProperty.call(ARG_KEYS,msg.cmd))throw bridgeError("COMMAND_NOT_ALLOWED","Unknown command");
    if(msg.cmd!=="ping" && msg.sessionId!==SESSION)throw bridgeError("SESSION_MISMATCH","Fresh ping sessionId required; no operation executed");
    if(msg.cmd==="ping" && msg.sessionId!==undefined && msg.sessionId!==SESSION)throw bridgeError("SESSION_MISMATCH","Stale ping sessionId");
    if(!Number.isSafeInteger(msg.deadlineMs)||msg.deadlineMs<=Date.now())throw bridgeError("DEADLINE_EXCEEDED","Request expired; no operation executed");
    if(mutates(msg.cmd)&&(!Number.isSafeInteger(msg.expectedRevision)||msg.expectedRevision<0))throw bridgeError("REVISION_REQUIRED","Mutations require an observed project revision");
    validateArgs(msg.cmd,msg.args);
    if(msg.cmd!=="ping")assertProject();
}
function enqueue(ctx,msg) {
    var job={ctx:ctx,cmd:msg.cmd,args:msg.args,requestId:msg.requestId,deadline:Math.min(msg.deadlineMs,Date.now()+LIMIT.maxMs),phase:"queued",expectedRevision:msg.expectedRevision};
    validateEnvelope(msg);
    // Dynamic ping is read-only and deliberately uncached: liveness remains available while publish is busy.
    if(job.cmd==="ping"){writeResponse(ctx,200,COMMANDS.ping(job.args),job);return;}
    var fingerprint=JSON.stringify({cmd:job.cmd,args:job.args,expectedRevision:job.expectedRevision}),seen=Bridge.seen[job.requestId];
    if(seen){
        if(seen.fingerprint!==fingerprint)writeResponse(ctx,409,fail("requestId reused with different operation","REQUEST_ID_REUSED"),job);
        else if(seen.response)writeResponse(ctx,200,seen.response,job);
        else writeResponse(ctx,409,fail(seen.done?"Prior completion retained without payload; operation not replayed":"Request already in progress; operation not replayed",seen.done?"COMPLETION_RETAINED_NO_REPLAY":"REQUEST_IN_PROGRESS"),job);
        return;
    }
    if(Bridge.queue.length>=LIMIT.queue) {writeResponse(ctx,429,fail("Queue full","QUEUE_FULL"),job);return;}
    if(Bridge.seenCount>=LIMIT.seen){writeResponse(ctx,429,fail("Session claim capacity reached; no claim evicted","SESSION_CAPACITY"),job);return;}
    Bridge.seen[job.requestId]={fingerprint:fingerprint,done:false,response:null};Bridge.seenCount++;
    Bridge.queue.push(job);
}
function pumpReaders() {
    for(var i=Bridge.readers.length-1;i>=0;i--){var r=Bridge.readers[i];
        if(!r.pending.IsCompleted && Date.now()<r.deadline)continue;
        var msg=null;
        try {
            if(Date.now()>=r.deadline)throw bridgeError("BODY_TIMEOUT","Body deadline exceeded");
            if(taskFailed(r.pending))throw bridgeError("BODY_IO_ERROR","Body read failed");
            var count=Number(r.pending.Result);
            if(!Number.isInteger(count) || count<0 || count>4096)throw bridgeError("BODY_IO_ERROR","Invalid character read count");
            if(count>0) {
                r.chars+=count;if(r.chars>LIMIT.body)throw bridgeError("BODY_LIMIT","Body exceeds character bound");
                // Char is a numeric Puerts primitive; GetValue remains checked to avoid guessed string constructors.
                var text="";
                for(var j=0;j<count;j++) {
                    var value=r.buffer.GetValue(j);
                    if(typeof value==="number")text+=String.fromCharCode(value);
                    else {var character=String(value);if(character.length!==1)throw bridgeError("CHAR_BINDING_ERROR","Unexpected boxed Char binding");text+=character;}
                }
                r.chunks.push(text);
                r.pending=r.reader.ReadAsync(r.buffer,0,4096);
                continue;
            }
            Bridge.readers.splice(i,1);
            var body=r.chunks.join("");if(utf8Length(body)>LIMIT.body)throw bridgeError("BODY_LIMIT","Body exceeds64KiB");
            try{msg=JSON.parse(body);}catch(_){throw bridgeError("INVALID_JSON","Malformed JSON");}
            enqueue(r.ctx,msg);
        }catch(e){
            if(Bridge.readers[i]===r)Bridge.readers.splice(i,1);
            plog(e.bridgeCode || "BODY_READ_BINDING_FAILED",e);
            writeResponse(r.ctx,400,fail(e.bridgeCode?e.message:"Request rejected",e.bridgeCode || "BODY_IO_ERROR"),msg && UUID.test(String(msg.requestId))?{requestId:msg.requestId}:null);
        }
    }
}
function complete(job,out,retainCurrent) {
    if(job.responded){if(!retainCurrent && Bridge.current===job)Bridge.current=null;return;}
    job.responded=true;
    if(job.writeClaimed)Coordination.revision++;
    var sent=writeResponse(job.ctx,200,out,job),seen=Bridge.seen[job.requestId];
    seen.done=true;seen.response=sent;Bridge.completed.push(job.requestId);
    if(Bridge.completed.length>LIMIT.cache){var evicted=Bridge.completed.shift();Bridge.seen[evicted].response=null;}
    if(!retainCurrent && Bridge.current===job)Bridge.current=null;
}
function execute(job) {
    Bridge.itemCount=0;
    var result=COMMANDS[job.cmd](job.args);
    if(job.cmd==="create_component") {
        job.result=result;job.opened=ensureDocOpen(getPkg(job.args.pkg),result.data.name);job.phase="post-create-wait";job.openFrame=Bridge.frame;return;
    }
    complete(job,result);
}
function stepQueue() {
    var job=Bridge.current;
    if(!job){job=Bridge.queue.shift();if(!job)return;Bridge.current=job;}
    try {
        // Drain independently of deadline or project changes. No later command may
        // overlap an unfinished native publisher, even after the response timed out.
        if(job.phase==="publish-drain"){
            if(!publishFinished(job))return;
            try{restorePublishMode(job);recordPublishCleanup(job,null);}catch(cleanupError){recordPublishCleanup(job,cleanupError);plog(cleanupError.bridgeCode || "PUBLISH_RESTORE_FAILED",cleanupError);}
            detachPublish(job);complete(job,null);return;
        }
        assertProject();
        if(Bridge.publishRecovery && Bridge.publishRecovery.blocked && job.cmd!=="bridge_log")throw bridgeError("PUBLISH_RECOVERY_PENDING","Interrupted native publish owner/settings require recovery; inspect ping.publishRecovery");
        if(Date.now()>=job.deadline){
            if(job.nativeStarted && !publishFinished(job)){
                job.phase="publish-drain";
                complete(job,fail("Request deadline exceeded; native publish is still running, queue retained until completion; do not retry automatically","DEADLINE_EXCEEDED"),true);return;
            }
            if(job.handler)detachPublish(job);
            restorePublishMode(job);
            complete(job,fail("Request deadline exceeded; operation will not be replayed","DEADLINE_EXCEEDED"));return;
        }
        if(job.phase==="publish-wait"){var out=stepPublish(job);if(out)complete(job,out);return;}
        if(job.phase==="document-wait" || job.phase==="post-create-wait"){
            if(Bridge.frame<=job.openFrame || !job.opened.doc.content)return;
            if(job.phase==="post-create-wait"){complete(job,job.result);return;}
            execute(job);return;
        }
        claimWrite(job);
        if(job.cmd==="publish"){job.phase="publish-wait";startPublish(job);return;}
        if(DOCUMENT_COMMANDS.indexOf(job.cmd)>=0){job.opened=ensureDocOpen(getPkg(job.args.pkg),job.args.name);job.phase="document-wait";job.openFrame=Bridge.frame;return;}
        execute(job);
    }catch(e){
        var draining=job.nativeStarted && !publishFinished(job);
        if(draining)job.phase="publish-drain";
        else {if(job.handler)detachPublish(job);try{restorePublishMode(job);if(job.publishMode)recordPublishCleanup(job,null);}catch(cleanupError){recordPublishCleanup(job,cleanupError);e=cleanupError;}}
        plog(e.bridgeCode || "EDITOR_API_ERROR",e);
        complete(job,fail(e.bridgeCode?e.message:"Editor API call failed; operation may be partially applied and will not be replayed",e.bridgeCode || "EDITOR_API_ERROR"),draining);
    }
}
function startServer() {
    if(Bridge.listener || !Config)return;
    try {
        var listener=new CS.System.Net.HttpListener();listener.Prefixes.Add("http://127.0.0.1:"+Config.port+"/");listener.Start();
        Bridge.listener=listener;Bridge.port=Config.port;Bridge.pendingAccept=listener.BeginGetContext(null,null);plog("LISTENER_STARTED");
    }catch(_){try{if(listener)listener.Close();}catch(__){}Bridge.listener=null;Bridge.pendingAccept=null;plog("LISTENER_START_FAILED");}
}
function projectOpened() { recoverPublishLease();startServer(); }
function pumpFrom(source) {
    if(Bridge.stopped)return;
    if(source==="app")Bridge.appEntries++;else Bridge.timerEntries++;
    if(Bridge.backgroundFallback){
        try{if(!CS.UnityEngine.Application.runInBackground)CS.UnityEngine.Application.runInBackground=true;}catch(error){if(Date.now()>=Bridge.nextPumpDiagAt)plog("BACKGROUND_FALLBACK_FAILED",error);}
    }
    var now=Date.now(),unityFrame;
    try{unityFrame=Number(CS.UnityEngine.Time.frameCount);}catch(error){
        if(now>=Bridge.nextPumpDiagAt){Bridge.nextPumpDiagAt=now+10000;plog("FRAMECOUNT_BINDING_FAILED",error);}
        // Do not run two un-deduplicated sources if the frame-count binding is absent.
        if(source!=="app")return;unityFrame=Bridge.frame+1;
    }
    if(now>=Bridge.nextPumpDiagAt){
        Bridge.nextPumpDiagAt=now+10000;
        plog("PUMP_COUNTERS",null,{appEntries:Bridge.appEntries,timerEntries:Bridge.timerEntries,unityFrame:unityFrame,processedFrames:Bridge.frame,lastPumpMs:Bridge.updatedAtMs,observedAtMs:now,readers:Bridge.readers.length,writers:Bridge.writers.length,queue:Bridge.queue.length,busy:Bridge.current!==null,backgroundPolicy:backgroundPolicy()});
    }
    if(unityFrame===Bridge.lastUnityFrame || Bridge.pumping)return;
    Bridge.lastUnityFrame=unityFrame;Bridge.pumping=true;
    try{
        Bridge.frame++;Bridge.updatedAtMs=now;
        if(!Bridge.current && Bridge.publishRecovery && Bridge.publishRecovery.blocked && now>=(Bridge.nextRecoveryAt || 0)){Bridge.nextRecoveryAt=now+2000;recoverPublishLease();}
        // Each stage is isolated; no waits, normal stream Close or worker-thread JS callbacks.
        try{pumpWriters();}catch(error){plog("WRITE_PUMP_ERROR",error);}
        try{pumpAccepts();}catch(error){plog("ACCEPT_PUMP_ERROR",error);}
        try{pumpReaders();}catch(error){plog("READ_PUMP_ERROR",error);}
        try{stepQueue();}catch(error){plog("COMMAND_PUMP_ERROR",error);}
    }finally{Bridge.pumping=false;}
}
function onUpdate(){pumpFrom("app");}
function onTimerUpdate(param){pumpFrom("timer");}
function loadConfig() {
    var c=JSON.parse(String(CS.System.IO.File.ReadAllText(PluginDir+"/config.json")));
    if(c.host!=="127.0.0.1" || (!Number.isInteger(c.port)||c.port<1024||c.port>65535) || typeof c.token!=="string" || c.token.length<24 || c.token.length>256)throw bridgeError("CONFIG_INVALID","Invalid loopback config");
    ["projectPath","publishDir","screenshotDir"].forEach(function(k){if(typeof c[k]!=="string" || !/^[A-Za-z]:[\\/]/.test(c[k]))throw bridgeError("CONFIG_INVALID","Absolute configured paths required");});
    requireWithin(PluginDir,c.projectPath);requireWithin(c.publishDir,CS.System.IO.Path.GetDirectoryName(c.projectPath));requireWithin(c.screenshotDir,CS.System.IO.Path.GetDirectoryName(c.projectPath));
    return c;
}
function boot() {
    plog("BOOT_STARTED");
    try{Config=loadConfig();}catch(_){plog("CONFIG_LOAD_FAILED");plog("BOOT_RETURNED");return;}
    recoverPublishLease();
    acquireBackgroundHold();
    try{App.add_onUpdate(onUpdate);Bridge.subscribed=true;plog("UPDATE_SUBSCRIBED");}catch(_){plog("UPDATE_SUBSCRIBE_FAILED");}
    try{FairyGUI.Timers.inst.AddUpdate(onTimerUpdate);Bridge.timerSubscribed=true;plog("TIMER_SUBSCRIBED");}catch(error){plog("TIMER_SUBSCRIBE_FAILED",error);}
    // Preserve upstream boot behavior: listener starts immediately, independent of first frame.
    if(App.project!=null)startServer();
    else {try{App.add_onProjectOpened(projectOpened);}catch(_){plog("PROJECT_EVENT_SUBSCRIBE_FAILED");}}
    plog("BOOT_RETURNED");
}
function onDestroy() {
    if(Bridge.stopped)return;
    Bridge.stopped=true;
    try{if(Bridge.subscribed)App.remove_onUpdate(onUpdate);}catch(_){}Bridge.subscribed=false;
    try{App.remove_onProjectOpened(projectOpened);}catch(_){}
    try{if(Bridge.timerSubscribed)FairyGUI.Timers.inst.Remove(onTimerUpdate);}catch(error){plog("TIMER_UNSUBSCRIBE_FAILED",error);}Bridge.timerSubscribed=false;
    try{if(Bridge.current && Bridge.current.handler){
        if(!Bridge.current.nativeStarted || publishFinished(Bridge.current))restorePublishMode(Bridge.current);
        else plog("PUBLISH_ACTIVE_ON_UNLOAD"); // No cancellation or restoration guarantee during host/plugin teardown.
        detachPublish(Bridge.current);
    }}catch(_){plog("PUBLISH_UNLOAD_RESTORE_FAILED");}
    Bridge.readers.forEach(function(r){try{r.ctx.Response.Abort();}catch(_){}});
    Bridge.writers.forEach(function(w){try{w.ctx.Response.Abort();}catch(_){}});
    try{if(Bridge.listener)Bridge.listener.Close();}catch(_){}Bridge.listener=null;
    if(Bridge.backgroundHold){
        Bridge.backgroundHold=false;Bridge.backgroundHoldReleased=true;
        try{App.EndBackgroundJob();plog("BACKGROUND_HOLD_RELEASED",null,backgroundPolicy());}catch(error){plog("BACKGROUND_HOLD_END_FAILED",error);}
    }
    if(Bridge.backgroundCaptured){try{CS.UnityEngine.Application.runInBackground=Bridge.backgroundOriginal;Bridge.backgroundEffective=!!CS.UnityEngine.Application.runInBackground;plog("BACKGROUND_RESTORED");}catch(_){plog("BACKGROUND_RESTORE_FAILED");}}
    plog("DESTROYED");
}
exports.onDestroy=onDestroy;
boot();
