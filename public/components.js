import { $, $$, api, esc, modal, toast, guard, previewVoice, genderTag, SOURCES, GENDER, AGE, confirmBox } from './lib.js';

let voicesCache = null;
export async function loadVoices(force = false) {
  if (!voicesCache || force) voicesCache = await api('/voices');
  return voicesCache;
}
export const invalidateVoices = () => { voicesCache = null; };

/** 音色卡片 HTML（音色库页与选择器共用） */
export function voiceCard(v, { picked = false, pickMode = false } = {}) {
  return `<div class="voice ${picked ? 'picked' : ''}" data-vid="${v.id}">
    <div class="vh">
      <button class="play" data-preview="${esc(v.voice_id)}" title="试听">▶</button>
      <b title="${esc(v.name)}">${esc(v.name || v.voice_id)}</b>
      ${genderTag(v.gender)}
      <button class="star ${v.favorite ? 'on' : ''}" data-fav="${v.id}" title="收藏">★</button>
    </div>
    <div class="vid">${esc(v.voice_id)}</div>
    ${v.description ? `<div class="desc" title="${esc(v.description)}">${esc(v.description)}</div>` : ''}
    <div class="row" style="gap:4px">
      <span class="tag">${SOURCES[v.source] || v.source}</span>
      ${(v.tags || '').split(/[,，]/).filter(Boolean).slice(0, 3).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}
    </div>
    ${v.bound_to ? `<div class="bound" title="${esc(v.bound_to)}">已绑定：${esc(v.bound_to.length > 40 ? v.bound_to.slice(0, 40) + '…' : v.bound_to)}</div>` : ''}
    <div class="vf">${pickMode ? `<button class="btn sm primary" data-pick="${v.id}">${picked ? '当前' : '选择'}</button>` : `
      <button class="btn sm" data-bind="${v.id}">绑定到角色</button>
      <button class="btn sm" data-edit="${v.id}">编辑</button>
      ${v.source !== 'system' ? `<button class="btn sm danger" data-del="${v.id}">删除</button>` : ''}`}
    </div>
  </div>`;
}

export function filterVoices(list, { kw = '', gender = '', source = '' }) {
  kw = kw.trim().toLowerCase();
  return list.filter((v) => {
    if (gender && v.gender !== gender) return false;
    if (source === 'fav' && !v.favorite) return false;
    if (source === 'bound' && !v.bind_count) return false;
    if (source && !['fav', 'bound'].includes(source) && v.source !== source) return false;
    if (kw && ![v.name, v.voice_id, v.description, v.tags, v.bound_to].join(' ').toLowerCase().includes(kw)) return false;
    return true;
  });
}

export function filterBar(state) {
  const segBtn = (key, val, label) => `<button data-f="${key}" data-v="${val}" class="${state[key] === val ? 'on' : ''}">${label}</button>`;
  return `<input type="search" placeholder="搜索音色名称 / ID / 描述 / 标签" value="${esc(state.kw)}" data-kw />
    <div class="seg-btns">${segBtn('gender', '', '全部')}${segBtn('gender', 'male', '男')}${segBtn('gender', 'female', '女')}</div>
    <div class="seg-btns">${segBtn('source', '', '全部来源')}${segBtn('source', 'fav', '★ 收藏')}${segBtn('source', 'bound', '已绑定')}${segBtn('source', 'system', '系统')}${segBtn('source', 'cloning', '复刻')}${segBtn('source', 'custom', '自定义')}</div>`;
}

/** 绑定通用事件：试听 / 收藏 */
export function bindVoiceCommon(root, getList, rerender, previewText) {
  root.addEventListener('click', async (e) => {
    const p = e.target.closest('[data-preview]');
    if (p) {
      const v = getList().find((x) => x.voice_id === p.dataset.preview);
      return previewVoice(p.dataset.preview, p, { title: v?.name, text: previewText?.() || undefined });
    }
    const f = e.target.closest('[data-fav]');
    if (f) {
      const v = getList().find((x) => x.id === Number(f.dataset.fav));
      v.favorite = v.favorite ? 0 : 1;
      await guard(() => api('/voices/' + v.id, { method: 'PUT', body: { favorite: v.favorite } }));
      f.classList.toggle('on', !!v.favorite);
    }
  });
}

/**
 * 音色选择器。onPick(voice|null)
 */
