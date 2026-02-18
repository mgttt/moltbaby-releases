// ndtsdb-cli 使用示例
// 运行: qjs -c qjs_ndtsdb.so example.js

import * as ndtsdb from "ndtsdb";

// 打开数据库
const db = ndtsdb.open("./data/BTCUSDT.ndts");

// 插入单条K线
ndtsdb.insert(db, "BTCUSDT", "1m", {
    timestamp: Date.now(),
    open: 50000,
    high: 50200,
    low: 49800,
    close: 50100,
    volume: 100.5
});

// 批量插入
const klines = [];
for (let i = 0; i < 1000; i++) {
    klines.push({
        timestamp: Date.now() - i * 60000,
        open: 50000 + i,
        high: 50200 + i,
        low: 49800 + i,
        close: 50100 + i,
        volume: 100 + i
    });
}
ndtsdb.insertBatch(db, "BTCUSDT", "1m", klines);

// 查询
const rows = ndtsdb.query(db, "BTCUSDT", "1m", 
    Date.now() - 3600000,  // 1小时前
    Date.now(),             // 现在
    100                     // 最多100条
);
print(`查询到 ${rows.length} 条K线`);

// 获取最新时间戳
const latest = ndtsdb.getLatestTimestamp(db, "BTCUSDT", "1m");
print(`最新时间戳: ${latest}`);

// 关闭
ndtsdb.close(db);

print("完成!");
