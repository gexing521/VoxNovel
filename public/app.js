import { $, $$, api, esc, toast, guard, modal, confirmBox, promptBox, player, fileUrl, genderTag, colorOf, fmtDur, readTextFile, previewVoice, EMOTIONS, SOURCES, GENDER } from './lib.js';
import { loadVoices, invalidateVoices, voiceCard, filterVoices, filterBar, bindVoiceCommon, openVoicePicker, openCharacterModal, characterTable, bindCharacterTable, openNpcPoolManager, isNpcCharacter, characterVoice } from './components.js';

let view = $('#view');
let cleanup = null; // 当前视图的清理函数

// ================= 任务轮询 =================
const jobListeners = new Set();
let lastActive = '';
let knownActive = new Set();
async function pollJobs() {
  try {
    const active = await api('/jobs?active=1');
    const badge = $('#jobBadge');
    badge.textContent = active.length;
    badge.classList.toggle('hidden', !active.length);
    const sig = JSON.stringify(active.map((j) => [j.id, j.status, j.done, j.failed, j.message]));
    const nowIds = new Set(active.map((j) => j.id));
    const finished = [...knownActive].filter((id) => !nowIds.has(id));
    knownActive = nowIds;
    for (const id of finished) {
      const j = await api('/jobs/' + id).catch(() => null);
      if (j) toast(`${j.title}：${j.status === 'done' ? '完成' : j.status === 'error' ? '失败' : j.status} — ${j.message}`, j.status === 'done' ? 'ok' : j.status === 'error' ? 'err' : '');
    }
    if (sig !== lastActive || finished.length) {
      lastActive = sig;
      jobListeners.forEach((fn) => fn(active));
    }
  } catch {}
}
setInterval(pollJobs, 2000);
const onJobs = (fn) => { jobListeners.add(fn); return () => jobListeners.delete(fn); };
async function startJob(path, body, msg) {
  const r = await guard(() => api(path, { body }));
  toast(msg || '任务已开始', 'ok');
  lastActive = 'x';
  setTimeout(pollJobs, 300);
  return r;
}

