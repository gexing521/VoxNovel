// OpenAI 兼容格式的大语言模型调用（默认 https://starlinkaisite.com/v1）
import { REPAIR_PROMPT } from './prompts.js';

function baseUrl(settings) {
  let u = String(settings.llm_base_url || 'https://starlinkaisite.com/v1').trim().replace(/\/+$/, '');
  // 只填了域名（如 https://starlinkaisite.com）时自动补 /v1
  try {
    const p = new URL(u);
    if (p.pathname === '' || p.pathname === '/') u += '/v1';
  } catch {}
  // 用户误填了完整路径
  return u.replace(/\/chat\/completions$/, '');
}

export async function chat(settings, messages, { json = true, temperature } = {}) {
  if (!settings.llm_api_key) throw new Error('未配置大语言模型 API Key（设置 → 大语言模型）');
  const url = baseUrl(settings) + '/chat/completions';
  const body = {
    model: settings.llm_model || 'deepseek-v4.1-flash',
    messages,
    temperature: temperature ?? (Number(settings.llm_temperature) || 0.2),
  };
  const useJsonMode = json && settings.llm_json_mode !== '0';
  if (useJsonMode) body.response_format = { type: 'json_object' };

  const doFetch = async (b) => {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.llm_api_key}` },
        body: JSON.stringify(b),
        signal: AbortSignal.timeout(Number(settings.llm_timeout_ms) || 180000),
      });
    } catch (e) {
      throw new Error(`无法连接 ${url}：${e.cause?.code || e.cause?.message || e.message}`);
    }
    const txt = await res.text();
    return { res, txt };
  };

  let { res, txt } = await doFetch(body);
  // 部分中转不支持 response_format，自动降级重试
  if (!res.ok && useJsonMode && res.status === 400 && /response_format|json_object/i.test(txt)) {
    delete body.response_format;
    ({ res, txt } = await doFetch(body));
  }
  if (!res.ok) throw new Error(`LLM 请求失败 HTTP ${res.status}：${txt.slice(0, 300)}`);
  let data;
  try { data = JSON.parse(txt); } catch { throw new Error('LLM 返回非 JSON：' + txt.slice(0, 200)); }
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('LLM 返回格式异常：' + txt.slice(0, 200));
  return { content, usage: data.usage };
}

/** 从模型输出中尽力解析 JSON */
export function parseJsonLoose(text) {
  let t = String(text).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch {}
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s >= 0 && e > s) {
    try { return JSON.parse(t.slice(s, e + 1)); } catch {}
  }
  const as = t.indexOf('[');
  const ae = t.lastIndexOf(']');
  if (as >= 0 && ae > as) {
    try { return JSON.parse(t.slice(as, ae + 1)); } catch {}
  }
  throw new Error('无法解析 LLM 输出的 JSON：' + t.slice(0, 200));
}

export async function chatJson(settings, messages, opts) {
  let lastErr;
  for (let i = 0; i < 2; i++) {
    let content;
    try {
      ({ content } = await chat(settings, messages, opts));
      return parseJsonLoose(content);
    } catch (e) {
      lastErr = e;
      if (/未配置|HTTP 40[13]/.test(e.message)) break;
      // 输出格式不对：追加一轮纠正，让模型把自己的结果转成 JSON（比整段重来便宜）
      if (content) {
        try {
          const { content: fixed } = await chat(settings, [...messages, { role: 'assistant', content }, { role: 'user', content: REPAIR_PROMPT }], opts);
          return parseJsonLoose(fixed);
        } catch (e2) {
          lastErr = e2;
        }
      }
    }
  }
  throw lastErr;
}

export async function listModels(settings) {
  const res = await fetch(baseUrl(settings) + '/models', {
    headers: { Authorization: `Bearer ${settings.llm_api_key}` },
    signal: AbortSignal.timeout(20000),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}：${txt.slice(0, 200)}`);
  const data = JSON.parse(txt);
  return (data.data || []).map((m) => m.id).filter(Boolean).sort();
}
