import { mbtiScore, mbtiSolve, mbtiParseAnswers, mbtiExportCsv, mbtiTargetTypes, mbtiScoreKnn } from './mbti.js';
import { MBTI93_DATA } from './mbti_93.data.js';
import { MBTI16P_FULL_DATA } from './mbti_16p_full.data.js';
import { MBTI200MD_DATA } from './mbti_200md.data.js';
import { MBTI16P60_DATA } from './mbti_16p60.data.js';
import { MBTI_TYPES_16 } from './mbti_types.js';

let pass = 0, fail = 0;
function ok(cond, msg, extra = '') {
  if (cond) { pass += 1; }
  else { fail += 1; console.log(`FAIL  ${msg}  ${extra}`); }
}

const data = MBTI93_DATA;
const TYPES = MBTI_TYPES_16.map((t) => t.id);

// 1) 反推：每个 16 型都应生成命中目标类型的作答
{
  let bad = 0;
  for (const t of TYPES) {
    const r = mbtiSolve(data, t);
    if (!r.feasible) { bad += 1; console.log('  infeasible:', t, '->', r.type); }
  }
  ok(bad === 0, `MBTI 16 型全部可反推命中`, `bad=${bad}`);
}

// 2) 正向评分往返：反推出的作答算回类型应一致
{
  const r = mbtiSolve(data, 'INTJ');
  const sc = mbtiScore(data, r.answers);
  ok(sc.type === 'INTJ', `反推 INTJ 回算一致`, `got=${sc.type}`);
}

// 3) 中间型 X 目标健壮性（93 题题本为奇数维、无中间型阈值，X 严格判定留待阶段3接入
//    full 200 题偶数维题本再覆盖；此处仅验证不抛错且产出合法类型结构）
{
  const r = mbtiSolve(data, 'INXJ');
  const sc = mbtiScore(data, r.answers);
  ok(sc.type.length === 4, `中间型目标 INXJ 生成合法类型`, `got=${sc.type}`);
}

// 4) 手工作答评分：构造一份「全选 A」看是否与题本极性分布吻合（只校验不抛错且长度为4）
{
  const r = mbtiSolve(data, 'INTJ');
  const sc = mbtiScore(data, r.answers);
  ok(sc.type.length === 4, `类型字符串长度为 4`);
}

// 5) 解析 / 导出
{
  const r = mbtiSolve(data, 'ENFP');
  const csv = mbtiExportCsv(data, r.answers);
  ok(csv.startsWith('题号,选项,字母'), `导出有表头`);
  const parsed = mbtiParseAnswers(data, r.answers.map((a) => a).join(''));
  ok(parsed.length === data.nItems, `解析长度正确`);
}

// 6) 目标类型列表
{
  const list = mbtiTargetTypes(data);
  ok(list.length === 16, `目标类型列表 16 项`, `got=${list.length}`);
}

// 7) 16personalities full(200) 16 型反推可行
{
  let bad = 0;
  for (const t of TYPES) {
    const r = mbtiSolve(MBTI16P_FULL_DATA, t);
    if (!r.feasible) { bad += 1; console.log('  full infeasible:', t, '->', r.type); }
  }
  ok(bad === 0, `full 200 题 16 型全部可反推命中`, `bad=${bad}`);
}

// 8) 中间型 X：full 200 题（每维 50 偶数，阈值 5）应判 X
//    'IXXJ' 按 EI/SN/TF/JP 顺序解析为 EI=I, SN=X, TF=X, JP=J
{
  const r = mbtiSolve(MBTI16P_FULL_DATA, 'IXXJ');
  const sc = mbtiScore(MBTI16P_FULL_DATA, r.answers);
  ok(sc.type === 'IXXJ', `full 中间型目标 IXXJ 命中`, `got=${sc.type}`);
  ok(sc.dims.SN.letter === 'X', `full SN 维判为中间型 X`, `got=${sc.dims.SN.letter}`);
  ok(sc.dims.TF.letter === 'X', `full TF 维判为中间型 X`, `got=${sc.dims.TF.letter}`);
}

// 9) 200 题 md 库：16 型反推可行 + 中间型
{
  let bad = 0;
  for (const t of TYPES) {
    const r = mbtiSolve(MBTI200MD_DATA, t);
    if (!r.feasible) { bad += 1; console.log('  200md infeasible:', t, '->', r.type); }
  }
  ok(bad === 0, `200 题 md 16 型全部可反推命中`, `bad=${bad}`);
  const r = mbtiSolve(MBTI200MD_DATA, 'IXXJ');
  const sc = mbtiScore(MBTI200MD_DATA, r.answers);
  ok(sc.type === 'IXXJ', `200md 中间型目标 IXXJ 命中`, `got=${sc.type}`);
}

// 10) 16personalities 60 题（④）：查表反推（随机）+ KNN 正向评分
{
  // 查表反推：16 型全部命中且 fromSample=true；固定 rng 保证可复现
  let bad = 0;
  for (const t of TYPES) {
    const r = mbtiSolve(MBTI16P60_DATA, t, { rng: () => 0.37 });
    if (!r.feasible || !r.fromSample || r.type !== t) bad += 1;
  }
  ok(bad === 0, `16p60 查表反推 16 型全部命中`, `bad=${bad}`);

  // KNN 正向评分：train/test split 准确率应 >90%（faithful 归类，复刻原 KNN 仓库）
  const all = MBTI16P60_DATA.samples;
  const trainData = { scales: MBTI16P60_DATA.scales, samples: all.slice(500) };
  const test = all.slice(0, 500);
  let okc = 0;
  for (const s of test) {
    const r = mbtiScoreKnn(trainData, s.ans);
    if (r.type === s.label) okc += 1;
  }
  const acc = okc / test.length;
  ok(acc > 0.9, `16p60 KNN 正向评分准确率 >90%`, `acc=${(100 * acc).toFixed(1)}%`);
}

console.log(fail === 0 ? `ALL OK (${pass} checks)` : `${fail} FAILURES, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
