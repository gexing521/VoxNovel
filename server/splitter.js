// 小说拆分：章节识别、规则切分（引号）、LLM 识别说话人 / LLM 全文拆分
import { chatJson } from './llm.js';
import { ALL_EMOTIONS } from './emotions.js';
import { hybridSystem, fullSystem, hybridUserMessage, fullUserMessage } from './prompts.js';

// ---------------- 章节识别 ----------------
const CHAPTER_RE = /^\s*((?:第\s*[0-9零一二三四五六七八九十百千万两〇]+\s*[章节回卷集部篇幕话]|序章|序言|楔子|引子|尾声|后记|番外|Chapter\s*\d+|CHAPTER\s*\d+)[^\n]{0,40})\s*$/;

export function detectChapters(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const chapters = [];
  let cur = { title: '', lines: [] };
  for (const line of lines) {
    const m = line.match(CHAPTER_RE);
    if (m && line.trim().length <= 50) {
      if (cur.title || cur.lines.join('').trim()) chapters.push(cur);
      cur = { title: m[1].trim(), lines: [] };
    } else {
      cur.lines.push(line);
    }
  }
  if (cur.title || cur.lines.join('').trim()) chapters.push(cur);
  const out = chapters
    .map((c, i) => ({ title: c.title || (i === 0 ? '开篇' : `第${i + 1}节`), content: c.lines.join('\n').trim() }))
    .filter((c) => c.content || c.title);
  // 开头的短小前言（如书名、作者行）并入下一章
  if (out.length > 1 && out[0].title === '开篇' && out[0].content.length < 60) out.shift();
  return out.length ? out : [{ title: '正文', content: String(text || '').trim() }];
}

// ---------------- 规则切分 ----------------
const QUOTE_RE = /“[^“”]*”|「[^「」]*」|『[^『』]*』|"[^"\n]*"/g;
const END_PUNCT = /[。！？!?…~～]/;
const HAS_WORD = /[\p{L}\p{N}]/u;

function isSpeech(inner, before, after) {
  const t = inner.trim();
  if (!t) return false;
  if (/[：:]\s*$/.test(before)) return true;
  if (END_PUNCT.test(t)) return true;
  if (t.length > 15) return true;
  const beforeLast = before.slice(-1);
  const afterFirst = after.slice(0, 1);
  // 句中引用（所谓“天才”就是……）
  if (beforeLast && HAS_WORD.test(beforeLast) && afterFirst && HAS_WORD.test(afterFirst)) return false;
  if (t.length <= 6) return false;
  return true;
}

/** 规则切分一个段落 */
function splitParagraph(para, paraIdx) {
  const pieces = [];
  const pushNarr = (s) => {
    s = s.trim();
    if (!s) return;
    // 未闭合的开引号：多段连续对白，整段视作对白
    if (/^[“「『"]/.test(s) && !/[”」』"]/.test(s.slice(1))) {
      pieces.push({ type: 'dialogue', text: s.slice(1).trim(), para: paraIdx });
      return;
    }
    pieces.push({ type: 'narration', text: s, para: paraIdx });
  };
  let last = 0;
  for (const m of para.matchAll(QUOTE_RE)) {
    const inner = m[0].slice(1, -1);
    const before = para.slice(0, m.index).trimEnd();
    const after = para.slice(m.index + m[0].length).trimStart();
    if (!isSpeech(inner, before, after)) continue;
    pushNarr(para.slice(last, m.index));
    if (inner.trim()) pieces.push({ type: 'dialogue', text: inner.trim(), para: paraIdx });
    last = m.index + m[0].length;
  }
  pushNarr(para.slice(last));
  return pieces;
}

/** 超长文本按句切块 */
function chunkLong(text, max) {
  if (text.length <= max) return [text];
  const parts = text.match(/[^。！？!?；;…]+[。！？!?；;…”」』]*|.+$/g) || [text];
  const out = [];
  let buf = '';
  for (const p of parts) {
    if (buf && (buf + p).length > max) { out.push(buf); buf = ''; }
    buf += p;
    while (buf.length > max) { out.push(buf.slice(0, max)); buf = buf.slice(max); }
  }
  if (buf.trim()) out.push(buf);
  return out;
}

export function ruleSplit(content) {
  const paras = String(content || '').replace(/\r\n?/g, '\n').split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const pieces = [];
  paras.forEach((p, i) => pieces.push(...splitParagraph(p, i)));
  return pieces;
}

