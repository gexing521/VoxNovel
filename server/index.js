import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { q, tx, updateFields, getSettings, setSettings, publicSettings, DATA_DIR } from './db.js';
import { detectChapters } from './splitter.js';
import { fetchVoices, synthesizeOnce } from './minimax.js';
import { chat, listModels } from './llm.js';
import { guessGender } from './voices-seed.js';
import {
  AUDIO_DIR, PREVIEW_DIR, ensureNarrator, startSplit, startGenerate, cancelJob, previewVoice,
  removeChapterAudio, buildMerged, findCharacterByName, autoAssignVoice, resolveVoice, safeName, startReconcile,
} from './jobs.js';
import { streamZip } from './zip.js';
import { fetchChapter } from './fetcher.js';
import { getIdentityReport } from './identity.js';
import { describeNpc, isNpc, npcVoice, assignNovelNpcs, listPools, assertIdle, invalidateCharacterAudio } from './npc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('nvs:' + APP_PASSWORD + DATA_DIR).digest('hex');

// ---------------- 小工具 ----------------
class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
const bad = (msg) => { throw new HttpError(400, msg); };
const notFound = (msg = '不存在') => { throw new HttpError(404, msg); };

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 60 * 1024 * 1024) throw new HttpError(413, '请求体过大（上限 60MB）');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { bad('JSON 格式错误'); }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.mp3': 'audio/mpeg', '.lrc': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

function serveFile(req, res, file, extraHeaders = {}) {
  let st;
  try { st = fs.statSync(file); } catch { return send(res, 404, 'Not Found'); }
  if (!st.isFile()) return send(res, 404, 'Not Found');
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', ...extraHeaders };
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    let start = m && m[1] ? Number(m[1]) : 0;
    let end = m && m[2] ? Number(m[2]) : st.size - 1;
    if (m && !m[1] && m[2]) { start = st.size - Number(m[2]); end = st.size - 1; }
    if (start >= st.size || end >= st.size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...base, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

/** 防目录穿越 */
function safeJoin(root, rel) {
  const p = path.resolve(root, '.' + path.sep + rel);
  if (!p.startsWith(path.resolve(root) + path.sep) && p !== path.resolve(root)) return null;
  return p;
}

// ---------------- 鉴权 ----------------
const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('hex').slice(0, 32);
function makeToken() {
  const exp = Date.now() + 30 * 24 * 3600 * 1000;
  return `${exp}.${sign(String(exp))}`;
}
function checkToken(t) {
  if (!t) return false;
  const [exp, sig] = t.split('.');
  return sig && sign(exp) === sig && Number(exp) > Date.now();
}
function cookies(req) {
  const out = {};
  for (const p of (req.headers.cookie || '').split(';')) {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  }
  return out;
}
const authed = (req) => !APP_PASSWORD || checkToken(cookies(req).nvs_token);

// ---------------- 路由 ----------------
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
  routes.push({ method, re, keys, handler });
};

// --- 鉴权 ---
route('GET', '/api/auth', (req) => ({ required: !!APP_PASSWORD, ok: authed(req) }));
route('POST', '/api/login', async (req, res, p, body) => {
  if (!APP_PASSWORD) return { ok: true };
  const a = Buffer.from(String(body.password || ''));
  const b = Buffer.from(APP_PASSWORD);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, '密码错误');
  res.setHeader('Set-Cookie', `nvs_token=${makeToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`);
  return { ok: true };
});
route('POST', '/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'nvs_token=; Path=/; Max-Age=0');
  return { ok: true };
});

// --- 设置 ---
route('GET', '/api/settings', () => publicSettings());
route('PUT', '/api/settings', (req, res, p, body) => { setSettings(body); return publicSettings(); });
route('POST', '/api/settings/test-llm', async () => {
  const s = getSettings();
  const t0 = Date.now();
  const { content } = await chat(s, [{ role: 'user', content: '请只回复 JSON：{"ok":true}' }], { json: true });
  return { ok: true, ms: Date.now() - t0, reply: content.slice(0, 200) };
});
route('GET', '/api/settings/llm-models', async () => ({ models: await listModels(getSettings()) }));
route('POST', '/api/fetch-url', async (req, res, p, body) => fetchChapter(String(body.url || '').trim()));
route('POST', '/api/settings/test-tts', async () => {
  const s = getSettings();
  const t0 = Date.now();
  const r = await synthesizeOnce('测试', { voice_id: s.default_narrator_voice }, s);
  return { ok: true, ms: Date.now() - t0, bytes: r.audio.length };
});

