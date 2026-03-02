// ============================================================
// ndtsdb_lock.c - 并发访问控制实现
// 基于 flock 的跨进程锁 + snapshot 读取
// ============================================================

#include "ndtsdb_lock.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <errno.h>

#ifdef _WIN32
#include <winsock2.h>
#include <windows.h>
#include <io.h>
#include <sys/stat.h>
#define fsync(fd) _commit(fd)
// pwrite 模拟 - Windows 无原生支持，用 _lseek + _write
static ssize_t pwrite(int fd, const void *buf, size_t count, off_t offset) {
    off_t old_pos = _lseek(fd, 0, SEEK_CUR);
    if (old_pos == (off_t)-1) return -1;
    if (_lseek(fd, offset, SEEK_SET) == (off_t)-1) return -1;
    ssize_t result = _write(fd, buf, count);
    _lseek(fd, old_pos, SEEK_SET);
    return result;
}
// flock 模拟
#define LOCK_SH 1
#define LOCK_EX 2
#define LOCK_NB 4
#define LOCK_UN 8
static int flock(int fd, int operation) {
    HANDLE h = (HANDLE)_get_osfhandle(fd);
    if (h == INVALID_HANDLE_VALUE) return -1;
    
    if (operation & LOCK_UN) {
        return UnlockFile(h, 0, 0, 0xFFFFFFFF, 0xFFFFFFFF) ? 0 : -1;
    }
    
    OVERLAPPED ov = {0};
    DWORD flags = 0;
    if (operation & LOCK_NB) flags |= LOCKFILE_FAIL_IMMEDIATELY;
    if (operation & LOCK_EX) flags |= LOCKFILE_EXCLUSIVE_LOCK;
    
    return LockFileEx(h, flags, 0, 0xFFFFFFFF, 0xFFFFFFFF, &ov) ? 0 : -1;
}
// Windows 简易目录遍历结构
typedef struct DIR {
    HANDLE handle;
    WIN32_FIND_DATA data;
    struct dirent *entry;
    int first;
} DIR;

typedef struct dirent {
    char d_name[MAX_PATH];
} dirent;

static DIR* opendir(const char *path) {
    DIR *dir = malloc(sizeof(DIR));
    if (!dir) return NULL;
    char pattern[MAX_PATH];
    snprintf(pattern, MAX_PATH, "%s/*", path);
    dir->handle = FindFirstFile(pattern, &dir->data);
    if (dir->handle == INVALID_HANDLE_VALUE) {
        free(dir);
        return NULL;
    }
    dir->first = 1;
    dir->entry = malloc(sizeof(struct dirent));
    return dir;
}

static struct dirent* readdir(DIR *dir) {
    if (!dir || !dir->entry) return NULL;
    if (!dir->first) {
        if (!FindNextFile(dir->handle, &dir->data)) return NULL;
    }
    dir->first = 0;
    strncpy(dir->entry->d_name, dir->data.cFileName, MAX_PATH);
    return dir->entry;
}

static void closedir(DIR *dir) {
    if (dir) {
        FindClose(dir->handle);
        free(dir->entry);
        free(dir);
    }
}
#else
#include <unistd.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <dirent.h>
#endif

// 锁文件名
#define LOCK_FILENAME ".ndtsdb.lock"

// 构建锁文件路径
// 返回动态分配的字符串，调用者需释放
static char* build_lock_path(const char* db_path) {
    size_t path_len = strlen(db_path);
    size_t lock_path_len = path_len + strlen(LOCK_FILENAME) + 2; // +2 for '/' and '\0'
    
    char* lock_path = malloc(lock_path_len);
    if (!lock_path) return NULL;
    
    // 确保路径以/结尾
    if (path_len > 0 && db_path[path_len - 1] == '/') {
        snprintf(lock_path, lock_path_len, "%s%s", db_path, LOCK_FILENAME);
    } else {
        snprintf(lock_path, lock_path_len, "%s/%s", db_path, LOCK_FILENAME);
    }
    
    return lock_path;
}

int ndtsdb_lock_acquire(const char* db_path, bool exclusive) {
    if (!db_path || strlen(db_path) == 0) {
        errno = EINVAL;
        return -1;
    }
    
    char* lock_path = build_lock_path(db_path);
    if (!lock_path) {
        errno = ENOMEM;
        return -1;
    }
    
    // 打开或创建锁文件
    int lock_fd = open(lock_path, O_RDONLY | O_CREAT, 0644);
    if (lock_fd < 0) {
        fprintf(stderr, "[ndtsdb] lock: open failed: %s (errno=%d)\n", lock_path, errno);
        free(lock_path);
        return -1;
    }
    free(lock_path);

    // 获取锁
    int op = exclusive ? LOCK_EX : LOCK_SH;
    if (flock(lock_fd, op) < 0) {
        fprintf(stderr, "[ndtsdb] lock: flock failed (errno=%d)\n", errno);
        close(lock_fd);
        return -1;
    }
    
    return lock_fd;
}

