/** @typedef {import('../types').AtlasData} AtlasData */

/** 在建立邻接表前拒绝损坏输入，不静默丢关系或改写方向。
 * @param {unknown} input
 * @returns {AtlasData}
 */
export function validateAtlasData(input) {
  if (!input || !Array.isArray(input.nodes) || !Array.isArray(input.edges) || !Array.isArray(input.factions)) throw new Error('Invalid atlas data');
  const people = new Set(), edges = new Set(), factions = new Set();
  for (const faction of input.factions) {
    if (!faction || typeof faction.id !== 'string' || !faction.id || typeof faction.name !== 'string' || factions.has(faction.id)) throw new Error('Invalid or duplicate faction');
    factions.add(faction.id);
  }
  for (const node of input.nodes) {
    if (!node || typeof node.id !== 'string' || !node.id || typeof node.name !== 'string' || !Array.isArray(node.aliases) || !node.aliases.every(alias => typeof alias === 'string') || typeof node.factionName !== 'string' || !factions.has(node.factionId) || people.has(node.id)) throw new Error('Invalid or duplicate person');
    people.add(node.id);
  }
  for (const edge of input.edges) {
    if (!edge || typeof edge.id !== 'string' || !edge.id || edges.has(edge.id) || !people.has(edge.source) || !people.has(edge.target) || edge.source === edge.target || !['mutual', 'awareness'].includes(edge.kind)) throw new Error('Invalid relationship');
    edges.add(edge.id);
  }
  return input;
}
