# 画布揭示与分组契约

日期：2026-09-30。本文拥有"一支笔落下之后画布如何让用户看见"以及"agent 应当如何组织它创建的元素"这两条当前契约。

## 体验承诺

一段工作落下时，用户应当看得见它在长，而不是被一整块结果砸中。一件交付物应当能被整块拿起、整块挪走，而不是散成几十个抓不住的碎片。

## 起因

在用户真实画布（Dia，projectId `project-209a7e47-e4e4-4774-b80c-89559e61c273`）上实测到两个缺陷。

**一、几乎没有任何可见过程。** 原实现在 `CanvasPresentation.show` 中要求 `el.type === 'freedraw'` 且 `el.frameId` 为空且底色透明，并且以"累计 32 ms"为总量预算，超预算即 `break`。三条限制叠加的后果是：文字、矩形、图片、箭头永远没有呈现过程；一旦元素进入 frame 就失去呈现；而超过预算之后的所有元素被直接丢弃。实测三次提交各 50 个元素，绝大多数元素没有任何可见过程。

**二、分组要求从未到达 agent。** 全仓唯一的分组指令位于 `packages/canvas/src/instructions.ts` 的 `CANVAS_INSTRUCTIONS` 常量内，而 `docs/agent-architecture.md` 早已记载该常量不是 MCP 实际下发的 payload。真正送达的 `GALTA_MCP_INSTRUCTIONS` 与嵌入式 `codexInstructions` 中没有任何分组要求。实测 150 个对象的 `groupIds` 全为空。

历史证据同向：`docs/evidence/detective-board-2026-09-18/observer-notes.md` 记录 agent 曾主动尝试使用 `groupIds`，被当时的 schema 拒绝，当时的评价就是"不应称模型没想到分组"。

## 一、揭示：提交之后重放，而不是提交之前抢跑

**结构决定：reveal 在 commit 之后发生。**

最初的实现把 reveal 放在 commit 之前，意图是"元素等提交时已经铺开"。实测证明这条路走不通：`prepare` 0.5 ms、`present` 8.4 ms、`applyPrepared` 0.9 ms，整次提交耗时约 16.7 ms——**一个 commit 只占一帧**。元素虽然确实在 6 ms 和 14 ms 两次进入 DOM，但在同一帧内就被清除，浏览器没有任何机会绘制它们。

因此改为：元素先按原子事务提交，原生元素随即画上；随后把**本批新增的元素**重放为装饰层，覆盖在已经完成的原生画面之上，再逐帧淡出。这个顺序有三个直接收益：

- 装饰不再与事务竞争时间，无法延迟 commit（`docs/architecture.md` 记录的不变量继续成立）。
- 装饰盖住的是一份已经定稿的文档，因此它不可能改变回执、修订号或撤销栈。
- 中断路径变得平凡：写入未提交就没有任何装饰，写入已提交则原生画面已经存在。五个中断动作（stop / storage / edit / restore / close）在新语义下断言"零装饰"。

**预算从总量制改为帧预算制。** 每帧最多消耗 4 ms 的装饰时间，跨帧继续，直到本批全部铺开。原先是"总量 32 ms 用完即止"，两者差别是根本性的：前者在 50 个元素时只有最前几个有机会出现，后者会铺满整批。

**只画能诚实表达的类型。** `freedraw` 用原生路径；矩形、椭圆、菱形、frame、图片与 `embeddable` 用几何轮廓；未绑定文本用测量后的折行盒。两类元素被**有意省略**而不是近似：

- **绑定文本**。它的真实渲染位置由 `getBoundTextElementPosition` 计算，与 `x/y/width/height` 不是同一个盒子。`elementBounds` 调用 `getCommonBounds` 时未传 elementsMap，文本分支会退化为裸盒子。预览层拿不到正确位置，就不画。
- **HTML 与视频实体**。它们需要原生挂载点。这与 `canvas_inspect` 既有的"仅边界可见"是同一个诚实边界。

**降级。** `prefers-reduced-motion: reduce` 与 `document.hidden` 直接跳过装饰，不降级为瞬时显示——作品照常提交。

## 二、分组：要求送达 agent，不由引擎代劳

**结构决定：引擎不做任何自动分组。** 不按批次、不按轮次注入 group id。

理由不是"实现成本"，而是职责：一次任务需要几个语义单元，只有 agent 知道。引擎按批次自动分组会把一个刻意拆分的交付物粘成一坨，而且会让"分组"从任务判断退化为数量推断。`docs/agent-architecture.md` 既有的 "never inferred from element count or tool-batch boundaries" 继续有效。

