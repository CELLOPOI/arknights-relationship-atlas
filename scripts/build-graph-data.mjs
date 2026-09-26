import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { applyIdentityCorrections } from './identity-corrections.mjs';
export async function build(source, output) {
  const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
  const { missingFactionOverrides } = read(new URL('./faction-overrides.json', import.meta.url));
  const workspace = path.dirname(source);
  const review = path.join(source, '第三步核查');
  const rows = read(path.join(review, '全部结果.json'));
  const mapping = read(path.join(review, '最终人物对映射.json'));
  const judgments = new Map(read(path.join(review, '人工判定/当前有效判定.json')).map(r => [r.key, r]));
  const { createIdentity } = await import(pathToFileURL(path.join(source, 'scripts/candidates/identity.mjs')));
  const identity = createIdentity(workspace);
  const groups = read(path.join(review, '身份补查/审读身份对应.json')).groups;
  const reviewIds = new Map(groups.flatMap(g => g.ids.map(id => [id, g.canonical])));
  const canonical = id => reviewIds.get(identity.canonical(id)) || identity.canonical(id);
  const teams = read(path.join(workspace, 'ArknightsGameData/zh_CN/gamedata/excel/handbook_team_table.json'));
  const aliases = new Map();
  const addAlias = (id, alias) => { id = canonical(id); if (!aliases.has(id)) aliases.set(id, new Set()); if (alias?.trim()) aliases.get(id).add(alias.trim()); };
  for (const [alias, ids] of identity.aliases) for (const id of ids) addAlias(id, alias);
  for (const p of identity.people.values()) for (const id of p.forms) { addAlias(p.id, identity.chars[id]?.name); addAlias(p.id, identity.chars[id]?.appellation); }
  const supplement = path.join(review, '补充称呼.json');
  if (fs.existsSync(supplement)) for (const r of read(supplement)) addAlias(r.personId, r.term);
  const nodeNames = new Map();
  const rowByPair = new Map(rows.map(r => [[r.干员A,r.干员B].sort().join('|'),r]));
  for (const g of mapping.groups) g.canonicalKey.split('|').forEach((id,i) => { nodeNames.set(id,g.people[i]); addAlias(id,g.people[i]); });
  const factionMap = new Map();
  const nodes = [...nodeNames].map(([id,name]) => {
    const c = identity.chars[id]; assert.ok(c, `Missing character ${id}`);
    let factionId = c.nationId || c.groupId || c.teamId || 'unknown';
    if (factionId === 'unknown') factionId = missingFactionOverrides[id] || factionId;
    if (factionId === 'lungmen') factionId = 'yan';
    const factionName = factionId === 'unknown' ? '未归属' : teams[factionId]?.powerName;
    assert.ok(factionName, `Missing faction label ${factionId}`);
    factionMap.set(factionId,{id:factionId,name:factionName,order:teams[factionId]?.orderNum ?? 999});
    const groupId = c.groupId || c.teamId;
    return {id,name,aliases:[...aliases.get(id)].sort(),factionId,factionName,...(groupId ? {groupId,groupName:teams[groupId]?.powerName || groupId}: {})};
  }).sort((a,b)=>a.id.localeCompare(b.id));
  const nodeMap = new Map(nodes.map(n=>[n.id,n]));
  const compact = s => s.replace(/[（(][^）)]*[）)]/g,'').replace(/\s/g,'');
  function direction(note, a, b) {
    const text = compact(note); const matches = new Set();
    for (let i=0;i<text.length;i++) if(text[i]==='→') {
      const left=text.slice(0,i),right=text.slice(i+1);
      const ends = [a,b].flatMap(id=>nodeMap.get(id).aliases.map(alias=>({id,alias:compact(alias)}))).filter(x=>x.alias);
      const before=ends.filter(x=>left.endsWith(x.alias)).sort((x,y)=>y.alias.length-x.alias.length);
      const after=ends.filter(x=>right.startsWith(x.alias)).sort((x,y)=>y.alias.length-x.alias.length);
      if(before.length&&after.length&&before[0].id!==after[0].id) matches.add(before[0].id+'|'+after[0].id);
    }
    assert.equal(matches.size,1,`Ambiguous/missing direction ${nodeMap.get(a).name} / ${nodeMap.get(b).name}: ${note}`);
    const [from,to]=[...matches][0].split('|'); return {from,to};
  }
  const edges=[];const evidence={};
  for (const g of mapping.groups) {
    const row=rowByPair.get([...g.people].sort().join('|')); assert.ok(row,`Missing final row ${g.canonicalKey}`);
    if(!['确认相识','单向知晓'].includes(row.判定)) continue;
    const [source,target]=g.canonicalKey.split('|');
    const kind=row.判定==='确认相识'?'mutual':'awareness';
    edges.push({id:g.canonicalKey,source,target,kind,...(kind==='awareness'?direction(row.备注,source,target):{}),stableKeys:g.stableKeys});
    const sources=[];const seen=new Set();
    for(const key of g.stableKeys) { const j=judgments.get(key);assert.ok(j,`Missing judgment ${key}`);for(const e of j.evidence||[]) { const s={kind:e.kind,source:e.source,...(e.line!=null?{line:e.line}:{}),...(e.endLine!=null?{endLine:e.endLine}:{})};const sig=JSON.stringify(s);if(!seen.has(sig)){sources.push(s);seen.add(sig);} } }
    evidence[g.canonicalKey]={quote:row.关键原文,note:row.备注,sources};
  }
  const graph={nodes,edges,factions:[...factionMap.values()].sort((a,b)=>a.order-b.order)};
  assert.equal(nodes.length,396);assert.equal(edges.length,3695);assert.equal(edges.filter(e=>e.kind==='awareness').length,901);
  const corrected=applyIdentityCorrections(graph,evidence);
  fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'graph.json'),JSON.stringify(corrected.graph));fs.writeFileSync(path.join(output,'evidence.json'),JSON.stringify(corrected.evidence));
  fs.writeFileSync(path.join(output,'identity-corrections.json'),JSON.stringify(corrected.corrections,null,2)+'\n');
  console.log(JSON.stringify({nodes:nodes.length,edges:corrected.graph.edges.length,awareness:901,identityCorrections:corrected.corrections.length,factions:graph.factions.map(f=>({...f,count:nodes.filter(n=>n.factionId===f.id).length})),identityPeople:identity.people.size},null,2));
  return {graph:corrected.graph,evidence:corrected.evidence};
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){const args=process.argv.slice(2);const arg=name=>args[args.indexOf(name)+1];assert.ok(args.includes('--source')&&args.includes('--output'),'Usage: node build-graph-data.mjs --source <pilot-directory> --output <directory>');await build(path.resolve(arg('--source')),path.resolve(arg('--output')));}
