// 端到端测试：启动 mock LLM（OpenAI 格式）+ mock MiniMax WebSocket，跑通 导入→拆分→绑定→生成→下载
// 用法：npm run test:e2e
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LLM_PORT = 18101, WS_PORT = 18102, APP_PORT = 18103;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'nvs-e2e-'));
let ok = 0;
const assert = (cond, msg) => { if (!cond) { console.error('✕ ' + msg); process.exit(1); } ok++; console.log('✓ ' + msg); };

// ---------- mock LLM ----------
const NAMES = ['林默', '苏晴', '老板'];
const llm = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
  const j = JSON.parse(body);
  if (req.headers.authorization !== 'Bearer llm-key') { res.writeHead(401); return res.end('{"error":"bad key"}'); }
  const user = j.messages.at(-1).content;
  let out = { ok: true };
  if (user.includes('待标注文本')) {
    const lines = user.split('\n').filter((l) => /^\[\d+\|/.test(l));
    const dialogues = [];
    let lastNarr = '';
    for (const l of lines) {
      const m = l.match(/^\[(\d+)\|(对话|旁白)\] (.*)$/);
      if (m[2] === '旁白') { lastNarr = m[3]; continue; }
      const sp = NAMES.find((n) => lastNarr.includes(n)) || '路人';
      dialogues.push({ id: Number(m[1]), speaker: sp, emotion: m[3].includes('！') ? 'angry' : '', is_speech: true });
    }
    out = {
      characters: [
        { name: '林默', gender: 'male', age: 'young', aliases: ['小林'], description: '男主' },
        { name: '苏晴', gender: 'female', age: 'young', aliases: [], description: '女主' },
        { name: '老板', is_named: false, gender: 'male', age: 'middle', aliases: [], description: '' },
      ],
      dialogues,
    };
  }
  if (user.startsWith('{')) {
    const input=JSON.parse(user);
    if (input.editable_narration) out={narration:input.editable_narration.map(s=>({id:s.id,text:s.text.slice(0,Math.max(1,Math.floor(s.text.length/2)))}))};
  }
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '```json\n' + JSON.stringify(out) + '\n```' } }] }));
});

// ---------- mock MiniMax WS ----------
function fakeMp3(ms) {
  // MPEG1 Layer3 128kbps 32kHz：每帧 576 字节、36ms
  const frames = Math.max(1, Math.round(ms / 36));
  const f = Buffer.alloc(576);
  f[0] = 0xff; f[1] = 0xfb; f[2] = 0x98; f[3] = 0x64;
  return Buffer.concat(Array(frames).fill(f));
}
function wsFrame(str) {
  const p = Buffer.from(str);
  let h;
  if (p.length < 126) h = Buffer.from([0x81, p.length]);
  else if (p.length < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(p.length, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(p.length), 2); }
  return Buffer.concat([h, p]);
}
let wsCalls = 0;
const wsSrv = http.createServer();
wsSrv.on('upgrade', (req, sock) => {
  if (req.headers.authorization !== 'Bearer mm-key') { sock.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const send = (o) => sock.write(wsFrame(JSON.stringify(o)));
  send({ event: 'connected_success', base_resp: { status_code: 0 } });
  let buf = Buffer.alloc(0);
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      const op = buf[0] & 0x0f;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len)).map((b, i) => b ^ mask[i % 4]);
      buf = buf.subarray(off + 4 + len);
      if (op === 8) { sock.end(); return; }
      if (op !== 1) continue;
      const msg = JSON.parse(Buffer.from(payload).toString());
      if (msg.event === 'task_start') {
        if (!msg.voice_setting?.voice_id) return send({ event: 'task_failed', base_resp: { status_code: 2013, status_msg: 'no voice' } });
        send({ event: 'task_started', base_resp: { status_code: 0 } });
      } else if (msg.event === 'task_continue') {
        wsCalls++;
        const mp3 = fakeMp3(msg.text.length * 220);
        const half = Math.floor(mp3.length / 2 / 576) * 576;
        send({ event: 'task_continued', data: { audio: mp3.subarray(0, half).toString('hex') }, is_final: false, base_resp: { status_code: 0 } });
        send({ event: 'task_continued', data: { audio: mp3.subarray(half).toString('hex') }, is_final: false, base_resp: { status_code: 0 } });
        send({ event: 'task_continued', data: { audio: '' }, is_final: true, extra_info: { audio_length: 0, usage_characters: msg.text.length }, base_resp: { status_code: 0 } });
      } else if (msg.event === 'task_finish') {
        send({ event: 'task_finished', base_resp: { status_code: 0 } });
      }
    }
  });
  sock.on('error', () => {});
});

