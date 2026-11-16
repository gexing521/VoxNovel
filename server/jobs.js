// 业务服务：拆分任务、生成任务、音色解析、合并音频
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { q, tx, getSettings, DATA_DIR } from './db.js';
import { splitChapterText } from './splitter.js';
import { synthesize, synthesizeOnce } from './minimax.js';
import { buildSegmentLines, formatLrc, mp3DurationMs } from './lrc.js';
import { guessAgeTag, isMandarinVoice } from './voices-seed.js';
import { chatJson } from './llm.js';
import { CASTING_SYSTEM, castingUserMessage } from './prompts.js';
import { scopedCharacterByName, scopedCharacters, reconcileNovel } from './identity.js';
import { isNpc, npcVoice, assignNovelNpcs, describeNpc, invalidateCharacterAudio } from './npc.js';
import { compressChapterNarration, assertNotCompressing, resetCompression } from './narration.js';

export const AUDIO_DIR = path.join(DATA_DIR, 'audio');
export const PREVIEW_DIR = path.join(DATA_DIR, 'previews');
fs.mkdirSync(AUDIO_DIR, { recursive: true });
fs.mkdirSync(PREVIEW_DIR, { recursive: true });

export const safeName = (s, max = 40) =>
  String(s || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, max) || '未命名';

// ---------------- 角色 ----------------
export function ensureNarrator(novelId) {
  let n = q.get('SELECT * FROM characters WHERE novel_id = ? AND is_narrator = 1', novelId);
  if (!n) {
    const id = q.run(`INSERT INTO characters(novel_id, name, is_narrator, description) VALUES (?, '旁白', 1, '叙述者')`, novelId).id;
    n = q.get('SELECT * FROM characters WHERE id = ?', id);
    const s = getSettings();
    const v = q.get('SELECT id FROM voices WHERE voice_id = ?', s.default_narrator_voice);
    if (v) q.run('INSERT OR IGNORE INTO character_voices(character_id, voice_id, is_default) VALUES (?, ?, 1)', n.id, v.id);
  }
  return n;
}

export function findCharacterByName(novelId, name, chapterId) {
  return scopedCharacterByName(novelId, name, chapterId);
}

/** 可用于角色配音的音色（普通话，排除旁白/播报/卡通类） */
function castingPool() {
  return q.all(`SELECT * FROM voices WHERE source IN ('system','cloning','generation','custom')`)
    .filter((v) => (v.source !== 'system' || isMandarinVoice(v)) && !/有声书|主持|播报|新闻|电台|旁白/.test(`${v.name} ${v.tags} ${v.description}`));
}
const usedVoiceIds = (novelId) =>
  new Set(q.all(`SELECT cv.voice_id FROM character_voices cv JOIN characters c ON c.id = cv.character_id WHERE c.novel_id = ? AND cv.is_default = 1`, novelId).map((r) => r.voice_id));

/** 规则分配：按性别、年龄，尽量不与本书已用音色重复 */
export function autoAssignVoice(character) {
  if (character.is_narrator) return;
  if (isNpc(character)) { npcVoice(character, { strict: false }); return; }
  if (q.get('SELECT 1 FROM character_voices WHERE character_id = ?', character.id)) return;
  const used = usedVoiceIds(character.novel_id);
  const age = character.age || 'young';
  const all = castingPool().filter((v) => v.gender === (character.gender || 'male') && !/卡通|机器|机械|萌兽|特色/.test(`${v.name} ${v.tags} ${v.description}`));
  if (!all.length) return;
  const ageOf = (v) => guessAgeTag(`${v.tags} ${v.name} ${v.description}`);
  const byAge = all.filter((v) => ageOf(v) === age);
  const notChild = age === 'child' ? all : all.filter((v) => ageOf(v) !== 'child');
  // 优先：同年龄未占用 > 同性别未占用（非童声）> 同年龄 > 同性别
  const tiers = [byAge.filter((v) => !used.has(v.id)), notChild.filter((v) => !used.has(v.id)), byAge, notChild, all];
  const pickFrom = tiers.find((t) => t.length);
  const h = crypto.createHash('md5').update(character.name).digest().readUInt32LE(0);
  const v = pickFrom[h % pickFrom.length];
  q.run('INSERT OR IGNORE INTO character_voices(character_id, voice_id, is_default) VALUES (?, ?, 1)', character.id, v.id);
}

