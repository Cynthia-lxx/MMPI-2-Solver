import {
  likertScore, likertSolve, likertFeasibleBounds, likertSetItemLevel, likertTargetScales, likertParseAnswers, likertExportCsv,
} from './likert.js';
import { PHQ9_DATA } from './phq9.data.js';
import { GAD7_DATA } from './gad7.data.js';
import { HADS_DATA } from './hads.data.js';
import { WHO5_DATA } from './who5.data.js';

let pass = 0, fail = 0;
function ok(cond, msg, extra = '') {
  if (cond) { pass += 1; }
  else { fail += 1; console.log(`FAIL  ${msg}  ${extra}`); }
}
const approx = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

for (const [name, data] of [['PHQ-9', PHQ9_DATA], ['GAD-7', GAD7_DATA], ['HADS', HADS_DATA], ['WHO-5', WHO5_DATA]]) {
  // 求解一个典型目标，再正向计分应还原
  const ts = {};
  for (const s of likertTargetScales(data)) ts[s.name] = s.presets[1].value; // 取中段预设
  const r = likertSolve(data, ts);
  ok(r.answers.length === data.nItems, `${name} 求解长度正确`);
  const sc = likertScore(data, r.answers);
  for (const s of likertTargetScales(data)) {
    const got = sc.factors[s.name] ? (s.metric === 'sum' ? sc.factors[s.name].raw : sc.factors[s.name].mean)
      : (s.name === '总分' && s.bandMetric === 'sum' ? sc.total : sc.totalMean);
    const want = ts[s.name];
    ok(approx(got, want, 0.05), `${name} ${s.name} 达成≈目标`, `got=${got} want=${want}`);
  }
  // 全最低档 -> 正向题贡献 0；反向题（如 HADS 偶数抑郁题）贡献最大
  const zero = new Array(data.nItems).fill(0);
  const sz = likertScore(data, zero);
  const revCount = (data.reverse || []).length;
  const expectZero = revCount === 0 ? 0 : revCount * (data.formats.likert.levels.length - 1);
  ok(sz.total === expectZero, `${name} 全最低档总分正确`, `got=${sz.total} expect=${expectZero}`);
}

// HADS 反向计分：把第 2 题（反向）设到最高级别，抑郁子分应下降
{
  const r = likertSolve(HADS_DATA, { 抑郁: 10 });
  const before = likertScore(HADS_DATA, r.answers).factors['抑郁'].raw;
  // 第 2 题现在处于某级别，把它推到最高级（label 最大），贡献分应最小
  const lvl = 3;
  const next = likertSetItemLevel(HADS_DATA, r.answers, { 抑郁: 10 }, 2, lvl);
  const after = likertScore(HADS_DATA, next).factors['抑郁'].raw;
  ok(after <= before, 'HADS 反向题设最高级 -> 抑郁子分不升反降', `before=${before} after=${after}`);
}

// 可行区间 + 同因子守恒：PHQ-9 抑郁(总分)目标 20
{
  const r = likertSolve(PHQ9_DATA, { 总分: 20 });
  const b = likertFeasibleBounds(PHQ9_DATA, { 总分: 20 });
  ok(b.every((x) => x.lo >= 0 && x.hi <= 3), 'PHQ-9 目标 20 每题可行区间在 0..3');
  const next = likertSetItemLevel(PHQ9_DATA, r.answers, { 总分: 20 }, 1, 0);
  ok(likertScore(PHQ9_DATA, next).total === 20, '改一题后 PHQ-9 总分守恒', `${likertScore(PHQ9_DATA, next).total}`);
}

// 解析 / 导出
{
  const csv = likertExportCsv(PHQ9_DATA, new Array(9).fill(2));
  ok(csv.startsWith('题号,得分,程度'), 'PHQ-9 导出有表头');
  const parsed = likertParseAnswers(PHQ9_DATA, '111111111');
  ok(parsed.found === 9, 'PHQ-9 紧凑串解析 9 题');
}

console.log(fail === 0 ? `ALL OK (${pass} checks)` : `${fail} FAILURES, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
