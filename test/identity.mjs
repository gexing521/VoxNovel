import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nvs-identity-'));
const { q, db } = await import('../server/db.js');
const { validateIdentities, analyzeIdentities, identityFingerprint } = await import('../server/identity-analysis.js');
const { applyIdentityReport, scopedCharacterByName, scopedCharacters, getIdentityReport } = await import('../server/identity.js');
const { fetchChapter, extractChapter } = await import('../server/fetcher.js');
const { ruleSplit } = await import('../server/splitter.js');
let checks = 0;
function check(condition, message) { assert.ok(condition, message); checks++; console.log('✓ ' + message); }
const novel = q.run('INSERT INTO novels(title) VALUES (?)', '跨章身份测试').id;
const other = q.run('INSERT INTO novels(title) VALUES (?)', '其他小说').id;
const data = [
  ['第1章 初遇', '清冷女人抬起头：“你触犯了法律。”主持人甲摘下面具，众人称他为面具人。'],
  ['第2章 真名', '清冷女人说：“我叫章晨泽，是一名律师。”主持人乙戴着面具出现，这个面具人与前者并非一人。'],
];
const chapters = data.map(([title,content],idx) => ({ id:q.run('INSERT INTO chapters(novel_id,idx,title,content) VALUES (?,?,?,?)',novel,idx,title,content).id, idx,title,content }));
const [first, second] = chapters;
const src = q.run('INSERT INTO characters(novel_id,name,aliases) VALUES (?,?,?)',novel,'清冷女律师','清冷女人,清冷的女人').id;
const dst = q.run('INSERT INTO characters(novel_id,name) VALUES (?,?)',novel,'章晨泽').id;
const outsider = q.run('INSERT INTO characters(novel_id,name) VALUES (?,?)',other,'清冷女人').id;
const voices = q.all('SELECT id FROM voices LIMIT 2');
q.run('INSERT INTO character_voices(character_id,voice_id,is_default,speed) VALUES (?,?,1,1.2)',src,voices[0].id);
q.run('INSERT INTO character_voices(character_id,voice_id,is_default) VALUES (?,?,1)',dst,voices[1].id);
q.run("INSERT INTO segments(chapter_id,idx,type,character_id,speaker,text,status,audio_file,gen_key) VALUES (?,0,'dialogue',?,'清冷女律师','你触犯了法律。','done','existing.mp3','old-key')",first.id,src);
q.run("UPDATE chapters SET merged_audio='old-merged.mp3' WHERE id=?",first.id);
const raw = { characters: [
  {name:'章晨泽',gender:'female',age:'young',description:'冷静的女律师',confidence:0.99,aliases:[{name:'清冷女人',chapter_ids:[first.id,second.id]}],evidence:[{chapter_id:second.id,quote:second.content.slice(0,25)}]},
  {name:'主持人甲',gender:'male',age:'middle',confidence:0.98,aliases:[{name:'面具人',chapter_ids:[first.id]}],evidence:[{chapter_id:first.id,quote:'主持人甲摘下面具，众人称他为面具人。'}]},
  {name:'主持人乙',gender:'male',age:'middle',confidence:0.98,aliases:[{name:'面具人',chapter_ids:[second.id]}],evidence:[{chapter_id:second.id,quote:'主持人乙戴着面具出现，这个面具人与前者并非一人。'}]},
],unresolved:[]};
const settings = {llm_model:'mock-deepseek'};
let requests = 0;
const report = await analyzeIdentities(chapters,settings,{ request:async()=>{ requests++; return raw; } });
check(requests===2,'身份通读后独立回溯核对早期称呼');
let partialRequests = 0;
const partial = await analyzeIdentities(chapters,settings,{ request:async()=> ++partialRequests===1 ? raw : {characters:[raw.characters[0]],unresolved:[]} });
check(partial.characters.length===3,'汇总只返回重点人物时保留其他已获证实的身份');
const applied = applyIdentityReport(novel,report,chapters);
check(applied.applied.merged===1,'同一人的早期称呼与后期真名去重');
const segment = q.get('SELECT * FROM segments WHERE chapter_id=?',first.id);
check(segment.character_id===dst && segment.speaker==='章晨泽','已存在的第一章台词回溯到后文姓名');
check(segment.status==='pending' && segment.audio_file==='existing.mp3','音色变化后标记待生成，保留已有音频文件引用');
check(q.get('SELECT merged_audio FROM chapters WHERE id=?',first.id).merged_audio===null,'角色发生变化时失效整章合并缓存');
check(q.all('SELECT * FROM character_voices WHERE character_id=?',dst).length===2,'合并承接音色绑定并保留默认音色');
check(q.get('SELECT * FROM character_voices WHERE character_id=? AND is_default=1',dst).voice_id===voices[1].id,'保留规范角色原有的默认音色');
check(q.get('SELECT id FROM characters WHERE id=?',outsider).id===outsider,'不会合并其他小说的同名角色');
check(scopedCharacterByName(novel,'面具人',first.id).name==='主持人甲' && scopedCharacterByName(novel,'面具人',second.id).name==='主持人乙','同一称呼在不同章节可指不同人物');
check(scopedCharacterByName(novel,'章晨泽',first.id).id===dst,'后文揭示的规范实名在尚未出现姓名的早期章节同样有效');
check(scopedCharacterByName(novel,'面具人')===null,'歧义别名不会被当作全书唯一身份');
check(scopedCharacters(novel,first.id).find(c=>c.name==='主持人乙').aliases==='','拆分提示词只接收本章有效别名');
check(getIdentityReport(novel).fingerprint===identityFingerprint(chapters,settings),'持久化身份认定报告与正文指纹');
check(identityFingerprint(chapters,settings)!==identityFingerprint([{...first,content:first.content+'修改'},second],settings),'追加或修改正文会使旧认定缓存失效');
assert.throws(()=>validateIdentities({characters:[{...raw.characters[0],evidence:[{chapter_id:second.id,quote:'编造的姓名揭示证据不存在。'}]}]},chapters));checks++; console.log('✓ 拒绝不存在的原文证据');
const conflict = validateIdentities({characters:raw.characters.map(c=>({...c,aliases:[{name:'面具人',chapter_ids:[first.id]}]}))},chapters);
check(conflict.characters.every(c=>!c.aliases.some(a=>a.name==='面具人')),'同章相同别名的多身份冲突保留待核对');
const signal={cancelled:false};
await assert.rejects(analyzeIdentities(chapters,settings,{signal,request:async()=>{signal.cancelled=true;return raw;}}),/已取消/);checks++;console.log('✓ 取消后不应用身份结果');
const html = '<h1>第一章</h1><div class="body-content"><div id="content"><header>首页 作者 加书签</header><div id="chaptercontent"><p>'+ '正文只有小说内容。'.repeat(30)+'</p></div><footer>推荐其他小说</footer></div></div>';
const extracted = extractChapter(html);
check(extracted.content.startsWith('正文只有小说内容。') && !/首页|作者|加书签|推荐/.test(extracted.content),'正文容器优先，排除网页导航污染');
check(ruleSplit('她沉默了：“……”然后转过头。').some(s=>s.text==='……'),'保留只有省略号的对白，避免20章原文校验丢字');
check(ruleSplit('山羊头说“讲故事嘚人中，有且只有一个说谎者”。').map(s=>s.text).join('').endsWith('。'),'保留引号外单独的句号与省略号');
const { startReconcile, startGenerate, startSplit, splitChapter } = await import('../server/jobs.js');
const generating = q.run("INSERT INTO jobs(type,novel_id,status) VALUES ('generate',?,'running')",novel).id;
assert.throws(()=>startReconcile(novel),/正在生成音频/);checks++;console.log('✓ 生成期间禁止修改整书身份，避免音色竞态');
assert.throws(()=>startSplit([first.id],{mode:'rule',reconcile:false}),/正在生成音频/);checks++;console.log('✓ 规则拆分与关闭身份预分析时同样禁止和音频生成并发');
q.run("UPDATE jobs SET status='done' WHERE id=?",generating);
q.run("INSERT INTO jobs(type,novel_id,status) VALUES ('identity',?,'running')",novel);
assert.throws(()=>startGenerate([first.id]),/正在拆分或统一角色身份/);checks++;console.log('✓ 身份统一期间禁止按旧角色生成音频');
const headingHtml = '<h1>第3章 有技术的人</h1><div id="chaptercontent">第3章 有技术嘚人<br>'+ '正文只有小说内容。'.repeat(30)+'</div>';
check(!extractChapter(headingHtml).content.startsWith('第3章'),'移除正文里异体字不同的重复章节标题，防止重复分章');
const third = { id:q.run('INSERT INTO chapters(novel_id,idx,title,content) VALUES (?,2,?,?)',novel,'第3章 另一个人','清冷女人走入另一个场景，身份尚未确定。').id,idx:2,title:'第3章 另一个人',content:'清冷女人走入另一个场景，身份尚未确定。' };
const reused = q.run('INSERT INTO characters(novel_id,name,aliases) VALUES (?,?,?)',novel,'无名女子','清冷女人').id;
const scopedSegment = q.run("INSERT INTO segments(chapter_id,idx,type,character_id,speaker,text) VALUES (?,1,'dialogue',?,'无名女子','第一章台词')",first.id,reused).id;
const unconfirmedSegment = q.run("INSERT INTO segments(chapter_id,idx,type,character_id,speaker,text) VALUES (?,0,'dialogue',?,'无名女子','第三章另一个人的台词')",third.id,reused).id;
applyIdentityReport(novel,{...report,fingerprint:identityFingerprint([...chapters,third],settings)},[...chapters,third]);
check(q.get('SELECT character_id FROM segments WHERE id=?',scopedSegment).character_id===dst,'通过旧角色别名迁移有原文证据的章节');
check(q.get('SELECT character_id FROM segments WHERE id=?',unconfirmedSegment).character_id===reused,'同称呼在未确认章节的台词不会被全书强制合并');
const { npcVoice } = await import('../server/npc.js');
const npcNovel = q.run('INSERT INTO novels(title) VALUES (?)', 'NPC 缓存回归').id;
const npcContent = '侍卫甲站在左边，人们也称他为左边侍卫，他说了一句话。';
const npcChapter = { id:q.run('INSERT INTO chapters(novel_id,idx,title,content) VALUES (?,0,?,?)',npcNovel,'NPC 章节',npcContent).id,idx:0,title:'NPC 章节',content:npcContent };
const npcA = q.run("INSERT INTO characters(novel_id,name,role_type) VALUES (?,'侍卫甲','npc')",npcNovel).id;
const npcB = q.run("INSERT INTO characters(novel_id,name,role_type) VALUES (?,'左边侍卫','npc')",npcNovel).id;
const pool = q.get('SELECT id FROM npc_pools ORDER BY id LIMIT 1');
const npcVoices = q.all("SELECT voice_id FROM npc_pool_voices WHERE pool_id=? AND gender='male' LIMIT 2",pool.id);
for (const [id, voice] of [[npcA,npcVoices[0]],[npcB,npcVoices[1]]]) q.run("INSERT INTO npc_assignments(character_id,pool_id,voice_id,gender) VALUES (?,?,?,'male')",id,pool.id,voice.voice_id);
const npcSegment = q.run("INSERT INTO segments(chapter_id,idx,type,character_id,speaker,text,status,audio_file) VALUES (?,0,'dialogue',?,'左边侍卫','一句话','done','npc-old.mp3')",npcChapter.id,npcB).id;
applyIdentityReport(npcNovel,{characters:[{name:'侍卫甲',is_named:false,gender:'male',confidence:0.99,aliases:[{name:'左边侍卫',chapter_ids:[npcChapter.id]}],evidence:[{chapter_id:npcChapter.id,quote:npcContent}]}],unresolved:[],fingerprint:'npc-merge'},[npcChapter]);
const mergedNpc = q.get('SELECT * FROM segments WHERE id=?',npcSegment);
check(mergedNpc.character_id===npcA && mergedNpc.status==='pending' && mergedNpc.audio_file==='npc-old.mp3','NPC 身份合并比较实际合集声音，避免复用旧 NPC 的音频');
const autoId = q.run("INSERT INTO characters(novel_id,name,role_hint) VALUES (?,'少年','npc')",npcNovel).id;
npcVoice(q.get('SELECT * FROM characters WHERE id=?',autoId));
q.run('INSERT INTO character_voices(character_id,voice_id,is_default) VALUES (?,?,1)',autoId,voices[0].id);
const oldAuto = q.run("INSERT INTO segments(chapter_id,idx,type,character_id,speaker,text,status,audio_file) VALUES (?,1,'dialogue',?,'少年','旧台词','done','auto-old.mp3')",npcChapter.id,autoId).id;
q.run("UPDATE chapters SET merged_audio='npc-merged.mp3' WHERE id=?",npcChapter.id);
const newChapter = q.run("INSERT INTO chapters(novel_id,idx,title,content) VALUES (?,1,'身份变化','少年说：“来了。”')",npcNovel).id;
q.run("INSERT OR REPLACE INTO settings(key,value) VALUES ('llm_api_key','mock-key'),('auto_assign_voice','0')");
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({characters:[{name:'少年',is_named:true,gender:'male'}],dialogues:[{id:1,speaker:'少年',is_speech:true}]})}}]}));
  await splitChapter(newChapter,{mode:'hybrid'});
} finally { globalThis.fetch=originalFetch; }
check(q.get('SELECT status FROM segments WHERE id=?',oldAuto).status==='pending' && q.get('SELECT merged_audio FROM chapters WHERE id=?',npcChapter.id).merged_audio===null && !q.get('SELECT 1 FROM npc_assignments WHERE character_id=?',autoId),'新章节识别出实名后同步失效前章缓存并移除旧 NPC 分配');
db.close();console.log(`全部通过（${checks} 项），临时目录：${process.env.DATA_DIR}`);
