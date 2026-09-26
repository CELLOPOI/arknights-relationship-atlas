import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

// 仅修正上游候选包；正式库仍须走资料修订。决定见 docs/STORY_IDENTITIES.md。
export const identityCorrections=JSON.parse(fs.readFileSync(new URL('../data/corrections/story-identities-20260926.json',import.meta.url),'utf8'));
function sorted(value){
  return Array.isArray(value)?value.map(sorted):value&&typeof value==='object'
    ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])])):value;
}
export const identityDigest=value=>crypto.createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');

export function applyIdentityCorrections(graph,evidence){
  const result={graph:structuredClone(graph),evidence:structuredClone(evidence),corrections:[]};
  for(const correction of identityCorrections.corrections){
    const id=correction.relationshipId, edge=result.graph.edges.find(e=>e.id===id);
    if(!edge){assert.ok(!result.evidence[id],`Orphan identity evidence: ${id}`);continue;}
    if(correction.action==='replace_evidence'&&identityDigest(result.evidence[id])===identityDigest(correction.replacement))continue;
    assert.equal(identityDigest({edge,evidence:result.evidence[id]}),correction.expectedDigest,
      `Identity correction input changed; review current evidence before applying: ${id}`);
    if(correction.action==='withdraw'){
      result.graph.edges=result.graph.edges.filter(e=>e.id!==id);
      delete result.evidence[id];
    }else{
      assert.equal(correction.action,'replace_evidence');
      result.evidence[id]=structuredClone(correction.replacement);
    }
    result.corrections.push({id,action:correction.action,reason:correction.reason});
  }
  const people=new Set(result.graph.nodes.map(node=>node.id));
  for(const addition of identityCorrections.additions){
    const {edge,evidence:quote}=addition;
    // 干员子集不含 NPC；完整图生成后再补入双方均在场的人物对。
    if(!people.has(edge.source)||!people.has(edge.target))continue;
    const existing=result.graph.edges.find(value=>value.id===edge.id);
    if(existing){
      assert.deepEqual(existing,edge,`Added relationship changed; review again: ${edge.id}`);
      assert.deepEqual(result.evidence[edge.id],quote,`Added evidence changed; review again: ${edge.id}`);
      continue;
    }
    assert.ok(!result.evidence[edge.id],`Orphan added evidence: ${edge.id}`);
    result.graph.edges.push(structuredClone(edge));
    result.evidence[edge.id]=structuredClone(quote);
    result.corrections.push({id:edge.id,action:'add',reason:addition.reason});
  }
  return result;
}
