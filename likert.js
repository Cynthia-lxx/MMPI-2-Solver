/**
 * 通用「多级求和」量表引擎（Likert / Choice 计分）。
 *
 * 与 MMPI-2（是非题 + T 分反算）不同，SCL-90、PHQ-9、GAD-7、HADS、WHO-5 等都
 * 是「若干题的得分求和 / 求均值」，且各因子（子量表）互不重叠地划分题项。这套引擎
 * 与具体量表**无关**，只认传入的 `data`：
 *
 *   - data.nItems          题数
 *   - data.items           题项文本与 format 标注
 *   - data.formats         自定义作答格式（makeLikert 产物）
 *   - data.scoreShift       内部级别 -> 基础得分的偏移（SCL-90:1，其余:0）
 *   - data.reverse?        反向计分的题号集合（如 HADS 的偶数抑郁题）
 *   - data.scales[]        每个子量表：{ name, fullName, family, type, bind:[题号],
 *                             bandMetric:'mean'|'sum', bands:[{min,max,severity,...}] }
 *                             聚合项（总分）约定 bind=[0]
 *   - data.positiveScore?  得分 >= 该值计为阳性项目（仅 SCL-90 用）
 *
 * 作答在内部统一存成「级别 level ∈ [0, L-1]」。某题对因子总分的「贡献分」为：
 *     正向题：contrib = level + shift
 *     反向题：contrib = (L-1 - level) + shift
 * 因子度量值 = 各题 contrib 之和 / 均值。求解、可行区间、滑块重平衡全部在「贡献分」
 * 空间里计算，再映射回级别，因此正反向题统一处理。
 */

import { itemFormatDesc } from './formats.js';

/** 命中哪一段临床解释；返回 band 或 null（落在分段间隙时）。 */
export function matchBand(bands, value) {
  for (const b of bands) {
    const aboveMin = b.minInc ? value >= b.min : value > b.min;
    const belowMax = b.maxInc ? value <= b.max : value < b.max;
    if (aboveMin && belowMax) return b;
  }
  return null;
}

/** 某量表最高级别（0 起）。 */
function maxLevelOf(data) {
  return itemFormatDesc(data, 1).levels.length - 1;
}

/** 反向计分的题号集合。 */
function reverseSet(data) {
  return new Set(data.reverse || []);
}

/** 某题在某级别下对总分的「贡献分」（正反向统一）。 */
function contribOf(data, item, level) {
  const ml = maxLevelOf(data);
  const shift = data.scoreShift || 0;
  const lv = Math.max(0, Math.min(ml, Number(level)));
  return reverseSet(data).has(item) ? ml - lv + shift : lv + shift;
}

/** 把「贡献分」映射回级别（contrib 越界会被夹到合法范围）。 */
function levelFromContrib(data, item, contrib) {
  const ml = maxLevelOf(data);
  const shift = data.scoreShift || 0;
  const cc = Math.max(shift, Math.min(ml + shift, Number(contrib)));
  return reverseSet(data).has(item) ? ml - (cc - shift) : cc - shift;
}

/** 内部级别 -> 得分（不含题号，正向；供导出等场景）。 */
export function levelScore(data, level) {
  const shift = data.scoreShift || 0;
  return Math.max(shift, Math.min(maxLevelOf(data) + shift, Number(level) + shift));
}

/** 得分 -> 内部级别（夹到合法范围）。 */
export function scoreToLevel(data, score) {
  const shift = data.scoreShift || 0;
  return Math.max(0, Math.min(maxLevelOf(data), Number(score) - shift));
}

/** 该因子是否「聚合项」（总分 / 总平均分，bind=[0]）。 */
function isAggregate(scale) {
  return scale.bind.length === 1 && scale.bind[0] === 0;
}

/** 某子量表的「目标度量」用的是均值还是总分。 */
function metricOf(scale) {
  return scale.bandMetric || 'mean';
}

/** 某子量表在当前答卷下的度量值（用于分级判定）。 */
function metricValue(data, scale, factors, total, totalMean) {
  if (isAggregate(scale)) {
    return scale.type === 'sum' ? total : totalMean;
  }
  const f = factors[scale.name];
  return metricOf(scale) === 'sum' ? f.raw : f.mean;
}

/**
 * 正向计分：各因子 = 所包含题项贡献分之和 / 均值，给出每个因子的度量值、
 * 总分、总均值，以及命中哪一段临床解释（bands）。
 * @param {number[]} answers 长度 data.nItems，元素为内部级别 0..L-1（缺失按 0）
 */
