/**
 * 多作答格式（TF / Likert / Choice）泛化引擎的测试。
 * 用一个合成的迷你数据集验证：
 *  - formats.js 的工厂与 helper；
 *  - 权重表计分对 TF / Likert / Choice 都正确；
 *  - InverseModel + solve 能在多级量表上求解目标（_nextLevel 枚举级别有效）。
 */
import { FORMATS, makeLikert, makeChoice, levelCount, coerceLevel, itemFormat }
  from './formats.js';
import { InverseModel, solve } from './inverse.js';

let failures = 0;
function check(cond, msg, extra) {
  if (cond) {
    console.log(`  ok  ${msg}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${msg}${extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''}`);
  }
}

/* ---- 1. formats 注册表与 helper -------------------------------------- */
console.log('formats:');
check(makeLikert(5).levels.length === 5, 'makeLikert(5) 有 5 个级别');
check(makeLikert(5).levels[0].label === '完全不符合', 'Likert 默认首级标签');
check(makeChoice(['是', '否']).levels.length === 2, 'makeChoice 有 2 个选项');
check(levelCount(FORMATS.tf) === 2, 'TF 为 2 级');
check(coerceLevel(FORMATS.tf, null) === null, 'coerceLevel(null) -> null');
check(coerceLevel(FORMATS.tf, true) === 1 && coerceLevel(FORMATS.tf, false) === 0, '布尔转 1/0');
check(coerceLevel(FORMATS.tf, 3) === 3, '数字原样');
check(itemFormat({}, 5) === 'tf', '缺省格式为 tf');

/* ---- 2. 合成数据集：TF + Likert + Choice --------------------------- */
const likert3 = makeLikert(3); // 0,1,2
const choice2 = makeChoice(['否', '是']); // 0,1
const data = {
  nItems: 6,
  nScales: 3,
  items: { en: Array(6).fill('q'), zh: Array(6).fill('题') },
  // 题 1-3 为 TF；4-5 为 3 级 Likert；6 为 2 选 1
  formats: { likert3, choice2 },
  formatArr: ['tf', 'tf', 'tf', 'likert3', 'likert3', 'choice2'],
  scales: [
    { flat: 0, family: 0, y: 0, name: 'A', fullName: 'A', kind: 'keyed', p: 0 },
    {
      flat: 1, family: 1, y: 0, name: 'L1', fullName: 'L1', kind: 'keyed', p: 0,
      weights: { 4: [0, 1, 2], 5: [0, 1, 2] },
    },
    {
      flat: 2, family: 1, y: 1, name: 'C1', fullName: 'C1', kind: 'keyed', p: 1,
      weights: { 6: [0, 1] },
    },
  ],
  kCorrections: {},
  reachable: {
    male: {
      A: { values: [0, 1, 2, 3] },
      L1: { values: [0, 1, 2, 3, 4, 5, 6] },
      C1: { values: [0, 1] },
    },
    female: {
      A: { values: [0, 1, 2, 3] },
      L1: { values: [0, 1, 2, 3, 4, 5, 6] },
      C1: { values: [0, 1] },
    },
  },
  response: { vrinPairs: [], vrinExpected: [], truePairs: [], falsePairs: [] },
  male: {
    keys: [
      [[1, 2], [3]], // family 0: A 的 T 键题 [1,2]、F 键题 [3]
      [[], [], [], []], // family 1: L1/C1 用 weights，keys 留空
      [], [], [], // family 2-4 占位（scoreAnswers 依赖 totals[4] 插入 VRIN/TRIN）
    ],
    tables: [
      [[0, 10, 20, 30]], // family 0: [A 表]，tables[family][y] 为「按原始分索引」的一维 T 数组
      [ // family 1: [L1 表, C1 表]
        [0, 10, 20, 30, 40, 50, 60], // L1: raw4 -> T40
        [0, 10], // C1: raw1 -> T10
      ],
      [], [], [], // family 2-4 占位
    ],
  },
  female: null,
};
data.items.format = data.formatArr;

console.log('计分（权重表，经 InverseModel）：');
const answers = [1, 1, 0, 2, 1, 1]; // item1-3 TF(T,T,F); item4-5 likert(2,1); item6 choice(是)
// scoreAnswers 的 VRIN/TRIN 处理逻辑与真实 MMPI 的 family4 布局耦合，无法喂入极简合成数据；
// 泛化计分核心在 InverseModel（求解器也用它），由它验证即可（真实 MMPI 上的 scoreAnswers 一致性已由 test-inverse/test-gui 覆盖）。
const m = new InverseModel(data, { isMale: true });
m.reset(answers);
check(m.rawByName.A === 3, 'TF 量表 A 原始分 = #T键真 + #F键假 = 3', m.rawByName.A);
check(m.rawByName.L1 === 3, 'Likert 量表 L1 = 2 + 1 = 3', m.rawByName.L1);
check(m.rawByName.C1 === 1, 'Choice 量表 C1 = 选项「是」计 1', m.rawByName.C1);

console.log('求解（多级量表目标）：');
const plan = solve({ L1: 40 }, { data, isMale: true, seed: 1 });
check(plan !== null, 'solve 返回方案');
check(plan && plan.achieved.L1 === 40, 'L1 达成 T = 40', plan && plan.achieved.L1);
// 用模型复算原始分，确认 Likert 目标 40 对应原始分 4
const m2 = new InverseModel(data, { isMale: true });
m2.reset(plan.answers);
check(m2.rawByName.L1 === 4, 'Likert 目标 40 对应原始分 4 已达成', m2.rawByName.L1);
// 多级题被解成合法级别
const a4 = plan.answers[3]; // item4（0-based 3）
check(a4 === 0 || a4 === 1 || a4 === 2, 'item4 解为合法 Likert 级别', a4);

console.log(`\n${failures === 0 ? 'ALL OK' : failures + ' FAILURES'}`);
process.exit(failures === 0 ? 0 : 1);
