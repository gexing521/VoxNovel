import { q, tx, getSettings } from './db.js';
import { analyzeIdentities, identityFingerprint, validateIdentities } from './identity-analysis.js';
import { isNpc, npcVoice, invalidateCharacterAudio, describeNpc } from './npc.js';

const names = text => String(text || '').split(/[,，、\s]+/).filter(Boolean);
export const getIdentityReport = novelId => {
  const row = q.get('SELECT report_json FROM identity_reports WHERE novel_id = ?', novelId);
  return row ? JSON.parse(row.report_json) : null;
};
export function scopedCharacters(novelId, chapterId) {
  const chars = q.all('SELECT * FROM characters WHERE novel_id = ? AND is_narrator = 0', novelId);
  const all = q.all('SELECT alias,character_id,chapter_id FROM character_alias_scopes WHERE novel_id = ?', novelId);
  const scopedNames = new Set(all.map(a => a.alias));
  return chars.map(c => ({ ...c, aliases: [...new Set([
    ...names(c.aliases).filter(a => !scopedNames.has(a)),
    ...all.filter(a => a.character_id === c.id && a.chapter_id === chapterId && a.alias !== c.name).map(a => a.alias),
  ])].join(',') }));
}
export function scopedCharacterByName(novelId, name, chapterId) {
  if (!name) return null;
  const scope = q.all('SELECT * FROM character_alias_scopes WHERE novel_id = ? AND alias = ?', novelId, name);
  if (scope.length) {
    const ids = new Set(scope.filter(s => chapterId == null || s.chapter_id === chapterId).map(s => s.character_id));
    if (ids.size === 1) return q.get('SELECT * FROM characters WHERE id = ?', [...ids][0]);
    // 规范名全书有效：早期章节尚未出现实名，也必须能绑定到已考据的同一角色。
    const owners = new Set(scope.map(s => s.character_id));
    if (!ids.size && owners.size === 1) {
      const canonical = q.get('SELECT * FROM characters WHERE id = ?', [...owners][0]);
      if (canonical?.name === name) return canonical;
    }
    // 已知歧义称呼不能回退到无范围的 aliases。
    return null;
  }
  const list = q.all('SELECT * FROM characters WHERE novel_id = ?', novelId);
  const exact = list.find(c => c.name === name);
  if (exact) return exact;
  const hits = list.filter(c => names(c.aliases).includes(name));
  return hits.length === 1 ? hits[0] : null;
}
const defaultVoice = id => {
  if (!id) return null;
  const c = q.get('SELECT * FROM characters WHERE id = ?', id);
  if (isNpc(c)) {
    const v = describeNpc(c).npc_voice;
    return v ? { voice_id: v.id, speed: 1, vol: 1, pitch: 0 } : null;
  }
  return q.get('SELECT voice_id,speed,vol,pitch FROM character_voices WHERE character_id = ? ORDER BY is_default DESC,created_at LIMIT 1', id);
};

