import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
const root=path.resolve(import.meta.dirname,'..');
const sharp=createRequire(path.join(root,'frontend/package.json'))('sharp');
const catalog=JSON.parse(await fs.readFile(path.join(root,'data/preferences/catalog.json'),'utf8'));
const output=path.join(root,'.runtime/verification/preferences-contact');await fs.mkdir(output,{recursive:true});
const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;');
for(let offset=0;offset<catalog.appearances.length;offset+=24){
 const entries=catalog.appearances.slice(offset,offset+24);const width=1200;const height=Math.ceil(entries.length/6)*300;const composite=[];
 for(const [i,a]of entries.entries()){
  const image=await sharp(path.join(root,a.thumbnail_url.slice(1))).resize({width:190,height:252,fit:'contain',background:'#20252b'}).png().toBuffer();
  composite.push({input:image,left:(i%6)*200+5,top:Math.floor(i/6)*300});
  const form=catalog.forms.find(f=>f.id===a.form_id);
  const label=Buffer.from(`<svg width="200" height="48"><style>text{font-family:sans-serif;font-size:12px;fill:white}</style><text x="4" y="17">${escape(form.name)}</text><text x="4" y="36">${escape(a.name)}</text></svg>`);
  composite.push({input:label,left:(i%6)*200,top:Math.floor(i/6)*300+252});
 }
 await sharp({create:{width,height,channels:3,background:'#20252b'}}).composite(composite).png().toFile(path.join(output,`sheet-${offset/24+1}.png`));
}
const icons=[];
for(const [i,p]of catalog.professions.entries())for(const [row,background]of ['#20252b','#f2f2f2'].entries()){
 const image=await sharp(path.join(root,p.icon_url.slice(1))).resize(100,100,{fit:'contain',background}).flatten({background}).png().toBuffer();
 icons.push({input:image,left:i*120+10,top:row*120+10});
}
await sharp({create:{width:960,height:240,channels:3,background:'#808080'}}).composite(icons).png().toFile(path.join(output,'professions.png'));
console.log(output);
