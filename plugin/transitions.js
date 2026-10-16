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
