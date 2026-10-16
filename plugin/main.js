// MIT fork of wingcd/fairygui-agent-bridge @4b3abc16da973b4a1d54325f61d2522455349168.
// See LICENSE. Upstream command handlers remain below; transport and bounds are adapted.
// No JS callbacks run on worker threads: completed managed I/O tasks are polled onUpdate.
"use strict";
var CS = require("csharp");
var FairyGUI = CS.FairyGUI, FairyEditor = CS.FairyEditor, App = FairyEditor.App;
var VERSION = "0.5.0-dev.1";
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
var ARG_KEYS={controller_list:["pkg","name","controller","offset","limit"],controller_create:["pkg","name","controller","pages","exported"],controller_update:["pkg","name","controller","newName","pageNames","exported"],controller_select:["pkg","name","controller","index"],controller_remove:["pkg","name","controller"],list_items_page:["pkg","limit","cursor"],ping:[],project_info:[],list_packages:[],list_items:["pkg","depth"],read_component:["pkg","name"],create_component:["pkg","name","width","height","path","exported","extention"],delete_item:["pkg","name"],open_doc:["pkg","name"],close_doc:["pkg","name"],list_children:["pkg","name"],insert_object:["pkg","name","url","ref_pkg","ref_name","x","y","index","props"],set_property:["pkg","name","target","props","prop","value"],remove_object:["pkg","name","target"],save_all:[],refresh:[],screenshot:["path"],bridge_log:["tail"],publish:["pkg","branch","out_path","timeout_ms"]};
function validateArgs(cmd,a) {
    if(!object(a))throw bridgeError("INVALID_ARGUMENTS","args must be object");
    Object.keys(a).forEach(function(k){if(ARG_KEYS[cmd].indexOf(k)<0)throw bridgeError("INVALID_ARGUMENTS","Unsupported argument key");});
    ["pkg","name","ref_pkg","ref_name","target"].forEach(function(k){if(a[k]!==undefined && (typeof a[k]!=="string" || !a[k].length || a[k].length>256 || /[\u0000-\u001f]/.test(a[k])))throw bridgeError("INVALID_ARGUMENTS","Bounded nonempty identifier required");});
    if(ARG_KEYS[cmd].indexOf("pkg")>=0 && !a.pkg)throw bridgeError("INVALID_ARGUMENTS","pkg required");
    if(ARG_KEYS[cmd].indexOf("name")>=0 && !a.name)throw bridgeError("INVALID_ARGUMENTS","name required");
    if(a.limit!==undefined && (!Number.isInteger(a.limit)||a.limit<1||a.limit>100))throw bridgeError("INVALID_ARGUMENTS","limit1..100 required");
    if(a.cursor!==undefined && (typeof a.cursor!=="string"||a.cursor.length<1||a.cursor.length>160))throw bridgeError("INVALID_ARGUMENTS","Bounded cursor string required");
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
var WRITE_COMMANDS=["controller_create","controller_update","controller_select","controller_remove","create_component","delete_item","insert_object","set_property","remove_object","save_all","refresh","publish","close_doc"];
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
// ---------------- bounded asynchronous publish (upstream PublishHandler adapter) ----------------
function startPublish(job) {
    if(App.docView.HasUnsavedDocuments())throw bridgeError("UNSAVED_DOCUMENTS","Save documents before publish");
    var pkg=getPkg(job.args.pkg),global=App.project.GetSettings("Publish"),settings=pkg.publishSettings;
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
    handler.Run(); // Original upstream public API; normal editor checks remain untouched.
}
function detachPublish(job) { try {if(job.handler && job.publishCallback)job.handler.remove_onComplete(job.publishCallback);}catch(_){plog("PUBLISH_DETACH_FAILED");} }
function stepPublish(job) {
    if(!job.done)return null;
    var handler=job.handler,success=!!handler.isSuccess,files=[];
    if(canonical(handler.exportPath)!==canonical(Config.publishDir))throw bridgeError("PUBLISH_PATH_CHANGED","Publish handler path changed");
    try {var found=CS.System.IO.Directory.GetFiles(Config.publishDir);for(var i=0;i<Math.min(Number(found.Length),1024);i++)files.push(String(found.GetValue(i)));}catch(_){plog("PUBLISH_LIST_FILES_FAILED");}
    var out={ok:success,data:{isSuccess:success,elapsedMs:Date.now()-job.t0,files:files,exportPath:Config.publishDir,verified:false},error:success?null:{code:"PUBLISH_FAILED",message:"Editor PublishHandler reported isSuccess=false"}};
    detachPublish(job);return out;
}
var ASYNC_STARTERS={publish:startPublish},ASYNC_STEPPERS={publish:stepPublish};
var DOCUMENT_COMMANDS=["controller_list","controller_create","controller_update","controller_select","controller_remove","open_doc","list_children","insert_object","set_property","remove_object"];
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
function complete(job,out) {
    if(job.writeClaimed)Coordination.revision++;
    var sent=writeResponse(job.ctx,200,out,job),seen=Bridge.seen[job.requestId];
    seen.done=true;seen.response=sent;Bridge.completed.push(job.requestId);
    if(Bridge.completed.length>LIMIT.cache){var evicted=Bridge.completed.shift();Bridge.seen[evicted].response=null;}
    if(Bridge.current===job)Bridge.current=null;
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
        assertProject();
        if(Date.now()>=job.deadline){
            if(job.handler){try{job.handler.Exit();}catch(_){plog("PUBLISH_EXIT_FAILED");}detachPublish(job);}
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
    }catch(e){if(job.handler)detachPublish(job);plog(e.bridgeCode || "EDITOR_API_ERROR",e);complete(job,fail(e.bridgeCode?e.message:"Editor API call failed; operation may be partially applied and will not be replayed",e.bridgeCode || "EDITOR_API_ERROR"));}
}
function startServer() {
    if(Bridge.listener || !Config)return;
    try {
        var listener=new CS.System.Net.HttpListener();listener.Prefixes.Add("http://127.0.0.1:"+Config.port+"/");listener.Start();
        Bridge.listener=listener;Bridge.port=Config.port;Bridge.pendingAccept=listener.BeginGetContext(null,null);plog("LISTENER_STARTED");
    }catch(_){try{if(listener)listener.Close();}catch(__){}Bridge.listener=null;Bridge.pendingAccept=null;plog("LISTENER_START_FAILED");}
}
function projectOpened() { startServer(); }
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
    try{if(Bridge.current && Bridge.current.handler)detachPublish(Bridge.current);}catch(_){}
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