// ================= 路由 =================
const routes = [
  [/^#\/novels$/, viewNovels, 'novels'],
  [/^#\/novel\/(\d+)$/, viewNovel, 'novels'],
  [/^#\/chapter\/(\d+)$/, viewChapter, 'novels'],
  [/^#\/characters$/, viewCharacters, 'characters'],
  [/^#\/voices$/, viewVoices, 'voices'],
  [/^#\/jobs$/, viewJobs, 'jobs'],
  [/^#\/settings$/, viewSettings, 'settings'],
];
async function router() {
  const hash = location.hash || '#/novels';
  cleanup?.();
  cleanup = null;
  // 换一个干净的容器，避免上一个视图的事件监听残留
  const fresh = view.cloneNode(false);
  view.replaceWith(fresh);
  view = fresh;
  window.scrollTo(0, 0);
  for (const [re, fn, nav] of routes) {
    const m = hash.match(re);
    if (m) {
      $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === nav));
      view.innerHTML = '<div class="muted">加载中…</div>';
      try { await fn(...m.slice(1).map(Number)); } catch (e) { view.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; }
      return;
    }
  }
  location.hash = '#/novels';
}
window.addEventListener('hashchange', router);

// ================= 小说库 =================
async function viewNovels() {
  const list = await api('/novels');
  view.innerHTML = `
    <div class="page-head"><h1>小说库</h1><div class="grow"></div><button class="btn primary" data-new>+ 导入小说</button></div>
    ${list.length ? `<div class="cards">${list.map((n) => {
      const pct = n.segment_count ? Math.round((n.done_count / n.segment_count) * 100) : 0;
      return `<div class="card" data-open="${n.id}">
        <div class="title">${esc(n.title)}</div>
        ${n.author ? `<div class="small muted">${esc(n.author)}</div>` : ''}
        <div class="stats"><span><b>${n.chapter_count}</b> 章</span><span><b>${(n.char_count / 10000).toFixed(1)}</b> 万字</span><span><b>${n.character_count}</b> 角色</span><span><b>${n.done_count}</b>/${n.segment_count} 片段</span></div>
        <div class="progress ${pct === 100 ? 'ok' : ''}"><i style="width:${pct}%"></i></div>
      </div>`;
    }).join('')}</div>` : `<div class="empty panel">还没有小说<br/><button class="btn primary" data-new>+ 导入第一本小说</button></div>`}`;
  view.onclick = (e) => {
    if (e.target.closest('[data-new]')) return openImport();
    const c = e.target.closest('[data-open]');
    if (c) location.hash = '#/novel/' + c.dataset.open;
  };
}

function importForm(withMeta) {
  return `${withMeta ? `<div class="grid2"><label class="field">书名<input name="title" /></label><label class="field">作者<input name="author" /></label></div>` : ''}
    <div class="row">
      <label class="btn sm primary">上传 TXT 文件<input type="file" accept=".txt,text/plain" multiple hidden data-file /></label>
      <span class="small muted" data-fname>支持 UTF-8 / GBK 编码，可多选，也可直接把文件拖到下方文本框</span>
    </div>
    <div class="row">
      <input data-url placeholder="或输入章节网址，如 http://www.wxxiaoshuo.cc/read/120503/44182870.html" style="flex:1;min-width:260px" />
      <button class="btn sm" type="button" data-fetch>抓取章节</button>
    </div>
    <label class="field">正文<textarea name="content" rows="14" placeholder="粘贴小说正文，或上传 / 拖入 TXT 文件，或从网址抓取（可多次抓取，按顺序追加）……"></textarea></label>
    <label class="check"><input type="checkbox" name="autoDetect" checked /> 自动识别章节（第X章 / 序章 / 楔子 / 番外 / Chapter N）</label>
    <label class="field" data-ctitle style="display:none">章节标题<input name="chapterTitle" placeholder="新章节" /></label>`;
}
function wireImport(m) {
  const ta = m.el.querySelector('[name=content]');
  const fname = m.el.querySelector('[data-fname]');
  const loadFiles = async (files) => {
    files = [...files].filter((f) => /\.txt$/i.test(f.name) || f.type.startsWith('text/'));
    if (!files.length) return toast('请选择 .txt 文件', 'err');
    files.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    const texts = [];
    for (const f of files) texts.push(await readTextFile(f));
    ta.value = (ta.value.trim() ? ta.value.trim() + '\n\n' : '') + texts.join('\n\n');
    fname.textContent = `已载入 ${files.map((f) => f.name).join('、')}（共 ${ta.value.length} 字）`;
    const t = m.el.querySelector('[name=title]');
    if (t && !t.value) t.value = files[0].name.replace(/\.txt$/i, '');
  };
  m.el.querySelector('[data-file]').onchange = (e) => loadFiles(e.target.files);
  ta.addEventListener('dragover', (e) => { e.preventDefault(); ta.style.borderColor = 'var(--accent)'; });
  ta.addEventListener('dragleave', () => (ta.style.borderColor = ''));
  ta.addEventListener('drop', (e) => {
    ta.style.borderColor = '';
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    loadFiles(e.dataTransfer.files);
  });
  m.el.querySelector('[data-fetch]').onclick = async (e) => {
    const url = m.el.querySelector('[data-url]').value.trim();
    if (!url) return;
    const b = e.currentTarget;
    b.disabled = true; b.textContent = '抓取中…';
    try {
      const r = await guard(() => api('/fetch-url', { body: { url } }));
      const title = r.title || '新章节';
      ta.value = (ta.value.trim() ? ta.value.trim() + '\n\n' : '') + title + '\n' + r.content;
      fname.textContent = `已抓取「${title}」${r.pages > 1 ? `（${r.pages} 页）` : ''}，${r.content.length} 字`;
      m.el.querySelector('[data-url]').value = '';
      // 抓取的标题若不是“第X章”格式，关闭自动识别并用它做章节标题
      if (!/^\s*(第\s*[0-9零一二三四五六七八九十百千万两〇]+\s*[章节回卷集部篇幕话]|序章|楔子|番外|尾声|Chapter)/i.test(title)) {
        const ad = m.el.querySelector('[name=autoDetect]');
        if (ad.checked && !ta.value.slice(0, -r.content.length - title.length - 1).trim()) {
          ad.checked = false;
          m.el.querySelector('[data-ctitle]').style.display = '';
          ta.value = r.content;
          m.el.querySelector('[name=chapterTitle]').value = title;
        }
      }
    } finally { b.disabled = false; b.textContent = '抓取章节'; }
  };
  m.el.querySelector('[name=autoDetect]').onchange = (e) => (m.el.querySelector('[data-ctitle]').style.display = e.target.checked ? 'none' : '');
}
function openImport() {
  const m = modal({ title: '导入小说', body: importForm(true), foot: '<button class="btn" data-x>取消</button><button class="btn primary" data-ok>导入</button>' });
  wireImport(m);
  m.el.querySelector('[data-x]').onclick = m.close;
  m.el.querySelector('[data-ok]').onclick = async () => {
    const g = (n) => m.el.querySelector(`[name=${n}]`);
    const n = await guard(() => api('/novels', { body: { title: g('title').value, author: g('author').value, content: g('content').value, autoDetect: g('autoDetect').checked, chapterTitle: g('chapterTitle').value } }), '导入成功');
    m.close();
    location.hash = '#/novel/' + n.id;
  };
}

// 任务结束后由现有轮询自动刷新生成按钮。
const generationBlocker = (book) => (book.active_jobs || []).find(j=>['identity','split','compress','generate'].includes(j.type));
const compressionBlocker = (book) => (book.active_jobs || []).find(j=>['identity','split','generate'].includes(j.type));
const generationWait = (book) => {
  const j=compressionBlocker(book) || generationBlocker(book);
  const wait = j?.type === 'compress'
    ? '其他未在处理的章节仍可整合旁白；生成音频需等待本书全部整合任务完成。'
    : '完成后生成和旁白整合按钮会自动恢复。';
  return j ? `<div class="panel small" data-generation-wait style="margin-bottom:12px">正在处理：<a href="#/jobs">${esc(j.title)}（任务 #${j.id}）</a>。${wait}${j.message ? `<div class="muted">${esc(j.message)}</div>` : ''}</div>` : '';
};
// ================= 视频旁白整合 =================
const compressionActive = (c) => ['queued', 'running'].includes(c.compression_status);
const VIDEO_NARRATION_VERSION = 'video-v2';
const compressionCurrent = (c) => c.compression_status === 'done' && c.compression_version === VIDEO_NARRATION_VERSION;
const compressionEligible = (c) => c.split_status === 'done' && !compressionCurrent(c) && !compressionActive(c);
const COMPRESSION_HELP = '以对白为主线整合必要的视频旁白，对白原文、说话人和顺序保持不变。将场景中的环境、动作和心理段落合成必要的过渡解说，省去画面可表达或对白已说明的重复旁白，保留因果与关键剧情，不按比例逐条缩写。原旁白会自动备份，可恢复；有省略段时，修改文本或重新拆分前请先恢复原旁白。变更后的旁白和整章音频需要重新生成。';
function compressionStatus(c) {
  const status = c.compression_status || 'none';
  const label = status === 'done' ? (compressionCurrent(c) ? '已整合' : '旧版已压缩 · 待整合') : ({ none: '未整合', queued: '整合排队中', running: '整合中…', error: '整合失败' }[status] || status);
  const tone = status === 'done' ? 'ok' : status === 'error' ? 'err' : compressionActive(c) ? 'warn' : '';
  const before = Number(c.narration_before_chars), after = Number(c.narration_after_chars);
  const metrics = status === 'done' && Number.isFinite(before) && Number.isFinite(after) && before > 0
    ? `<div class="small muted">${before} → ${after} 字</div>` : '';
  return `<span class="tag ${tone}"${c.compression_error ? ` title="${esc(c.compression_error)}"` : ''}>${esc(label)}</span>${metrics}`;
}

// ================= 小说详情 =================
async function viewNovel(id) {
  let tab = sessionStorage.getItem('novelTab') || 'chapters';
  let n, chars, npcPools;
  let npcBusy = false;
  let compressionBusy = false;
  const load = async () => {
    [n, chars, npcPools] = await Promise.all([api('/novels/' + id), api('/characters?novel_id=' + id), api('/npc-pools')]);
  };
  await load();
  const render = () => {
    const openNpcGroups = $$('[data-npc-group][open]', view).map((el) => el.dataset.npcGroup);
    const done = n.chapters.reduce((a, c) => a + c.done_count, 0);
    const total = n.chapters.reduce((a, c) => a + c.segment_count, 0);
    const unsplit = n.chapters.filter((c) => c.split_status !== 'done').length;
    const unbound = chars.filter((c) => !characterVoice(c) && c.line_count);
    const uncompressed = n.chapters.filter(compressionEligible).length;
    const compressed = n.chapters.filter(compressionCurrent).length;
    const compressing = n.chapters.filter(compressionActive).length;
    view.innerHTML = `
      <div class="crumbs"><a href="#/novels">小说库</a> / ${esc(n.title)}</div>
      <div class="page-head">
        <h1>${esc(n.title)}</h1>${n.author ? `<span class="muted">${esc(n.author)}</span>` : ''}
        <button class="icon" data-edit title="编辑信息">✎</button>
        <div class="grow"></div>
        <button class="btn" data-import>+ 追加章节</button>
        <button class="btn" data-split-all ${unsplit ? '' : 'disabled'}>拆分未拆分章节（${unsplit}）</button>
        <button class="btn" data-compress-all ${uncompressed && !compressionBlocker(n) && !compressionBusy ? '' : 'disabled'}>整合未整合章节旁白（${uncompressed}）</button>
        <button class="btn" data-identities>统一角色身份</button>
        <button class="btn" data-identity-report>身份认定依据</button>
        <button class="btn primary" data-gen-all ${generationBlocker(n) ? 'disabled' : ''}>一键生成全部</button>
        <button class="btn" data-dl>下载 ZIP</button>
        <button class="icon" data-del title="删除小说">🗑</button>
      </div>
      ${generationWait(n)}
      <div class="panel" style="margin-bottom:16px">
        <div class="stats" style="margin-bottom:8px"><span><b>${n.chapters.length}</b> 章</span><span><b>${chars.length - 1}</b> 个角色</span><span>已生成 <b>${done}</b> / ${total} 个片段</span>
          ${unbound.length ? `<span class="tag warn">${unbound.length} 个角色待配音色：${esc(unbound.slice(0, 5).map((c) => c.name).join('、'))}${unbound.length > 5 ? '…' : ''}</span>` : ''}</div>
        <div class="progress ${total && done === total ? 'ok' : ''}"><i style="width:${total ? (done / total) * 100 : 0}%"></i></div>
        <div class="small muted" style="margin-top:10px">视频旁白已整合 ${compressed} 章${compressing ? ` · 整合处理中 ${compressing} 章` : ''} · 可整合 ${uncompressed} 章（仅统计已拆分章节）</div>
        <p class="small muted" style="margin-bottom:0">${COMPRESSION_HELP}</p>
      </div>
      <div class="tabs"><button data-tab="chapters" class="${tab === 'chapters' ? 'active' : ''}">章节（${n.chapters.length}）</button><button data-tab="chars" class="${tab === 'chars' ? 'active' : ''}">角色与音色（${chars.length}）</button></div>
      <div data-body></div>`;
    const body = $('[data-body]', view);
    if (tab === 'chapters') {
      body.innerHTML = n.chapters.length ? `<div class="tbl-wrap"><table class="tbl">
        <thead><tr><th style="width:50px">#</th><th>章节</th><th>字数</th><th>拆分</th><th>视频旁白整合</th><th style="width:220px">生成进度</th><th>整章</th><th style="width:250px"></th></tr></thead>
        <tbody>${n.chapters.map((c) => {
          const pct = c.segment_count ? (c.done_count / c.segment_count) * 100 : 0;
          const st = { none: '<span class="tag">未拆分</span>', queued: '<span class="tag warn">排队中</span>', running: '<span class="tag warn">拆分中…</span>', done: `<span class="tag ok">${c.segment_count} 段</span>`, error: `<span class="tag err" title="${esc(c.split_error)}">失败</span>` }[c.split_status] || c.split_status;
          return `<tr data-ch="${c.id}">
            <td class="muted">${c.idx + 1}</td>
            <td><a href="#/chapter/${c.id}">${esc(c.title)}</a></td>
            <td class="muted">${c.length}</td>
            <td>${st}</td>
            <td>${compressionStatus(c)}</td>
            <td><div class="row" style="gap:8px"><div class="progress ${pct === 100 ? 'ok' : ''}" style="flex:1"><i style="width:${pct}%"></i></div><span class="small muted">${c.done_count}/${c.segment_count}${c.error_count ? ` <span style="color:var(--err)">✕${c.error_count}</span>` : ''}</span></div></td>
            <td>${c.merged_audio ? `<button class="btn sm" data-play-merged>▶ ${fmtDur(c.merged_duration_ms)}</button>` : '<span class="muted small">—</span>'}</td>
            <td><div class="row" style="gap:4px;justify-content:flex-end">
              <button class="btn sm" data-split>${c.split_status === 'done' ? '重新拆分' : '拆分'}</button>
              <button class="btn sm" data-compress ${c.split_status === 'done' && !compressionActive(c) && !compressionBlocker(n) && !compressionBusy ? '' : 'disabled'}>${compressionCurrent(c) ? '重新整合' : '整合旁白'}</button>
              <button class="btn sm" data-gen ${c.split_status === 'done' && !generationBlocker(n) ? '' : 'disabled'}>生成</button>
              <a class="btn sm" href="/api/chapters/${c.id}/download-merged" title="下载整章拼接 MP3 和 LRC" ${c.merged_audio && c.merged_lrc ? '' : 'aria-disabled="true" tabindex="-1" style="opacity:.5;pointer-events:none"'}>下载整章</a>
              <a class="btn sm" href="#/chapter/${c.id}">编辑</a>
              <button class="icon" data-chdel title="删除章节">✕</button>
            </div></td>
          </tr>`;
        }).join('')}</tbody></table></div>` : '<div class="empty panel">还没有章节，点击右上角「追加章节」导入正文</div>';
    } else {
      const npcs = chars.filter(isNpcCharacter);
      const missingNpc = npcs.filter((c) => !c.npc_voice).length;
      body.innerHTML = `<div class="panel" style="margin-bottom:14px">
        <div class="row" style="margin-bottom:10px"><b>NPC 集合配音</b><span class="small muted">${npcs.length} 个 NPC · ${missingNpc} 个待分配</span></div>
        <div class="row">
          <label class="small muted">本书音色集合 <select data-npc-pool ${npcBusy ? 'disabled' : ''}><option value="" ${n.npc_pool_id == null ? 'selected' : ''}>默认集合${npcPools[0] ? '（' + esc(npcPools[0].name) + '）' : '（尚未创建）'}</option>${npcPools.map((p) => `<option value="${p.id}" ${p.id === n.npc_pool_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
          <button class="btn sm" data-npc-pools>管理 NPC 音色集合</button>
          <button class="btn sm primary" data-npc-assign ${npcBusy ? 'disabled' : ''}>整理 NPC 并自动配音</button>
          <button class="btn sm" data-npc-reroll ${npcBusy || !npcs.length ? 'disabled' : ''}>重新分配 NPC 音色</button>
        </div>
        <p class="small muted" style="margin-bottom:0">先在集合中添加男声和女声。整理时自动识别 NPC，并仅补充缺少的音色；性别未知默认男。添加音色不会改变已有分配；切换集合或移除正在使用的音色会重新分配受影响 NPC。这里只分配音色，音频仍通过「一键生成全部」生成。</p>
      </div><div class="row" style="margin-bottom:12px"><button class="btn sm" data-newchar>+ 新建角色</button><span class="small muted">正式角色独立绑定音色；NPC 按男 / 女折叠，可展开编辑原名、类型和性别。</span></div>${characterTable(chars, { showNovel: false, openNpcGroups })}`;
    }
  };
  const refresh = async () => { await load(); render(); };
  render();
  bindCharacterTable(view, () => chars, refresh);
  view.onchange = async (e) => {
    if (!e.target.matches('[data-npc-pool]') || npcBusy) return;
    const poolId = e.target.value ? Number(e.target.value) : null;
    npcBusy = true;
    e.target.disabled = true;
    try {
      await guard(() => api('/novels/' + id, { method: 'PUT', body: { npc_pool_id: poolId } }), '已保存本书 NPC 音色集合');
      await load();
    } catch (e) {
      // 保留原来的选择，错误已由 guard 提示。
    } finally { npcBusy = false; render(); }
  };

  view.onclick = async (e) => {
    const t = e.target;
    const tb = t.closest('[data-tab]');
    if (tb) { tab = tb.dataset.tab; sessionStorage.setItem('novelTab', tab); return render(); }
    if (t.closest('[data-newchar]')) return openCharacterModal(null, { novelId: id, onSaved: refresh });
    if (t.closest('[data-npc-pools]')) return openNpcPoolManager({ poolId: n.npc_pool_id, onChanged: refresh });
    const assignNpc = t.closest('[data-npc-assign], [data-npc-reroll]');
    if (assignNpc) {
      if (npcBusy) return;
      const reroll = assignNpc.hasAttribute('data-npc-reroll');
      if (reroll && !(await confirmBox('为本书所有 NPC 重新分配音色？已有 NPC 的声音可能改变，之后生成音频将使用新的分配。正式角色的独立音色不受影响。', { okText: '确认重新分配' }))) return;
      npcBusy = true;
      render();
      try {
        const r = await guard(() => api(`/novels/${id}/npc-assign`, { body: { reroll } }));
        toast(`NPC 整理完成：共 ${r.npc_count} 个（男 ${r.male} / 女 ${r.female}），本次分配 ${r.assigned} 个音色`, 'ok');
        await load();
      } catch (e) {
        // API 错误已由 guard 提示，允许补充集合后再次执行。
      } finally { npcBusy = false; render(); }
      return;
    }
    if (t.closest('[data-import]')) {
      const m = modal({ title: '追加章节', body: importForm(false), foot: '<button class="btn" data-x>取消</button><button class="btn primary" data-ok>追加</button>' });
      wireImport(m);
      m.el.querySelector('[data-x]').onclick = m.close;
      m.el.querySelector('[data-ok]').onclick = async () => {
        const g = (k) => m.el.querySelector(`[name=${k}]`);
        const r = await guard(() => api(`/novels/${id}/chapters`, { body: { content: g('content').value, autoDetect: g('autoDetect').checked, title: g('chapterTitle').value } }));
        toast(`已追加 ${r.added} 章`, 'ok');
        m.close();
        refresh();
      };
      return;
    }
    if (t.closest('[data-edit]')) {
      const m = modal({ title: '编辑小说信息', body: `<label class="field">书名<input name="title" value="${esc(n.title)}"/></label><label class="field">作者<input name="author" value="${esc(n.author)}"/></label><label class="field">简介<textarea name="description" rows="3">${esc(n.description)}</textarea></label>`, foot: '<button class="btn primary" data-ok>保存</button>' });
      m.el.querySelector('[data-ok]').onclick = async () => {
        const g = (k) => m.el.querySelector(`[name=${k}]`).value;
        await guard(() => api('/novels/' + id, { method: 'PUT', body: { title: g('title'), author: g('author'), description: g('description') } }));
        m.close(); refresh();
      };
      return;
    }
    if (t.closest('[data-del]')) {
      if (!(await confirmBox(`删除《${n.title}》及其所有章节、角色和已生成的音频？此操作不可恢复。`, { danger: true, okText: '删除' }))) return;
      await guard(() => api('/novels/' + id, { method: 'DELETE' }), '已删除');
      location.hash = '#/novels';
      return;
    }
    if (t.closest('[data-identities]')) return startJob(`/novels/${id}/reconcile`, {}, '正在结合已导入的全部章节统一角色身份');
    if (t.closest('[data-identity-report]')) return openIdentityReport(id, n.chapters);
    if (t.closest('[data-split-all]')) return openSplitDialog(`/novels/${id}/split`, { onlyNew: true }, refresh);
    if (t.closest('[data-compress-all]')) {
      if (compressionBlocker(n)) return toast('请等待当前任务完成后再整合旁白，进度见任务页');
      const count = n.chapters.filter(compressionEligible).length;
      if (!count || compressionBusy) return;
      compressionBusy = true;
      render();
      try {
        if (!(await confirmBox(`整合本书 ${count} 个已拆分、尚未完成新版整合的章节旁白？${COMPRESSION_HELP}`, { okText: '开始视频旁白整合' }))) return;
        await startJob(`/novels/${id}/compress-narration`, { onlyNew: true }, '视频旁白整合任务已开始');
        await load();
      } finally { compressionBusy = false; render(); }
      return;
    }
    if (t.closest('[data-gen-all]')) {
      if(generationBlocker(n)) return toast('请等待当前任务完成后再生成，进度见任务页');
      const force = await askForce();
      if (force === null) return;
      await startJob(`/novels/${id}/generate`, { force }, '生成任务已开始');
      return;
    }
    if (t.closest('[data-dl]')) return (location.href = `/api/novels/${id}/download`);
    const tr = t.closest('[data-ch]');
    if (tr) {
      const cid = Number(tr.dataset.ch);
      const c = n.chapters.find((x) => x.id === cid);
      if (t.closest('[data-split]')) {
        if (c.split_status === 'done' && !(await confirmBox('重新拆分会覆盖本章所有片段的修改，并删除已生成的音频，确定？'))) return;
        return openSplitDialog(`/chapters/${cid}/split`, {}, refresh);
      }
      if (t.closest('[data-compress]')) {
        if (compressionBlocker(n)) return toast('请等待当前任务完成后再整合旁白，进度见任务页');
        if (c.split_status !== 'done' || compressionActive(c) || compressionBusy) return;
        const force = c.compression_status === 'done';
        compressionBusy = true;
        render();
        try {
          const detail = force ? '将从备份的原始旁白重新组织视频解说，不会在上次结果上累积删减。' : '';
          if (!(await confirmBox(`${compressionCurrent(c) ? '重新整合' : '整合'}「${c.title}」的视频旁白？${detail}${COMPRESSION_HELP}`, { okText: force ? '从原旁白重新整合' : '开始视频旁白整合' }))) return;
          await startJob(`/chapters/${cid}/compress-narration`, force ? { force: true } : {}, '本章视频旁白整合任务已开始');
          await load();
        } finally { compressionBusy = false; render(); }
        return;
      }
      if (t.closest('[data-gen]')) return startJob(`/chapters/${cid}/generate`, {}, '生成任务已开始');
      if (t.closest('[data-play-merged]')) return player.play(fileUrl(c.merged_audio), c.title, n.title);
      if (t.closest('[data-chdel]')) {
        if (!(await confirmBox(`删除章节「${c.title}」？`, { danger: true, okText: '删除' }))) return;
        await guard(() => api('/chapters/' + cid, { method: 'DELETE' }));
        return refresh();
      }
    }
  };
  let timer;
  cleanup = onJobs(() => { clearTimeout(timer); timer = setTimeout(refresh, 300); });
}

async function openIdentityReport(novelId, chapters) {
  const { report } = await api(`/novels/${novelId}/identities`);
  if (!report) return toast('尚未统一角色身份，点击「统一角色身份」开始', '');
  const titles = new Map(chapters.map(c => [c.id, c.title]));
  const m = modal({ title: '角色身份认定依据', wide: true, body: `
    <p class="muted">已结合 ${report.chapter_ids.length} 章认定 ${report.characters.length} 个角色。以下原文依据和别名范围可供核对。认定时间：${esc(new Date(report.created_at).toLocaleString())}</p>
    ${report.characters.map(c => `<div class="panel" style="margin-bottom:12px"><b>${esc(c.name)}</b> ${genderTag(c.gender)}
      <p class="small muted">${esc(c.description)}</p>
      <div class="small">${c.aliases.filter(a => a.name !== c.name).map(a => `<span class="tag" title="${esc(a.chapter_ids.map(id => titles.get(id) || id).join('、'))}">${esc(a.name)} · ${a.chapter_ids.length} 章</span>`).join(' ') || '无其他称呼'}</div>
      ${c.evidence.map(e => `<p class="small" style="line-height:1.7"><a href="#/chapter/${e.chapter_id}">${esc(titles.get(e.chapter_id) || '原文章节')}</a>：${esc(e.quote)}</p>`).join('')}
    </div>`).join('')}
    ${report.unresolved.length ? `<div class="panel"><b>待核对，未据此自动合并</b>${report.unresolved.map(s => `<p class="small muted">${esc(s)}</p>`).join('')}</div>` : ''}` });
  m.el.addEventListener('click', e => { if (e.target.closest('a[href^="#/chapter/"]')) m.close(); });
}

async function askForce() {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title: '生成音频',
      body: `<div class="muted" style="line-height:1.7">默认只生成<b>未生成或已修改</b>的片段（文本、音色、情绪变化都会自动识别），已完成的片段会跳过。</div>
        <label class="check"><input type="checkbox" data-force /> 强制全部重新生成</label>`,
      foot: '<button class="btn" data-x>取消</button><button class="btn primary" data-ok>开始生成</button>',
      onClose: () => !done && resolve(null),
    });
    m.el.querySelector('[data-x]').onclick = m.close;
    m.el.querySelector('[data-ok]').onclick = () => { done = true; const f = m.el.querySelector('[data-force]').checked; m.close(); resolve(f); };
  });
}

async function openSplitDialog(path, extra, after) {
  const s = await api('/settings');
  const m = modal({
    title: '拆分旁白与对话',
    body: `<div class="settings-sec">
      ${[['hybrid', '规则切分 + LLM 识别说话人（推荐）', '按引号精确切分，原文一字不改；LLM 只负责判断每句对话是谁说的、情绪是什么。稳定、省 token。'],
         ['llm', 'LLM 全文拆分', '让大模型直接拆分全文，适合引号不规范的文本；会逐块校验原文吻合度，不合格自动回退。'],
         ['rule', '仅规则切分（不调用 LLM）', '只按引号切出对话，说话人需要手动指定。']]
        .map(([v, t, d]) => `<label class="check" style="align-items:flex-start"><input type="radio" name="mode" value="${v}" ${s.split_mode === v ? 'checked' : ''} style="margin-top:3px"/><div><b>${t}</b><div class="small muted">${d}</div></div></label>`).join('')}
    </div><label class="check"><input type="checkbox" data-reconcile ${s.identity_prepass !== '0' ? 'checked' : ''} /> 先结合已导入的全部章节统一角色身份（仅规则模式不调用模型）</label><p class="small muted">后续章节揭示的姓名会用于前章角色，并合并重复称呼。正文未变化时复用认定结果。</p>`,
    foot: '<button class="btn" data-x>取消</button><button class="btn primary" data-ok>开始拆分</button>',
  });
  m.el.querySelector('[data-x]').onclick = m.close;
  m.el.querySelector('[data-ok]').onclick = async () => {
    const mode = m.el.querySelector('[name=mode]:checked').value;
    const reconcile = m.el.querySelector('[data-reconcile]').checked;
    m.close();
    await startJob(path, { ...extra, mode, reconcile }, '拆分任务已开始');
    after?.();
  };
}

// ================= 章节编辑 =================
async function viewChapter(id) {
  let c;
  let showOriginal = false;
  let restoreBusy = false;
  const load = async () => { c = await api('/chapters/' + id); };
  await load();

  const charOptions = (sel) => `<option value="">旁白</option>${c.characters.filter((x) => !x.is_narrator).map((x) => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}<option value="__new">+ 新角色…</option>`;
  const segHtml = (s) => {
    const ch = s.character_id && c.characters.find((x) => x.id === s.character_id);
    return `<div class="seg ${s.type}" data-sid="${s.id}" style="--c:${ch ? colorOf(ch.name) : 'var(--narr)'}">
      <div class="num"><span>${s.idx + 1}</span><span class="dot ${s.status}" title="${esc(s.status)}"></span></div>
      <div class="who">
        <select data-speaker>${charOptions(s.character_id)}</select>
        <span class="vname ${s.voice_override ? 'ov' : ''}" data-voice title="点击为该片段单独指定音色">${s.voice ? '🎙 ' + esc(s.voice.name) : '<span style="color:var(--err)">⚠ 待配音色</span>'}${s.voice_override ? '（单独）' : ''}</span>
      </div>
      <div class="txt" contenteditable="plaintext-only" spellcheck="false" data-text>${esc(s.text)}</div>
      <div class="acts">
        <select class="emo" data-emo title="情绪">${EMOTIONS.map(([v, l]) => `<option value="${v}" ${v === (s.emotion || '') ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <button class="icon" data-play title="播放" ${s.audio_file ? '' : 'disabled style="opacity:.3"'}>▶</button>
        <button class="icon" data-regen title="生成/重新生成此片段">↻</button>
        <button class="icon" data-more title="更多">⋯</button>
      </div>
      ${s.status === 'error' && s.error ? `<div class="err-msg">${esc(s.error)}</div>` : ''}
    </div>`;
  };

  const render = () => {
    const done = c.segments.filter((s) => s.status === 'done').length;
    const totalDur = c.segments.reduce((a, s) => a + (s.duration_ms || 0), 0);
    const cast = c.characters.map((ch) => ({ ...ch, n: c.segments.filter((s) => (ch.is_narrator ? s.type === 'narration' : s.character_id === ch.id)).length })).filter((ch) => ch.n || ch.is_narrator);
    view.innerHTML = `
      <div class="crumbs"><a href="#/novels">小说库</a> / <a href="#/novel/${c.novel_id}">${esc(c.novel.title)}</a> / ${esc(c.title)}</div>
      <div class="page-head">
        <h1>${esc(c.title)}</h1><button class="icon" data-rename title="重命名">✎</button>
        <div class="grow"></div>
        ${c.has_narration_backup ? `<button class="btn sm" data-restore-narration ${restoreBusy || compressionActive(c) ? 'disabled' : ''}>恢复原旁白</button>` : ''}
        ${c.prev ? `<a class="btn sm" href="#/chapter/${c.prev.id}">← 上一章</a>` : ''}${c.next ? `<a class="btn sm" href="#/chapter/${c.next.id}">下一章 →</a>` : ''}
      </div>
      ${generationWait(c)}
      <div class="editor">
        <div>
          ${c.split_error && c.split_status === 'done' ? `<div class="panel small" style="margin-bottom:10px;color:var(--warn);white-space:pre-wrap">${esc(c.split_error)}</div>` : ''}
          ${c.compression_status && c.compression_status !== 'none' ? `<div class="panel small" style="margin-bottom:10px">${compressionStatus(c)}<p class="small muted" style="margin-bottom:0">${c.compression_status === 'done' ? '原旁白已备份；对白主线保持原样。变更后的旁白需要重新生成音频，可使用上方「恢复原旁白」。' : compressionActive(c) ? '正在处理旁白，请在任务页查看进度；对话保持原样。' : esc(c.compression_error || '视频旁白整合未完成，可返回章节列表重试。')}</p></div>` : ''}
          ${c.split_status === 'error' ? `<div class="panel small" style="margin-bottom:10px;color:var(--err)">拆分失败：${esc(c.split_error)}</div>` : ''}
          ${['queued', 'running'].includes(c.split_status) ? '<div class="panel" style="margin-bottom:10px">⏳ 正在拆分，请稍候…（进度见「任务」）</div>' : ''}
          ${showOriginal ? `<div class="panel" style="white-space:pre-wrap;line-height:1.9;margin-bottom:12px"><div class="row" style="margin-bottom:8px"><b>原文</b><div style="flex:1"></div><button class="btn sm" data-save-orig>保存原文修改</button></div><textarea data-orig rows="20" style="width:100%">${esc(c.content)}</textarea></div>` : ''}
          ${c.segments.length ? `<div class="seg-list">${c.segments.map(segHtml).join('')}</div>` : `<div class="empty panel">本章还没有拆分<br/><button class="btn primary" data-split>拆分旁白与对话</button></div>`}
        </div>
        <div class="side-panel">
          <div class="panel">
            <h3>操作</h3>
            <div class="settings-sec" style="gap:8px">
              <button class="btn primary" data-gen ${c.segments.length && !generationBlocker(c) ? '' : 'disabled'}>生成本章音频</button>
              <button class="btn" data-split>${c.segments.length ? '重新拆分' : '拆分'}</button>
              <button class="btn" data-orig-toggle>${showOriginal ? '隐藏原文' : '查看/编辑原文'}</button>
              <button class="btn" data-dl ${done ? '' : 'disabled'}>下载本章 ZIP</button>
              ${c.merged_audio ? `<button class="btn" data-merged>▶ 播放整章（${fmtDur(c.merged_duration_ms)}）</button><a class="btn sm" href="${fileUrl(c.merged_lrc)}" target="_blank">查看整章 LRC</a>` : done === c.segments.length && done ? '<button class="btn" data-remerge>合成整章音频</button>' : ''}
            </div>
            <div class="legend-line" style="margin-top:12px"><span>已生成 ${done}/${c.segments.length}</span><span>${fmtDur(totalDur)}</span></div>
            <div class="progress ${done === c.segments.length && done ? 'ok' : ''}" style="margin-top:6px"><i style="width:${c.segments.length ? (done / c.segments.length) * 100 : 0}%"></i></div>
          </div>
          <div class="panel">
            <h3>本章角色</h3>
            <div class="cast">${cast.map((ch) => {
              const dv = characterVoice(ch);
              return `<div class="cast-item" data-cast="${ch.id}">
                <span class="sw" style="background:${ch.is_narrator ? 'var(--narr)' : colorOf(ch.name)}"></span>
                <div class="nm"><b>${esc(ch.name)}</b> ${isNpcCharacter(ch) ? '<span class="tag">NPC</span>' : ''} <span class="small muted">${ch.n} 句</span><div>${dv ? '🎙 ' + esc(dv.name || dv.voice_id) : `<span style="color:var(--err)">${isNpcCharacter(ch) ? '待集合分配' : '未绑定音色'}</span>`}</div></div>
                ${dv ? `<button class="play" data-cast-play title="试听">▶</button>` : ''}
                <button class="btn sm" data-cast-bind>${isNpcCharacter(ch) ? '集合' : '换'}</button>
                <button class="icon" data-cast-edit title="编辑角色">✎</button>
              </div>`;
            }).join('')}</div>
          </div>
        </div>
      </div>`;
  };
  render();

  const refresh = async () => { await load(); render(); };
  const seg = (sid) => c.segments.find((s) => s.id === sid);
  const replaceSeg = (ns) => {
    const i = c.segments.findIndex((s) => s.id === ns.id);
    c.segments[i] = { ...c.segments[i], ...ns };
    const el = $(`[data-sid="${ns.id}"]`, view);
    if (el) el.outerHTML = segHtml(c.segments[i]);
  };

  view.onclick = async (e) => {
    const t = e.target;
    if (t.closest('[data-split]')) {
      if (c.segments.length && !(await confirmBox('重新拆分会覆盖本章所有片段的修改，并删除已生成的音频，确定？'))) return;
      return openSplitDialog(`/chapters/${id}/split`, {}, refresh);
    }
    if (t.closest('[data-gen]')) {
      if(generationBlocker(c)) return toast('请等待当前任务完成后再生成，进度见任务页');
      const force = await askForce();
      if (force === null) return;
      return startJob(`/chapters/${id}/generate`, { force }, '生成任务已开始');
    }
    if (t.closest('[data-restore-narration]')) {
      if (restoreBusy || !c.has_narration_backup || compressionActive(c)) return;
      restoreBusy = true;
      render();
      try {
        if (!(await confirmBox('恢复本章备份的原始旁白？对话不变，当前整合后的旁白将被替换，受影响的旁白和整章音频需重新生成。请等待本书当前任务结束后操作。', { okText: '恢复原旁白' }))) return;
        await guard(() => api(`/chapters/${id}/restore-narration`, { body: {} }), '已恢复原旁白，请重新生成受影响的音频');
        await load();
      } finally { restoreBusy = false; render(); }
      return;
    }
    if (t.closest('[data-dl]')) return (location.href = `/api/chapters/${id}/download`);
    if (t.closest('[data-merged]')) return player.play(fileUrl(c.merged_audio), c.title + '（整章）', c.novel.title);
    if (t.closest('[data-remerge]')) { await guard(() => api(`/chapters/${id}/merge`, { body: {} })); return refresh(); }
    if (t.closest('[data-orig-toggle]')) { showOriginal = !showOriginal; return render(); }
    if (t.closest('[data-save-orig]')) {
      await guard(() => api('/chapters/' + id, { method: 'PUT', body: { content: $('[data-orig]', view).value } }), '原文已保存（需重新拆分才会生效）');
      return refresh();
    }
    if (t.closest('[data-rename]')) {
      const v = await promptBox('章节标题', { value: c.title });
      if (v) { await guard(() => api('/chapters/' + id, { method: 'PUT', body: { title: v } })); refresh(); }
      return;
    }
    const ci = t.closest('[data-cast]');
    if (ci) {
      const ch = c.characters.find((x) => x.id === Number(ci.dataset.cast));
      if (t.closest('[data-cast-play]')) { const dv = characterVoice(ch); if (dv) return previewVoice(dv.voice_id, t.closest('[data-cast-play]'), { title: `${ch.name} · ${dv.name}`, speed: dv.speed, vol: dv.vol, pitch: dv.pitch }); }
      if (t.closest('[data-cast-edit]')) return openCharacterModal(ch.id, { novelId: c.novel_id, onSaved: refresh });
      if (t.closest('[data-cast-bind]')) {
        if (isNpcCharacter(ch)) return openNpcPoolManager({ novelId: c.novel_id, onChanged: refresh });
        return openVoicePicker({
          title: `为「${ch.name}」选择默认音色（全书生效）`,
          currentId: (ch.voices.find((v) => v.is_default) || {}).id,
          onPick: async (v) => { await guard(() => api(`/characters/${ch.id}/voices`, { body: { voice_db_id: v.id, is_default: true } }), `「${ch.name}」→ ${v.name}`); invalidateVoices(); refresh(); },
        });
      }
    }
    const se = t.closest('[data-sid]');
    if (!se) return;
    const s = seg(Number(se.dataset.sid));
    if (t.closest('[data-play]') && s.audio_file) return player.play(fileUrl(s.audio_file), `#${s.idx + 1} ${s.speaker || '旁白'}`, s.text.slice(0, 40));
    if (t.closest('[data-regen]')) return startJob(`/chapters/${id}/generate`, { segmentIds: [s.id], force: true }, `片段 #${s.idx + 1} 已加入生成队列`);
    if (t.closest('[data-voice]')) {
      return openVoicePicker({
        title: `片段 #${s.idx + 1} 单独指定音色`,
        currentId: s.voice_override,
        allowClear: !!s.voice_override,
        clearText: '恢复使用角色音色',
        onPick: async (v) => replaceSeg(await guard(() => api('/segments/' + s.id, { method: 'PUT', body: { voice_override: v ? v.id : null } }))),
      });
    }
    if (t.closest('[data-more]')) {
      const m = modal({
        title: `片段 #${s.idx + 1}`,
        body: `<div class="settings-sec" style="gap:8px">
          <button class="btn" data-a="ins">在下方插入新片段</button>
          <button class="btn" data-a="merge">与下一个片段合并</button>
          <button class="btn" data-a="split">在光标处拆成两段（先在文本中点击光标位置）</button>
          ${s.lrc_file ? `<a class="btn" href="${fileUrl(s.lrc_file)}" target="_blank">查看 LRC</a><a class="btn" href="${fileUrl(s.audio_file, 1)}">下载 MP3</a>` : ''}
          <button class="btn danger" data-a="del">删除此片段</button></div>`,
      });
      const caret = lastCaret.sid === s.id ? lastCaret.pos : -1;
      m.el.onclick = async (ev) => {
        const a = ev.target.closest('[data-a]')?.dataset.a;
        if (!a) return;
        m.close();
        if (a === 'ins') { await guard(() => api(`/chapters/${id}/segments`, { body: { after: s.idx, text: '（新片段，点击编辑）' } })); return refresh(); }
        if (a === 'merge') { await guard(() => api(`/segments/${s.id}/merge-next`, { body: {} })); return refresh(); }
        if (a === 'del') { await guard(() => api('/segments/' + s.id, { method: 'DELETE' })); return refresh(); }
        if (a === 'split') {
          if (caret <= 0 || caret >= s.text.length) return toast('请先在该片段文本中点击要拆分的位置', 'err');
          const head = s.text.slice(0, caret), tail = s.text.slice(caret);
          await guard(() => api('/segments/' + s.id, { method: 'PUT', body: { text: head } }));
          await guard(() => api(`/chapters/${id}/segments`, { body: { after: s.idx, text: tail, character_id: s.character_id, type: s.type } }));
          return refresh();
        }
      };
    }
  };
  // 记录光标位置（用于拆分片段）
  const lastCaret = { sid: 0, pos: -1 };
  view.onkeyup = view.onmouseup = (e) => {
    const tx = e.target.closest?.('[data-text]');
    if (!tx) return;
    const sel = getSelection();
    if (!sel.rangeCount) return;
    const r = sel.getRangeAt(0).cloneRange();
    r.selectNodeContents(tx);
    r.setEnd(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
    lastCaret.sid = Number(tx.closest('[data-sid]').dataset.sid);
    lastCaret.pos = r.toString().length;
  };
  view.onchange = async (e) => {
    const se = e.target.closest('[data-sid]');
    if (!se) return;
    const s = seg(Number(se.dataset.sid));
    if (e.target.matches('[data-emo]')) return replaceSeg(await guard(() => api('/segments/' + s.id, { method: 'PUT', body: { emotion: e.target.value } })));
    if (e.target.matches('[data-speaker]')) {
      let v = e.target.value;
      if (v === '__new') {
        const name = await promptBox('新角色名称', { placeholder: '如：店小二' });
        if (!name) { e.target.value = s.character_id || ''; return; }
        await guard(() => api('/segments/' + s.id, { method: 'PUT', body: { speaker: name.trim() } }));
        return refresh();
      }
      replaceSeg(await guard(() => api('/segments/' + s.id, { method: 'PUT', body: { character_id: v ? Number(v) : null } })));
    }
  };
  view.addEventListener('focusout', async (e) => {
    const tx = e.target.closest?.('[data-text]');
    if (!tx) return;
    const s = seg(Number(tx.closest('[data-sid]').dataset.sid));
    const text = tx.innerText.replace(/\n+$/, '');
    if (!s || text === s.text) return;
    if (!text.trim()) { tx.innerText = s.text; return toast('文本不能为空，删除片段请用 ⋯ 菜单', 'err'); }
    s.text = text;
    await guard(() => api('/segments/' + s.id, { method: 'PUT', body: { text } }));
    toast('已保存', 'ok');
  });

  // 任务进行中时轮询刷新片段状态（不打断正在编辑的文本）
  let timer;
  const off = onJobs(async (active) => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const editing = document.activeElement?.matches?.('[data-text]');
      const fresh = await api('/chapters/' + id).catch(() => null);
      if (!fresh) return;
      const blockerChanged=JSON.stringify(c.active_jobs || [])!==JSON.stringify(fresh.active_jobs || []);
      if(blockerChanged && !editing){c=fresh;render();return;}
      c.active_jobs=fresh.active_jobs;
      if (editing || fresh.segments.length === c.segments.length && fresh.split_status === c.split_status) {
        // 只更新状态
        c.merged_audio = fresh.merged_audio;
        for (const ns of fresh.segments) {
          const os = seg(ns.id);
          if (!os) continue;
          if (os.status !== ns.status || os.audio_file !== ns.audio_file || os.error !== ns.error) {
            Object.assign(os, { status: ns.status, audio_file: ns.audio_file, lrc_file: ns.lrc_file, error: ns.error, duration_ms: ns.duration_ms });
            const el = $(`[data-sid="${ns.id}"]`, view);
            if (el && !el.contains(document.activeElement)) el.outerHTML = segHtml(os);
          }
        }
        if (!active.length && !editing) { c = fresh; render(); }
      } else {
        c = fresh;
        render();
      }
    }, 200);
  });
  cleanup = () => { off(); view.onkeyup = view.onmouseup = view.onchange = null; };
}

// ================= 角色库 =================
async function viewCharacters() {
  const novels = await api('/novels');
  let novelId = Number(sessionStorage.getItem('charNovel')) || '';
  let kw = '';
  let list = [];
  const load = async () => { list = await api('/characters' + (novelId ? '?novel_id=' + novelId : '')); };
  view.innerHTML = `
    <div class="page-head"><h1>角色库</h1><div class="grow"></div><button class="btn" data-npc-pools>NPC 音色集合</button><button class="btn primary" data-new>+ 新建角色</button></div>
    <div class="filters">
      <select data-novel><option value="">全部小说</option>${novels.map((n) => `<option value="${n.id}" ${n.id === novelId ? 'selected' : ''}>${esc(n.title)}</option>`).join('')}</select>
      <input type="search" placeholder="搜索角色名 / 别名 / 描述" data-kw />
      <span class="small muted">正式角色可绑定多个音色（★ 为默认）；NPC 从集合自动分配，按男 / 女折叠展示。</span>
    </div>
    <div data-list></div>`;
  const renderList = () => {
    const f = kw ? list.filter((c) => [c.name, c.aliases, c.description, c.novel_title].join(' ').includes(kw)) : list;
    const openNpcGroups = $$('[data-npc-group][open]', view).map((el) => el.dataset.npcGroup);
    $('[data-list]', view).innerHTML = characterTable(f, { showNovel: !novelId, openNpcGroups });
  };
  const refresh = async () => { await load(); renderList(); };
  await refresh();
  bindCharacterTable(view, () => list, refresh);
  $('[data-novel]', view).onchange = (e) => { novelId = Number(e.target.value) || ''; sessionStorage.setItem('charNovel', novelId); refresh(); };
  $('[data-kw]', view).oninput = (e) => { kw = e.target.value.trim(); renderList(); };
  $('[data-new]', view).onclick = () => openCharacterModal(null, { novels, novelId: novelId || null, onSaved: refresh });
  $('[data-npc-pools]', view).onclick = () => openNpcPoolManager({ novelId: novelId || null, onChanged: refresh });
}

// ================= 音色库 =================
async function viewVoices() {
  let list = await loadVoices(true);
  const state = { kw: '', gender: '', source: '' };
  view.innerHTML = `
    <div class="page-head"><h1>音色库</h1><span class="muted" data-count></span><div class="grow"></div>
      <a class="btn" href="https://www.minimax.cn/audio/voices" target="_blank" rel="noopener">官方音色库 ↗</a>
      <button class="btn" data-npc-pools>NPC 音色集合</button>
      <button class="btn" data-add>+ 添加音色 ID</button>
      <button class="btn primary" data-sync>同步账号音色</button>
    </div>
    <div class="panel small muted" style="margin-bottom:14px;line-height:1.7">
      内置了常用系统音色；点击「同步账号音色」会调用 MiniMax <span class="mono">/v1/get_voice</span> 拉取账号下全部可用音色（含系统、快速复刻、文生音色）。
      试听会实时合成并缓存，每个音色首次试听会消耗少量字符额度。
      <div class="row" style="margin-top:8px">试听文本 <input data-ptext style="flex:1" placeholder="留空使用设置中的默认试听文本" /></div>
    </div>
    <div class="filters" data-filters></div>
    <div class="voice-grid" data-grid></div>`;
  const renderGrid = () => {
    const items = filterVoices(list, state);
    $('[data-count]', view).textContent = `${items.length} / ${list.length}`;
    $('[data-grid]', view).innerHTML = items.map((v) => voiceCard(v)).join('') || '<div class="empty">没有匹配的音色</div>';
  };
  const renderFilters = () => { $('[data-filters]', view).innerHTML = filterBar(state); };
  renderFilters();
  renderGrid();
  const refresh = async () => { list = await loadVoices(true); renderGrid(); };

  bindVoiceCommon(view, () => list, null, () => $('[data-ptext]', view).value.trim());
  view.oninput = (e) => { if (e.target.matches('[data-kw]')) { state.kw = e.target.value; renderGrid(); } };
  view.onclick = async (e) => {
    const t = e.target;
    const fb = t.closest('[data-f]');
    if (fb) { state[fb.dataset.f] = fb.dataset.v; renderFilters(); $('[data-kw]', view).value = state.kw; return renderGrid(); }
    if (t.closest('[data-sync]')) {
      const b = t.closest('[data-sync]');
      b.disabled = true; b.textContent = '同步中…';
      try {
        const r = await guard(() => api('/voices/sync', { body: {} }));
        toast(`同步完成：共 ${r.total} 个，新增 ${r.added}`, 'ok');
        await refresh();
      } finally { b.disabled = false; b.textContent = '同步账号音色'; }
      return;
    }
    if (t.closest('[data-npc-pools]')) return openNpcPoolManager({ onChanged: refresh });
    if (t.closest('[data-add]')) return editVoice(null, refresh);
    const ed = t.closest('[data-edit]');
    if (ed) return editVoice(list.find((v) => v.id === Number(ed.dataset.edit)), refresh);
    const del = t.closest('[data-del]');
    if (del) {
      const v = list.find((x) => x.id === Number(del.dataset.del));
      if (!(await confirmBox(`删除音色「${v.name}」？已绑定的角色会解除绑定。`, { danger: true, okText: '删除' }))) return;
      await guard(() => api('/voices/' + v.id, { method: 'DELETE' }));
      return refresh();
    }
    const bd = t.closest('[data-bind]');
    if (bd) return bindVoiceToCharacter(list.find((v) => v.id === Number(bd.dataset.bind)), refresh);
  };
}

function editVoice(v, after) {
  const isNew = !v;
  v = v || { voice_id: '', name: '', description: '', gender: '', tags: '' };
  const m = modal({
    title: isNew ? '添加音色' : '编辑音色',
    body: `<label class="field">voice_id<span class="hint">系统音色、复刻音色或文生音色的 ID</span><input name="voice_id" value="${esc(v.voice_id)}" ${isNew ? '' : 'readonly'} /></label>
      <div class="grid2"><label class="field">显示名称<input name="name" value="${esc(v.name)}" /></label>
      <label class="field">性别<select name="gender">${Object.entries(GENDER).map(([k, l]) => `<option value="${k}" ${k === (v.gender || '') ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
      <label class="field">标签<span class="hint">逗号分隔，如：青年,温柔,旁白</span><input name="tags" value="${esc(v.tags)}" /></label>
      <label class="field">描述<textarea name="description" rows="2">${esc(v.description)}</textarea></label>`,
    foot: `${isNew ? '' : `<button class="play" data-try style="margin-right:auto">▶</button>`}<button class="btn" data-x>取消</button><button class="btn primary" data-ok>保存</button>`,
  });
  m.el.querySelector('[data-x]').onclick = m.close;
  m.el.querySelector('[data-try]')?.addEventListener('click', (e) => previewVoice(v.voice_id, e.currentTarget, { title: v.name }));
  m.el.querySelector('[data-ok]').onclick = async () => {
    const g = (k) => m.el.querySelector(`[name=${k}]`).value;
    const body = { voice_id: g('voice_id'), name: g('name'), gender: g('gender'), tags: g('tags'), description: g('description') };
    await guard(() => (isNew ? api('/voices', { body }) : api('/voices/' + v.id, { method: 'PUT', body })), '已保存');
    invalidateVoices();
    m.close();
    after();
  };
}

async function bindVoiceToCharacter(v, after) {
  const [novels, chars] = await Promise.all([api('/novels'), api('/characters')]);
  const m = modal({
    title: `绑定「${v.name}」到角色`,
    body: `<label class="field">小说<select data-n><option value="">全部</option>${novels.map((n) => `<option value="${n.id}">${esc(n.title)}</option>`).join('')}</select></label>
      <label class="field">角色<select data-c size="10" style="height:auto"></select></label>
      <label class="check"><input type="checkbox" data-def checked /> 设为该角色的默认音色</label>
      <p class="small muted">这里只列出正式角色。NPC 请添加到「NPC 音色集合」，再由小说批量分配。</p>`,
    foot: '<button class="btn" data-x>取消</button><button class="btn primary" data-ok>绑定</button>',
  });
  const fill = () => {
    const nid = Number(m.el.querySelector('[data-n]').value);
    m.el.querySelector('[data-c]').innerHTML = chars.filter((c) => !isNpcCharacter(c) && (!nid || c.novel_id === nid))
      .map((c) => `<option value="${c.id}">${esc(c.name)}${c.novel_title ? '（' + esc(c.novel_title) + '）' : ''}${c.voices.length ? ' · 现：' + esc((c.voices.find((x) => x.is_default) || c.voices[0]).name) : ''}</option>`).join('');
  };
  fill();
  m.el.querySelector('[data-n]').onchange = fill;
  m.el.querySelector('[data-x]').onclick = m.close;
  m.el.querySelector('[data-ok]').onclick = async () => {
    const cid = m.el.querySelector('[data-c]').value;
    if (!cid) return toast('请选择角色', 'err');
    await guard(() => api(`/characters/${cid}/voices`, { body: { voice_db_id: v.id, is_default: m.el.querySelector('[data-def]').checked } }), '已绑定');
    invalidateVoices();
    m.close();
    after();
  };
}

// ================= 任务 =================
async function viewJobs() {
  const render = async () => {
    const list = await api('/jobs');
    const st = { queued: 'tag warn', running: 'tag warn', done: 'tag ok', error: 'tag err', cancelled: 'tag', interrupted: 'tag err' };
    const name = { queued: '排队中', running: '进行中', done: '完成', error: '失败', cancelled: '已取消', interrupted: '已中断' };
    view.innerHTML = `<div class="page-head"><h1>任务</h1><div class="grow"></div><button class="btn" data-clear>清除已结束任务</button></div>
      ${list.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>#</th><th>任务</th><th>状态</th><th style="width:220px">进度</th><th>信息</th><th>时间</th><th></th></tr></thead><tbody>
      ${list.map((j) => `<tr><td class="muted">${j.id}</td><td>${j.novel_id ? `<a href="#/novel/${j.novel_id}">${esc(j.title)}</a>` : esc(j.title)}</td>
        <td><span class="${st[j.status] || 'tag'}">${name[j.status] || j.status}</span></td>
        <td><div class="row" style="gap:8px"><div class="progress ${j.status === 'done' ? 'ok' : ''}" style="flex:1"><i style="width:${j.total ? ((j.done + j.failed) / j.total) * 100 : j.status === 'done' ? 100 : 0}%"></i></div><span class="small muted">${j.done}${j.failed ? `+<span style="color:var(--err)">${j.failed}</span>` : ''}/${j.total}</span></div></td>
        <td class="small" style="max-width:420px;white-space:pre-wrap">${esc(j.message)}</td>
        <td class="small muted">${esc(j.created_at)}</td>
        <td>${['queued', 'running'].includes(j.status) ? `<button class="btn sm danger" data-cancel="${j.id}">取消</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty panel">暂无任务</div>'}`;
  };
  await render();
  view.onclick = async (e) => {
    const c = e.target.closest('[data-cancel]');
    if (c) { await guard(() => api(`/jobs/${c.dataset.cancel}/cancel`, { body: {} }), '已请求取消'); return render(); }
    if (e.target.closest('[data-clear]')) { await guard(() => api('/jobs', { method: 'DELETE' })); return render(); }
  };
  cleanup = onJobs(render);
}

// ================= 设置 =================
async function viewSettings() {
  const s = await api('/settings');
  const f = (key, label, { type = 'text', hint = '', ph = '', list = '' } = {}) =>
    `<label class="field">${label}${hint ? `<span class="hint">${hint}</span>` : ''}<input name="${key}" type="${type}" value="${esc(s[key])}" placeholder="${esc(ph)}" ${list ? `list="${list}"` : ''} autocomplete="off" /></label>`;
  const sel = (key, label, opts, hint = '') =>
    `<label class="field">${label}${hint ? `<span class="hint">${hint}</span>` : ''}<select name="${key}">${opts.map(([v, l]) => `<option value="${v}" ${String(s[key]) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
  const chk = (key, label) => `<label class="check"><input type="checkbox" name="${key}" ${s[key] === '1' ? 'checked' : ''} /> ${label}</label>`;

  view.innerHTML = `
    <div class="page-head"><h1>设置</h1><div class="grow"></div><button class="btn primary" data-save>保存设置</button></div>
    <form data-form autocomplete="off">
    <div class="panel settings-sec">
      <div class="sec-title"><h2 style="margin:0">大语言模型</h2><span class="small muted">OpenAI 兼容格式（/v1/chat/completions），默认 starlinkaisite.com</span></div>
      <p class="small muted">推荐中转服务：<a href="https://starlinkaisite.com" target="_blank" rel="noopener noreferrer">https://starlinkaisite.com</a></p>
      <div class="grid2">
        ${f('llm_base_url', 'Base URL', { hint: '填到 /v1 为止，例如 https://starlinkaisite.com/v1' })}
        ${f('llm_api_key', 'API Key', { type: 'password', hint: s.llm_api_key_set ? '已配置（留空/不修改则保持不变）' : '未配置', ph: 'sk-...' })}
        ${f('llm_model', '模型', { list: 'llmModels', hint: '可手动输入，或点「获取模型列表」' })}
        ${f('llm_temperature', '温度', { type: 'number' })}
        ${f('llm_chunk_chars', '每次请求的文本长度（字）', { type: 'number', hint: '越大越省请求次数，但上下文越长；建议 2000~4000' })}
        ${f('llm_timeout_ms', '请求超时（毫秒）', { type: 'number' })}
        ${sel('split_mode', '默认拆分模式', [['hybrid', '规则切分 + LLM 识别说话人（推荐）'], ['llm', 'LLM 全文拆分'], ['rule', '仅规则切分']])}
        ${sel('llm_json_mode', 'JSON 模式', [['1', '开启 response_format=json_object（不支持时自动降级）'], ['0', '关闭']])}
      </div>
      <datalist id="llmModels"></datalist>
      <div class="row">${chk('identity_prepass', '拆分前结合已导入的全部章节统一角色身份，回溯早期称呼并去重')}</div>
      <div class="row">${chk('detect_emotion', '让 LLM 为每句对话标注情绪（只使用当前语音模型支持的 MiniMax 情绪值，生成时按情绪合成）')}</div>
      <div class="row"><button type="button" class="btn sm" data-test-llm>测试连接</button><button type="button" class="btn sm" data-models>获取模型列表</button><span class="small muted" data-llm-res></span></div>
    </div>
    <div class="panel settings-sec">
      <div class="sec-title"><h2 style="margin:0">MiniMax 语音合成</h2><span class="small muted">WebSocket 同步语音合成 · Token Plan 密钥同样适用</span></div>
      <div class="grid2">
        ${f('minimax_api_key', 'API Key', { type: 'password', hint: s.minimax_api_key_set ? '已配置（不修改则保持不变）' : '未配置', ph: 'sk-...' })}
        ${f('tts_model', '语音模型', { list: 'ttsModels', hint: 'speech-2.8-hd / speech-2.8-turbo / speech-2.6-hd 等' })}
        ${f('minimax_ws_url', 'WebSocket 地址', { hint: '国内：wss://api.minimaxi.com/ws/v1/t2a_v2　国际：wss://api.minimax.io/ws/v1/t2a_v2' })}
        ${f('minimax_api_base', 'HTTP API 地址（同步音色用）', { hint: '国内：https://api.minimaxi.com　国际：https://api.minimax.io' })}
        ${sel('tts_language_boost', '语种增强', [['Chinese', '中文'], ['Chinese,Yue', '粤语'], ['English', '英文'], ['auto', '自动'], ['none', '不设置']])}
        ${sel('tts_sample_rate', '采样率', [['16000', '16000'], ['24000', '24000'], ['32000', '32000'], ['44100', '44100']])}
        ${sel('tts_bitrate', '码率', [['64000', '64k'], ['128000', '128k'], ['256000', '256k']])}
        ${f('tts_concurrency', '并发数', { type: 'number', hint: '同时合成的片段数，按账号 RPM 配额调整（1~10）' })}
        ${f('tts_rpm', '每分钟请求上限（RPM）', { type: 'number', hint: '所有合成请求共用；遇到 1002 限流会自动冷却重试。Token Plan 建议 20~30' })}
        ${f('tts_max_retries', '失败重试次数', { type: 'number' })}
        ${f('default_narrator_voice', '新小说的默认旁白音色 voice_id', {})}
      </div>
      <datalist id="ttsModels"><option value="speech-2.8-hd"><option value="speech-2.8-turbo"><option value="speech-2.6-hd"><option value="speech-2.6-turbo"><option value="speech-02-hd"><option value="speech-02-turbo"></datalist>
      ${f('preview_text', '试听文本')}
      <div class="row">${chk('auto_assign_voice', '拆分后为未绑定音色的新角色自动分配音色')}${chk('ai_casting', 'AI 选角：让大模型根据人设从音色库挑选最合适且不重复的音色（关闭则按性别/年龄规则分配）')}</div>
      <div class="row"><button type="button" class="btn sm" data-test-tts>测试合成</button><span class="small muted" data-tts-res></span></div>
    </div>
    <div class="panel settings-sec">
      <h2 style="margin:0">片段与字幕</h2>
      <div class="grid3">
        ${f('max_segment_chars', '单个片段最大字数', { type: 'number', hint: '超过会按句子切开' })}
        ${f('merge_narration_chars', '合并相邻旁白（字数上限）', { type: 'number', hint: '0 = 不合并，每个自然段一个片段' })}
        ${f('lrc_max_line_chars', 'LRC 每行最大字数', { type: 'number' })}
      </div>
      <div class="row">${chk('build_merged', '章节全部生成后自动合成整章 MP3 + LRC')}${chk('lrc_speaker_prefix', '整章 LRC 中对话行加「角色名：」前缀')}</div>
    </div>
    </form>`;

  const collect = () => {
    const out = {};
    for (const el of $$('[data-form] [name]', view)) out[el.name] = el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value;
    return out;
  };
  const save = async (quiet) => { await guard(() => api('/settings', { method: 'PUT', body: collect() }), quiet ? null : '设置已保存'); };
  view.onclick = async (e) => {
    const t = e.target;
    if (t.closest('[data-save]')) return save();
    if (t.closest('[data-test-llm]')) {
      await save(true);
      const out = $('[data-llm-res]', view);
      out.textContent = '测试中…';
      try { const r = await api('/settings/test-llm', { body: {} }); out.innerHTML = `<span style="color:var(--ok)">✓ 连接成功（${r.ms}ms）</span> ${esc(r.reply)}`; }
      catch (err) { out.innerHTML = `<span style="color:var(--err)">✕ ${esc(err.message)}</span>`; }
    }
    if (t.closest('[data-models]')) {
      await save(true);
      const out = $('[data-llm-res]', view);
      try { const r = await api('/settings/llm-models'); $('#llmModels').innerHTML = r.models.map((m) => `<option value="${esc(m)}">`).join(''); out.textContent = `获取到 ${r.models.length} 个模型，点击「模型」输入框选择`; }
      catch (err) { out.innerHTML = `<span style="color:var(--err)">✕ ${esc(err.message)}</span>`; }
    }
    if (t.closest('[data-test-tts]')) {
      await save(true);
      const out = $('[data-tts-res]', view);
      out.textContent = '合成中…';
      try { const r = await api('/settings/test-tts', { body: {} }); out.innerHTML = `<span style="color:var(--ok)">✓ 合成成功（${r.ms}ms，${(r.bytes / 1024).toFixed(1)}KB）</span>`; }
      catch (err) { out.innerHTML = `<span style="color:var(--err)">✕ ${esc(err.message)}</span>`; }
    }
  };
}

// ================= 启动 / 登录 =================
async function boot() {
  const a = await api('/auth').catch(() => ({ required: false, ok: true }));
  if (a.required && !a.ok) return showLogin();
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#logoutBtn').classList.toggle('hidden', !a.required);
  router();
  pollJobs();
}
function showLogin() {
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
}
window.addEventListener('need-login', showLogin);
$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api('/login', { body: { password: e.target.password.value } });
    boot();
  } catch (err) { $('#loginErr').textContent = err.message; }
};
$('#logoutBtn').onclick = async () => { await api('/logout', { body: {} }); location.reload(); };
$('#playerClose').onclick = () => player.stop();
boot();
