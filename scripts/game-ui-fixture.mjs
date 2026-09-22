import fs from 'node:fs/promises';

// 浏览器验收只使用本地资料并拦截全部 API，不向运行中的业务库写入。
export const gameGraph = JSON.parse(await fs.readFile(new URL('../data/npc/graph.json', import.meta.url), 'utf8'));
const evidence = JSON.parse(await fs.readFile(new URL('../data/npc/evidence.json', import.meta.url), 'utf8'));
const peopleDirectory = new URL('../data/source/people/', import.meta.url);
const peopleRows = await Promise.all((await fs.readdir(peopleDirectory)).filter(file => file.endsWith('.json')).map(async file => JSON.parse(await fs.readFile(new URL(file, peopleDirectory), 'utf8'))));
const peopleMap = new Map(peopleRows.map(person => [person.id, person]));
gameGraph.nodes = gameGraph.nodes.map(person => ({ ...person, isOperator: peopleMap.get(person.id)?.is_operator !== false, avatar: `/avatars/${person.id}.webp` }));
const people = new Map(gameGraph.nodes.map(person => [person.id, person]));
const edges = new Map(gameGraph.edges.map(edge => [edge.id, edge]));

export async function installGameFixture(page) {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET') return route.fulfill({ status: 403, json: { detail: 'Writes are disabled in game verification.' } });
    if (url.pathname === '/api/session/') return route.fulfill({ json: { user: null, communityEnabled: false, registrationEnabled: false, feedbackEnabled: true } });
    if (url.pathname === '/api/graph/') {
      const scope = url.searchParams.get('scope') || 'operators';
      const nodes = gameGraph.nodes.filter(person => scope === 'all' || person.isOperator);
      const ids = new Set(nodes.map(person => person.id));
      return route.fulfill({ json: { ...gameGraph, nodes, edges: gameGraph.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)), scope } });
    }
    if (url.pathname.startsWith('/api/relationships/')) {
      const id = decodeURIComponent(url.pathname.split('/')[3]);
      const edge = edges.get(id);
      if (!edge) return route.fulfill({ status: 404, json: { detail: 'Relationship unavailable.' } });
      const record = evidence[id] || {};
      const pair = [people.get(edge.source), people.get(edge.target)];
      return route.fulfill({ json: { ...edge, ...record, title: pair.map(person => person.name).join('与'), people: pair,
        evidence: record.quote ? [{ id: 1, quote: record.quote, sources: record.sources || [] }] : [] } });
    }
    return route.fulfill({ status: 404, json: { detail: 'Unmocked API request.' } });
  });
}
