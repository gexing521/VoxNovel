// 真实接口联调：抓取/读取章节 → 用真实 LLM 拆分 → 用真实 MiniMax 合成前几段，输出报告
// 用法：
//   npm run test:live                                  # 默认抓取测试章节「空屋」
//   npm run test:live -- --url <章节网址>
//   npm run test:live -- --file ./第一章.txt --mode llm --tts 6
// 密钥读取顺序：环境变量 > 网页「设置」中保存的配置（data/app.db）
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS } from '../server/defaults.js';
import { chat } from '../server/llm.js';
import { fetchChapter } from '../server/fetcher.js';
import { splitChapterText, detectChapters, ruleSplit } from '../server/splitter.js';
import { synthesize, fetchVoices } from '../server/minimax.js';
import { buildSegmentLines, formatLrc, mp3DurationMs } from '../server/lrc.js';
import { SEED_VOICES, guessAgeTag } from '../server/voices-seed.js';
import { PROMPT_VERSION } from '../server/prompts.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const OUT = path.join(DATA_DIR, 'live-test');
fs.mkdirSync(OUT, { recursive: true });

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1]?.startsWith('--') ? '1' : arr[i + 1] ?? '1']] : a), [])
);
const URL_DEFAULT = 'http://www.wxxiaoshuo.cc/read/120503/44182870.html';

// ---- 读取设置 ----
const settings = { ...DEFAULT_SETTINGS };
const dbFile = path.join(DATA_DIR, 'app.db');
if (fs.existsSync(dbFile)) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  for (const r of db.prepare('SELECT key, value FROM settings').all()) if (r.value) settings[r.key] = r.value;
  db.close();
}
for (const [k, env] of Object.entries({ llm_base_url: 'LLM_BASE_URL', llm_api_key: 'LLM_API_KEY', llm_model: 'LLM_MODEL', minimax_api_key: 'MINIMAX_API_KEY', minimax_ws_url: 'MINIMAX_WS_URL', minimax_api_base: 'MINIMAX_API_BASE', tts_model: 'TTS_MODEL' })) {
  if (process.env[env]) settings[k] = process.env[env];
}
if (args.mode) settings.split_mode = args.mode;

const report = [];
const log = (s = '') => { console.log(s); report.push(s); };
const t0 = Date.now();
const sec = (t) => ((Date.now() - t) / 1000).toFixed(1) + 's';

log(`# 联调报告 ${new Date().toLocaleString('zh-CN')}`);
log(`- LLM：${settings.llm_base_url} · ${settings.llm_model} · 提示词 ${PROMPT_VERSION} · 拆分模式 ${settings.split_mode}`);
log(`- TTS：${settings.minimax_ws_url} · ${settings.tts_model}`);

// 1. LLM 连通
let t = Date.now();
try {
  const r = await chat(settings, [{ role: 'user', content: '只回复 JSON：{"ok":true}' }]);
  log(`- ✓ LLM 连通（${sec(t)}）：${r.content.slice(0, 60).replace(/\n/g, ' ')}`);
} catch (e) {
  log(`- ✕ LLM 连通失败：${e.message}`);
  finish(1);
}

// 2. 获取章节
let title, content;
t = Date.now();
if (args.file) {
  content = fs.readFileSync(args.file, 'utf8');
  title = path.basename(args.file);
} else {
  const url = args.url && args.url !== '1' ? args.url : URL_DEFAULT;
  try {
    const r = await fetchChapter(url);
    title = r.title;
    content = r.content;
    log(`- ✓ 抓取章节「${title}」${r.pages} 页，${content.length} 字（${sec(t)}）`);
  } catch (e) {
    log(`- ✕ 抓取失败：${e.message}`);
    finish(1);
  }
}
const chs = detectChapters(content);
if (chs.length > 1) content = chs[0].content;
fs.writeFileSync(path.join(OUT, 'chapter.txt'), `${title}\n${content}`);

