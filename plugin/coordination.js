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
