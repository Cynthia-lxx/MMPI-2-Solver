# Common Clinical Models 资料挖掘调查报告

> 调查对象：`MMPI_2_Grader-master/.../common-clinical-models-master/`（工作区新增资料，共 2966 个文件）
> 调查目的：为 PsychoInverse（心理量表反算 / 评分工具）后续扩充量表做储备。
> 调查日期：2026-10-17

---

## 1. 这是什么资料

这是 **openEHR 的「Common Clinical Models」** 档案库，由 Cambio Healthcare Systems 维护，README 明确说明已**停止维护**，内容已并入上游仓库 `openEHR/gdl-guideline-models`。

本质是一套**临床决策支持（CDS）模型库**：用 openEHR 原型（archetype）描述数据结构，用 GDL2（Guideline Definition Language 2.0）描述评分规则与判定逻辑。其中 `views/` 下的 165 个文件对应 165 个临床量表 / 评分工具，覆盖全科医学；精神 / 心理相关量表是一个**完整且可直接复用**的子集，与本项目高度契合。

---

## 2. 目录结构与规模

| 目录 | 文件数 | 内容 |
|---|---|---|
| `archetypes/` | 1125 个 `.adl` | openEHR 原型：定义每个量表的**题项文本 + 作答选项**（如 Likert 0–3 的标签、编码） |
| `gdl2/` | 672 `.json` + 668 `.yml` | GDL2 指南：每个量表的**计分规则（求和 / 判定）+ 严重程度分级 + 参考文献** |
| `guidelines/` | 316 `.gdl` | 较早的 GDL1 指南（旧格式，备用） |
| `views/` | 165 `.dsv`（实为 HTML+JSON） | 每个量表的**前端视图 + 元数据**：名称、用途、解释文案、cut-off、PubMed 引用 |
| `templates/` `terminologies/` `img/` | — | 模板、术语绑定、示意图 |

---

## 3. 单条量表的三层数据模型

每条量表的信息**分散在三类文件中**，互相通过 openEHR archetype id 引用：

```
archetypes/openEHR-EHR-OBSERVATION.<scale>.v1.adl   ← 题项文字 + 选项标签（数据层）
gdl2/<Scale>.v1.gdl2.json                          ← 计分公式 + 分级区间 + 文献（逻辑层）
views/<Scale>.v1.dsv                               ← 展示文案 + 解释 + 误用警告（视图层）
```

### 实例：PHQ-9（已逐文件核实）

**① archetype（`.adl`）** — 9 道题的中英文题干（如 "Little pleasure doing things" / "Feeling hopeless"） + 每题 0–3 四级 Likert 标签。

**② gdl2（`PHQ9.v1.gdl2.json`）** 关键片段：

```jsonc
"data_bindings": {
  "gt0002": { "model_id": "openEHR-EHR-OBSERVATION.patient_health_questionnaire_9.v1",
              "type": "INPUT",
              "elements": { "gt0003": { "path": "/data.../items[at0004]" }, /* ...9 题元素 */ } },
  "gt0029": { "model_id": "openEHR-EHR-EVALUATION.phq9_assessment.v1", "type": "OUTPUT", ... }
},
"rules": {
  "gt0028": { "priority": 6, "when": ["$gt0003|Little pleasure doing things|!=null", ...],
              /* 求和公式 + 分级：0-4 无/极轻，5-9 轻度，10-14 中度，15-19 偏重，20-27 重度 */ }
}
```

- `references` 字段带 PubMed 出处（Kroenke 2001 等），可直接引用。
- GAD-7 同理：`gdl2/GAD-7.v1.gdl2.json` 定义 7 题 0–3 求和（0–21，5/10/15 为轻/中/重 cut-off）。

**③ view（`PHQ-9.v1.dsv`）** — 纯展示层：量表名、用途说明、误用警告（如「第 9 题 > 0 需评估自杀风险」）、版权、参考文献链接。

> 结论：要复现一个量表，需要从 **archetype 抽题项 + 选项、从 gdl2 抽计分规则 + 分级、从 dsv 抽解释文案 + 文献** 三方拼合。

---

## 4. 量表清单（共 165 个）

全部 165 个位于 `views/`。除精神心理子集外，其余为心内、肾内、肿瘤、外科、急诊、产科、儿科等全科评分工具（如 NEWS、SOFA、APGAR、Glasgow、Braden 压疮、各类药物剂量计算等）。

### 4.1 精神 / 心理相关量表（重点子集，按类别）

