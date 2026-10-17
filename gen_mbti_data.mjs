import { writeFileSync, readFileSync } from 'fs';

const ROOT = 'C:/Users/wjz-s/Downloads/MMPI_2_Grader-master/MMPI_2_Grader-master';
const SRC_TYPES = ROOT + '/MBTI_Test_16Personalities-main/src/data/types.json';
const SRC_Q = ROOT + '/MBTI-master/data/questions.json';

// 16 型档案（来自 16Personalities 项目，含类别/别名/特质等）
const types = JSON.parse(readFileSync(SRC_TYPES, 'utf8'));
writeFileSync(
  'mbti_types.js',
  '// AUTO-GENERATED from MBTI_Test_16Personalities-main/src/data/types.json\n' +
  'export const MBTI_TYPES_16 = ' + JSON.stringify(types, null, 2) + ';\n'
);

// 93 题 MBTI 职业测试（来自 MBTI-master/data/questions.json）
const q = JSON.parse(readFileSync(SRC_Q, 'utf8'));
const itemOptions = q.map((x) => [x.choice_a.value, x.choice_b.value]);
const zh = q.map((x) => x.question);
const zhA = q.map((x) => x.choice_a.text);
const zhB = q.map((x) => x.choice_b.text);
const data = {
  id: 'mbti93',
  name: 'MBTI 职业性格测试（93 题）',
  blurb: '选择目标人格类型，反推出一份能命中该类型的作答；或直接导入、编辑并评分。',
  nItems: q.length,
  itemOptions,
  items: { zh, zhA, zhB },
  scales: [
    { name: 'EI', pair: ['E', 'I'], tieThreshold: 0 },
    { name: 'SN', pair: ['S', 'N'], tieThreshold: 0 },
    { name: 'TF', pair: ['T', 'F'], tieThreshold: 0 },
    { name: 'JP', pair: ['J', 'P'], tieThreshold: 0 },
  ],
  types,
};
writeFileSync(
  'mbti_93.data.js',
  '// AUTO-GENERATED from MBTI-master/data/questions.json + 16Personalities types.json\n' +
  'export const MBTI93_DATA = ' + JSON.stringify(data, null, 2) + ';\n'
);

console.log('generated mbti_types.js (',
  types.length, 'types) and mbti_93.data.js (', q.length, 'items)');
