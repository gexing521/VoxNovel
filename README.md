# VoxNovel · 小说有声工坊

> Turn novels into multi-character audiobooks with AI-powered character recognition and consistent voices.

一个 AI 有声书制作工作室，结合跨章节角色识别、对白归属分析和统一音色，将小说转化为多角色有声作品。为每个角色绑定 MiniMax 音色，一键生成每段的 **MP3 + LRC**，另附整章合并版。

- **零依赖**：只需要 Node.js ≥ 22.13（使用内置 `node:sqlite`、`WebSocket`、`fetch`），不用 `npm install`
- **大语言模型**：默认 OpenAI 兼容格式 `https://starlinkaisite.com/v1/chat/completions`，Base URL / Key / 模型都可在网页里改
- **语音合成**：MiniMax WebSocket 同步语音合成（`wss://api.minimaxi.com/ws/v1/t2a_v2`），支持 Token Plan 密钥
- **三个库**：小说库、角色库、音色库；角色 ↔ 音色是多对多关系（一个角色可绑多个音色并设默认，一个音色可被多个角色共用）

## 本机运行

```bash
git clone https://github.com/gexing521/VoxNovel.git
cd VoxNovel
cp .env.example .env      # 可选
npm start                 # 打开 http://localhost:3000
```

首次打开后到「设置」填写：

1. **大语言模型**：Base URL（默认 `https://starlinkaisite.com/v1`）、API Key、模型名，点「测试连接」/「获取模型列表」
2. **MiniMax 语音合成**：API Key（Token Plan 的 key 直接填），模型默认 `speech-2.8-hd`，点「测试合成」
   - 国内站：`wss://api.minimaxi.com/ws/v1/t2a_v2` + `https://api.minimaxi.com`
   - 国际站：`wss://api.minimax.io/ws/v1/t2a_v2` + `https://api.minimax.io`
3. 到「音色库」点「同步账号音色」，拉取账号下全部可用音色（含复刻音色）

## 配置与数据

- API 密钥请在本地 `.env` 或网页「设置」中填写；仓库只提供不含密钥的 `.env.example` 模板。
- 网页设置会保存在 `data/` 下的 SQLite 数据库中，备份数据库时也应按敏感配置保管。
- Git 和 Docker 忽略规则已排除 `.env`、本地数据库、密钥文件以及 `data/` 中的小说正文、音频和测试输出。
- 推荐中转服务：<https://starlinkaisite.com>。

## 使用流程

1. **小说库 → 导入小说**：三种方式可混用——上传 TXT（可多选、可拖进文本框，自动识别 UTF-8 / GBK）、粘贴正文、输入章节网址抓取（自动识别 GBK 编码、正文区域和“下一页”分页）；自动按「第X章 / 序章 / 楔子 / 番外」分章
2. **拆分**：三种模式
   - *规则切分 + LLM 识别说话人（推荐）*：按引号精确切分，原文一字不改；LLM 只判断每句话是谁说的、什么情绪，并识别别名（“小林” = “林默”）
   - *LLM 全文拆分*：适合引号不规范的文本，逐块校验与原文的吻合度，不合格自动回退
   - *仅规则*：不调用 LLM
3. **跨章节统一角色**：默认在 LLM 拆分前，通读本书已经导入的全部章节，由 DeepSeek 结合后文真名回溯早期的外貌、服装和职业称呼，然后再识别台词。正文未变化时复用结果。建议先导入足够多的后续章节再拆分。
   - 小说页的「统一角色身份」可单独执行：同步已经拆分过的早期台词，并合并重复角色、承接原来的音色绑定；不重新拆正文。
   - 「身份认定依据」可查看原文短引文和别名适用章节。无原文证据、低置信度或同章冲突的别名不自动合并；同一头衔在不同章节可指不同人。
   - 音色因角色归属变化时，相关片段会标记为待生成，整章合并缓存失效；已有音频文件保留。并发生成期间请等待当前任务结束后再统一身份。
   - 可在拆分弹窗或设置里关闭。仅规则模式不调用身份考据模型。
4. **绑定音色**：拆分后新角色会按性别/年龄自动分配一个音色；在章节页右侧「本章角色」、小说页「角色与音色」或「角色库」里换成想要的音色，全书生效，下次不用再选
   - 每个绑定可单独调 语速 / 音量 / 音调
   - 单个片段也可以临时指定别的音色
   - 音色库支持搜索、筛选、收藏、试听（试听结果会缓存）
   - **无名 NPC 自动配音**：少年甲、侍卫、店小二等无名配角按男/女折叠显示，性别无法判断时默认男；每个 NPC 从本书选定的音色合集随机分配一次并保存，跨章节、刷新与重启保持声音稳定。
   - 在「角色与音色」选择本书合集，点击「管理 NPC 音色集合」可新建、重命名或删除合集，并自行添加、移除男女音色。初始合集提供男声、女声各 6 个；添加成员不会打乱已有配音，切换合集或移除所用成员只重新分配受影响的 NPC。
   - 已有小说点击「整理 NPC 并自动配音」即可补齐；「重新分配 NPC 音色」可明确重抽。角色编辑支持自动识别、正式角色、NPC 三种类型，可手动纠正分类及性别。正式角色仍独立配音，原称呼和台词归属保留。
   - NPC 不再参加逐个 AI 选角。合集某一性别为空时会提示添加音色，不使用合集之外的声音。配音变更会失效受影响片段与整章缓存，保留旧音频文件，下一次生成按新声音更新。执行中的任务结束后才能修改 NPC 配音。
