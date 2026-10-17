// AUTO-GENERATED-style data module for WHO-5 (主观幸福感指数).
// 5 题，0–5 六级，总分 0–25（常换算为 0–100 指数 = 总分×4）。纯求和量表。
import { makeLikert } from './formats.js';

const WHO5_FMT = makeLikert(6, ['完全不符合', '很少', '有时', '约一半', '经常', '完全符合']);
const WHO5_FMTS = Array(5).fill('likert');

export const WHO5_DATA = {
  id: 'who5',
  name: 'WHO-5 主观幸福感量表',
  blurb: '选择目标总分，反推出一份 5 题作答；或直接导入、编辑并评分。',
  targetLabel: '目标得分',
  targetTableTitle: '得分达成',
  scoreShift: 0,
  nItems: 5,
  items: {
    zh: [
      '我感到积极乐观',
      '我感到平静放松',
      '我感到活跃有精力',
      '我醒来时精神饱满',
      '我的日常生活充满兴趣',
    ],
    en: [
      'I have felt cheerful and in good spirits',
      'I have felt calm and relaxed',
      'I have felt active and vigorous',
      'I woke up feeling fresh and rested',
      'My daily life has been filled with things that interest me',
    ],
    format: WHO5_FMTS,
  },
  formats: { likert: WHO5_FMT },
  scales: [
    {
      name: '总分',
      fullName: 'WHO-5 总分',
      family: 'well',
      bind: [1, 2, 3, 4, 5],
      bandMetric: 'sum',
      bands: [
        { min: 0, max: 8, minInc: true, maxInc: true, severity: '很差' },
        { min: 9, max: 17, minInc: true, maxInc: true, severity: '一般' },
        { min: 18, max: 25, minInc: true, maxInc: true, severity: '良好' },
      ],
    },
  ],
  note: 'WHO-5 指数 = 总分 × 4（0–100）；≤50 提示幸福感下降，≤28 为很差。',
};
