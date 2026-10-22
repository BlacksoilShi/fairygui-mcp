// Distribution metadata/install checks. No native editor is launched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
let checks=0; const check=fn=>{fn();checks++;};
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const plugin=JSON.parse(fs.readFileSync(path.join(root,'plugin/package.json'),'utf8'));
check(()=>assert.equal(pkg.version,'0.7.1'));
check(()=>assert.equal(plugin.version,pkg.fgui.bridgePluginVersion));
check(()=>assert(fs.readFileSync(path.join(root,'plugin/header.js'),'utf8').includes('var VERSION = "'+pkg.fgui.bridgePluginVersion+'";')));
check(()=>assert(fs.readFileSync(path.join(root,'server.mjs'),'utf8').includes("version:'"+pkg.version+"'")));
const omitted=new Set(['tmp','__pycache__','.git','node_modules']);
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>omitted.has(e.name)?[]:e.isDirectory()?files(path.join(dir,e.name)):[path.join(dir,e.name)]);}
const entries=files(root);
check(()=>assert(entries.length>=40));
check(()=>assert(entries.every(f=>!fs.readFileSync(f).includes(13)),'Distribution files must use LF'));
check(()=>assert(entries.every(f=>!/^config\.json$|\.local\.json$|\.(exe|dll|pdb|zip|fui|bytes)$/i.test(path.basename(f)))));
check(()=>assert(entries.every(f=>!fs.lstatSync(f).isSymbolicLink())));
const broken=[];
for(const file of entries.filter(f=>f.endsWith('.md'))){
 const text=fs.readFileSync(file,'utf8');
 for(const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)){
  if(/^[a-z]+:|^#/i.test(m[1]))continue;
  const target=path.resolve(path.dirname(file),decodeURIComponent(m[1].split('#')[0]));
  if(!fs.existsSync(target)||path.relative(root,target).startsWith('..'))broken.push([path.relative(root,file),m[1]]);
 }
}
check(()=>assert.deepEqual(broken,[]));
check(()=>assert.equal(JSON.parse(fs.readFileSync(path.join(root,'docs/contract.schema.json'),'utf8')).$schema,'https://json-schema.org/draft/2020-12/schema'));
const tempRoot=path.join(root,'tests/tmp');fs.mkdirSync(tempRoot,{recursive:true});
const work=fs.mkdtempSync(path.join(tempRoot,'release-install-'));
const project=path.join(work,'project'),runtime=path.join(work,'runtime'),editor=path.join(work,'mock-editor.bin');
fs.mkdirSync(project);fs.writeFileSync(path.join(project,'fixture.fairy'),'{}');fs.writeFileSync(editor,'not launched');
const before=fs.readFileSync(path.join(project,'fixture.fairy'));
const python=process.env.FGUI_RELEASE_PYTHON||'python';
const args=[path.join(root,'setup.py'),'--project',project,'--editor',editor,'--runtime',runtime,'--port','18743'];
const install=spawnSync(python,args,{encoding:'utf8',windowsHide:true});
check(()=>assert.equal(install.status,0,install.stderr));
const installed=JSON.parse(install.stdout);
check(()=>assert.equal(installed.tokenPrinted,false));
check(()=>assert.equal(installed.projectModified,false));
const configFile=path.join(runtime,'config.json'),configBytes=fs.readFileSync(configFile),config=JSON.parse(configBytes);
check(()=>assert.match(config.token,/^[a-f0-9]{64}$/));
check(()=>assert(!install.stdout.includes(config.token)));
check(()=>assert.equal(config.projectPath,path.resolve(project)));
check(()=>assert.equal(config.port,18743));
check(()=>assert(path.isAbsolute(config.python)));
check(()=>assert.equal(fs.existsSync(path.join(project,'plugins')),false));
check(()=>assert.deepEqual(fs.readFileSync(path.join(project,'fixture.fairy')),before));
const second=spawnSync(python,args,{encoding:'utf8',windowsHide:true});
check(()=>assert.notEqual(second.status,0));
check(()=>assert.deepEqual(fs.readFileSync(configFile),configBytes));
check(()=>assert(!second.stdout.includes(config.token)&&!second.stderr.includes(config.token)));
console.log(JSON.stringify({passed:true,checks,files:entries.length,installProjectModified:false,repeatPreservedConfig:true,nativeEditorLaunched:false}));

