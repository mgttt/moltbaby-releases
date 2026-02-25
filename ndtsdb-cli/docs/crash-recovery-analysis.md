# ndtsdb Crash Recovery Analysis

## 1. 执行摘要

**分析目标**: 评估 ndtsdb 在写入过程中发生 crash 时的数据一致性风险
**分析范围**: `write-json` 写入路径、`.ndts` 分区文件格式、`.ndtv` 向量文件格式、WAL 机制
**关键结论**: 
- **无原子写入保证**: 写入中途 crash 会导致文件损坏
- **WAL 存在但未充分利用**: 有 WAL 结构但缺少自动重放机制
- **向量文件无校验**: `.ndtv` 文件无 CRC 校验，存在静默损坏风险

---

## 2. 写入路径分析

### 2.1 write-json 流程 (cmd_io.c)

```
1. ndtsdb_lock_acquire()     → 获取 flock 独占锁
2. ndtsdb_open()             → 打开数据库
3. 逐行解析 JSON
4. ndtsdb_wal_append()       → 先写 WAL (fsync)
5. ndtsdb_insert_batch()     → 写入内存
6. ndtsdb_wal_mark_committed() → 标记 WAL 已提交
7. ndtsdb_close()            → 刷盘所有数据文件
8. ndtsdb_lock_release()     → 释放锁
```

### 2.2 关键代码片段

```c
// 批量写入前先写 WAL
off_t wal_offset = ndtsdb_wal_append(database, batch_symbol, batch_interval, batch, batch_count);
int inserted = ndtsdb_insert_batch(db, batch_symbol, batch_interval, batch, batch_count);
if (inserted > 0) {
    count += inserted;
    if (wal_offset >= 0) {
        ndtsdb_wal_mark_committed(database, wal_offset);
    }
}
```

**问题**: WAL 写入后没有立即强制刷盘数据文件，`ndtsdb_close()` 时才统一刷盘。

---

## 3. 文件格式原子性分析

### 3.1 .ndts 分区文件格式 (ndts.c)

```
[Header Block 4096 bytes]
  - magic[4]: "NDTS"
  - header_len[4]
  - json[N]: 列定义 + stringDicts
  - padding[4096-8-N]
  
[Header CRC32 4 bytes]

[Chunk Data]
  - row_count[4]
  - symbol列[int32数组]
  - interval列[int32数组]
  - timestamp列[int64数组]
  - open/high/low/close/volume列[float64数组]
  - flags列[uint32数组]
  
[Chunk CRC32 4 bytes]
```

**Crash 场景分析**:

| 崩溃时机 | 后果 | 可检测性 |
|---------|------|---------|
| Header 写入中 | Header CRC 校验失败 | ✅ 可检测 |
| Chunk 数据写入中 | Chunk CRC 校验失败 | ✅ 可检测 |
| Header CRC 写入中 | Header 不完整 | ⚠️ 可能检测 |
| Chunk CRC 写入中 | Chunk 不完整 | ⚠️ 可能检测 |

**结论**: 单文件模式下，CRC 可以检测写入不完整。但目录模式下（按天分文件），部分文件损坏会导致数据不一致。

### 3.2 .ndtv 向量文件格式 (ndtsdb_vector.c)

```
[File Header 64 bytes]
  - magic[4]: "NDTV"
  - version[2]: 0x0001
  - reserved[2]
  - record_count[8]: uint64_t
  - padding[48]

[Record Sequence, 追加写]
  - rec_size[4]: uint32_t
  - timestamp[8]: int64_t
  - agent_id[32]: char[32]
  - type[16]: char[16]
  - confidence[4]: float32
  - embedding_dim[2]: uint16_t
  - flags[4]: uint32_t
  - _pad[2]: 对齐
  - embedding[dim*4]: float32数组
```

**问题**:
1. **无 CRC 校验**: 向量文件没有 CRC，无法检测数据损坏
2. **record_count 更新非原子**: 文件头中的 record_count 在每条记录写入后更新，crash 时可能计数与实际记录不符
3. **无写入事务边界**: 单条记录跨多个字段写入，中途 crash 会导致记录断裂

### 3.3 WAL 文件格式 (ndtsdb_lock.c)

```
[Record]
  - magic[4]: 0x57414C44 ("WALD")
  - symbol[32]: char[32]
  - interval[16]: char[16]
  - row_count[4]: uint32_t
  - committed[1]: 0x00=待提交, 0x01=已提交
  
[Data]
  - rows[row_count * sizeof(KlineRow)]
```

**优点**:
- 有 committed 标志位，可区分已提交/未提交记录
- 追加写入，天然原子性（单条记录级别）

**缺点**:
- 无 CRC 校验
- 没有自动重放机制（需要手动调用 `wal-replay`）

---

