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

