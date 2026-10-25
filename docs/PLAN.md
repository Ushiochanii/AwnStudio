# Awn Studio 新版：重建算法体系化与项目架构计划（草案 v0）

日期：2026-10-25　状态：待确认　原项目：`E:\Awn_recognization\wheat-awn-phenotyping`（只读引用，不修改、不移动）

---

## 1. 现状诊断：碎片 → 完整芒的重建后处理

现行路线（`src/awnphen/phenotyping/physical/growth/`）：

```text
高重叠芒合并 → 小穗清理 → 每个小穗取 ≤8 个候选种子 → 逐跳贪心生长
→ 兄弟种子竞争归属（5% 相对分差内可共享） → branch_score 选代表 → 根部归一化 → 弧长
```

### 1.1 经验参数的分布（不含检测与标定阶段）

| 环节 | 位置 | 手工参数 |
|---|---|---|
| 种子发现 | `seeds.py`, `config.py` | 直接根半径 2.8 mm、投影射线 4.5 mm / 1.2 mm、轴偏 75°；`seed_score` 权重 4 / 1 / 1.5 / 1.5 / 0.10 |
| 逐跳生长 | `growth.py:_wide_rank_next_support` | 硬门限 55° / 70° / 90° / 20°、2.8 mm、0.35 mm、join 22° / 8°；线性打分权重 1.0 / 0.45 / 0.35 / 7.5 / 0.18 / 2.2 / 2.0；跨预测风险 0.35 / 1.0 mm / 18° / 6° / ≥2 项 |
| 形态 v2 打分 | `growth.py:_morphology_rank_next_support` | 尺度 1.0 mm / 20° / 10° / 20° / 2.0 mm、搜索半径 6 mm |
| 归属竞争 | `ownership.py` | 共享相对分差 5%；`branch_score` 权重 0.75 / 0.025 / 0.25 / 0.35 |
| 交叉保护 | `crossing.py:CrossingPolicy` | 9 个半径 / 角度参数 |
| 根部救援 | root normalization | 0.60–1.50 mm、0.30 mm、1.50 mm、2.00 mm |

合计约 60 个手工常数，多数在 Validation11 上逐轮调整过（`docs/current/2026-10-0x-*` 的实验记录本身也承认这一点）。

### 1.2 结构性问题（比参数数量更关键）

1. **局部贪心、顺序依赖**：每跳只取当前最优，小穗按 `seed_score` 排序后依次“提交”并占用碎片，先处理的小穗会抢走后处理小穗的碎片，结果与处理顺序有关，无法写成一个明确的优化目标。
2. **三套互不可比的分数**：`seed_score`、`growth_score`、`branch_score` 单位任意，“5% 相对分差可共享”在任意单位上没有统计含义。
3. **代表芒规则与规范不一致**：`docs/methods/phenotype-output-spec.md:34,66` 规定“代表值取完整芒中最长者”，而 `ownership.py` 的 `grow_representatives` 用 `branch_score`（长度 + 0.75×跳数 − 角度/距离/种子惩罚）排序选赢家。
4. **代码内存在多条并行打分路径**：`grow_branch` 仍调用 `_wide_rank_next_support`，`pipeline.py` 默认改用 `_morphology_rank_next_support`，另有 gated-gain、hybrid 等实验分支；冻结的 v1 与当前工作树行为已经分叉，需要先固定一个“基线”。
5. **只有长度级评估**：目前只看最终长度 MAE，没有直接衡量“重建是否把碎片拼对了”（合并错误 / 断裂错误）。

> 可利用的有利条件：`data/annotations/segmentation_source/` 中人工 polygon 是**整根芒的实例标注**（train 4898 / valid 594 根芒）。这意味着“两段碎片是否属于同一根芒”可以从标注自动得到监督标签，经验阈值可以换成从数据估计的统计模型。

---

## 2. 新方案：概率碎片图 + 全局最优指派

核心思想：把“碎片拼接成芒”写成一个**有明确目标函数的推断问题**，而不是一串局部规则。每一个打分项都是对数似然比，可解释、可估计、可做消融。

### 2.1 步骤

**A. 原子碎片化**
每个芒 mask 骨架化为毫米坐标中心线，在骨架分叉点和轨迹拐点处切分（沿用现有 trajectory-aware decomposition 思路，但切分阈值改为由数据分布给出），得到带方向（根→梢）的原子碎片，附带长度、置信度、宽度剖面、两端切线。

**B. 连接似然模型 p(link | x)**
对碎片 i 的末端与碎片 j 的起端构造特征 x：间隙距离、横向偏移、多尺度切线夹角、最小弹性曲线（Euler spiral / elastica）桥接的弯曲能量、宽度比、两段置信度、桥接是否穿过其他 mask。
用逻辑回归（必要时加单调约束的 GAM）估计 p(link | x)。标签：把预测碎片按覆盖率匹配到人工整芒实例，同一实例且沿弧长相邻为正例，否则为负例。
边代价 = −log[p / (1 − p)]。原来的 55° / 2.8 mm / 7.5 倍距离权重等全部由模型系数替代；搜索半径取正例间隙分布的高分位数。

**C. 根部似然 p(root | fragment, spikelet)**
同样方式估计：与小穗上端区域距离、与小穗轴向夹角、投影距离等。标签由人工芒 polygon 与人工小穗 polygon 的接触关系自动导出。替代 `seed_score` 与直接 / 投影两套半径。