// --- 小说 ---
route('GET', '/api/novels', () =>
  q.all(`SELECT n.*,
    (SELECT COUNT(*) FROM chapters c WHERE c.novel_id = n.id) AS chapter_count,
    (SELECT COUNT(*) FROM characters ch WHERE ch.novel_id = n.id AND ch.is_narrator = 0) AS character_count,
    (SELECT COUNT(*) FROM segments s JOIN chapters c ON c.id = s.chapter_id WHERE c.novel_id = n.id) AS segment_count,
    (SELECT COUNT(*) FROM segments s JOIN chapters c ON c.id = s.chapter_id WHERE c.novel_id = n.id AND s.status = 'done') AS done_count,
    (SELECT COALESCE(SUM(LENGTH(content)),0) FROM chapters c WHERE c.novel_id = n.id) AS char_count
    FROM novels n ORDER BY n.updated_at DESC, n.id DESC`)
);
route('POST', '/api/novels', (req, res, p, body) => {
  if (!body.title?.trim()) bad('请填写书名');
  const id = tx(() => {
    const nid = q.run('INSERT INTO novels(title, author, description) VALUES (?, ?, ?)', body.title.trim(), body.author || '', body.description || '').id;
    insertChapters(nid, body.content, body.autoDetect !== false, body.chapterTitle);
    return nid;
  });
  ensureNarrator(id);
  return q.get('SELECT * FROM novels WHERE id = ?', id);
});
function insertChapters(novelId, content, autoDetect = true, title) {
  if (!content || !String(content).trim()) return 0;
  const list = autoDetect ? detectChapters(content) : [{ title: title || '新章节', content: String(content).trim() }];
  const max = q.get('SELECT COALESCE(MAX(idx), -1) AS m FROM chapters WHERE novel_id = ?', novelId).m;
  list.forEach((c, i) => q.run('INSERT INTO chapters(novel_id, idx, title, content) VALUES (?, ?, ?, ?)', novelId, max + 1 + i, c.title, c.content));
  q.run(`UPDATE novels SET updated_at = datetime('now','localtime') WHERE id = ?`, novelId);
  return list.length;
}
route('GET', '/api/novels/:id', (req, res, { id }) => {
  const n = q.get('SELECT * FROM novels WHERE id = ?', id) || notFound();
  n.chapters = q.all(`SELECT c.id, c.idx, c.title, c.split_status, c.split_error, c.merged_audio, c.merged_lrc, c.merged_duration_ms, LENGTH(c.content) AS length,
      (SELECT COUNT(*) FROM segments s WHERE s.chapter_id = c.id) AS segment_count,
      (SELECT COUNT(*) FROM segments s WHERE s.chapter_id = c.id AND s.status = 'done') AS done_count,
      (SELECT COUNT(*) FROM segments s WHERE s.chapter_id = c.id AND s.status = 'error') AS error_count
    FROM chapters c WHERE c.novel_id = ? ORDER BY c.idx, c.id`, id);
  return n;
});
route('PUT', '/api/novels/:id', (req, res, { id }, body) => {
  q.get('SELECT id FROM novels WHERE id = ?', id) || notFound();
  return tx(() => {
    if ('npc_pool_id' in body) {
      assertIdle(Number(id));
      if (body.npc_pool_id !== null && (!Number.isSafeInteger(body.npc_pool_id) || !q.get('SELECT id FROM npc_pools WHERE id = ?', body.npc_pool_id))) bad('NPC 音色合集不存在');
      q.run('UPDATE novels SET npc_pool_id = ? WHERE id = ?', body.npc_pool_id, id);
      // 更换合集时更新声音；清空某一性别的合集时允许保存，生成前会明确提示。
      for (const c of q.all('SELECT * FROM characters WHERE novel_id = ?', id).filter(isNpc)) npcVoice(c, { strict: false });
    }
    updateFields('novels', id, body, ['title', 'author', 'description']);
    return q.get('SELECT * FROM novels WHERE id = ?', id);
  });
});
route('DELETE', '/api/novels/:id', (req, res, { id }) => {
  q.run('DELETE FROM novels WHERE id = ?', id);
  fs.rmSync(path.join(AUDIO_DIR, `novel_${Number(id)}`), { recursive: true, force: true });
  return { ok: true };
});
route('POST', '/api/novels/:id/chapters', (req, res, { id }, body) => {
  q.get('SELECT id FROM novels WHERE id = ?', id) || notFound();
  return { added: insertChapters(Number(id), body.content, body.autoDetect !== false, body.title) };
});
route('POST', '/api/novels/:id/split', (req, res, { id }, body) => {
  let ids = body.chapterIds;
  if (!ids?.length) {
    ids = q.all(`SELECT id FROM chapters WHERE novel_id = ? ${body.onlyNew ? "AND split_status != 'done'" : ''} ORDER BY idx`, id).map((r) => r.id);
  }
  return { jobId: startSplit(ids, { mode: body.mode, reconcile: body.reconcile }) };
});
route('POST', '/api/novels/:id/npc-assign', (req, res, { id }, body) => {
  q.get('SELECT id FROM novels WHERE id = ?', id) || notFound();
  assertIdle(Number(id));
  return assignNovelNpcs(Number(id), { reroll: body.reroll === true });
});
route('GET', '/api/novels/:id/identities', (req, res, { id }) => {
  q.get('SELECT id FROM novels WHERE id = ?', id) || notFound();
  return { report: getIdentityReport(Number(id)) };
});
route('POST', '/api/novels/:id/reconcile', (req, res, { id }) => {
  q.get('SELECT id FROM novels WHERE id = ?', id) || notFound();
  return { jobId: startReconcile(Number(id)) };
});
route('POST', '/api/novels/:id/generate', (req, res, { id }, body) => {
  const ids = body.chapterIds?.length ? body.chapterIds : q.all(`SELECT id FROM chapters WHERE novel_id = ? AND split_status = 'done' ORDER BY idx`, id).map((r) => r.id);
  return { jobId: startGenerate(ids, { force: !!body.force }) };
});
route('GET', '/api/novels/:id/download', async (req, res, { id }) => {
  const n = q.get('SELECT * FROM novels WHERE id = ?', id) || notFound();
  const chs = q.all('SELECT * FROM chapters WHERE novel_id = ? ORDER BY idx', id);
  const files = chs.flatMap((c) => chapterFiles(c, `${safeName(n.title)}/${String(c.idx + 1).padStart(4, '0')}_${safeName(c.title)}/`));
  return zipResponse(res, `${safeName(n.title)}.zip`, files);
});