| 类别 | 量表（views 中的 dsViewId） |
|---|---|
| 抑郁 | **PHQ-9**、**HAD**（医院焦虑抑郁）、**HAM**（Hamilton，含焦虑 HAM-A / 抑郁 HAM-D 变体）、**MADRS** / **MADRS-S**、**QIDS**（抑郁症状快速清单） |
| 焦虑 | **GAD-7**、**HAD**、**SPIN**（社交恐怖量表）、**AS-18**（部分条目偏焦虑，待核验） |
| 双相 / 躁狂 | **YMRS**（Young 躁狂评定量表） |
| 强迫 | **Y-BOCS**（耶鲁-布朗强迫量表）、**OCI-R**（强迫量表修订版） |
| 创伤 / 应激 | **IES-R**（事件影响量表，PTSD）、**RAADS-14**（孤独症 / 阿斯伯格筛查） |
| 惊恐 | **PDSS-SR**（惊恐障碍严重度量表） |
| 注意缺陷 | **ASRS**（成人 ADHD 自评） |
| 物质使用 | **CAGE**、**AUDIT-C**（酒精筛查）、**DUDIT**（药物使用筛查）；戒断：**CIWA-Ar**（酒精）、**COWS**（阿片） |
| 睡眠 / 疲劳 | **ESS**（Epworth 嗜睡）、**MOS-SSS**（睡眠量表）、**MFIS** / **MFIS_shortened**（多发性硬化疲劳影响） |
| 功能 / 残疾 | **WHODAS 2.0**（12 项与 36 项，WHO 残疾评定） |

> 说明：上述清单中加粗者为**明确**属精神心理自评/他评的量表。另有个别文件（如 SFSR、SMS、TRI、SCI-93、MNS、NPS、DLCN 等）名称偏临床，**接入前需逐一打开 `.dsv` 核验其实际领域**，不可仅凭文件名判定。

### 4.2 与本项目已有量表的对比

- 本项目已实现：**MMPI-2**（567 题，T 分，含 K/VRIN/TRIN 校正）、**SCL-90**（90 题 5 级，12 维度，已接入并支持量表切换）。
- 本资料可补充：一批**标准化、带文献出处、含现成 cut-off 与分级**的常见精神量表（PHQ-9/GAD-7 等），比 SCL-90 数据源更规范，适合批量接入。

---

## 5. 对 PsychoInverse 的可用性与提取方案

### 5.1 价值

- 这些都是**权威、带 PubMed 出处**的量表，自带「题项文本 + 选项标签 + 求和计分 + 严重程度分级 + 解释文案」，**正好契合现有引擎**（Likert / Choice + 权重计分，逐题相加）。
- 多数为**简单求和量表**（与 SCL-90 同类），可直接用现有 `weights` 机制表达；少数带条件分支（如自杀风险专项判定）需特殊处理后接入。

### 5.2 提取路径（每个量表）

1. **题项 + 选项**：解析 `archetypes/*<scale>*.adl` → 题干（中/英）+ Likert 级别标签与编码。
2. **计分 + 分级**：解析 `gdl2/<Scale>.v1.gdl2.json` 的 `rules` → 求和公式 + 各档 cut-off（如 PHQ-9 的 5/10/15/20）。
3. **解释 + 文献**：解析 `views/<Scale>.v1.dsv` → 用途、解释文案、误用警告、参考文献（用于界面说明与引用）。

### 5.3 落地形态建议

参照现有 `scl90.data.js`（由 `gen_scl90.mjs` 从原始 JSON 自动生成）的做法：

- 新增 `<scale>.data.js`（题项、格式、维度绑定、诊断带），由解析脚本从 `.adl` + `.gdl2.json` 自动生成，避免手抄出错。
- 新增对应计分 / 求解函数，并在 `switchScale` 注册，复用现有「量表切换」框架。
- 优先级建议：**先做 PHQ-9 + GAD-7**（最常用、纯求和、资料最完整）作为抽取脚本的验证样本，跑通后再批量铺开其余纯求和类。

---

## 6. 注意与风险

- **格式不兼容**：资料是 openEHR/GDL 的 CDS 模型，**不是**本项目现有的「题项 → 权重表」JSON 格式，必须写解析脚本转换，无法直接引用。
- **多为决策支持模型**：部分 GDL 含临床判定分支（适应症/禁忌、阈值告警），接入评分反算时只取「求和 + 分级」部分，忽略临床决策分支。
- **语种**：`gdl2` 内 `details` 多为 `sv`（瑞典语）+ `en` 双语；`views` 多为英文。题项中文需对齐本项目已有译法（SCL-90 已统一）。
- **版权**：`views` 标注 `© Cambio Healthcare Systems`；量表本身是公开的临床工具，但引用时建议保留原始文献出处（已在 `references` 字段中）。
- **数据新鲜度**：该仓库已归档，内容为历史快照；若需最新版本应参考上游 `openEHR/gdl-guideline-models`。

---

## 7. 后续开发待办（建议）

- [ ] 编写 `<scale>` 解析脚本：`.adl` + `.gdl2.json` + `.dsv` → 生成 `<scale>.data.js`
- [ ] 以 PHQ-9、GAD-7 为样本验证抽取可行性
- [ ] 逐个核验 4.1 中「待核验」文件的实际领域
- [ ] 评估 WHODAS 2.0 / ASRS 等非纯求和量表的接入成本
- [ ] 数量表后补充对应 `test-<scale>.mjs` 与 e2e
