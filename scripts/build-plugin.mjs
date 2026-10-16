import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=new URL('../plugin/',import.meta.url);
const data=Buffer.concat(['header.js','upstream-handlers.js','coordination.js','controllers.js','relations.js','transitions.js','transport.js'].map(p=>fs.readFileSync(new URL(p,root))));
const output=new URL('main.js',root);
if(process.argv.includes('--check')){
  if(!data.equals(fs.readFileSync(output)))throw Error('plugin/main.js differs from source fragments');
  console.log('Plugin source parity passed');
}else {fs.writeFileSync(output,data);console.log(fileURLToPath(output));}
