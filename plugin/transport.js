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
var DOCUMENT_COMMANDS=["relation_list","relation_set","relation_remove","controller_list","controller_create","controller_update","controller_select","controller_remove","open_doc","list_children","insert_object","set_property","remove_object"];
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