void ndtsdb_lock_release(int lock_fd) {
    if (lock_fd < 0) return;
    
    flock(lock_fd, LOCK_UN);
    close(lock_fd);
}

int ndtsdb_lock_try_acquire(const char* db_path, bool exclusive) {
    if (!db_path || strlen(db_path) == 0) {
        errno = EINVAL;
        return -1;
    }
    
    char* lock_path = build_lock_path(db_path);
    if (!lock_path) {
        errno = ENOMEM;
        return -1;
    }
    
    // 打开或创建锁文件
    int lock_fd = open(lock_path, O_RDONLY | O_CREAT, 0644);
    free(lock_path);
    
    if (lock_fd < 0) {
        return -1;
    }
    
    // 尝试获取锁（非阻塞）
    int op = (exclusive ? LOCK_EX : LOCK_SH) | LOCK_NB;
    if (flock(lock_fd, op) < 0) {
        close(lock_fd);
        return -1;
    }
    
    return lock_fd;
}

off_t ndtsdb_get_safe_read_size(const char* file_path) {
    if (!file_path) {
        errno = EINVAL;
        return -1;
    }
    
    struct stat st;
    if (stat(file_path, &st) < 0) {
        return -1;
    }
    
    return st.st_size;
}

ssize_t ndtsdb_safe_read(const char* file_path, off_t max_size,
                         void* out_buf, size_t buf_size) {
    if (!file_path || !out_buf || max_size < 0) {
        errno = EINVAL;
        return -1;
    }
    
    int fd = open(file_path, O_RDONLY);
    if (fd < 0) {
        return -1;
    }
    
    // 计算实际读取大小
    size_t to_read = (max_size < (off_t)buf_size) ? (size_t)max_size : buf_size;
    
    ssize_t total_read = 0;
    char* buf_ptr = (char*)out_buf;
    
    while (to_read > 0) {
        ssize_t n = read(fd, buf_ptr + total_read, to_read);
        if (n < 0) {
            if (errno == EINTR) continue;
            close(fd);
            return -1;
        }
        if (n == 0) break; // EOF
        
        total_read += n;
        to_read -= n;
    }
    
    close(fd);
    return total_read;
}

off_t ndtsdb_get_db_size(const char* db_path) {
    if (!db_path || strlen(db_path) == 0) {
        errno = EINVAL;
        return -1;
    }
    
    off_t total_size = 0;
    DIR* dir = opendir(db_path);
    if (!dir) {
        // 目录不存在，返回 0
        return 0;
    }
    
    struct dirent* ent;
    while ((ent = readdir(dir)) != NULL) {
        // 只处理 .ndts 文件
        if (!strstr(ent->d_name, ".ndts")) continue;
        
        char filepath[512];
        snprintf(filepath, sizeof(filepath), "%s/%s", db_path, ent->d_name);
        
        struct stat st;
        if (stat(filepath, &st) == 0) {
            total_size += st.st_size;
        }
    }
    
    closedir(dir);
    return total_size;
}

// ============================================================
// WAL (Write-Ahead Log) 实现
// ============================================================

// WAL 文件名
#define WAL_FILENAME ".wal.log"

char* ndtsdb_wal_path(const char* db_path) {
    size_t path_len = strlen(db_path);
    size_t wal_path_len = path_len + strlen(WAL_FILENAME) + 2;
    
    char* wal_path = malloc(wal_path_len);
    if (!wal_path) return NULL;
    
    if (path_len > 0 && db_path[path_len - 1] == '/') {
        snprintf(wal_path, wal_path_len, "%s%s", db_path, WAL_FILENAME);
    } else {
        snprintf(wal_path, wal_path_len, "%s/%s", db_path, WAL_FILENAME);
    }
    
    return wal_path;
}

