// 对运行中的应用做真实前20章回归：先拆第一章，再通读统一，再拆其余19章。不生成音频。
import fs from 'node:fs';
import assert from 'node:assert/strict';
const dir = new URL('../data/identity-test/', import.meta.url);
const corpus = JSON.parse(fs.readFileSync(new URL('chapters.json', dir), 'utf8'));
const base = process.env.APP_BASE || 'http://127.0.0.1:3000';
async function api(route,body) {
  const r = await fetch(base+'/api'+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
  const out = await r.json();if(!r.ok) throw new Error(`${route}: ${r.status} ${out.error}`);return out;
}
async function wait(id) {
  const end=Date.now()+40*60*1000;let last='';
  while(Date.now()<end) {
    const j=await api('/jobs/'+id);
    const message=`${j.status} ${j.done}/${j.total} ${j.message}`;
    if(message!==last){console.log(message);last=message;}
    if(!['queued','running'].includes(j.status)){assert.equal(j.status,'done',j.message);assert.equal(j.failed,0,j.message);return j;}
    await new Promise(r=>setTimeout(r,2000));
  }throw new Error('任务等待超时');
}
const title='十日终焉（前20章·角色统一测试）';
const novels=await api('/novels');
let novel=novels.find(n=>n.title===title);
if(!novel) {
  novel=await api('/novels',{title,author:'杀虫队队员'});
  for(const c of corpus.chapters) await api(`/novels/${novel.id}/chapters`,{title:c.title,content:c.content,autoDetect:false});
}
let detail=await api('/novels/'+novel.id);assert.equal(detail.chapters.length,20);
fs.writeFileSync(new URL('app-state.json',dir),JSON.stringify({novel_id:novel.id,url:`${base}/#/novel/${novel.id}`},null,2));
let baseline;
const beforeFile=new URL('before.json',dir);
if(fs.existsSync(beforeFile)) baseline=JSON.parse(fs.readFileSync(beforeFile,'utf8'));
else {
  console.log('基线：不预读后文，只拆第一章');
  await wait((await api(`/chapters/${detail.chapters[0].id}/split`,{mode:'hybrid',reconcile:false})).jobId);
  baseline={novel_id:novel.id,characters:await api('/characters?novel_id='+novel.id),chapter:await api('/chapters/'+detail.chapters[0].id)};
  fs.writeFileSync(beforeFile,JSON.stringify(baseline,null,2));
}
assert.equal(baseline.novel_id,novel.id,'基线必须属于同一测试书');
console.log('全书角色认定：通读20章并回溯第一章');
let report=(await api(`/novels/${novel.id}/identities`)).report;
if(!report || process.env.FORCE_IDENTITIES==='1') {
  await wait((await api(`/novels/${novel.id}/reconcile`,{})).jobId);
  report=(await api(`/novels/${novel.id}/identities`)).report;
}
assert.equal(report.chapter_ids.length,20);
const chapter1=await api('/chapters/'+detail.chapters[0].id);
fs.writeFileSync(new URL('after-first-chapter.json',dir),JSON.stringify({characters:await api('/characters?novel_id='+novel.id),chapter:chapter1,report},null,2));
const expected=[['清冷女人','章晨泽','不必跟喔们介绍了'],['花臂男人','乔家劲','你……是谁'],['白大褂','赵海博','喔们都刚刚才醒过来'],['健壮年轻人','李尚武','为什么这里有十个人']];
for(const [alias,name,text] of expected) {
  const identity=report.characters.find(c=>c.name===name);assert.ok(identity,`角色表缺少 ${name}`);
  assert.ok(identity.aliases.some(a=>a.name===alias),`角色表缺少 ${alias} => ${name}`);
  const lines=chapter1.segments.filter(s=>s.type==='dialogue'&&s.text.includes(text));
  assert.ok(lines.length,`未找到关键台词 ${text}`);assert.ok(lines.every(s=>s.speaker===name),`${alias} 的首章台词未回溯到 ${name}`);
  console.log(`✓ ${alias} => ${name}，首章台词已回溯`);
}
console.log('检查并拆分剩余章节（复用已确认的角色表）');
detail=await api('/novels/'+novel.id);
if(detail.chapters.some(c=>c.split_status!=='done')) await wait((await api(`/novels/${novel.id}/split`,{onlyNew:true,mode:'hybrid'})).jobId);
if(process.env.RECHECK_CHAPTERS) {
  const indices=process.env.RECHECK_CHAPTERS.split(',').map(Number);
  const chapterIds=detail.chapters.filter(c=>indices.includes(c.idx+1)).map(c=>c.id);
  assert.equal(chapterIds.length,indices.length,'复核章节编号无效');
  await wait((await api(`/novels/${novel.id}/split`,{chapterIds,mode:'hybrid'})).jobId);
}
detail=await api('/novels/'+novel.id);
assert.ok(detail.chapters.every(c=>c.split_status==='done'));
const all=[];const norm=s=>s.replace(/[\s“”「」『』"'‘’]/g,'');
for(const ch of detail.chapters) {
  const c=await api('/chapters/'+ch.id);assert.ok(norm(c.segments.map(s=>s.text).join(''))===norm(c.content),`${c.title} 原文发生变化`);
  all.push(c);
}
const chars=await api('/characters?novel_id='+novel.id);
const duplicates=expected.filter(([alias,name])=>chars.some(c=>c.name===alias)&&chars.some(c=>c.name===name));
assert.equal(duplicates.length,0,'早期称呼仍为重复角色');
const nameCounts = new Map();
for (const c of chars.filter(c=>!c.is_narrator)) nameCounts.set(c.name,(nameCounts.get(c.name)||0)+1);
const duplicateNames = [...nameCounts].filter(([,count])=>count>1).map(([name])=>name);
assert.equal(duplicateNames.length,0,'存在同名重复角色：'+duplicateNames.join('、'));
const segments=all.flatMap(c=>c.segments),dialogues=segments.filter(s=>s.type==='dialogue');
const unbound=dialogues.filter(s=>!s.character_id);
assert.equal(unbound.length,0,'有对白未关联角色');
const summary={source:corpus.source,model:report.model,novel_id:novel.id,url:`${base}/#/novel/${novel.id}`,chapters:20,characters:chars.filter(c=>!c.is_narrator).length,segments:segments.length,dialogues:dialogues.length,unknown_dialogues:dialogues.filter(s=>s.speaker==='未知角色').length,duplicate_early_names:duplicates.length,duplicate_names:duplicateNames.length,text_preserved_chapters:all.length,identity_changes:report.applied,mappings:expected.map(([alias,name])=>({alias,name})),unresolved:report.unresolved,created_at:new Date().toISOString()};
fs.writeFileSync(new URL('app-result.json',dir),JSON.stringify({summary,report,characters:chars,chapters:all},null,2));
const markdown=`# 十日终焉前20章：跨章节角色统一测试\n\n- 来源：${corpus.source}\n- 模型：${summary.model}\n- 测试页面：${summary.url}\n- 范围：第1章「空屋」至第20章「寻道」，${corpus.chapters.reduce((n,c)=>n+c.content.length,0)} 字\n- 结果：${summary.characters} 个角色，${summary.segments} 个片段，${summary.dialogues} 句对白\n- ${summary.text_preserved_chapters}/20 章拆分后正文保持一致；早期称呼重复角色 ${duplicates.length} 个；未知说话人对白 ${summary.unknown_dialogues} 句\n- 已完成角色分析和文本拆分，未执行真实语音生成\n\n| 早期称呼 | 统一姓名 | 验证 |\n| --- | --- | --- |\n${expected.map(([alias,name])=>`| ${alias} | ${name} | 第一章既有台词已回溯 |`).join('\n')}\n\n## 身份原文依据\n\n${report.characters.filter(c=>expected.some(([,name])=>name===c.name)).map(c=>`### ${c.name}\n\n${[c.evidence.find(e=>e.quote.includes(c.name)) || c.evidence[0]].map(e=>`- ${all.find(ch=>ch.id===e.chapter_id)?.title || e.chapter_id}：${e.quote.slice(0,120)}${e.quote.length>120?'…':''}`).join('\n')}`).join('\n\n')}\n\n## 待核对\n\n${report.unresolved.length ? report.unresolved.map(s=>'- '+s).join('\n') : '本次未列出待核对项。'}\n`;
fs.writeFileSync(new URL('report.md',dir),markdown);
console.log(JSON.stringify(summary,null,2));