要求改为经**两处真正送达的通道**下发：

| 通道 | 落点 |
| --- | --- |
| 工具 | `canvas_edit` 描述、`groupIds` 字段描述（Zod 与 host schema 两份） |
| 系统提示词 | `codexInstructions`（嵌入式 turn）、`GALTA_MCP_INSTRUCTIONS`（MCP `instructions`） |

`GALTA_MCP_INSTRUCTIONS` 的首 512 字符是 Discovery 可见窗口，因此绑定、保留、工具清单与分组要求全部前置在第一段内，且该段自包含。

**措辞中必须包含"不要只靠嵌套"这一条。** `relatedElementIds` 的分组展开是**一跳**，不是传递闭包：它取目标元素携带的 group id，再加入所有携带这些 id 的元素，仅此一层（frame 子元素与绑定文本走定点循环，是传递的）。若 agent 用"内层卡片组 + 外层任务组"表达归属，`move` 带 `scope: 'group'` 只会展开一层，用户拖动时行为不符预期。因此要求明确：**同一交付物直接共享同一组 id**。

**回执如实报告未分组。** 指令送达不等于遵守，因此 `canvas_edit` 的回执在**本批创建了两个以上元素且无一成组**时给出 `notes` 条目。判定依据是这批工作本身，不是数量阈值，也不是批次边界：

- 单个元素不成组 → 静默。一个元素没有"整块"可言。
- 全部成组 → 静默。
- **部分成组 → 静默。** 一批里既有成组的交付物又有独立元素，是合法的混合工作；对它唠叨就是把判断权收回到引擎手里。
- 只有更新、没有创建 → 静默。改写既有元素的组织不是本规则的范围。

这条 note 不阻止提交、不代建分组、不改动文档，只把调用方原本只能从"字段缺失"推断的事实摆到台面上。它是**告知**，不是**强制**：分组仍然是 agent 的任务判断。

## 非声明

- 不改协议。实测 `packages/runtime/src/codex.ts` 只转发 `item/agentMessage/delta` 与 `item/commandExecution/outputDelta`，工具参数**没有** delta 通道。本方案不依赖参数流，也不试图引入它：流式应用会破坏原子性、revision 校验与"一次编辑一个撤销步"。
- 不引入第二个文档状态拥有者。揭示是装饰，永不进入持久化、快照或撤销栈。
- 不做引擎侧自动分组。
- **不承诺模型必然遵守分组要求。** 送达与自检是两件事：测试能证明要求进入了模型的请求，回执的 `notes` 能让未分组这件事在下一轮可见，但两者都不能强制模型修正。这是本契约已知的、有意保留的边界——强制分组会把"一次任务需要几个语义单元"这个只有 agent 掌握的信息，替换成引擎的数量推断。

## 证据与验证

- `tests/browser/progressive-write.spec.ts`：12 项。覆盖跨帧揭示、提交前零装饰、五个中断动作零装饰、相机跟随、降级路径、真实合成像素，以及混合类型各分支被覆盖（矩形/椭圆/菱形/文本）。
- 帧预算改动后**必须重跑** `bun scripts/verify-progressive-write.ts`。`docs/evidence/progressive-write-2026-09-20/README.md` 中 "32 ms 预算、0 个 50 ms+ long task" 的结论建立在总量制之上，改制后需要重新测量并另立证据记录。
- `tests/mcp-execution.test.mjs` 断言首 512 字符包含 `groupIds`；`scripts/verify-input-context.ts` 断言分组要求出现在真实模型请求的两个通道中。
- 既有分组断言不重复造：`tests/browser/canvas-semantics.spec.ts` 覆盖嵌套组写入/读取/恢复/取消分组与 `scope: 'group'` 位移，`tests/browser/box-selection.spec.ts` 覆盖原生组选择与 frame 归属。

## 边界

- 一跳分组展开是既有行为，本次**未修改**，只是通过指令措辞规避其影响。若要支持嵌套归属的整组拖动，那是 `relatedElementIds` 的独立改动。
- 预览层不处理 clipping、group opacity、主题明暗差异与描边宽度以外的样式。视觉差异在放宽准入后更容易被察觉，若出现问题应在像素测试中显式记录，而不是靠近似掩盖。
- 首 512 字符窗口是硬预算。新增要求时必须同时压缩既有措辞，不能靠延长首段解决。
