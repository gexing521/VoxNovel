// MiniMax 情绪参数（voice_setting.emotion），2026-11-14 用真实接口实测：
// speech-2.8-*：happy sad angry fearful disgusted surprised calm fluent neutral 可用；whisper 报错 2013
// speech-2.6-*：以上全部 + whisper
// 其它（speech-02 / 01 等旧模型）：只用 7 种基础情绪 + neutral 更稳妥
export const ALL_EMOTIONS = ['neutral', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm', 'fluent', 'whisper'];
const BASE = ['neutral', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm'];

export function emotionsForModel(model = '') {
  const m = String(model).toLowerCase();
  if (/speech-2\.6/.test(m)) return [...BASE, 'fluent', 'whisper'];
  if (/speech-2\.[7-9]|speech-[3-9]/.test(m)) return [...BASE, 'fluent'];
  return BASE;
}

/** 把情绪映射为当前模型可用的值；空串表示交给模型自动判断 */
export function emotionForModel(emotion, model) {
  const e = String(emotion || '').toLowerCase().trim();
  if (!e || !ALL_EMOTIONS.includes(e)) return '';
  const ok = emotionsForModel(model);
  if (ok.includes(e)) return e;
  if (e === 'whisper') return ok.includes('calm') ? 'calm' : '';
  if (e === 'fluent') return 'neutral';
  return '';
}
