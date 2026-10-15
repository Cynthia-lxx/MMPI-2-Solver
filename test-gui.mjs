/**
 * Node smoke test for the GUI core (the DOM-free half of gui.js).
 *
 *   node web/test-gui.mjs
 *
 * Checks what the page promises the user:
 *   - targets are met, or residuals are reported
 *   - items marked "free" really can be flipped without moving a target
 *   - items marked "locked" really do move one
 *   - exports round-trip through the Python grader's CSV format
 */

import { MMPI2_DATA as DATA } from './data.js';
import {
  planSheet,
  randomizeFree,
  randomizeWithinBounds,
  answersToCsv,
  answersToCompact,
  parseBulkTargets,
  combinationLabel,
  reachableValuesFor,
  startSheet,
  formatTarget,
  convertTargets,
  analyseFreedom,
  EXAMPLE_TARGETS,
} from './gui.js';
import { scoreAnswers, InverseModel, nearestReachable, distanceOutside } from './inverse.js';

let failures = 0;
const check = (ok, label, extra = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

/* 1. a small profile -------------------------------------------------- */
{
  const plan = planSheet({ targets: { Hs: 70, Sc: 81 }, isMale: true, seed: 1 });
  check(plan.feasible, 'Hs=70 + Sc=81 可行', `loss=${plan.loss}`);
  check(plan.achieved.Hs === 70 && plan.achieved.Sc === 81, '达成值等于目标');
  check(plan.answers.length === 567, '答卷长度 567', `${plan.answers.length}`);
  check(
    plan.freeItems.length + plan.lockedItems.length === 567,
    '自由题 + 锁定题 = 567',
    `free=${plan.freeItems.length}`
  );
}

/* 2. free items really are free, locked items really are not ------------ */
{
  const targets = { Hs: 81, D: 80, Hy: 79, Pd: 79, Pa: 79, Pt: 81, Sc: 81, Ma: 81 };
  const plan = planSheet({ targets, isMale: true, seed: 3 });
  check(plan.feasible, '8 个临床量表同时可行', `loss=${plan.loss}`);

  const model = new InverseModel(DATA, { isMale: true });
  model.reset(plan.answers);
  const before = Object.fromEntries(Object.keys(targets).map((n) => [n, model.byName()[n]]));

  let brokeFree = 0;
  for (const item of plan.freeItems) {
    const answers = plan.answers.slice();
    answers[item - 1] = !answers[item - 1];
    const after = scoreAnswers(answers, { isMale: true }).byName;
    if (Object.keys(targets).some((n) => after[n] !== before[n])) brokeFree += 1;
  }
  check(brokeFree === 0, '全部自由题翻转后目标不变', `violations=${brokeFree}`);

  // Locked items are locked *structurally* (they key into a targeted scale),
  // which is what makes the 2 ** n combination count valid.  A single flip
  // may still land on a plateau and leave the T score unchanged, so the
  // assertion is on the reason, not on the observed T score.
  let noReason = 0;
  for (const item of plan.lockedItems) if (!plan.lockReason.get(item).length) noReason += 1;
  check(noReason === 0, '全部锁定题都有锁定原因', `missing=${noReason}`);

  let wrongFree = 0;
  for (const item of plan.freeItems) if (plan.lockReason.has(item)) wrongFree += 1;
  check(wrongFree === 0, '自由题没有锁定原因');

  // and the other direction: every locked item really does key into a target
  const model2 = new InverseModel(DATA, { isMale: true });
  model2.reset(plan.answers);
  const watched = new Set(Object.keys(targets).map((n) => model2.nameToFlat.get(n)));
  let mislabelled = 0;
  for (const item of plan.lockedItems) {
    const direct = model2.byItem[item].some(
      ([flat]) => watched.has(flat) || (flat === model2.kFlat && model2.itemLocks)
    );
    if (!direct && !plan.lockReason.get(item).some((r) => r === 'VRIN' || r === 'TRIN')) {
      mislabelled += 1;
    }
  }
  check(mislabelled === 0, '锁定题确实键入了目标量表', `mislabelled=${mislabelled}`);

  const randomized = randomizeFree(plan.answers, plan.freeItems, 7);
  const afterRandom = scoreAnswers(randomized, { isMale: true }).byName;
  check(
    Object.keys(targets).every((n) => afterRandom[n] === before[n]),
    '随机化自由题后目标仍成立'
  );
  check(
    randomized.some((v, i) => v !== plan.answers[i]),
    '随机化确实改动了答案'
  );
}

/* 3. K-corrected scale: K items must be locked ------------------------- */
{
  const plan = planSheet({ targets: { Hs: 70 }, isMale: true, seed: 5, iterations: 60000 });
  check(plan.feasible, '单个 K 校正量表 Hs=70 可行');
  const kItems = DATA.male.keys[0][2 * 2].concat(DATA.male.keys[0][2 * 2 + 1]);
  const kFree = kItems.filter((i) => plan.freedom[i]).length;
  check(kFree === 0, 'Hs 为目标时 K 量表题目全部锁定', `kFree=${kFree}/${kItems.length}`);
}

/* 4. VRIN / TRIN targeting, both formulas ------------------------------ */
for (const correctInconsistency of [true, false]) {
  const mode = correctInconsistency ? '修正' : '原程序';
  const vrinValues = reachableValuesFor('VRIN', true, correctInconsistency);
  const trinValues = reachableValuesFor('TRIN', true, correctInconsistency);
  // middle of whatever this formula can actually produce
  const vrinWant = vrinValues[Math.floor(vrinValues.length / 2)];
  const trinWant = trinValues[Math.floor(trinValues.length / 2)];

  const vrin = planSheet({
    targets: { VRIN: vrinWant }, isMale: true, correctInconsistency, seed: 11, iterations: 80000,
  });
  check(vrin.achieved.VRIN === vrinWant, `VRIN=${vrinWant} 可达（${mode}）`, `got=${vrin.achieved.VRIN}`);
  const pairs = DATA.response.vrinPairs;
  const pairFree = pairs.filter((i) => vrin.freedom[i]).length;
  check(pairFree === 0, `VRIN 为目标时配对题全部锁定（${mode}）`, `free=${pairFree}/${pairs.length}`);

  const trin = planSheet({
    targets: { TRIN: trinWant }, isMale: true, correctInconsistency, seed: 12, iterations: 80000,
  });
  check(trin.achieved.TRIN === trinWant, `TRIN=${trinWant} 可达（${mode}）`, `got=${trin.achieved.TRIN}`);
  const trinPairs = DATA.response.truePairs.concat(DATA.response.falsePairs);
  const trinFree = trinPairs.filter((i) => trin.freedom[i]).length;
  check(trinFree === 0, `TRIN 为目标时配对题全部锁定（${mode}）`, `free=${trinFree}/${trinPairs.length}`);

  // and the values the formula cannot produce are not silently accepted
  const impossible = DATA.reachable.male.VRIN.values.find((v) => !vrinValues.includes(v));
  if (impossible !== undefined) {
    const snapped = planSheet({
      targets: { VRIN: impossible }, isMale: true, correctInconsistency, seed: 13, iterations: 40000,
    });
    check(
      snapped.target.VRIN !== impossible && vrinValues.includes(snapped.target.VRIN),
      `VRIN=${impossible}（${mode} 不可达）被折算`,
      `-> ${snapped.target.VRIN}`
    );
  }
}

/* 5. exports ----------------------------------------------------------- */
{
  const plan = planSheet({ targets: { Si: 65 }, isMale: false, seed: 2, iterations: 60000 });
  check(plan.feasible, '女性 Si=65 可行');
  const csv = answersToCsv(plan.answers, { isMale: false, lastName: 'Doe', firstName: 'Jane' });
  const lines = csv.trimEnd().split('\r\n');
  check(lines.length === 569, 'CSV 569 行', `${lines.length}`);
  check(lines[0] === 'Doe,Jane,,', 'CSV 表头');
  check(lines[1] === 'Female', 'CSV 性别行');
  check(
    lines.slice(2).every((l) => l === 'True' || l === 'False'),
    'CSV 答案行合法'
  );
  const compact = answersToCompact(plan.answers);
  check(/^[TF]{567}$/.test(compact), 'T/F 串 567 位');
}

/* 6. bulk input -------------------------------------------------------- */
{
  // Pt 74 is a real value (the gap in the male Pt table is at 75); 75 is not
  const parsed = parseBulkTargets('Hs=70\nSc 81\nPt:75\nNope 50\nZzz=99', { isMale: true });
  check(parsed.targets.Hs === 70 && parsed.targets.Sc === 81 && parsed.targets.Pt === 75, '批量解析');
  check(parsed.unknown.length === 2 && parsed.unknown.includes('Zzz=99'), '未知量表被报告');
  check(parsed.unreachable.length === 1 && parsed.unreachable[0].startsWith('Pt 75'), '不可达値被报告');

  const plan = planSheet({ targets: parsed.targets, isMale: true, seed: 4, iterations: 120000 });
  check(plan.target.Pt === 74, '不可达目标被折算', `Pt 75 -> ${plan.target.Pt}`);
  check(plan.feasible, '折算后可行', `loss=${plan.loss}`);
}

/* 7. the built-in example --------------------------------------------- */
for (const isMale of [true, false]) {
  const gender = isMale ? 'male' : 'female';
  const reachable = DATA.reachable[gender];
  const wanted = EXAMPLE_TARGETS[gender];
  const snapped = Object.fromEntries(
    Object.entries(wanted).map(([n, v]) => [
      n,
      reachable[n].values.includes(v) ? v : nearestReachable(reachable[n].values, v),
    ])
  );
  check(
    Object.entries(snapped).every(([n, v]) => v === wanted[n]),
    `示例剖面（${isMale ? '男' : '女'}）全部是可取値`
  );
  const plan = planSheet({ targets: snapped, isMale, seed: 6 });
  check(
    plan.feasible,
    `示例剖面（${isMale ? '男' : '女'}，13 个量表）可行`,
    `loss=${plan.loss}${plan.feasible ? '' : ' ' + JSON.stringify(plan.residual)}`
  );
}

/* 8. infeasible targets are reported, not hidden ----------------------- */
{
  const plan = planSheet({
    targets: { Hs: 81, D: 30, Hy: 30, Pd: 30, Pt: 30, Sc: 30, Ma: 30 },
    isMale: true,
    seed: 8,
    iterations: 60000,
  });
  check(!plan.feasible, '极端矛盾目标报告为不可行', `loss=${plan.loss}`);
  check(plan.achieved.Hs === 81, '不可行时仍满足能救的目标');
}

/* 9. mode-dependent value lists ---------------------------------------- */
{
  // the TRIN table is V-shaped (114 ... 50 ... 120); raw >= 9 under the
  // original formula hides the 64..99 branch, not the bottom of the scale
  const legacyTrin = reachableValuesFor('TRIN', true, false);
  const fixedTrin = reachableValuesFor('TRIN', true, true);
  check(!legacyTrin.includes(64), '原程序公式下 TRIN 不提供 64（不可达）', `legacy=${legacyTrin.join(',')}`);
  check(fixedTrin.includes(64), '修正公式下 TRIN 提供 64');
  check(legacyTrin.includes(50) && fixedTrin.includes(50), '两种公式下 TRIN 50 都可达');
  check(reachableValuesFor('VRIN', true, false).length === 25, 'VRIN 取值不受公式影响');

  // one inconsistency scale at a time: the start sheet must hit it exactly.
  // VRIN and TRIN share 27 items, so with both targeted the start can only be
  // approximate -- it just has to land inside the table, which is the point.
  for (const correctInconsistency of [true, false]) {
    const mode = correctInconsistency ? '修正' : '原程序';
    for (const name of ['VRIN', 'TRIN']) {
      const values = reachableValuesFor(name, true, correctInconsistency);
      const want = values[Math.floor(values.length / 2)];
      const scored = scoreAnswers(startSheet({ [name]: want }, { correctInconsistency, isMale: true }), {
        isMale: true,
        correctInconsistency,
      }).byName;
      check(scored[name] === want, `起点精确命中 ${name}=${want}（${mode}）`, `got=${scored[name]}`);
    }
    const both = { VRIN: reachableValuesFor('VRIN', true, correctInconsistency)[1], TRIN: 65 };
    const scored = scoreAnswers(startSheet(both, { correctInconsistency, isMale: true }), {
      isMale: true,
      correctInconsistency,
    }).byName;
    check(
      scored.VRIN < 120 && scored.TRIN < 120,
      `VRIN+TRIN 同时指定时起点仍在表内（${mode}）`,
      `VRIN=${scored.VRIN} TRIN=${scored.TRIN}`
    );
  }
}

/* 10. range targets --------------------------------------------------- */
{
  // distanceOutside is the whole definition of "inside the range"
  check(distanceOutside(70, { lo: 65, hi: 75 }) === 0, '区间内距离为 0');
  check(distanceOutside(60, { lo: 65, hi: 75 }) === -5, '低于下限为负');
  check(distanceOutside(80, { lo: 65, hi: 75 }) === 5, '高于上限为正');

  const plan = planSheet({
    targets: { Hs: { lo: 65, hi: 75 } },
    isMale: true,
    seed: 3,
    iterations: 120000,
  });
  check(plan.feasible, '区间目标 Hs 65–75 可行', `loss=${plan.loss}`);
  check(plan.achieved.Hs >= 65 && plan.achieved.Hs <= 75, '达成值落在区间内', `Hs=${plan.achieved.Hs}`);
  check(plan.residual.Hs === 0, '区间内偏差为 0', `${plan.residual.Hs}`);
  check(plan.hasRange, '标记为区间目标');
  // 65 is not a value the male Hs table can produce, so the bound is snapped
  // outwards -- the planned interval must still contain the requested one
  const hsValues = reachableValuesFor('Hs', true, false);
  check(
    plan.bounds.Hs.lo <= 65 && plan.bounds.Hs.hi >= 75 &&
      hsValues.includes(plan.bounds.Hs.lo) && hsValues.includes(plan.bounds.Hs.hi),
    'bounds 是折算到可取値后的区间',
    JSON.stringify(plan.bounds.Hs)
  );

  // a point target must behave exactly as before
  const point = planSheet({ targets: { Hs: 70 }, isMale: true, seed: 3, iterations: 60000 });
  check(point.achieved.Hs === 70 && point.target.Hs === 70, '定点目标不受影响', `${point.target.Hs}`);
  check(point.slackItems.length === 0, '定点目标没有区间内可翻转题');

  // >= and <= are the same interval with one open end
  const atLeast = planSheet({
    targets: { Hs: { lo: 78, hi: 120 } },
    isMale: true,
    seed: 5,
    iterations: 60000,
  });
  check(atLeast.feasible && atLeast.achieved.Hs >= 78, '不低于 78 可行', `Hs=${atLeast.achieved.Hs}`);
  const atMost = planSheet({
    targets: { Hs: { lo: 0, hi: 55 } },
    isMale: true,
    seed: 5,
    iterations: 60000,
  });
  check(atMost.feasible && atMost.achieved.Hs <= 55, '不高于 55 可行', `Hs=${atMost.achieved.Hs}`);
}

/* 11. slack items: flippable, but only one at a time ------------------- */
{
  const wide = planSheet({
    targets: { Hs: { lo: 50, hi: 90 } },
    isMale: true,
    seed: 9,
    iterations: 120000,
  });
  check(wide.feasible, '宽区间可行', `Hs=${wide.achieved.Hs}`);
  check(wide.slackItems.length > 0, '宽区间找出区间内可翻转题', `${wide.slackItems.length} 道`);
  check(
    wide.slackItems.every((item) => !wide.freedom[item]),
    '区间内可翻转题不属于结构自由题'
  );

  let broke = 0;
  for (const item of wide.slackItems) {
    const answers = wide.answers.slice();
    answers[item - 1] = !answers[item - 1];
    const after = scoreAnswers(answers, { isMale: true }).byName;
    if (distanceOutside(after.Hs, wide.bounds.Hs) !== 0) broke += 1;
  }
  check(broke === 0, '每一道单独翻转后仍在区间内', `broke=${broke}`);

  // flipping one changes where the rest sit, so the split has to be redone
  const flipped = wide.answers.slice();
  flipped[wide.slackItems[0] - 1] = !flipped[wide.slackItems[0] - 1];
  const again = analyseFreedom(flipped, wide.bounds, { isMale: true });
  check(
    distanceOutside(scoreAnswers(flipped, { isMale: true }).byName.Hs, wide.bounds.Hs) === 0,
    '重算前的翻转确实安全（正向复核）'
  );
  check(again.freedom.length === DATA.nItems + 1 && again.slack.length === DATA.nItems + 1,
    '重算返回完整数组');

  // randomising keeps the profile inside the interval
  const shuffled = randomizeWithinBounds(wide.answers, wide.bounds, {
    freeItems: wide.freeItems,
    slackItems: wide.slackItems,
    seed: 11,
    isMale: true,
  });
  const after = scoreAnswers(shuffled, { isMale: true }).byName;
  check(distanceOutside(after.Hs, wide.bounds.Hs) === 0, '随机化后仍在区间内', `Hs=${after.Hs}`);
  const changed = shuffled.reduce((n, a, i) => n + (a !== wide.answers[i] ? 1 : 0), 0);
  check(changed > 0, '随机化确实改了答卷', `${changed} 道`);
}

/* 12. the four modes in bulk input and in the formatter ---------------- */
{
  const male = DATA.reachable.male;
  const bulk = parseBulkTargets('Hs=70\nSc=65-75\nPt>=80\nD<=45\nMa 55', { isMale: true });
  check(bulk.targets.Hs === 70, '批量：精确值仍是数字');
  check(bulk.targets.Sc.lo === 65 && bulk.targets.Sc.hi === 75, '批量：区间', JSON.stringify(bulk.targets.Sc));
  check(
    bulk.targets.Pt.lo === 80 && bulk.targets.Pt.hi === male.Pt.max,
    '批量：不低于',
    JSON.stringify(bulk.targets.Pt)
  );
  check(
    bulk.targets.D.hi === 45 && bulk.targets.D.lo === male.D.min,
    '批量：不高于',
    JSON.stringify(bulk.targets.D)
  );
  check(bulk.targets.Ma === 55, '批量：空格分隔');

  const hs = male.Hs;
  check(formatTarget(70, hs) === '70', '格式化：精确值', formatTarget(70, hs));
  check(formatTarget({ lo: 65, hi: 75 }, hs) === '65–75', '格式化：区间', formatTarget({ lo: 65, hi: 75 }, hs));
  check(formatTarget({ lo: 65, hi: hs.max }, hs) === '≥ 65', '格式化：不低于', formatTarget({ lo: 65, hi: hs.max }, hs));
  check(formatTarget({ lo: hs.min, hi: 70 }, hs) === '≤ 70', '格式化：不高于', formatTarget({ lo: hs.min, hi: 70 }, hs));

  const options = [{ name: 'Hs', values: hs.values, min: hs.min, max: hs.max }];
  const exact = convertTargets({ Hs: { lo: 65, hi: 75 } }, 'exact', options);
  check(exact.Hs.lo === exact.Hs.hi, '切到精确值后是定点', JSON.stringify(exact.Hs));
  const range = convertTargets({ Hs: { lo: 70, hi: 70 } }, 'range', options);
  check(range.Hs.lo === 70 && range.Hs.hi > 70, '切到区间后上限抬高', JSON.stringify(range.Hs));
  const atLeast = convertTargets({ Hs: { lo: 70, hi: 70 } }, 'atLeast', options);
  check(atLeast.Hs.lo === 70 && atLeast.Hs.hi === hs.max, '切到不低于', JSON.stringify(atLeast.Hs));
  const atMost = convertTargets({ Hs: { lo: 70, hi: 70 } }, 'atMost', options);
  check(atMost.Hs.hi === 70 && atMost.Hs.lo === hs.min, '切到不高于', JSON.stringify(atMost.Hs));
}

console.log(`\n${failures === 0 ? 'ALL OK' : failures + ' FAILURES'}`);
console.log(`组合数量示例: 自由题 20 道 -> ${combinationLabel(20)}, 300 道 -> ${combinationLabel(300)}`);
process.exit(failures === 0 ? 0 : 1);