export function likertScore(data, answers) {
  const n = data.nItems;
  let totalRaw = 0;
  let positive = 0;
  for (let i = 0; i < n; i += 1) {
    const c = contribOf(data, i + 1, answers[i]);
    totalRaw += c;
    if (data.positiveScore && c >= data.positiveScore) positive += 1;
  }

  const factors = {};
  for (const f of data.scales) {
    if (isAggregate(f)) continue;
    let raw = 0;
    for (const it of f.bind) raw += contribOf(data, it, answers[it - 1]);
    factors[f.name] = { raw, mean: raw / f.bind.length, n: f.bind.length };
  }

  const total = totalRaw;
  const totalMean = totalRaw / n;

  const diagnoses = {};
  for (const f of data.scales) {
    diagnoses[f.name] = matchBand(f.bands, metricValue(data, f, factors, total, totalMean));
  }

  const out = { factors, total, totalMean, diagnoses };
  if (data.positiveScore) {
    out.positiveCount = positive;
    out.positiveRate = positive / n;
    out.positiveCutoff = data.positiveCutoff || 0;
  }
  return out;
}

/**
 * 反推作答：给定「子量表名 -> 目标度量值」求解一份答卷。
 * 各因子互不重叠，逐因子独立精确求解；未指定的因子默认答最低档。
 * 在贡献分空间里做均匀分配，再映射回级别（反向题自动取反）。
 */
export function likertSolve(data, targets = {}) {
  const n = data.nItems;
  const answers = new Array(n).fill(0); // 默认最低档
  const achieved = {};
  const requested = {};
  const shift = data.scoreShift || 0;
  const maxScore = maxLevelOf(data) + shift;

  for (const f of data.scales) {
    if (isAggregate(f)) continue;
    const name = f.name;
    const items = f.bind;
    const ni = items.length;
    const metricVal = targets[name];
    if (metricVal === undefined || metricVal === null) {
      achieved[name] = metricOf(f) === 'sum' ? 0 : shift;
      continue;
    }
    requested[name] = Number(metricVal);
    const targetSum = metricOf(f) === 'sum'
      ? Math.round(Number(metricVal))
      : Math.round(Number(metricVal) * ni);

    // 贡献分空间的均匀分配
    const base = Math.floor(targetSum / ni);
    const rem = targetSum - base * ni;
    items.forEach((it, k) => {
      const contrib = Math.max(shift, Math.min(maxScore, base + (k < rem ? 1 : 0)));
      answers[it - 1] = levelFromContrib(data, it, contrib);
    });
    const sum = items.reduce((s, it) => s + contribOf(data, it, answers[it - 1]), 0);
    achieved[name] = metricOf(f) === 'sum' ? sum : sum / ni;
  }

  return { answers, achieved, requested, feasible: true, nItems: n };
}

/**
 * 每道题在当前目标下的「可行级别区间」（0..L-1）。
 * 在贡献分空间里：单题贡献分 c 可行的充要条件是其余 n-1 题能凑出 S-c，即
 *     (n-1)·scoreMin ≤ S-c ≤ (n-1)·scoreMax
 * 再映射回级别（反向题自动取反）。未设目标的因子整段自由。
 * 返回数组下标 1..n（0 占位），每项 { lo, hi }。
 */
export function likertFeasibleBounds(data, targets = {}) {
  const n = data.nItems;
  const maxL = maxLevelOf(data);
  const bounds = new Array(n + 1);
  for (let i = 1; i <= n; i += 1) bounds[i] = { lo: 0, hi: maxL };

  const shift = data.scoreShift || 0;
  const scoreMin = shift;
  const scoreMax = maxL + shift;

  for (const f of data.scales) {
    if (isAggregate(f)) continue;
    const ni = f.bind.length;
    const metricVal = targets[f.name];
    if (metricVal === undefined || metricVal === null) continue;
    const sum = metricOf(f) === 'sum'
      ? Math.round(Number(metricVal))
      : Math.round(Number(metricVal) * ni);
    const loC = Math.max(scoreMin, sum - scoreMax * (ni - 1));
    const hiC = Math.min(scoreMax, sum - scoreMin * (ni - 1));
    for (const it of f.bind) {
      // 反向题的 levelFromContrib 单调递减：loC 映射出的是较大的级别，hiC 映射出的是较小的
      // 级别，直接赋值会得到 lo > hi，GUI 会退化成「只锁定一格」。这里统一成 lo <= hi。
      const a = levelFromContrib(data, it, loC);
      const b = levelFromContrib(data, it, hiC);
      bounds[it] = { lo: Math.min(a, b), hi: Math.max(a, b) };
    }
  }
  return bounds;
}

/**
 * 把某题设成指定级别，并在**同一子量表内**自动重分配其余题目，使该因子总分
 * （即目标度量值）保持不变。尽量少改动其它题：只把差额逐题 ±1 补上。
 * 在贡献分空间里做重平衡，再映射回级别（反向题自动取反）。
 * 若该题所属因子没有目标，则直接设值、不重分配。传入的 level 会被夹到可行区间。
 */