/** AI 选角：用 LLM 根据人设为未绑定音色的角色挑选音色；失败时回退到规则分配 */
export async function aiCasting(novelId, settings, onProgress) {
  const chars = q.all(
    `SELECT c.* FROM characters c WHERE c.novel_id = ? AND c.is_narrator = 0
       AND NOT EXISTS (SELECT 1 FROM character_voices cv WHERE cv.character_id = c.id) AND c.name NOT IN ('未知角色')`, novelId).filter(c => !isNpc(c));
  if (!chars.length) return;
  const pool = castingPool();
  const used = usedVoiceIds(novelId);
  const narr = q.get(`SELECT cv.voice_id FROM character_voices cv JOIN characters c ON c.id = cv.character_id WHERE c.novel_id = ? AND c.is_narrator = 1 AND cv.is_default = 1`, novelId);
  if (narr) used.add(narr.voice_id);
  const genders = new Set(chars.map((c) => c.gender || 'male'));
  const cand = pool.filter((v) => !v.gender || genders.has(v.gender) || [...genders].includes(''));
  onProgress?.(`AI 选角：${chars.length} 个角色`);
  try {
    const res = await chatJson(settings, [
      { role: 'system', content: CASTING_SYSTEM },
      { role: 'user', content: castingUserMessage(chars, cand, pool.filter((v) => used.has(v.id)).map((v) => `${v.voice_id}(${v.name})`)) },
    ]);
    // 兼容两种输出：{"assign":[{name,voice_id}]} 或 {"角色名":{voice_id}} / {"角色名":"voice_id"}
    let list = Array.isArray(res.assign) ? res.assign : Array.isArray(res) ? res : null;
    if (!list) {
      const obj = res.assign && typeof res.assign === 'object' ? res.assign : res;
      list = Object.entries(obj).map(([name, v]) => ({ name, voice_id: typeof v === 'string' ? v : v?.voice_id }));
    }
    for (const a of list) {
      const c = chars.find((x) => x.name === a.name);
      const v = pool.find((x) => x.voice_id === a.voice_id);
      if (!c || !v) continue;
      if (c.gender && v.gender && c.gender !== v.gender) continue;
      if (used.has(v.id) && pool.some((x) => !used.has(x.id) && x.gender === v.gender)) continue; // 重复就交给规则分配
      q.run('INSERT OR IGNORE INTO character_voices(character_id, voice_id, is_default) VALUES (?, ?, 1)', c.id, v.id);
      used.add(v.id);
    }
  } catch (e) {
    console.warn('AI 选角失败，回退规则分配：', e.message);
  }
  for (const c of chars) autoAssignVoice(c);
}

// ---------------- 音色解析 ----------------
export function resolveVoice(seg, chapter) {
  if (seg.voice_override) {
    const v = q.get('SELECT * FROM voices WHERE id = ?', seg.voice_override);
    if (v) {
      const cv = seg.character_id ? q.get('SELECT * FROM character_voices WHERE character_id = ? AND voice_id = ?', seg.character_id, v.id) : null;
      return { voice_id: v.voice_id, name: v.name, speed: cv?.speed ?? 1, vol: cv?.vol ?? 1, pitch: cv?.pitch ?? 0 };
    }
  }
  let charId = seg.character_id;
  if (!charId || seg.type === 'narration') {
    if (seg.type === 'narration' || !charId) charId = ensureNarrator(chapter.novel_id).id;
  }
  const character = charId ? q.get('SELECT * FROM characters WHERE id = ?', charId) : null;
  if (seg.type === 'dialogue' && isNpc(character)) {
    const v = describeNpc(character).npc_voice;
    return v ? { voice_id: v.voice_id, name: v.name, speed: 1, vol: 1, pitch: 0 } : null;
  }
  const pick = (cid) =>
    q.get(
      `SELECT v.voice_id, v.name, cv.speed, cv.vol, cv.pitch FROM character_voices cv JOIN voices v ON v.id = cv.voice_id
       WHERE cv.character_id = ? ORDER BY cv.is_default DESC, cv.created_at ASC LIMIT 1`,
      cid
    );
  let r = pick(charId);
  if (!r && seg.type === 'dialogue') return null; // 对话角色未绑定音色
  if (!r) r = pick(ensureNarrator(chapter.novel_id).id);
  if (!r) {
    const s = getSettings();
    r = { voice_id: s.default_narrator_voice, name: s.default_narrator_voice, speed: 1, vol: 1, pitch: 0 };
  }
  return r;
}

