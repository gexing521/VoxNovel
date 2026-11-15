import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { SEED_VOICES, guessGender } from './voices-seed.js';
import { DEFAULT_SETTINGS } from './defaults.js';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS novels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  author TEXT DEFAULT '',
  description TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL DEFAULT 0,
  title TEXT DEFAULT '',
  content TEXT DEFAULT '',
  split_status TEXT DEFAULT 'none',
  split_error TEXT,
  merged_audio TEXT,
  merged_lrc TEXT,
  merged_duration_ms INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_chapters_novel ON chapters(novel_id, idx);
CREATE TABLE IF NOT EXISTS characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  novel_id INTEGER REFERENCES novels(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  aliases TEXT DEFAULT '',
  gender TEXT DEFAULT '',
  age TEXT DEFAULT '',
  description TEXT DEFAULT '',
  is_narrator INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_characters_novel ON characters(novel_id);
CREATE TABLE IF NOT EXISTS voices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  voice_id TEXT NOT NULL UNIQUE,
  name TEXT DEFAULT '',
  description TEXT DEFAULT '',
  gender TEXT DEFAULT '',
  tags TEXT DEFAULT '',
  source TEXT DEFAULT 'system',
  favorite INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS character_voices (
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  voice_id INTEGER NOT NULL REFERENCES voices(id) ON DELETE CASCADE,
  is_default INTEGER DEFAULT 0,
  speed REAL DEFAULT 1,
  vol REAL DEFAULT 1,
  pitch INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (character_id, voice_id)
);
CREATE INDEX IF NOT EXISTS idx_cv_voice ON character_voices(voice_id);
CREATE TABLE IF NOT EXISTS segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL DEFAULT 'narration',
  character_id INTEGER REFERENCES characters(id) ON DELETE SET NULL,
  speaker TEXT DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  emotion TEXT DEFAULT '',
  voice_override INTEGER REFERENCES voices(id) ON DELETE SET NULL,
  status TEXT DEFAULT 'pending',
  error TEXT,
  audio_file TEXT,
  lrc_file TEXT,
  duration_ms INTEGER,
  gen_key TEXT,
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_segments_chapter ON segments(chapter_id, idx);
CREATE INDEX IF NOT EXISTS idx_segments_character ON segments(character_id);
CREATE TABLE IF NOT EXISTS character_alias_scopes (
  novel_id INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  PRIMARY KEY (novel_id, chapter_id, alias)
);
CREATE TABLE IF NOT EXISTS identity_reports (
  novel_id INTEGER PRIMARY KEY REFERENCES novels(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  report_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  title TEXT DEFAULT '',
  novel_id INTEGER,
  chapter_ids TEXT DEFAULT '[]',
  status TEXT DEFAULT 'queued',
  total INTEGER DEFAULT 0,
  done INTEGER DEFAULT 0,
  failed INTEGER DEFAULT 0,
  message TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  finished_at TEXT
);
`);

// ---- NPC 合集与兼容旧数据库的增量迁移 ----
const addColumn = (table, name, definition) => {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
};
addColumn('novels', 'npc_pool_id', 'INTEGER REFERENCES npc_pools(id) ON DELETE SET NULL');
addColumn('characters', 'role_type', "TEXT NOT NULL DEFAULT 'auto'");
addColumn('characters', 'role_hint', "TEXT NOT NULL DEFAULT ''");
addColumn('chapters', 'compression_version', "TEXT NOT NULL DEFAULT ''");
addColumn('segments', 'narration_omitted', 'INTEGER NOT NULL DEFAULT 0');
addColumn('chapters', 'compression_status', "TEXT NOT NULL DEFAULT 'none'");
addColumn('chapters', 'compression_error', 'TEXT');
addColumn('chapters', 'narration_before_chars', 'INTEGER');
addColumn('chapters', 'narration_after_chars', 'INTEGER');
db.exec(`CREATE TABLE IF NOT EXISTS narration_backups (
  chapter_id INTEGER PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE,
  originals_json TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime'))
)`);
db.exec(`
CREATE TABLE IF NOT EXISTS npc_pools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS npc_pool_voices (
  pool_id INTEGER NOT NULL REFERENCES npc_pools(id) ON DELETE CASCADE,
  voice_id INTEGER NOT NULL REFERENCES voices(id) ON DELETE CASCADE,
  gender TEXT NOT NULL CHECK(gender IN ('male','female')),
  PRIMARY KEY(pool_id,voice_id)
);
CREATE TABLE IF NOT EXISTS npc_assignments (
  character_id INTEGER PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  pool_id INTEGER NOT NULL REFERENCES npc_pools(id) ON DELETE CASCADE,
  voice_id INTEGER NOT NULL REFERENCES voices(id) ON DELETE CASCADE,
  gender TEXT NOT NULL CHECK(gender IN ('male','female'))
);
`);

// ---- 参数归一化：node:sqlite 不接受 undefined / boolean ----
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const normAll = (p) => p.map(norm);

export const q = {
  all: (sql, ...p) => db.prepare(sql).all(...normAll(p)),
  get: (sql, ...p) => db.prepare(sql).get(...normAll(p)),
  run: (sql, ...p) => {
    const r = db.prepare(sql).run(...normAll(p));
    return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
  },
};

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 动态 UPDATE：只更新白名单字段 */
export function updateFields(table, id, data, allowed) {
  const keys = Object.keys(data).filter((k) => allowed.includes(k) && data[k] !== undefined);
  if (!keys.length) return 0;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
  return q.run(sql, ...keys.map((k) => data[k]), id).changes;
}

// ---------------- 设置 ----------------
export { DEFAULT_SETTINGS };

export const SECRET_KEYS = ['llm_api_key', 'minimax_api_key'];

const ENV_MAP = {
  llm_base_url: 'LLM_BASE_URL',
  llm_api_key: 'LLM_API_KEY',
  llm_model: 'LLM_MODEL',
  minimax_api_key: 'MINIMAX_API_KEY',
  minimax_ws_url: 'MINIMAX_WS_URL',
  minimax_api_base: 'MINIMAX_API_BASE',
  tts_model: 'TTS_MODEL',
};

export function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const [k, env] of Object.entries(ENV_MAP)) if (process.env[env]) out[k] = process.env[env];
  for (const r of q.all('SELECT key, value FROM settings')) {
    if (r.value !== null && r.value !== '') out[r.key] = r.value;
  }
  return out;
}

export function setSettings(obj) {
  tx(() => {
    for (const [k, v] of Object.entries(obj)) {
      if (!(k in DEFAULT_SETTINGS)) continue;
      // 前端回传掩码值时不覆盖密钥
      if (SECRET_KEYS.includes(k) && typeof v === 'string' && (v.includes('****') || v === '')) continue;
      q.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, v == null ? '' : String(v));
    }
  });
}

export function maskSecret(s) {
  if (!s) return '';
  if (s.length <= 10) return '****';
  return s.slice(0, 4) + '****' + s.slice(-4);
}

export function publicSettings() {
  const s = getSettings();
  for (const k of SECRET_KEYS) {
    s[k + '_set'] = !!s[k];
    s[k] = maskSecret(s[k]);
  }
  return s;
}

// ---------------- 内置音色初始化 ----------------
(function seedVoices() {
  const ins = db.prepare(`INSERT OR IGNORE INTO voices(voice_id, name, description, gender, tags, source) VALUES (?, ?, ?, ?, ?, 'system')`);
  db.exec('BEGIN');
  try {
    for (const v of SEED_VOICES) ins.run(v.voice_id, v.name, v.description || '', v.gender || guessGender(v.voice_id + v.name), v.tags || '');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
})();

// 默认合集只初始化一次；用户删减成员后重启不会重新补回。
if (!q.get("SELECT 1 FROM settings WHERE key = '_npc_pools_initialized'")) {
  tx(() => {
    const pool = q.run('INSERT INTO npc_pools(name) VALUES (?)', '默认 NPC 音色合集').id;
    const seed = ['male-qn-qingse', 'male-qn-jingying', 'male-qn-badao', 'male-qn-daxuesheng', 'Chinese (Mandarin)_Gentleman', 'Chinese (Mandarin)_Reliable_Executive', 'female-shaonv', 'female-yujie', 'female-chengshu', 'female-tianmei', 'Chinese (Mandarin)_Warm_Bestie', 'Chinese (Mandarin)_Wise_Women'];
    for (const [index, key] of seed.entries()) {
      const v = q.get('SELECT id FROM voices WHERE voice_id = ?', key);
      if (v) q.run('INSERT INTO npc_pool_voices(pool_id,voice_id,gender) VALUES (?,?,?)', pool, v.id, index < 6 ? 'male' : 'female');
    }
    q.run("INSERT INTO settings(key,value) VALUES ('_npc_pools_initialized','1')");
  });
}

// 服务重启时，未完成的任务标记为中断
q.run(`UPDATE jobs SET status = 'interrupted', finished_at = datetime('now','localtime') WHERE status IN ('queued','running')`);
q.run(`UPDATE segments SET status = 'pending' WHERE status = 'running'`);
q.run(`UPDATE chapters SET compression_status = 'error', compression_error = '服务重启，旁白压缩中断，可重试' WHERE compression_status IN ('queued','running')`);
q.run(`UPDATE chapters SET split_status = 'error', split_error = '服务重启，拆分中断' WHERE split_status = 'running'`);
