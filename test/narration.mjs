import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'voxnovel-narration-'));
const {q,db}=await import('../server/db.js');
const {compressChapterNarration,restoreChapterNarration,resetCompression}=await import('../server/narration.js');
const {startCompressNarration,startGenerate,startSplit,startReconcile,cancelJob}=await import('../server/jobs.js');
let checks=0;const check=(ok,msg)=>{assert.ok(ok,msg);checks++;console.log('✓',msg);};
const novel=q.run("INSERT INTO novels(title) VALUES ('旁白测试')").id;
const chapter=q.run("INSERT INTO chapters(novel_id,idx,title,content,split_status) VALUES (?,0,'第一章','完整原著保留','done')",novel).id;
const narrator=q.run("INSERT INTO characters(novel_id,name,is_narrator) VALUES (?,'旁白',1)",novel).id;
const char=q.run("INSERT INTO characters(novel_id,name) VALUES (?,'林默')",novel).id;
const rows=[['narration','窗外的雨下个不停，林默站在窗前，抬起头看向苏晴，缓缓开口。'],['dialogue','你也喜欢下雨天吗？'],['narration','苏晴轻轻地笑了一下，她把手中的书放下，回应了林默的问题。'],['dialogue','喜欢。']];
const ids=rows.map(([type,text],idx)=>q.run("INSERT INTO segments(chapter_id,idx,type,character_id,speaker,text,status,audio_file,lrc_file,gen_key,duration_ms) VALUES (?,?,?,?,?,?,'done',?,?,?,1000)",chapter,idx,type,type==='narration'?narrator:char,type==='dialogue'?'林默':'',text,idx+'.mp3',idx+'.lrc','key'+idx).id);
q.run("UPDATE chapters SET merged_audio='merged.mp3',merged_lrc='merged.lrc',merged_duration_ms=4000 WHERE id=?",chapter);
const get=()=>q.all('SELECT * FROM segments WHERE chapter_id=? ORDER BY idx,id',chapter);
const dialogues=JSON.stringify(get().filter(s=>s.type==='dialogue'));
const originalTexts=get().filter(s=>s.type==='narration').map(s=>s.text);
let calls=0;const request=async(settings,messages)=>{
 calls++;const body=JSON.parse(messages[1].content);
 check(body.context.some(s=>s.type==='dialogue') && body.editable_narration.every(s=>!s.type),'请求将对白作为只读上下文，只编辑旁白编号');
 return {narration:body.editable_narration.map(s=>({id:s.id,text:s.id===ids[0]?'雨中，林默望向苏晴。':'苏晴放下书，轻笑。'}))};
};
const result=await compressChapterNarration(chapter,{request});
check(result.after<result.before && result.changed===2,'压缩旁白字数且保持片段编号与数量');
check(JSON.stringify(get().filter(s=>s.type==='dialogue'))===dialogues,'对白全文、说话人、顺序、音频与所有元数据逐字保持不变');
check(get().filter(s=>s.type==='narration').every(s=>s.status==='pending' && s.audio_file && s.gen_key),'仅旁白待重新生成，旧音频文件引用保留');
check(q.get('SELECT merged_audio FROM chapters WHERE id=?',chapter).merged_audio===null,'压缩后整章拼接缓存失效');
check(q.get('SELECT content FROM chapters WHERE id=?',chapter).content==='完整原著保留','章节原著全文不改写');
check(q.get('SELECT compression_status FROM chapters WHERE id=?',chapter).compression_status==='done','压缩完成状态和字数持久化');
await compressChapterNarration(chapter,{request:async(s,m)=>{const b=JSON.parse(m[1].content);check(JSON.stringify(b.editable_narration.map(x=>x.text))===JSON.stringify(originalTexts),'重新压缩从最初旁白而非上次压缩稿开始');return {narration:b.editable_narration.map(x=>({id:x.id,text:x.text.slice(0,12)}))};}});
restoreChapterNarration(chapter);
check(JSON.stringify(get().filter(s=>s.type==='narration').map(s=>s.text))===JSON.stringify(originalTexts),'恢复原旁白可精确还原初稿');
check(JSON.stringify(get().filter(s=>s.type==='dialogue'))===dialogues,'恢复操作也不影响对白');
await compressChapterNarration(chapter,{request:async(s,m)=>{
 const b=JSON.parse(m[1].content);
 check(b.chapter_context.filter(x=>x.type==='dialogue').length===2,'整章对白作为视频叙事骨架传给模型');
 return {narration:[{id:ids[0],text:'雨中，林默问苏晴是否喜欢雨天，苏晴放下书。'}],omitted_ids:[ids[2]]};
}});
check(get().find(s=>s.id===ids[2]).narration_omitted===1 && get().find(s=>s.id===ids[2]).text==='','环境与动作可整合一句，冗余段落明确省略而非逐段缩句');
check(JSON.stringify(get().filter(s=>s.type==='dialogue'))===dialogues,'整合并省略旁白时所有对白记录完全不变');
assert.throws(()=>resetCompression(chapter),/先恢复原旁白/);
check(!!q.get('SELECT 1 FROM narration_backups WHERE chapter_id=?',chapter),'省略后的原稿备份不会因文本编辑重置而丢失');
restoreChapterNarration(chapter);
check(get().filter(s=>s.type==='narration').every(s=>s.narration_omitted===0),'恢复后省略段落重新出现且原顺序不变');
const signature=JSON.stringify(get());
for(const [label,make] of [
 ['拒绝缺少旁白编号',b=>({narration:[{id:ids[0],text:'短文'}]})],
 ['拒绝试图改对白',b=>({narration:[{id:ids[1],text:'改对白'},{id:ids[2],text:'短文'}]})],
 ['拒绝空文本',b=>({narration:b.editable_narration.map(x=>({id:x.id,text:''}))})],
 ['拒绝重复编号',b=>({narration:b.editable_narration.map(x=>({id:ids[0],text:'短文'}))})],
 ['拒绝把多段堆成长篇旁白',b=>({narration:b.editable_narration.map(x=>({id:x.id,text:'长'.repeat(101)}))})],
 ['拒绝扩写',b=>({narration:b.editable_narration.map(x=>({id:x.id,text:x.text.repeat(2)}))})]
]){
 await assert.rejects(compressChapterNarration(chapter,{request:async(s,m)=>make(JSON.parse(m[1].content))}));
 check(JSON.stringify(get())===signature,label+'且整章原子回滚');
}
const signal={cancelled:false};
await assert.rejects(compressChapterNarration(chapter,{signal,request:async(s,m)=>{signal.cancelled=true;return {narration:JSON.parse(m[1].content).editable_narration.map(x=>({id:x.id,text:'短文'}))};}}),/已取消/);
check(JSON.stringify(get())===signature,'模型返回后取消任务也不写入');
await assert.rejects(compressChapterNarration(chapter,{request:async(s,m)=>{q.run("UPDATE segments SET emotion='happy' WHERE id=?",ids[1]);return {narration:JSON.parse(m[1].content).editable_narration.map(x=>({id:x.id,text:'短文'}))};}}),/发生变化/);
check(get()[0].text===originalTexts[0],'请求期间片段被修改时拒绝过时结果');
q.run("INSERT OR REPLACE INTO settings(key,value) VALUES ('llm_api_key','mock-key')");
const generating=q.run("INSERT INTO jobs(type,novel_id,status) VALUES ('generate',?,'running')",novel).id;
assert.throws(()=>startCompressNarration([chapter]),/正在执行/);check(true,'生成中禁止启动旁白压缩');
q.run("UPDATE jobs SET status='done' WHERE id=?",generating);
const compressing=q.run("INSERT INTO jobs(type,novel_id,status) VALUES ('compress',?,'queued')",novel).id;
assert.throws(()=>startGenerate([chapter]),/压缩旁白/);assert.throws(()=>startSplit([chapter],{mode:'rule'}),/压缩旁白/);assert.throws(()=>startReconcile(novel),/压缩旁白/);
check(true,'压缩中禁止拆分、身份分析和音频生成');
q.run("UPDATE jobs SET status='done' WHERE id=?",compressing);
const unsplit=q.run("INSERT INTO chapters(novel_id,idx,title) VALUES (?,1,'未拆分')",novel).id;
assert.throws(()=>startCompressNarration([unsplit]),/先完成章节拆分/);check(true,'未拆分章节不可压缩');
const oldFetch=globalThis.fetch;
try{
 globalThis.fetch=async(url,opts)=>{const b=JSON.parse(JSON.parse(opts.body).messages[1].content);return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({narration:b.editable_narration.map(x=>({id:x.id,text:'简洁旁白。'}))})}}]}));};
 const job=startCompressNarration([chapter]);
 for(let i=0;i<100;i++){if(['done','error','cancelled'].includes(q.get('SELECT status FROM jobs WHERE id=?',job).status))break;await new Promise(r=>setTimeout(r,10));}
 check(q.get('SELECT status FROM jobs WHERE id=?',job).status==='done','后台压缩任务完成并更新章节状态');
 const legacy=q.run("INSERT INTO chapters(novel_id,idx,title,split_status,compression_status) VALUES (?,4,'旧版已压缩','done','done')",novel).id;
 q.run("INSERT INTO segments(chapter_id,idx,type,text) VALUES (?,0,'narration','旧旁白正文')",legacy);
 const legacyJob=startCompressNarration([legacy]);
 for(let i=0;i<100;i++){if(q.get('SELECT status FROM jobs WHERE id=?',legacyJob).status==='done')break;await new Promise(r=>setTimeout(r,10));}
 check(q.get('SELECT compression_version FROM chapters WHERE id=?',legacy).compression_version==='video-v2','旧版已缩句章节可直接进入新版视频整合');
 assert.throws(()=>startCompressNarration([chapter]),/均已压缩/);check(true,'重复批量压缩自动跳过已完成章');
 globalThis.fetch=async()=>new Response('{"error":"unavailable"}',{status:503});
 const retryJob=startCompressNarration([chapter],{force:true});
 for(let i=0;i<100;i++){if(q.get('SELECT status FROM jobs WHERE id=?',retryJob).status==='error')break;await new Promise(r=>setTimeout(r,10));}
 check(q.get('SELECT compression_status FROM chapters WHERE id=?',chapter).compression_status==='done' && q.get('SELECT 1 FROM narration_backups WHERE chapter_id=?',chapter),'重新压缩失败保留前次完成状态和可恢复备份');
 resetCompression(chapter);check(!q.get('SELECT 1 FROM narration_backups WHERE chapter_id=?',chapter),'手动编辑或重新拆分可以重置压缩基线');
 const cancelledJob=startCompressNarration([chapter]);cancelJob(cancelledJob);
 for(let i=0;i<100;i++){if(q.get('SELECT status FROM jobs WHERE id=?',cancelledJob).status==='cancelled')break;await new Promise(r=>setTimeout(r,10));}
 check(q.get('SELECT compression_status FROM chapters WHERE id=?',chapter).compression_status==='none','排队时取消恢复章节压缩状态');
}finally{globalThis.fetch=oldFetch;}
 const one=q.run("INSERT INTO chapters(novel_id,idx,title,split_status) VALUES (?,2,'整合跨段','done')",novel).id;
 const short=q.run("INSERT INTO segments(chapter_id,idx,type,text) VALUES (?,0,'narration','雨夜。')",one).id;
 const long=q.run("INSERT INTO segments(chapter_id,idx,type,text) VALUES (?,1,'narration','林默经过漫长等待，终于等到苏晴推门进来。')",one).id;
 const combined='雨夜，林默终于等到苏晴到来。';
 await compressChapterNarration(one,{request:async()=>({narration:[{id:short,text:combined}],omitted_ids:[long]})});
 check(q.get('SELECT text FROM segments WHERE id=?',short).text===combined,'整合后的单条旁白可以长于原段，总量控制不限制跨段整合');
 await compressChapterNarration(one,{request:async()=>({narration:[],omitted_ids:[short,long]})});
 check(q.get('SELECT count(*) n FROM segments WHERE chapter_id=? AND narration_omitted=0',one).n===0,'可由画面完整表达的场景允许省略全部旁白');
 restoreChapterNarration(one);
 check(q.get('SELECT count(*) n FROM segments WHERE chapter_id=? AND narration_omitted=0',one).n===2,'全部省略的场景仍能完整恢复原旁白');
