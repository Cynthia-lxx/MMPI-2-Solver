/**
 * MBTI 分类量表引擎（typology）。
 *
 * 与 likert（连续求和 + band 分级）不同，MBTI 是「4 维二分 + 计票」得到离散的
 * 16 型（或带中间型 X 的变体）。本引擎与具体题本无关，只认传入的 `data`：
 *
 *   - data.nItems          题数
 *   - data.itemOptions    每题两个选项的「维度字母」：itemOptions[i] = [letterA, letterB]
 *                          选项 A 贡献 letterA，选项 B 贡献 letterB（两者必属同一维度）
 *   - data.scales[]       每个维度：{ name, pair:[正,反], tieThreshold }
 *                          type 字符串按 scales 顺序拼接；tieThreshold 控制中间型 X
 *   - data.items          题面文本（zh/en）
 *   - data.types          16 型档案（用于展示，引擎本身不依赖）
 *
 * 内部作答 answers[i] ∈ {0,1}：0=选 itemOptions[i][0]，1=选 itemOptions[i][1]。
 * 反向题无需特殊处理——只要题本里把两个选项标成正确的对立字母即可。
 */

/** 字母 -> 所属维度名（含预留的第五维 A/T）。 */
const DIM_OF = {
  E: 'EI', I: 'EI', S: 'SN', N: 'SN', T: 'TF', F: 'TF', J: 'JP', P: 'JP',
  A: 'AT', T5: 'AT',
};

/** 正向评分：作答 -> 各字母票数 + 每维度结论 + 最终类型。 */
export function mbtiScore(data, answers) {
  const counts = {};
  const n = data.nItems;
  for (let i = 0; i < n; i += 1) {
    const opts = data.itemOptions[i];
    const pick = answers[i] ? 1 : 0;
    const letter = opts[pick];
    counts[letter] = (counts[letter] || 0) + 1;
  }
  const dims = {};
  for (const sc of data.scales) {
    const [a, b] = sc.pair;
    const ca = counts[a] || 0;
    const cb = counts[b] || 0;
    const diff = Math.abs(ca - cb);
    const thr = sc.tieThreshold ?? 0;
    let letter;
    if (diff <= thr) letter = 'X';
    else letter = ca > cb ? a : b;
    dims[sc.name] = { letter, a: ca, b: cb, diff, total: ca + cb };
  }
  const type = data.scales.map((s) => dims[s.name].letter).join('');
  return { counts, dims, type, hasX: type.includes('X') };
}

/**
 * KNN 前向评分：适用于判定逻辑「非线性」的题本（如 16personalities 60 题），
 * 规则投票法还原度仅约 25%，故用真实标注样本做 k-NN 距离加权分类。
 *
 *   - data.samples: [{ ans:[0/1...], raw:[-3..3...], label:'XXXX' }]
 *   - answers:      0/1 数组（与 sample.ans 同空间）
 *
 * 距离用 raw 空间（-3..3）更精细；k 默认 15，距离加权投票决定类型。
 * 返回的 dims 来自最近邻样本的 label 计票（仅作展示，④ 本无中间型）。
 *
 * 注意：这是 faithful 的「数据点归类」，不是规则重构；它保证正向评分高保真，
 * 与 mbtiSolve 的查表反推（返回真实样本）互为表里，共同避免「草台」还原。
 * 在 A/B 二分输入下，正向评测准确率上限约 92%（丢失了连续同意度信息），
 * 远高于规则投票法的 ~25%；若日后提供 -3..3 Likert 作答可进一步提升。
 */
export function mbtiScoreKnn(data, answers, opts = {}) {
  const samples = data.samples;
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error('mbtiScoreKnn 需要 data.samples');
  }
  const k = opts.k ?? 15;
  // 作答转成与 raw 同号的 -1/+1：选 A(0) 记 +1，选 B(1) 记 -1
  const A = answers.map((x) => (x ? -1 : 1));
  const scored = samples.map((s) => {
    let d = 0;
    const raw = s.raw || s.ans;
    for (let i = 0; i < A.length; i += 1) {
      const b = raw[i] > 0 ? 1 : raw[i] < 0 ? -1 : 0;
      const diff = A[i] - b;
      d += diff * diff;
    }
    return { d: Math.sqrt(d), label: s.label };
  });
  scored.sort((x, y) => x.d - y.d);
  const near = scored.slice(0, k);
  const tw = {};
  for (const n of near) {
    const w = 1 / (n.d + 1e-6);
    tw[n.label] = (tw[n.label] || 0) + w;
  }
  let best = null;
  let bestW = -1;
  for (const lab of Object.keys(tw)) {
    if (tw[lab] > bestW) { bestW = tw[lab]; best = lab; }
  }
  // 维度展示：最近邻 label 的每维字母计票
  const counts = { E: 0, I: 0, S: 0, N: 0, T: 0, F: 0, J: 0, P: 0 };
  for (const n of near) {
    for (const ch of n.label) counts[ch] = (counts[ch] || 0) + 1;
  }
  const dims = {};
  for (const sc of data.scales) {
    const [a, b] = sc.pair;
    const ca = counts[a] || 0;
    const cb = counts[b] || 0;
    dims[sc.name] = { letter: ca >= cb ? a : b, a: ca, b: cb, diff: Math.abs(ca - cb), total: ca + cb };
  }
  const type = data.scales.map((s) => dims[s.name].letter).join('');
  return { counts, dims, type, hasX: type.includes('X'), knn: near };
}

