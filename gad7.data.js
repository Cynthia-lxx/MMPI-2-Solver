// AUTO-GENERATED-style data module for GAD-7 (广泛性焦虑筛查量表).
// 题项与计分依据 Spitzer 等 (2006)；纯求和量表，得分 0–3，总分 0–21。
import { makeLikert } from './formats.js';

const GAD7_FMT = makeLikert(4, ['完全不会', '好几天', '一半以上的天数', '几乎每天']);
const GAD7_FMTS = Array(7).fill('likert');

export const GAD7_DATA = {
  id: 'gad7',
  name: 'GAD-7 焦虑筛查量表',
  blurb: '选择目标总分，反推出一份 7 题作答；或直接导入、编辑并评分。',
  targetLabel: '目标得分',
  targetTableTitle: '得分达成',
  scoreShift: 0,
  nItems: 7,
  items: {
    zh: [
      '感到紧张、焦虑或急切',
      '不能停止或控制担忧',
      '对各种各样的事情担忧过多',
      '很难放松下来',
      '坐立不安，难以静坐',
      '变得容易烦恼或易怒',
      '感到害怕，好像将有可怕的事情发生',
    ],
    en: [
      'Feeling nervous, anxious, or on edge',
      'Not being able to stop or control worrying',
      'Worrying too much about different things',
      'Trouble relaxing',
      'Being so restless that it is hard to sit still',
      'Becoming easily annoyed or irritable',
      'Feeling afraid as if something awful might happen',
    ],
    format: GAD7_FMTS,
  },
  formats: { likert: GAD7_FMT },
  scales: [
    {
      name: '总分',
      fullName: 'GAD-7 总分',
      family: 'anx',
      bind: [1, 2, 3, 4, 5, 6, 7],
      bandMetric: 'sum',
      bands: [
        { min: 0, max: 4, minInc: true, maxInc: true, severity: '无/极轻微' },
        { min: 5, max: 9, minInc: true, maxInc: true, severity: '轻度' },
        { min: 10, max: 14, minInc: true, maxInc: true, severity: '中度' },
        { min: 15, max: 21, minInc: true, maxInc: true, severity: '重度' },
      ],
    },
  ],
  note: 'GAD-7 ≥ 10 提示需要进一步焦虑评估。',
};
