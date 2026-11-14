// ---------- 基础工具 ----------
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers['Content-Type'] = 'application/json';
    if (!opts.method) init.method = 'POST';
  }
  const res = await fetch('/api' + path, init);
  const txt = await res.text();
  let data;
  try { data = txt ? JSON.parse(txt) : {}; } catch { data = { error: txt }; }
  if (res.status === 401 && path !== '/login') {
    window.dispatchEvent(new Event('need-login'));
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), type === 'err' ? 6000 : 3000);
}

export async function guard(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg, 'ok');
    return r;
  } catch (e) {
    toast(e.message, 'err');
    throw e;
  }
}

/** 弹窗：返回 { el, close } */
export function modal({ title, body = '', foot = '', wide = false, onClose } = {}) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal ${wide ? 'wide' : ''}">
    <div class="modal-h"><h2>${esc(title)}</h2><button class="icon" data-close>✕</button></div>
    <div class="modal-b">${body}</div>
    ${foot ? `<div class="modal-f">${foot}</div>` : ''}
  </div>`;
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  bg.querySelector('[data-close]').onclick = close;
  $('#modalRoot').appendChild(bg);
  return { el: bg.querySelector('.modal'), close };
}

export function confirmBox(text, { okText = '确定', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title: '确认',
      body: `<div style="white-space:pre-wrap;line-height:1.6">${esc(text)}</div>`,
      foot: `<button class="btn" data-no>取消</button><button class="btn ${danger ? 'danger' : 'primary'}" data-yes>${esc(okText)}</button>`,
      onClose: () => !done && resolve(false),
    });
    m.el.querySelector('[data-no]').onclick = () => m.close();
    m.el.querySelector('[data-yes]').onclick = () => { done = true; m.close(); resolve(true); };
  });
}

export function promptBox(title, { value = '', placeholder = '', multiline = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const input = multiline
      ? `<textarea rows="8" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
      : `<input value="${esc(value)}" placeholder="${esc(placeholder)}" />`;
    const m = modal({ title, body: input, foot: `<button class="btn" data-no>取消</button><button class="btn primary" data-yes>确定</button>`, onClose: () => !done && resolve(null) });
    const el = m.el.querySelector('input,textarea');
    el.focus();
    const ok = () => { done = true; const v = el.value; m.close(); resolve(v); };
    m.el.querySelector('[data-no]').onclick = () => m.close();
    m.el.querySelector('[data-yes]').onclick = ok;
    if (!multiline) el.onkeydown = (e) => e.key === 'Enter' && ok();
  });
}

// ---------- 播放器 ----------
export const player = {
  play(url, title = '', sub = '') {
    const a = $('#audio');
    $('#player').classList.remove('hidden');
    $('#playerTitle').textContent = title;
    $('#playerSub').textContent = sub;
    a.src = url;
    a.play().catch(() => {});
  },
  stop() {
    const a = $('#audio');
    a.pause();
    $('#player').classList.add('hidden');
  },
};

export const fileUrl = (rel, dl) => rel ? '/files/' + rel.split(/[\\/]/).map(encodeURIComponent).join('/') + (dl ? '?dl=1' : '') : '';

export const GENDER = { male: '男', female: '女', '': '未知' };
export const AGE = { child: '儿童', young: '青年', middle: '中年', old: '老年', '': '' };
export const EMOTIONS = [['', '情绪·自动'], ['neutral', '中性'], ['calm', '冷静'], ['happy', '开心'], ['sad', '悲伤'], ['angry', '愤怒'], ['fearful', '害怕'], ['surprised', '惊讶'], ['disgusted', '厌恶'], ['fluent', '生动'], ['whisper', '低语(仅2.6)']];
export const SOURCES = { system: '系统', cloning: '复刻', generation: '文生音色', custom: '自定义', music: '音乐' };
export const genderTag = (g) => (g ? `<span class="tag ${g}">${GENDER[g]}</span>` : '');

export function colorOf(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 62% 46%)`;
}

export function fmtDur(ms) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s % 60).padStart(2, '0');
}

/** 读取 txt，自动识别 UTF-8 / GBK */
export async function readTextFile(file) {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch {
    try { return new TextDecoder('gb18030').decode(buf); } catch { return new TextDecoder('gbk').decode(buf); }
  }
}

// ---------- 音色试听 ----------
const previewCache = new Map();
export async function previewVoice(voice_id, btn, opts = {}) {
  const key = voice_id + JSON.stringify(opts);
  try {
    btn?.classList.add('loading');
    let url = previewCache.get(key);
    if (!url) {
      url = (await api('/voices/preview', { body: { voice_id, ...opts } })).url;
      previewCache.set(key, url);
    }
    player.play(url, opts.title || voice_id, '音色试听');
  } catch (e) {
    toast('试听失败：' + e.message, 'err');
  } finally {
    btn?.classList.remove('loading');
  }
}
