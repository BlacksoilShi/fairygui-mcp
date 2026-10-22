'use strict';
// One owned asynchronous job. Private config path only, no credentials in argv.
const fs=require('node:fs'),path=require('node:path');
const {createHost}=require('./browser_preview.cjs');
const [file,work]=process.argv.slice(2);let host,timer,poll;
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
(async()=>{
 let receipt={state:'failed',error:{code:'PREVIEW_JOB_FAILURE'}},expired=false;
 try{
  const cfg=JSON.parse(fs.readFileSync(file,'utf8')),aborter=new AbortController();
  if(!Number.isSafeInteger(cfg.deadlineAtMs)||cfg.deadlineAtMs<=Date.now()){expired=true;throw Error('expired');}
  const ownership=path.join(work,'node-owned.json'),gateDeadline=Date.now()+5000;
  while(!fs.existsSync(ownership)&&Date.now()<gateDeadline)await new Promise(r=>setTimeout(r,10));
  const owner=JSON.parse(fs.readFileSync(ownership,'utf8'));if(owner.node?.pid!==process.pid||owner.jobId!==path.basename(work))throw Error('ownership gate');
  timer=setTimeout(()=>{expired=true;aborter.abort();},Math.max(1,cfg.deadlineAtMs-Date.now()));
  poll=setInterval(()=>{if(fs.existsSync(path.join(work,'cancel.json')))aborter.abort();},50);
  if(fs.existsSync(path.join(work,'cancel.json')))aborter.abort();
  host=await createHost(cfg.host,work,{signal:aborter.signal,onProgress:p=>emit({event:'progress',phase:p.phase,sequence:p.sequence})});
  receipt=await host.preview(cfg.request);
 }catch(error){receipt={state:error.code==='PREVIEW_CANCELLED'?'cancelled':'failed',error:{code:typeof error.code==='string'&&/^PREVIEW_[A-Z_]+$/.test(error.code)?error.code:'PREVIEW_JOB_FAILURE'},...(!host?{cleanup:{confirmed:true,reason:'preview-not-started'}}:{})};}
 finally{
  clearTimeout(timer);clearInterval(poll);
  if(host){try{receipt.close=await host.close();}catch{receipt.close={contextClosed:false,profileRemoved:false};}}
 }
 if(expired){receipt.state='failed';receipt.error={code:'PREVIEW_DEADLINE'};}
 emit({event:'result',receipt});
})().catch(()=>{emit({event:'result',receipt:{state:'failed',error:{code:'PREVIEW_JOB_FAILURE'}}});process.exitCode=1;});