function genKey(seg, voice, s) {
  return crypto
    .createHash('md5')
    .update([seg.text, voice.voice_id, voice.speed, voice.vol, voice.pitch, seg.emotion, s.tts_model, s.tts_sample_rate, s.tts_bitrate].join('|'))
    .digest('hex');
}

function chapterDir(chapter) {
  return path.join(AUDIO_DIR, `novel_${chapter.novel_id}`, `ch_${chapter.id}`);
}

// ---------------- 任务管理 ----------------
const running = new Map(); // jobId -> { cancelled }

export function createJob(type, title, novelId, chapterIds, total = 0) {
  return q.run(
    `INSERT INTO jobs(type, title, novel_id, chapter_ids, status, total) VALUES (?, ?, ?, ?, 'queued', ?)`,
    type, title, novelId, JSON.stringify(chapterIds), total
  ).id;
}
const jobUpdate = (id, fields) => {
  const keys = Object.keys(fields);
  q.run(`UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => fields[k]), id);
};
const jobFinish = (id, status, message) =>
  q.run(`UPDATE jobs SET status = ?, message = ?, finished_at = datetime('now','localtime') WHERE id = ?`, status, message, id);

export function cancelJob(id) {
  const r = running.get(Number(id));
  if (r) r.cancelled = true;
  else q.run(`UPDATE jobs SET status = 'cancelled' WHERE id = ? AND status IN ('queued','running')`, id);
}

// 简单串行队列：同一时间只跑一个拆分任务 + 一个生成任务，避免触发限流
const queues = { split: Promise.resolve(), generate: Promise.resolve() };
function enqueue(kind, jobId, fn, onQueuedCancel) {
  const signal = { cancelled: false };
  running.set(jobId, signal);
  queues[kind] = queues[kind].then(async () => {
    if (signal.cancelled) { onQueuedCancel?.(); jobFinish(jobId, 'cancelled', '已取消'); running.delete(jobId); return; }
    jobUpdate(jobId, { status: 'running' });
    try {
      const msg = await fn(signal);
      jobFinish(jobId, signal.cancelled ? 'cancelled' : 'done', msg || '完成');
    } catch (e) {
      jobFinish(jobId, signal.cancelled ? 'cancelled' : 'error', e.message);
    } finally {
      running.delete(jobId);
    }
  });
  return jobId;
}

export function startCompressNarration(chapterIds, { force = false } = {}) {
  let chapters = [...new Set(chapterIds)].map(id => q.get('SELECT * FROM chapters WHERE id=?',id)).filter(Boolean).sort((a,b)=>a.idx-b.idx || a.id-b.id);
  if (!chapters.length) throw new Error('没有可压缩的章节');
  if (chapters.some(c=>c.novel_id!==chapters[0].novel_id)) throw new Error('一次只能压缩同一本小说');
  const novel=q.get('SELECT * FROM novels WHERE id=?',chapters[0].novel_id);
  const blocker = q.get("SELECT id,title,type FROM jobs WHERE novel_id=? AND status IN ('queued','running') ORDER BY id LIMIT 1",novel.id);
  if (blocker) {
    const e = new Error(`本书有正在执行的任务（#${blocker.id}：${blocker.title}），请等待任务完成或取消后再整合旁白`);
    e.status = 409; throw e;
  }
  if (chapters.some(c=>c.split_status!=='done')) throw new Error('请先完成章节拆分，再压缩旁白');
  chapters=chapters.filter(c=>force || c.compression_status!=='done' || c.compression_version!=='video-v2');
  if (!chapters.length) throw new Error('所选章节旁白均已压缩');
  if (!getSettings().llm_api_key) throw new Error('未配置大语言模型 API Key');
  const jobId=createJob('compress',`压缩《${novel.title}》${chapters.length} 章旁白`,novel.id,chapters.map(c=>c.id),chapters.length);
  for(const c of chapters) q.run("UPDATE chapters SET compression_status='queued',compression_error=NULL WHERE id=?",c.id);
  // 与拆分共用串行队列，避免增加模型并发。
  return enqueue('split',jobId,async signal=>{
    let done=0,failed=0,before=0,after=0;
    for(const c of chapters) {
      if(signal.cancelled) {
        q.run("UPDATE chapters SET compression_status=?,compression_error=NULL WHERE id=? AND compression_status='queued'",c.compression_status,c.id);
        continue;
      }
      q.run("UPDATE chapters SET compression_status='running' WHERE id=?",c.id);
      try {
        const r=await compressChapterNarration(c.id,{signal,onProgress:message=>jobUpdate(jobId,{message:`${c.title}：${message}`})});
        done++;before+=r.before;after+=r.after;
      } catch(e) {
        if(signal.cancelled) q.run('UPDATE chapters SET compression_status=?,compression_error=NULL WHERE id=?',c.compression_status,c.id);
        else { failed++;q.run('UPDATE chapters SET compression_status=?,compression_error=? WHERE id=?',c.compression_status==='done'?'done':'error',e.message,c.id); }
      }
      jobUpdate(jobId,{done,failed});
    }
    if(failed && !done) throw new Error(`旁白压缩失败 ${failed} 章，请查看章节错误信息`);
    return `完成 ${done} 章，失败 ${failed} 章；旁白 ${before} → ${after} 字，对白保持原文`;
  },()=>{
    for(const c of chapters) q.run("UPDATE chapters SET compression_status=?,compression_error=NULL WHERE id=? AND compression_status='queued'",c.compression_status,c.id);
  });
}