// --- 章节 ---
route('GET', '/api/chapters/:id', (req, res, { id }) => {
  const c = q.get('SELECT * FROM chapters WHERE id = ?', id) || notFound();
  c.novel = q.get('SELECT id, title, author FROM novels WHERE id = ?', c.novel_id);
  c.segments = q.all('SELECT * FROM segments WHERE chapter_id = ? ORDER BY idx, id', id);
  const vcache = {};
  for (const s of c.segments) {
    const v = resolveVoice(s, c);
    s.voice = v ? { voice_id: v.voice_id, name: v.name } : null;
    vcache[s.id] = 1;
  }
  c.characters = characterList(c.novel_id);
  const nav = q.all('SELECT id, idx, title FROM chapters WHERE novel_id = ? ORDER BY idx, id', c.novel_id);
  const pos = nav.findIndex((x) => x.id === c.id);
  c.prev = nav[pos - 1] || null;
  c.next = nav[pos + 1] || null;
  return c;
});
route('PUT', '/api/chapters/:id', (req, res, { id }, body) => {
  updateFields('chapters', id, body, ['title', 'content', 'idx']);
  return q.get('SELECT id, title, idx FROM chapters WHERE id = ?', id);
});
route('DELETE', '/api/chapters/:id', (req, res, { id }) => {
  const c = q.get('SELECT * FROM chapters WHERE id = ?', id) || notFound();
  removeChapterAudio(c);
  q.run('DELETE FROM chapters WHERE id = ?', id);
  return { ok: true };
});
route('POST', '/api/chapters/:id/split', (req, res, { id }, body) => ({ jobId: startSplit([Number(id)], { mode: body.mode, reconcile: body.reconcile }) }));
route('POST', '/api/chapters/:id/generate', (req, res, { id }, body) => ({
  jobId: startGenerate([Number(id)], { force: !!body.force, segmentIds: body.segmentIds?.length ? body.segmentIds.map(Number) : null }),
}));
route('POST', '/api/chapters/:id/merge', (req, res, { id }) => ({ ok: buildMerged(Number(id)) }));
route('GET', '/api/chapters/:id/download', async (req, res, { id }) => {
  const c = q.get('SELECT * FROM chapters WHERE id = ?', id) || notFound();
  const n = q.get('SELECT * FROM novels WHERE id = ?', c.novel_id);
  return zipResponse(res, `${safeName(n.title)}_${safeName(c.title)}.zip`, chapterFiles(c, ''));
});
route('POST', '/api/chapters/:id/segments', (req, res, { id }, body) => {
  // 插入片段：after = 在哪个 idx 之后
  const c = q.get('SELECT * FROM chapters WHERE id = ?', id) || notFound();
  const after = body.after == null ? -1 : Number(body.after);
  const r = tx(() => {
    q.run('UPDATE segments SET idx = idx + 1 WHERE chapter_id = ? AND idx > ?', id, after);
    const ch = body.type === 'dialogue' && body.character_id ? q.get('SELECT * FROM characters WHERE id = ?', body.character_id) : null;
    return q.run('INSERT INTO segments(chapter_id, idx, type, character_id, speaker, text) VALUES (?, ?, ?, ?, ?, ?)',
      id, after + 1, ch ? 'dialogue' : 'narration', ch?.id ?? null, ch?.name ?? '', body.text || '（新片段）').id;
  });
  invalidateMerged(c.id);
  return q.get('SELECT * FROM segments WHERE id = ?', r);
});

