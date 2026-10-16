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