## 4. Crash 场景详细分析

### 4.1 场景 1: write-json 写入中途 Crash

**时间点**: 已经写入部分 batch，ndtsdb_close() 未执行

**后果**:
- 内存中的数据丢失（未刷盘）
- 已写入的数据文件可能不完整（无 fsync）
- WAL 中可能有未标记 committed 的记录

**恢复**:
```bash
ndtsdb-cli wal-replay --database <path>
```

### 4.2 场景 2: ndtsdb_close() 刷盘时 Crash

**时间点**: 正在执行 fclose()，数据正在刷入磁盘

**后果**:
- .ndts 文件可能部分写入，CRC 校验失败
- 文件系统层面可能存在不完整块

**检测**:
```c
// 读取时会检查 magic
if (fread(magic, 1, 4, f) != 4 || memcmp(magic, "NDTS", 4) != 0) {
    // 跳过损坏文件
}
```

### 4.3 场景 3: 向量写入中途 Crash

**时间点**: ndtsdb_insert_vector() 执行中

**后果**:
- .ndtv 文件记录数与实际记录不匹配
- 最后一条记录可能断裂（rec_size 已写但数据未写完）

**风险**: ⚠️ **高** - 无法自动检测，读取时可能越界或返回垃圾数据

### 4.4 场景 4: 多进程并发写入（理论场景）

**后果**:
- flock 锁防止了并发写入
- 但如果一个进程 crash，锁会自动释放，新进程可以正常获取锁
- 遗留的部分写入数据需要清理

---

## 5. 数据损坏检测能力

| 组件 | 检测机制 | 检测覆盖 | 自动修复 |
|-----|---------|---------|---------|
| .ndts Header | CRC32 | 完整 Header Block | ❌ 无 |
| .ndts Chunk | CRC32 | 完整 Chunk Data | ❌ 无 |
| .ndtv File | Magic only | 文件头 | ❌ 无 |
| .ndtv Record | rec_size 字段 | 单条记录边界 | ⚠️ 部分 |
| WAL | Magic + committed 标志 | 记录完整性 | ✅ wal-replay |

---

## 6. 关键问题总结

### 6.1 已确认问题

1. **向量文件无 CRC**: .ndtv 文件损坏无法检测（Issue #1）
2. **无原子写入**: 写入过程中 crash 会导致部分数据写入（Issue #2）
3. **WAL 未自动重放**: 需要手动执行 wal-replay（Issue #3）
4. **缺少 fsync 策略**: 关键节点（batch 写入后）未强制刷盘（Issue #4）

### 6.2 风险等级评估

| 风险项 | 概率 | 影响 | 等级 |
|-------|------|------|------|
| 向量文件损坏 | 中 | 数据丢失/错误 | 🔴 高 |
| 分区文件损坏 | 低 | 单日数据丢失 | 🟡 中 |
| WAL 未重放 | 高 | 数据丢失 | 🟡 中 |
| 进程 crash | 低 | 部分数据丢失 | 🟡 中 |

---

## 7. 建议方案

### 7.1 短期修复（高优先级）

1. **添加向量文件 CRC**
   - 在每条记录后添加 CRC32
   - 读取时校验，损坏记录跳过

2. **启动时自动 WAL 重放**
   - ndtsdb_open() 时检查 WAL 文件
   - 自动重放未提交记录

3. **关键节点 fsync**
   - 每个 batch 写入后执行 fsync
   - ndtsdb_close() 时确保所有数据落盘

### 7.2 中期改进

1. **临时文件 + rename 模式**
   ```
   写入流程:
   1. 写入 .ndts.tmp
   2. fsync
   3. rename .ndts.tmp → .ndts
   ```

2. **数据完整性校验工具**
   ```bash
   ndtsdb-cli doctor --database <path>
   ```

### 7.3 长期规划

1. **真正的 WAL + Checkpoint 机制**
   - 所有写入先写 WAL
   - 定期 checkpoint 刷盘
   - 启动时自动恢复到一致状态

---

## 8. 附录

### 8.1 代码位置

- 写入逻辑: `ndtsdb-cli/src/cmd_io.c:cmd_write_json()`
- 分区文件写入: `ndtsdb/native/ndts.c:write_partition_file()`
- 向量文件写入: `ndtsdb/native/ndtsdb_vector.c:ndtsdb_insert_vector()`
- WAL 实现: `ndtsdb-cli/src/ndtsdb_lock.c`

### 8.2 相关文件

- `ndtsdb-cli/src/ndtsdb_lock.h` - 锁和 WAL 接口
- `ndtsdb/native/ndtsdb.h` - 核心数据结构
- `ndtsdb/native/ndtsdb_vector.h` - 向量数据结构

---

*分析完成时间: 2026-02-21*
*分析者: bot-00d*