// --- 片段 ---
route('PUT', '/api/segments/:id', (req, res, { id }, body) => {
  const s = q.get('SELECT * FROM segments WHERE id = ?', id) || notFound();
  const chapter = q.get('SELECT * FROM chapters WHERE id = ?', s.chapter_id);
  const data = {};
  if (body.text != null) data.text = String(body.text);
  if (body.emotion != null) data.emotion = String(body.emotion);
  if ('voice_override' in body) data.voice_override = body.voice_override || null;
  if ('character_id' in body || body.speaker != null) {
    let ch = null;
    if (body.character_id) ch = q.get('SELECT * FROM characters WHERE id = ? AND novel_id = ?', body.character_id, chapter.novel_id);
    else if (body.speaker) {
      ch = findCharacterByName(chapter.novel_id, body.speaker.trim(), chapter.id);
      if (!ch) {
        const cid = q.run('INSERT INTO characters(novel_id, name) VALUES (?, ?)', chapter.novel_id, body.speaker.trim()).id;
        ch = q.get('SELECT * FROM characters WHERE id = ?', cid);
        if (getSettings().auto_assign_voice !== '0') autoAssignVoice(ch);
      }
    }
    if (!ch || ch.is_narrator) Object.assign(data, { type: 'narration', character_id: null, speaker: '' });
    else Object.assign(data, { type: 'dialogue', character_id: ch.id, speaker: ch.name });
  }
  updateFields('segments', id, data, ['text', 'emotion', 'voice_override', 'type', 'character_id', 'speaker']);
  invalidateMerged(s.chapter_id);
  const ns = q.get('SELECT * FROM segments WHERE id = ?', id);
  const v = resolveVoice(ns, chapter);
  ns.voice = v ? { voice_id: v.voice_id, name: v.name } : null;
  return ns;
});
route('DELETE', '/api/segments/:id', (req, res, { id }) => {
  const s = q.get('SELECT * FROM segments WHERE id = ?', id) || notFound();
  for (const f of [s.audio_file, s.lrc_file]) if (f) fs.rmSync(path.join(AUDIO_DIR, f), { force: true });
  tx(() => {
    q.run('DELETE FROM segments WHERE id = ?', id);
    q.run('UPDATE segments SET idx = idx - 1 WHERE chapter_id = ? AND idx > ?', s.chapter_id, s.idx);
  });
  invalidateMerged(s.chapter_id);
  return { ok: true };
});
route('POST', '/api/segments/:id/merge-next', (req, res, { id }) => {
  const s = q.get('SELECT * FROM segments WHERE id = ?', id) || notFound();
  const n = q.get('SELECT * FROM segments WHERE chapter_id = ? AND idx = ?', s.chapter_id, s.idx + 1) || bad('已经是最后一个片段');
  tx(() => {
    q.run(`UPDATE segments SET text = ?, status = 'pending' WHERE id = ?`, s.text + (s.type === 'narration' ? '' : '') + n.text, s.id);
    q.run('DELETE FROM segments WHERE id = ?', n.id);
    q.run('UPDATE segments SET idx = idx - 1 WHERE chapter_id = ? AND idx > ?', s.chapter_id, n.idx);
  });
  invalidateMerged(s.chapter_id);
  return { ok: true };
});
function invalidateMerged(chapterId) {
  q.run('UPDATE chapters SET merged_audio = NULL, merged_lrc = NULL, merged_duration_ms = NULL WHERE id = ?', chapterId);
}

