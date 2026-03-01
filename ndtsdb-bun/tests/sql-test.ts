// ============================================================
// SQL 测试 - 验证解析器和执行器
// ============================================================

import { parseSQL, SQLParser } from '../src/sql/parser.js';
import { SQLExecutor } from '../src/sql/executor.js';
import { ColumnarTable } from '../src/columnar.js';

console.log('🚀 SQL 解析器和执行器测试\n');
console.log('=' .repeat(60));

// 测试 1: SQL 解析
console.log('\n📋 测试 1: SQL 解析\n');

const testQueries = [
  'SELECT * FROM trades',
  'SELECT symbol, price FROM trades WHERE price > 100',
  'SELECT symbol, AVG(price) FROM trades GROUP BY symbol',
  'SELECT * FROM trades ORDER BY price DESC LIMIT 10',
  'SELECT * FROM trades WHERE symbol = \'AAPL\' AND price > 100',
  'INSERT INTO trades (symbol, price) VALUES (\'AAPL\', 150.5)',
  // advanced
  "WITH t AS (SELECT price AS a FROM trades) SELECT a FROM t ORDER BY a DESC LIMIT 1",
  "SELECT 'A' || 'B' as s FROM trades LIMIT 1",
  "SELECT ROUND(price, 2) as r, SQRT(4) as s FROM trades LIMIT 1",
  "SELECT * FROM trades WHERE (symbol, volume) IN ((0,1000),(1,2000))",
];

for (const sql of testQueries) {
  try {
    const result = parseSQL(sql);
    console.log(`✅ ${sql}`);
    console.log(`   类型: ${result.type}`);
    if (result.type === 'SELECT') {
      console.log(`   列: ${result.data.columns.join(', ')}`);
      console.log(`   表: ${result.data.from}`);
      if (result.data.where) {
        console.log(`   条件: ${JSON.stringify(result.data.where)}`);
      }
    }
    console.log('');
  } catch (e: any) {
    console.log(`❌ ${sql}`);
    console.log(`   错误: ${e.message}\n`);
  }
}

// 测试 2: SQL 执行
console.log('\n📊 测试 2: SQL 执行\n');

// 创建测试表
const table = new ColumnarTable([
  { name: 'timestamp', type: 'int64' },
  { name: 'symbol', type: 'int32' },
  { name: 'price', type: 'float64' },
  { name: 'volume', type: 'int32' }
]);

// 插入测试数据
const now = BigInt(Date.now());
table.appendBatch([
  { timestamp: now, symbol: 0, price: 100.5, volume: 1000 },
  { timestamp: now + 1000n, symbol: 1, price: 150.2, volume: 2000 },
  { timestamp: now + 2000n, symbol: 0, price: 101.0, volume: 1500 },
  { timestamp: now + 3000n, symbol: 1, price: 149.8, volume: 3000 },
  { timestamp: now + 4000n, symbol: 0, price: 102.5, volume: 1200 },
]);

// 创建执行器
const executor = new SQLExecutor();
executor.registerTable('trades', table);

// 执行查询
const executeQuery = (sql: string) => {
  try {
    const parsed = parseSQL(sql);
    const start = performance.now();
    const result = executor.execute(parsed);
    const time = performance.now() - start;
    
    console.log(`✅ ${sql}`);
    console.log(`   耗时: ${time.toFixed(2)}ms`);
    
    if ('rows' in result) {
      console.log(`   返回: ${result.rowCount} 行`);
      console.log(`   列: ${result.columns.join(', ')}`);
      console.log(`   数据:`, result.rows.slice(0, 3));
    } else {
      console.log(`   影响: ${result} 行`);
    }
    console.log('');
  } catch (e: any) {
    console.log(`❌ ${sql}`);
    console.log(`   错误: ${e.message}\n`);
  }
};

executeQuery('SELECT * FROM trades');
executeQuery('SELECT symbol, price FROM trades WHERE price > 100');
executeQuery('SELECT * FROM trades ORDER BY price DESC LIMIT 3');

// 测试 2.0: 复杂 WHERE（括号 + AND/OR/NOT 优先级）
executeQuery("SELECT symbol, price FROM trades WHERE (symbol = 0 AND price > 101) OR (symbol = 1 AND price > 150)");
executeQuery("SELECT symbol, price FROM trades WHERE NOT (symbol = 0 AND price > 101)");

// 测试 2.1: CTE + 多列 IN + 字符串拼接
console.log('\n🧩 测试 2.1: CTE + 多列 IN + 字符串拼接\n');