// ---------- 测试流程 ----------
const NOVEL = `第一章 雨夜
雨下得很大。林默推开咖啡馆的门，风铃叮当作响。
老板抬起头，笑着说：“今天这么晚还来？”
林默点点头：“老样子，一杯美式。”
角落里，苏晴放下书，轻声道：“你也喜欢下雨天吗？”
林默愣了一下。他想起了所谓“命运”这种东西。
苏晴又说：“我叫苏晴，你呢？”
林默说：“林默！”

第二章 重逢
三天后，林默又见到了苏晴。
苏晴说：“真巧啊。”`;

const base = `http://127.0.0.1:${APP_PORT}/api`;
async function call(p, body, method) {
  const r = await fetch(base + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${p} → ${r.status} ${t}`);
  return t ? JSON.parse(t) : null;
}
async function waitJob(id) {
  for (let i = 0; i < 200; i++) {
    const j = await call('/jobs/' + id);
    if (!['queued', 'running'].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('job timeout');
}

await new Promise((r) => llm.listen(LLM_PORT, r));
await new Promise((r) => wsSrv.listen(WS_PORT, r));
const app = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: ROOT, env: { ...process.env, DATA_DIR: DATA, PORT: String(APP_PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
app.stdout.on('data', () => {});
for (let i = 0; i < 50; i++) { try { await fetch(base + '/auth'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

try {
  await call('/settings', {
    llm_base_url: `http://127.0.0.1:${LLM_PORT}/v1`, llm_api_key: 'llm-key', llm_model: 'mock-model',
    minimax_api_key: 'mm-key', minimax_ws_url: `ws://127.0.0.1:${WS_PORT}/ws/v1/t2a_v2`, tts_concurrency: '2', tts_rpm: '6000', ai_casting: '0', identity_prepass: '0',
  }, 'PUT');
  const s = await call('/settings');
  assert(s.llm_api_key.includes('****') && s.llm_api_key_set, '密钥保存并掩码返回');
  await call('/settings', { llm_api_key: s.llm_api_key }, 'PUT');
  assert((await call('/settings/test-llm', {})).ok, 'LLM 测试连接（掩码回传不覆盖密钥）');
  assert((await call('/settings/llm-models')).models[0] === 'mock-model', '获取模型列表');
  assert((await call('/settings/test-tts', {})).bytes > 0, 'MiniMax WS 测试合成');

  const novel = await call('/novels', { title: '雨夜咖啡馆', author: '测试', content: NOVEL });
  let n = await call('/novels/' + novel.id);
  assert(n.chapters.length === 2 && n.chapters[0].title === '第一章 雨夜', '自动识别 2 个章节');

  const job = await call(`/novels/${novel.id}/split`, { mode: 'hybrid' });
  const sj = await waitJob(job.jobId);
  assert(sj.status === 'done', '拆分任务完成：' + sj.message);
  const ch = await call('/chapters/' + n.chapters[0].id);
  const dl = ch.segments.filter((x) => x.type === 'dialogue');
  console.log(ch.segments.map((x) => `  [${x.type === 'dialogue' ? x.speaker : '旁白'}${x.emotion ? '/' + x.emotion : ''}] ${x.text}`).join('\n'));
  assert(dl.length === 5, '第一章识别出 5 句对话');
  assert(dl[0].speaker === '老板' && dl[2].speaker === '苏晴' && dl[4].speaker === '林默', '说话人归属正确');
  assert(ch.segments.some((x) => x.type === 'narration' && x.text.includes('“命运”')), '非对白引号保留在旁白中');
  assert(dl[4].emotion === 'angry', '情绪识别写入');
  const chars = await call('/characters?novel_id=' + novel.id);
  assert(chars.length === 4 && chars.every((c) => c.is_npc ? c.npc_voice : c.voices.length), '角色入库（含旁白）且实名与 NPC 均自动分配音色');
  assert(chars.find((c) => c.name === '林默').aliases.includes('小林'), '别名入库');

  // 多对多绑定：给林默再绑一个音色并设为默认；同一音色绑给苏晴
  const voices = await call('/voices');
  const v = voices.find((x) => x.voice_id === 'male-qn-jingying');
  const lin = chars.find((c) => c.name === '林默'), su = chars.find((c) => c.name === '苏晴');
  await call(`/characters/${lin.id}/voices`, { voice_db_id: v.id, is_default: true, speed: 1.1 });
  await call(`/characters/${su.id}/voices`, { voice_db_id: v.id, is_default: false });
  const lin2 = (await call('/characters?novel_id=' + novel.id)).find((c) => c.id === lin.id);
  assert(lin2.voices.length === 2 && lin2.voices[0].voice_id === 'male-qn-jingying' && lin2.voices[0].is_default, '角色多音色绑定 + 默认切换');
  assert((await call('/voices')).find((x) => x.id === v.id).bind_count === 2, '一个音色被多个角色绑定');

  // 生成整本
  const gj = await waitJob((await call(`/novels/${novel.id}/generate`, {})).jobId);
  assert(gj.status === 'done' && gj.failed === 0, '生成任务完成：' + gj.message);
  const ch2 = await call('/chapters/' + n.chapters[0].id);
  assert(ch2.segments.every((x) => x.status === 'done' && x.duration_ms > 0), '所有片段生成成功且解析出时长');
  assert(ch2.segments.find((x) => x.speaker === '林默').voice.voice_id === 'male-qn-jingying', '使用角色默认音色');
  const lrc = fs.readFileSync(path.join(DATA, 'audio', ch2.segments[0].lrc_file), 'utf8');
  console.log(lrc.split('\n').map((l) => '  ' + l).join('\n'));
  assert(/\[00:00\.\d\d\]/.test(lrc) && lrc.includes('[ti:'), '每段 LRC 正确生成');
  assert(ch2.merged_audio && fs.existsSync(path.join(DATA, 'audio', ch2.merged_audio)), '整章 MP3 合并');
  const cz = await fetch(`${base}/chapters/${ch2.id}/download-merged`);
  const chapterZip = Buffer.from(await cz.arrayBuffer());
  const entryNames = [];
  for (let offset = 0; offset + 30 <= chapterZip.length && chapterZip.readUInt32LE(offset) === 0x04034b50;) {
    const nameLength = chapterZip.readUInt16LE(offset + 26), extraLength = chapterZip.readUInt16LE(offset + 28), size = chapterZip.readUInt32LE(offset + 18);
    entryNames.push(chapterZip.toString('utf8', offset + 30, offset + 30 + nameLength));
    offset += 30 + nameLength + extraLength + size;
  }
  assert(cz.ok && entryNames.length === 2 && entryNames.some((x) => x === path.basename(ch2.merged_audio)) && entryNames.some((x) => x === path.basename(ch2.merged_lrc)), '整章下载 ZIP 只包含所选章节拼接后的 MP3 与 LRC');
  const segmentZipResponse = await fetch(`${base}/chapters/${ch2.id}/download`);
  const segmentZip = Buffer.from(await segmentZipResponse.arrayBuffer());
  const segmentCount = [...segmentZip.toString('latin1').matchAll(/PK\x01\x02/g)].length;
  assert(segmentZipResponse.ok && segmentCount > 2, '章节详情原下载仍保留全部分段文件');
  const emptyNovel = await call('/novels', { title: '未生成下载测试', content: '尚未生成音频。', autoDetect: false });
  const emptyChapter = (await call('/novels/' + emptyNovel.id)).chapters[0];
  const chapterEmpty = await fetch(`${base}/chapters/${emptyChapter.id}/download-merged`);
  assert(chapterEmpty.status === 400, '尚未生成整章拼接文件时下载按钮不可用并返回明确错误');
  const mlrc = fs.readFileSync(path.join(DATA, 'audio', ch2.merged_lrc), 'utf8');
  assert(mlrc.split('\n').filter((l) => /^\[\d\d:\d\d/.test(l)).length > ch2.segments.length, '整章 LRC 时间轴');

  // 增量：再次生成应全部跳过；修改一句再生成只生成 1 段
  const calls0 = wsCalls;
  await waitJob((await call(`/chapters/${ch2.id}/generate`, {})).jobId);
  assert(wsCalls === calls0, '未修改的片段不会重复生成');
  await call('/segments/' + ch2.segments[1].id, { text: '老板抬起头，笑着说道。' }, 'PUT');
  await waitJob((await call(`/chapters/${ch2.id}/generate`, {})).jobId);
  assert(wsCalls === calls0 + 1, '修改后只重新生成 1 个片段');
  // 改说话人 → 自动建角色
  const up = await call('/segments/' + ch2.segments[2].id, { speaker: '神秘人' }, 'PUT');
  assert(up.type === 'dialogue' && up.speaker === '神秘人' && up.voice, '改说话人为新角色并自动分配音色');

  // ZIP 下载
  const zr = await fetch(`${base}/novels/${novel.id}/download`);
  const zip = Buffer.from(await zr.arrayBuffer());
  fs.writeFileSync(path.join(DATA, 'out.zip'), zip);
  assert(zr.ok && zip.readUInt32LE(0) === 0x04034b50 && zip.readUInt32LE(zip.length - 22) === 0x06054b50, `ZIP 下载（${(zip.length / 1024).toFixed(0)}KB）`);
  const audio = await fetch(`http://127.0.0.1:${APP_PORT}/files/${ch2.segments[0].audio_file}`, { headers: { Range: 'bytes=0-99' } });
  assert(audio.status === 206 && (await audio.arrayBuffer()).byteLength === 100, '音频 Range 请求');
  const beforeCompression=await call('/chapters/'+ch2.id);
  const originalDialogue=JSON.stringify(beforeCompression.segments.filter(s=>s.type==='dialogue'));
  const originalNarration=beforeCompression.segments.filter(s=>s.type==='narration').map(s=>s.text);
  const compressionJob=await waitJob((await call(`/chapters/${ch2.id}/compress-narration`,{})).jobId);
  const afterCompression=await call('/chapters/'+ch2.id);
  assert(compressionJob.status==='done' && afterCompression.compression_status==='done' && afterCompression.narration_after_chars<afterCompression.narration_before_chars,'单章压缩 API 与任务进度和字数统计正常');
  assert(JSON.stringify(afterCompression.segments.filter(s=>s.type==='dialogue'))===originalDialogue,'HTTP 旁白压缩严格保留对白及其音频');
  const backupBefore=await call('/chapters/'+ch2.id);
  const invalidMerge=await fetch(`${base}/segments/${backupBefore.segments.at(-1).id}/merge-next`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  const backupAfter=await call('/chapters/'+ch2.id);
  assert(invalidMerge.status===400 && backupAfter.has_narration_backup && backupAfter.compression_status==='done','失败的片段合并不删除旁白备份或压缩状态');
  await call('/segments/'+backupAfter.segments[0].id,{text:backupAfter.segments[0].text},'PUT');
  assert((await call('/chapters/'+ch2.id)).has_narration_backup,'保存未变文本不会清空原旁白备份');
  const batchCompression=await waitJob((await call(`/novels/${novel.id}/compress-narration`,{onlyNew:true})).jobId);
  assert(batchCompression.status==='done' && batchCompression.total===1,'全书批量压缩只选择未压缩的已拆分章节');
  await call(`/chapters/${ch2.id}/restore-narration`,{});
  const restored=await call('/chapters/'+ch2.id);
  assert(JSON.stringify(restored.segments.filter(s=>s.type==='narration').map(s=>s.text))===JSON.stringify(originalNarration) && restored.compression_status==='none','恢复原旁白 API 精确恢复并重置状态');
  console.log(`\n全部通过（${ok} 项）。数据目录：${DATA}`);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  app.kill();
  llm.close();
  wsSrv.close();
  setTimeout(() => process.exit(), 200);
}
