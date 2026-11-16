import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';

// Never open the development/production database or send a real model request.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voxnovel-narration-concurrency-'));
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Unexpected unmocked model request'); };
const { q, db } = await import('../server/db.js');
const { compressChapterNarration } = await import('../server/narration.js');
const { startCompressNarration, cancelJob } = await import('../server/jobs.js');
q.run("INSERT OR REPLACE INTO settings(key,value) VALUES ('llm_api_key','concurrency-mock-key')");
q.run("INSERT OR REPLACE INTO settings(key,value) VALUES ('llm_base_url','http://mock.invalid/v1')");

let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks++;
  console.log('✓', message);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
// Event-loop turns let all currently runnable promise chains settle. No model
// operation completes until the test explicitly opens its gate.
async function flush() { for (let i = 0; i < 4; i++) await immediate(); }
async function until(predicate, description) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Timed out: ' + description);
    await immediate();
  }
}
function observe(promise) {
  const state = { settled: false };
  state.promise = promise.then(
    value => { state.settled = true; state.value = value; },
    error => { state.settled = true; state.error = error; },
  );
  return state;
}
const newNovel = title => q.run('INSERT INTO novels(title) VALUES (?)', title).id;
function newChapter(novel, title, narrationCount = 288, status = 'none') {
  const id = q.run("INSERT INTO chapters(novel_id,idx,title,split_status,compression_status) VALUES (?,?,?,'done',?)", novel, nextIndex++, title, status).id;
  for (let i = 0; i < narrationCount; i++) {
    q.run("INSERT INTO segments(chapter_id,idx,type,text) VALUES (?,?,'narration',?)", id, i * 2, '原始旁白交代场景变化以及必要的事件因果，等待模型决定保留内容。');
    q.run("INSERT INTO segments(chapter_id,idx,type,speaker,text) VALUES (?,?,'dialogue','角色',?)", id, i * 2 + 1, '对白保持原文。' + i);
  }
  return id;
}
let nextIndex = 0;
const rows = id => q.all('SELECT * FROM segments WHERE chapter_id=? ORDER BY idx,id', id);
const snapshot = id => JSON.stringify(rows(id));
const dialogues = id => JSON.stringify(rows(id).filter(s => s.type === 'dialogue'));
const chapterState = id => q.get('SELECT compression_status FROM chapters WHERE id=?', id).compression_status;
const jobState = id => q.get('SELECT * FROM jobs WHERE id=?', id);
const terminal = id => ['done', 'error', 'cancelled'].includes(jobState(id).status);
function goodResult(body) {
  return { narration: body.editable_narration.map(s => ({ id: s.id, text: '整合旁白' + s.id })), omitted_ids: [] };
}
function completeOutput(id, originalDialogue) {
  assert.ok(rows(id).filter(s => s.type === 'narration').every(s => s.text === '整合旁白' + s.id && !s.narration_omitted));
  assert.equal(dialogues(id), originalDialogue);
  assert.equal(chapterState(id), 'done');
  assert.ok(q.get('SELECT 1 FROM narration_backups WHERE chapter_id=?', id));
}
function modelGates() {
  const calls = [], completed = [];
  let active = 0, peak = 0;
  const request = async (_settings, messages) => {
    const body = JSON.parse(messages[1].content), gate = deferred();
    const call = { index: calls.length, body, gate, released: false };
    calls.push(call); active++; peak = Math.max(peak, active);
    try { return await gate.promise; }
    finally { active--; completed.push(call.index); }
  };
  return {
    calls, completed, request,
    get active() { return active; }, get peak() { return peak; },
    release(index, error) {
      const call = calls[index];
      assert.ok(call && !call.released, 'Gate must exist and be unreleased: ' + index);
      call.released = true;
      if (error) call.gate.reject(error); else call.gate.resolve(goodResult(call.body));
    },
    installFetch() {
      globalThis.fetch = async (url, options) => {
        assert.equal(String(url), 'http://mock.invalid/v1/chat/completions');
        const body = JSON.parse(options.body);
        const result = await request(null, body.messages);
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }), { headers: { 'Content-Type': 'application/json' } });
      };
    },
    async drain(isDone) {
      const deadline = Date.now() + 5000;
      while (!isDone()) {
        for (const call of calls.filter(c => !c.released)) this.release(call.index);
        await immediate();
        assert.ok(Date.now() < deadline, 'Timed out draining model gates');
      }
      await flush();
      assert.equal(active, 0, 'All in-flight model requests drained');
    },
  };
}

