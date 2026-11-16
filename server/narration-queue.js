// 所有旁白整合任务共用请求上限，避免多集同时启动时成倍增加模型并发。
const MAX_REQUESTS = 6;
let activeRequests = 0;
const waiters = [];

export async function narrationRequest(fn, cancelled = () => false) {
  if (activeRequests >= MAX_REQUESTS) await new Promise(resolve => waiters.push(resolve));
  else activeRequests++;
  try {
    if (cancelled()) throw new Error('已取消');
    return await fn();
  } finally {
    const next = waiters.shift();
    if (next) next();
    else activeRequests--;
  }
}

// 出错后停止领取新工作，等待已经发出的请求结束，再由调用者处理整集结果。
export async function narrationWorkers(items, concurrency, fn, cancelled = () => false) {
  let next = 0, error;
  const worker = async () => {
    while (!error && next < items.length) {
      if (cancelled()) { error = new Error('已取消'); break; }
      const index = next++;
      try { await fn(items[index], index); }
      catch (e) { error ||= e; }
    }
  };
  await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, worker));
  if (error) throw error;
}