// --- 角色 ---
function characterList(novelId) {
  const rows = novelId
    ? q.all(`SELECT c.*, n.title AS novel_title, (SELECT COUNT(*) FROM segments s WHERE s.character_id = c.id) AS line_count
             FROM characters c LEFT JOIN novels n ON n.id = c.novel_id WHERE c.novel_id = ? ORDER BY c.is_narrator DESC, line_count DESC, c.id`, novelId)
    : q.all(`SELECT c.*, n.title AS novel_title, (SELECT COUNT(*) FROM segments s WHERE s.character_id = c.id) AS line_count
             FROM characters c LEFT JOIN novels n ON n.id = c.novel_id ORDER BY c.novel_id DESC, c.is_narrator DESC, line_count DESC, c.id`);
  const binds = q.all(`SELECT cv.*, v.voice_id AS vid, v.name AS vname, v.gender AS vgender FROM character_voices cv JOIN voices v ON v.id = cv.voice_id ORDER BY cv.is_default DESC, cv.created_at`);
  const map = {};
  for (const b of binds) (map[b.character_id] ||= []).push({ id: b.voice_id, voice_id: b.vid, name: b.vname, gender: b.vgender, is_default: b.is_default, speed: b.speed, vol: b.vol, pitch: b.pitch });
  for (const r of rows) r.voices = map[r.id] || [];
  return rows.map(describeNpc);
}
route('GET', '/api/characters', (req, res, p, body, url) => {
  let list = characterList(url.searchParams.get('novel_id') ? Number(url.searchParams.get('novel_id')) : null);
  const kw = (url.searchParams.get('q') || '').trim();
  if (kw) list = list.filter((c) => [c.name, c.aliases, c.description, c.novel_title].join(' ').includes(kw));
  return list;
});
route('POST', '/api/characters', (req, res, p, body) => {
  if (!body.name?.trim()) bad('请填写角色名');
  if (body.novel_id && findCharacterByName(body.novel_id, body.name.trim())) bad('该小说中已存在同名角色');
  validateRoleType(body);
  if (body.novel_id) assertIdle(Number(body.novel_id));
  const id = q.run('INSERT INTO characters(novel_id, name, aliases, gender, age, description, role_type) VALUES (?, ?, ?, ?, ?, ?, ?)',
    body.novel_id || null, body.name.trim(), body.aliases || '', body.gender || '', body.age || '', body.description || '', body.role_type || 'auto').id;
  npcVoice(q.get('SELECT * FROM characters WHERE id = ?', id), { strict: false });
  return describeNpc(q.get('SELECT * FROM characters WHERE id = ?', id));
});
function validateRoleType(body) {
  if ('role_type' in body && !['auto', 'named', 'npc'].includes(body.role_type)) bad('角色类型无效');
  if ('gender' in body && !['', 'male', 'female'].includes(body.gender)) bad('性别无效');
}
route('PUT', '/api/characters/:id', (req, res, { id }, body) => {
  const c = q.get('SELECT * FROM characters WHERE id = ?', id) || notFound();
  validateRoleType(body);
  if (['role_type', 'gender', 'name'].some(k => k in body)) assertIdle(c.novel_id);
  return tx(() => {
    updateFields('characters', id, body, ['name', 'aliases', 'gender', 'age', 'description', 'role_type']);
    if (body.name && body.name !== c.name) q.run('UPDATE segments SET speaker = ? WHERE character_id = ?', body.name, id);
    const fresh = q.get('SELECT * FROM characters WHERE id = ?', id);
    if (isNpc(c) !== isNpc(fresh)) invalidateCharacterAudio(id);
    if (isNpc(fresh)) npcVoice(fresh, { strict: false });
    else q.run('DELETE FROM npc_assignments WHERE character_id = ?', id);
    return describeNpc(fresh);
  });
});
route('DELETE', '/api/characters/:id', (req, res, { id }) => {
  const c = q.get('SELECT * FROM characters WHERE id = ?', id) || notFound();
  if (c.is_narrator) bad('旁白角色不能删除');
  q.run(`UPDATE segments SET type = 'narration', character_id = NULL, speaker = '' WHERE character_id = ?`, id);
  q.run('DELETE FROM characters WHERE id = ?', id);
  return { ok: true };
});
route('POST', '/api/characters/:id/merge', (req, res, { id }, body) => {
  // 把当前角色合并到 target（台词、别名、音色绑定转移）
  const src = q.get('SELECT * FROM characters WHERE id = ?', id) || notFound();
  const dst = q.get('SELECT * FROM characters WHERE id = ?', body.targetId) || notFound('目标角色不存在');
  if (src.id === dst.id || src.is_narrator) bad('无法合并');
  tx(() => {
    q.run('UPDATE segments SET character_id = ?, speaker = ? WHERE character_id = ?', dst.id, dst.name, src.id);
    const al = new Set([...(dst.aliases || '').split(/[,，、\s]+/), src.name, ...(src.aliases || '').split(/[,，、\s]+/)].filter((x) => x && x !== dst.name));
    q.run('UPDATE characters SET aliases = ? WHERE id = ?', [...al].join(','), dst.id);
    q.run('INSERT OR IGNORE INTO character_voices(character_id, voice_id, is_default, speed, vol, pitch) SELECT ?, voice_id, 0, speed, vol, pitch FROM character_voices WHERE character_id = ?', dst.id, src.id);
    q.run('UPDATE character_alias_scopes SET character_id = ? WHERE character_id = ?', dst.id, src.id);
    q.run('DELETE FROM characters WHERE id = ?', src.id);
  });
  return { ok: true };
});
route('POST', '/api/characters/:id/voices', (req, res, { id }, body) => {
  q.get('SELECT id FROM characters WHERE id = ?', id) || notFound();
  let v = body.voice_db_id ? q.get('SELECT * FROM voices WHERE id = ?', body.voice_db_id) : q.get('SELECT * FROM voices WHERE voice_id = ?', body.voice_id);
  if (!v && body.voice_id) {
    const vid = q.run(`INSERT INTO voices(voice_id, name, source, gender) VALUES (?, ?, 'custom', ?)`, body.voice_id, body.voice_id, guessGender(body.voice_id)).id;
    v = q.get('SELECT * FROM voices WHERE id = ?', vid);
  }
  if (!v) bad('音色不存在');
  tx(() => {
    const has = q.get('SELECT 1 FROM character_voices WHERE character_id = ?', id);
    const makeDefault = body.is_default !== false || !has;
    if (makeDefault) q.run('UPDATE character_voices SET is_default = 0 WHERE character_id = ?', id);
    q.run(`INSERT INTO character_voices(character_id, voice_id, is_default, speed, vol, pitch) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(character_id, voice_id) DO UPDATE SET is_default = excluded.is_default, speed = excluded.speed, vol = excluded.vol, pitch = excluded.pitch`,
      id, v.id, makeDefault ? 1 : 0, body.speed ?? 1, body.vol ?? 1, body.pitch ?? 0);
  });
  return { ok: true };
});
route('PUT', '/api/characters/:id/voices/:vid', (req, res, { id, vid }, body) => {
  tx(() => {
    if (body.is_default) q.run('UPDATE character_voices SET is_default = 0 WHERE character_id = ?', id);
    const data = {};
    for (const k of ['speed', 'vol', 'pitch']) if (body[k] != null) data[k] = Number(body[k]);
    if (body.is_default != null) data.is_default = body.is_default ? 1 : 0;
    const keys = Object.keys(data);
    if (keys.length) q.run(`UPDATE character_voices SET ${keys.map((k) => k + ' = ?').join(', ')} WHERE character_id = ? AND voice_id = ?`, ...keys.map((k) => data[k]), id, vid);
  });
  return { ok: true };
});
route('DELETE', '/api/characters/:id/voices/:vid', (req, res, { id, vid }) => {
  const was = q.get('SELECT is_default FROM character_voices WHERE character_id = ? AND voice_id = ?', id, vid);
  q.run('DELETE FROM character_voices WHERE character_id = ? AND voice_id = ?', id, vid);
  if (was?.is_default) q.run('UPDATE character_voices SET is_default = 1 WHERE rowid = (SELECT rowid FROM character_voices WHERE character_id = ? ORDER BY created_at LIMIT 1)', id);
  return { ok: true };
});

