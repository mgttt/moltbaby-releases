# archived/ - 废弃文件

## GalesStrategy.ts（已废弃 2026-02-21）

**废弃原因**：

策略层唯一真相源已确认为 `quant-lab/strategies/gales-simple.js`（QuickJS沙箱版）。
GalesStrategy.ts 是早期 TypeScript 版本，与生产版本已严重背离（JS版 2646行，TS版 542行，缺失 40+ 实盘功能）。

**决策依据**：

总裁决策（2026-02-21）：策略必须运行在 QuickJS 沙箱 JS 中，热更新是核心需求。

**正确使用**：

- 策略层改进 → `quant-lab/strategies/gales-simple.js`
- 框架层改进 → `quant-lab/src/execution/`, `quant-lab/src/engine/`
- 集成参考 → `quant-lab/docs/framework-integration.md`
