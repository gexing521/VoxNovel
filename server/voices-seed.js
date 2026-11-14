// MiniMax 系统音色（内置种子，便于离线挑选）。
// 在「音色库」点击“同步官方音色”会调用 /v1/get_voice 拉取账号下全部可用音色（含复刻音色）并合并到这里。
// 官方音色试听页：https://www.minimax.cn/audio/voices

const V = (voice_id, name, gender, tags = '', description = '') => ({ voice_id, name, gender, tags, description });

export const SEED_VOICES = [
  // 有声书 / 播音
  V('audiobook_male_1', '男性有声书1', 'male', '有声书,旁白'),
  V('audiobook_male_2', '男性有声书2', 'male', '有声书,旁白'),
  V('audiobook_female_1', '女性有声书1', 'female', '有声书,旁白'),
  V('audiobook_female_2', '女性有声书2', 'female', '有声书,旁白'),
  V('presenter_male', '男性主持人', 'male', '主持,旁白'),
  V('presenter_female', '女性主持人', 'female', '主持,旁白'),
  V('Chinese (Mandarin)_News_Anchor', '新闻女声', 'female', '播报,旁白'),
  V('Chinese (Mandarin)_Male_Announcer', '播报男声', 'male', '播报,旁白'),
  V('Chinese (Mandarin)_Radio_Host', '电台男主播', 'male', '播报,旁白'),
  V('Chinese (Mandarin)_Lyrical_Voice', '抒情男声', 'male', '抒情,旁白'),
  // 青年男
  V('male-qn-qingse', '青涩青年', 'male', '青年'),
  V('male-qn-jingying', '精英青年', 'male', '青年'),
  V('male-qn-badao', '霸道青年', 'male', '青年,霸道'),
  V('male-qn-daxuesheng', '青年大学生', 'male', '青年,学生'),
  V('male-qn-qingse-jingpin', '青涩青年-beta', 'male', '青年'),
  V('male-qn-jingying-jingpin', '精英青年-beta', 'male', '青年'),
  V('male-qn-badao-jingpin', '霸道青年-beta', 'male', '青年,霸道'),
  V('male-qn-daxuesheng-jingpin', '青年大学生-beta', 'male', '青年,学生'),
  V('junlang_nanyou', '俊朗男友', 'male', '青年,恋爱'),
  V('chunzhen_xuedi', '纯真学弟', 'male', '少年,学生'),
  V('lengdan_xiongzhang', '冷淡学长', 'male', '青年,高冷'),
  V('badao_shaoye', '霸道少爷', 'male', '青年,霸道'),
  V('bingjiao_didi', '病娇弟弟', 'male', '少年,病娇'),
  V('Chinese (Mandarin)_Gentleman', '温润男声', 'male', '青年,温柔'),
  V('Chinese (Mandarin)_Gentle_Youth', '温润青年', 'male', '青年,温柔'),
  V('Chinese (Mandarin)_Unrestrained_Young_Man', '不羁青年', 'male', '青年,洒脱'),
  V('Chinese (Mandarin)_Southern_Young_Man', '南方小哥', 'male', '青年'),
  V('Chinese (Mandarin)_Sincere_Adult', '真诚青年', 'male', '青年'),
  V('Chinese (Mandarin)_Straightforward_Boy', '率真弟弟', 'male', '少年'),
  V('Chinese (Mandarin)_Stubborn_Friend', '嘴硬竹马', 'male', '少年'),
  V('Chinese (Mandarin)_Pure-hearted_Boy', '清澈邻家弟弟', 'male', '少年'),
  V('Chinese (Mandarin)_Reliable_Executive', '沉稳高管', 'male', '中年,沉稳'),
  V('Chinese (Mandarin)_Humorous_Elder', '搞笑大爷', 'male', '老年,幽默'),
  // 女
  V('female-shaonv', '少女', 'female', '少女'),
  V('female-yujie', '御姐', 'female', '御姐'),
  V('female-chengshu', '成熟女性', 'female', '成熟'),
  V('female-tianmei', '甜美女性', 'female', '甜美'),
  V('female-shaonv-jingpin', '少女-beta', 'female', '少女'),
  V('female-yujie-jingpin', '御姐-beta', 'female', '御姐'),
  V('female-chengshu-jingpin', '成熟女性-beta', 'female', '成熟'),
  V('female-tianmei-jingpin', '甜美女性-beta', 'female', '甜美'),
  V('tianxin_xiaoling', '甜心小玲', 'female', '少女,甜美'),
  V('qiaopi_mengmei', '俏皮萌妹', 'female', '少女,俏皮'),
  V('wumei_yujie', '妩媚御姐', 'female', '御姐,妩媚'),
  V('diadia_xuemei', '嗲嗲学妹', 'female', '少女,学生'),
  V('danya_xuejie', '淡雅学姐', 'female', '青年,淡雅'),
  V('Chinese (Mandarin)_Mature_Woman', '傲娇御姐', 'female', '御姐'),
  V('Arrogant_Miss', '嚣张小姐', 'female', '少女,嚣张'),
  V('Chinese (Mandarin)_Warm_Bestie', '温暖闺蜜', 'female', '青年,温暖'),
  V('Chinese (Mandarin)_Sweet_Lady', '甜美女声', 'female', '甜美'),
  V('Chinese (Mandarin)_Wise_Women', '阅历姐姐', 'female', '成熟'),
  V('Chinese (Mandarin)_Warm_Girl', '温暖少女', 'female', '少女'),
  V('Chinese (Mandarin)_Gentle_Senior', '温柔学姐', 'female', '青年,温柔'),
  V('Chinese (Mandarin)_Crisp_Girl', '清脆少女', 'female', '少女'),
  V('Chinese (Mandarin)_Soft_Girl', '柔和少女', 'female', '少女,温柔'),
  V('Chinese (Mandarin)_HK_Flight_Attendant', '港普空姐', 'female', '青年'),
  V('Chinese (Mandarin)_Kind-hearted_Antie', '热心大婶', 'female', '中年'),
  V('Chinese (Mandarin)_Kind-hearted_Elder', '花甲奶奶', 'female', '老年'),
  // 儿童 / 特色
  V('clever_boy', '聪明男童', 'male', '儿童'),
  V('cute_boy', '可爱男童', 'male', '儿童'),
  V('lovely_girl', '萌萌女童', 'female', '儿童'),
  V('cartoon_pig', '卡通猪小琪', 'female', '卡通'),
  V('Chinese (Mandarin)_Cute_Spirit', '憨憨萌兽', '', '卡通'),
  V('Robot_Armor', '机械战甲', 'male', '机器人,特色'),
];