/** 事务中同步旧台词、角色别名和音色；不重拆正文或删除已有音频文件。 */
export function applyIdentityReport(novelId, input, chapters) {
  const validated = validateIdentities(input, chapters);
  const report = { ...input, ...validated };
  const old = q.all('SELECT * FROM characters WHERE novel_id = ? AND is_narrator = 0 ORDER BY id', novelId);
  const owners = new Map();
  for (const c of report.characters) for (const alias of [c.name, ...c.aliases.map(a => a.name)]) {
    if (!owners.has(alias)) owners.set(alias, new Set());
    owners.get(alias).add(c.name);
  }
  let merged = 0, updatedSegments = 0, renamed = 0;
  const affected = new Set();
  tx(() => {
    q.run('DELETE FROM character_alias_scopes WHERE novel_id = ?', novelId);
    const remaps = new Map();
    for (const c of report.characters) {
      const aliases = c.aliases.map(a => a.name);
      const candidates = old.filter(o => {
        if (o.name === c.name) return true;
        // 旧名称可能是模型概括的“白大褂中年男人”；用它已经登记的逐字别名匹配。
        const labels = [o.name, ...names(o.aliases)];
        const identities = new Set(labels.flatMap(label => owners.get(label)?.size === 1 ? [...owners.get(label)] : []));
        if (identities.size !== 1 || !identities.has(c.name)) return false;
        const scope = new Set(c.aliases.filter(a => labels.includes(a.name)).flatMap(a => a.chapter_ids));
        // 旧角色跨章复用了一个外貌称呼时，只迁移有证据的章节；不能整行全书合并。
        return q.all('SELECT DISTINCT chapter_id FROM segments WHERE character_id = ?', o.id).every(s => scope.has(s.chapter_id));
      });
      let target = candidates.find(o => o.name === c.name) || candidates[0];
      if (!target) {
        const id = q.run('INSERT INTO characters(novel_id,name,aliases,gender,age,description) VALUES (?,?,?,?,?,?)', novelId, c.name, '', c.gender, c.age, c.description).id;
        target = { id, name: c.name, aliases: '' };
      }
      const allAliases = [...new Set([...aliases, ...candidates.flatMap(o => [o.name, ...names(o.aliases)])])].filter(a => a !== c.name);
      if (target.name !== c.name) renamed++;
      q.run('UPDATE characters SET name = ?,aliases = ?,gender = COALESCE(NULLIF(gender,\'\'),?),age = COALESCE(NULLIF(age,\'\'),?),description = ? WHERE id = ?', c.name, allAliases.join(','), c.gender, c.age, c.description, target.id);
      if (typeof c.is_named === 'boolean') q.run('UPDATE characters SET role_hint = ? WHERE id = ?', c.is_named ? 'named' : 'npc', target.id);
      const fresh = q.get('SELECT * FROM characters WHERE id = ?', target.id);
      if (isNpc(target) !== isNpc(fresh)) invalidateCharacterAudio(target.id);
      for (const source of candidates) remaps.set(source.id, { id: target.id, name: c.name });
      // 保留目标默认音色；若目标没有音色则从最早的旧角色承接默认绑定。
      for (const source of candidates.filter(o => o.id !== target.id)) {
        const hasDefault = !!defaultVoice(target.id);
        q.run('INSERT OR IGNORE INTO character_voices(character_id,voice_id,is_default,speed,vol,pitch) SELECT ?,voice_id,CASE WHEN ? THEN 0 ELSE is_default END,speed,vol,pitch FROM character_voices WHERE character_id = ?', target.id, hasDefault, source.id);
      }
      c.character_id = target.id;
      for (const a of c.aliases) for (const chapterId of a.chapter_ids) q.run('INSERT INTO character_alias_scopes(novel_id,chapter_id,alias,character_id) VALUES (?,?,?,?)', novelId, chapterId, a.name, target.id);
    }
    const segs = q.all('SELECT s.*,c.name AS old_name FROM segments s JOIN chapters ch ON ch.id = s.chapter_id LEFT JOIN characters c ON c.id = s.character_id WHERE ch.novel_id = ? AND s.type = \'dialogue\'', novelId);
    for (const s of segs) {
      let scoped = q.get('SELECT c.id,c.name FROM character_alias_scopes a JOIN characters c ON c.id = a.character_id WHERE a.novel_id = ? AND a.chapter_id = ? AND a.alias IN (?,?) ORDER BY CASE WHEN a.alias = ? THEN 0 ELSE 1 END LIMIT 1', novelId, s.chapter_id, s.speaker, s.old_name || '', s.speaker);
      if (!scoped) {
        const labels = names(old.find(c => c.id === s.character_id)?.aliases);
        if (labels.length) {
          const matches = q.all(`SELECT DISTINCT c.id,c.name FROM character_alias_scopes a JOIN characters c ON c.id = a.character_id WHERE a.novel_id = ? AND a.chapter_id = ? AND a.alias IN (${labels.map(() => '?').join(',')})`, novelId, s.chapter_id, ...labels);
          if (matches.length === 1) scoped = matches[0];
        }
      }
      const target = scoped || remaps.get(s.character_id);
      if (!target || (target.id === s.character_id && target.name === s.speaker)) continue;
      const voiceChanged = !s.voice_override && JSON.stringify(defaultVoice(s.character_id)) !== JSON.stringify(defaultVoice(target.id));
      q.run('UPDATE segments SET character_id = ?,speaker = ?,status = CASE WHEN ? THEN \'pending\' ELSE status END WHERE id = ?', target.id, target.name, voiceChanged, s.id);
      updatedSegments++; affected.add(s.chapter_id);
    }
    for (const [sourceId, target] of remaps) if (sourceId !== target.id) {
      q.run('DELETE FROM characters WHERE id = ? AND NOT EXISTS (SELECT 1 FROM segments WHERE character_id = ?)', sourceId, sourceId);
      merged++;
    }
    for (const id of affected) q.run('UPDATE chapters SET merged_audio = NULL,merged_lrc = NULL,merged_duration_ms = NULL WHERE id = ?', id);
    for (const c of q.all('SELECT * FROM characters WHERE novel_id = ?', novelId)) {
      if (isNpc(c)) npcVoice(c, { strict: false });
      else q.run('DELETE FROM npc_assignments WHERE character_id = ?', c.id);
    }
    report.applied = { merged, renamed, updated_segments: updatedSegments };
    q.run('INSERT INTO identity_reports(novel_id,fingerprint,report_json) VALUES (?,?,?) ON CONFLICT(novel_id) DO UPDATE SET fingerprint=excluded.fingerprint,report_json=excluded.report_json', novelId, report.fingerprint, JSON.stringify(report));
  });
  return report;
}

export async function reconcileNovel(novelId, { force = false, onProgress, signal } = {}) {
  const chapters = q.all('SELECT * FROM chapters WHERE novel_id = ? ORDER BY idx,id', novelId);
  const settings = getSettings();
  const fingerprint = identityFingerprint(chapters, settings);
  const cached = getIdentityReport(novelId);
  if (!force && cached?.fingerprint === fingerprint) return cached;
  const report = await analyzeIdentities(chapters, settings, { onProgress, signal });
  if (signal?.cancelled) throw new Error('已取消');
  // 分析过程中若原文被编辑，禁止把旧结果应用到新正文。
  const fresh = q.all('SELECT * FROM chapters WHERE novel_id = ? ORDER BY idx,id', novelId);
  if (identityFingerprint(fresh, settings) !== fingerprint) throw new Error('分析期间原文发生变化，请重新统一角色');
  return applyIdentityReport(novelId, report, fresh);
}
