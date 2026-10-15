/**
 * SCL-90 症状自评量表 —— 数据无关的逻辑层。
 *
 * 与 MMPI-2 不同，SCL-90 不做 T 分反推，而是「各因子 = 所包含题目的得分之和 /
 * 均值」，且 10 个因子（9 个临床因子 + 其他）恰好把 90 题不重不漏地划分完。因此：
 *
 *   - 正向计分（scl90Score）只是线性求和，给出各因子均值、总分、阳性项目数，
 *     以及命中哪一段临床解释（bands）。
 *   - 反推作答（scl90Solve）是逐因子的整数划分问题，因子间互不干扰，可精确求解：
 *     给定某因子目标均值 m 与题数 n，目标总分 = round(m·n)，再把 1..5 分分配到
 *     各题即可；未指定目标的因子默认全答「没有」（均值 1，正常）。
 *
 * 作答在内部统一存成「级别 level ∈ 0..4」，显示/导出时换算为得分 score = level + 1
 * （没有=1 … 严重=5），与 formats.js 的 likert5 约定一致。
 */

import { SCL90_DATA } from './scl90.data.js';

export { SCL90_DATA };

/** 内部级别 -> 得分（1..5）。level 缺失视为 0（没有）。 */
export function levelToScore(level) {
  if (level === null || level === undefined) return 1;
  const lv = Number(level);
  return Math.max(1, Math.min(5, lv + 1));
}

/** 得分（1..5）-> 内部级别（0..4）。 */
export function scoreToLevel(score) {
  return Math.max(0, Math.min(4, Number(score) - 1));
}

/** 题项文本；SCL-90 源数据只有中文，英文留空。 */
export function scl90ItemText(item) {
  return { zh: SCL90_DATA.items.zh[item - 1] || '', en: SCL90_DATA.items.en[item - 1] || '' };
}

/** 该因子是否「聚合项」（总分 / 总平均分，bind=[0]）。 */
function isAggregate(scale) {
  return scale.bind.length === 1 && scale.bind[0] === 0;
}

/** 命中哪一段临床解释；返回 band 或 null（落在分段间隙时）。 */
export function matchBand(bands, value) {
  for (const b of bands) {
    const aboveMin = b.minInc ? value >= b.min : value > b.min;
    const belowMax = b.maxInc ? value <= b.max : value < b.max;
    if (aboveMin && belowMax) return b;
  }
  return null;
}

/**
 * 正向计分。
 * @param {number[]} answers 长度 90，元素为内部级别 0..4（缺失按 0）。
 */
export function scl90Score(answers) {
  const n = SCL90_DATA.nItems;
  const scoreOf = (lvl) => levelToScore(lvl);
  let totalRaw = 0;
  let positive = 0;
  for (let i = 0; i < n; i += 1) {
    const s = scoreOf(answers[i]);
    totalRaw += s;
    if (s >= 2) positive += 1; // 得分 ≥2（很轻及以上）计为阳性项目
  }

  const factors = {};
  for (const f of SCL90_DATA.scales) {
    if (isAggregate(f)) continue;
    let raw = 0;
    for (const it of f.bind) raw += scoreOf(answers[it - 1]);
    factors[f.name] = { raw, mean: raw / f.bind.length, n: f.bind.length };
  }

  const total = totalRaw;
  const totalMean = totalRaw / n;

  const diagnoses = {};
  for (const f of SCL90_DATA.scales) {
    const value = isAggregate(f)
      ? f.type === 'sum'
        ? total
        : totalMean
      : factors[f.name].mean;
    diagnoses[f.name] = matchBand(f.bands, value);
  }

  return {
    factors,
    total,
    totalMean,
    positiveCount: positive,
    positiveRate: positive / n,
    positiveCutoff: SCL90_DATA.positiveCutoff,
    diagnoses,
  };
}

/**
 * 反推作答：给定「因子名 -> 目标均值」求解一份答卷。
 * 因子间互不重叠，逐因子独立精确求解；未指定的因子默认全答「没有」。
 */
