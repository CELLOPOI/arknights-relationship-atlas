import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const root=path.resolve(import.meta.dirname,'..');
const read=async file=>JSON.parse(await fs.readFile(path.join(root,file),'utf8'));
const digest=data=>crypto.createHash('sha256').update(data).digest('hex');
const sharp=createRequire(path.join(root,'frontend/package.json'))('sharp');
const manifest=await read('assets/preferences-manifest.json');
const catalog=await read('data/preferences/catalog.json');
const metadata=await read('data/preferences/metadata.json');
const resources=await read('assets/resource-manifest.json');
const npcSelection=await read('data/preferences/npc-selection.json');
const npcCoverage=await read('data/preferences/npc-coverage.json');
const npcSources=new Map(npcSelection.persons.map(x=>[x.id,x]));
const coverage=await read('data/preferences/coverage.json');
const focus=await read('data/preferences/portrait-focus.json');
assert.equal(digest(await fs.readFile(path.join(root,'data/preferences/portrait-focus.json'))),manifest.portrait_focus_sha256);
assert.equal(catalog.forms.length,metadata.selected_form_ids.length);
assert.deepEqual(catalog.forms.map(x=>x.id).sort(),[...metadata.selected_form_ids].sort());
assert.equal(coverage.forms.length,catalog.forms.length);
assert.equal(npcCoverage.units.length,metadata.story_units.length);
assert.equal(catalog.asset_version,manifest.version);
assert.equal(digest(await fs.readFile(path.join(root,'data/preferences/catalog.json'))),manifest.catalog_sha256);
assert.equal(manifest.rights_status,'unreviewed');
assert.deepEqual(manifest.metadata_inputs,metadata.inputs);
const paths=[];
async function walk(dir,prefix=''){for(const item of await fs.readdir(dir,{withFileTypes:true})){assert.ok(!item.isSymbolicLink(),'No symlink assets');if(item.isDirectory())await walk(path.join(dir,item.name),`${prefix}${item.name}/`);else paths.push(`${prefix}${item.name}`);}}
await walk(path.join(root,'assets/preferences'));
assert.deepEqual(paths.sort(),manifest.files.map(x=>x.path).sort(),'Only fixed-manifest files may be used');
const unique=(entries,label)=>{assert.equal(new Set(entries.map(x=>x.id)).size,entries.length,`Duplicate ${label}`);return new Map(entries.map(x=>[x.id,x]));};
const persons=unique(catalog.persons,'person');const forms=unique(catalog.forms,'form');const appearances=unique(catalog.appearances,'appearance');const professions=unique(catalog.professions,'profession');
assert.deepEqual([...professions.keys()].sort(),['PIONEER','WARRIOR','TANK','SNIPER','CASTER','MEDIC','SUPPORT','SPECIAL'].sort());
const files=new Map(manifest.files.map(x=>[x.path,x]));
const resourceFiles=new Map(resources.files.map(x=>[x.path,x]));
function reference(url){assert.equal(typeof url,'string');const pathname=url.split('?')[0];assert.ok(!pathname.includes('..'));if(pathname.startsWith('/assets/preferences/'))assert.ok(files.has(pathname.slice('/assets/preferences/'.length)),`Missing ${url}`);else assert.ok(resourceFiles.has(pathname.slice(1)),`Missing existing ${url}`);}
for(const file of manifest.files){assert.ok(!file.path.startsWith('/')&&!file.path.includes('..'));const raw=await fs.readFile(path.join(root,'assets/preferences',file.path));assert.equal(raw.length,file.bytes);assert.equal(digest(raw),file.sha256,file.path);const info=await sharp(raw).metadata();assert.equal(info.width,file.width);assert.equal(info.height,file.height);if(!file.path.startsWith('v2/portrait/')&&!file.path.startsWith('v2/npc/'))assert.ok(info.hasAlpha,`Alpha ${file.path}`);await sharp(raw).raw().toBuffer();}
for(const p of persons.values()){reference(p.representative_url);for(const id of p.form_ids)assert.equal(forms.get(id)?.person_id,p.id);assert.ok(p.kind==='operator'||p.selection_reason);if(p.kind==='npc'){const reviewed=npcSources.get(p.id);assert.ok(reviewed?.review?.image_review,`Unreviewed NPC ${p.id}`);assert.ok(reviewed.story_units?.length,`No story evidence ${p.id}`);assert.equal(reviewed.representative_url,p.representative_url);}}
for(const f of forms.values()){
 assert.ok(persons.has(f.person_id));assert.ok(professions.has(f.profession));assert.ok(persons.get(f.person_id).form_ids.includes(f.id));
 if(!f.complete){assert.equal(f.appearance_ids.length,0);reference(f.representative_url);continue;}
 assert.ok(f.appearance_ids.includes(f.default_appearance_id));
 const expected=coverage.forms.find(x=>x.form_id===f.id);assert.ok(expected);assert.equal(expected.missing.length,0);assert.equal(expected.status,'complete');
 const patch=Object.values(metadata.patch).find(x=>x[f.id])?.[f.id];
 const stageIds=[...new Set(Object.values(metadata.evolve[f.id]||{'2':patch}))];
 const metadataIds=new Set(stageIds),illustrations=new Set(stageIds.map(id=>metadata.skins[id].illust_id));
 for(const skin of Object.values(metadata.skins).filter(x=>x.form_id===f.id&&x.name).sort((a,b)=>a.sort_id-b.sort_id))if(!illustrations.has(skin.illust_id)){metadataIds.add(skin.id);illustrations.add(skin.illust_id);}
 assert.deepEqual([...f.appearance_ids].sort(),[...metadataIds].sort(),`Metadata denominator mismatch ${f.id}`);
 assert.deepEqual(expected.actual.map(x=>x.id).sort(),[...metadataIds].sort(),`Actual resource inventory mismatch ${f.id}`);
 assert.deepEqual([...f.appearance_ids].sort(),expected.expected.map(x=>x.id).sort(),`Incomplete skin set ${f.id}`);
 for(const id of f.appearance_ids)assert.equal(appearances.get(id)?.form_id,f.id);
}
for(const a of appearances.values()){const crop=focus.portraits[a.id];assert.ok(crop?.reviewed,`Unreviewed portrait ${a.id}`);assert.equal(crop.source_sha256,files.get(a.image_url.replace('/assets/preferences/','')).sha256);assert.equal(crop.portrait_sha256,files.get(crop.portrait_url.replace('/assets/preferences/','')).sha256);assert.deepEqual(a.focus.crop,crop.crop);assert.ok(crop.crop.every(Number.isFinite)&&crop.crop[2]>0&&crop.crop[3]>0);reference(a.portrait_url);assert.ok(forms.get(a.form_id)?.appearance_ids.includes(a.id));assert.equal(a.rights_status,'unreviewed');assert.match(a.source_blob_sha1,/^[a-f0-9]{40}$/);assert.match(a.source_sha256,/^[a-f0-9]{64}$/);assert.ok(a.source_url.includes(manifest.source.commit));reference(a.image_url);reference(a.thumbnail_url);assert.equal(metadata.skins[a.id].form_id,a.form_id);if(a.kind==='outfit')assert.ok(metadata.skins[a.id].get_time<=Date.parse(`${catalog.coverage.metadata_date}T23:59:59+08:00`)/1000,`Unreleased outfit ${a.id}`);}
for(const p of professions.values())reference(p.icon_url);
assert.equal(forms.get('char_1001_amiya2').profession,'WARRIOR');assert.equal(forms.get('char_1037_amiya3').profession,'MEDIC');assert.equal(forms.get('char_1001_amiya2').person_id,'char_002_amiya');
assert.ok([...forms.values()].some(f=>f.complete&&f.appearance_ids.length===1));
assert.ok([...forms.values()].some(f=>f.complete&&f.appearance_ids.length===2&&f.appearance_ids.every(id=>appearances.get(id).kind!=='outfit')));
assert.ok([...forms.values()].some(f=>f.complete&&!f.appearance_ids.some(id=>appearances.get(id).kind==='elite')));
assert.equal(forms.get('char_1012_skadi2').person_id,'char_263_skadi');
assert.equal(new Set([...forms.values()].filter(f=>f.complete).map(f=>f.profession)).size,8);
for(const old of (await read('data/preferences/history/manifest-v1.json')).files)assert.equal(files.get(old.path)?.sha256,old.sha256,`Changed prior asset ${old.path}`);
console.log(JSON.stringify({verified:files.size,persons:persons.size,forms:forms.size,complete_forms:[...forms.values()].filter(f=>f.complete).length,appearances:appearances.size,bytes:manifest.files.reduce((n,x)=>n+x.bytes,0)}));