export async function openVoicePicker({ title = '选择音色', currentId = null, allowClear = false, clearText = '清除', onPick }) {
  const list = await loadVoices(true);
  const state = { kw: '', gender: '', source: '' };
  const m = modal({
    title,
    wide: true,
    body: `<div class="filters" data-filters></div>
      <div class="row small muted">没有想要的？在 <a href="https://www.minimax.cn/audio/voices" target="_blank" rel="noopener">MiniMax 官方音色库</a> 找到后，把 voice_id 粘贴到这里：
        <input data-custom placeholder="voice_id，如 Chinese (Mandarin)_Gentleman" style="flex:1;min-width:220px" />
        <button class="btn sm" data-use-custom>使用</button></div>
      <div class="voice-grid" data-grid></div>`,
    foot: `${allowClear ? `<button class="btn" data-clear>${esc(clearText)}</button>` : ''}<button class="btn" data-cancel>取消</button>`,
  });
  const grid = m.el.querySelector('[data-grid]');
  const render = () => {
    m.el.querySelector('[data-filters]').innerHTML = filterBar(state);
    const items = filterVoices(list, state);
    grid.innerHTML = items.length ? items.map((v) => voiceCard(v, { pickMode: true, picked: v.id === currentId })).join('') : '<div class="empty">没有匹配的音色</div>';
  };
  const renderGrid = () => {
    const items = filterVoices(list, state);
    grid.innerHTML = items.length ? items.map((v) => voiceCard(v, { pickMode: true, picked: v.id === currentId })).join('') : '<div class="empty">没有匹配的音色</div>';
  };
  render();
  m.el.addEventListener('input', (e) => { if (e.target.matches('[data-kw]')) { state.kw = e.target.value; renderGrid(); } });
  m.el.addEventListener('click', async (e) => {
    const fb = e.target.closest('[data-f]');
    if (fb) { state[fb.dataset.f] = fb.dataset.v; const kw = state.kw; render(); const inp = m.el.querySelector('[data-kw]'); inp.value = kw; return; }
    const pk = e.target.closest('[data-pick]');
    if (pk) { m.close(); return onPick(list.find((v) => v.id === Number(pk.dataset.pick))); }
    if (e.target.closest('[data-clear]')) { m.close(); return onPick(null); }
    if (e.target.closest('[data-cancel]')) return m.close();
    if (e.target.closest('[data-use-custom]')) {
      const vid = m.el.querySelector('[data-custom]').value.trim();
      if (!vid) return;
      let v = list.find((x) => x.voice_id === vid);
      if (!v) v = await guard(() => api('/voices', { body: { voice_id: vid, name: vid } }));
      invalidateVoices();
      m.close();
      return onPick(v);
    }
  });
  bindVoiceCommon(m.el, () => list);
}