try {
  // One chapter has four batches: opening batch 3 first must start batch 4
  // while batches 1 and 2 remain held, and must not affect output ordering.
  {
    const id = newChapter(newNovel('单集并发'), '四批单集', 384), before = dialogues(id);
    const model = modelGates(), work = observe(compressChapterNarration(id, { request: model.request }));
    await until(() => model.calls.length === 3, 'first three chapter batches');
    await flush();
    check(model.active === 3 && model.peak === 3 && model.calls.length === 3, '单集批次并发峰值为3，第四批等待空位');
    model.release(2);
    await until(() => model.calls.length === 4, 'fourth batch after third completes');
    model.release(3); await flush();
    model.release(1); await flush();
    check(!work.settled && chapterState(id) === 'none', '乱序完成的批次不会提前写入整集');
    model.release(0); await work.promise;
    assert.ifError(work.error); completeOutput(id, before);
    check(model.peak === 3 && JSON.stringify(model.completed) === '[2,3,1,0]', '批次以3、4、2、1顺序完成后，全部384段输出及对白完整');
  }
  // Four simultaneously requested chapters offer twelve runnable batches,
  // proving the shared cap rather than merely summing two per-chapter caps.
  {
    const novel = newNovel('全局并发'), ids = Array.from({ length: 4 }, (_, i) => newChapter(novel, '全局集' + i));
    const originals = ids.map(dialogues), model = modelGates();
    const work = ids.map(id => observe(compressChapterNarration(id, { request: model.request })));
    await until(() => model.calls.length === 6, 'six globally admitted requests');
    await flush();
    check(model.calls.length === 6 && model.active === 6, '四集同时请求时，共享global上限6，其余模型请求等待');
    await model.drain(() => work.every(w => w.settled));
    for (let i = 0; i < ids.length; i++) { assert.ifError(work[i].error); completeOutput(ids[i], originals[i]); }
    check(model.peak === 6 && model.calls.length === 12, '四集12批全部完成，全程模型请求峰值恰为6');
  }
  {
    const novel = newNovel('同书多个任务'), ids = [newChapter(novel, '任务甲'), newChapter(novel, '任务乙')];
    const original = ids.map(dialogues), model = modelGates(); model.installFetch();
    const a = startCompressNarration([ids[0]]), b = startCompressNarration([ids[1]]);
    assert.throws(() => startCompressNarration([ids[0]]), e => e.status === 409);
    await until(() => model.calls.length === 6, 'two same-book jobs running');
    check(a !== b && jobState(a).status === 'running' && jobState(b).status === 'running' && new Set(model.calls.map(c => c.body.chapter)).size === 2, '同书不同章可同时startCompressNarration，重复同章同步拒绝409');
    await model.drain(() => terminal(a) && terminal(b));
    assert.equal(jobState(a).status, 'done'); assert.equal(jobState(b).status, 'done');
    ids.forEach((id, i) => completeOutput(id, original[i]));
    check(model.peak === 6, '同书两任务通过真实chatJson/fetch mock并行完成，共享上限6');
  }
  {
    const novel = newNovel('单任务多集'), ids = Array.from({ length: 3 }, (_, i) => newChapter(novel, '并行集' + i));
    const original = ids.map(dialogues), model = modelGates(); model.installFetch();
    const job = startCompressNarration(ids);
    await until(() => model.calls.length === 6, 'two chapter workers within one job');
    check(ids.filter(id => chapterState(id) === 'running').length === 2 && chapterState(ids[2]) === 'queued' && new Set(model.calls.map(c => c.body.chapter)).size === 2, '同job两章并行处理，各3批；第三章排队');
    await model.drain(() => terminal(job));
    assert.equal(jobState(job).status, 'done'); assert.equal(jobState(job).done, 3);
    ids.forEach((id, i) => completeOutput(id, original[i]));
    check(model.peak === 6 && model.calls.length === 9, '同job三章9批完整完成，统计done=3');
  }
  {
    const novel = newNovel('取消等待'), prior = ['none', 'error', 'none', 'error'];
    const ids = prior.map((status, i) => newChapter(novel, '取消集' + i, 192, status));
    const originals = ids.map(snapshot), model = modelGates(); model.installFetch();
    const job = startCompressNarration(ids);
    await until(() => model.calls.length === 4, 'four in-flight cancellation requests');
    assert.deepEqual(ids.map(chapterState), ['running', 'running', 'queued', 'queued']);
    cancelJob(job); await flush();
    check(jobState(job).status === 'running' && model.active === 4, '取消不会立即标为结束，等待已发出的模型请求');
    model.release(0); await flush();
    check(jobState(job).status === 'running' && model.active === 3, '只完成部分在途请求时取消任务仍保持running');
    await model.drain(() => terminal(job));
    assert.equal(jobState(job).status, 'cancelled'); assert.equal(model.calls.length, 4);
    assert.deepEqual(ids.map(chapterState), prior);
    ids.forEach((id, i) => { assert.equal(snapshot(id), originals[i]); assert.ok(!q.get('SELECT 1 FROM narration_backups WHERE chapter_id=?', id)); });
    check(true, '取消后未完成章零写入，未启动排队章不发请求，所有章节还原原状态');
    const immediateJob = startCompressNarration(ids); cancelJob(immediateJob);
    await until(() => terminal(immediateJob), 'cancel before enqueue callback');
    assert.equal(jobState(immediateJob).status, 'cancelled'); assert.deepEqual(ids.map(chapterState), prior);
    check(model.calls.length === 4, '任务入队后立即取消也还原排队状态，未发出模型请求');
  }
  {
    const id = newChapter(newNovel('部分批失败'), '失败整集', 384), original = snapshot(id), model = modelGates();
    const work = observe(compressChapterNarration(id, { request: model.request }));
    await until(() => model.calls.length === 3, 'three in-flight failure requests');
    model.release(0, new Error('LLM 请求失败 HTTP 401：测试批次失败')); await flush();
    check(!work.settled && model.active === 2 && model.calls.length === 3, '部分批失败停止领取第四批，并等待另外两个在途批次');
    model.release(1); await flush();
    check(!work.settled && model.active === 1 && snapshot(id) === original, '失败后仅剩一个在途批次仍不结束，也不部分写入');
    model.release(2); await work.promise;
    assert.match(work.error?.message || '', /HTTP 401/);
    assert.equal(snapshot(id), original); assert.equal(chapterState(id), 'none');
    assert.ok(!q.get('SELECT 1 FROM narration_backups WHERE chapter_id=?', id));
    check(model.active === 0 && model.calls.length === 3, '所有在途批次结束后抛出原始错误，整章及原稿备份均未被写入');
  }
  check(q.get('PRAGMA integrity_check').integrity_check === 'ok', '独立临时数据库完整性正常');
  console.log(`全部通过（${checks} 项）；DATA_DIR=${process.env.DATA_DIR}`);
} finally {
  globalThis.fetch = realFetch;
  db.close();
}
