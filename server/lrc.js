// LRC 生成 + MP3 时长解析

const STRONG_END = /[。！？!?；;…]/;
const WEAK_END = /[，,、：:]/;
const PUNCT_RE = /[\s\p{P}\p{S}]/gu;

/** 去掉 MiniMax 停顿标记 <#0.5#> 等 */
export function stripMarkup(text) {
  return String(text || '').replace(/<#[\d.]+#>/g, '');
}

/** 有效字符数（不含标点空白），英文单词按 2 字估算 */
function effLen(s) {
  const plain = s.replace(PUNCT_RE, '');
  const words = plain.match(/[A-Za-z]+/g) || [];
  const nonAscii = plain.replace(/[A-Za-z0-9]+/g, '').length;
  const digits = (plain.match(/[0-9]/g) || []).length;
  return nonAscii + words.length * 2 + digits;
}

/** 把一段文本切成适合字幕显示的句子 */
export function splitSentences(text, maxLen = 28) {
  const src = stripMarkup(text).replace(/\s+/g, ' ').trim();
  if (!src) return [];
  // 1) 按强标点切句（标点和紧随的引号保留在句尾）
  const sentences = [];
  let buf = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    buf += ch;
    if (STRONG_END.test(ch)) {
      while (i + 1 < src.length && /[。！？!?…”’」』）)\]"']/.test(src[i + 1])) buf += src[++i];
      sentences.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) sentences.push(buf.trim());

  // 2) 过长的句子再按逗号等弱标点切
  const out = [];
  for (const s of sentences) {
    if (s.length <= maxLen) { out.push(s); continue; }
    let part = '';
    for (let i = 0; i < s.length; i++) {
      part += s[i];
      if (WEAK_END.test(s[i]) && part.length >= Math.min(8, maxLen / 2)) {
        out.push(part.trim());
        part = '';
      } else if (part.length >= maxLen * 1.6) {
        out.push(part.trim());
        part = '';
      }
    }
    if (part.trim()) {
      // 太短的尾巴并到前一句
      if (part.trim().length < 4 && out.length) out[out.length - 1] += part.trim();
      else out.push(part.trim());
    }
  }
  return out.filter((s) => s.replace(PUNCT_RE, '').length > 0 || out.length === 1);
}

/** 根据总时长按字数权重分配每句开始时间 */
export function timeSentences(sentences, durationMs, offsetMs = 0) {
  if (!sentences.length) return [];
  const weights = sentences.map((s) => {
    let w = Math.max(1, effLen(s));
    const last = s.replace(/[”’」』）)\]"'\s]+$/, '').slice(-1);
    if (STRONG_END.test(last)) w += 2.2;
    else if (WEAK_END.test(last)) w += 1.2;
    return w;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  const lead = Math.min(120, durationMs * 0.02); // 片头少量静音
  const usable = Math.max(0, durationMs - lead);
  let t = lead;
  return sentences.map((s, i) => {
    const line = { t: Math.round(offsetMs + t), text: s };
    t += (usable * weights[i]) / total;
    return line;
  });
}

export function fmtTime(ms) {
  ms = Math.max(0, Math.round(ms));
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

export function formatLrc(lines, meta = {}) {
  const head = [];
  if (meta.title) head.push(`[ti:${meta.title}]`);
  if (meta.artist) head.push(`[ar:${meta.artist}]`);
  if (meta.album) head.push(`[al:${meta.album}]`);
  if (meta.durationMs) head.push(`[length:${fmtTime(meta.durationMs).replace(/\.\d+$/, '')}]`);
  head.push('[by:novel-voice-studio]');
  const body = lines.map((l) => `[${fmtTime(l.t)}]${l.text}`);
  if (meta.durationMs) body.push(`[${fmtTime(meta.durationMs)}]`);
  return head.concat(body).join('\n') + '\n';
}

/** 为单段音频生成 LRC 行 */
export function buildSegmentLines(text, durationMs, { offsetMs = 0, maxLen = 28, prefix = '' } = {}) {
  const sentences = splitSentences(text, maxLen);
  const lines = timeSentences(sentences, durationMs, offsetMs);
  if (prefix) for (const l of lines) l.text = prefix + l.text;
  return lines;
}

// ---------------- MP3 时长 ----------------
const BITRATES = {
  // [version][layer] -> kbps table（index 1..14）
  V1L1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  V1L2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  V1L3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  V2L1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  V2L23: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** 逐帧解析 MP3，返回毫秒时长；解析失败返回 0 */
export function mp3DurationMs(buf) {
  let i = 0;
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    i = 10 + size;
  }
  let seconds = 0;
  let frames = 0;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) { i++; continue; }
    const verBits = (buf[i + 1] >> 3) & 3; // 3=V1, 2=V2, 0=V2.5
    const layerBits = (buf[i + 1] >> 1) & 3; // 1=L3, 2=L2, 3=L1
    const brIdx = (buf[i + 2] >> 4) & 0xf;
    const srIdx = (buf[i + 2] >> 2) & 3;
    const pad = (buf[i + 2] >> 1) & 1;
    if (verBits === 1 || layerBits === 0 || brIdx === 0 || brIdx === 15 || srIdx === 3) { i++; continue; }
    const sr = SAMPLE_RATES[verBits][srIdx];
    const v1 = verBits === 3;
    const layer = 4 - layerBits;
    const table = v1 ? (layer === 1 ? BITRATES.V1L1 : layer === 2 ? BITRATES.V1L2 : BITRATES.V1L3) : layer === 1 ? BITRATES.V2L1 : BITRATES.V2L23;
    const br = table[brIdx] * 1000;
    let samples, len;
    if (layer === 1) { samples = 384; len = (Math.floor((12 * br) / sr) + pad) * 4; }
    else if (layer === 2) { samples = 1152; len = Math.floor((144 * br) / sr) + pad; }
    else { samples = v1 ? 1152 : 576; len = Math.floor(((v1 ? 144 : 72) * br) / sr) + pad; }
    if (len < 4) { i++; continue; }
    seconds += samples / sr;
    frames++;
    i += len;
  }
  return frames ? Math.round(seconds * 1000) : 0;
}
