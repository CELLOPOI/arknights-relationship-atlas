import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const args=process.argv.slice(2);const arg=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
const directory=arg('--data',path.dirname(new URL(import.meta.url).pathname));
const source=arg('--source',path.resolve(import.meta.dirname,'../../ArknightsRelationshipPilot'));
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const {missingFactionOverrides}=read(new URL('./faction-overrides.json',import.meta.url));
const graph=read(path.join(directory,'graph.json')),evidence=read(path.join(directory,'evidence.json'));
const rows=read(path.join(source,'第三步核查/全部结果.json'));
const mapping=read(path.join(source,'第三步核查/最终人物对映射.json'));
const judgments=new Map(read(path.join(source,'第三步核查/人工判定/当前有效判定.json')).map(r=>[r.key,r]));
const nodeMap=new Map(graph.nodes.map(n=>[n.id,n]));
assert.equal(nodeMap.size,396);assert.equal(graph.edges.length,3695);assert.equal(new Set(graph.edges.map(e=>e.id)).size,3695);
assert.equal(graph.edges.filter(e=>e.kind==='mutual').length,2794);assert.equal(graph.edges.filter(e=>e.kind==='awareness').length,901);
const expected=new Map();
for(const g of mapping.groups){const r=rows.find(r=>g.people.includes(r.干员A)&&g.people.includes(r.干员B));if(['确认相识','单向知晓'].includes(r.判定))expected.set(g.canonicalKey,{g,r});}
for(const e of graph.edges){
  assert.ok(nodeMap.has(e.source)&&nodeMap.has(e.target));assert.notEqual(e.source,e.target);
  const {g,r}=expected.get(e.id);assert.equal(e.kind,r.判定==='确认相识'?'mutual':'awareness');assert.deepEqual(e.stableKeys,g.stableKeys);
  if(e.kind==='awareness'){assert.ok([e.source,e.target].includes(e.from)&&[e.source,e.target].includes(e.to));assert.notEqual(e.from,e.to);}else{assert.equal(e.from,undefined);assert.equal(e.to,undefined);}
  assert.deepEqual(Object.keys(evidence[e.id]).sort(),['note','quote','sources']);assert.equal(evidence[e.id].quote,r.关键原文);assert.equal(evidence[e.id].note,r.备注);
  for(const s of evidence[e.id].sources){assert.ok(e.stableKeys.some(k=>judgments.get(k).evidence.some(v=>v.kind===s.kind&&v.source===s.source&&v.line===s.line&&v.endLine===s.endLine)));assert.ok(Object.keys(s).every(k=>['kind','source','line','endLine'].includes(k)));}
}
function edge(a,b){return graph.edges.find(e=>[nodeMap.get(e.source).name,nodeMap.get(e.target).name].includes(a)&&[nodeMap.get(e.source).name,nodeMap.get(e.target).name].includes(b));}
// 对有空白、身份别名、括号和常见反向排序的实际数据做独立语义回归。
for(const [from,to] of [['杰西卡','12F'],['阿兰娜','电弧'],['澄闪','阿米娅'],['机械师','艾雅法拉'],['林','拜松'],['THRM-EX','古米'],['克洛丝','黍'],['森蚺','机械师']]){const e=edge(from,to);assert.equal(nodeMap.get(e.from).name,from);assert.equal(nodeMap.get(e.to).name,to);}
const isolated=graph.nodes.filter(n=>!graph.edges.some(e=>e.source===n.id||e.target===n.id));assert.deepEqual(isolated.map(n=>n.name),['云迹']);
const chars=read(path.join(path.dirname(source),'ArknightsGameData/zh_CN/gamedata/excel/character_table.json'));
for(const n of graph.nodes){const c=chars[n.id];const raw=c.nationId||c.groupId||c.teamId||'unknown';const expected=raw==='unknown'?(missingFactionOverrides[n.id]||raw):raw==='lungmen'?'yan':raw;assert.equal(n.factionId,expected);assert.ok(graph.factions.some(f=>f.id===n.factionId&&f.name===n.factionName));assert.ok(n.aliases.includes(n.name));}
assert.ok(!graph.factions.some(f=>f.id==='lungmen'));assert.equal(Object.keys(evidence).length,3695);
console.log('PASS: 396 nodes, 3695 valid edges, 901 directed awareness records; all final text and provenance preserved; canonical IDs, faction attribution, 8 direction regressions, isolated 云迹, and feedback exclusion verified.');
