import { SCL90_DATA } from './scl90.data.js';
import {
  scl90Score,
  scl90Solve,
  scl90TargetScales,
  scl90ParseAnswers,
  scl90ExportCsv,
  levelToScore,
} from './scl90.js';

let fails = 0;
const ok = (cond, label, extra = '') => {
  if (!cond) fails += 1;
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

// 1) 全「没有」：均值 1，总分 90，阳性 0
{
  const ans = new Array(90).fill(0);
  const s = scl90Score(ans);
  ok(s.total === 90, '全没有 → 总分 90', `${s.total}`);
  ok(s.positiveCount === 0, '全没有 → 阳性项目 0', `${s.positiveCount}`);
  ok(Math.abs(s.factors['躯体化'].mean - 1) < 1e-9, '全没有 → 躯体化均值 1');
  ok(s.diagnoses['躯体化']?.severity === '正常', '全没有 → 躯体化解释「正常」');
}

// 2) 全「严重」：均值 5，总分 450，阳性 90
{
  const ans = new Array(90).fill(4);
  const s = scl90Score(ans);
  ok(s.total === 450, '全严重 → 总分 450', `${s.total}`);
  ok(s.positiveCount === 90, '全严重 → 阳性项目 90', `${s.positiveCount}`);
  ok(Math.abs(s.totalMean - 5) < 1e-9, '全严重 → 总平均分 5');
  ok(s.diagnoses['总分']?.severity !== '正常', '全严重 → 总分解释非健康', `${s.diagnoses['总分']?.severity}`);
}

// 3) 反推单因子：躯体化目标均值 3.5
{
  const targets = { 躯体化: 3.5 };
  const r = scl90Solve(targets);
  ok(r.feasible, '躯体化 3.5 可解');
  const got = r.achieved['躯体化'];
  ok(Math.abs(got - 3.5) < 1e-6, '躯体化达成均值 = 3.5', `${got}`);
  // 计分回读一致
  const score = scl90Score(r.answers);
  ok(Math.abs(score.factors['躯体化'].mean - 3.5) < 1e-6, '计分回读吻合', `${score.factors['躯体化'].mean}`);
  // 仅躯体化被改动，其他因子仍为正常(1)
  ok(Math.abs(score.factors['强迫症状'].mean - 1) < 1e-9, '未指定因子保持正常', `${score.factors['强迫症状'].mean}`);
}

// 4) 反推多因子，逐个核对
{
  const targets = { 躯体化: 2.5, 抑郁: 4.2, 焦虑: 1.4, 其他: 3.5 };
  const r = scl90Solve(targets);
  const score = scl90Score(r.answers);
  for (const [name, m] of Object.entries(targets)) {
    const got = score.factors[name].mean;
    // 整数总分约束下，可达成均值与目标的偏差不超过 0.5/题数
    ok(Math.abs(got - m) <= 0.08, `${name} 达成均值`, `${got} vs ${m}`);
  }
  // 因子互不重叠：各因子题数之和 = 90
  const covered = SCL90_DATA.scales.filter((f) => !(f.bind.length === 1 && f.bind[0] === 0))
    .reduce((s, f) => s + f.bind.length, 0);
  ok(covered === 90, '10 个因子题数之和 = 90（不重不漏）', `${covered}`);
}

// 5) 解析 / 导出 往返
{
  const r = scl90Solve({ 敌对: 4.5 });
  const csv = scl90ExportCsv(r.answers);
  const parsed = scl90ParseAnswers(csv);
  ok(parsed.found >= 80, '从导出 csv 回读题目数', `${parsed.found}`);
  // 回读后敌对均值仍高
  const score = scl90Score(parsed.answers);
  ok(score.factors['敌对'].mean >= 4, '回读后敌对仍偏高', `${score.factors['敌对'].mean}`);
  // 紧凑数字串解析
  const compact = r.answers.map((l) => String(levelToScore(l))).join('');
  const p2 = scl90ParseAnswers(compact);
  ok(p2.found === 90 && p2.unknown.length === 0, '紧凑得分串解析 90 题', `${p2.found}`);
}

// 6) 目标预设可用
{
  const ts = scl90TargetScales();
  ok(ts.length === 10, '可设目标因子 = 10（9 临床 + 其他）', `${ts.length}`);
  ok(ts[0].presets.length === 3, '躯体化有 3 段预设', `${ts[0].presets.map((p) => p.label).join('/')}`);
}

console.log(`\n${fails === 0 ? 'ALL OK' : fails + ' FAILURES'}`);
process.exit(fails === 0 ? 0 : 1);
