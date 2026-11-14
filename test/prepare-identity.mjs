// 下载并校验身份识别回归语料；不调用 LLM 或语音合成。
import fs from 'node:fs';
import { fetchChapter, decodeHtml, htmlToText } from '../server/fetcher.js';
const source = 'http://www.tianqiunovels.com/wenku/147-147006.html';
const dir = new URL('../data/identity-test/', import.meta.url);
fs.mkdirSync(dir, { recursive: true });
const res = await fetch(source, { signal: AbortSignal.timeout(30000) });
if (!res.ok) throw new Error(`目录 HTTP ${res.status}`);
const html = decodeHtml(Buffer.from(await res.arrayBuffer()), res.headers.get('content-type') || '');
const links = [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
  .map(m => ({ url: new URL(m[1], source).href, title: htmlToText(m[2]) }))
  .filter(c => /^第\d+章\s/.test(c.title));
const chapters = [...new Map(links.map(c => [c.url, c])).values()].slice(0, 20);
if (chapters.length !== 20) throw new Error(`目录仅找到 ${chapters.length} 章`);
let cursor = 0;
await Promise.all(Array.from({ length: 3 }, async () => {
  while (cursor < chapters.length) {
    const idx = cursor++, c = chapters[idx];
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await fetchChapter(c.url);
        if (!result.title.startsWith(`第${idx + 1}章`) || result.content.length < 1000) throw new Error(`章节校验失败 ${JSON.stringify({ title: result.title, length: result.content.length })}`);
        chapters[idx] = { ...c, ...result, idx };
        console.log(`${idx + 1}/20 ${result.title} ${result.content.length} 字 ${result.pages} 页`);
        break;
      } catch (e) { if (attempt >= 2) throw e; console.warn(`重试 ${c.title}: ${e.message}`); }
    }
  }
}));
fs.writeFileSync(new URL('chapters.json', dir), JSON.stringify({ source, fetched_at: new Date().toISOString(), chapters }, null, 2));
console.log(`已保存 ${chapters.length} 章，${chapters.reduce((n, c) => n + c.content.length, 0)} 字`);