const klines = new ColumnarTable([
  { name: 'base_currency', type: 'string' },
  { name: 'quote_currency', type: 'string' },
  { name: 'timestamp', type: 'int64' },
  { name: 'close', type: 'float64' },
]);

klines.appendBatch([
  { base_currency: 'AAPL', quote_currency: 'USD', timestamp: now + 0n, close: 100 },
  { base_currency: 'AAPL', quote_currency: 'USD', timestamp: now + 1n, close: 101 },
  { base_currency: 'TSLA', quote_currency: 'USD', timestamp: now + 0n, close: 200 },
  { base_currency: 'TSLA', quote_currency: 'USD', timestamp: now + 1n, close: 220 },
  { base_currency: 'MSFT', quote_currency: 'USD', timestamp: now + 1n, close: 300 },
]);

executor.registerTable('klines', klines);

executeQuery(`
WITH periods AS (
  SELECT
    base_currency,
    quote_currency,
    close AS price,
    timestamp,
    ROW_NUMBER() OVER (PARTITION BY base_currency, quote_currency ORDER BY timestamp DESC) AS rn
  FROM klines
  WHERE (base_currency, quote_currency) IN (('AAPL','USD'),('TSLA','USD'))
)
SELECT
  base_currency || '/' || quote_currency AS symbol,
  ROUND(price, 2) AS price2
FROM periods
WHERE rn = 1
ORDER BY symbol ASC
`);

// 测试 3: 性能测试
console.log('\n⚡ 测试 3: 性能测试 (10万行)\n');

const bigTable = new ColumnarTable([
  { name: 'id', type: 'int32' },
  { name: 'value', type: 'float64' }
]);

// 生成 10万行数据
const bigData = [];
for (let i = 0; i < 100000; i++) {
  bigData.push({ id: i, value: Math.random() * 1000 });
}
bigTable.appendBatch(bigData);
executor.registerTable('big_table', bigTable);

const perfStart = performance.now();
const perfResult = executor.execute(parseSQL('SELECT * FROM big_table WHERE value > 500'));
const perfTime = performance.now() - perfStart;

console.log(`✅ SELECT * FROM big_table WHERE value > 500`);
console.log(`   耗时: ${perfTime.toFixed(2)}ms`);
console.log(`   扫描: 100000 行`);
console.log(`   返回: ${(perfResult as any).rowCount} 行`);
console.log(`   速度: ${(100000 / perfTime * 1000 / 1000000).toFixed(1)}M rows/s`);

// 测试 2.2: Inline Window + PARTITION BY fast-path（波动率脚本模式）
console.log('\n🧩 测试 2.2: Inline Window (STDDEV in expression) + PARTITION BY fast-path\n');

const volTable = new ColumnarTable([
  { name: 'base_currency', type: 'string' },
  { name: 'quote_currency', type: 'string' },
  { name: 'timestamp', type: 'int64' },
  { name: 'close', type: 'float64' },
]);

// 模拟 2 个 symbol，每个 10 条数据
const volData = [];
for (let i = 0; i < 10; i++) {
  volData.push({ base_currency: 'AAPL', quote_currency: 'USD', timestamp: BigInt(i), close: 100 + i });
}
for (let i = 0; i < 10; i++) {
  volData.push({ base_currency: 'TSLA', quote_currency: 'USD', timestamp: BigInt(i), close: 200 + i * 2 });
}
volTable.appendBatch(volData);
executor.registerTable('vol_klines', volTable);

// 测试 inline window：STDDEV(close) OVER (...) / close 作为表达式
const volQuery = `
  WITH periods AS (
    SELECT
      base_currency,
      quote_currency,
      close AS price,
      STDDEV(close) OVER (
        PARTITION BY base_currency, quote_currency
        ORDER BY timestamp
        ROWS BETWEEN 4 PRECEDING AND CURRENT ROW
      ) / close * 100 AS vol_pct,
      ROW_NUMBER() OVER (PARTITION BY base_currency, quote_currency ORDER BY timestamp DESC) AS rn
    FROM vol_klines
  )
  SELECT
    base_currency || '/' || quote_currency AS symbol,
    price,
    ROUND(vol_pct, 2) AS vol_pct
  FROM periods
  WHERE rn = 1
  ORDER BY symbol ASC
`;

const volStart = performance.now();
executeQuery(volQuery);
const volTime = performance.now() - volStart;
console.log(`   耗时: ${volTime.toFixed(2)}ms (应走 PARTITION BY fast-path，只计算每分区最后一行)`);

console.log('\n' + '=' .repeat(60));
console.log('\n✅ SQL 测试完成！');