// --- NPC 音色合集 ---
const requirePool = id => q.get('SELECT * FROM npc_pools WHERE id = ?', id) || notFound('NPC 音色合集不存在');
const refreshNpcVoices = () => {
  for (const c of q.all('SELECT * FROM characters WHERE is_narrator = 0').filter(isNpc)) npcVoice(c, { strict: false });
};
route('GET', '/api/npc-pools', () => listPools());
route('POST', '/api/npc-pools', (req, res, p, body) => {
  const name = String(body.name || '').trim();
  if (!name || name.length > 80) bad('合集名称需为 1–80 个字符');
  const id = q.run('INSERT INTO npc_pools(name) VALUES (?)', name).id;
  return { id, name, voices: [] };
});
route('PUT', '/api/npc-pools/:id', (req, res, { id }, body) => {
  requirePool(id);
  const name = String(body.name || '').trim();
  if (!name || name.length > 80) bad('合集名称需为 1–80 个字符');
  q.run('UPDATE npc_pools SET name = ? WHERE id = ?', name, id);
  return listPools().find(p => p.id === Number(id));
});
route('DELETE', '/api/npc-pools/:id', (req, res, { id }) => {
  requirePool(id); assertIdle();
  if (q.get('SELECT COUNT(*) n FROM npc_pools').n <= 1) bad('至少保留一个 NPC 音色合集');
  return tx(() => {
    for (const a of q.all('SELECT character_id FROM npc_assignments WHERE pool_id = ?', id)) invalidateCharacterAudio(a.character_id);
    q.run('DELETE FROM npc_pools WHERE id = ?', id);
    refreshNpcVoices();
    return { ok: true };
  });
});
route('POST', '/api/npc-pools/:id/voices', (req, res, { id }, body) => {
  requirePool(id); assertIdle();
  if (!['male', 'female'].includes(body.gender)) bad('请选择男 NPC 或女 NPC');
  if (!q.get('SELECT id FROM voices WHERE id = ?', body.voice_db_id)) bad('音色不存在');
  return tx(() => {
    q.run('INSERT INTO npc_pool_voices(pool_id,voice_id,gender) VALUES (?,?,?) ON CONFLICT(pool_id,voice_id) DO UPDATE SET gender=excluded.gender', id, body.voice_db_id, body.gender);
    refreshNpcVoices();
    return { ok: true };
  });
});
route('DELETE', '/api/npc-pools/:id/voices/:vid', (req, res, { id, vid }) => {
  requirePool(id); assertIdle();
  return tx(() => {
    q.run('DELETE FROM npc_pool_voices WHERE pool_id = ? AND voice_id = ?', id, vid);
    refreshNpcVoices();
    return { ok: true };
  });
});