const large=q.run("INSERT INTO chapters(novel_id,idx,title,split_status) VALUES (?,5,'长集回归','done')",novel).id;
for(let i=0;i<210;i++) {
 q.run("INSERT INTO segments(chapter_id,idx,type,text) VALUES (?,?,?,?)",large,i*2,'narration','原始旁白描述场景变化，需要模型明确决定保留或省略。');
 q.run("INSERT INTO segments(chapter_id,idx,type,text) VALUES (?,?,?,?)",large,i*2+1,'dialogue','对白不可修改。');
}
const largeRows=()=>q.all('SELECT * FROM segments WHERE chapter_id=? ORDER BY idx',large);
const largeDialogue=JSON.stringify(largeRows().filter(s=>s.type==='dialogue'));
let retryFeedback=false,splitSeen=false,maxBatch=0;
await compressChapterNarration(large,{request:async(s,m)=>{
 const b=JSON.parse(m[1].content),batch=b.editable_narration;maxBatch=Math.max(maxBatch,batch.length);
 if(batch.length>48) {
  if(m.length>2) retryFeedback ||= m.at(-1).content.includes('缺少') && m.at(-1).content.includes(String(batch.at(-1).id));
  return {narration:[{id:batch[0].id,text:'场景变化。'}]};
 }
 splitSeen=true;
 return {narration:[{id:batch[0].id,text:'场景变化。'}],omitted_ids:batch.slice(1).map(x=>x.id)};
}});
check(maxBatch===96 && splitSeen && retryFeedback,'长集每批最多96段；遗漏编号反馈明确，连续失败后拆小批次重试');
check(JSON.stringify(largeRows().filter(s=>s.type==='dialogue'))===largeDialogue,'长集分批及拆小重试均完整保留对白');
restoreChapterNarration(large);
check(largeRows().filter(s=>s.type==='narration').every(s=>s.text.includes('原始旁白描述')),'长集整合结果可恢复全部原始旁白');
const beforeFailure=JSON.stringify(largeRows());let validBatches=0;
await assert.rejects(compressChapterNarration(large,{request:async(s,m)=>{
 const b=JSON.parse(m[1].content);
 if(b.editable_narration[0].id===largeRows()[0].id) {validBatches++;return {narration:[],omitted_ids:b.editable_narration.map(x=>x.id)};}
 return {narration:[],omitted_ids:[]};
}}),/缺少/);
check(validBatches===1 && JSON.stringify(largeRows())===beforeFailure,'长集后续批次最终失败时，前面成功批次也不写入原稿');
let parseSplit=false;
await compressChapterNarration(large,{request:async(s,m)=>{
 const b=JSON.parse(m[1].content);
 if(b.editable_narration.length>48) throw new Error('无法解析 LLM 输出的 JSON：截断');
 parseSplit=true;return {narration:[],omitted_ids:b.editable_narration.map(x=>x.id)};
}});
check(parseSplit,'模型返回不可解析 JSON 时也可自动缩小批次恢复');
restoreChapterNarration(large);
let authCalls=0;
await assert.rejects(compressChapterNarration(large,{request:async()=>{authCalls++;throw new Error('LLM 请求失败 HTTP 401');}}),/401/);
check(authCalls===1,'鉴权失败直接停止，不触发拆批放大请求');
check(q.get('PRAGMA integrity_check').integrity_check==='ok','数据库完整性正常');
db.close();console.log(`全部通过（${checks} 项），${process.env.DATA_DIR}`);