export function startReconcile(novelId, { force = true } = {}) {
  assertNotCompressing(novelId);
  const novel = q.get('SELECT * FROM novels WHERE id = ?', novelId);
  if (!novel) throw new Error('小说不存在');
  const chapters = q.all('SELECT id FROM chapters WHERE novel_id = ? ORDER BY idx,id', novelId);
  if (!chapters.length) throw new Error('没有可分析的章节');
  if (q.get("SELECT id FROM jobs WHERE novel_id = ? AND type = 'generate' AND status IN ('queued','running')", novelId)) throw new Error('本书正在生成音频，请完成或取消生成后再统一角色身份');
  const jobId = createJob('identity', `统一《${novel.title}》角色身份`, novelId, chapters.map(c => c.id), 1);
  return enqueue('split', jobId, async signal => {
    const report = await reconcileNovel(novelId, { force, signal, onProgress: message => jobUpdate(jobId, { message }) });
    assignNovelNpcs(novelId, { strict: false });
    const settings = getSettings();
    if (settings.auto_assign_voice !== '0') {
      if (settings.ai_casting !== '0') await aiCasting(novelId, settings, message => jobUpdate(jobId, { message }));
      for (const c of q.all('SELECT * FROM characters WHERE novel_id = ? AND is_narrator = 0', novelId)) autoAssignVoice(c);
    }
    jobUpdate(jobId, { done: 1 });
    return `结合 ${report.chapter_ids.length} 章认定 ${report.characters.length} 个角色，合并 ${report.applied.merged} 个重复角色，更新 ${report.applied.updated_segments} 句台词；${report.unresolved.length} 项待核对`;
  });
}