// --- 音色 ---
route('GET', '/api/voices', () =>
  q.all(`SELECT v.*, (SELECT COUNT(*) FROM character_voices cv WHERE cv.voice_id = v.id) AS bind_count,
    (SELECT GROUP_CONCAT(c.name || CASE WHEN n.title IS NOT NULL THEN '（' || n.title || '）' ELSE '' END, '、')
       FROM character_voices cv JOIN characters c ON c.id = cv.character_id LEFT JOIN novels n ON n.id = c.novel_id WHERE cv.voice_id = v.id) AS bound_to
    FROM voices v ORDER BY v.favorite DESC, CASE v.source WHEN 'cloning' THEN 0 WHEN 'generation' THEN 1 WHEN 'custom' THEN 2 ELSE 3 END, v.id`)
);
route('POST', '/api/voices', (req, res, p, body) => {
  if (!body.voice_id?.trim()) bad('请填写 voice_id');
  if (q.get('SELECT 1 FROM voices WHERE voice_id = ?', body.voice_id.trim())) bad('该 voice_id 已存在');
  const id = q.run(`INSERT INTO voices(voice_id, name, description, gender, tags, source) VALUES (?, ?, ?, ?, ?, 'custom')`,
    body.voice_id.trim(), body.name || body.voice_id.trim(), body.description || '', body.gender || guessGender(body.voice_id + (body.name || '')), body.tags || '').id;
  return q.get('SELECT * FROM voices WHERE id = ?', id);
});
route('PUT', '/api/voices/:id', (req, res, { id }, body) => {
  updateFields('voices', id, body, ['name', 'description', 'gender', 'tags', 'favorite']);
  return q.get('SELECT * FROM voices WHERE id = ?', id);
});
route('DELETE', '/api/voices/:id', (req, res, { id }) => {
  assertIdle();
  return tx(() => {
    for (const a of q.all('SELECT character_id FROM npc_assignments WHERE voice_id = ?', id)) invalidateCharacterAudio(a.character_id);
    q.run('DELETE FROM voices WHERE id = ?', id);
    refreshNpcVoices();
    return { ok: true };
  });
});
route('POST', '/api/voices/sync', async () => {
  const list = await fetchVoices(getSettings());
  let added = 0, updated = 0;
  tx(() => {
    for (const v of list) {
      const ex = q.get('SELECT * FROM voices WHERE voice_id = ?', v.voice_id);
      if (ex) {
        q.run(`UPDATE voices SET name = CASE WHEN name = '' OR name = voice_id THEN ? ELSE name END, description = CASE WHEN description = '' THEN ? ELSE description END,
               gender = CASE WHEN gender = '' THEN ? ELSE gender END, source = CASE WHEN source = 'custom' THEN ? ELSE source END WHERE id = ?`,
          v.name, v.description, v.gender, v.source, ex.id);
        updated++;
      } else {
        q.run('INSERT INTO voices(voice_id, name, description, gender, source) VALUES (?, ?, ?, ?, ?)', v.voice_id, v.name, v.description, v.gender, v.source);
        added++;
      }
    }
  });
  return { total: list.length, added, updated };
});
route('POST', '/api/voices/preview', async (req, res, p, body) => {
  if (!body.voice_id) bad('缺少 voice_id');
  return { url: await previewVoice(body.voice_id, body) };
});

