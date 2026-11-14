// 前20章真实 DeepSeek 角色考据（只读现有配置，不初始化业务数据库，不生成音频）。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_SETTINGS } from '../server/defaults.js';
import { analyzeIdentities } from '../server/identity-analysis.js';
import { chatJson } from '../server/llm.js';
const dir = new URL('../data/identity-test/', import.meta.url);
const corpus = JSON.parse(fs.readFileSync(new URL('chapters.json', dir), 'utf8'));
const chapters = corpus.chapters.map((c, i) => ({ ...c, id: i + 1 }));
const db = new DatabaseSync(path.resolve('data/app.db'), { readOnly: true });
const settings = { ...DEFAULT_SETTINGS };
for (const [key, env] of Object.entries({ llm_base_url: 'LLM_BASE_URL', llm_api_key: 'LLM_API_KEY', llm_model: 'LLM_MODEL' })) if (process.env[env]) settings[key] = process.env[env];
for (const r of db.prepare('SELECT key,value FROM settings').all()) if (r.value) settings[r.key] = r.value;
db.close();
if (!/deepseek/i.test(settings.llm_model)) throw new Error('本回归要求使用 DeepSeek');
console.log(`模型 ${settings.llm_model}，${chapters.length} 章`);
let calls = 0;
const report = await analyzeIdentities(chapters, settings, { onProgress: console.log, request: async (...args) => {
  const raw = await chatJson(...args);
  fs.writeFileSync(new URL(`raw-${++calls}.json`, dir), JSON.stringify(raw, null, 2));
  return raw;
} });
fs.writeFileSync(new URL('analysis.json', dir), JSON.stringify(report, null, 2));
for (const c of report.characters) console.log(`${c.name} <= ${c.aliases.map(a => a.name).join('、')}`);
console.log(`未决事项 ${report.unresolved.length}，结果已保存`);