// ---------------- 拆分 ----------------
export function startSplit(chapterIds, { mode, reconcile } = {}) {
  const chapters = [...new Set(chapterIds)].map((id) => q.get('SELECT * FROM chapters WHERE id = ?', id)).filter(Boolean).sort((a,b) => a.idx - b.idx || a.id - b.id);
  if (!chapters.length) throw new Error('没有可拆分的章节');
  if (chapters.some(c => c.novel_id !== chapters[0].novel_id)) throw new Error('一次只能拆分同一本小说');
  assertNotCompressing(chapters[0].novel_id);
  const novel = q.get('SELECT * FROM novels WHERE id = ?', chapters[0].novel_id);
  if (q.get("SELECT id FROM jobs WHERE novel_id = ? AND type = 'generate' AND status IN ('queued','running')", novel.id)) throw new Error('本书正在生成音频，请完成或取消生成后再拆分');
  const jobId = createJob('split', `拆分《${novel.title}》${chapters.length > 1 ? chapters.length + ' 章' : chapters[0].title}`, novel.id, chapters.map((c) => c.id), chapters.length);
  for (const c of chapters) q.run(`UPDATE chapters SET split_status = 'queued', split_error = NULL WHERE id = ?`, c.id);
  return enqueue('split', jobId, async (signal) => {
    let done = 0, failed = 0;
    const warns = [];
    const settings = getSettings();
    if ((mode || settings.split_mode) !== 'rule' && (reconcile ?? settings.identity_prepass !== '0')) {
      try {
        if (q.get("SELECT id FROM jobs WHERE novel_id = ? AND type = 'generate' AND status IN ('queued','running')", novel.id)) throw new Error('本书正在生成音频，请结束生成后再统一角色并拆分');
        const report = await reconcileNovel(novel.id, { signal, onProgress: message => jobUpdate(jobId, { message }) });
        warns.push(`已结合 ${report.chapter_ids.length} 章统一 ${report.characters.length} 个角色身份`);
      } catch (e) {
        for (const c of chapters) q.run(`UPDATE chapters SET split_status = 'none' WHERE id = ? AND split_status = 'queued'`, c.id);
        throw e;
      }
    }
    for (const c of chapters) {
      if (signal.cancelled) { q.run(`UPDATE chapters SET split_status = 'none' WHERE id = ? AND split_status = 'queued'`, c.id); continue; }
      try {
        const w = await splitChapter(c.id, { mode, signal, onProgress: (m) => jobUpdate(jobId, { message: `${c.title}：${m}` }) });
        warns.push(...w.map((x) => `${c.title}：${x}`));
        done++;
      } catch (e) {
        failed++;
        q.run(`UPDATE chapters SET split_status = 'error', split_error = ? WHERE id = ?`, e.message, c.id);
        if (/未配置|HTTP 40[13]/.test(e.message)) {
          for (const r of chapters) q.run(`UPDATE chapters SET split_status = 'none' WHERE id = ? AND split_status = 'queued'`, r.id);
          throw e;
        }
      }
      jobUpdate(jobId, { done, failed });
    }
    return `完成 ${done} 章${failed ? `，失败 ${failed} 章` : ''}${warns.length ? '；' + warns.slice(0, 5).join('；') : ''}`;
  });
}

