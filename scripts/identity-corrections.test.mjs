import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {applyIdentityCorrections,identityCorrections} from './identity-corrections.mjs';
const read=name=>JSON.parse(fs.readFileSync(new URL(`../data/npc/${name}.json`,import.meta.url),'utf8'));

test('withdraws eight wrong pairs, labels the manual decision and adds the chapter 13 encounter',()=>{
  const graph=read('graph'),evidence=read('evidence');
  const result=applyIdentityCorrections(graph,evidence);
  assert.equal(graph.edges.length,5711);
  assert.equal(result.graph.edges.length,5704);
  assert.deepEqual(result.graph.nodes,graph.nodes);
  assert.deepEqual(result.graph.factions,graph.factions);
  const changes=new Map(identityCorrections.corrections.map(c=>[c.relationshipId,c]));
  for(const edge of graph.edges){
    const change=changes.get(edge.id),after=result.graph.edges.find(e=>e.id===edge.id);
    if(change?.action==='withdraw'){
      assert.equal(after,undefined);assert.equal(result.evidence[edge.id],undefined);
    }else{
      assert.deepEqual(after,edge);
      assert.deepEqual(result.evidence[edge.id],change?.replacement||evidence[edge.id]);
    }
  }
  assert.ok(result.graph.edges.some(e=>e.id==='char_113_cqbw|npc_b99957887950ebfd'));
  const retained=result.evidence['char_003_kalts|char_4125_rdoc'];
  assert.match(retained.quote,/人工裁定，非剧情原文/);
  assert.ok(retained.sources.every(s=>s.kind==='manual'));
  const added='char_450_necras|npc_69395c50206899b0';
  assert.equal(result.graph.edges.find(edge=>edge.id===added).kind,'mutual');
  assert.match(result.evidence[added].quote,/爱布拉娜：塔露拉·雅特利亚斯/);
  assert.match(result.evidence[added].quote,/塔露拉：我们毫无瓜葛，深池的德拉克/);
  const again=applyIdentityCorrections(result.graph,result.evidence);
  assert.deepEqual(again.graph,result.graph);assert.deepEqual(again.evidence,result.evidence);
});
test('an independently added or edited chapter 13 relationship requires review',()=>{
  const graph=read('graph'),evidence=read('evidence');
  const addition=identityCorrections.additions[0];
  graph.edges.push({...addition.edge,kind:'awareness',from:addition.edge.source,to:addition.edge.target});
  evidence[addition.edge.id]=addition.evidence;
  assert.throws(()=>applyIdentityCorrections(graph,evidence),/relationship changed/);
});
test('new or changed evidence requires fresh review instead of an obsolete withdrawal',()=>{
  const graph=read('graph'),evidence=read('evidence');
  evidence['char_113_cqbw|char_4125_rdoc'].quote+=' New independent evidence.';
  assert.throws(()=>applyIdentityCorrections(graph,evidence),/input changed/);
  assert.equal(graph.edges.length,5711);
});
