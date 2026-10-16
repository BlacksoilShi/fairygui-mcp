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