export function guessGender(s = '') {
  const t = String(s);
  if (/female|woman|girl|lady|miss|女|姐|妹|奶奶|大婶|阿姨|少女|御姐/i.test(t)) return 'female';
  if (/male|man\b|boy|gentleman|男|哥|弟|爷|叔|少爷|学长|青年|大叔/i.test(t)) return 'male';
  return '';
}

/** 根据名称/标签推断年龄段，用于自动分配音色 */
export function guessAgeTag(s = '') {
  const t = String(s);
  if (/儿童|童|child|kid|cute_boy|clever_boy|lovely_girl/i.test(t)) return 'child';
  if (/少年|少女|少爷|学生|学弟|学妹|学姐|学长|弟弟|青年|年轻|young/i.test(t)) return 'young';
  if (/老|爷|奶奶|elder|grandpa|grandma/i.test(t)) return 'old';
  if (/中年|大婶|成熟|高管|mature|executive|antie/i.test(t)) return 'middle';
  return 'young';
}

/** 是否为普通话音色（用于自动分配，排除外语/方言音色） */
const FOREIGN = /(英|西班牙|葡萄牙|法|意大利|德|日|韩|俄|阿拉伯|希腊|捷克|芬兰|印地|土耳其|荷兰|越南|泰|印尼|印度尼西亚|波兰|罗马尼亚|乌克兰|瑞典|挪威|丹麦|匈牙利|保加利亚|希伯来|马来|菲律宾|粤|闽南|波斯|斯瓦希里)语/;
export function isMandarinVoice(v) {
  const id = v.voice_id || '';
  const d = v.description || '';
  if (id.startsWith('Chinese (Mandarin)')) return true;
  if (FOREIGN.test(d)) return false;
  if (/^(English|Japanese|Korean|Spanish|Portuguese|French|Indonesian|German|Russian|Italian|Arabic|Turkish|Ukrainian|Dutch|Vietnamese|Thai|Polish|Romanian|Greek|Czech|Finnish|Hindi|Cantonese|Chinese \(Cantonese\))/i.test(id)) return false;
  if (/^(greek|czech|finnish|hindi|english|spanish|french|german|italian|japanese|korean|russian|arabic|turkish|dutch|polish|thai|vietnamese|indonesian|portuguese|ukrainian|romanian)_/i.test(id)) return false;
  return /^[a-z]/.test(id) || /普通话|中文/.test(d) || /^(Arrogant_Miss|Robot_Armor)$/.test(id);
}
