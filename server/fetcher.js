// 从小说网页抓取章节正文（自动识别 GBK/UTF-8、正文容器、分页）

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…', mdash: '—', middot: '·', emsp: ' ', ensp: ' ' };
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*', 'Accept-Language': 'zh-CN,zh;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`抓取失败 HTTP ${res.status}：${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return decodeHtml(buf, res.headers.get('content-type') || '');
}

export function decodeHtml(buf, contentType = '') {
  let cs = (contentType.match(/charset=([\w-]+)/i) || [])[1];
  if (!cs) {
    const head = buf.subarray(0, 4096).toString('latin1');
    cs = (head.match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1];
  }
  cs = (cs || 'utf-8').toLowerCase();
  if (['gb2312', 'gbk', 'gb18030', 'x-gbk'].includes(cs)) cs = 'gb18030';
  try { return new TextDecoder(cs).decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
}

/** 取出从 startIdx 开始的完整 <tag>…</tag>（处理嵌套） */
function sliceElement(html, startIdx, tag) {
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = startIdx;
  let depth = 0;
  let m;
  while ((m = re.exec(html))) {
    if (m[1]) { depth--; if (depth === 0) return html.slice(startIdx, m.index + m[0].length); }
    else depth++;
  }
  return html.slice(startIdx);
}

const CONTENT_HINT = /\b(?:id|class)\s*=\s*["'][^"']*\b(content|chaptercontent|chapter-content|chapter_content|booktext|BookText|txtcontent|txt|nr1|nr_content|htmlContent|readcontent|read-content|article-content|text-content|showtxt|contentbox|novelcontent|book_con|bookcontent)\b[^"']*["']/i;

export function htmlToText(fragment) {
  return decodeEntities(
    fragment
      .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h\d|li)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/　/g, ' ')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

const AD_LINE = /(www\.|https?:|\.com|\.cc|\.net|\.org|本章未完|点击下一页|继续阅读|最新章节|手机阅读|加入书签|投推荐票|请收藏|天才一秒记住|笔趣阁|首发|广告|章节错误|更新最快|免费阅读|上一章|下一章|返回目录|上一页|下一页)/i;
function cleanLines(text, title) {
  const heading = s => String(s || '').replace(/\s/g, '').match(/^(第[0-9零一二三四五六七八九十百千万两〇]+[章节回卷集部篇幕话])/i)?.[1];
  return text
    .split('\n')
    .filter((l) => !(l.length < 60 && AD_LINE.test(l)))
    .filter((l, i) => !(i < 2 && title && (l.replace(/\s/g, '') === title.replace(/\s/g, '') || (heading(title) && heading(l) === heading(title)))))
    .join('\n');
}

/** 从 HTML 中抽取标题与正文 */
export function extractChapter(html) {
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  let title = h1 ? htmlToText(h1[1]) : '';
  if (!title) {
    const t = html.match(/<title>([\s\S]*?)<\/title>/i);
    title = t ? htmlToText(t[1]).split(/[_\-|–]/)[0].trim() : '';
  }
  let body = '';
  // 优先精确的正文 id，避免先命中外层 body-content / content 容器而带入导航和推荐。
  for (const id of ['chaptercontent', 'chapter-content', 'chapter_content', 'BookText', 'booktext', 'txtcontent', 'htmlContent', 'readcontent', 'novelcontent', 'content']) {
    const exact = html.match(new RegExp(`<(?<tag>div|article|section|p)\\b[^>]*\\bid=["']${id}["'][^>]*>`, 'i'));
    if (!exact) continue;
    const text = htmlToText(sliceElement(html, exact.index, exact.groups.tag));
    if (text.replace(/\\s/g, '').length >= 100) { body = text; break; }
  }
  const m = html.match(new RegExp(`<(div|article|section|p)\\b[^>]*${CONTENT_HINT.source}[^>]*>`, 'i'));
  if (!body && m) body = htmlToText(sliceElement(html, m.index, m[1]));
  if (body.replace(/\s/g, '').length < 100) {
    // 兜底：中文字符最多的 div
    let best = '';
    const re = /<div\b[^>]*>/gi;
    let mm;
    let count = 0;
    while ((mm = re.exec(html)) && count++ < 3000) {
      const inner = sliceElement(html, mm.index, 'div');
      // 只看“直接文本”多的块：去掉子 div 后统计
      const own = inner.replace(/<div\b[\s\S]*?<\/div>/gi, (x) => (x === inner ? x : ''));
      const t = htmlToText(own);
      if ((t.match(/[一-龥]/g) || []).length > (best.match(/[一-龥]/g) || []).length) best = t;
    }
    if (best.length > body.length) body = best;
  }
  return { title: title.replace(/\s+/g, ' ').trim(), content: cleanLines(body, title) };
}

/** 找“下一页”（同一章的分页） */
function findNextPage(html, url) {
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const text = htmlToText(m[2]);
    if (!/下一页|下页/.test(text) || /下一章/.test(text)) continue;
    try {
      const next = new URL(m[1], url).href;
      const base = (u) => new URL(u).pathname.replace(/(_\d+)?\.html?$/i, '');
      if (base(next) === base(url) && next !== url) return next;
    } catch {}
  }
  return null;
}

export async function fetchChapter(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('请输入以 http:// 或 https:// 开头的网址');
  const pages = [];
  let title = '';
  let cur = url;
  const seen = new Set();
  for (let i = 0; i < 30 && cur && !seen.has(cur); i++) {
    seen.add(cur);
    const html = await fetchHtml(cur);
    const r = extractChapter(html);
    if (!title) title = r.title;
    pages.push(r.content);
    cur = findNextPage(html, cur);
  }
  const content = pages.join('\n').trim();
  if (content.replace(/\s/g, '').length < 50) throw new Error('没有识别到正文，请手动复制粘贴');
  return { title: title.replace(/[（(]\d+\s*\/\s*\d+[)）]$/, '').trim(), content, pages: pages.length };
}
