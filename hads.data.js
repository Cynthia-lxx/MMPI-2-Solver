// AUTO-GENERATED-style data module for HADS (医院焦虑抑郁量表).
// Zigmond & Snaith (1983)。14 题，两个子量表（焦虑 7 题 / 抑郁 7 题），各 0–21。
// 抑郁子量表中偶数题为反向计分（data.reverse 标注），引擎在贡献分空间统一处理。
import { makeLikert } from './formats.js';

const HADS_FMT = makeLikert(4, ['完全没有', '有时', '经常', '绝大部分时间']);

export const HADS_DATA = {
  id: 'hads',
  name: 'HADS 焦虑抑郁量表',
  blurb: '分别选择焦虑、抑郁两个子量表的目标分，反推出 14 题作答；或直接导入、编辑并评分。',
  targetLabel: '目标子分',
  targetTableTitle: '子分达成',
  scoreShift: 0,
  nItems: 14,
  // 偶数抑郁题为反向计分
  reverse: [2, 4, 6, 8, 10, 12, 14],
  items: {
    zh: [
      '我感到紧张或焦虑不安',                 // 1 A
      '我仍像往常一样享受事物',             // 2 D (rev)
      '我有一种害怕的感觉，好像可怕的事要发生', // 3 A
      '我能笑并看到事物有趣的一面',         // 4 D (rev)
      '担忧的念头萦绕在脑中',               // 5 A
      '我感到愉快',                         // 6 D (rev)
      '我能安坐并感到放松',                 // 7 A
      '我感到自己好像变慢了',               // 8 D (rev)
      '我突然感到惊恐',                     // 9 A
      '我对自己的外表失去兴趣',             // 10 D (rev)
      '我感到坐立不安，必须走动',           // 11 A
      '我满怀期待地盼望事情',               // 12 D (rev)
      '我突然感到一阵恐慌',                 // 13 A
      '我能享受一本好书或广播/电视节目',    // 14 D (rev)
    ],
    en: [
      'I feel tense or wound up',
      'I still enjoy the things I used to enjoy',
      'I get a sort of frightened feeling as if something awful is about to happen',
      'I can laugh and see the funny side of things',
      'Worrying thoughts go through my mind',
      'I feel cheerful',
      'I can sit at ease and feel relaxed',
      'I feel as if I am slowed down',
      'I get a sort of frightened feeling like "butterflies" in the stomach',
      'I have lost interest in my appearance',
      'I feel restless as if I have to be on the move',
      'I look forward with enjoyment to things',
      'I get sudden feelings of panic',
      'I can enjoy a good book or radio or TV program',
    ],
    format: Array(14).fill('likert'),
  },
  formats: { likert: HADS_FMT },
  scales: [
    {
      name: '焦虑',
      fullName: 'HADS 焦虑子量表',
      family: 'anx',
      bind: [1, 3, 5, 7, 9, 11, 13],
      bandMetric: 'sum',
      bands: [
        { min: 0, max: 7, minInc: true, maxInc: true, severity: '正常' },
        { min: 8, max: 10, minInc: true, maxInc: true, severity: '轻度' },
        { min: 11, max: 14, minInc: true, maxInc: true, severity: '中度' },
        { min: 15, max: 21, minInc: true, maxInc: true, severity: '重度' },
      ],
    },
    {
      name: '抑郁',
      fullName: 'HADS 抑郁子量表',
      family: 'dep',
      bind: [2, 4, 6, 8, 10, 12, 14],
      bandMetric: 'sum',
      bands: [
        { min: 0, max: 7, minInc: true, maxInc: true, severity: '正常' },
        { min: 8, max: 10, minInc: true, maxInc: true, severity: '轻度' },
        { min: 11, max: 14, minInc: true, maxInc: true, severity: '中度' },
        { min: 15, max: 21, minInc: true, maxInc: true, severity: '重度' },
      ],
    },
    {
      name: '总分',
      fullName: 'HADS 总分',
      family: 'total',
      type: 'sum',
      bind: [0],
      bandMetric: 'sum',
      bands: [
        { min: 0, max: 14, minInc: true, maxInc: true, severity: '正常' },
        { min: 15, max: 21, minInc: true, maxInc: true, severity: '轻度' },
        { min: 22, max: 28, minInc: true, maxInc: true, severity: '中度' },
        { min: 29, max: 42, minInc: true, maxInc: true, severity: '重度' },
      ],
    },
  ],
};
