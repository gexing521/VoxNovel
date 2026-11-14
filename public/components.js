import { $, $$, api, esc, modal, toast, guard, previewVoice, genderTag, SOURCES, GENDER, AGE, confirmBox, promptBox } from './lib.js';

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

/** NPC 使用集合分配的音色，普通角色保留独立音色绑定。 */
export const isNpcCharacter = (c) => !c.is_narrator && (c.role_type === 'npc' || (c.role_type !== 'named' && !!c.is_npc));
export const npcGender = (c) => (c.npc_gender || c.gender) === 'female' ? 'female' : 'male';
export const characterVoice = (c) => isNpcCharacter(c) ? c.npc_voice : (c.voices || []).find((v) => v.is_default) || (c.voices || [])[0];

/** NPC 音色集合。分组由成员 gender 决定，与音色库元数据无关。 */
export async function openNpcPoolManager({ poolId = null, novelId = null, onChanged } = {}) {
  let pools = await guard(() => api('/npc-pools'));
  if (novelId && poolId == null) {
    const novel = await guard(() => api('/novels/' + novelId));
    poolId = novel.npc_pool_id;
  }
  let selectedId = poolId ?? pools[0]?.id ?? null;
  let busy = false;
  const m = modal({
    title: 'NPC 音色集合', wide: true,
    body: '<div data-pool-manager></div>',
    foot: '<button class="btn" data-pool-close>关闭</button>',
  });
  const box = m.el.querySelector('[data-pool-manager]');
  const render = () => {
    const pool = pools.find((p) => p.id === selectedId) || pools[0];
    selectedId = pool?.id ?? null;
    box.innerHTML = `<p class="small muted">为男 NPC、女 NPC 分别准备可复用的音色。添加时所选分组决定集合内性别，不修改音色库的性别。角色保留原名，无需逐个挑选音色。</p>
      <div class="row" style="margin-bottom:16px">
        <select data-pool-select aria-label="NPC 音色集合" style="flex:1" ${pools.length ? '' : 'disabled'}>${pools.length ? pools.map((p, i) => `<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>${esc(p.name)}${i === 0 ? '（默认）' : ''}</option>`).join('') : '<option>暂无集合</option>'}</select>
        <button class="btn sm primary" data-pool-create>+ 新建集合</button>
        ${pool ? `<button class="btn sm" data-pool-rename>重命名</button><button class="btn sm danger" data-pool-delete ${pools.length < 2 ? 'disabled title="至少保留一个 NPC 音色集合"' : ''}>删除集合</button>` : ''}
      </div>
      ${pool ? `<div class="grid2">${['male', 'female'].map((gender) => {
        const voices = (pool.voices || []).filter((v) => (v.pool_gender || v.gender) === gender);
        const label = gender === 'male' ? '男 NPC' : '女 NPC';
        return `<section class="panel"><div class="row" style="margin-bottom:10px"><b>${label} · ${voices.length} 个音色</b><div class="grow"></div><button class="btn sm" data-pool-add="${gender}">+ 添加${gender === 'male' ? '男' : '女'}声</button></div>
          ${voices.length ? voices.map((v) => `<div class="row" style="padding:8px 0;border-bottom:1px solid var(--line)">
            <button class="play" data-pool-preview="${v.id}" title="试听">▶</button>
            <div style="flex:1;min-width:100px"><b>${esc(v.name || v.voice_id)}</b><div class="small muted mono">${esc(v.voice_id)}</div></div>
            <select data-pool-gender="${v.id}" aria-label="${esc(v.name || v.voice_id)}的集合性别"><option value="male" ${gender === 'male' ? 'selected' : ''}>男 NPC</option><option value="female" ${gender === 'female' ? 'selected' : ''}>女 NPC</option></select>
            <button class="icon" data-pool-remove="${v.id}" title="从集合移除">✕</button>
          </div>`).join('') : '<div class="small muted">此分组还没有音色，请先添加。</div>'}
        </section>`;
      }).join('')}</div>` : '<div class="empty">新建一个集合，再分别添加男声和女声。</div>'}
      <p class="small muted">小说可选择使用哪个集合；未指定时使用列表中的默认集合。整理 NPC 时仅补充分配，已有音色保留；需要换一批音色时，在小说的「角色与音色」中明确重新分配。</p>`;
  };
  const mutate = async (fn, message, nextId) => {
    if (busy) return;
    busy = true;
    box.querySelectorAll('button,select').forEach((el) => { el.disabled = true; });
    try {
      await guard(async () => {
        const result = await fn();
        pools = await api('/npc-pools');
        if (nextId) selectedId = nextId(result);
        await onChanged?.();
      }, message);
    } catch (e) {
      // guard 已显示 API 错误；保留弹窗以便重试。
    } finally { busy = false; render(); }
  };
  render();
  m.el.addEventListener('change', async (e) => {
    if (busy) return;
    if (e.target.matches('[data-pool-select]')) { selectedId = Number(e.target.value); return render(); }
    const select = e.target.closest('[data-pool-gender]');
    if (select) await mutate(() => api(`/npc-pools/${selectedId}/voices`, { body: { voice_db_id: Number(select.dataset.poolGender), gender: select.value } }), '已更新集合内性别');
  });
  m.el.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('[data-pool-close]')) return m.close();
    if (busy) return;
    const pool = pools.find((p) => p.id === selectedId);
    if (t.closest('[data-pool-create]')) {
      const name = await promptBox('新建 NPC 音色集合', { placeholder: '如：通用配角、武侠配角' });
      if (!name?.trim()) return;
      return mutate(() => api('/npc-pools', { body: { name: name.trim() } }), '集合已创建', (r) => r.id);
    }
    if (!pool) return;
    if (t.closest('[data-pool-rename]')) {
      const name = await promptBox('重命名 NPC 音色集合', { value: pool.name });
      if (!name?.trim() || name.trim() === pool.name) return;
      return mutate(() => api('/npc-pools/' + pool.id, { method: 'PUT', body: { name: name.trim() } }), '集合已重命名');
    }
    if (t.closest('[data-pool-delete]')) {
      if (!(await confirmBox(`删除 NPC 音色集合「${pool.name}」？集合中的音色仍保留在音色库中。使用该集合的小说将改用默认集合。`, { danger: true, okText: '删除集合' }))) return;
      return mutate(() => api('/npc-pools/' + pool.id, { method: 'DELETE' }), '集合已删除');
    }
    const add = t.closest('[data-pool-add]');
    if (add) {
      const gender = add.dataset.poolAdd;
      const targetId = pool.id;
      return openVoicePicker({
        title: `添加到「${pool.name}」· ${gender === 'male' ? '男 NPC' : '女 NPC'}`,
        onPick: (v) => mutate(() => api(`/npc-pools/${targetId}/voices`, { body: { voice_db_id: v.id, gender } }), '已添加到集合'),
      });
    }
    const remove = t.closest('[data-pool-remove]');
    if (remove) return mutate(() => api(`/npc-pools/${pool.id}/voices/${Number(remove.dataset.poolRemove)}`, { method: 'DELETE' }), '已从集合移除');
    const preview = t.closest('[data-pool-preview]');
    if (preview) {
      const voice = pool.voices.find((v) => v.id === Number(preview.dataset.poolPreview));
      if (voice) return previewVoice(voice.voice_id, preview, { title: voice.name || voice.voice_id });
    }
  });
}

