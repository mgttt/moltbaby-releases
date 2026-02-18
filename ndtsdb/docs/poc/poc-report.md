# ndtsdb-cli POC 预研报告

**日期**: 2026-02-18  
**状态**: Phase 1 预研完成  
**负责**: 1号

---

## 1. libndtsdb 现状分析

### 1.1 当前导出的函数（36个）

**压缩/解压**:
- `gorilla_compress_f64`, `gorilla_decompress_f64`
- `delta_encode_f64`, `delta_decode_f64`

**查询/过滤**:
- `filter_f64_gt`, `filter_price_volume`
- `binary_search_i64`, `binary_search_batch_i64`

**聚合计算**:
- `aggregate_f64`, `sum_f64`, `sma_f64`, `ema_f64`
- `rolling_std_f64`, `minmax_f64`, `prefix_sum_f64`
- `ohlcv_aggregate`

**IO操作**:
- `uring_init`, `uring_destroy`, `uring_batch_read`, `uring_available`

**工具函数**:
- `int64_to_f64`, `f64_to_int64`
- `counting_sort_apply`, `counting_sort_argsort_f64`
- `gather_f64`, `gather_batch4`, `gather_i32`

### 1.2 缺失的高级 API

当前 libndts.so **不是**完整的数据库引擎，只是**底层计算库**。

MVP 需要新增的 C API:

| 函数 | 用途 |
|------|------|
| `ndtsdb_open(path)` | 打开/创建数据库文件 |
| `ndtsdb_close(db)` | 关闭数据库 |
| `ndtsdb_insert(db, row)` | 插入单条Kline |
| `ndtsdb_insert_batch(db, rows[], n)` | 批量插入 |
| `ndtsdb_query(db, query)` | 查询数据 |
| `ndtsdb_free_result(r)` | 释放查询结果 |

### 1.3 静态库问题

- **现状**: 只有动态库 `libndts.so` (~27KB)
- **需要**: 编译为静态库 `.a` 以便 QuickJS 静态链接

---

## 2. 技术路径选择

### 方案 A: 扩展现有 libndts (推荐)

在 `native/ndts.c` 中新增上述 6 个高级 API，编译为静态库。

**优点**: 复用现有压缩/查询逻辑  
**工作量**: 约 2-3 天

### 方案 B: 新建 libndts-full

从头构建完整的数据库引擎。

**缺点**: 工作量巨大，不推荐 MVP 阶段

---

## 3. QuickJS 集成验证

QuickJS 静态链接后约 **1MB**，完全满足 ~2MB 目标。

### 绑定层设计

```c
// C -> QuickJS 绑定
static JSValue js_ndtsdb_open(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *path = JS_ToCString(ctx, argv[0]);
    NDTSDB *db = ndtsdb_open(path);
    return JS_NewUint32(ctx, (uint32_t)db);
}
```

---

## 4. 已完成 (2026-02-18)

✅ **1号完成**: 新增 6 个高级 API
- `ndtsdb_open/close` - 打开/关闭数据库
- `ndtsdb_insert/insert_batch` - 插入单条/批量
- `ndtsdb_query` - 查询K线
- `ndtsdb_get_latest_timestamp` - 获取最新时间戳
- 编译验证通过，API已导出

## 5. 下一步行动

1. **构建**: 编译为静态库 `libndts.a` (待)
2. **006**: QuickJS 集成 POC
3. **测试**: insert/query 性能基准

---

## 6. 已完成 (2026-02-18 20:04)

✅ **QuickJS 环境就绪**:
- 下载并编译 QuickJS 2024-01-13
- 安装到 ~/.local/bin/qjs
- REPL 测试通过

## 7. 风险与依赖

| 风险 | 缓解 |
|------|------|
| C API 设计需与 TS 版对齐 | 参考 `quant-lab/src/storage/ndtsdb.ts` |
| 编译静态库可能失败 | 使用 Zig 交叉编译 |
| 性能不达标 | 瓶颈在 IO，后续优化 |