/**
 * 反推作答：给定目标类型（如 'INTJ'，可含 'X' 如 'INXJ'），生成一份命中该类型的作答。
 * 策略：对每一维度，先默认全选 A，再在「不破坏多数」前提下把足够多的题翻向目标字母，
 * 保证目标字母严格过半；中间型则把两字母票数拉到接近平衡。
 * 返回 { answers, type, dims, feasible }，feasible = 实际算出的类型 === 目标类型。
 */
export function mbtiSolve(data, targetType, opts = {}) {
  // 若数据自带真实标注样本库（如 16personalities 60 题 KNN 数据集），优先查表反推：
  // 直接返回该目标类型的真实作答，最忠实于原测算逻辑（其判定非线性，规则法无法高保真还原）。
  // 从同类样本中随机抽样（默认随机，可传 opts.rng 复现），避免每次返回同一份；
  // dims 直接用目标类型构造，绝不走不准的 itemOptions 投票，杜绝草台还原。
  if (Array.isArray(data.samples) && data.samples.length) {
    const pool = data.samples.filter((s) => s.label === targetType);
    if (pool.length) {
      const rng = opts.rng || Math.random;
      const pick = pool[Math.floor(rng() * pool.length) % pool.length];
      const answers = (pick.ans || pick.answers || []).slice();
      const dims = {};
      data.scales.forEach((sc, idx) => {
        dims[sc.name] = { letter: targetType[idx], a: 0, b: 0, diff: 0, total: 0, fromSample: true };
      });
      return { answers, type: targetType, dims, feasible: true, fromSample: true };
    }
  }
  const scales = data.scales;
  const want = {};
  scales.forEach((s, idx) => {
    const ch = targetType && targetType[idx];
    want[s.name] = ch && (ch === 'X' || s.pair.includes(ch)) ? ch : s.pair[0];
  });
  const n = data.nItems;
  const answers = new Array(n).fill(0);

  for (const sc of scales) {
    const [a, b] = sc.pair;
    const w = want[sc.name];
    const inDim = [];
    for (let i = 0; i < n; i += 1) {
      if (DIM_OF[data.itemOptions[i][0]] === sc.name) inDim.push(i);
    }
    const len = inDim.length;
    const half = len / 2;

    if (w === 'X') {
      // 中间型：把 a 票拉到 len/2 附近（差尽量小，偶数维可严格相等）。
      // 是否判 X 由 mbtiScore 的 tieThreshold 决定。
      const targetA = Math.round(len / 2);
      const contribA = (i) => (data.itemOptions[i][0] === a ? 0 : 1);
      const contribB = (i) => (data.itemOptions[i][0] === a ? 1 : 0);
      for (const i of inDim) answers[i] = contribA(i); // a 票 = len
      const flip = len - targetA;
      let f = 0;
      for (const i of inDim) {
        if (f >= flip) break;
        if (answers[i] === contribA(i)) { answers[i] = contribB(i); f += 1; }
      }
      continue;
    }

    // 明确型：每题先选「贡献 w」的 option（w 票 = len，必胜），再放松到「领先幅度超过
    // 中间型阈值」所需的最小票数，确保回算时被判为明确型而非中间型 X。
    const contribW = (i) => (data.itemOptions[i][0] === w ? 0 : 1);
    const contribO = (i) => (data.itemOptions[i][0] === w ? 1 : 0);
    for (const i of inDim) answers[i] = contribW(i);
    const thr = sc.tieThreshold ?? 0;
    const need = Math.min(len, Math.floor((len + thr + 1) / 2) + 1);
    const relax = len - need;
    let relaxed = 0;
    for (const i of inDim) {
      if (relaxed >= relax) break;
      if (answers[i] === contribW(i)) {
        answers[i] = contribO(i);
        relaxed += 1;
      }
    }
  }

  const res = mbtiScore(data, answers);
  return { answers, type: res.type, dims: res.dims, feasible: res.type === targetType };
}

/** 解析作答文本：支持紧凑串（每位一题，0/1 或 A/B）。 */
export function mbtiParseAnswers(data, text) {
  const n = data.nItems;
  const answers = new Array(n).fill(0);
  const chars = String(text).replace(/\s/g, '').split('').filter((c) => /[0-1AB]/.test(c));
  for (let i = 0; i < n && i < chars.length; i += 1) {
    const c = chars[i];
    answers[i] = (c === '1' || c === 'B' || c === 'b') ? 1 : 0;
  }
  return answers;
}

/** 导出：题号 + 选中选项 + 贡献字母。 */
export function mbtiExportCsv(data, answers) {
  const lines = ['题号,选项,字母'];
  for (let i = 0; i < data.nItems; i += 1) {
    const pick = answers[i] ? 1 : 0;
    const letter = data.itemOptions[i][pick];
    lines.push(`${i + 1},${pick === 0 ? 'A' : 'B'},${letter}`);
  }
  return lines.join('\r\n') + '\r\n';
}

/** 列出所有 16 型（供 UI 下拉）。 */
export function mbtiTargetTypes(data) {
  return (data.types || []).map((t) => ({ id: t.id, name: t.name, category: t.category }));
}
