# Quant-Lib 开发路线图

> **版本**: v0.3.0 (2026-02-10)  
> **底层**: ndtsdb v0.9.3.10

---

## 🎯 核心完成度

| 模块 | 状态 | 说明 |
|------|------|------|
| **数据存储** | ✅ 100% | KlineDatabase（分区表 + 压缩） |
| **数据获取** | ✅ 80% | Binance ✅ / TradingView 部分 / Investing 待 |
| **实时指标** | ✅ 100% | StreamingIndicators（SMA/EMA/StdDev/Min/Max） |
| **技术指标** | ⏳ 30% | 基础均线已有，RSI/MACD/BB 待补充 |

---

## 📋 Phase 1: 核心架构 ✅ **已完成**

- [x] 项目结构设计
- [x] 类型定义系统（types/kline.ts + types/common.ts）
- [x] Provider 基类（providers/base.ts）
- [x] Binance Provider 完整实现
- [x] **KlineDatabase 分区表迁移**（2026-02-10 ✅）
  - 哈希分区：symbol_id % 100
  - 文件数：9000 → 300（减少 97%）
  - 启用压缩：Delta + Gorilla
- [x] **StreamingIndicators 实时指标**（2026-02-10 ✅）
  - SMA/EMA/StdDev/Min/Max
  - 多 symbol 管理 + 批量回填
- [x] 基础示例 + 文档

---

## 📋 Phase 2: 完善数据提供者

### 外部数据源现状（阻塞中）

| Provider | 状态 | 阻塞原因 |
|----------|------|----------|
| **TradingView** | ⏸️ 登录模式阻塞 | 2FA 短信发送至香港手机号，接收不稳定，预计 2026-03-04 恢复 |
| **Futu** | ⏸️ 功能受限 | 1000 产品/月上限，无数字货币历史数据 |
| **Binance** | ✅ 可用 | 仅限加密货币，部分地区需代理 |

**应对策略**: 开发 **Virtual Market Generator**（虚拟市场数据生成器），用模拟数据测试 ndtsdb 和策略系统。

### TradingView Provider
- [x] `providers/tradingview.ts`
  - [x] WebSocket 客户端基础 ✅
  - [x] 登录模式支持 ✅（代码就绪，2FA 阻塞）
  - [x] 匿名模式支持（免登录）✅
  - [x] 双模式自动 fallback ✅
  - [x] 实时订阅功能 ✅
  - [x] 协议消息解析 ✅

### Investing.com Provider
- [ ] `providers/investing.ts` ⏸️ 低优先级

### Virtual Market Generator（新增）
- [ ] `providers/virtual-market.ts`
  - [ ] 模拟真实市场特征（趋势、波动、跳空、成交量）
  - [ ] 多币种生成（BTC、ETH 等虚拟产品）
  - [ ] 可调参数（波动率、趋势强度、均值回归）
  - [ ] 历史数据批量生成（支撑回测）
  - [ ] 实时流模拟（支撑实时策略）

**目标**: 
- 测试 ndtsdb 压缩率、性能、SQL 接口
- 为策略回测提供数据基础
- 不依赖外部 API，随时可用

---

## 📋 Phase 3: 存储层

### DuckDB 统一接口
- [ ] `storage/database.ts`
  - [ ] 统一 schema 设计
  - [ ] K线数据存储
  - [ ] 增量更新逻辑
  - [ ] 索引优化
  - [ ] 查询API

**迁移来源**: `tv-iv-collector/src/db/database.ts`

### Schema 设计
- [ ] `storage/schema.sql`
  - [ ] `klines` 表（主表）
  - [ ] `sync_metadata` 表（同步元数据）
  - [ ] `volatility_15m` 视图（波动率视图）
  - [ ] 索引和约束

### 缓存层
- [ ] `storage/cache.ts`
  - [ ] 内存缓存（Map/LRU）
  - [ ] Redis 支持（可选）
  - [ ] TTL 管理
  - [ ] 缓存穿透/雪崩保护

