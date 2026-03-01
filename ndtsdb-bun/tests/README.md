# ndtsdb 测试套件

## 快速开始

```bash
# 冒烟测试 (快速验证核心功能)
bun run test:smoke

# Bun 原生测试 (完整单元测试)
bun test

# 完整测试套件 (所有模块)
bun run test:suite

# 全部测试
bun run test:all
```

## 测试文件说明

| 测试文件 | 用途 | 运行时间 |
|----------|------|----------|
| `smoke-test.ts` | 快速冒烟测试，验证核心功能可用 | ~1s |
| `ndtsdb.test.ts` | Bun 原生单元测试 (bun:test) | ~5s |
| `test-suite.ts` | 完整测试套件，覆盖所有模块 | ~10s |

## 专项测试

```bash
# 增量写入 + CRC32
bun tests/append-test.ts

# 多路归并 + ASOF JOIN
bun tests/merge-stream.ts

# 内存映射
bun tests/mmap-basic.ts

# SQL 解析和执行
bun tests/sql-test.ts

# 时序查询 (SAMPLE BY, OHLCV, 窗口函数)
bun tests/query-test.ts

# 索引 (Roaring Bitmap, BTree)
bun tests/index-test.ts

# FFI 性能
bun tests/ffi-benchmark.ts

# 全市场 3000 产品基准
bun run benchmark:3000
```

## 测试覆盖范围

### ✅ ColumnarTable
- [x] 空表创建
- [x] 单行/批量插入
- [x] 容量自动扩容
- [x] 文件存取 round-trip
- [x] 类型自动转换

### ✅ AppendWriter
- [x] 创建新文件
- [x] 多 chunk 追加
- [x] 重新打开追加
- [x] CRC32 完整性校验

### ✅ MmapPool
- [x] 多文件映射
- [x] zero-copy 读取验证
- [x] 列数据访问

### ✅ MmapMergeStream
- [x] MinHeap 归并排序正确性
- [x] Tick-level 回放
- [x] Snapshot 回放 (ASOF JOIN)
- [x] Seek 跳转
- [x] 时间范围过滤

### ✅ SQL
- [x] SELECT 解析和执行
- [x] WHERE 过滤
- [x] ORDER BY / LIMIT
- [x] UPSERT

### ✅ 时序查询
- [x] SAMPLE BY 时间桶聚合
- [x] OHLCV K线生成
- [x] SMA/EMA 移动平均
- [x] LATEST ON

### ✅ 索引
- [x] RoaringBitmap 添加/查询

### ✅ FFI
- [x] libndts 加载检查
- [x] binarySearchI64

## 添加新测试

### 使用 bun:test (推荐)

```typescript
import { describe, it, expect } from 'bun:test';
import { ColumnarTable } from '../src/columnar.js';

describe('My Feature', () => {
  it('should work', () => {
    const table = new ColumnarTable([{ name: 'v', type: 'float64' }]);
    expect(table.getRowCount()).toBe(0);
  });
});
```

### 使用简单测试风格

```typescript
import { ColumnarTable } from '../src/columnar.js';

console.log('🧪 My Test\n');

// Test 1
const table = new ColumnarTable([{ name: 'v', type: 'float64' }]);
console.log(table.getRowCount() === 0 ? '✅ Empty table' : '❌ Failed');
```

## CI/CD

在 CI 中运行测试：

```bash
# 快速验证
bun run test:smoke

# 完整测试
bun test

# 失败时退出码非零
```