/** 角色编辑弹窗：基本信息 + 多音色绑定 */
export async function openCharacterModal(charId, { novels = null, novelId = null, onSaved } = {}) {
  const isNew = !charId;
  let c = { name: '', aliases: '', gender: '', age: '', description: '', novel_id: novelId, voices: [] };
  if (!isNew) {
    const all = await api('/characters' + (novelId ? '?novel_id=' + novelId : ''));
    c = all.find((x) => x.id === charId) || (await api('/characters')).find((x) => x.id === charId);
  }
  novels = novels || (await api('/novels'));
  const m = modal({
    title: isNew ? '新建角色' : `角色：${c.name}`,
    body: `
      <div class="grid2">
        <label class="field">角色名<input name="name" value="${esc(c.name)}" ${c.is_narrator ? 'readonly' : ''} /></label>
        <label class="field">所属小说<select name="novel_id" ${isNew ? '' : 'disabled'}>
          <option value="">（通用角色）</option>
          ${novels.map((n) => `<option value="${n.id}" ${n.id === c.novel_id ? 'selected' : ''}>${esc(n.title)}</option>`).join('')}
        </select></label>
        <label class="field">性别<select name="gender">${Object.entries(GENDER).map(([k, v]) => `<option value="${k}" ${k === (c.gender || '') ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="field">年龄段<select name="age"><option value="">未知</option>${['child', 'young', 'middle', 'old'].map((k) => `<option value="${k}" ${k === c.age ? 'selected' : ''}>${AGE[k]}</option>`).join('')}</select></label>
      </div>
      <label class="field">别名 / 称呼<span class="hint">逗号分隔。拆分时 LLM 会把这些称呼识别为同一角色</span><input name="aliases" value="${esc(c.aliases)}" /></label>
      <label class="field">人设描述<textarea name="description" rows="2">${esc(c.description)}</textarea></label>
      ${isNew ? '' : `<div><h3>绑定音色 <span class="muted small">（可绑定多个，★ 为默认使用的音色；语速/音量/音调仅对该角色生效）</span></h3>
        <div data-binds class="settings-sec" style="gap:8px"></div>
        <button class="btn sm" data-add style="margin-top:10px">+ 添加音色</button></div>`}`,
    foot: `${!isNew && !c.is_narrator ? '<button class="btn danger" data-delete style="margin-right:auto">删除角色</button>' : ''}<button class="btn" data-cancel>关闭</button><button class="btn primary" data-save>保存</button>`,
  });

  const renderBinds = () => {
    const box = m.el.querySelector('[data-binds]');
    if (!box) return;
    box.innerHTML = c.voices.length
      ? c.voices.map((v) => `<div class="row" style="border:1px solid var(--line);border-radius:8px;padding:8px 10px" data-bv="${v.id}">
          <button class="star ${v.is_default ? 'on' : ''}" data-def title="设为默认">★</button>
          <button class="play" data-play title="试听">▶</button>
          <div style="flex:1;min-width:120px"><b>${esc(v.name)}</b> ${genderTag(v.gender)}<div class="vid mono muted">${esc(v.voice_id)}</div></div>
          <label class="small muted">语速 <input type="number" step="0.05" min="0.5" max="2" value="${v.speed}" data-k="speed" style="width:66px" /></label>
          <label class="small muted">音量 <input type="number" step="0.1" min="0.1" max="10" value="${v.vol}" data-k="vol" style="width:60px" /></label>
          <label class="small muted">音调 <input type="number" step="1" min="-12" max="12" value="${v.pitch}" data-k="pitch" style="width:56px" /></label>
          <button class="icon" data-unbind title="解除绑定">✕</button>
        </div>`).join('')
      : '<div class="muted small">还没有绑定音色，生成时该角色的对话会报错提示。</div>';
  };
  renderBinds();

  const reload = async () => {
    const all = await api('/characters' + (c.novel_id ? '?novel_id=' + c.novel_id : ''));
    c = all.find((x) => x.id === charId) || c;
    renderBinds();
    onSaved?.();
  };

  m.el.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('[data-cancel]')) return m.close();
    if (t.closest('[data-add]')) {
      return openVoicePicker({
        title: `为「${c.name}」添加音色`,
        onPick: async (v) => {
          await guard(() => api(`/characters/${c.id}/voices`, { body: { voice_db_id: v.id, is_default: !c.voices.length } }), '已绑定');
          invalidateVoices();
          reload();
        },
      });
    }
    const row = t.closest('[data-bv]');
    if (row) {
      const vid = Number(row.dataset.bv);
      const v = c.voices.find((x) => x.id === vid);
      if (t.closest('[data-def]')) { await guard(() => api(`/characters/${c.id}/voices/${vid}`, { method: 'PUT', body: { is_default: true } })); return reload(); }
      if (t.closest('[data-unbind]')) { await guard(() => api(`/characters/${c.id}/voices/${vid}`, { method: 'DELETE' })); invalidateVoices(); return reload(); }
      if (t.closest('[data-play]')) return previewVoice(v.voice_id, t.closest('[data-play]'), { title: `${c.name} · ${v.name}`, speed: v.speed, vol: v.vol, pitch: v.pitch });
    }
    if (t.closest('[data-delete]')) {
      if (!(await confirmBox(`删除角色「${c.name}」？其台词将变为旁白。`, { danger: true, okText: '删除' }))) return;
      await guard(() => api('/characters/' + c.id, { method: 'DELETE' }), '已删除');
      m.close();
      onSaved?.();
    }
    if (t.closest('[data-save]')) {
      const get = (n) => m.el.querySelector(`[name=${n}]`).value;
      const body = { name: get('name').trim(), aliases: get('aliases'), gender: get('gender'), age: get('age'), description: get('description') };
      if (isNew) {
        body.novel_id = get('novel_id') ? Number(get('novel_id')) : null;
        const nc = await guard(() => api('/characters', { body }), '已创建');
        m.close();
        onSaved?.();
        return openCharacterModal(nc.id, { novels, novelId: nc.novel_id, onSaved });
      }
      await guard(() => api('/characters/' + c.id, { method: 'PUT', body }), '已保存');
      m.close();
      onSaved?.();
    }
  });
  m.el.addEventListener('change', async (e) => {
    const inp = e.target.closest('[data-k]');
    if (!inp) return;
    const vid = Number(inp.closest('[data-bv]').dataset.bv);
    const v = c.voices.find((x) => x.id === vid);
    v[inp.dataset.k] = Number(inp.value);
    await guard(() => api(`/characters/${c.id}/voices/${vid}`, { method: 'PUT', body: { [inp.dataset.k]: Number(inp.value) } }));
  });
}

/** 角色表格（角色库页 & 小说详情页共用） */
export function characterTable(list, { showNovel = true } = {}) {
  if (!list.length) return '<div class="empty">暂无角色。拆分章节后会自动识别角色，也可以手动新建。</div>';
  return `<div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>角色</th>${showNovel ? '<th>小说</th>' : ''}<th>性别/年龄</th><th>别名</th><th>台词</th><th>绑定音色</th><th style="width:150px"></th></tr></thead>
    <tbody>${list.map((c) => `<tr data-cid="${c.id}">
      <td><span class="dot" style="background:${c.is_narrator ? 'var(--narr)' : colorOfName(c.name)}"></span> <b>${esc(c.name)}</b>${c.description ? `<div class="small muted" style="max-width:260px">${esc(c.description)}</div>` : ''}</td>
      ${showNovel ? `<td class="small">${esc(c.novel_title || '通用')}</td>` : ''}
      <td>${genderTag(c.gender)} <span class="small muted">${AGE[c.age || ''] || ''}</span></td>
      <td class="small muted" style="max-width:180px">${esc(c.aliases || '')}</td>
      <td>${c.line_count}</td>
      <td><div class="row" style="gap:4px">${c.voices.map((v) => `<span class="chip ${v.is_default ? 'def' : ''}" title="${esc(v.voice_id)}">${v.is_default ? '★ ' : ''}${esc(v.name)}<button class="icon" data-cplay="${esc(v.voice_id)}" data-speed="${v.speed}" data-vol="${v.vol}" data-pitch="${v.pitch}">▶</button></span>`).join('') || '<span class="tag warn">未绑定</span>'}</div></td>
      <td><div class="row" style="gap:4px;justify-content:flex-end">
        <button class="btn sm" data-cbind>选音色</button>
        <button class="btn sm" data-cedit>编辑</button>
        ${c.is_narrator ? '' : '<button class="btn sm" data-cmerge title="合并到另一个角色">合并</button>'}
      </div></td>
    </tr>`).join('')}</tbody></table></div>`;
}
function colorOfName(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 62% 46%)`;
}

/** 角色表格事件 */
export function bindCharacterTable(root, getList, refresh) {
  root.addEventListener('click', async (e) => {
    const tr = e.target.closest('[data-cid]');
    if (!tr) return;
    const c = getList().find((x) => x.id === Number(tr.dataset.cid));
    const pl = e.target.closest('[data-cplay]');
    if (pl) return previewVoice(pl.dataset.cplay, pl, { title: c.name, speed: Number(pl.dataset.speed), vol: Number(pl.dataset.vol), pitch: Number(pl.dataset.pitch) });
    if (e.target.closest('[data-cedit]')) return openCharacterModal(c.id, { novelId: c.novel_id, onSaved: refresh });
    if (e.target.closest('[data-cbind]')) {
      const def = c.voices.find((v) => v.is_default);
      return openVoicePicker({
        title: `为「${c.name}」选择默认音色`,
        currentId: def?.id,
        onPick: async (v) => {
          await guard(() => api(`/characters/${c.id}/voices`, { body: { voice_db_id: v.id, is_default: true } }), `「${c.name}」→ ${v.name}`);
          invalidateVoices();
          refresh();
        },
      });
    }
    if (e.target.closest('[data-cmerge]')) {
      const others = getList().filter((x) => x.novel_id === c.novel_id && x.id !== c.id && !x.is_narrator);
      if (!others.length) return toast('同一小说中没有其他角色可合并', 'err');
      const m = modal({
        title: `合并「${c.name}」`,
        body: `<div class="muted">把「${c.name}」的所有台词、别名和音色绑定转移到目标角色，然后删除「${c.name}」。适合 LLM 把同一人识别成两个名字的情况。</div>
          <label class="field">合并到<select data-target>${others.map((o) => `<option value="${o.id}">${esc(o.name)}（${o.line_count} 句）</option>`).join('')}</select></label>`,
        foot: '<button class="btn" data-x>取消</button><button class="btn primary" data-ok>合并</button>',
      });
      m.el.querySelector('[data-x]').onclick = m.close;
      m.el.querySelector('[data-ok]').onclick = async () => {
        await guard(() => api(`/characters/${c.id}/merge`, { body: { targetId: Number(m.el.querySelector('[data-target]').value) } }), '已合并');
        m.close();
        refresh();
      };
    }
  });
}
