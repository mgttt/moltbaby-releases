# ndtsdb-cli ↔ ndtsdb 互操作性测试

## 测试结构

本目录包含5个测试场景，验证CLI（QuickJS）与Bun实现的数据格式一致性：

### 场景1：内部一致性
- **cli/write-test.js**: CLI写入1000条BTCUSDT数据
- **cli/verify-read-cli.js**: CLI读取并验证自身写入的数据
- **bun/write-test.ts**: Bun写入1000条ETHUSDT数据
- **bun/verify-read.ts**: Bun读取并验证自身写入的数据

### 场景2：跨实现互操作（Phase 1+2）
- **Phase 1**: CLI写入 → Bun读取
  - cli/write-test.js
  - bun/verify-read-cli.ts（验证CLI写入的BTCUSDT）
- **Phase 2**: Bun写入 → CLI读取
  - bun/write-test.ts
  - cli/verify-read-cli.js（验证Bun写入的ETHUSDT）
- **bun/append-data.ts**: Bun追加数据，CLI验证总数

### 场景3：并发读
- **cli/read-loop.js**: CLI循环读取（10秒）
- **bun/read-loop.ts**: Bun循环读取（10秒）

### 场景4：边界情况
- **bun/write-large.ts**: 大数据量测试（100万条）
- **cli/query-last.js**: 查询最后一条记录
- **cli/write-edge.js**: 边界值测试
- **bun/verify-edge.ts**: 验证边界值
- **cli/query-empty.js**: 空查询测试
- **bun/query-empty.ts**: Bun空查询

### 场景5：文件格式验证
- **cli/write-sample.js**: CLI写入样本数据
- **bun/write-sample.ts**: Bun写入样本数据
- 对比文件头部magic/version一致性

## 运行方式

```bash
# 运行完整互操作测试套件
cd ndtsdb-cli/tests/interop
NDTS_DATA_DIR=/tmp/test-data bash run-interop-tests.sh

# 单独运行某个场景
NDTS_DATA_DIR=/tmp/test-data ../../ndtsdb-cli cli/write-test.js
NDTS_DATA_DIR=/tmp/test-data bun bun/verify-read-cli.ts
```

## 环境要求

- **ndtsdb-cli**: 已编译的CLI二进制（`../../ndtsdb-cli`）
- **Bun**: JavaScript运行时（`bun --version`）
- **NDTS_DATA_DIR**: 测试数据目录（默认`/tmp/ndtsdb-interop-test-$$`）

## 已知限制

1. **QuickJS中process.env**: 需要在main.c中注入环境变量
   - 当前通过`NDTS_DATA_DIR`环境变量传递
   - CLI脚本读取`process.env.NDTS_DATA_DIR`

2. **verify-read-cli.js查询ETHUSDT**:
   - Phase 2测试验证Bun写入的ETHUSDT数据
   - Symbol和interval必须与write-test.ts一致（ETHUSDT/1h）

3. **文件大小差异**:
   - CLI写入文件约1.7KB（Phase 1格式）
   - Bun写入文件约4.2KB~5.6KB（包含4096字节header区）
   - Phase 2已修复：CLI可读取两种格式

4. **BigInt处理**:
   - QuickJS需要`JS_ToInt64Ext`处理BigInt timestamp
   - 已在`qjs_ndtsdb.c`中修复

## 测试数据格式

### PartitionedTable格式（Bun标准）
```
[0x0000] magic: "NDTS" (4字节)
[0x0004] header_len: uint32LE
[0x0008] header_json: header_len字节
[0x1000] CRC32: uint32LE
[0x1004] chunks开始
```

### 列顺序
- symbol (int32字典ID)
- interval (int32字典ID)
- timestamp (int64)
- open (float64)
- high (float64)
- low (float64)
- close (float64)
- volume (float64)

## 验收标准

- ✅ CLI内部一致性：CLI写入→CLI读取通过
- ✅ Bun内部一致性：Bun写入→Bun读取通过
- ✅ Phase 1：CLI写入→Bun读取1000条
- ✅ Phase 2：Bun写入→CLI读取1000条
- ✅ dirty标志：只读操作不覆盖原文件

## 相关Commit

- `b41dfbfc0`: Phase 1（CLI写出PartitionedTable格式）
- `7216f81c6`: Phase 2 + dirty标志修复
- `5b539d292`: libndts.a更新