// --- 任务 ---
route('GET', '/api/jobs', (req, res, p, body, url) => {
  const active = url.searchParams.get('active');
  return q.all(`SELECT * FROM jobs ${active ? "WHERE status IN ('queued','running')" : ''} ORDER BY id DESC LIMIT 100`);
});
route('GET', '/api/jobs/:id', (req, res, { id }) => q.get('SELECT * FROM jobs WHERE id = ?', id) || notFound());
route('POST', '/api/jobs/:id/cancel', (req, res, { id }) => { cancelJob(Number(id)); return { ok: true }; });
route('DELETE', '/api/jobs', () => { q.run(`DELETE FROM jobs WHERE status NOT IN ('queued','running')`); return { ok: true }; });

// --- 下载辅助 ---
function chapterFiles(c, prefix) {
  const files = [];
  for (const s of q.all(`SELECT * FROM segments WHERE chapter_id = ? AND status = 'done' ORDER BY idx`, c.id)) {
    if (s.audio_file) files.push({ name: prefix + path.basename(s.audio_file), path: path.join(AUDIO_DIR, s.audio_file) });
    if (s.lrc_file) files.push({ name: prefix + path.basename(s.lrc_file), path: path.join(AUDIO_DIR, s.lrc_file) });
  }
  if (c.merged_audio) files.push({ name: prefix + path.basename(c.merged_audio), path: path.join(AUDIO_DIR, c.merged_audio) });
  if (c.merged_lrc) files.push({ name: prefix + path.basename(c.merged_lrc), path: path.join(AUDIO_DIR, c.merged_lrc) });
  return files;
}
async function zipResponse(res, filename, files) {
  if (!files.length) bad('还没有已生成的音频');
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="download.zip"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  });
  await streamZip(res, files);
  return undefined;
}

// ---------------- 服务器 ----------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  try {
    if (pathname.startsWith('/api/')) {
      if (!['/api/auth', '/api/login'].includes(pathname) && !authed(req)) throw new HttpError(401, '未登录');
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = pathname.match(r.re);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
        const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
        const out = await r.handler(req, res, params, body, url);
        if (out !== undefined && !res.headersSent) send(res, 200, out);
        return;
      }
      throw new HttpError(404, '接口不存在');
    }
    if (pathname.startsWith('/files/') || pathname.startsWith('/previews/')) {
      if (!authed(req)) return send(res, 401, 'Unauthorized');
      const isFiles = pathname.startsWith('/files/');
      const root = isFiles ? AUDIO_DIR : PREVIEW_DIR;
      const file = safeJoin(root, pathname.slice(isFiles ? 7 : 10));
      if (!file) return send(res, 403, 'Forbidden');
      const headers = url.searchParams.get('dl') ? { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}` } : {};
      return serveFile(req, res, file, headers);
    }
    // 静态资源 / SPA
    let file = safeJoin(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
    if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, 'index.html');
    return serveFile(req, res, file);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: e.message || String(e) });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`小说有声工坊已启动： http://localhost:${PORT}`);
  console.log(`数据目录：${DATA_DIR}${APP_PASSWORD ? '（已启用访问密码）' : '（未设置 APP_PASSWORD，任何人可访问）'}`);
});