/** 后处理：超长切块、相邻旁白合并 */
export function finalizeSegments(segs, settings) {
  const max = Math.max(200, Number(settings.max_segment_chars) || 1500);
  const mergeLimit = Number(settings.merge_narration_chars) || 0;
  let out = [];
  for (const s of segs) {
    for (const t of chunkLong(s.text, max)) out.push({ ...s, text: t });
  }
  if (mergeLimit > 0) {
    const merged = [];
    for (const s of out) {
      const prev = merged[merged.length - 1];
      if (prev && prev.type === 'narration' && s.type === 'narration' && (prev.text + s.text).length <= mergeLimit) {
        prev.text += '\n' + s.text;
      } else merged.push({ ...s });
    }
    out = merged;
  }
  return out.map((s) => ({
    type: s.type === 'dialogue' ? 'dialogue' : 'narration',
    text: s.text.trim(),
    speaker: s.type === 'dialogue' ? (s.speaker || '').trim() : '',
    emotion: s.type === 'dialogue' && ALL_EMOTIONS.includes(String(s.emotion || '').toLowerCase()) ? String(s.emotion).toLowerCase() : '',
  })).filter((s) => s.text);
}

// ---------------- LLM ----------------
// 提示词见 prompts.js

function normGender(g) {
  g = String(g || '').toLowerCase().trim();
  if (/^(male|man|m|男)/.test(g) && !g.includes('|')) return 'male';
  if (/^(female|woman|f|女)/.test(g) && !g.includes('|')) return 'female';
  return '';
}
function normAge(a) {
  a = String(a || '').toLowerCase().trim();
  if (a.includes('|')) return '';
  if (/child|儿童|孩/.test(a)) return 'child';
  if (/old|老/.test(a)) return 'old';
  if (/middle|中年/.test(a)) return 'middle';
  if (/young|青|少/.test(a)) return 'young';
  return '';
}

function mergeCharacters(known, incoming) {
  for (const c of incoming || []) {
    if (!c || !c.name || typeof c.name !== 'string' || c.name === '角色名') continue;
    const name = c.name.trim();
    if (!name || ['旁白', '未知', '未知角色', '叙述者'].includes(name)) continue;
    const aliases = Array.isArray(c.aliases) ? c.aliases.filter((a) => typeof a === 'string' && a.trim()) : [];
    const hit = known.find((k) => k.name === name || (k.aliases || '').split(/[,，、\s]+/).includes(name));
    if (hit) {
      const set = new Set((hit.aliases || '').split(/[,，、\s]+/).filter(Boolean));
      aliases.forEach((a) => a !== hit.name && set.add(a));
      hit.aliases = [...set].join(',');
      if (!hit.gender && normGender(c.gender)) hit.gender = normGender(c.gender);
      if (!hit.age && normAge(c.age)) hit.age = normAge(c.age);
      if (!hit.description && c.description) hit.description = c.description;
    } else {
      known.push({
        name,
        gender: normGender(c.gender),
        age: normAge(c.age),
        aliases: aliases.filter((a) => a !== name).join(','),
        description: c.description || '',
        _new: true,
      });
    }
  }
}

/** 混合模式：规则切分 + LLM 标注说话人 */
async function hybridSplit(content, known, settings, onProgress, signal) {
  const pieces = ruleSplit(content);
  const chunkChars = Math.max(800, Number(settings.llm_chunk_chars) || 3000);
  const batches = [];
  let cur = [];
  let len = 0;
  pieces.forEach((p, i) => {
    cur.push(i);
    len += p.text.length;
    if (len >= chunkChars) { batches.push(cur); cur = []; len = 0; }
  });
  if (cur.length) batches.push(cur);

  const needed = batches.filter((b) => b.some((i) => pieces[i].type === 'dialogue'));
  let n = 0;
  const apply = (res, batch) => {
    mergeCharacters(known, res.characters);
    for (const d of res.dialogues || []) {
      const id = Number(d.id);
      const p = pieces[id];
      if (!p || p.type !== 'dialogue' || !batch.includes(id)) continue;
      p.labeled = true;
      if (d.is_speech === false || d.speaker === '旁白') { p.nonSpeech = true; continue; }
      let sp = String(d.speaker || '').trim().replace(/^["“]|["”]$/g, '');
      if (!sp || sp === '未知') sp = '未知角色';
      p.speaker = sp;
      p.emotion = settings.detect_emotion === '0' ? '' : d.emotion || '';
    }
  };
  for (const batch of needed) {
    if (signal?.cancelled) throw new Error('已取消');
    n++;
    onProgress?.(`LLM 识别说话人 ${n}/${needed.length}`);
    const res = await chatJson(settings, [
      { role: 'system', content: hybridSystem(settings.tts_model) },
      { role: 'user', content: hybridUserMessage(known, pieces, batch, { model: settings.tts_model }) },
    ]);
    apply(res, batch);
    // 模型漏标的对话，单独补标一次
    const missing = batch.filter((i) => pieces[i].type === 'dialogue' && !pieces[i].labeled);
    if (missing.length) {
      onProgress?.(`LLM 补标 ${missing.length} 条遗漏对话`);
      try {
        const res2 = await chatJson(settings, [
          { role: 'system', content: hybridSystem(settings.tts_model) },
          { role: 'user', content: hybridUserMessage(known, pieces, batch, { model: settings.tts_model }) + `\n\n注意：只需要输出以下编号的对话：${missing.join(', ')}` },
        ]);
        apply(res2, missing);
      } catch {}
    }
  }

  // 非对白引号还原为旁白并与同段旁白粘合
  const out = [];
  for (const p of pieces) {
    let s = p;
    if (p.type === 'dialogue' && p.nonSpeech) s = { type: 'narration', text: `“${p.text}”`, para: p.para, glue: true };
    const prev = out[out.length - 1];
    if (prev && prev.type === 'narration' && s.type === 'narration' && prev.para === s.para && (prev.glue || s.glue)) {
      prev.text += s.text;
      prev.glue = !!s.glue;
    } else out.push({ ...s });
  }
  return out;
}

