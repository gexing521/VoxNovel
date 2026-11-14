// 默认设置（db.js 与 test/live.mjs 共用）
export const DEFAULT_SETTINGS = {
  // 大语言模型（OpenAI 兼容格式）
  llm_base_url: 'https://starlinkaisite.com/v1',
  llm_api_key: '',
  llm_model: 'deepseek-v4.1-flash',
  llm_temperature: '0.1',
  llm_timeout_ms: '180000',
  llm_json_mode: '1',
  llm_chunk_chars: '3000',
  split_mode: 'hybrid', // hybrid=规则切分+LLM识别说话人；llm=LLM全文拆分；rule=纯规则（不调用LLM）
  detect_emotion: '1',
  identity_prepass: '1', // 先结合全书已导入章节考据身份，再拆分并统一早期称呼
  // MiniMax 语音
  minimax_api_key: '',
  minimax_ws_url: 'wss://api.minimaxi.com/ws/v1/t2a_v2',
  minimax_api_base: 'https://api.minimaxi.com',
  tts_model: 'speech-2.8-hd',
  tts_language_boost: 'Chinese',
  tts_sample_rate: '32000',
  tts_bitrate: '128000',
  tts_concurrency: '3',
  tts_rpm: '30', // 每分钟最多请求数（按 MiniMax 账号 RPM 配额调整）
  tts_timeout_ms: '120000',
  tts_max_retries: '3',
  preview_text: '你好，这是一段试听音频。夜色渐深，远处的灯火一盏一盏亮了起来。',
  default_narrator_voice: 'audiobook_male_1',
  auto_assign_voice: '1',
  ai_casting: '1', // 拆分后用 LLM 按人设为新角色挑选音色
  // 切分与字幕
  max_segment_chars: '1500',
  merge_narration_chars: '0',
  lrc_max_line_chars: '28',
  lrc_speaker_prefix: '0',
  build_merged: '1',
};
