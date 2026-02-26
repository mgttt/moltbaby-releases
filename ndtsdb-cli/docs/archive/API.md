# ndtsdb-cli API 参考文档

> ndtsdb-cli JavaScript API 完整参考

## 概述

ndtsdb-cli 使用 QuickJS 嵌入式引擎，提供 ES2020 语法支持。所有 API 通过 `ndtsdb` 模块访问。

```javascript
import * as ndtsdb from 'ndtsdb';
```

## 类型定义

### KlineRow

K线数据行结构。

```typescript
interface KlineRow {
  timestamp: bigint | number;  // 毫秒时间戳（推荐使用 BigInt）
  open: number;                // 开盘价
  high: number;                // 最高价
  low: number;                 // 最低价
  close: number;               // 收盘价
  volume: number;              // 交易量
}
```

**字段说明**：

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `timestamp` | `bigint \| number` | ✅ | 毫秒时间戳，推荐使用 BigInt 避免精度丢失 |
| `open` | `number` | ✅ | 开盘价 |
| `high` | `number` | ✅ | 最高价 |
| `low` | `number` | ✅ | 最低价 |
| `close` | `number` | ✅ | 收盘价 |
| `volume` | `number` | ✅ | 交易量 |

### DbHandle

数据库句柄，是一个数字类型。

```typescript
type DbHandle = number;
```

## 核心函数

### ndtsdb.open()

打开或创建数据库文件。

```typescript
function open(path: string): DbHandle
```

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `path` | `string` | ✅ | 数据库文件路径（如 `./data/BTC.ndts`） |

**返回值**：
- 成功：返回数据库句柄（正整数）
- 失败：抛出异常

**示例**：

```javascript
import * as ndtsdb from 'ndtsdb';

// 打开数据库
const handle = ndtsdb.open('./data/BTCUSDT-1h.ndts');
console.log(`数据库句柄: ${handle}`);

// 注意：目录必须存在，否则会失败
// 建议先创建目录
```

**错误处理**：

```javascript
try {
  const handle = ndtsdb.open('./data/BTC.ndts');
  console.log('数据库打开成功');
} catch (e) {
  console.error(`打开数据库失败: ${e.message}`);
}
```

**注意事项**：
1. 如果文件不存在，会自动创建
2. 父目录必须存在，否则会失败
3. 建议使用 `.ndts` 作为文件扩展名

---

### ndtsdb.insert()

插入单条K线数据。

```typescript
function insert(
  handle: DbHandle,
  symbol: string,
  interval: string,
  row: KlineRow
): number
```

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `handle` | `DbHandle` | ✅ | 数据库句柄（由 `open()` 返回） |
| `symbol` | `string` | ✅ | 交易对（如 `'BTCUSDT'`、`'ETHUSDT'`） |
| `interval` | `string` | ✅ | K线周期（如 `'1m'`、`'5m'`、`'1h'`、`'1d'`） |
| `row` | `KlineRow` | ✅ | K线数据对象 |

**返回值**：
- `0`：插入成功
- `-1`：插入失败

**示例**：

```javascript
import * as ndtsdb from 'ndtsdb';

const handle = ndtsdb.open('./data/BTCUSDT-1h.ndts');

// 插入单条数据
const result = ndtsdb.insert(handle, 'BTCUSDT', '1h', {
  timestamp: 1700000000000n,  // 使用 BigInt
  open: 50000.0,
  high: 51000.0,
  low: 49500.0,
  close: 50500.0,
  volume: 1000000.0
});

if (result === 0) {
  console.log('插入成功');
} else {
  console.error('插入失败');
}
```

**批量插入示例**：

```javascript
import * as ndtsdb from 'ndtsdb';

const handle = ndtsdb.open('./data/ETHUSDT-1h.ndts');
const startTime = 1700000000000n;

// 批量插入1000条数据
for (let i = 0; i < 1000; i++) {
  ndtsdb.insert(handle, 'ETHUSDT', '1h', {
    timestamp: startTime + BigInt(i * 3600000),  // 每小时一条
    open: 3000.0 + i,
    high: 3010.0 + i,
    low: 2990.0 + i,
    close: 3005.0 + i,
    volume: 1000.0 + i
  });
}

console.log('批量插入完成');
```

**注意事项**：
1. `timestamp` 推荐使用 BigInt 避免大数精度丢失
2. 数据按时间戳排序存储
3. 相同时间戳的数据会被覆盖

---

### ndtsdb.query()

查询K线数据。

```typescript
function query(
  handle: DbHandle,
  symbol: string,
  interval: string,
  start: bigint | number,
  end: bigint | number,
  limit?: number
): KlineRow[]
```

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `handle` | `DbHandle` | ✅ | 数据库句柄 |
| `symbol` | `string` | ✅ | 交易对 |
| `interval` | `string` | ✅ | K线周期 |
| `start` | `bigint \| number` | ✅ | 开始时间戳（毫秒，包含） |
| `end` | `bigint \| number` | ✅ | 结束时间戳（毫秒，不包含） |
| `limit` | `number` | ❌ | 返回条数限制（默认1000） |

**返回值**：
- 成功：返回 `KlineRow[]` 数组
- 失败：返回空数组 `[]`

**示例**：

```javascript
import * as ndtsdb from 'ndtsdb';

const handle = ndtsdb.open('./data/BTCUSDT-1h.ndts');

// 查询时间范围内的数据
const startTime = 1700000000000n;
const endTime = 1700086400000n;

const rows = ndtsdb.query(
  handle,
  'BTCUSDT',
  '1h',
  startTime,
  endTime
);

console.log(`查询到 ${rows.length} 条数据`);

// 遍历结果
for (const row of rows) {
  console.log(`时间: ${row.timestamp}, 收盘价: ${row.close}`);
}
```

