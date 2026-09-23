import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const root=path.resolve(import.meta.dirname,'..'), sharp=createRequire(path.join(root,'frontend/package.json'))('sharp'),exec=promisify(execFile);
const read=async p=>JSON.parse(await fs.readFile(path.join(root,p),'utf8'));
const save=async(p,v)=>fs.writeFile(path.join(root,p),JSON.stringify(v,null,2)+'\n');
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
const selection=await read('data/preferences/npc-selection.json'), resources=await read('assets/resource-manifest.json');
const index=await read(`assets/local/${resources.version}/illustrations/index.json`);
const cache=path.join(root,'.runtime/preferences-originals/npc');await fs.mkdir(cache,{recursive:true});
await fs.mkdir(path.join(root,'assets/preferences/v2/npc'),{recursive:true});
const files=[],sources=[];let cursor=0;
async function prepare(p){
 if(index.people[p.id]?.base && !p.force_independent_art){p.representative_url=index.people[p.id].base.src;return;}
 const image=new URL(p.portrait_source.imageUrl);const parts=image.pathname.split('/');
 if(parts[1]==='thumb')image.pathname='/'+parts.slice(2,-1).join('/');image.search='';
 const original=path.join(cache,p.id+'.png');
 try{await fs.access(original);}catch{await exec('curl',['--fail','--silent','--show-error','--location','--proto','=https','--proto-redir','=https','--retry','4','--retry-all-errors','--max-time','120','--output',original+'.part',image.href]);await fs.rename(original+'.part',original);}
 const raw=await fs.readFile(original);const full=await sharp(raw).trim({threshold:8}).resize({width:1200,height:1400,fit:'inside',withoutEnlargement:true}).webp({quality:88,alphaQuality:95}).toBuffer({resolveWithObject:true});
 const file=`v2/npc/${p.id}.webp`;await fs.writeFile(path.join(root,'assets/preferences',file),full.data);
 files.push({path:file,sha256:sha(full.data),bytes:full.data.length,width:full.info.width,height:full.info.height});
 p.representative_url=`/assets/preferences/${file}`;
 sources.push({person_id:p.id,source_url:image.href,file_page_url:p.portrait_source.filePageUrl,source_sha256:sha(raw),source_bytes:raw.length,transform:'trim8-max1200x1400-webp88',rights_status:'unreviewed'});
 console.log(p.name);
}
await Promise.all(Array.from({length:4},async()=>{while(cursor<selection.persons.length)await prepare(selection.persons[cursor++]);}));
await save('data/preferences/npc-selection.json',selection);
await save('data/preferences/npc-artwork.json',{version:2,files:files.sort((a,b)=>a.path.localeCompare(b.path)),sources:sources.sort((a,b)=>a.person_id.localeCompare(b.person_id)),retained_resource_version:resources.version});
console.log(JSON.stringify({persons:selection.persons.length,new_files:files.length}));
