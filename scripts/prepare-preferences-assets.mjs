import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = path.resolve(import.meta.dirname, '..');
const sharp = createRequire(path.join(root, 'frontend/package.json'))('sharp');
const exec = promisify(execFile);
const read = async p => JSON.parse(await fs.readFile(path.join(root, p), 'utf8'));
const hash = (data, algorithm = 'sha256') => crypto.createHash(algorithm).update(data).digest('hex');
const blob = data => hash(Buffer.concat([Buffer.from(`blob ${data.length}\0`), data]), 'sha1');
const save = async (p, value) => fs.writeFile(path.join(root, p), JSON.stringify(value, null, 2) + '\n');
const source = { repository: 'fexli/ArknightsResource', commit: '230ae8586b4140645af68fe121e44d2676b56197', tree: '77748e9bd15bf7a166a2d360310ec031347da90c' };
const iconSource = { repository: 'Aceship/Arknight-Images', commit: '0b28f9562fcadbd644c6225f8f8aefbb500b4d22' };
const professions = [['PIONEER','先锋','vanguard'],['WARRIOR','近卫','guard'],['TANK','重装','defender'],['SNIPER','狙击','sniper'],['CASTER','术师','caster'],['MEDIC','医疗','medic'],['SUPPORT','辅助','supporter'],['SPECIAL','特种','specialist']].map(([id,name,file]) => ({id,name,file,icon_url:`/assets/preferences/professions/${id}.png`}));
const cache = path.join(root, '.runtime/preferences-originals');
await fs.mkdir(cache, {recursive:true});
for (const dir of ['full','thumb','professions']) await fs.mkdir(path.join(root, 'assets/preferences', dir), {recursive:true});
async function download(url, file) {
  await exec('curl', ['--fail','--silent','--show-error','--location','--connect-timeout','15','--max-time','120','--retry','5','--retry-all-errors','--http1.1','--proto','=https','--proto-redir','=https','--output',`${file}.part`,url]);
  await fs.rename(`${file}.part`,file);
}
async function cached(url, name) {
  const file = path.join(cache,name);
  try {return await fs.readFile(file);} catch(error) {if(error.code!=='ENOENT')throw error;}
  await download(url,file); return fs.readFile(file);
}
const metadata=await read('data/preferences/metadata.json');
assert.equal(metadata.version,2,'Prepare the full fixed metadata before assets');
const chosen=metadata.selected_form_ids;
const tree=await read('data/preferences/artwork-tree.json');
assert.equal(tree.sha,source.tree);assert.equal(tree.truncated,false);
const treeFiles=new Map(tree.tree.map(x=>[x.path,x]));
const resource=await read('assets/resource-manifest.json');
const index=await read(`assets/local/${resource.version}/illustrations/index.json`);
const previous=await read('data/preferences/history/catalog-v1.json');
const currentCatalog=await read('data/preferences/catalog.json').catch(()=>previous);
const versionIndex=process.argv.indexOf('--catalog-version');
const catalogVersion=versionIndex<0?'preferences-catalog-v2':process.argv[versionIndex+1];
assert.match(catalogVersion||'',/^[A-Za-z0-9_.-]+$/,'Provide a stable new catalog version');
const oldManifest=await read('data/preferences/history/manifest-v1.json');
const currentManifest=await read('assets/preferences-manifest.json').catch(()=>oldManifest);
const focus=await read('data/preferences/portrait-focus.json').catch(()=>({portraits:{}}));
const npcArtwork=await read('data/preferences/npc-artwork.json').catch(()=>({files:[],sources:[]}));
const persons=Object.values(metadata.identities).map(p=>({id:p.id,name:p.name,aliases:p.aliases,
  kind:'operator',eligible:true,representative_url:index.people[p.id]?.base?.src||'',form_ids:[]}));
