// 无付费调用：验证真实 HTTP API、SQLite 持久化、性别池隔离和音频失效。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'voxnovel-npc-'));
const root = path.resolve(import.meta.dirname, '..');
const base = 'http://127.0.0.1:18113/api';
let child, db;
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); console.log('✓', label); checks++; };
async function start() {
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: root, env: { ...process.env, DATA_DIR: data, HOST: '127.0.0.1', PORT: '18113', APP_PASSWORD: '', LLM_API_KEY: '', MINIMAX_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let error = '';
  child.stderr.on('data', b => { error += b; });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('startup timeout: ' + error)), 10000);
    child.once('exit', code => { clearTimeout(timeout); reject(new Error('startup failed ' + code + ': ' + error)); });
    child.stdout.on('data', b => { if (String(b).includes('已启动')) { clearTimeout(timeout); resolve(); } });
  });
}
async function stop() { if (child && child.exitCode == null) { const exited = once(child, 'exit'); child.kill(); await exited; } }
async function api(url, body, method = body === undefined ? 'GET' : 'POST', expected = 200) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await r.json();
  assert.equal(r.status, expected, JSON.stringify(result));
  return result;
}
try {
  await start();
  db = new DatabaseSync(path.join(data, 'app.db'));
  const pools = await api('/npc-pools');
  check(pools.length === 1 && pools[0].voices.filter(v => v.gender === 'male').length === 6 && pools[0].voices.filter(v => v.gender === 'female').length === 6, '首次启动生成可编辑的男女默认合集');
  const pool = pools[0];
  const novel = await api('/novels', { title: 'NPC 回归', content: '第一章\n侍卫说：“站住。”\n少女说：“好。”' });
  const named = await api('/characters', { novel_id: novel.id, name: '林默', gender: 'male' });
  const male = await api('/characters', { novel_id: novel.id, name: '侍卫甲', description: '保护少女的侍卫' });
  const female = await api('/characters', { novel_id: novel.id, name: '少女' });
  const title = await api('/characters', { novel_id: novel.id, name: '沈嬷嬷', gender: 'female' });
  const unique = await api('/characters', { novel_id: novel.id, name: '花酒行者', gender: 'male' });
  check(!named.is_npc && !title.is_npc && !unique.is_npc, '实名和唯一专称继续独立配音，不误判姓氏加称谓');
  check(male.is_npc && male.npc_gender === 'male' && female.is_npc && female.npc_gender === 'female', '无名男女分类，未知默认男且不被描述中的少女误导');
  const chars = () => api('/characters?novel_id=' + novel.id);
  let list = await chars();
  const initial = list.find(c => c.id === male.id).npc_voice;
  check(pool.voices.some(v => v.id === initial.id && v.gender === 'male') && pool.voices.some(v => v.id === list.find(c => c.id === female.id).npc_voice.id && v.gender === 'female'), '随机音色仅来自对应性别的选定合集');
  await api('/novels/' + novel.id + '/npc-assign', {});
  check((await chars()).find(c => c.id === male.id).npc_voice.id === initial.id, '重复批量整理和浏览不会重抽声音');
  const chapter = (await api('/novels/' + novel.id)).chapters[0];
  const seg = await api('/chapters/' + chapter.id + '/segments', { type: 'dialogue', character_id: male.id, text: '站住。' });
  db.prepare("UPDATE segments SET status='done',audio_file='keep.mp3',gen_key='old' WHERE id=?").run(seg.id);
  db.prepare("UPDATE chapters SET merged_audio='old.mp3' WHERE id=?").run(chapter.id);
  const custom = await api('/voices', { voice_id: 'npc-test-voice', name: '自定义测试男声', gender: 'male' });
  await api('/npc-pools/' + pool.id + '/voices', { voice_db_id: custom.id, gender: 'male' });
  check((await chars()).find(c => c.id === male.id).npc_voice.id === initial.id && db.prepare('SELECT status FROM segments WHERE id=?').get(seg.id).status === 'done', '新增合集成员保留原分配和已生成缓存');
  await api('/npc-pools/' + pool.id + '/voices/' + initial.id, {}, 'DELETE');
  const replacement = (await chars()).find(c => c.id === male.id).npc_voice;
  const changedSeg = db.prepare('SELECT * FROM segments WHERE id=?').get(seg.id);
  check(replacement.id !== initial.id && changedSeg.status === 'pending' && changedSeg.audio_file === 'keep.mp3' && db.prepare('SELECT merged_audio FROM chapters WHERE id=?').get(chapter.id).merged_audio === null, '移除所用成员自动补位，只失效受影响缓存并保留旧音频文件引用');
  await api('/novels/' + novel.id + '/npc-assign', { reroll: true });
  check((await chars()).find(c => c.id === male.id).npc_voice.id !== replacement.id, '显式重抽在多个可用声音时换声');
  await api('/characters/' + male.id, { role_type: 'named' }, 'PUT');
  check(!(await chars()).find(c => c.id === male.id).is_npc, '支持把重要配角手动提升为独立角色');
  await api('/characters/' + male.id, { role_type: 'npc', gender: 'female' }, 'PUT');
  check(pool.voices.some(v => v.id === (db.prepare('SELECT voice_id FROM npc_assignments WHERE character_id=?').get(male.id).voice_id) && v.gender === 'female'), '手动纠正性别后从女声池重新分配');
  const empty = await api('/npc-pools', { name: '可编辑测试合集' });
  await api('/novels/' + novel.id, { npc_pool_id: empty.id }, 'PUT');
  check((await chars()).filter(c => c.is_npc).every(c => c.npc_voice === null), '空合集不偷偷使用库外音色');
  const failure = await api('/novels/' + novel.id + '/npc-assign', {}, 'POST', 500);
  check(failure.error.includes('没有女 NPC 音色'), '空性别池给出明确补充音色提示');
  await api('/npc-pools/' + empty.id + '/voices', { voice_db_id: custom.id, gender: 'female' });
  check((await chars()).filter(c => c.is_npc).every(c => c.npc_voice.id === custom.id), '可显式为合集设置成员性别并自动补齐');
  await api('/npc-pools/' + empty.id, { name: '已重命名' }, 'PUT');
  check((await api('/npc-pools')).find(p => p.id === empty.id).name === '已重命名', '合集可重命名');
  const job = db.prepare("INSERT INTO jobs(type,novel_id,status) VALUES ('generate',?,'running')").run(novel.id).lastInsertRowid;
  await api('/novels/' + novel.id + '/npc-assign', {}, 'POST', 409);
  await api('/npc-pools/' + empty.id + '/voices/' + custom.id, {}, 'DELETE', 409);
  check(true, '生成任务执行时禁止改动配音和合集，防止声音竞态');
  db.prepare("UPDATE jobs SET status='done' WHERE id=?").run(job);
  await api('/npc-pools/' + empty.id, {}, 'DELETE');
  check((await api('/novels/' + novel.id)).npc_pool_id === null && (await chars()).filter(c => c.is_npc).every(c => c.npc_voice), '删除选中的合集会回退默认合集并补齐配音');
  await api('/npc-pools/' + pool.id, {}, 'DELETE', 400);
  check(true, '保留至少一个合集');
  const stable = (await chars()).find(c => c.id === female.id).npc_voice.id;
  await stop();
  await start();
  check((await chars()).find(c => c.id === female.id).npc_voice.id === stable, '重启后 NPC 随机分配保持稳定');
  check(!(await api('/npc-pools'))[0].voices.some(v => v.id === initial.id), '用户移除的默认成员重启后不会重新添加');
  // 模型提供未命名标记时，支持规则未覆盖的复杂外貌称呼。
  const hinted = await api('/characters', { novel_id: novel.id, name: '披着破斗篷的陌生壮汉' });
  db.prepare("UPDATE characters SET role_hint='npc' WHERE id=?").run(hinted.id);
  await api('/novels/' + novel.id + '/npc-assign', {});
  check((await chars()).find(c => c.id === hinted.id).is_npc, '复杂无名描述支持模型的姓名判定标记');
  check(db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok', '数据库完整性正常');
  console.log(`全部通过（${checks} 项），临时目录：${data}`);
} finally {
  db?.close();
  await stop();
}
