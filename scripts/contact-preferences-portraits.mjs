import fs from 'node:fs/promises';import path from 'node:path';import {createRequire} from 'node:module';
const root=path.resolve(import.meta.dirname,'..'),sharp=createRequire(path.join(root,'frontend/package.json'))('sharp');
const catalog=JSON.parse(await fs.readFile(path.join(root,'data/preferences/catalog.json'),'utf8'));
const focus=JSON.parse(await fs.readFile(path.join(root,'data/preferences/portrait-focus.json'),'utf8'));
const out=path.join(root,'.runtime/verification/preferences-portraits');await fs.mkdir(out,{recursive:true});
const entries=[...catalog.appearances].sort((a,b)=>Number(Boolean(focus.portraits[a.id].face_candidates.length))-Number(Boolean(focus.portraits[b.id].face_candidates.length))||a.id.localeCompare(b.id));
const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;');
await fs.writeFile(path.join(out,'index.json'),JSON.stringify(entries.map((a,i)=>({number:i+1,id:a.id,form:catalog.forms.find(f=>f.id===a.form_id).name,name:a.name,face_candidates:focus.portraits[a.id].face_candidates})),null,2));
const subset=process.argv.includes('--only')?new Set(process.argv[process.argv.indexOf('--only')+1].split(',').map(Number)):null;
for(let offset=0;offset<entries.length;offset+=64){const page=offset/64+1;if(subset&&!subset.has(page))continue;const items=entries.slice(offset,offset+64),composite=[];
 for(const[i,a]of items.entries()){
  const im=await sharp(path.join(root,a.portrait_url.slice(1))).resize(176,260,{fit:'fill'}).flatten({background:'#13191f'}).png().toBuffer();
  composite.push({input:im,left:i%8*180+2,top:Math.floor(i/8)*292});
  const form=catalog.forms.find(f=>f.id===a.form_id);
  composite.push({input:Buffer.from(`<svg width="180" height="32"><style>text{font-family:sans-serif;font-size:11px;fill:#f0f0f0}</style><text x="3" y="12">${offset+i+1} ${escape(form.name)} ${escape(a.name).slice(0,9)}</text><text x="3" y="27">${escape(a.id)}</text></svg>`),left:i%8*180,top:Math.floor(i/8)*292+260});
 }
 await sharp({create:{width:1440,height:Math.ceil(items.length/8)*292,channels:3,background:'#13191f'}}).composite(composite).png().toFile(path.join(out,`page-${String(page).padStart(2,'0')}.png`));
}
console.log(out);
