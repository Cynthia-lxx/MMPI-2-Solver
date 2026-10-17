// AUTO-GENERATED-style data module for PHQ-9 (抑郁症筛查量表).
// 题项与计分依据 Kroenke 等 (2001)；纯求和量表，得分 0–3，总分 0–27。
import { makeLikert } from './formats.js';

const PHQ9_FMT = makeLikert(4, ['完全不会', '好几天', '一半以上的天数', '几乎每天']);
const PHQ9_FMTS = Array(9).fill('likert');

export const PHQ9_DATA = {
  id: 'phq9',
  name: 'PHQ-9 抑郁症筛查量表',
  blurb: '选择目标总分，反推出一份 9 题作答；或直接导入、编辑并评分。',
  targetLabel: '目标得分',
  targetTableTitle: '得分达成',
  scoreShift: 0,
  nItems: 9,
  items: {
    zh: [
      '做事时提不起劲或没有兴趣',
      '感到心情低落、沮丧或绝望',
      '入睡困难、睡不安稳或睡眠过多',
      '感觉疲倦或没有活力',
      '食欲不振或吃太多',
      '对自己感到失望，或觉得自己很失败，或让自己/家人失望',
      '注意力难以集中，例如看电视或看报纸时',
      '行动或说话明显变慢，或坐立不安、比平时动得更厉害',
      '有不如死掉或用某种方式伤害自己的念头',
    ],
    en: [
      'Little interest or pleasure in doing things',
      'Feeling down, depressed, or hopeless',
      'Trouble falling or staying asleep, or sleeping too much',
      'Feeling tired or having little energy',
      'Poor appetite or overeating',
      'Feeling bad about yourself — or that you are a failure or have let yourself or your family down',
      'Trouble concentrating on things, such as reading the newspaper or watching television',
      'Moving or speaking so slowly that other people could have noticed — or being so fidgety or restless that you have been moving around a lot more than usual',
      'Thoughts that you would be better off dead, or of hurting yourself',
    ],
    format: PHQ9_FMTS,
  },
  formats: { likert: PHQ9_FMT },
  scales: [
    {
      name: '总分',
      fullName: 'PHQ-9 总分',
      family: 'dep',
      bind: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      bandMetric: 'sum',
      bands: [
        { min: 0, max: 4, minInc: true, maxInc: true, severity: '无/极轻微' },
        { min: 5, max: 9, minInc: true, maxInc: true, severity: '轻度' },
        { min: 10, max: 14, minInc: true, maxInc: true, severity: '中度' },
        { min: 15, max: 19, minInc: true, maxInc: true, severity: '偏重' },
        { min: 20, max: 27, minInc: true, maxInc: true, severity: '重度' },
      ],
    },
  ],
  note: '第 9 题（自杀念头）> 0 时，临床上须评估自伤/自杀风险。',
};