export async function splitChapter(chapterId, { mode, signal, onProgress } = {}) {
  const chapter = q.get('SELECT * FROM chapters WHERE id = ?', chapterId);
  if (!chapter) throw new Error('章节不存在');
  assertNotCompressing(chapter.novel_id);
  q.run(`UPDATE chapters SET split_status = 'running', split_error = NULL WHERE id = ?`, chapterId);
  const settings = getSettings();
  ensureNarrator(chapter.novel_id);
  const known = scopedCharacters(chapter.novel_id, chapterId);
  const { segments, warnings } = await splitChapterText(chapter.content, known, settings, { mode, onProgress, signal });
  if (signal?.cancelled) throw new Error('已取消');

  tx(() => {
    // 写入/更新角色
    for (const k of known) {
      const before = k.id ? q.get('SELECT * FROM characters WHERE id = ?', k.id) : null;
      if (k._new) {
        if (findCharacterByName(chapter.novel_id, k.name)) continue;
        q.run('INSERT INTO characters(novel_id, name, aliases, gender, age, description, role_hint) VALUES (?, ?, ?, ?, ?, ?, ?)', chapter.novel_id, k.name, k.aliases || '', k.gender || '', k.age || '', k.description || '', k.role_hint || '');
      } else if (k.id) {
        const existingAliases = q.get('SELECT aliases FROM characters WHERE id = ?', k.id)?.aliases || '';
        const aliases = [...new Set([existingAliases, k.aliases || ''].flatMap(a => a.split(/[,，、\s]+/)).filter(Boolean))].join(',');
        q.run(`UPDATE characters SET aliases = ?, gender = COALESCE(NULLIF(gender,''), ?), age = COALESCE(NULLIF(age,''), ?), description = COALESCE(NULLIF(description,''), ?) WHERE id = ?`, aliases, k.gender || '', k.age || '', k.description || '', k.id);
      }
      if (k.id && k.role_hint) q.run('UPDATE characters SET role_hint = ? WHERE id = ?', k.role_hint, k.id);
      if (before) {
        const fresh = q.get('SELECT * FROM characters WHERE id = ?', k.id);
        if (isNpc(before) !== isNpc(fresh)) invalidateCharacterAudio(k.id);
        if (!isNpc(fresh)) q.run('DELETE FROM npc_assignments WHERE character_id = ?', k.id);
      }
    }
    resetCompression(chapterId);
    // 删除旧片段与旧音频
    removeChapterAudio(chapter);
    q.run('DELETE FROM segments WHERE chapter_id = ?', chapterId);
    segments.forEach((s, i) => {
      let charId = null;
      let speaker = '';
      if (s.type === 'dialogue') {
        speaker = s.speaker || '未知角色';
        let c = findCharacterByName(chapter.novel_id, speaker, chapterId);
        if (!c) {
          const id = q.run('INSERT INTO characters(novel_id, name) VALUES (?, ?)', chapter.novel_id, speaker).id;
          c = { id, name: speaker };
        }
        charId = c.id;
        speaker = c.name;
      }
      q.run('INSERT INTO segments(chapter_id, idx, type, character_id, speaker, text, emotion) VALUES (?, ?, ?, ?, ?, ?, ?)', chapterId, i, s.type, charId, speaker, s.text, s.emotion || '');
    });
    q.run(`UPDATE chapters SET split_status = 'done', split_error = ? WHERE id = ?`, warnings.length ? warnings.join('\n') : null, chapterId);
  });

  assignNovelNpcs(chapter.novel_id, { strict: false });
  if (settings.auto_assign_voice !== '0') {
    if (settings.ai_casting !== '0' && settings.llm_api_key && (mode || settings.split_mode) !== 'rule') await aiCasting(chapter.novel_id, settings, onProgress);
    for (const c of q.all('SELECT * FROM characters WHERE novel_id = ? AND is_narrator = 0', chapter.novel_id)) autoAssignVoice(c);
  }
  return warnings;
}

export function removeChapterAudio(chapter) {
  const dir = chapterDir(chapter);
  fs.rmSync(dir, { recursive: true, force: true });
  q.run('UPDATE chapters SET merged_audio = NULL, merged_lrc = NULL, merged_duration_ms = NULL WHERE id = ?', chapter.id);
}

