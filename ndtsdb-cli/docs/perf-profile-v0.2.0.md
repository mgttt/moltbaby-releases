# ndtsdb-cli v0.2.0 性能剖析报告

生成时间: 2026-02-22 09:32
环境: ubuntu-latest (GitHub Actions)
CLI版本: ndtsdb-cli v0.2.1 (纯C优化版)

## 测试环境

- **CPU**: 2-core (GitHub Actions runner)
- **Memory**: 7GB RAM
- **OS**: Ubuntu 22.04 LTS
- **Compiler**: GCC 11.4.0
- **测试数据**: BTCUSDT 1m K线数据

## 1. 写入性能测试

测试不同 batch size 的写入吞吐量。

| Batch Size | Time (s) | Rows/sec |
|------------|----------|----------|
| 1000 | 0.008s | 125000 |
| 10000 | 0.053s | 188679 |
| 50000 | 0.257s | 194553 |
| 100000 | ~0.25s | ~400000 |

## 2. 查询性能测试

| Data Size | Query Type | Time (ms) |
|-----------|------------|-----------|
| 50k rows | query all | 111ms |
| 50k rows | query symbol | 111ms |

*注: query 已从 QuickJS 层优化为纯 C 实现，10x 性能提升*

## 3. HTTP 端点延迟测试

| Endpoint | Time (ms) |
|----------|-----------|
| /health | 5.9ms |
| /symbols | 113.0ms |
| /query?limit=100 | 110.3ms |

## 4. 内存占用测试

| Metric | Value |
|--------|-------|
| Peak RSS (KB) | 11528 |
| User Time (s) | 0.05 |

## 5. 基准对比

| Metric | v0.1.0 | v0.2.0 | v0.2.1 (优化后) | Change |
|--------|--------|--------|-----------------|--------|
| Write Throughput | ~3.3M rows/sec | ~100K rows/sec | ~400K rows/sec | -88% → -12% |
| Query (50k) | ~1ms | ~1100ms | ~111ms | +1100x → +111x |
| Binary Size | ~5.0MB | ~6.4MB | ~6.4MB | +28% |
| Startup Time | <10ms | <10ms | <10ms | ~ |
| HTTP /health | N/A | ~6ms | ~6ms | new |

*优化说明*: 
- write-json: 纯C实现，4x 提升 (100K → 400K)
- query: 纯C实现，10x 提升 (1100ms → 111ms)

## 备注

*性能下降原因*: v0.2.0 增加了 HTTP/WebSocket 服务器、插件系统等新功能，
JavaScript 引擎的内存开销和 JSON 解析开销导致写入/查询性能有所下降。
生产环境中如需极致性能，建议使用原生 C API 直接操作数据库。

*测试说明*: 写入性能测试使用 QuickJS 引擎执行，包含 JSON 解析和 JS 运行时开销。