---

## 📋 Phase 4: 工具函数

### HTTP 工具
- [ ] `utils/http.ts`
  - [ ] 通用 HTTP 客户端
  - [ ] 代理支持
  - [ ] 超时/重试机制
  - [ ] 速率限制处理

### WebSocket 工具
- [ ] `utils/websocket.ts`
  - [ ] WebSocket 客户端封装
  - [ ] 自动重连
  - [ ] 心跳机制
  - [ ] 消息队列

### 时间处理
- [ ] `utils/time.ts`
  - [ ] Unix ↔ ISO 转换
  - [ ] 时区处理（UTC/北京时间）
  - [ ] 时间范围计算
  - [ ] K线数量计算

### 格式转换
- [ ] `utils/format.ts`
  - [ ] Binance → 统一格式
  - [ ] TradingView → 统一格式
  - [ ] Investing → 统一格式
  - [ ] CSV/JSON 导出

### 符号映射
- [ ] `utils/symbols.ts`
  - [ ] 交易对标准化
  - [ ] 交易所符号映射
  - [ ] 币种别名处理（如 MATIC → POL）

---

## 📋 Phase 5: 数据分析

### 波动率计算
- [ ] `analytics/volatility.ts`
  - [ ] 多周期标准化波动率
  - [ ] 对数收益率计算
  - [ ] 滚动窗口标准差
  - [ ] 排行榜生成

**迁移来源**: `tv-iv-collector/scripts/query-multi-volatility.ts`

### 技术指标
- [ ] `analytics/indicators.ts`
  - [ ] 移动平均（SMA/EMA/WMA）
  - [ ] MACD
  - [ ] RSI
  - [ ] 布林带
  - [ ] ATR

### 统计工具
- [ ] `analytics/stats.ts`
  - [ ] 相关性分析
  - [ ] 回归分析
  - [ ] 分布统计
  - [ ] 异常值检测

---

## 📋 Phase 6: 高级功能

### 数据回填
- [ ] 批量拉取历史数据
- [ ] 分段下载（突破 1000 条限制）
- [ ] 断点续传
- [ ] 进度监控

### 实时流处理
- [ ] 实时K线聚合
- [ ] 指标实时计算
- [ ] 事件触发器
- [ ] WebSocket 推送

### 策略回测框架
- [ ] 回测引擎
- [ ] 绩效指标计算
- [ ] 风险管理
- [ ] 报告生成

---

## 📋 Phase 7: 测试与文档

### 单元测试
- [ ] `tests/types/*.test.ts`
- [ ] `tests/providers/*.test.ts`
- [ ] `tests/storage/*.test.ts`
- [ ] `tests/utils/*.test.ts`
- [ ] `tests/analytics/*.test.ts`

### 集成测试
- [ ] 端到端数据采集测试
- [ ] 多数据源对比测试
- [ ] 性能测试

### 文档
- [ ] API 文档（JSDoc）
- [ ] 使用教程
- [ ] 最佳实践
- [ ] 常见问题

---

## 🎯 下一步优先级

### 高优先级（本周）
1. ✅ KlineDatabase 分区表（已完成）
2. ✅ StreamingIndicators（已完成）
3. ⏳ 技术指标库补充（RSI/MACD/BB）
4. ⏳ TradingView Provider 完善

### 中优先级
5. Investing.com Provider
6. HTTP/WebSocket 工具封装
7. 缓存层实现

### 低优先级
8. 完整测试覆盖
9. 性能优化
10. 文档完善

---

## 📝 迁移状态

**从旧项目迁移的代码**：
- ✅ Binance Provider（tv-iv-collector）
- ⏳ TradingView Provider（部分完成）
- ⏳ 波动率计算（analytics/volatility.ts 待完善）
- ⏳ Investing.com Provider

---

*最后更新: 2026-02-10*  
*维护者: OpenClaw 🦀*