// ---------------- 生成 ----------------
export function startGenerate(chapterIds, { force = false, segmentIds = null } = {}) {
  const chapters = chapterIds.map((id) => q.get('SELECT * FROM chapters WHERE id = ?', id)).filter(Boolean);
  if (!chapters.length) throw new Error('没有可生成的章节');
  if (chapters.some(c=>c.novel_id!==chapters[0].novel_id)) throw new Error('一次只能生成同一本小说');
  assertNotCompressing(chapters[0].novel_id);
  const novel = q.get('SELECT * FROM novels WHERE id = ?', chapters[0].novel_id);
  const settings = getSettings();
  const blocker = q.get("SELECT id,title,type,status FROM jobs WHERE novel_id = ? AND type IN ('identity','split','compress','generate') AND status IN ('queued','running') ORDER BY id LIMIT 1", novel.id);
  if(blocker) {
    const e=new Error(`本书正在${({identity:'统一角色身份',split:'拆分章节',compress:'整合旁白',generate:'生成音频'})[blocker.type]}（任务 #${blocker.id}：${blocker.title}），请等待任务完成或取消后再生成音频`);
    e.status=409;throw e;
  }
  if (!settings.minimax_api_key) throw new Error('未配置 MiniMax API Key（设置 → 语音合成）');

  assignNovelNpcs(novel.id);
  // 预检：对话角色是否都绑定了音色
  const plan = [];
  const missing = new Set();
  for (const c of chapters) {
    let segs = q.all('SELECT * FROM segments WHERE chapter_id = ? AND narration_omitted=0 ORDER BY idx', c.id);
    if (segmentIds) segs = segs.filter((s) => segmentIds.includes(s.id));
    for (const s of segs) {
      const v = resolveVoice(s, c);
      if (!v) { missing.add(s.speaker || '未知'); continue; }
      const key = genKey(s, v, settings);
      const upToDate = s.status === 'done' && s.gen_key === key && s.audio_file && fs.existsSync(path.join(AUDIO_DIR, s.audio_file));
      if (!force && upToDate) continue;
      plan.push({ seg: s, chapter: c, voice: v, key });
    }
  }
  if (missing.size) throw new Error(`以下角色还没有绑定音色：${[...missing].join('、')}`);
  const title = `生成《${novel.title}》${segmentIds ? `${segmentIds.length} 个片段` : chapters.length > 1 ? chapters.length + ' 章' : chapters[0].title}`;
  const jobId = createJob('generate', title, novel.id, chapters.map((c) => c.id), plan.length);
  for (const p of plan) q.run(`UPDATE segments SET status = 'queued', error = NULL WHERE id = ?`, p.seg.id);

  return enqueue('generate', jobId, async (signal) => {
    let done = 0, failed = 0, idx = 0;
    const conc = Math.min(10, Math.max(1, Number(settings.tts_concurrency) || 3));
    const worker = async () => {
      while (idx < plan.length) {
        const p = plan[idx++];
        if (signal.cancelled) { q.run(`UPDATE segments SET status = 'pending' WHERE id = ? AND status = 'queued'`, p.seg.id); continue; }
        try {
          await generateSegment(p, settings, novel);
          done++;
        } catch (e) {
          failed++;
          q.run(`UPDATE segments SET status = 'error', error = ? WHERE id = ?`, e.message, p.seg.id);
          if (/未配置|1004|2049|1008/.test(e.message)) signal.cancelled = true; // 鉴权/余额错误，停止整个任务
        }
        jobUpdate(jobId, { done, failed, message: `${done + failed}/${plan.length}` });
      }
    };
    await Promise.all(Array.from({ length: conc }, worker));
    for (const c of chapters) {
      try { buildMerged(c.id, novel, settings); } catch (e) { console.error('合并失败', e); }
    }
    return `成功 ${done}，失败 ${failed}${signal.cancelled ? '（已中止）' : ''}`;
  });
}

async function generateSegment({ seg, chapter, voice, key }, settings, novel) {
  q.run(`UPDATE segments SET status = 'running', error = NULL WHERE id = ?`, seg.id);
  const res = await synthesize(seg.text, { ...voice, emotion: seg.emotion }, settings);
  const durationMs = mp3DurationMs(res.audio) || res.durationMs || 0;
  const dir = chapterDir(chapter);
  fs.mkdirSync(dir, { recursive: true });
  const speaker = seg.type === 'narration' ? '旁白' : seg.speaker || '角色';
  const base = `${String(seg.idx + 1).padStart(4, '0')}_${safeName(speaker, 20)}`;
  // 清理旧文件
  for (const f of [seg.audio_file, seg.lrc_file]) if (f) fs.rmSync(path.join(AUDIO_DIR, f), { force: true });
  fs.writeFileSync(path.join(dir, base + '.mp3'), res.audio);
  const lines = buildSegmentLines(seg.text, durationMs, { maxLen: Number(settings.lrc_max_line_chars) || 28 });
  const lrc = formatLrc(lines, { title: `${chapter.title} #${seg.idx + 1}`, artist: speaker, album: novel.title, durationMs });
  fs.writeFileSync(path.join(dir, base + '.lrc'), lrc);
  const rel = path.relative(AUDIO_DIR, dir);
  q.run(
    `UPDATE segments SET status = 'done', error = NULL, audio_file = ?, lrc_file = ?, duration_ms = ?, gen_key = ?, updated_at = datetime('now','localtime') WHERE id = ?`,
    path.join(rel, base + '.mp3'), path.join(rel, base + '.lrc'), durationMs, key, seg.id
  );
}

