// 跨章节身份识别：不接触数据库，便于真实语料与 mock 回归。
import crypto from 'node:crypto';
import { chatJson } from './llm.js';
import { IDENTITY_VERSION, IDENTITY_SYSTEM, CONSOLIDATE_SYSTEM } from './identity-prompts.js';

const forbidden = new Set(['旁白', '叙述者', '未知', '未知角色', '他', '她', '它', '我', '你', '他们', '她们', '众人', '男人', '女人', '男子', '女子', '年轻人', '警察', '医生', '那人']);
const cleanName = s => typeof s === 'string' ? s.trim().slice(0, 80) : '';
export function identityFingerprint(chapters, settings) {
  return crypto.createHash('sha256').update(JSON.stringify([IDENTITY_VERSION, settings.llm_model, chapters.map(c => [c.id, c.title, c.content])])).digest('hex');
}

/** 证据必须逐字来自章节；有歧义的同章别名不自动归属。 */
export function validateIdentities(raw, chapters) {
  if (!Array.isArray(raw?.characters)) throw new Error('角色考据结果缺少 characters 数组');
  const byId = new Map(chapters.map(c => [c.id, c]));
  const rejected = [], characters = [];
  const unresolvedNames = new Set((Array.isArray(raw.unresolved) ? raw.unresolved : []).filter(x => typeof x === 'string').map(x => x.trim()));
  for (const c of raw.characters) {
    const name = cleanName(c?.name);
    const baseName = name.replace(/[（(].*?[）)]/g, '').trim();
    if (!name || !baseName || forbidden.has(name) || Number(c.confidence) < 0.9 || Number(c.confidence) > 1 || !Number.isFinite(Number(c.confidence)) || !chapters.some(ch => ch.content.includes(baseName))) {
      rejected.push(`未自动采纳角色：${name || '无名'}（姓名或置信度未通过校验）`); continue;
    }
    const evidence = (Array.isArray(c.evidence) ? c.evidence : []).filter(e => Number.isSafeInteger(e?.chapter_id) && typeof e.quote === 'string' && e.quote.trim().length >= 8 && byId.get(e.chapter_id)?.content.includes(e.quote));
    if (!evidence.length) { rejected.push(`${name}：没有可核对的原文证据`); continue; }
    const aliases = [];
    for (const a of Array.isArray(c.aliases) ? c.aliases : []) {
      const alias = cleanName(a?.name);
      if (!alias || forbidden.has(alias) || unresolvedNames.has(alias)) continue;
      const ids = [...new Set(Array.isArray(a.chapter_ids) ? a.chapter_ids : [])].filter(id => Number.isSafeInteger(id) && byId.get(id)?.content.includes(alias));
      if (ids.length) aliases.push({ name: alias, chapter_ids: ids });
    }
    // 规范名本身也按章节记录，支持带场景限定的同名人物。
    if (!/[（(]/.test(name)) {
      const ids = chapters.filter(ch => ch.content.includes(name)).map(ch => ch.id);
      if (ids.length) aliases.push({ name, chapter_ids: ids });
    }
    const existing = characters.find(x => x.name === name);
    if (existing) { existing.aliases.push(...aliases); existing.evidence.push(...evidence); }
    else characters.push({ name, gender: /^(male|男)$/.test(c.gender) ? 'male' : /^(female|女)$/.test(c.gender) ? 'female' : '', age: ({ '青年': 'young', '成年': 'young', '中年': 'middle', '老年': 'old', '儿童': 'child' })[c.age] || (['child', 'young', 'middle', 'old'].includes(c.age) ? c.age : ''), description: typeof c.description === 'string' ? c.description.slice(0, 1500) : '', confidence: Number(c.confidence), aliases, evidence });
  }
  const owners = new Map();
  for (const c of characters) for (const a of c.aliases) for (const id of a.chapter_ids) {
    const key = JSON.stringify([a.name, id]);
    if (!owners.has(key)) owners.set(key, new Set());
    owners.get(key).add(c.name);
  }
  for (const c of characters) {
    const map = new Map();
    for (const a of c.aliases) for (const id of a.chapter_ids) {
      if (owners.get(JSON.stringify([a.name, id])).size > 1) { rejected.push(`第${byId.get(id).idx + 1}章「${a.name}」有多个身份，保留待核对`); continue; }
      if (!map.has(a.name)) map.set(a.name, new Set());
      map.get(a.name).add(id);
    }
    c.aliases = [...map].map(([name, ids]) => ({ name, chapter_ids: [...ids] }));
    c.evidence = [...new Map(c.evidence.map(e => [JSON.stringify(e), e])).values()];
  }
  if (!characters.length) throw new Error('角色考据未返回任何有原文依据的身份，未修改角色');
  return { characters, unresolved: [...new Set([...(Array.isArray(raw.unresolved) ? raw.unresolved.filter(x => typeof x === 'string') : []), ...rejected])] };
}

export async function analyzeIdentities(chapters, settings, { onProgress, signal, request = chatJson } = {}) {
  if (!chapters.length) throw new Error('没有可分析的章节');
  const batches = [];
  let current = [], size = 0;
  for (const c of chapters) {
    if (size + c.content.length > 26000 && current.length) {
      batches.push(current);
      current = current.length > 1 ? [current.at(-1)] : [];
      size = current.reduce((n, ch) => n + ch.content.length, 0);
    }
    current.push(c); size += c.content.length;
  }
  if (current.length) batches.push(current);
  const observations = [];
  const outputFormat = '\n【输出格式】只输出 JSON 对象，第一个字符必须是 {，必须使用英文键 characters（数组）和 unresolved（数组）。characters 每项包含 name, gender, age, description, confidence, aliases:[{name,chapter_ids}], evidence:[{chapter_id,quote}]。不要输出表格、列表、解释或代码块。';
  const getResult = async (messages, scope) => {
    let raw = await request(settings, messages, { temperature: 0.1 });
    try { return validateIdentities(raw, scope); }
    catch (e) {
      if (signal?.cancelled) throw new Error('已取消');
      onProgress?.('校正角色考据的输出格式与原文证据');
      raw = await request(settings, [...messages, { role: 'assistant', content: JSON.stringify(raw) }, { role: 'user', content: `校验未通过：${e.message}。请重新完整输出，核对证据。${outputFormat}` }], { temperature: 0.1 });
      return validateIdentities(raw, scope);
    }
  };
  for (let i = 0; i < batches.length; i++) {
    if (signal?.cancelled) throw new Error('已取消');
    onProgress?.(`通读角色身份 ${i + 1}/${batches.length} 批（${batches[i][0].title}—${batches[i].at(-1).title}）`);
    const observation = await getResult([
      { role: 'system', content: IDENTITY_SYSTEM },
      { role: 'user', content: '【章节原文】\n' + JSON.stringify(batches[i].map(c => ({ chapter_id: c.id, title: c.title, content: c.content }))) + outputFormat },
    ], batches[i]);
    observations.push(observation);
  }
  if (signal?.cancelled) throw new Error('已取消');
  let result = observations[0];
  if (observations.length) {
    onProgress?.('结合后续章节统一姓名、回溯早期称呼');
    result = await getResult([
      { role: 'system', content: CONSOLIDATE_SYSTEM },
      { role: 'user', content: '【各批角色考据】\n' + JSON.stringify(observations) + '\n【回溯核对：最早章节原文】\n' + JSON.stringify(chapters.slice(0, 3).map(c => ({ chapter_id: c.id, title: c.title, content: c.content }))) + '\n请逐句核对最早章节的每个说话者：将原文中所有外貌/服装称呼及其变体补入相应角色的 aliases（即使初步考据遗漏了也要补全），使用后续实名，并补充证明身份的逐字原文 evidence。最终保留有效的性别与年龄。' + outputFormat },
    ], chapters);
    // 汇总模型有时只返回重点核对的人物；保留各批已证实但被遗漏的独立身份。
    const finalNames = new Set(result.characters.flatMap(c => [c.name, ...c.aliases.map(a => a.name)]));
    const omitted = observations.flatMap(o => o.characters).filter(c => !finalNames.has(c.name));
    result = validateIdentities({ characters: [...result.characters, ...omitted], unresolved: result.unresolved }, chapters);
  }
  return { ...result, version: IDENTITY_VERSION, model: settings.llm_model, chapter_ids: chapters.map(c => c.id), fingerprint: identityFingerprint(chapters, settings), created_at: new Date().toISOString() };
}