**D. 全局推断**
1. 每个小穗用 k-best beam search 在碎片图上生成候选路径（路径分 = 根部对数似然比 + Σ 连接对数似然比 + 路径级平滑先验）。
2. 在全页上解加权集合打包（weighted set packing）整数规划：最大化所选路径总对数似然比，约束每个碎片最多属于一条路径（交叉点碎片容量为 2），每个小穗最多选 m 条芒（m 与表型规范一致，1–3）。
3. 求解器：`scipy.optimize.milp`（HiGHS，环境已具备，无需新装包）。单页规模约几十个小穗、数百个碎片，求解很快。
结果与处理顺序无关、可复现，并且等价于该概率模型下的 MAP 解。

**E. 代表芒选择**
按规范：在已选路径中，取“完整性后验 ≥ τ”的最长者（梢端是自由端、未被页面边界或其他 mask 截断）。后验低的小穗进入人工审阅队列，网页上直接显示该数值。

**F. 测量**
根部归一化、DP1 弧长与 5 mm 网格标定沿用冻结实现，不改。

### 2.2 剩余超参数

只剩 beam 宽度 k、完整性阈值 τ、路径平滑先验强度、交叉容量规则这几个，都具有明确含义，论文中做敏感性分析即可。

### 2.3 评估设计

- **开发集**：Validation11（与现在一致）。连接 / 根部模型在 train 91 页的预测上拟合，在 Validation11 上检查校准；由于模型在 train 页上偏乐观（碎片更少），若校准偏差明显，改为 Validation11 按页 5 折交叉拟合。
- **新增重建级指标**：以人工整芒 polygon 为真值，统计每根芒的覆盖率 / 纯度、合并错误数、断裂错误数，以及代表芒是否命中真值最长芒。这比单一长度 MAE 更能说明重建方法本身。
- **消融**：贪心 vs 全局；手工权重 vs 学习似然；有无原子切分；代表芒“综合分”vs“最长完整”。
- **Test11**：所有选择在 Validation 上冻结后一次性运行，作为新版本结果，与 Unified Growth v1 的历史记录并列报告，不回写旧结论。
- **快速收益**：在新管线完成前，先在现有输出上单独评估“代表芒改为最长完整芒”的影响（只重算选择，不重跑推理）。

### 2.4 风险

- 新方法未必在 MAE 上超过当前约 1.70 mm 的最好开发结果；即便持平，方法的可解释性、参数数量和重建级指标仍是主要贡献，结论如实报告。
- train 页预测分布偏乐观（见上，已有对策）。
- 人工 polygon 在交叉处的归属可能存在歧义，需要抽样核查标签质量。

---

## 3. 新项目架构

位置：`E:\Awn_recognization\awn-studio\`（WSL：`/mnt/e/Awn_recognization/awn-studio`），本地 git 仓库，你在 GitHub 建好仓库后再推送。
数据与权重**不复制**：通过 `configs/paths.yaml` 只读引用原项目的 `data/raw/primary`、`data/annotations/segmentation_source`、`data/ground_truth/phenotype` 和冻结权重 `artifacts/models/controlled_v2_targeted_robust_stage1_640_b20/weights/best.pt`。运行环境固定为 WSL `~/.venvs/wheat_awn_rocm`。

```text
awn-studio/
  pyproject.toml
  configs/            paths.yaml（只读引用）、pipeline.yaml（全部超参数集中一处）
  src/awnstudio/
    io/               图像、权重、标注、真值读取
    inference/        YOLO11n-seg 分块推理与拼接（移植自原项目）
    calibration/      5 mm 网格标定 v2（移植）
    spikelet/         小穗清理与合并（移植）
    fragments/        骨架化、原子碎片、特征
    linking/          连接 / 根部似然模型及拟合
    assembly/         beam 候选路径 + ILP 全局指派
    selection/        代表芒（最长完整芒 + 后验）
    measurement/      根部归一化、弧长（移植）
    evaluation/       长度指标、重建级指标、消融
    pipeline.py       唯一入口：image → JSON 结果
  service/            本地 HTTP 服务，供网页调用 pipeline
  web/                网页前端
  scripts/            fit_link_model / run_validation / run_test_once / build_report
  tests/              单元测试 + 移植等价性测试
  docs/
```

原则：
- 推理、标定、测量三部分**移植并精简**（不 import 原项目），并用等价性测试保证在 Validation11 上逐页复现原冻结结果；只有重建部分是新算法。
- 原项目的 Unified Growth 以适配器形式保留为“基线”，便于在同一评估器下对比。

### 网页

功能与现 Awn Studio 一致：导入 → 标定 → 自动测量 → 审阅 → 检查 → 编辑 → 确认 → 导出，含图层、置信度过滤、撤销历史、项目保存、多语言。
计划保留现有无构建 ES module 架构和其单元测试，重做视图层与样式；另加一个“重建检查”面板，显示每条连接的后验概率与每个小穗的完整性后验，方便审阅。

---

## 4. 分阶段推进

| 阶段 | 内容 | 完成标志 |
|---|---|---|
| P0 | 建立新仓库骨架，移植推理 / 标定 / 测量 | Validation11 上与冻结输出逐页一致 |
| P1 | 基线复现 + 重建级指标 + “最长完整芒”快速评估 | 基线报告（长度 + 重建级） |
| P2 | 碎片真值匹配、连接与根部似然模型拟合 | 校准曲线、系数表 |
| P3 | beam + ILP 全局指派、代表芒选择 | Validation11 完整结果 |
| P4 | 消融、敏感性分析、Test11 一次性运行 | 新版本结果报告 |
| P5 | 网页重做（可与 P2–P4 并行，另开线程） | 功能对齐的新界面 |

---

## 5. 需要你确认的事项

1. 新目录名用 `awn-studio`？
2. 网页：保留现有无构建 JS 架构只重做外观（推荐），还是改用 Vue / React + Vite？
3. 连接模型训练数据：train 页拟合 + Validation 校准（推荐），还是只用 Validation 交叉拟合？
