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
