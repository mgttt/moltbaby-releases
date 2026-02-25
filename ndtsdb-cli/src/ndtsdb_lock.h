// ============================================================
// ndtsdb_lock.h - 并发访问控制
// 提供 flock 文件锁和 snapshot 读取支持
// ============================================================

#ifndef NDTSDB_LOCK_H
#define NDTSDB_LOCK_H

#include <stddef.h>
#include <stdbool.h>
#include <sys/types.h>

// ============================================================
// 锁操作
// ============================================================

/**
 * 获取数据库锁
 * @param db_path 数据库目录路径
 * @param exclusive true=独占锁(写), false=共享锁(读)
 * @return 锁文件fd，-1表示失败
 */
int ndtsdb_lock_acquire(const char* db_path, bool exclusive);

/**
 * 释放数据库锁
 * @param lock_fd 锁文件fd
 */
void ndtsdb_lock_release(int lock_fd);

/**
 * 尝试获取锁（非阻塞）
 * @param db_path 数据库目录路径
 * @param exclusive true=独占锁, false=共享锁
 * @return 锁文件fd，-1表示获取失败
 */
int ndtsdb_lock_try_acquire(const char* db_path, bool exclusive);

// ============================================================
// Snapshot 读取
// ============================================================

/**
 * 获取文件安全读取大小（snapshot 隔离）
 * 在查询开始时调用，后续只读取该范围内的数据
 * @param file_path 数据文件路径
 * @return 安全读取大小（字节），-1表示错误
 */
off_t ndtsdb_get_safe_read_size(const char* file_path);

/**
 * 安全读取文件到缓冲区（带大小限制）
 * @param file_path 文件路径
 * @param max_size 最大读取大小（来自 snapshot）
 * @param out_buf 输出缓冲区（需预先分配）
 * @param buf_size 缓冲区大小
 * @return 实际读取字节数，-1表示错误
 */
ssize_t ndtsdb_safe_read(const char* file_path, off_t max_size, 
                         void* out_buf, size_t buf_size);

// ============================================================
// Snapshot 读取（无锁）
// ============================================================

/**
 * 获取数据库目录总大小（用于 snapshot）
 * 遍历目录中所有 .ndts 文件，返回总字节数
 * @param db_path 数据库目录路径
 * @return 总字节数，-1 表示错误
 */
off_t ndtsdb_get_db_size(const char* db_path);

// ============================================================
// WAL (Write-Ahead Log)
// ============================================================

#include "../../ndtsdb/native/ndtsdb.h"

/**
 * WAL 魔数
 */
#define WAL_MAGIC 0x57414C44  // "WALD"

/**
 * WAL 记录头
 */
typedef struct {
    uint32_t magic;      // WAL_MAGIC
    char symbol[32];     // symbol
    char interval[16];   // interval
    uint32_t row_count;  // KlineRow 数量
    uint8_t committed;   // 0x00 = 待提交, 0x01 = 已提交
} WALRecordHeader;

/**
 * 追加记录到 WAL
 * @param db_path 数据库目录路径
 * @param symbol 交易对
 * @param interval 时间间隔
 * @param rows KlineRow 数组
 * @param n 行数
 * @return 0 成功，-1 失败
 */
int ndtsdb_wal_append(const char* db_path, const char* symbol, const char* interval,
                      const KlineRow* rows, uint32_t n);

/**
 * 重放 WAL 日志到数据库
 * @param db_path 数据库目录路径
 * @param db 数据库句柄（已打开）
 * @return 重放的记录数，-1 表示错误
 */
int ndtsdb_wal_replay(const char* db_path, void* db);

/**
 * 获取 WAL 文件路径
 * @param db_path 数据库目录路径
 * @return 动态分配的 WAL 路径，调用者需释放
 */
char* ndtsdb_wal_path(const char* db_path);

/**
 * 标记 WAL 记录为已提交
 * @param db_path 数据库目录路径
 * @param offset WAL 记录的文件偏移量
 * @return 0 成功，-1 失败
 */
int ndtsdb_wal_mark_committed(const char* db_path, off_t offset);

#endif // NDTSDB_LOCK_H
