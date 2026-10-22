import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {loadConfig,ProjectBridge} from '../lib/core.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const W=fs.mkdtempSync(path.join(process.env.FGUI_DIAGNOSTICS_WORK||os.tmpdir(),'preview-config-'));
let checks=0;
const c={projectPath:W,editorPath:process.execPath,python:process.execPath,host:'127.0.0.1',port:17931,token:'x'.repeat(64),publishDir:path.join(W,'out'),screenshotDir:path.join(W,'screens')};
const cfg=path.join(W,'config.json');
function good(extra){fs.writeFileSync(cfg,JSON.stringify({...c,...extra}));loadConfig(cfg);checks++;}
function bad(extra){fs.writeFileSync(cfg,JSON.stringify({...c,...extra}));assert.throws(()=>loadConfig(cfg),e=>e.code==='CONFIG_INVALID');checks++;}
good({});good({sourcePreviews:false});
for(const v of [true,'true',1,null])bad({sourcePreviews:v});
const source={sourceHelper:path.join(W,'backend.py'),sourceConfig:path.join(W,'backend.json'),sourceProtocol:'fgui-rebuild-http/1'};
good({...source,sourcePreviews:true});good({...source,sourcePreviews:false});
for(const v of ['true',1,null])bad({...source,sourcePreviews:v});
const b=new ProjectBridge({...c,...source},cfg,{helperPath:path.join(ROOT,'helper.py')});
await assert.rejects(()=>b.helper('source_preview',{}),e=>e.code==='SOURCE_PREVIEW_DISABLED');checks++;
console.log(JSON.stringify({passed:true,checks,scope:'Explicit preview opt-in/legacy config and helper admission; no editor or source endpoint execution'}));
