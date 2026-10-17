/**
 * 与视觉设计强耦合的 UX 文案与动效参数，集中在此「宏常量」里。
 *
 * 目的：换配色 / 调字号 / 改动效速度时只改这一处，界面文案与实际样式不再失配
 * （例如自由题框换成另一种颜色后，提示文案里的颜色词会自动跟着变）。
 *
 * 生效方式：
 *  - 构建时 build-site.mjs 会读取本文件，把 index.src.html 里的双花括号占位符
 *    替换成这里 UI_TEXT / THEME 的值；
 *  - 同时把 ANIM 生成为 :root 下的 CSS 自定义属性（--anim-* / --ease-out），
 *    CSS 动画全部走 var(--anim-*) 引用，调 --anim-scale 即可整体加减速；
 *  - gui.js 也直接引用 UI_TEXT，保证运行时写入的文案与静态 HTML 同源。
 */

export const THEME = {
  /** 自由题虚线框：对应 --free（当前为玫瑰粉 #c98aa6） */
  freeColorName: '粉色',
  /** 区间内可翻转虚线框：对应 --accent（当前为品牌蓝 #2f6fb3） */
  slackColorName: '蓝色',
  /** 滑轨上的可行区间框：对应 .slide-mark 的白色描边 */
  slideFrameName: '白框',
  /** 剖面阈值色：对应 --warn / --bad */
  warnColorName: '橙色',
  badColorName: '红色',
};

export const UI_TEXT = {
  /** MMPI（二值作答）答案区图例 */
  mmpiAnswerHint:
    `${THEME.freeColorName}虚线框为「自由题」：翻转它不会改变任何目标量表的分数，点击即可切换；` +
    `${THEME.slackColorName}虚线框为「区间内可翻转」——它会改动目标量表，但翻过去后目标仍落在区间内，只能一道一道改；` +
    '实线框为锁定题，翻转会破坏目标（悬停可看它影响哪些量表）。',

  /** SCL-90 滑轨提示（左栏区间求解面板） */
  scl90Hint:
    `滑轨按选项分块，${THEME.slideFrameName}标出该题在当前目标下的可行区间；` +
    '拖动会在同因子内自动调平，使目标均分保持不变。也可以点「生成答卷」精确求解。',

  /** 多级作答（Likert / Choice）答案区图例 */
  likertAnswerHint:
    `滑轨按选项分块；${THEME.slideFrameName}是该题在当前目标下的可行区间（框越窄越受限，只剩一格即锁定）。` +
    '拖动会在同因子内自动调平，目标均分保持不变；也可点选滑轨或用方向键微调。',

  /** MMPI 剖面折叠标题（阈值配色） */
  profileSummaryMmpi:
    `完整剖面（87 个量表，${THEME.warnColorName} ≥ 65、${THEME.badColorName} ≥ 80）`,
};

export const ANIM = {
  /** 全局动效速度因子：1=基准，>1 整体更慢，<1 整体更快（会生成 --anim-scale） */
  scale: 1,
  /** 各档时长，构建时生成 calc(<时长> * var(--anim-scale)) */
  durations: {
    fast: '.12s',
    xfast: '.14s',
    hover: '.18s',
    med: '.3s',
    pop: '.32s',
    in: '.35s',
    slow: '.5s',
    slower: '.55s',
  },
  /** 统一缓动曲线 */
  easeOut: 'cubic-bezier(.2, .7, .3, 1)',
};
