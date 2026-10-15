/**
 * 作答格式（response format）抽象层。
 *
 * MMPI-2 全部是「是非（True/False）」题，但后续要纳入更多量表，它们的作答方式
 * 各不相同：程度量表常用 Likert（如 1–5 同意度），有的量表是选项单选，还有其他
 * 精神科量表的多级作答。本模块把「一道题怎么答」统一成一份格式描述，并给出把原始
 * 作答（布尔 / 数字 / 字符串）换算成「级别索引（level，0 起）」的 helper，供计分、
 * 求解与界面复用。
 *
 * 核心约定
 * --------
 * - 一道题的作答在内部统一存成 **整数级别索引** `level ∈ [0, L-1]`，`null` 表示未答。
 * - TF 题是两级特例：`0 = 否/False`，`1 = 是/True`。
 * - 某题属于哪个格式由 `data.items.format[item-1]` 决定；缺省视为 `'tf'`。
 *
 * 计分模型（见 inverse.js）按 (量表, 题号, 级别) 的权重 `weights[flat][item][level]`
 * 累加原始分，TF 只是 `[[0,1],[1,0]]` 这种特例，因此多级量表无需特殊分支。
 *
 * 新增一种量表时无需改引擎：把题项加进 `data.items`、给题项标好 `format`，并在
 * `data.scales` 里用 `weights: { 题号: [各级点数...] }` 声明计分权重即可。
 */

/** 内置格式注册表。Likert / Choice 这种带参数的用工厂函数现造。 */
export const FORMATS = {
  tf: {
    id: 'tf',
    type: 'binary',
    // 顺序固定为 [False, True]，索引即内部级别
    levels: [
      { value: 0, label: '否', short: 'F' },
      { value: 1, label: '是', short: 'T' },
    ],
  },
};

const DEFAULT_LIKERT = [
  '完全不符合', '基本不符合', '不确定', '基本符合', '完全符合',
];

/** 程度量表：n 个等级，可自定义每级标签（默认 5 级同意度量表）。 */
export function makeLikert(n, labels) {
  if (!Number.isInteger(n) || n < 2) throw new Error(`likert 等级数需 >=2，收到 ${n}`);
  return {
    id: `likert${n}`,
    type: 'likert',
    levels: Array.from({ length: n }, (_, i) => ({
      value: i,
      label: (labels && labels[i]) || DEFAULT_LIKERT[i] || String(i + 1),
    })),
  };
}

/** 选项单选：labels 是各选项文本（顺序即级别）。 */
export function makeChoice(labels) {
  if (!Array.isArray(labels) || labels.length < 2) throw new Error('choice 至少两个选项');
  return {
    id: `choice${labels.length}`,
    type: 'choice',
    levels: labels.map((label, i) => ({ value: i, label: String(label) })),
  };
}

/** 取得某格式的级别列表（缺省走 TF）。 */
export function formatLevels(format) {
  return (format || FORMATS.tf).levels;
}

/** 级别数量（TF=2）。 */
export function levelCount(format) {
  return ((format || FORMATS.tf).levels || []).length;
}

/** 某级别的展示标签。 */
export function levelLabel(format, value) {
  const lv = formatLevels(format).find((l) => l.value === value);
  return lv ? lv.label : String(value);
}

/** TF 题「True」对应的内部级别（恒为 1）。 */
export const TRUE_LEVEL = 1;

/** 把任意内部作答当成 TF 的 True 判断（用于 VRIN/TRIN 这类只认 True/False 的对）。
 *  同时接受布尔 true 与整数级别 1，方便公开接口沿用布尔 T/F。 */
export function isTrue(level) {
  return level === TRUE_LEVEL || level === true;
}

/**
 * 把外部原始作答换算成内部级别索引。
 * - null/undefined -> null（未答）
 * - boolean -> 1/0
 * - number   -> 原样（已是级别）
 * - string   -> 优先按数字解析，否则按标签/简写匹配级别
 */
export function coerceLevel(format, raw, fallback = 0) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    const num = Number(s);
    if (Number.isInteger(num)) return num;
    const lv = formatLevels(format).find((l) => l.label === s || l.short === s);
    return lv ? lv.value : fallback;
  }
  return fallback;
}

/** 题项的作答格式；data.items.format 缺省视为 TF。 */
export function itemFormat(data, item) {
  const formats = data && data.items && data.items.format;
  return formats ? formats[item - 1] : 'tf';
}

/**
 * 题项的完整格式描述对象。优先取内置 TF；若 data.formats 里注册了自定义格式
 * （如 makeLikert / makeChoice 的产物），用它；否则回退 TF。
 */
export function itemFormatDesc(data, item) {
  const id = itemFormat(data, item);
  if (id === 'tf' || FORMATS[id]) return FORMATS[id] || FORMATS.tf;
  const custom = data && data.formats && data.formats[id];
  return custom || FORMATS.tf;
}