// NPC 由独立的逐剧情审读清单维护；素材准备不从名字推定入选。
let npcReview;
try {npcReview=await read('data/preferences/npc-selection.json');} catch(error) {if(error.code!=='ENOENT')throw error;}
const selectedNpcs=npcReview?.persons||previous.persons.filter(p=>p.kind==='npc');
for(const npc of selectedNpcs)if(!persons.some(p=>p.id===npc.id))persons.push({id:npc.id,name:npc.name,aliases:npc.aliases||[],selection_reason:npc.selection_reason,form_ids:[],eligible:true,kind:'npc',representative_url:npc.representative_url||index.people[npc.id]?.base?.src||''});
const personMap=new Map(persons.map(x=>[x.id,x]));
const forms=[]; const appearances=[]; const files=[...new Map([...oldManifest.files,...currentManifest.files,...npcArtwork.files].map(f=>[f.path,f])).values()]; const sources=[];
for(const dir of ['full','thumb','portrait','npc'])await fs.mkdir(path.join(root,'assets/preferences/v2',dir),{recursive:true});
async function inventory(file,raw,details={}) {const row={path:file,bytes:raw.length,sha256:hash(raw),...details};const old=files.findIndex(x=>x.path===file);if(old>=0)files[old]=row;else files.push(row);await fs.writeFile(path.join(root,'assets/preferences',file),raw);}
async function artwork(skin,kind,form) {
  const stem=skin.illust_id.replace(/^illust_/,'').replaceAll('#','_');
  // 使用固定提交的完整 PNG，避免把带 b 的另一个构图未经核对地替换进来。
  const file=treeFiles.get(`${stem}.png`);assert.ok(file,`Missing full source ${stem}`);
  const url=`https://raw.githubusercontent.com/${source.repository}/${source.commit}/charpack/${encodeURIComponent(file.path)}`;
  const recordFile=path.join(cache,`v2-${skin.id.replaceAll('/','_')}.json`);
  try {const record=JSON.parse(await fs.readFile(recordFile,'utf8'));if(record.appearance.source_blob_sha1===file.sha){
    for(const item of record.files){const content=await fs.readFile(path.join(root,'assets/preferences',item.path));assert.equal(hash(content),item.sha256);const old=files.findIndex(f=>f.path===item.path);if(old<0)files.push(item);else files[old]=item;}
    appearances.push(record.appearance);sources.push(record.source);return;
  }}catch(error){if(error.code!=='ENOENT')throw error;}

  let raw;try{raw=await fs.readFile(path.join(root,'.runtime/game-art/originals',file.path));}catch{raw=await cached(url,file.path);}
  assert.equal(blob(raw),file.sha,`Source blob ${file.path}`);
  const {data,info}=await sharp(raw).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  let l=info.width,t=info.height,r=-1,b=-1;
  for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++)if(data[(y*info.width+x)*4+3]>8){l=Math.min(l,x);r=Math.max(r,x);t=Math.min(t,y);b=Math.max(b,y);}
  assert.ok(r>l&&b>t,`Empty ${skin.id}`);
  const trim={left:Math.max(0,l-2),top:Math.max(0,t-2),width:0,height:0};trim.width=Math.min(info.width-trim.left,r-trim.left+3);trim.height=Math.min(info.height-trim.top,b-trim.top+3);
  const id=skin.id;const filename=id.replaceAll('@','_').replaceAll('#','_').replaceAll('+','plus');
  const full=await sharp(raw).extract(trim).resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true}).webp({quality:86,alphaQuality:95}).toBuffer({resolveWithObject:true});
  const thumb=await sharp(full.data).resize({width:480,height:600,fit:'inside',withoutEnlargement:true}).webp({quality:80,alphaQuality:90}).toBuffer({resolveWithObject:true});
  await inventory(`v2/full/${filename}.webp`,full.data,{width:full.info.width,height:full.info.height});
  await inventory(`v2/thumb/${filename}.webp`,thumb.data,{width:thumb.info.width,height:thumb.info.height});
  const provenance={source_url:url,source_blob_sha1:file.sha,source_sha256:hash(raw),rights_status:'unreviewed',original_width:info.width,original_height:info.height,trim,focus:{x:0.5,y:0.35,method:'composition-center-default',reviewed:false},transform:'alpha-bounds-1600-webp86-thumb480x600-contain-v1'};
  sources.push({appearance_id:id,...provenance});
  appearances.push({id,form_id:form.id,name:skin.name||(kind==='elite'?'精英二':'基础立绘'),kind,image_url:`/assets/preferences/v2/full/${filename}.webp`,thumbnail_url:`/assets/preferences/v2/thumb/${filename}.webp`,eligible:true,width:full.info.width,height:full.info.height,...provenance});
  await fs.writeFile(recordFile,JSON.stringify({appearance:appearances.at(-1),source:sources.at(-1),files:files.filter(f=>f.path===`v2/full/${filename}.webp`||f.path===`v2/thumb/${filename}.webp`)}));
}
const coverage=[];
for(const [order,id]of chosen.entries()) {
  const c=metadata.characters[id];const personId=c.person_id;assert.ok(personMap.has(personId),`Missing person ${id}`);
  const evolve=metadata.evolve[id];const patch=Object.values(metadata.patch).find(x=>x[id])?.[id];
  const baseId=evolve?.['1']||evolve?.['0']||patch;assert.ok(baseId,`No base ${id}`);
  const expected=[];
  for(const [stage,sid]of Object.entries(evolve||{'2':patch})) {
    if(expected.some(x=>x.skin.id===sid))continue;
    assert.ok(metadata.skins[sid],`Missing stage metadata ${id}/${sid}`);
    expected.push({skin:metadata.skins[sid],kind:sid===baseId?'base':stage==='2'?'elite':'base',
      label:sid===baseId?'基础立绘':stage==='2'?'精英二':'初始立绘'});
  }
  for(const skin of Object.values(metadata.skins).filter(x=>x.form_id===id&&x.name).sort((a,b)=>a.sort_id-b.sort_id)) {
    assert.ok(skin.get_time&&skin.obtain_approach&&skin.get_time<=Date.parse(metadata.cutoff)/1000,`Unconfirmed outfit ${skin.id}`);
    if(!expected.some(x=>x.skin.illust_id===skin.illust_id))expected.push({skin,kind:'outfit',label:skin.name});
  }
  const missing=expected.filter(x=>!treeFiles.has(`${x.skin.illust_id.replace(/^illust_/,'').replaceAll('#','_')}.png`));
  const form={id,person_id:personId,name:id==='char_1001_amiya2'?'阿米娅 · 近卫':id==='char_1037_amiya3'?'阿米娅 · 医疗':c.name,profession:c.profession,order,default_appearance_id:baseId,
    catalog_version:`form-${hash(JSON.stringify(expected.map(x=>x.skin.id).sort())).slice(0,16)}`,eligible:true,complete:missing.length===0,appearance_ids:expected.map(x=>x.skin.id),availability:c.availability};
  // 集合没有变化的形态沿用旧确认版本，避免仅增大覆盖时要求所有人重确认。
  const old=currentCatalog.forms.find(x=>x.id===id)||previous.forms.find(x=>x.id===id);
  if(old?.complete&&JSON.stringify([...old.appearance_ids].sort())===JSON.stringify([...form.appearance_ids].sort()))form.catalog_version=old.catalog_version;
  forms.push(form);personMap.get(personId).form_ids.push(id);
  coverage.push({form_id:id,name:form.name,person_id:personId,identity_basis:c.identity_basis,
    expected:expected.map(x=>({id:x.skin.id,kind:x.kind,illust_id:x.skin.illust_id,ownership:'tmplId || charId; stage mappings',status:missing.includes(x)?'missing':'verified_source_blob'})),
    missing:missing.map(x=>x.skin.id),status:missing.length?'incomplete':'complete'});
  assert.equal(missing.length,0,`Missing full sources for ${id}: ${missing.map(x=>x.skin.id)}`);
  form.jobs=expected;
}
const jobs=forms.flatMap(form=>form.jobs.map(job=>({form,...job})));
let cursor=0,done=0;
await Promise.all(Array.from({length:6},async()=>{while(cursor<jobs.length){const {form,skin,kind,label}=jobs[cursor++];
  await artwork({...skin,name:skin.name||label},kind,form);done++;if(done%25===0)console.log(`Prepared ${done}/${jobs.length} appearances`);
}}));
for(const f of forms){delete f.jobs;const p=personMap.get(f.person_id);if(!p.representative_url)p.representative_url=appearances.find(a=>a.id===f.default_appearance_id).image_url;}
const rootTree=JSON.parse(await cached(`https://api.github.com/repos/${iconSource.repository}/git/trees/${iconSource.commit}`,'icon-root.json'));
const classes=rootTree.tree.find(x=>x.path==='classes');assert.ok(classes);
const classTree=JSON.parse(await cached(`https://api.github.com/repos/${iconSource.repository}/git/trees/${classes.sha}`,'icon-classes.json'));
for(const p of professions) {
 const file=`class_${p.file}.png`;const entry=classTree.tree.find(x=>x.path===file);assert.ok(entry);
 const url=`https://raw.githubusercontent.com/${iconSource.repository}/${iconSource.commit}/classes/${file}`;const raw=await cached(url,file);assert.equal(blob(raw),entry.sha);
 const info=await sharp(raw).metadata();assert.ok(info.hasAlpha);await inventory(`professions/${p.id}.png`,raw,{width:info.width,height:info.height,source_url:url,source_blob_sha1:entry.sha,rights_status:'unreviewed'});delete p.file;
}
for(const a of appearances){const p=focus.portraits[a.id];if(p?.source_sha256===files.find(f=>a.image_url==='/assets/preferences/'+f.path)?.sha256){a.portrait_url=p.portrait_url;a.focus={crop:p.crop,method:p.method,reviewed:p.reviewed};}}
files.sort((a,b)=>a.path.localeCompare(b.path));appearances.sort((a,b)=>a.id.localeCompare(b.id));
const assetVersion=`preferences-assets-${hash(JSON.stringify(files.map(x=>[x.path,x.sha256]))).slice(0,24)}`;
const npcCoverage=await read('data/preferences/npc-coverage.json');
for(const row of coverage)row.actual=appearances.filter(a=>a.form_id===row.form_id).map(a=>({id:a.id,image_url:a.image_url,thumbnail_url:a.thumbnail_url,portrait_url:a.portrait_url||null,source_url:a.source_url,source_blob_sha1:a.source_blob_sha1,source_sha256:a.source_sha256}));
const catalog={version:catalogVersion,asset_version:assetVersion,source_version:hash(JSON.stringify(metadata.inputs)),persons,forms,appearances,professions,coverage:{expected_forms:chosen.length,complete_forms:forms.filter(f=>f.complete).length,appearances:appearances.length,selected_npcs:persons.filter(p=>p.kind==='npc').map(p=>p.name),metadata_date:metadata.cutoff.slice(0,10),cutoff:metadata.cutoff,excluded_forms:metadata.excluded_forms,excluded_skins:metadata.excluded_skins,npc_unit_count:npcCoverage.unit_count,npc_covered_units:npcCoverage.covered_units,npc_count:selectedNpcs.length,portrait_reviewed:appearances.filter(a=>a.focus?.reviewed).length,note:'按固定国服元数据核对完整集合；未来获取记录单独排除；名录须独立审核发布。'},rights_status:'unreviewed'};
await save('data/preferences/catalog.json',catalog);
await save('data/preferences/coverage.json',{cutoff:metadata.cutoff,source:metadata.source,forms:coverage});
await save('assets/preferences-manifest.json',{version:assetVersion,rights_status:'unreviewed',source,icon_source:iconSource,metadata_inputs:metadata.inputs,files,sources,npc_sources:npcArtwork.sources,portrait_focus_sha256:hash(await fs.readFile(path.join(root,'data/preferences/portrait-focus.json'))),catalog_sha256:hash(await fs.readFile(path.join(root,'data/preferences/catalog.json')))});
console.log(JSON.stringify({persons:persons.length,forms:forms.length,complete_forms:chosen.length,appearances:appearances.length,files:files.length,asset_version:assetVersion}));