export function likertSetItemLevel(data, answers, targets, item, level) {
  const next = answers.slice();
  const factor = data.scales.find(
    (f) => !isAggregate(f) && f.bind.includes(item)
  );
  if (!factor) {
    next[item - 1] = Math.max(0, Math.min(maxLevelOf(data), Number(level)));
    return next;
  }
  const ni = factor.bind.length;
  const metricVal = targets ? targets[factor.name] : undefined;
  if (metricVal === undefined || metricVal === null) {
    next[item - 1] = Math.max(0, Math.min(maxLevelOf(data), Number(level)));
    return next;
  }
  const shift = data.scoreShift || 0;
  const scoreMin = shift;
  const scoreMax = maxLevelOf(data) + shift;
  const sum = metricOf(factor) === 'sum'
    ? Math.round(Number(metricVal))
    : Math.round(Number(metricVal) * ni);
  const loC = Math.max(scoreMin, sum - scoreMax * (ni - 1));
  const hiC = Math.min(scoreMax, sum - scoreMin * (ni - 1));
  next[item - 1] = levelFromContrib(data, item, Math.max(loC, Math.min(hiC, contribOf(data, item, level))));

  // 其余题目的贡献分补到 sum，尽量少改动（逐题 ±1）
  const others = factor.bind.filter((it) => it !== item);
  let total = factor.bind.reduce((s, it) => s + contribOf(data, it, next[it - 1]), 0);
  let idx = 0;
  let guard = others.length * 8 + 16;
  while (total !== sum && guard > 0) {
    const it = others[idx % others.length];
    if (total < sum && next[it - 1] < maxLevelOf(data)) {
      next[it - 1] += 1;
      total += reverseSet(data).has(it) ? -1 : 1;
    } else if (total > sum && next[it - 1] > 0) {
      next[it - 1] -= 1;
      total += reverseSet(data).has(it) ? 1 : -1;
    }
    idx += 1;
    guard -= 1;
  }
  return next;
}

/**
 * GUI 用：可设目标的子量表列表（不含聚合项），每个附「严重度预设」与
 * 全部可达度量值（供下拉直接选「正常 / 轻度 / 中度 / 偏重」或任意数值）。
 * presets 默认取各 band 的中点；若 data.presetMeans[bandCount] 存在则优先（SCL-90 用）。
 */
export function likertTargetScales(data) {
  const shift = data.scoreShift || 0;
  const maxScore = maxLevelOf(data) + shift;
  return data.scales
    .filter((f) => !isAggregate(f))
    .map((f) => {
      const ni = f.bind.length;
      const metric = metricOf(f);
      const minMetric = metric === 'sum' ? ni * shift : shift;
      const maxMetric = metric === 'sum' ? ni * maxScore : maxScore;
      const step = metric === 'sum' ? 1 : 1 / ni;
      const allValues = [];
      for (let v = minMetric; v <= maxMetric + 1e-9; v += step) {
        allValues.push(Number(v.toFixed(4)));
      }
      const presetTable = data.presetMeans ? data.presetMeans[f.bands.length] : null;
      const presets = f.bands.map((b, i) => ({
        label: b.severity,
        value: presetTable
          ? presetTable[i]
          : Number(((b.min + b.max) / 2).toFixed(4)),
      }));
      return {
        name: f.name,
        fullName: f.fullName,
        family: f.family,
        n: ni,
        metric,
        presets,
        allValues,
      };
    });
}

/** 解析答卷文本：支持「题号,得分」逐行，或紧凑的数字得分串（每位一题）。 */
export function likertParseAnswers(data, text) {
  const n = data.nItems;
  const shift = data.scoreShift || 0;
  const maxScore = maxLevelOf(data) + shift;
  const answers = new Array(n).fill(null);
  const unknown = [];
  let found = 0;

  const lines = String(text).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const looksTabular = lines.length > 1 || /[,，]/.test(text);
  if (looksTabular) {
    let idx = 0;
    for (const line of lines) {
      if (/题号|得分|程度|q|item|factor/i.test(line)) continue; // 跳过表头
      const parts = line.split(/[,，\t]+/).map((s) => s.trim()).filter(Boolean);
      const tok = parts.length >= 2 ? parts[1] : parts[0];
      const d = Number(tok);
      if (Number.isInteger(d) && idx < n) {
        if (d >= shift && d <= maxScore) {
          answers[idx] = scoreToLevel(data, d); // 得分 -> 级别
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
    if (d >= shift && d <= maxScore) {
      answers[i] = scoreToLevel(data, d);
      found += 1;
    } else {
      unknown.push(i + 1);
    }
  }
  return { answers, found, unknown };
}

/** 导出：题号 + 得分 + 程度，便于 Excel 打开。 */
export function likertExportCsv(data, answers) {
  const lines = ['题号,得分,程度'];
  for (let i = 0; i < data.nItems; i += 1) {
    const lvl = answers[i];
    const score = levelScore(data, lvl);
    const label = itemFormatDesc(data, i + 1).levels[lvl]?.label || '';
    lines.push(`${i + 1},${score},${label}`);
  }
  return lines.join('\r\n') + '\r\n';
}