function stripTags(buf) {
  let s = 0, e = buf.length;
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    s = 10 + (((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f));
  }
  if (e - s > 128 && buf.toString('latin1', e - 128, e - 125) === 'TAG') e -= 128;
  return buf.subarray(s, e);
}

/** 整章合并：所有片段都完成时拼接 MP3 并生成整章 LRC */
export function buildMerged(chapterId, novel, settings = getSettings()) {
  const chapter = q.get('SELECT * FROM chapters WHERE id = ?', chapterId);
  if (!chapter || settings.build_merged === '0') return false;
  const segs = q.all('SELECT * FROM segments WHERE chapter_id = ? AND narration_omitted=0 ORDER BY idx', chapterId);
  if (!segs.length || segs.some((s) => s.status !== 'done' || !s.audio_file)) return false;
  novel = novel || q.get('SELECT * FROM novels WHERE id = ?', chapter.novel_id);
  const bufs = [];
  const lines = [];
  let offset = 0;
  const maxLen = Number(settings.lrc_max_line_chars) || 28;
  for (const s of segs) {
    const p = path.join(AUDIO_DIR, s.audio_file);
    if (!fs.existsSync(p)) return false;
    const b = stripTags(fs.readFileSync(p));
    bufs.push(b);
    const dur = s.duration_ms || mp3DurationMs(b);
    const prefix = settings.lrc_speaker_prefix === '1' && s.type === 'dialogue' ? `${s.speaker}：` : '';
    lines.push(...buildSegmentLines(s.text, dur, { offsetMs: offset, maxLen, prefix }));
    offset += dur;
  }
  const dir = chapterDir(chapter);
  fs.mkdirSync(dir, { recursive: true });
  const base = `${String(chapter.idx + 1).padStart(4, '0')}_${safeName(chapter.title, 30)}_整章`;
  fs.writeFileSync(path.join(dir, base + '.mp3'), Buffer.concat(bufs));
  fs.writeFileSync(path.join(dir, base + '.lrc'), formatLrc(lines, { title: chapter.title, artist: novel.author || '', album: novel.title, durationMs: offset }));
  const rel = path.relative(AUDIO_DIR, dir);
  q.run('UPDATE chapters SET merged_audio = ?, merged_lrc = ?, merged_duration_ms = ? WHERE id = ?', path.join(rel, base + '.mp3'), path.join(rel, base + '.lrc'), offset, chapterId);
  return true;
}

// ---------------- 试听 ----------------
export async function previewVoice(voiceId, { text, speed = 1, vol = 1, pitch = 0, emotion = '' } = {}) {
  const settings = getSettings();
  text = (text || settings.preview_text || '你好').slice(0, 300);
  const h = crypto.createHash('md5').update([voiceId, text, speed, vol, pitch, emotion, settings.tts_model].join('|')).digest('hex').slice(0, 16);
  const file = `${safeName(voiceId, 60)}_${h}.mp3`;
  const full = path.join(PREVIEW_DIR, file);
  if (!fs.existsSync(full)) {
    const res = await synthesizeOnce(text, { voice_id: voiceId, speed, vol, pitch, emotion }, settings);
    fs.writeFileSync(full, res.audio);
  }
  return '/previews/' + encodeURIComponent(file);
}
