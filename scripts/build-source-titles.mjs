import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clean = value => value.replace(/<[^>]*>/g, '').trim();
const join = (...parts) => parts.filter(Boolean).map(clean).join(' · ');
export const normalizeStory = value => value.replace(/^ArknightsGameData\/zh_CN\/gamedata\/story\//, '')
  .replace(/^zh_CN\/gamedata\/story\//, '').replace(/\.txt$/i, '').toLowerCase();

// 名称仅作为读取时的辅助索引；正式证据及发布摘要保持原样。见 docs/SOURCE_TITLES.md。
export function buildSourceTitles(gameRoot, sourceRoot, supplements) {
  const hashes = {};
  const read = relative => {
    const bytes = fs.readFileSync(path.join(gameRoot, relative));
    hashes[relative] = createHash('sha256').update(bytes).digest('hex');
    return JSON.parse(bytes);
  };
  const table = name => read(`zh_CN/gamedata/excel/${name}.json`);
  const review = table('story_review_table');
  const meta = table('story_review_meta_table');
  const handbook = table('handbook_info_table').handbookDict;
  const characters = table('character_table');
  const words = table('charword_table');
  const modules = table('uniequip_table').equipDict;
  const skins = table('skin_table').charSkins;
  const items = table('item_table').items;
  const activity = table('activity_table');
  const rogue = table('roguelike_topic_table');
  const sandbox = table('sandbox_perm_table');
  const zones = table('zone_table');
  const stages = Object.values(table('stage_table').stages);
  const index = new Map();
  const add = (source, title, basis, extra = {}) => {
    if (!source) return;
    const key = `story:${normalizeStory(source)}`;
    const entry = { title: clean(title), basis: Array.isArray(basis) ? basis : [basis], ...extra };
    const old = index.get(key);
    assert.ok(!old || old.title === entry.title, `Conflicting source title: ${source}`);
    index.set(key, entry);
  };
  const owners = new Map();
  for (const [id, entry] of Object.entries(handbook)) {
    for (const set of entry.handbookAvgList || []) owners.set(set.storySetId, characters[id]?.name);
  }
  for (const group of Object.values(review)) {
    for (const story of group.infoUnlockDatas) {
      const owner = owners.get(group.id);
      const title = owner
        ? join(owner, `干员密录《${group.name}》`, group.infoUnlockDatas.length > 1 ? story.storyName : '')
        : join(`《${group.name}》`, story.storyCode, story.storyName, story.avgTag);
      const basis = `story_review_table.json#${group.id}/${story.storyId}`;
      add(story.storyTxt, title, basis);
      if (story.storyInfo) add(story.storyInfo.replace(/^info\//, '[uc]info/'), join(title, '剧情梗概'), basis);
    }
  }
  for (const [id, entry] of Object.entries(meta.actArchiveResData.avgs)) {
    const group = review[entry.contentPath?.split('/')[1]];
    if (group && !index.has(`story:${normalizeStory(entry.contentPath)}`)) {
      add(entry.contentPath, join(`《${group.name}》`, '后记', entry.desc), `story_review_meta_table.json#actArchiveResData/avgs/${id}`);
    }
  }
  for (const [topicId, detail] of Object.entries(rogue.details)) {
    const topic = `《${rogue.topics[topicId].name}》`;
    for (const [id, end] of Object.entries(detail.archiveComp?.endbook?.endbook || {})) {
      const basis = `roguelike_topic_table.json#details/${topicId}/archiveComp/endbook/endbook/${id}`;
      add(end.avgId, join(topic, '结局', end.title), basis);
      for (const item of end.clientEndbookItemDatas || []) {
        add(item.textId, join(topic, end.title, item.endbookName), basis);
      }
    }
    for (const [id, chat] of Object.entries(detail.archiveComp?.chat?.chat || {})) {
      const squad = Object.values(detail.monthSquad || {}).find(squad => squad.chatId === id);
      if (!squad) continue;
      chat.chatItemList.forEach((item, i) => add(item.chatStoryId,
        join(topic, `月度故事《${squad.teamName}》`, `第 ${i + 1} 段`),
        [`roguelike_topic_table.json#details/${topicId}/monthSquad/${squad.id}`,
          `roguelike_topic_table.json#details/${topicId}/archiveComp/chat/chat/${id}`]));
    }
  }
  for (const [template, topics] of Object.entries(sandbox.detail)) {
    for (const [topicId, detail] of Object.entries(topics)) {
      for (const [id, archive] of Object.entries(detail.archiveQuestData)) {
        for (const avg of archive.avgDataList || []) {
          add(avg.avgId, join(`《${sandbox.basicInfo[topicId].topicName}》`, avg.avgName),
            `sandbox_perm_table.json#detail/${template}/${topicId}/archiveQuestData/${id}`);
        }
      }
    }
  }
  // 主线前情回顾与关卡内教学分别从其配置入口追溯，不能由脚本编号猜关卡号。
  function walk(value, visit, trail = []) {
    if (!value || typeof value !== 'object') return;
    visit(value, trail);
    for (const [key, child] of Object.entries(value)) if (child && typeof child === 'object') walk(child, visit, [...trail, key]);
  }
  walk(zones, (value, trail) => {
    if (value.recapId) add(value.recapId, join(review[value.zoneId]?.name, value.buttonName || '前情提要'), `zone_table.json#${trail.join('/')}`);
  });
  const allStages = [...stages, ...Object.values(activity.actFunData.stages), ...Object.values(meta.trainingCampData.stageData)];
  const evidence = fs.readdirSync(path.join(sourceRoot, 'evidence')).sort()
    .map(file => JSON.parse(fs.readFileSync(path.join(sourceRoot, 'evidence', file))));
  const sources = evidence.flatMap(item => item.sources);
  const missingStories = new Set(sources.filter(s => s.kind === 'story' && !index.has(`story:${normalizeStory(s.source)}`))
    .map(s => normalizeStory(s.source)));
  const teaching = [...missingStories].filter(s => /\/tutorial\/|\/training\/|activities\/act54side\/level\//.test(s));
  for (const stage of allStages) {
    if (!stage.levelId) continue;
    const relative = `zh_CN/gamedata/levels/${stage.levelId.toLowerCase()}.json`;
    if (!fs.existsSync(path.join(gameRoot, relative))) continue;
    const bytes = fs.readFileSync(path.join(gameRoot, relative), 'utf8');
    const hits = teaching.filter(source => bytes.toLowerCase().includes(`"${source}"`));
    if (!hits.length) continue;
    hashes[relative] = createHash('sha256').update(bytes).digest('hex');
    let group = activity.basicInfo[stage.stageId?.split('_')[0]]?.name;
    if (stage.levelId.toLowerCase().includes('/legion/')) group = '保全派驻';
    if (stage.levelId.toLowerCase().includes('/main/')) group = '主线剧情';
    if (stage.code.startsWith('CH-')) group = '机制教学';
    for (const source of hits) {
      // 愚人节通用活动名由已核对的补充配置替换为具体活动名。
      const groupOverride = supplements.activityNames[source.split('/')[1]];
      add(source, join(groupOverride || group || '作战训练', stage.code, stage.name, '关卡内教学'),
        [relative, 'stage_table.json / story_review_meta_table.json / activity_table.json']);
    }
  }
  for (const entry of supplements.sandboxDialogs) {
    const { topicId, dialogId, questId } = entry;
    const template = sandbox.basicInfo[topicId].topicTemplate;
    const detail = sandbox.detail[template][topicId];
    const dialog = detail.dialogData[dialogId];
    const quest = detail.questData[questId];
    assert.ok(dialog && quest?.questTitle, `Invalid sandbox mapping: ${dialogId}`);
    const section = detail.questLineData[quest.questLine]?.questLineTitle;
    add(dialog.avgId, join(`《${sandbox.basicInfo[topicId].topicName}》`, section, quest.questTitle, entry.part),
      [`sandbox_perm_table.json#detail/${template}/${topicId}/dialogData/${dialogId}`,
        `sandbox_perm_table.json#detail/${template}/${topicId}/questData/${questId}`],
      { referenceUrl: `https://prts.wiki/w/${encodeURIComponent(sandbox.basicInfo[topicId].topicName + '/日志')}#${encodeURIComponent(quest.questTitle)}`, referenceLabel: 'PRTS 任务目录' });
  }
  for (const entry of supplements.stories) {
    assert.ok(fs.existsSync(path.join(gameRoot, 'zh_CN/gamedata/story', `${entry.source}.txt`)), `Missing story: ${entry.source}`);
    add(entry.source, entry.title, entry.basis, entry.referenceUrl ? { referenceUrl: entry.referenceUrl, referenceLabel: 'PRTS 剧情' } : {});
  }
  for (const entry of supplements.prtsPages) {
    const found = index.get(`story:${entry.source}`);
    if (found) Object.assign(found, { referenceUrl: `https://prts.wiki/w/${encodeURIComponent(entry.page)}`, referenceLabel: 'PRTS 剧情' });
  }
  for (const entry of supplements.storyQualifiers) {
    const found = index.get(`story:${entry.source}`);
    assert.ok(found, `Unknown story qualifier: ${entry.source}`);
    found.title = join(found.title, entry.qualifier);
    found.basis.push(`https://prts.wiki/w/${encodeURIComponent(entry.page)}`);
    Object.assign(found, { referenceUrl: `https://prts.wiki/w/${encodeURIComponent(entry.page)}`, referenceLabel: 'PRTS 剧情' });
  }
  function profile(source) {
    const [id, kind, key, variant] = source.split('/');
    const name = characters[id]?.name;
    if (!name) return null;
    let title, basis, referenceUrl;
    if (kind === 'archive') {
      const section = handbook[id]?.storyTextAudio?.[Number(key)];
      if (section?.stories?.[Number(variant)]) title = join(name, section.storyTitle);
      basis = `handbook_info_table.json#handbookDict/${id}/storyTextAudio/${key}/stories/${variant}`;
    } else if (kind === 'voice' && words.charWords[key]?.charId === id) {
      title = join(name, `语音「${words.charWords[key].voiceTitle}」`);
      basis = `charword_table.json#charWords/${key}`;
    } else if (kind === 'voice' && words.charExtraWords[key]?.charId === id) {
      for (const [archiveId, archive] of Object.entries(activity.missionArchives)) {
        for (const node of archive.nodes) {
          const clip = node.clips.find(clip => `${clip.charId}_${clip.voiceId}` === key);
          if (clip) {
            title = join(review[archive.zones[0]]?.name, '尘封密室', `特蕾西娅的留言「${node.title}」`, `第 ${clip.index} 段`);
            basis = `activity_table.json#missionArchives/${archiveId}/${node.nodeId}`;
            referenceUrl = 'https://prts.wiki/w/' + encodeURIComponent('关卡一览/主题曲/尘封密室');
          }
        }
      }
    } else if (kind === 'module' && modules[key]?.charId === id) {
      title = join(name, `模组《${modules[key].uniEquipName}》`);
      basis = `uniequip_table.json#equipDict/${key}`;
    } else if (kind === 'skin' && skins[key]?.displaySkin?.[variant]) {
      title = join(name, `时装《${skins[key].displaySkin.skinName}》`, variant === 'description' ? '描述' : '介绍');
      basis = `skin_table.json#charSkins/${key}/displaySkin/${variant}`;
    } else if (kind === 'token' && items[key]) {
      title = join(name, items[key].name);
      basis = `item_table.json#items/${key}`;
    } else if (kind === 'record-summary') {
      const set = handbook[id]?.handbookAvgList?.find(set => set.avgList.some(avg => avg.storyId === key));
      if (set) {
        title = join(name, `干员密录《${set.storySetName}》`, '简介');
        basis = `handbook_info_table.json#handbookDict/${id}/handbookAvgList/${set.storySetId}`;
      }
    }
    return title ? { title, basis: [basis], ...(referenceUrl ? { referenceUrl, referenceLabel: 'PRTS 留言记录' } : {}) } : null;
  }
  const entries = {};
  const stats = {};
  const unresolved = new Set();
  for (const source of sources) {
    stats[source.kind] ??= { total: 0, named: 0 };
    stats[source.kind].total++;
    const key = `${source.kind}:${source.kind === 'story' ? normalizeStory(source.source) : source.source}`;
    let entry = source.kind === 'story' ? index.get(key) : source.kind === 'profile' ? profile(source.source) : null;
    if (source.kind === 'manual') entry = { title: '人工复核意见', basis: [source.source] };
    if (entry) {
      entries[key] = entry;
      stats[source.kind].named++;
    } else unresolved.add(key);
  }
  assert.equal(unresolved.size, 0, `Unresolved source titles:\n${[...unresolved].join('\n')}`);
  const sourceCommit = process.env.ARKNIGHTS_SOURCE_COMMIT
    || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gameRoot, encoding: 'utf8' }).trim();
  assert.equal(sourceCommit, supplements.sourceCommit, 'Re-review supplements before changing the game data version');
  return {
    schemaVersion: 1, sourceCommit, evidenceCount: evidence.length, stats,
    inputHashes: Object.fromEntries(Object.entries(hashes).sort()),
    entries: Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b, 'en'))),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [gameRoot, sourceRoot = path.join(root, 'data/source'), output = path.join(root, 'backend/atlas/data/source-titles.json')] = process.argv.slice(2);
  assert.ok(gameRoot, 'Usage: node scripts/build-source-titles.mjs <game-data> [source-snapshot] [output]');
  const supplements = JSON.parse(fs.readFileSync(path.join(root, 'scripts/source-title-supplements.json')));
  const catalog = buildSourceTitles(path.resolve(gameRoot), path.resolve(sourceRoot), supplements);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(catalog, null, 2) + '\n');
  console.log(JSON.stringify({ entries: Object.keys(catalog.entries).length, stats: catalog.stats, output }, null, 2));
}
