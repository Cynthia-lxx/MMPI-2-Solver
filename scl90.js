/**
 * SCL-90 症状自评量表 —— 逻辑层（委托给通用 likert 引擎）。
 *
 * SCL-90 是「各因子 = 所包含题项得分之和 / 均值」的典型多级求和量表，因此直接复用
 * likert.js 的通用引擎，这里只保留 SCL-90 专属的入口与措辞（预设均值、解析、导出）。
 * 其余量表（PHQ-9 / GAD-7 / HADS / WHO-5 等）走同样的引擎，不再各自复制一套。
 */

import { SCL90_DATA } from './scl90.data.js';
import {
  likertScore,
  likertSolve,
  likertFeasibleBounds,
  likertSetItemLevel,
  likertTargetScales,
  likertParseAnswers,
  likertExportCsv,
  levelScore,
} from './likert.js';

export { SCL90_DATA };

/** 内部级别 -> 得分（1..5）。level 缺失视为 0（没有）。 */
export function levelToScore(level) {
  return levelScore(SCL90_DATA, level);
}

/** 题项文本；SCL-90 源数据只有中文，英文留空。 */
export function scl90ItemText(item) {
  return { zh: SCL90_DATA.items.zh[item - 1] || '', en: SCL90_DATA.items.en[item - 1] || '' };
}

/** 命中哪一段临床解释（直接复用通用实现，见 likert.matchBand）。 */

/** SCL-90 内部统一用通用引擎；以下入口仅做「绑死 SCL90_DATA」的薄封装。 */
export function scl90Score(answers) {
  return likertScore(SCL90_DATA, answers);
}
export function scl90Solve(targets = {}) {
  return likertSolve(SCL90_DATA, targets);
}
export function scl90FeasibleBounds(targets = {}) {
  return likertFeasibleBounds(SCL90_DATA, targets);
}
export function scl90SetItemLevel(answers, targets, item, level) {
  return likertSetItemLevel(SCL90_DATA, answers, targets, item, level);
}

/**
 * GUI 用：可设目标的因子列表（不含聚合项），每个因子附「严重度预设」。
 * 预设均值取各 band 的代表值（SCL-90 用固定的好看的均值，如 1.5/2.5/3.5/4.5）。
 */
export function scl90TargetScales() {
  const PRESET_MEAN = { 2: [1.2, 3.0], 3: [1.4, 2.5, 4.2], 4: [1.4, 2.5, 4.2, 4.7] };
  return likertTargetScales(SCL90_DATA).map((s) => ({
    name: s.name,
    fullName: s.fullName,
    family: s.family,
    n: s.n,
    presets: s.presets.map((p, i) => ({
      label: p.label,
      mean: (PRESET_MEAN[s.presets.length] || PRESET_MEAN[3])[i] ?? p.value,
    })),
  }));
}

/** 解析 SCL-90 答卷文本：支持「题号,得分」逐行 CSV，或 90 位 1..5 紧凑串。 */
export function scl90ParseAnswers(text) {
  return likertParseAnswers(SCL90_DATA, text);
}

/** 导出：题号 + 得分 + 程度，便于 Excel 打开。 */
export function scl90ExportCsv(answers) {
  return likertExportCsv(SCL90_DATA, answers);
}
