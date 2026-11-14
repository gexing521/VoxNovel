// MiniMax 语音合成（WebSocket，同步 T2A）与音色查询
// 文档：https://platform.minimaxi.com/docs/guides/speech-t2a-websocket
//      https://platform.minimaxi.com/docs/api-reference/voice-management-get
import { guessGender } from './voices-seed.js';

export class MiniMaxError extends Error {
  constructor(code, msg) {
    super(`MiniMax 错误 ${code}: ${msg || ''}`);
    this.code = code;
  }
}

// 可重试的错误码：限流 / 超时 / 服务内部错误
const RETRYABLE = new Set([1000, 1001, 1002, 1024, 1033, 1039, 2205]);

import { emotionForModel, ALL_EMOTIONS } from './emotions.js';
export const EMOTIONS = ALL_EMOTIONS;

/**
 * 单次合成。返回 { audio: Buffer, durationMs, usage }
 */
export function synthesizeOnce(text, voice, settings) {
  const key = settings.minimax_api_key;
  if (!key) return Promise.reject(new Error('未配置 MiniMax API Key（设置 → 语音合成）'));
  const url = settings.minimax_ws_url || 'wss://api.minimaxi.com/ws/v1/t2a_v2';

  const voiceSetting = {
    voice_id: voice.voice_id,
    speed: num(voice.speed, 1),
    vol: num(voice.vol, 1),
    pitch: Math.round(num(voice.pitch, 0)),
  };
  // 情绪：按当前模型做兼容映射（如 speech-2.8 不支持 whisper → calm），空值表示让模型自动判断
  const emo = voice._raw ? voice.emotion : emotionForModel(voice.emotion, settings.tts_model);
  if (emo) voiceSetting.emotion = emo;

  const startMsg = {
    event: 'task_start',
    model: settings.tts_model || 'speech-2.8-hd',
    voice_setting: voiceSetting,
    audio_setting: {
      sample_rate: Number(settings.tts_sample_rate) || 32000,
      bitrate: Number(settings.tts_bitrate) || 128000,
      format: 'mp3',
      channel: 1,
    },
  };
  if (settings.tts_language_boost && settings.tts_language_boost !== 'none') startMsg.language_boost = settings.tts_language_boost;

  return new Promise((resolve, reject) => {
    const chunks = [];
    let extra = null;
    let settled = false;
    let gotFinal = false;
    let ws;
    const timeoutMs = Number(settings.tts_timeout_ms) || 120000;
    const timer = setTimeout(() => fail(Object.assign(new Error(`合成超时（${timeoutMs / 1000}s）`), { retryable: true })), timeoutMs);

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      const audio = Buffer.concat(chunks);
      if (!audio.length) return reject(Object.assign(new Error('MiniMax 未返回音频数据'), { retryable: true }));
      resolve({ audio, durationMs: Number(extra?.audio_length) || 0, usage: extra?.usage_characters ?? null });
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      reject(err);
    };
    const send = (obj) => ws.send(JSON.stringify(obj));

    try {
      ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key}` } });
    } catch (e) {
      return fail(new Error('WebSocket 创建失败：' + e.message));
    }

    ws.onmessage = async (ev) => {
      let msg;
      try {
        const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data instanceof Blob ? await ev.data.arrayBuffer() : ev.data).toString('utf8');
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      const br = msg.base_resp;
      if (br && br.status_code && br.status_code !== 0) {
        const err = new MiniMaxError(br.status_code, br.status_msg);
        err.retryable = RETRYABLE.has(br.status_code);
        return fail(err);
      }
      if (msg.data?.audio) chunks.push(Buffer.from(msg.data.audio, 'hex'));
      if (msg.extra_info) extra = msg.extra_info;

      switch (msg.event) {
        case 'connected_success':
          send(startMsg);
          break;
        case 'task_started':
          send({ event: 'task_continue', text });
          break;
        case 'task_failed':
          return fail(new MiniMaxError(br?.status_code ?? -1, br?.status_msg || 'task_failed'));
        case 'task_finished':
          return finish();
      }
      if (msg.is_final && !gotFinal) {
        gotFinal = true;
        try { send({ event: 'task_finish' }); } catch {}
        // 等待 task_finished，若服务端直接关闭也会在 onclose 中收尾
        setTimeout(finish, 1500);
      }
    };
    ws.onerror = (ev) => {
      if (settled) return;
      const m = ev?.message || ev?.error?.message || '';
      fail(Object.assign(new Error(`WebSocket 连接错误 ${m}（请检查 MiniMax 密钥与 WS 地址）`), { retryable: !/401|403/.test(m) }));
    };
    ws.onclose = (ev) => {
      if (settled) return;
      if (gotFinal && chunks.length) return finish();
      fail(Object.assign(new Error(`连接被关闭 code=${ev.code} ${ev.reason || ''}`), { retryable: true }));
    };
  });
}

// ---- 全局限流：所有合成请求（含试听）共用 ----
// tts_rpm：每分钟最多发起的请求数（Token Plan 有 RPM 上限）；遇到 1002 限流时全局冷却
let nextSlot = 0;
let cooldownUntil = 0;
async function acquireSlot(settings) {
  const rpm = Math.max(1, Number(settings.tts_rpm) || 20);
  const gap = 60000 / rpm;
  for (;;) {
    const now = Date.now();
    if (now < cooldownUntil) { await sleep(cooldownUntil - now); continue; }
    const at = Math.max(now, nextSlot);
    nextSlot = at + gap;
    if (at > now) await sleep(at - now);
    if (Date.now() >= cooldownUntil) return;
  }
}

/** 带限流与重试的合成 */
export async function synthesize(text, voice, settings) {
  const max = Math.max(1, Number(settings.tts_max_retries) || 3);
  let lastErr;
  let rateLimitHits = 0;
  for (let attempt = 1; attempt <= max + rateLimitHits; attempt++) {
    await acquireSlot(settings);
    try {
      return await synthesizeOnce(text, voice, settings);
    } catch (e) {
      lastErr = e;
      if (e.code === 1002 || e.code === 1039) {
        // 限流：全局冷却 20s 起，逐次加长；限流重试不计入普通重试次数（最多额外 8 次）
        rateLimitHits++;
        if (rateLimitHits > 8) break;
        cooldownUntil = Math.max(cooldownUntil, Date.now() + Math.min(60000, 15000 + rateLimitHits * 5000));
        continue;
      }
      if (!e.retryable || attempt >= max + rateLimitHits) break;
      await sleep(1000 * attempt * attempt);
    }
  }
  throw lastErr;
}

/** 拉取账号下可用音色 */
export async function fetchVoices(settings) {
  const key = settings.minimax_api_key;
  if (!key) throw new Error('未配置 MiniMax API Key');
  const base = (settings.minimax_api_base || 'https://api.minimaxi.com').replace(/\/+$/, '');
  const res = await fetch(base + '/v1/get_voice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ voice_type: 'all' }),
    signal: AbortSignal.timeout(30000),
  });
  const txt = await res.text();
  let data;
  try { data = JSON.parse(txt); } catch { throw new Error(`get_voice 返回非 JSON（HTTP ${res.status}）：${txt.slice(0, 200)}`); }
  if (data.base_resp && data.base_resp.status_code !== 0) throw new MiniMaxError(data.base_resp.status_code, data.base_resp.status_msg);
  const out = [];
  const take = (list, source) => {
    for (const v of list || []) {
      if (!v?.voice_id) continue;
      const desc = Array.isArray(v.description) ? v.description.join('；') : v.description || '';
      const name = v.voice_name || v.voice_id;
      out.push({ voice_id: v.voice_id, name, description: desc, source, gender: guessGender(`${v.voice_id} ${name} ${desc}`) });
    }
  };
  take(data.system_voice, 'system');
  take(data.voice_cloning, 'cloning');
  take(data.voice_generation, 'generation');
  take(data.music_generation, 'music');
  return out;
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