**带限制的查询**：

```javascript
// 只返回最近100条数据
const rows = ndtsdb.query(
  handle,
  'BTCUSDT',
  '1h',
  0n,
  9999999999999n,
  100
);

console.log(`返回 ${rows.length} 条数据`);
```

**查询所有数据**：

```javascript
// 使用极大的时间范围查询所有数据
const allRows = ndtsdb.query(
  handle,
  'BTCUSDT',
  '1h',
  0n,
  9999999999999n
);

console.log(`总数据量: ${allRows.length}`);
```

**注意事项**：
1. 时间范围是 `[start, end)`，即包含 start，不包含 end
2. 返回的数据按时间戳升序排列
3. 如果没有匹配的数据，返回空数组

---

### ndtsdb.close()

关闭数据库连接。

```typescript
function close(handle: DbHandle): void
```

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `handle` | `DbHandle` | ✅ | 数据库句柄 |

**返回值**：无

**示例**：

```javascript
import * as ndtsdb from 'ndtsdb';

const handle = ndtsdb.open('./data/BTCUSDT-1h.ndts');

// 使用数据库...
ndtsdb.insert(handle, 'BTCUSDT', '1h', { /* ... */ });
const rows = ndtsdb.query(handle, 'BTCUSDT', '1h', 0n, 9999999999999n);

// 使用完毕后关闭
ndtsdb.close(handle);
console.log('数据库已关闭');
```

**最佳实践**：

```javascript
import * as ndtsdb from 'ndtsdb';

let handle;
try {
  handle = ndtsdb.open('./data/BTC.ndts');
  // 执行数据库操作...
} finally {
  if (handle !== undefined) {
    ndtsdb.close(handle);
  }
}
```

## 完整示例

### 基础使用

```javascript
import * as ndtsdb from 'ndtsdb';

// 打开数据库
const handle = ndtsdb.open('./data/ETHUSDT-1h.ndts');

// 写入数据
const startTime = 1700000000000n;
for (let i = 0; i < 100; i++) {
  ndtsdb.insert(handle, 'ETHUSDT', '1h', {
    timestamp: startTime + BigInt(i * 3600000),
    open: 3000.0 + i,
    high: 3010.0 + i,
    low: 2990.0 + i,
    close: 3005.0 + i,
    volume: 1000.0 + i
  });
}

// 查询数据
const rows = ndtsdb.query(
  handle,
  'ETHUSDT',
  '1h',
  startTime,
  startTime + 100n * 3600000n
);

console.log(`写入100条，查询到 ${rows.length} 条`);

// 关闭数据库
ndtsdb.close(handle);
```

### 错误处理

```javascript
import * as ndtsdb from 'ndtsdb';

function safeInsert(handle, symbol, interval, row) {
  const result = ndtsdb.insert(handle, symbol, interval, row);
  if (result !== 0) {
    console.error(`插入失败: ${symbol} ${interval} @ ${row.timestamp}`);
    return false;
  }
  return true;
}

// 使用示例
const handle = ndtsdb.open('./data/test.ndts');

const success = safeInsert(handle, 'BTCUSDT', '1h', {
  timestamp: 1700000000000n,
  open: 50000,
  high: 51000,
  low: 49500,
  close: 50500,
  volume: 1000000
});

if (!success) {
  console.error('数据插入失败，请检查数据格式');
}

ndtsdb.close(handle);
```

## 错误处理约定

### 错误类型

| 函数 | 成功返回 | 失败返回 | 异常情况 |
|------|---------|---------|---------|
| `open()` | 句柄（正整数） | - | 文件无法创建/读取时抛出异常 |
| `insert()` | `0` | `-1` | 不抛出异常 |
| `query()` | 数据数组 | 空数组 `[]` | 不抛出异常 |
| `close()` | 无 | 无 | 不抛出异常 |

### 常见错误

1. **目录不存在**
   ```javascript
   // 错误：目录 ./data/ 不存在
   ndtsdb.open('./data/BTC.ndts');  // 抛出异常
   ```

2. **无效句柄**
   ```javascript
   // 错误：使用已关闭的句柄
   const handle = ndtsdb.open('./data/BTC.ndts');
   ndtsdb.close(handle);
   ndtsdb.query(handle, 'BTC', '1h', 0n, 9999999999999n);  // 可能失败
   ```

3. **类型错误**
   ```javascript
   // 错误：timestamp 必须是数字或 BigInt
   ndtsdb.insert(handle, 'BTC', '1h', {
     timestamp: '2024-01-01',  // 错误：字符串
     // ...
   });
   ```

## 标准库

ndtsdb-cli 内置以下标准库：

### console

```javascript
console.log(...args);    // 标准输出
console.warn(...args);   // 警告输出
console.error(...args);  // 错误输出
```

### fs（基础文件操作）

```javascript
// 读取文件
const content = fs.readFile('./data.json');

// 写入文件
fs.writeFile('./output.txt', 'Hello, World!');
```

## 版本兼容性

- ndtsdb-cli v0.1.0+
- ES2020 语法支持
- QuickJS 引擎

## 相关文档

- [README.md](../README.md) - 项目概述和快速开始
- [FAQ.md](./FAQ.md) - 常见问题
- [benchmark.md](./benchmark.md) - 性能基准