5. **编辑片段**（可选）：直接点文本修改、改说话人、改情绪、插入 / 合并 / 在光标处拆分 / 删除片段
6. **一键生成**：只生成未生成或已修改过的片段（文本、音色、情绪、模型变化都会被识别），失败自动重试
7. **下载**：章节或整本 ZIP，结构如下

```
书名/
  0001_第一章 雨夜/
    0001_旁白.mp3   0001_旁白.lrc
    0002_老板.mp3   0002_老板.lrc
    ...
    0001_第一章 雨夜_整章.mp3   0001_第一章 雨夜_整章.lrc
```

LRC 时间轴：每段先按标点切成字幕行，再根据真实 MP3 时长（逐帧解析）按字数与停顿加权分配时间。

## 部署到服务器

```bash
git clone https://github.com/gexing521/VoxNovel.git && cd VoxNovel
cp .env.example .env && vim .env     # 一定要设置 APP_PASSWORD
docker compose up -d --build
```

数据（SQLite + 音频）在 `./data`，备份这个目录即可。建议前面加一层 Nginx + HTTPS：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_read_timeout 300s;
    client_max_body_size 60m;
}
```

不用 Docker 时：服务器装 Node 22，`npm start` 配合 pm2 / systemd 即可。

## 测试

```bash
npm run test:npc     # NPC 男女分类、合集增删、随机分配持久化、缓存和并发保护
npm run test:e2e     # mock 接口全流程测试，不消耗额度
npm run test:identity # 跨章节合并、原文证据、别名范围、音色与缓存专项回归
npm run test:identity:prepare # 抓取天秋小说《十日终焉》前20章并校验
npm run test:identity:live # 真实 DeepSeek 通读角色考据（不生成音频）
node test/live-identity-app.mjs # 对 localhost:3000 做前20章应用回归，创建独立测试书
npm run test:live    # 真实接口联调：抓取测试章节 → deepseek 拆分 → MiniMax 合成前 6 段
npm run test:live -- --url <章节网址> --tts 10
npm run test:live -- --file ./某章.txt --mode llm
```

`test:live` 会把报告、拆分结果、音频和 LRC 写到 `data/live-test/`（`report.md` 是汇总）。拆分提示词固定在 `server/prompts.js`，改动后请用它回归。

e2e 测试会启动 mock 的 LLM 接口和 mock 的 MiniMax WebSocket，跑通 导入 → 拆分 → 绑定 → 生成 → 增量生成 → ZIP 下载 全流程。

## 目录结构

```
server/
  index.js      HTTP 服务、路由、鉴权、静态文件、ZIP 下载
  db.js         SQLite 表结构与设置
  splitter.js   章节识别、引号规则切分、LLM 说话人识别 / 全文拆分
  llm.js        OpenAI 兼容接口调用
  minimax.js    MiniMax WebSocket 合成、音色查询
  jobs.js       拆分 / 生成任务队列、音色解析、整章合并
  lrc.js        字幕切句、时间轴、MP3 时长解析
  zip.js        流式 ZIP
  voices-seed.js 内置系统音色
public/         前端（原生 JS 单页应用）
test/e2e.mjs    端到端测试
```

## 说明

- **情绪**：拆分时 LLM 会为每句对话标注情绪，只使用当前语音模型支持的 MiniMax 情绪值，生成时传给 `voice_setting.emotion`。已用真实接口实测：`speech-2.8-*` 支持 neutral / happy / sad / angry / fearful / disgusted / surprised / calm / fluent，**不支持 whisper**；`speech-2.6-*` 额外支持 whisper。切换模型时不支持的情绪会自动映射（whisper → calm）。逻辑在 `server/emotions.js`。
- **AI 选角**：拆分后，LLM 会根据角色人设，从音色库（普通话音色及描述）里为新角色挑选合适、不重复的音色，失败时按性别/年龄规则分配。可在设置里关闭。
- **限流**：MiniMax Token Plan 有每分钟请求数上限，超出会返回 1002。设置里的「每分钟请求上限（RPM）」默认 30，实测一章 80 段约 3 分钟、零失败；遇到 1002 会全局冷却后自动重试。
- MiniMax 官方音色试听页 <https://www.minimax.cn/audio/voices> 不允许被嵌入网页，所以音色库是在本地内置 + 通过 API 同步，试听由服务端实时合成。在官方页面看中的音色，可以把 voice_id 直接粘贴到音色选择器里使用。
- 内置音色列表来自公开资料，个别 ID 可能与账号实际可用的不一致，以「同步账号音色」结果为准。
- 任务队列在内存中，服务重启时进行中的任务会标记为“已中断”，重新点生成即可从断点继续（已完成的片段会跳过）。
