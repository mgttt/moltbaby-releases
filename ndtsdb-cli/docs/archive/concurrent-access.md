# ndtsdb-cli 并发访问设计文档

**日期**: 2026-02-22  
**版本**: ndtsdb-cli v0.2.1  
**作者**: bot-00c (研发组)

---

## 1. 核心设计

**读无锁，写互斥**

| 操作 | 锁类型 | 说明 |
|------|--------|------|
| query/list/sql | **无锁** | append-only 格式天然安全 |
| write-json/write-csv | LOCK_EX | 写者互斥 |

---

## 2. 为什么读可以无锁

### 2.1 append-only 格式保证

ndtsdb 文件格式是 append-only：
- 写者只在文件末尾追加新数据
- 从不修改已写入的数据块
- 已写入的数据永远不变

### 2.2 读者安全性

读者读取时：
- 要么看到完整的数据行（写者已完成的追加）
- 要么看不到新数据（写者还在写入）
- **不会看到部分/损坏的数据**

因为：
- Linux 保证 O_APPEND 写入的原子性（<4KB）
- 写者使用 LOCK_EX 互斥，不会交叉写入
- 读者读取的是已存在的稳定数据

### 2.3 对比传统数据库

| 数据库 | 读并发策略 | 原因 |
|--------|-----------|------|
| ndtsdb-cli | **无锁** | append-only，数据不可变 |
| DuckDB | 无锁 snapshot | MVCC + 版本链 |
| SQLite | 共享锁 | 支持 UPDATE/DELETE，需要锁保护 |
| PostgreSQL | MVCC | 支持并发读写同一行 |

ndtsdb-cli 的 append-only 特性让它比传统数据库更简单：不需要 MVCC，不需要版本链，直接读就是安全的。

---

## 3. 实现细节

### 3.1 写者实现

```c
// write-json / write-csv
int lock_fd = ndtsdb_lock_acquire(database, true);  // LOCK_EX
// ... 写入数据（O_APPEND 保证原子性）...
ndtsdb_lock_release(lock_fd);
```

### 3.2 读者实现

```c
// query / list / sql
// 完全无锁，直接打开读取
NDTSDB *db = ndtsdb_open(database);
QueryResult *result = ndtsdb_query_all(db);
ndtsdb_close(db);
```

---

## 4. 风险与限制

### 4.1 已知限制

1. **flock 是建议性锁**：其他进程若不用 flock，仍可破坏数据
2. **NFS 不支持 flock**：网络文件系统上无效
3. **Windows 兼容性**：需测试 `LockFileEx` 替代方案

### 4.2 缓解措施

- 文档明确说明：必须通过 ndtsdb-cli 访问数据文件
- 外部工具不要直接修改 .ndts 文件

---

## 5. 测试

```bash
./tests/integration/test-concurrent-write.sh
```

测试场景：
- 两个并发 write-json 进程写入同一数据库
- 同时 query 读取
- 验证：数据无撕裂，格式正确

---

## 6. 参考

- Linux O_APPEND 原子性保证
- POSIX advisory locks