const normForCompare = (s) => String(s).replace(/[\s“”「」『』"'‘’]/g, '');

function coverage(source, segs) {
  const S = normForCompare(source);
  if (!S.length) return 1;
  let cursor = 0;
  let matched = 0;
  for (const seg of segs) {
    const t = normForCompare(seg.text || '');
    if (!t) continue;
    const idx = S.indexOf(t, cursor);
    if (idx >= 0 && idx - cursor < 200) { matched += t.length; cursor = idx + t.length; }
  }
  return matched / S.length;
}

/** LLM 全文拆分模式（逐块校验，校验不通过的块回退到混合模式） */
async function fullLlmSplit(content, known, settings, onProgress, signal, warnings) {
  const paras = String(content).replace(/\r\n?/g, '\n').split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const chunkChars = Math.max(600, Math.min(2500, Number(settings.llm_chunk_chars) || 2000));
  const chunks = [];
  let buf = [];
  let len = 0;
  for (const p of paras) {
    buf.push(p);
    len += p.length;
    if (len >= chunkChars) { chunks.push(buf.join('\n')); buf = []; len = 0; }
  }
  if (buf.length) chunks.push(buf.join('\n'));

  const out = [];
  for (let i = 0; i < chunks.length; i++) {
    if (signal?.cancelled) throw new Error('已取消');
    onProgress?.(`LLM 拆分 ${i + 1}/${chunks.length}`);
    let segs = null;
    try {
      const res = await chatJson(settings, [
        { role: 'system', content: fullSystem(settings.tts_model) },
        { role: 'user', content: fullUserMessage(known, chunks[i], settings.tts_model) },
      ]);
      const list = (res.segments || []).filter((s) => s && typeof s.text === 'string' && s.text.trim());
      const cov = coverage(chunks[i], list);
      if (cov >= 0.92) {
        mergeCharacters(known, res.characters);
        segs = list.map((s) => ({
          type: s.type === 'dialogue' ? 'dialogue' : 'narration',
          text: s.text.replace(/^[“「『"]+|[”」』"]+$/g, '').trim(),
          speaker: s.type === 'dialogue' ? (!s.speaker || s.speaker === '未知' ? '未知角色' : s.speaker) : '',
          emotion: settings.detect_emotion === '0' ? '' : s.emotion,
        }));
      } else {
        warnings.push(`第 ${i + 1} 块 LLM 输出与原文吻合度 ${(cov * 100).toFixed(0)}%，已回退为“规则+LLM 识别”模式`);
      }
    } catch (e) {
      if (/未配置|HTTP 40[13]/.test(e.message)) throw e;
      warnings.push(`第 ${i + 1} 块 LLM 拆分失败（${e.message.slice(0, 80)}），已回退`);
    }
    if (!segs) segs = await hybridSplit(chunks[i], known, settings, null, signal);
    out.push(...segs);
  }
  return out;
}

/**
 * 拆分一章。known：已知角色数组（会被就地补充新角色，带 _new 标记）
 * 返回 { segments, warnings }
 */
export async function splitChapterText(content, known, settings, { mode, onProgress, signal } = {}) {
  mode = mode || settings.split_mode || 'hybrid';
  const warnings = [];
  let segs;
  if (mode === 'rule') segs = ruleSplit(content);
  else if (mode === 'llm') segs = await fullLlmSplit(content, known, settings, onProgress, signal, warnings);
  else segs = await hybridSplit(content, known, settings, onProgress, signal);
  return { segments: finalizeSegments(segs, settings), warnings };
}
