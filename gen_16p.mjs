import { writeFileSync, readFileSync } from 'fs';

const ROOT = 'C:/Users/wjz-s/Downloads/MMPI_2_Grader-master/MMPI_2_Grader-master';
const SRC = ROOT + '/MBTI_Test_16Personalities-main/src/data/questions.json';
const SRC_TYPES = ROOT + '/MBTI_Test_16Personalities-main/src/data/types.json';

const types = JSON.parse(readFileSync(SRC_TYPES, 'utf8'));
const q = JSON.parse(readFileSync(SRC, 'utf8'));

// 三模式阈值（与 16Personalities 项目 TestEngine 一致：quick=1, standard=3, full=5）
const THR = { quick: 1, standard: 3, full: 5 };

function build(name, arr, thr) {
  const itemOptions = arr.map((x) => [x.options[0].value, x.options[1].value]);
  const zh = arr.map((x) => x.text);
  const zhA = arr.map((x) => x.options[0].text);
  const zhB = arr.map((x) => x.options[1].text);
  return {
    id: 'mbti16p_' + name,
    name: '16personalities ' + name + '（' + arr.length + ' 题）',
    blurb: '选择目标人格类型，反推出一份能命中该类型的作答；或直接导入、编辑并评分。',
    nItems: arr.length,
    itemOptions,
    items: { zh, zhA, zhB },
    scales: [
      { name: 'EI', pair: ['E', 'I'], tieThreshold: thr },
      { name: 'SN', pair: ['S', 'N'], tieThreshold: thr },
      { name: 'TF', pair: ['T', 'F'], tieThreshold: thr },
      { name: 'JP', pair: ['J', 'P'], tieThreshold: thr },
    ],
    types,
  };
}

const mods = {
  quick: build('quick', q.quick, THR.quick),
  standard: build('standard', q.standard, THR.standard),
  full: build('full', q.full, THR.full),
};

for (const [k, v] of Object.entries(mods)) {
  const varName = 'MBTI16P_' + k.toUpperCase() + '_DATA';
  writeFileSync(
    'mbti_16p_' + k + '.data.js',
    '// AUTO-GENERATED from MBTI_Test_16Personalities-main/src/data/questions.json\n' +
    'import { MBTI_TYPES_16 } from "./mbti_types.js";\n\n' +
    'export const ' + varName + ' = ' + JSON.stringify(v, null, 2) + ';\n'
  );
}
console.log('generated:', Object.keys(mods).map((k) => k + ':' + mods[k].nItems).join('  '));
