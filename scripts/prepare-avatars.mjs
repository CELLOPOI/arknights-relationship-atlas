import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const [input,output,sharpModule]=process.argv.slice(2);
if(!input||!output||!sharpModule)throw new Error('Usage: node prepare-avatars.mjs INPUT OUTPUT SHARP_MODULE');
const sharp=require(path.resolve(sharpModule));
fs.mkdirSync(output,{recursive:true});
const files=fs.readdirSync(input).filter(f=>f.endsWith('.png'));const records=[];
for(const file of files){const from=path.join(input,file),name=file.replace(/\.png$/,'.webp'),to=path.join(output,name);await sharp(from).webp({quality:86,effort:5}).toFile(to);const bytes=fs.readFileSync(to);records.push({id:file.slice(0,-4),file:name,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});}
console.log(JSON.stringify({count:records.length,bytes:records.reduce((s,r)=>s+r.bytes,0)}));
fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify(records,null,2));