export function scl90Solve(targets = {}) {
  const n = SCL90_DATA.nItems;
  const answers = new Array(n).fill(0); // 默认「没有」(level 0, score 1)
  const achieved = {};
  const requested = {};

  for (const f of SCL90_DATA.scales) {
    if (isAggregate(f)) continue;
    const name = f.name;
    const items = f.bind;
    const ni = items.length;
    const mean = targets[name];
    if (mean === undefined || mean === null) {
      achieved[name] = 1;
      continue;
    }
    requested[name] = Number(mean);
    const targetMean = Math.max(1, Math.min(5, Number(mean)));
    const targetSum = Math.round(targetMean * ni);

    // 基础全答「没有」(score 1 => raw = ni)，再按残差增减到目标 raw
    let residual = targetSum - ni;
    const levels = items.map(() => 0);
    let idx = 0;
    const guard = ni * 5 + 1;
    while (residual > 0 && idx < guard) {
      if (levels[idx % ni] < 4) {
        levels[idx % ni] += 1;
        residual -= 1;
      }
      idx += 1;
    }
    while (residual < 0 && idx < guard) {
      if (levels[idx % ni] > 0) {
        levels[idx % ni] -= 1;
        residual += 1;
      }
      idx += 1;
    }
    items.forEach((it, k) => {
      answers[it - 1] = levels[k];
    });
    const got = items.reduce((s, it) => s + levelToScore(answers[it - 1]), 0) / ni;
    achieved[name] = got;
  }

  return { answers, achieved, requested, feasible: true, nItems: n };
}

/**
 * GUI 用：可设目标的因子列表（不含聚合项），每个因子附「严重度预设」。
 * 预设均值取各 band 的代表值，便于下拉直接选「正常 / 轻度 / 中度 / 偏重」。
 */
export function scl90TargetScales() {
  const PRESET_MEAN = { 2: [1.2, 3.0], 3: [1.4, 2.5, 4.2], 4: [1.4, 2.5, 4.2, 4.7] };
  return SCL90_DATA.scales
    .filter((f) => !isAggregate(f))
    .map((f) => ({
      name: f.name,
      fullName: f.fullName,
      family: 'factor',
      presets: f.bands.map((b, i) => ({
        label: b.severity,
        mean: (PRESET_MEAN[f.bands.length] || PRESET_MEAN[3])[i] ?? (b.min + b.max) / 2,
      })),
    }));
}

/** 解析 SCL-90 答卷文本：支持「题号,得分」逐行 CSV，或 90 位 1..5 紧凑串。 */
export function scl90ParseAnswers(text) {
  const n = SCL90_DATA.nItems;
  const answers = new Array(n).fill(null);
  const unknown = [];
  let found = 0;

  const lines = String(text).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const looksTabular = lines.length > 1 || /[,，]/.test(text);
  if (looksTabular) {
    let idx = 0;
    for (const line of lines) {
      if (/题号|得分|程度|q|item/i.test(line)) continue; // 跳过表头
      const parts = line.split(/[,，\t]+/).map((s) => s.trim()).filter(Boolean);
      const tok = parts.length >= 2 ? parts[1] : parts[0];
      const d = Number(tok);
      if (Number.isInteger(d) && idx < n) {
        if (d >= 1 && d <= 5) {
          answers[idx] = d - 1;
          found += 1;
        } else {
          unknown.push(idx + 1);
        }
        idx += 1;
      }
    }
    return { answers, found, unknown };
  }

  const digits = String(text).replace(/\s/g, '').split('').filter((c) => /[0-9]/.test(c));
  for (let i = 0; i < n; i += 1) {
    const c = digits[i];
    if (c === undefined) break;
    const d = Number(c);
    if (d >= 1 && d <= 5) {
      answers[i] = d - 1; // 得分 -> 级别
      found += 1;
    } else {
      unknown.push(i + 1);
    }
  }
  return { answers, found, unknown };
}

/** 导出：题号 + 得分 + 程度，便于 Excel 打开。 */
export function scl90ExportCsv(answers) {
  const lines = ['题号,得分,程度'];
  for (let i = 0; i < SCL90_DATA.nItems; i += 1) {
    const lvl = answers[i];
    const score = levelToScore(lvl);
    const label = SCL90_DATA.formats.likert5.levels[lvl]?.label || '';
    lines.push(`${i + 1},${score},${label}`);
  }
  return lines.join('\r\n') + '\r\n';
}