/** 角色编辑弹窗：基本信息 + 多音色绑定 */
export async function openCharacterModal(charId, { novels = null, novelId = null, onSaved } = {}) {
  const isNew = !charId;
  let c = { name: '', aliases: '', gender: '', age: '', description: '', novel_id: novelId, role_type: 'auto', voices: [] };
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
        <label class="field">角色类型<select name="role_type" ${c.is_narrator ? 'disabled' : ''}>${[['auto', '自动识别'], ['named', '正式角色（独立音色）'], ['npc', 'NPC（使用音色集合）']].map(([k, label]) => `<option value="${k}" ${k === (c.role_type || 'auto') ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      </div>
      <p class="small muted">自动识别会区分正式角色与 NPC；也可手动指定。NPC 无需逐个选音色，按性别从小说所选集合分配；性别未知默认按男 NPC 处理，可在上方改为女性。</p>
      <label class="field">别名 / 称呼<span class="hint">逗号分隔。拆分时 LLM 会把这些称呼识别为同一角色</span><input name="aliases" value="${esc(c.aliases)}" /></label>
      <label class="field">人设描述<textarea name="description" rows="2">${esc(c.description)}</textarea></label>
      <div data-npc-binding></div>
      ${isNew ? '' : `<div data-named-binding><h3>绑定音色 <span class="muted small">（可绑定多个，★ 为默认使用的音色；语速/音量/音调仅对该角色生效）</span></h3>
        <div data-binds class="settings-sec" style="gap:8px"></div>
        <button class="btn sm" data-add style="margin-top:10px">+ 添加音色</button></div>`}`,
    foot: `${!isNew && !c.is_narrator ? '<button class="btn danger" data-delete style="margin-right:auto">删除角色</button>' : ''}<button class="btn" data-cancel>关闭</button><button class="btn primary" data-save>保存</button>`,
  });

  const renderBinds = () => {
    const role = m.el.querySelector('[name=role_type]').value;
    const npc = !c.is_narrator && (role === 'npc' || (role === 'auto' && isNpcCharacter(c)));
    const npcBox = m.el.querySelector('[data-npc-binding]');
    const namedBox = m.el.querySelector('[data-named-binding]');
    if (namedBox) namedBox.hidden = npc;
    npcBox.hidden = !npc;
    const v = c.npc_voice;
    npcBox.innerHTML = npc ? `<div class="panel"><h3>NPC 集合音色</h3><p class="small">${v ? `当前：<b>${esc(v.name || v.voice_id)}</b> <button class="play" data-npc-preview title="试听">▶</button>` : '保存后按小说所选集合自动分配音色；也可在小说的「角色与音色」中点击「整理 NPC 并自动配音」。'}</p><p class="small muted">无需单独绑定音色。修改类型或性别后保存，自动更新相应分配；要更换已有分配，请使用小说中的「重新分配 NPC 音色」。</p><button class="btn sm" data-npc-pools>管理 NPC 音色集合</button></div>` : '';
    const box = m.el.querySelector('[data-binds]');
    if (!box) return;
    box.innerHTML = (c.voices || []).length
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
    if (t.closest('[data-npc-pools]')) return openNpcPoolManager({ novelId: c.novel_id, onChanged: reload });
    if (t.closest('[data-npc-preview]') && c.npc_voice) return previewVoice(c.npc_voice.voice_id, t.closest('[data-npc-preview]'), { title: `${c.name} · ${c.npc_voice.name}` });
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
      const body = { name: get('name').trim(), aliases: get('aliases'), gender: get('gender'), age: get('age'), description: get('description'), role_type: get('role_type') };
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
    if (e.target.matches('[name=role_type]')) return renderBinds();
    const inp = e.target.closest('[data-k]');
    if (!inp) return;
    const vid = Number(inp.closest('[data-bv]').dataset.bv);
    const v = c.voices.find((x) => x.id === vid);
    v[inp.dataset.k] = Number(inp.value);
    await guard(() => api(`/characters/${c.id}/voices/${vid}`, { method: 'PUT', body: { [inp.dataset.k]: Number(inp.value) } }));
  });
}

