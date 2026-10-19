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

