import crypto from 'node:crypto';
import { q, tx } from './db.js';

// 仅匹配称谓/职业等完整标签；不以台词多少或“描述里提到别人”判定实名。
const prefixes = ['NPC','npc','无名','未知','不知名','匿名','某个','某位','一名','一个','另一名','另一个','其中一名','其中一个','那名','那个','这名','这个','众','一众','几名','几个','一位','其他','另一位','围观','旁观','路过','受伤','新到','场外','左边','右边','老成','买酒','正道','古月族','古月山寨','古月','漠家','商队','学堂','客栈','酒铺','酒肆','蛊室','青衣','白衣','黑衣','红衣','灰衣','年轻','青年','中年','老年','年老','高个','矮个','矮胖','胖','瘦','长发','短发','光头','络腮胡','白胡子','拳脚','甲等','乙等','丙等','丁等','一代','二代','三代','四代','五代','六代','带头','接替','耗元','男','女'].sort((a,b) => b.length-a.length);
const npcLabel = /^(?:角色|配角|路人|人群|群雄|身边人|同龄人|同桌|同伴|少年|少女|小孩|孩子|小孩子|男孩|女孩|青年|男子|女子|男人|女人|老者|老人|老爷子|大人|孙子|舅母|舅父|父亲|母亲|哥哥|姐姐|弟弟|妹妹|叔叔|婶婶|大叔|大婶|爷爷|奶奶|学员|学生|蛊师|武者|侍卫|守卫|护卫|卫兵|士兵|家奴|仆人|奴仆|丫鬟|侍女|伙计|店小二|掌柜|老板|店主|管家|家老|族长|教头|负责人|接待者|下属|猎户|农人|农夫|山民|摊贩|顾客|客人|群众|村民|商人|商贩|修士|长老|弟子|师兄|师姐|师弟|师妹|头目|领头人)(?:头目|们|群体|甲|乙|丙|丁|戊|己|庚|辛|壬|癸|[一二三四五六七八九十]|\d|[A-Z]|[（(][^）)]*[）)])*$/;
function genericName(name) {
  if (name.length > 100) return false;
  let remaining = name;
  while (remaining) {
    if (npcLabel.test(remaining)) return true;
    const prefix = prefixes.find(p => remaining.startsWith(p));
    if (!prefix) return false;
    remaining = remaining.slice(prefix.length);
  }
  return false;
}
export function isNpc(c) {
  if (!c || c.is_narrator || c.role_type === 'named') return false;
  if (c.role_type === 'npc') return true;
  if (c.role_hint === 'named') return false;
  if (c.role_hint === 'npc') return true;
  const name = String(c.name || '').trim();
  return genericName(name) || /^(?:无名|未知|不知名|匿名|NPC)[\s（(\d男女甲乙丙丁]/i.test(name);
}
export function npcGender(c) {
  if (c.gender === 'female' || c.gender === 'male') return c.gender;
  // 不用人设中其他角色的性别猜测；如“保护少女的侍卫”仍默认男。
  return /女|少女|丫鬟|侍女|舅母|母亲|姐姐|妹妹|婶|奶奶|婆婆|夫人|太太|小姐/.test(c.name || '') ? 'female' : 'male';
}
export function effectivePool(novelId) {
  const novel = novelId ? q.get('SELECT npc_pool_id FROM novels WHERE id = ?', novelId) : null;
  return (novel?.npc_pool_id && q.get('SELECT * FROM npc_pools WHERE id = ?', novel.npc_pool_id)) || q.get('SELECT * FROM npc_pools ORDER BY id LIMIT 1');
}
export function assertIdle(novelId = null) {
  const job = novelId
    ? q.get("SELECT id FROM jobs WHERE novel_id = ? AND status IN ('queued','running')", novelId)
    : q.get("SELECT id FROM jobs WHERE status IN ('queued','running')");
  if (job) { const e = new Error('请等待当前拆分、角色分析或音频生成任务结束后再修改 NPC 配音'); e.status = 409; throw e; }
}
export function invalidateCharacterAudio(id) {
  q.run("UPDATE segments SET status = 'pending',error = NULL WHERE character_id = ? AND voice_override IS NULL", id);
  q.run('UPDATE chapters SET merged_audio = NULL,merged_lrc = NULL,merged_duration_ms = NULL WHERE id IN (SELECT chapter_id FROM segments WHERE character_id = ? AND voice_override IS NULL)', id);
}
export function npcVoice(c, { reroll = false, strict = true } = {}) {
  if (!isNpc(c)) return null;
  const pool = effectivePool(c.novel_id);
  const gender = npcGender(c);
  if (!pool) throw new Error('请先创建 NPC 音色合集');
  const previous = q.get('SELECT * FROM npc_assignments WHERE character_id = ?', c.id);
  const members = q.all('SELECT v.* FROM npc_pool_voices p JOIN voices v ON v.id = p.voice_id WHERE p.pool_id = ? AND p.gender = ? ORDER BY v.id', pool.id, gender);
  if (!members.length) {
    if (!strict) {
      if (previous) { q.run('DELETE FROM npc_assignments WHERE character_id = ?', c.id); invalidateCharacterAudio(c.id); }
      return null;
    }
    throw new Error(`「${pool.name}」没有${gender === 'female' ? '女' : '男'} NPC 音色，请在 NPC 音色合集中添加`);
  }
  const valid = previous?.pool_id === pool.id && previous.gender === gender && members.some(v => v.id === previous.voice_id);
  if (!reroll && valid) return members.find(v => v.id === previous.voice_id);
  const choices = reroll && members.length > 1 ? members.filter(v => v.id !== previous?.voice_id) : members;
  const selected = choices[crypto.randomInt(choices.length)];
  q.run('INSERT INTO npc_assignments(character_id,pool_id,voice_id,gender) VALUES (?,?,?,?) ON CONFLICT(character_id) DO UPDATE SET pool_id=excluded.pool_id,voice_id=excluded.voice_id,gender=excluded.gender', c.id, pool.id, selected.id, gender);
  if (previous?.voice_id !== selected.id) invalidateCharacterAudio(c.id);
  return selected;
}
export function describeNpc(c) {
  const npc = isNpc(c);
  // 列表查询只读：不因浏览页面或音色库空缺修改配音/音频状态。
  const pool = npc ? effectivePool(c.novel_id) : null;
  const voice = npc ? q.get('SELECT v.* FROM npc_assignments a JOIN voices v ON v.id=a.voice_id JOIN npc_pool_voices p ON p.pool_id=a.pool_id AND p.voice_id=a.voice_id WHERE a.character_id=? AND a.pool_id=? AND a.gender=? AND p.gender=a.gender', c.id, pool?.id, npcGender(c)) : null;
  return { ...c, is_npc: npc, npc_gender: npcGender(c), npc_voice: voice || null };
}
export function assignNovelNpcs(novelId, { reroll = false, strict = true } = {}) {
  const chars = q.all('SELECT * FROM characters WHERE novel_id = ? AND is_narrator = 0', novelId).filter(isNpc);
  return tx(() => {
    let assigned = 0, male = 0, female = 0;
    for (const c of chars) {
      if (npcGender(c) === 'female') female++; else male++;
      const before = q.get('SELECT voice_id FROM npc_assignments WHERE character_id = ?', c.id);
      const v = npcVoice(c, { reroll, strict });
      if (v && before?.voice_id !== v.id) assigned++;
    }
    return { npc_count: chars.length, assigned, male, female };
  });
}
export function listPools() {
  return q.all('SELECT * FROM npc_pools ORDER BY id').map(p => ({ ...p, voices: q.all('SELECT v.*,p.gender FROM npc_pool_voices p JOIN voices v ON v.id=p.voice_id WHERE p.pool_id=? ORDER BY p.gender,v.id', p.id) }));
}