int ndtsdb_wal_append(const char* db_path, const char* symbol, const char* interval,
                      const KlineRow* rows, uint32_t n) {
    if (!db_path || !symbol || !interval || !rows || n == 0) {
        errno = EINVAL;
        return -1;
    }
    
    char* wal_path = ndtsdb_wal_path(db_path);
    if (!wal_path) {
        errno = ENOMEM;
        return -1;
    }
    
    // 以追加模式打开 WAL 文件
    int fd = open(wal_path, O_WRONLY | O_CREAT | O_APPEND, 0644);
    if (fd < 0) {
        free(wal_path);
        return -1;
    }
    
    // 获取当前文件位置（记录起始位置）
    off_t record_offset = lseek(fd, 0, SEEK_CUR);
    
    // 构建记录头
    WALRecordHeader header;
    header.magic = WAL_MAGIC;
    strncpy(header.symbol, symbol, 31);
    header.symbol[31] = '\0';
    strncpy(header.interval, interval, 15);
    header.interval[15] = '\0';
    header.row_count = n;
    header.committed = 0x00;  // 初始状态：待提交
    
    // 写入记录头
    ssize_t written = write(fd, &header, sizeof(header));
    if (written != sizeof(header)) {
        close(fd);
        free(wal_path);
        return -1;
    }
    
    // 写入数据行
    size_t data_size = n * sizeof(KlineRow);
    written = write(fd, rows, data_size);
    if ((size_t)written != data_size) {
        close(fd);
        free(wal_path);
        return -1;
    }
    
    // 同步到磁盘（确保 WAL 持久化）
    fsync(fd);
    close(fd);
    free(wal_path);
    
    // 返回记录起始位置（用于后续标记 committed）
    return (int)record_offset;
}

int ndtsdb_wal_replay(const char* db_path, void* db) {
    if (!db_path || !db) {
        errno = EINVAL;
        return -1;
    }
    
    char* wal_path = ndtsdb_wal_path(db_path);
    if (!wal_path) {
        errno = ENOMEM;
        return -1;
    }
    
    // 检查 WAL 文件是否存在
    if (access(wal_path, F_OK) != 0) {
        free(wal_path);
        return 0;  // WAL 不存在，视为成功（无数据需要重放）
    }
    
    int fd = open(wal_path, O_RDWR);
    if (fd < 0) {
        free(wal_path);
        return -1;
    }
    
    int record_count = 0;
    int total_rows = 0;
    
    while (1) {
        // 记录当前位置（用于标记 committed）
        off_t record_offset = lseek(fd, 0, SEEK_CUR);
        
        // 读取记录头
        WALRecordHeader header;
        ssize_t n = read(fd, &header, sizeof(header));
        if (n == 0) break;  // EOF
        if (n != sizeof(header)) {
            break;  // 不完整记录，停止
        }
        
        // 验证魔数
        if (header.magic != WAL_MAGIC) {
            break;  // 损坏的记录
        }
        
        // 读取数据行
        size_t data_size = header.row_count * sizeof(KlineRow);
        KlineRow* rows = malloc(data_size);
        if (!rows) {
            close(fd);
            free(wal_path);
            return -1;
        }
        
        n = read(fd, rows, data_size);
        if ((size_t)n != data_size) {
            free(rows);
            break;  // 数据不完整
        }
        
        // 只重放未提交的条目
        if (header.committed == 0x00) {
            // 插入到数据库
            // 注意：这里需要调用 ndtsdb_insert_batch，但 db 是 NDTSDB* 类型
            // 由于头文件循环依赖，我们在 main.c 中直接调用
            // 这里只返回记录数，实际插入在 wal-replay 命令中处理
            
            // 标记为已提交
            off_t commit_offset = record_offset + offsetof(WALRecordHeader, committed);
            uint8_t committed = 0x01;
            pwrite(fd, &committed, 1, commit_offset);
            
            record_count++;
            total_rows += header.row_count;
        }
        
        free(rows);
    }
    
    fsync(fd);
    close(fd);
    free(wal_path);
    
    return record_count;
}

int ndtsdb_wal_mark_committed(const char* db_path, off_t offset) {
    if (!db_path) {
        errno = EINVAL;
        return -1;
    }
    
    char* wal_path = ndtsdb_wal_path(db_path);
    if (!wal_path) {
        errno = ENOMEM;
        return -1;
    }
    
    int fd = open(wal_path, O_WRONLY);
    if (fd < 0) {
        free(wal_path);
        return -1;
    }
    
    // 计算 committed 字段的偏移量
    off_t commit_offset = offset + offsetof(WALRecordHeader, committed);
    uint8_t committed = 0x01;
    
    ssize_t n = pwrite(fd, &committed, 1, commit_offset);
    if (n != 1) {
        close(fd);
        free(wal_path);
        return -1;
    }
    
    fsync(fd);
    close(fd);
    free(wal_path);
    
    return 0;
}