// 3. 拆分
const rulePieces = ruleSplit(content);
const quoteDialogues = rulePieces.filter((p) => p.type === 'dialogue').length;
t = Date.now();
const known = [];
let segments, warnings;
try {
  ({ segments, warnings } = await splitChapterText(content, known, settings, { onProgress: (m) => process.stdout.write(`  … ${m}\r`) }));
} catch (e) {
  log(`- ✕ 拆分失败：${e.message}`);
  finish(1);
}
const dl = segments.filter((s) => s.type === 'dialogue');
const unknown = dl.filter((s) => s.speaker === '未知角色' || !s.speaker);
const norm = (s) => s.replace(/[\s“”「」『』"'‘’]/g, '');
const coverage = norm(segments.map((s) => s.text).join('')).length / Math.max(1, norm(content).length);
log(`- ✓ 拆分完成（${sec(t)}）：${segments.length} 段，其中对话 ${dl.length} 段（规则识别引号对话 ${quoteDialogues} 条），未知说话人 ${unknown.length} 条，文本覆盖率 ${(coverage * 100).toFixed(1)}%`);
for (const w of warnings) log(`  - ⚠ ${w}`);
log('\n## 角色');
for (const c of known) log(`- ${c.name}（${c.gender || '?'} / ${c.age || '?'}）${c.aliases ? ' 别名：' + c.aliases : ''} ${c.description || ''}`);
const counts = {};
for (const s of dl) counts[s.speaker] = (counts[s.speaker] || 0) + 1;
log('\n台词数：' + Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('，'));
log('\n## 片段');
segments.forEach((s, i) => log(`${String(i + 1).padStart(3)}. [${s.type === 'dialogue' ? s.speaker + (s.emotion ? '/' + s.emotion : '') : '旁白'}] ${s.text}`));
fs.writeFileSync(path.join(OUT, 'segments.json'), JSON.stringify({ known, segments }, null, 2));

// 4. MiniMax 音色列表
if (args.tts !== '0') {
  t = Date.now();
  try {
    const vs = await fetchVoices(settings);
    log(`\n- ✓ get_voice 返回 ${vs.length} 个音色（${sec(t)}）`);
    const ids = new Set(vs.map((v) => v.voice_id));
    const missing = SEED_VOICES.filter((v) => !ids.has(v.voice_id)).map((v) => v.voice_id);
    if (missing.length) log(`  - ⚠ 内置音色中有 ${missing.length} 个不在账号列表里：${missing.join(', ')}`);
    fs.writeFileSync(path.join(OUT, 'voices.json'), JSON.stringify(vs, null, 2));
  } catch (e) {
    log(`\n- ✕ get_voice 失败：${e.message}`);
  }

  // 5. 合成前 N 段
  const N = Number(args.tts) || 6;
  const pickVoice = (s) => {
    if (s.type !== 'dialogue') return settings.default_narrator_voice;
    const c = known.find((k) => k.name === s.speaker) || {};
    const pool = SEED_VOICES.filter((v) => v.gender === (c.gender || 'male') && !/旁白|卡通|特色/.test(v.tags));
    const byAge = pool.filter((v) => guessAgeTag(v.tags + v.name) === (c.age || 'young'));
    const list = byAge.length ? byAge : pool;
    let h = 0;
    for (const ch of s.speaker) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return list[h % list.length].voice_id;
  };
  log(`\n## 合成前 ${N} 段`);
  for (const [i, s] of segments.slice(0, N).entries()) {
    t = Date.now();
    const vid = pickVoice(s);
    try {
      const r = await synthesize(s.text, { voice_id: vid, emotion: s.emotion }, settings);
      const ms = mp3DurationMs(r.audio) || r.durationMs;
      const base = `${String(i + 1).padStart(4, '0')}_${s.type === 'dialogue' ? s.speaker : '旁白'}`;
      fs.writeFileSync(path.join(OUT, base + '.mp3'), r.audio);
      fs.writeFileSync(path.join(OUT, base + '.lrc'), formatLrc(buildSegmentLines(s.text, ms), { title, artist: s.speaker || '旁白', durationMs: ms }));
      log(`- ✓ #${i + 1} ${vid} ${(ms / 1000).toFixed(1)}s，${(r.audio.length / 1024).toFixed(0)}KB，扣费字符 ${r.usage ?? '?'}（${sec(t)}）`);
    } catch (e) {
      log(`- ✕ #${i + 1} ${vid}：${e.message}`);
      if (/1004|2049|鉴权|auth/i.test(e.message)) break;
    }
  }
}
finish(0);

function finish(code) {
  log(`\n总耗时 ${sec(t0)}。输出目录：${OUT}`);
  fs.writeFileSync(path.join(OUT, 'report.md'), report.join('\n') + '\n');
  process.exit(code);
}