/** 角色表格（角色库页 & 小说详情页共用） */
export function characterTable(list, { showNovel = true, openNpcGroups = [] } = {}) {
  if (!list.length) return '<div class="empty">暂无角色。拆分章节后会自动识别角色，也可以手动新建。</div>';
  const table = (characters) => `<div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>角色</th>${showNovel ? '<th>小说</th>' : ''}<th>性别/年龄</th><th>别名</th><th>台词</th><th>使用音色</th><th style="width:150px"></th></tr></thead>
    <tbody>${characters.map((c) => {
      const npc = isNpcCharacter(c);
      const voices = npc ? (c.npc_voice ? [c.npc_voice] : []) : (c.voices || []);
      return `<tr data-cid="${c.id}">
      <td><span class="dot" style="background:${c.is_narrator ? 'var(--narr)' : colorOfName(c.name)}"></span> <b>${esc(c.name)}</b>${npc ? ' <span class="tag">NPC</span>' : ''}${c.description ? `<div class="small muted" style="max-width:260px">${esc(c.description)}</div>` : ''}</td>
      ${showNovel ? `<td class="small">${esc(c.novel_title || '通用')}</td>` : ''}
      <td>${genderTag(npc ? npcGender(c) : c.gender)} <span class="small muted">${esc(AGE[c.age || ''] || '')}</span></td>
      <td class="small muted" style="max-width:180px">${esc(c.aliases || '')}</td>
      <td>${Number(c.line_count) || 0}</td>
      <td><div class="row" style="gap:4px">${voices.map((v) => `<span class="chip ${!npc && v.is_default ? 'def' : ''}" title="${esc(v.voice_id)}">${!npc && v.is_default ? '★ ' : ''}${esc(v.name || v.voice_id)}<button class="icon" data-cplay="${esc(v.voice_id)}" data-speed="${esc(v.speed ?? 1)}" data-vol="${esc(v.vol ?? 1)}" data-pitch="${esc(v.pitch ?? 0)}">▶</button></span>`).join('') || `<span class="tag warn">${npc ? '待集合分配' : '未绑定'}</span>`}</div></td>
      <td><div class="row" style="gap:4px;justify-content:flex-end">
        ${npc ? '<button class="btn sm" data-cpool>管理集合</button>' : '<button class="btn sm" data-cbind>选音色</button>'}
        <button class="btn sm" data-cedit>编辑</button>
        ${c.is_narrator ? '' : '<button class="btn sm" data-cmerge title="合并到另一个角色">合并</button>'}
      </div></td>
    </tr>`;
    }).join('')}</tbody></table></div>`;
  const named = list.filter((c) => !isNpcCharacter(c));
  return `${named.length ? table(named) : ''}${['male', 'female'].map((gender) => {
    const npcs = list.filter((c) => isNpcCharacter(c) && npcGender(c) === gender);
    if (!npcs.length) return '';
    const assigned = npcs.filter((c) => c.npc_voice).length;
    return `<details class="panel" data-npc-group="${gender}" ${openNpcGroups.includes(gender) ? 'open' : ''} style="margin-top:14px"><summary style="cursor:pointer"><b>${gender === 'male' ? '男 NPC' : '女 NPC'}（${npcs.length}）</b><span class="small muted"> · 已配音色 ${assigned}/${npcs.length} · 展开查看原名与编辑</span></summary><div style="margin-top:12px">${table(npcs)}</div></details>`;
  }).join('')}`;
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
    if (!c) return;
    const pl = e.target.closest('[data-cplay]');
    if (pl) return previewVoice(pl.dataset.cplay, pl, { title: c.name, speed: Number(pl.dataset.speed), vol: Number(pl.dataset.vol), pitch: Number(pl.dataset.pitch) });
    if (e.target.closest('[data-cedit]')) return openCharacterModal(c.id, { novelId: c.novel_id, onSaved: refresh });
    if (e.target.closest('[data-cpool]')) return openNpcPoolManager({ novelId: c.novel_id, onChanged: refresh });
    if (e.target.closest('[data-cbind]')) {
      if (isNpcCharacter(c)) return openCharacterModal(c.id, { novelId: c.novel_id, onSaved: refresh });
      const def = (c.voices || []).find((v) => v.is_default);
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
