// ============================================================
// libndts - N-Dimensional Time Series Native Core
// 
// 高性能底层操作：类型转换 · 排序 · 重排列 · SIMD
// ============================================================

#include <stddef.h>
#include <stdint.h>
#include <inttypes.h>
#include <string.h>
#include <float.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <time.h>
#include "ndtsdb.h"

#ifdef _WIN32
#include <winsock2.h>
#include <windows.h>
#include <direct.h>
#include <io.h>
#define mkdir(path, mode) _mkdir(path)
/* Windows: flush to disk */
#define NDTS_FSYNC(fd) _commit(fd)
/* Windows: no flock, use invalid sentinel */
#define NDTS_LOCK_FD_INVALID (-1)
/* strndup is a POSIX extension not available on Windows */
static char* strndup(const char* s, size_t n) {
    size_t len = 0;
    while (len < n && s[len]) len++;
    char* p = (char*)malloc(len + 1);
    if (p) { memcpy(p, s, len); p[len] = '\0'; }
    return p;
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
#include <sys/types.h>
#include <dirent.h>
#include <unistd.h>
#include <fcntl.h>      /* open, O_CREAT, O_RDWR */
#include <sys/file.h>   /* flock */
#define NDTS_FSYNC(fd) fsync(fd)
#define NDTS_LOCK_FD_INVALID (-1)
#endif

// ─── 类型转换 ─────────────────────────────────────────────

/**
 * BigInt64 → Float64 批量转换
 * 比 JS 循环快 5-10x
 */
void int64_to_f64(const int64_t* src, double* dst, size_t n) {
    size_t i = 0;
    // 4 路展开
    for (; i + 4 <= n; i += 4) {
        dst[i]     = (double)src[i];
        dst[i + 1] = (double)src[i + 1];
        dst[i + 2] = (double)src[i + 2];
        dst[i + 3] = (double)src[i + 3];
    }
    for (; i < n; i++) {
        dst[i] = (double)src[i];
    }
}

/**
 * Float64 → Int64 批量转换 (截断)
 */
void f64_to_int64(const double* src, int64_t* dst, size_t n) {
    size_t i = 0;
    for (; i + 4 <= n; i += 4) {
        dst[i]     = (int64_t)src[i];
        dst[i + 1] = (int64_t)src[i + 1];
        dst[i + 2] = (int64_t)src[i + 2];
        dst[i + 3] = (int64_t)src[i + 3];
    }
    for (; i < n; i++) {
        dst[i] = (int64_t)src[i];
    }
}

// ─── Counting Sort ────────────────────────────────────────

/**
 * Counting Sort argsort for Float64 timestamps
 * 
 * 假设时间戳范围有限 (typical: 1 day = 86.4M ms)
 * O(n + k) 复杂度，比 O(n log n) 快 10x
 * 
 * @param data      输入时间戳数组 (Float64)
 * @param n         数组长度
 * @param out_indices 输出排序后的索引
 * @param out_min   输出最小值
 * @param out_max   输出最大值
 * @return          唯一时间戳数量 (用于预分配)
 */
size_t counting_sort_argsort_f64(
    const double* data,
    size_t n,
    int32_t* out_indices,
    double* out_min,
    double* out_max
) {
    if (n == 0) {
        *out_min = 0;
        *out_max = 0;
        return 0;
    }

    // 1. 找 min/max
    double min_val = data[0], max_val = data[0];
    for (size_t i = 1; i < n; i++) {
        if (data[i] < min_val) min_val = data[i];
        if (data[i] > max_val) max_val = data[i];
    }
    *out_min = min_val;
    *out_max = max_val;

    size_t range = (size_t)(max_val - min_val) + 1;
    
    // 2. 计数 (动态分配在调用方，这里假设 range 合理)
    // 为了避免 malloc，使用调用方提供的缓冲区
    // 这个简化版本直接在 JS 层分配 count 数组
    
    // 简化实现：直接输出排序索引
    // 实际使用时，count 数组由 JS 层传入
    
    return range;
}

/**
 * Counting Sort 完整版 (带 count 缓冲区)
 * 
 * @param data        输入时间戳数组 (Float64)
 * @param n           数组长度
 * @param min_val     最小值 (预先计算)
 * @param count       计数数组 (调用方分配，大小 = range)
 * @param range       范围 = max - min + 1
 * @param out_indices 输出排序后的索引
 */
void counting_sort_apply(
    const double* data,
    size_t n,
    double min_val,
    int32_t* count,
    size_t range,
    int32_t* out_indices
) {
    // 1. 清零计数
    memset(count, 0, range * sizeof(int32_t));
    
    // 2. 计数
    for (size_t i = 0; i < n; i++) {
        count[(size_t)(data[i] - min_val)]++;
    }
    
    // 3. 累加
    for (size_t i = 1; i < range; i++) {
        count[i] += count[i - 1];
    }
    
    // 4. 稳定排序 (从后往前)
    for (size_t i = n; i > 0; i--) {
        size_t idx = i - 1;
        size_t bucket = (size_t)(data[idx] - min_val);
        out_indices[--count[bucket]] = (int32_t)idx;
    }
}

// ─── 数据重排列 (Scatter/Gather) ─────────────────────────

/**
 * 按索引重排列 Float64 数组
 * out[i] = src[indices[i]]
 */
void gather_f64(
    const double* src,
    const int32_t* indices,
    size_t n,
    double* out
) {
    size_t i = 0;
    // 4 路展开
    for (; i + 4 <= n; i += 4) {
        out[i]     = src[indices[i]];
        out[i + 1] = src[indices[i + 1]];
        out[i + 2] = src[indices[i + 2]];
        out[i + 3] = src[indices[i + 3]];
    }
    for (; i < n; i++) {
        out[i] = src[indices[i]];
    }
}

/**
 * 按索引重排列 Int32 数组
 */
void gather_i32(
    const int32_t* src,
    const int32_t* indices,
    size_t n,
    int32_t* out
) {
    size_t i = 0;
    for (; i + 4 <= n; i += 4) {
        out[i]     = src[indices[i]];
        out[i + 1] = src[indices[i + 1]];
        out[i + 2] = src[indices[i + 2]];
        out[i + 3] = src[indices[i + 3]];
    }
    for (; i < n; i++) {
        out[i] = src[indices[i]];
    }
}

/**
 * 批量重排列：同时处理 4 个数组
 * 用于 merge.ts init 阶段
 */
void gather_batch4(
    const double* ts_src,
    const int32_t* sym_src,
    const double* price_src,
    const int32_t* vol_src,
    const int32_t* indices,
    size_t n,
    double* ts_out,
    int32_t* sym_out,
    double* price_out,
    int32_t* vol_out
) {
    for (size_t i = 0; i < n; i++) {
        int32_t idx = indices[i];
        ts_out[i] = ts_src[idx];
        sym_out[i] = sym_src[idx];
        price_out[i] = price_src[idx];
        vol_out[i] = vol_src[idx];
    }
}

// ─── 找 Snapshot 边界 ────────────────────────────────────

/**
 * 找出排序后时间戳的变化点
 * 
 * @param sorted_ts   排序后的时间戳数组
 * @param n           数组长度
 * @param out_starts  输出 snapshot 起始索引
 * @return            snapshot 数量
 */
size_t find_snapshot_boundaries(
    const double* sorted_ts,
    size_t n,
    int32_t* out_starts
) {
    if (n == 0) return 0;
    
    size_t count = 0;
    out_starts[count++] = 0;
    
    double prev = sorted_ts[0];
    for (size_t i = 1; i < n; i++) {
        if (sorted_ts[i] != prev) {
            out_starts[count++] = (int32_t)i;
            prev = sorted_ts[i];
        }
    }
    out_starts[count] = (int32_t)n;  // 结束哨兵
    
    return count;
}

// ─── 原有 SIMD 操作 (从 simd.c 迁移) ─────────────────────

/**
 * 过滤: price > threshold
 */
size_t filter_f64_gt(const double* data, size_t n, double threshold, uint32_t* out_indices) {
    size_t count = 0;
    size_t i = 0;
    
    // 4 路展开
    for (; i + 4 <= n; i += 4) {
        if (data[i] > threshold) out_indices[count++] = i;
        if (data[i + 1] > threshold) out_indices[count++] = i + 1;
        if (data[i + 2] > threshold) out_indices[count++] = i + 2;
        if (data[i + 3] > threshold) out_indices[count++] = i + 3;
    }
    for (; i < n; i++) {
        if (data[i] > threshold) out_indices[count++] = i;
    }
    
    return count;
}

/**
 * 求和
 */
double sum_f64(const double* data, size_t n) {
    double sum0 = 0, sum1 = 0, sum2 = 0, sum3 = 0;
    size_t i = 0;
    
    for (; i + 4 <= n; i += 4) {
        sum0 += data[i];
        sum1 += data[i + 1];
        sum2 += data[i + 2];
        sum3 += data[i + 3];
    }
    
    double total = sum0 + sum1 + sum2 + sum3;
    for (; i < n; i++) {
        total += data[i];
    }
    
    return total;
}

/**
 * 聚合: sum/min/max/avg
 */
typedef struct {
    double sum;
    double min;
    double max;
    double avg;
    uint32_t count;
} AggregateResult;

void aggregate_f64(const double* data, size_t n, AggregateResult* out) {
    if (n == 0) {
        out->sum = 0;
        out->min = 0;
        out->max = 0;
        out->avg = 0;
        out->count = 0;
        return;
    }
    
    double sum = 0;
    double min = data[0];
    double max = data[0];
    
    for (size_t i = 0; i < n; i++) {
        double v = data[i];
        sum += v;
        if (v < min) min = v;
        if (v > max) max = v;
    }
    
    out->sum = sum;
    out->min = min;
    out->max = max;
    out->avg = sum / n;
    out->count = n;
}

/**
 * 两列过滤
 */
size_t filter_price_volume(
    const double* prices,
    const int32_t* volumes,
    size_t n,
    double p_thresh,
    int32_t v_thresh,
    uint32_t* out_indices
) {
    size_t count = 0;
    for (size_t i = 0; i < n; i++) {
        if (prices[i] > p_thresh && volumes[i] > v_thresh) {
            out_indices[count++] = i;
        }
    }
    return count;
}

// ─── Min/Max 查找 ────────────────────────────────────────

/**
 * 同时找 min 和 max (一次遍历)
 */
void minmax_f64(const double* data, size_t n, double* out_min, double* out_max) {
    if (n == 0) {
        *out_min = 0;
        *out_max = 0;
        return;
    }
    
    double min = data[0], max = data[0];
    for (size_t i = 1; i < n; i++) {
        if (data[i] < min) min = data[i];
        if (data[i] > max) max = data[i];
    }
    *out_min = min;
    *out_max = max;
}

// ─── Gorilla XOR 压缩 ────────────────────────────────────

/**
 * 计算前导零 (64-bit)
 */
static inline int clz64(uint64_t x) {
    if (x == 0) return 64;
    return __builtin_clzll(x);
}

/**
 * 计算尾随零 (64-bit)
 */
static inline int ctz64(uint64_t x) {
    if (x == 0) return 64;
    return __builtin_ctzll(x);
}

/**
 * double 转 uint64 位表示
 */
static inline uint64_t double_to_bits(double v) {
    union { double d; uint64_t u; } u;
    u.d = v;
    return u.u;
}

/**
 * uint64 位表示转 double
 */
static inline double bits_to_double(uint64_t bits) {
    union { double d; uint64_t u; } u;
    u.u = bits;
    return u.d;
}

/**
 * Gorilla XOR 压缩 Float64 数组
 * 
 * @param data        输入数组
 * @param n           数组长度
 * @param out_buffer  输出缓冲区 (需要预分配，建议 n * 9 bytes)
 * @return            压缩后的字节数
 */
size_t gorilla_compress_f64(
    const double* data,
    size_t n,
    uint8_t* out_buffer
) {
    if (n == 0) return 0;

    fprintf(stderr, "[GORILLA_DEBUG] compress_f64 called: n=%zu, first=%f, last=%f\n", n, data[0], data[n-1]);

    size_t byte_pos = 0;
    int bit_pos = 0;
    uint64_t prev_value = 0;
    int prev_leading = -1;
    int prev_trailing = 0;
    
    // 写入 bit
    #define WRITE_BIT(b) do { \
        if (bit_pos == 0) out_buffer[byte_pos] = 0; \
        if (b) out_buffer[byte_pos] |= (1 << (7 - bit_pos)); \
        bit_pos++; \
        if (bit_pos == 8) { bit_pos = 0; byte_pos++; } \
    } while(0)
    
    // 写入多个 bits
    #define WRITE_BITS(val, bits) do { \
        uint64_t _v = (val); \
        for (int _i = (bits) - 1; _i >= 0; _i--) { \
            WRITE_BIT((_v >> _i) & 1); \
        } \
    } while(0)
    
    // 第一个值：完整存储
    uint64_t first = double_to_bits(data[0]);
    WRITE_BITS(first, 64);
    prev_value = first;
    
    for (size_t i = 1; i < n; i++) {
        uint64_t curr = double_to_bits(data[i]);
        uint64_t xor_val = curr ^ prev_value;
        
        if (xor_val == 0) {
            // 相同值：写 0
            WRITE_BIT(0);
        } else {
            // 不同值：写 1
            WRITE_BIT(1);

            int leading = clz64(xor_val);
            int trailing = ctz64(xor_val);
            // Sanity check: for any non-zero value, leading + trailing must be < 64
            // If this fails, something is wrong with clz64/ctz64
            if (leading + trailing >= 64) {
                // This shouldn't happen for non-zero values, but handle gracefully
                // Treat all bits as "meaningful"
                leading = 0;
                trailing = 0;
            }
            
            if (prev_leading != -1 &&
                leading >= prev_leading &&
                trailing >= prev_trailing) {
                // 使用之前的块描述
                WRITE_BIT(0);
                int meaningful = 64 - prev_leading - prev_trailing;
                WRITE_BITS(xor_val >> prev_trailing, meaningful);
            } else {
                // 新的块描述
                WRITE_BIT(1);
                WRITE_BITS(leading, 6);
                int meaningful = 64 - leading - trailing;
                // Ensure meaningful stays in valid range [0, 63]
                if (meaningful < 0) meaningful = 0;
                if (meaningful > 63) meaningful = 63;
                WRITE_BITS(meaningful, 6);
                if (meaningful > 0) {
                    WRITE_BITS(xor_val >> trailing, meaningful);
                }

                prev_leading = leading;
                prev_trailing = trailing;
            }
        }
        
        prev_value = curr;
    }
    
    #undef WRITE_BIT
    #undef WRITE_BITS

    // 补齐最后一个字节
    if (bit_pos > 0) byte_pos++;

    fprintf(stderr, "[GORILLA_DEBUG] compress_f64 result: %zu bytes for %zu values (ratio: %.2f), final byte_pos=%zu, bit_pos=%d\n",
        byte_pos, n, (double)byte_pos / (n * 8.0), byte_pos, bit_pos);

    // Sanity check: if result is much larger than input, something is wrong
    if (byte_pos > n * 8 + 256) {
        fprintf(stderr, "[GORILLA_DEBUG] WARNING: compression result %zu is much larger than input %zu + overhead!\n", byte_pos, n * 8);
    }

    return byte_pos;
}

/**
 * VarInt 解码 (LEB128) - 用于 Delta 压缩数据
 *
 * LEB128 编码：每个字节的低 7 位是数据，高位是延续标志（1 表示继续，0 表示结束）
 */
static size_t varint_decode_u64(const uint8_t* buffer, size_t buffer_len, uint64_t* out) {
    *out = 0;
    uint64_t result = 0;
    int shift = 0;
    size_t pos = 0;

    while (pos < buffer_len && shift < 64) {
        uint8_t byte = buffer[pos++];
        result |= ((uint64_t)(byte & 0x7f)) << shift;
        if (!(byte & 0x80)) {
            *out = result;
            return pos;  /* 返回消费的字节数 */
        }
        shift += 7;
    }

    return 0;  /* 无效 VarInt */
}

/**
 * VarInt 编码 Uint64 (LEB128)
 *
 * 使用 7 bits 存储数据，最高位作为继续标志：
 * - bit 7 = 1: 还有更多字节
 * - bit 7 = 0: 最后一个字节
 *
 * @param value   要编码的值
 * @param buffer  输出缓冲区
 * @return        编码的字节数
 */
static size_t varint_encode_u64(uint64_t value, uint8_t* buffer) {
    size_t pos = 0;

    while (value > 0x7f) {
        buffer[pos++] = (uint8_t)((value & 0x7f) | 0x80);
        value >>= 7;
    }
    buffer[pos++] = (uint8_t)(value & 0x7f);

    return pos;  /* 返回编码的字节数 */
}

/**
 * Delta 压缩 Int32 数组 (VarInt 编码)
 *
 * Delta 编码：计算相邻值的差值，使用 zigzag 编码处理负数，然后 VarInt 编码
 * 输出：[zigzag(delta[0]), zigzag(delta[1]), ...]（其中 delta[0] 是初值）
 *
 * @param data       输入数组
 * @param count      元素数量
 * @param out_buf    输出缓冲区
 * @return           编码的字节数
 */
static size_t delta_compress_i32(
    const int32_t* data,
    size_t count,
    uint8_t* out_buf
) {
    if (count == 0) return 0;

    size_t pos = 0;
    int32_t prev = 0;

    for (size_t i = 0; i < count; i++) {
        int32_t delta = data[i] - prev;

        /* Zigzag 编码：处理负数 */
        uint64_t zigzag = ((uint64_t)delta << 1) ^ (delta >> 31);

        /* VarInt 编码 */
        pos += varint_encode_u64(zigzag, out_buf + pos);

        prev = data[i];
    }

    return pos;
}

/**
 * Delta 压缩 Int64 数组 (VarInt 编码)
 *
 * 同 delta_compress_i32 但针对 int64_t
 *
 * @param data       输入数组
 * @param count      元素数量
 * @param out_buf    输出缓冲区
 * @return           编码的字节数
 */
static size_t delta_compress_i64(
    const int64_t* data,
    size_t count,
    uint8_t* out_buf
) {
    if (count == 0) return 0;

    size_t pos = 0;
    int64_t prev = 0;

    for (size_t i = 0; i < count; i++) {
        int64_t delta = data[i] - prev;

        /* Zigzag 编码：处理负数 */
        uint64_t zigzag = ((uint64_t)delta << 1) ^ (delta >> 63);

        /* VarInt 编码 */
        pos += varint_encode_u64(zigzag, out_buf + pos);

        prev = data[i];
    }

    return pos;
}

/**
 * Delta 解压 Int32 数组 (VarInt 编码)
 *
 * Delta 编码：第一个值是初值，后续是差值（全部 VarInt 编码）
 * 解压：vals[0] = delta[0]; vals[i] = vals[i-1] + delta[i]
 *
 * @param buffer      压缩数据（VarInt 编码）
 * @param buffer_len  数据长度（字节数）
 * @param out_data    输出数组
 * @param max_count   最大输出数量
 * @return            解压的元素数量
 */
static size_t delta_decompress_i32(
    const uint8_t* buffer,
    size_t buffer_len,
    int32_t* out_data,
    size_t max_count
) {
    if (buffer_len == 0 || max_count == 0) return 0;

    size_t pos = 0;
    size_t count = 0;
    int32_t prev = 0;

    /* 解码所有 VarInt 值，作为 delta 累加 */
    while (pos < buffer_len && count < max_count) {
        uint64_t delta_u64 = 0;
        size_t bytes_consumed = varint_decode_u64(buffer + pos, buffer_len - pos, &delta_u64);
        if (bytes_consumed == 0) break;

        pos += bytes_consumed;

        /* 转换为带符号的 int32：使用 zigzag 解码 */
        int32_t delta = (int32_t)((delta_u64 >> 1) ^ (-(int32_t)(delta_u64 & 1)));
        prev = prev + delta;
        out_data[count++] = prev;
    }

    return count;
}

/**
 * Delta 解压 Int64 数组 (VarInt 编码)
 *
 * 同 delta_decompress_i32 但针对 int64_t
 *
 * @param buffer      压缩数据（VarInt 编码）
 * @param buffer_len  数据长度（字节数）
 * @param out_data    输出数组
 * @param max_count   最大输出数量
 * @return            解压的元素数量
 */
static size_t delta_decompress_i64(
    const uint8_t* buffer,
    size_t buffer_len,
    int64_t* out_data,
    size_t max_count
) {
    if (buffer_len == 0 || max_count == 0) return 0;

    size_t pos = 0;
    size_t count = 0;
    int64_t prev = 0;

    /* 解码所有 VarInt 值，作为 delta 累加 */
    while (pos < buffer_len && count < max_count) {
        uint64_t delta_u64 = 0;
        size_t bytes_consumed = varint_decode_u64(buffer + pos, buffer_len - pos, &delta_u64);
        if (bytes_consumed == 0) break;

        pos += bytes_consumed;

        /* 转换为带符号的 int64：使用 zigzag 解码 */
        int64_t delta = (int64_t)((delta_u64 >> 1) ^ (-(int64_t)(delta_u64 & 1)));
        prev = prev + delta;
        out_data[count++] = prev;
    }

    return count;
}

/**
 * Gorilla XOR 解压 Float64 数组
 *
 * @param buffer      压缩数据
 * @param buffer_len  压缩数据长度
 * @param out_data    输出数组
 * @param max_count   最大输出数量
 * @return            解压的元素数量
 */
size_t gorilla_decompress_f64(
    const uint8_t* buffer,
    size_t buffer_len,
    double* out_data,
    size_t max_count
) {
    if (buffer_len < 8) return 0;
    
    size_t byte_pos = 0;
    int bit_pos = 0;
    size_t count = 0;
    uint64_t prev_value = 0;
    int prev_leading = -1;
    int prev_trailing = 0;
    
    // 读取 bit
    #define READ_BIT() ({ \
        if (byte_pos >= buffer_len) return count; \
        int _b = (buffer[byte_pos] >> (7 - bit_pos)) & 1; \
        bit_pos++; \
        if (bit_pos == 8) { bit_pos = 0; byte_pos++; } \
        _b; \
    })
    
    // 读取多个 bits
    #define READ_BITS(bits) ({ \
        uint64_t _v = 0; \
        for (int _i = 0; _i < (bits); _i++) { \
            _v = (_v << 1) | READ_BIT(); \
        } \
        _v; \
    })
    
    // 第一个值
    prev_value = READ_BITS(64);
    out_data[count++] = bits_to_double(prev_value);
    fprintf(stderr, "[GORILLA_DECOMP_DEBUG] first 64 bits=0x%016lx, as double=%f\n", prev_value, out_data[0]);
    fflush(stderr);
    
    fprintf(stderr, "[GORILLA_DECOMP_DEBUG] entering loop: count=%zu, max_count=%zu, byte_pos=%zu, buffer_len=%zu\n", count, max_count, byte_pos, buffer_len);
    while (count < max_count && byte_pos < buffer_len) {
        int same = READ_BIT();
        
        if (same == 0) {
            // 相同值
            out_data[count++] = bits_to_double(prev_value);
        } else {
            int use_prev = READ_BIT();
            
            int leading, meaningful;
            if (use_prev == 0) {
                // 使用之前的块描述
                leading = prev_leading;
                meaningful = 64 - prev_leading - prev_trailing;
            } else {
                // 新的块描述
                leading = (int)READ_BITS(6);
                meaningful = (int)READ_BITS(6);
                prev_leading = leading;
                // #Bug3: 损坏数据可能使 leading+meaningful > 64，导致负移位 UB
                if ((uint32_t)leading + (uint32_t)meaningful > 64) {
                    fprintf(stderr, "[GORILLA_DECOMP_ERROR] leading=%d meaningful=%d sum=%u > 64, returning 0 rows\n",
                        leading, meaningful, (uint32_t)leading + (uint32_t)meaningful);
                    return 0;
                }
                prev_trailing = 64 - leading - meaningful;
            }
            
            uint64_t xor_val = READ_BITS(meaningful) << prev_trailing;
            prev_value = prev_value ^ xor_val;
            out_data[count++] = bits_to_double(prev_value);
        }
    }
    
    #undef READ_BIT
    #undef READ_BITS
    
    return count;
}


// ============================================================
// io_uring 批量异步读取 (Linux only)
// ============================================================

#ifdef __linux__
#include <sys/syscall.h>
#include <linux/io_uring.h>
#include <sys/mman.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdlib.h>

#define URING_ENTRIES 256

struct uring_ctx {
    int ring_fd;
    struct io_uring_sqe *sqes;
    struct io_uring_cqe *cqes;
    uint32_t *sq_head;
    uint32_t *sq_tail;
    uint32_t *sq_mask;
    uint32_t *sq_array;
    uint32_t *cq_head;
    uint32_t *cq_tail;
    uint32_t *cq_mask;
    void *sq_ring;
    void *cq_ring;
    size_t sq_ring_size;
    size_t cq_ring_size;
};

size_t uring_ctx_size(void) {
    return sizeof(struct uring_ctx);
}

int uring_init(void *ctx_ptr) {
    struct uring_ctx *ctx = (struct uring_ctx *)ctx_ptr;
    struct io_uring_params params;
    memset(&params, 0, sizeof(params));
    memset(ctx, 0, sizeof(*ctx));
    ctx->ring_fd = -1;
    
    int fd = syscall(__NR_io_uring_setup, URING_ENTRIES, &params);
    if (fd < 0) return -1;
    
    ctx->ring_fd = fd;
    
    ctx->sq_ring_size = params.sq_off.array + params.sq_entries * sizeof(uint32_t);
    ctx->sq_ring = mmap(0, ctx->sq_ring_size, PROT_READ | PROT_WRITE,
                        MAP_SHARED | MAP_POPULATE, fd, IORING_OFF_SQ_RING);
    if (ctx->sq_ring == MAP_FAILED) { close(fd); return -2; }
    
    ctx->sq_head = (uint32_t*)((char*)ctx->sq_ring + params.sq_off.head);
    ctx->sq_tail = (uint32_t*)((char*)ctx->sq_ring + params.sq_off.tail);
    ctx->sq_mask = (uint32_t*)((char*)ctx->sq_ring + params.sq_off.ring_mask);
    ctx->sq_array = (uint32_t*)((char*)ctx->sq_ring + params.sq_off.array);
    
    ctx->sqes = mmap(0, params.sq_entries * sizeof(struct io_uring_sqe),
                     PROT_READ | PROT_WRITE, MAP_SHARED | MAP_POPULATE,
                     fd, IORING_OFF_SQES);
    if (ctx->sqes == MAP_FAILED) { close(fd); return -3; }
    
    ctx->cq_ring_size = params.cq_off.cqes + params.cq_entries * sizeof(struct io_uring_cqe);
    ctx->cq_ring = mmap(0, ctx->cq_ring_size, PROT_READ | PROT_WRITE,
                        MAP_SHARED | MAP_POPULATE, fd, IORING_OFF_CQ_RING);
    if (ctx->cq_ring == MAP_FAILED) { close(fd); return -4; }
    
    ctx->cq_head = (uint32_t*)((char*)ctx->cq_ring + params.cq_off.head);
    ctx->cq_tail = (uint32_t*)((char*)ctx->cq_ring + params.cq_off.tail);
    ctx->cq_mask = (uint32_t*)((char*)ctx->cq_ring + params.cq_off.ring_mask);
    ctx->cqes = (struct io_uring_cqe *)((char*)ctx->cq_ring + params.cq_off.cqes);
    
    return 0;
}

void uring_destroy(void *ctx_ptr) {
    struct uring_ctx *ctx = (struct uring_ctx *)ctx_ptr;
    if (ctx->sq_ring && ctx->sq_ring != MAP_FAILED) 
        munmap(ctx->sq_ring, ctx->sq_ring_size);
    if (ctx->cq_ring && ctx->cq_ring != MAP_FAILED) 
        munmap(ctx->cq_ring, ctx->cq_ring_size);
    if (ctx->sqes && ctx->sqes != MAP_FAILED) 
        munmap(ctx->sqes, URING_ENTRIES * sizeof(struct io_uring_sqe));
    if (ctx->ring_fd >= 0) close(ctx->ring_fd);
}

int uring_batch_read(
    void *ctx_ptr,
    const int *fds,
    const size_t *offsets,
    const size_t *sizes,
    uint8_t *buffer,
    const size_t *buffer_offsets,
    size_t count
) {
    struct uring_ctx *ctx = (struct uring_ctx *)ctx_ptr;
    if (count == 0) return 0;
    if (count > URING_ENTRIES) count = URING_ENTRIES;
    
    uint32_t tail = *ctx->sq_tail;
    for (size_t i = 0; i < count; i++) {
        uint32_t idx = tail & *ctx->sq_mask;
        struct io_uring_sqe *sqe = &ctx->sqes[idx];
        
        memset(sqe, 0, sizeof(*sqe));
        sqe->opcode = IORING_OP_READ;
        sqe->fd = fds[i];
        sqe->off = offsets[i];
        sqe->addr = (unsigned long)(buffer + buffer_offsets[i]);
        sqe->len = sizes[i];
        sqe->user_data = i;
        
        ctx->sq_array[idx] = idx;
        tail++;
    }
    
    __atomic_store_n(ctx->sq_tail, tail, __ATOMIC_RELEASE);
    
    int ret = syscall(__NR_io_uring_enter, ctx->ring_fd, count, count,
                      IORING_ENTER_GETEVENTS, NULL, 0);
    if (ret < 0) return ret;
    
    int completed = 0;
    uint32_t head = *ctx->cq_head;
    while (head != *ctx->cq_tail) {
        uint32_t idx = head & *ctx->cq_mask;
        struct io_uring_cqe *cqe = &ctx->cqes[idx];
        if (cqe->res >= 0) completed++;
        head++;
    }
    
    __atomic_store_n(ctx->cq_head, head, __ATOMIC_RELEASE);
    return completed;
}

int uring_available(void) {
    struct io_uring_params params;
    memset(&params, 0, sizeof(params));
    int fd = syscall(__NR_io_uring_setup, 1, &params);
    if (fd >= 0) {
        close(fd);
        return 1;
    }
    return 0;
}

#else
size_t uring_ctx_size(void) { return 64; }
int uring_init(void *ctx) { (void)ctx; return -1; }
void uring_destroy(void *ctx) { (void)ctx; }
int uring_batch_read(void *ctx, const int *fds, const size_t *offsets,
                     const size_t *sizes, uint8_t *buffer, const size_t *buffer_offsets,
                     size_t count) { 
    (void)ctx; (void)fds; (void)offsets; (void)sizes; (void)buffer; (void)buffer_offsets; (void)count;
    return -1; 
}
int uring_available(void) { return 0; }
#endif

// ============================================================
// 新增 CPU 热点优化函数
// ============================================================

// 二分查找 - 返回第一个 >= target 的位置
size_t binary_search_i64(const int64_t* data, size_t n, int64_t target) {
    size_t lo = 0, hi = n;
    while (lo < hi) {
        size_t mid = lo + (hi - lo) / 2;
        if (data[mid] < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

// 批量二分查找 - 多个 target 一次性查找
void binary_search_batch_i64(
    const int64_t* data, size_t n,
    const int64_t* targets, size_t target_count,
    size_t* results
) {
    for (size_t i = 0; i < target_count; i++) {
        results[i] = binary_search_i64(data, n, targets[i]);
    }
}

// 累积和 (Prefix Sum)
void prefix_sum_f64(const double* src, double* dst, size_t n) {
    if (n == 0) return;
    dst[0] = src[0];
    
    // 4 路展开
    size_t i = 1;
    for (; i + 3 < n; i += 4) {
        dst[i] = dst[i-1] + src[i];
        dst[i+1] = dst[i] + src[i+1];
        dst[i+2] = dst[i+1] + src[i+2];
        dst[i+3] = dst[i+2] + src[i+3];
    }
    for (; i < n; i++) {
        dst[i] = dst[i-1] + src[i];
    }
}

// 差分编码 (Delta)
void delta_encode_f64(const double* src, double* dst, size_t n) {
    if (n == 0) return;
    dst[0] = src[0];
    for (size_t i = 1; i < n; i++) {
        dst[i] = src[i] - src[i-1];
    }
}

// 差分解码
void delta_decode_f64(const double* src, double* dst, size_t n) {
    prefix_sum_f64(src, dst, n);
}

// 整数差分解码 (int32)
static void delta_decode_i32(const int32_t* src, int32_t* dst, size_t n) {
    if (n == 0) return;
    dst[0] = src[0];
    for (size_t i = 1; i < n; i++) {
        dst[i] = dst[i-1] + src[i];
    }
}

// 整数差分解码 (int64)
static void delta_decode_i64(const int64_t* src, int64_t* dst, size_t n) {
    if (n == 0) return;
    dst[0] = src[0];
    for (size_t i = 1; i < n; i++) {
        dst[i] = dst[i-1] + src[i];
    }
}

// EMA (Exponential Moving Average)
void ema_f64(const double* src, double* dst, size_t n, double alpha) {
    if (n == 0) return;
    dst[0] = src[0];
    
    double one_minus_alpha = 1.0 - alpha;
    
    // 4 路展开无法用于 EMA (有依赖)，但可以优化循环
    for (size_t i = 1; i < n; i++) {
        dst[i] = alpha * src[i] + one_minus_alpha * dst[i-1];
    }
}

// SMA (Simple Moving Average)
void sma_f64(const double* src, double* dst, size_t n, size_t window) {
    if (n == 0 || window == 0) return;
    
    double sum = 0.0;
    double inv_window = 1.0 / (double)window;
    
    // 填充前 window-1 个为 NaN
    for (size_t i = 0; i < window - 1 && i < n; i++) {
        sum += src[i];
        dst[i] = 0.0 / 0.0; // NaN
    }
    
    // 计算完整窗口
    if (n >= window) {
        sum += src[window - 1];
        dst[window - 1] = sum * inv_window;
        
        for (size_t i = window; i < n; i++) {
            sum += src[i] - src[i - window];
            dst[i] = sum * inv_window;
        }
    }
}

// 滚动标准差
void rolling_std_f64(const double* src, double* dst, size_t n, size_t window) {
    if (n == 0 || window == 0) return;
    
    double sum = 0.0, sum2 = 0.0;
    double inv_window = 1.0 / (double)window;
    
    for (size_t i = 0; i < window - 1 && i < n; i++) {
        sum += src[i];
        sum2 += src[i] * src[i];
        dst[i] = 0.0 / 0.0;
    }
    
    if (n >= window) {
        sum += src[window - 1];
        sum2 += src[window - 1] * src[window - 1];
        double mean = sum * inv_window;
        double var = sum2 * inv_window - mean * mean;
        dst[window - 1] = var > 0 ? sqrt(var) : 0;
        
        for (size_t i = window; i < n; i++) {
            double old = src[i - window];
            double new_val = src[i];
            sum += new_val - old;
            sum2 += new_val * new_val - old * old;
            mean = sum * inv_window;
            var = sum2 * inv_window - mean * mean;
            dst[i] = var > 0 ? sqrt(var) : 0;
        }
    }
}

// OHLCV 聚合
typedef struct {
    double open;
    double high;
    double low;
    double close;
    double volume;
} OHLCV;

void ohlcv_aggregate(
    const double* prices, const double* volumes, size_t n,
    size_t bucket_size, OHLCV* out, size_t* out_count
) {
    if (n == 0 || bucket_size == 0) {
        *out_count = 0;
        return;
    }
    
    size_t buckets = (n + bucket_size - 1) / bucket_size;
    *out_count = buckets;
    
    for (size_t b = 0; b < buckets; b++) {
        size_t start = b * bucket_size;
        size_t end = start + bucket_size;
        if (end > n) end = n;
        
        out[b].open = prices[start];
        out[b].close = prices[end - 1];
        out[b].high = prices[start];
        out[b].low = prices[start];
        out[b].volume = 0;
        
        for (size_t i = start; i < end; i++) {
            if (prices[i] > out[b].high) out[b].high = prices[i];
            if (prices[i] < out[b].low) out[b].low = prices[i];
            out[b].volume += volumes[i];
        }
    }
}

// ============================================================
// ndtsdb 兼容性辅助函数
// ============================================================

/**
 * 检测路径是否为目录
 */
static int path_is_dir(const char* path) {
    struct stat st;
    if (stat(path, &st) == 0) return S_ISDIR(st.st_mode);
    size_t len = strlen(path);
    if (len > 0 && path[len-1] == '/') return 1;
    return (strrchr(path, '.') == NULL) ? 1 : 0;
}

/**
 * CRC32 实现
 */
static uint32_t g_crc32_table[256];
static int g_crc32_init = 0;

static void crc32_init_table(void) {
    if (g_crc32_init) return;
    for (int i = 0; i < 256; i++) {
        uint32_t c = (uint32_t)i;
        for (int j = 0; j < 8; j++)
            c = (c & 1) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
        g_crc32_table[i] = c;
    }
    g_crc32_init = 1;
}

static uint32_t crc32_buf(const void* data, size_t len) {
    crc32_init_table();
    const uint8_t* p = (const uint8_t*)data;
    uint32_t crc = 0xFFFFFFFFu;
    for (size_t i = 0; i < len; i++)
        crc = g_crc32_table[(crc ^ p[i]) & 0xFF] ^ (crc >> 8);
    return crc ^ 0xFFFFFFFFu;
}

/* 增量 CRC32 — 用于跨多个缓冲区的流式计算。
 * 初始状态：state = 0xFFFFFFFFu
 * 终态：result = state ^ 0xFFFFFFFFu  */
static uint32_t crc32_update(uint32_t state, const void* data, size_t len) {
    crc32_init_table();
    const uint8_t* p = (const uint8_t*)data;
    for (size_t i = 0; i < len; i++)
        state = g_crc32_table[(state ^ p[i]) & 0xFF] ^ (state >> 8);
    return state;
}

/**
 * timestamp → 日期标签
 */
static void ts_to_day(int64_t ts_ms, char* out) {
    time_t t = (time_t)(ts_ms / 1000);
    struct tm* tm = gmtime(&t);
    strftime(out, 12, "%Y-%m-%d", tm);
}

/**
 * 写入单个分区文件（PartitionedTable 格式）
 */
/* Gorilla 压缩输出缓冲区上限: 每个 f64 最坏 78 bits, 故 n*12+16 足够 */
#define GORILLA_BOUND(n) ((size_t)(n) * 12 + 16)

static void write_partition_file(const char* filepath,
                                  KlineRow* rows, uint32_t n_rows,
                                  char** sym_dict, int n_sym,
                                  char** itv_dict, int n_itv,
                                  int32_t* sym_ids, int32_t* itv_ids) {
    // #90: 写临时文件，成功后原子 rename，避免 crash 产生半写分区文件
    char tmppath[512 + 4];
    snprintf(tmppath, sizeof(tmppath), "%s.tmp", filepath);

    FILE* f = fopen(tmppath, "wb");
    if (!f) return;

    /* === 提取 OHLCV + 额外 3 列数组并压缩 === */
    size_t gorilla_bound = GORILLA_BOUND(n_rows);
    double* col_open   = (double*)malloc(n_rows * 8);
    double* col_high   = (double*)malloc(n_rows * 8);
    double* col_low    = (double*)malloc(n_rows * 8);
    double* col_close  = (double*)malloc(n_rows * 8);
    double* col_volume = (double*)malloc(n_rows * 8);
    double* col_quote_volume = (double*)malloc(n_rows * 8);
    double* col_taker_buy_volume = (double*)malloc(n_rows * 8);
    double* col_taker_buy_quote_volume = (double*)malloc(n_rows * 8);
    uint8_t* buf_open   = (uint8_t*)malloc(gorilla_bound);
    uint8_t* buf_high   = (uint8_t*)malloc(gorilla_bound);
    uint8_t* buf_low    = (uint8_t*)malloc(gorilla_bound);
    uint8_t* buf_close  = (uint8_t*)malloc(gorilla_bound);
    uint8_t* buf_volume = (uint8_t*)malloc(gorilla_bound);
    uint8_t* buf_quote_volume = (uint8_t*)malloc(gorilla_bound);
    uint8_t* buf_taker_buy_volume = (uint8_t*)malloc(gorilla_bound);
    uint8_t* buf_taker_buy_quote_volume = (uint8_t*)malloc(gorilla_bound);

    int use_gorilla = col_open && col_high && col_low && col_close && col_volume
                   && col_quote_volume && col_taker_buy_volume && col_taker_buy_quote_volume
                   && buf_open && buf_high && buf_low && buf_close && buf_volume
                   && buf_quote_volume && buf_taker_buy_volume && buf_taker_buy_quote_volume;

    size_t len_open = 0, len_high = 0, len_low = 0, len_close = 0, len_volume = 0;
    size_t len_quote_volume = 0, len_taker_buy_volume = 0, len_taker_buy_quote_volume = 0;

    if (use_gorilla && n_rows > 0) {
        fprintf(stderr, "[ndtsdb debug] write: populating col_quote_volume with %u rows, first val=%f, last val=%f\n",
            n_rows, rows[0].quoteVolume, rows[n_rows-1].quoteVolume);
        for (uint32_t i = 0; i < n_rows; i++) {
            col_open[i]   = rows[i].open;
            col_high[i]   = rows[i].high;
            col_low[i]    = rows[i].low;
            col_close[i]  = rows[i].close;
            col_volume[i] = rows[i].volume;
            col_quote_volume[i] = rows[i].quoteVolume;
            col_taker_buy_volume[i] = rows[i].takerBuyVolume;
            col_taker_buy_quote_volume[i] = rows[i].takerBuyQuoteVolume;
        }
        len_open   = gorilla_compress_f64(col_open,   n_rows, buf_open);
        len_high   = gorilla_compress_f64(col_high,   n_rows, buf_high);
        len_low    = gorilla_compress_f64(col_low,    n_rows, buf_low);
        len_close  = gorilla_compress_f64(col_close,  n_rows, buf_close);
        len_volume = gorilla_compress_f64(col_volume, n_rows, buf_volume);
        len_quote_volume = gorilla_compress_f64(col_quote_volume, n_rows, buf_quote_volume);
        fprintf(stderr, "[ndtsdb debug] write: quoteVolume compressed len=%zu (raw would be %zu)\n", len_quote_volume, (size_t)n_rows * 8);
        len_taker_buy_volume = gorilla_compress_f64(col_taker_buy_volume, n_rows, buf_taker_buy_volume);
        len_taker_buy_quote_volume = gorilla_compress_f64(col_taker_buy_quote_volume, n_rows, buf_taker_buy_quote_volume);
    }
    free(col_open); free(col_high); free(col_low); free(col_close); free(col_volume);
    free(col_quote_volume); free(col_taker_buy_volume); free(col_taker_buy_quote_volume);

    /* === Delta 压缩 sym_ids, timestamps, trades === */
    uint8_t* buf_sym_ids = (uint8_t*)malloc(n_rows * 5);  /* VarInt worst case: 5 bytes per int */
    uint8_t* buf_timestamps = (uint8_t*)malloc(n_rows * 10);  /* VarInt worst case: 10 bytes per int64 */
    uint8_t* buf_trades = (uint8_t*)malloc(n_rows * 5);  /* VarInt worst case: 5 bytes per int */

    size_t len_sym_ids = 0, len_timestamps = 0, len_trades = 0;

    if (buf_sym_ids && n_rows > 0) {
        len_sym_ids = delta_compress_i32(sym_ids, n_rows, buf_sym_ids);
    }

    if (buf_timestamps && n_rows > 0) {
        int64_t* ts_array = (int64_t*)malloc(n_rows * 8);
        if (ts_array) {
            for (uint32_t i = 0; i < n_rows; i++) {
                ts_array[i] = rows[i].timestamp;
            }
            len_timestamps = delta_compress_i64(ts_array, n_rows, buf_timestamps);
            free(ts_array);
        }
    }

    if (buf_trades && n_rows > 0) {
        int32_t* trades_array = (int32_t*)malloc(n_rows * 4);
        if (trades_array) {
            for (uint32_t i = 0; i < n_rows; i++) {
                trades_array[i] = rows[i].trades;
            }
            len_trades = delta_compress_i32(trades_array, n_rows, buf_trades);
            free(trades_array);
        }
    }

    /* === 构建 JSON header === */
    /* header_block = 4096 bytes: magic(4) + hlen(4) + json(≤4088) + CRC4
     * Use 4080 so snprintf never writes past the available space. */
    char json[4080];
    int pos = 0;
    fprintf(stderr, "[ndtsdb debug] write_partition_file: use_gorilla=%d, n_rows=%u\n", use_gorilla, n_rows);
    pos += snprintf(json+pos, sizeof(json)-pos,
        "{\"columns\":["
        "\"symbol_id\",\"timestamp\",\"open\",\"high\",\"low\",\"close\",\"volume\","
        "\"quoteVolume\",\"trades\",\"takerBuyVolume\",\"takerBuyQuoteVolume\""
        "],\"compression\":{\"enabled\":%s,\"algorithms\":{"
        "\"symbol_id\":\"delta\",\"timestamp\":\"delta\","
        "\"open\":\"gorilla\",\"high\":\"gorilla\",\"low\":\"gorilla\",\"close\":\"gorilla\","
        "\"volume\":\"gorilla\",\"quoteVolume\":\"gorilla\",\"takerBuyVolume\":\"gorilla\","
        "\"takerBuyQuoteVolume\":\"gorilla\",\"trades\":\"delta\"}},\"stringDicts\":{",
        use_gorilla ? "true" : "false");

    pos += snprintf(json+pos, sizeof(json)-pos, "\"symbol\":[");
    for (int i = 0; i < n_sym; i++) {
        if (i > 0) json[pos++] = ',';
        // #92: JSON overflow guard — stop before buffer full (need room for closing ]}}）
        if (pos + 64 >= (int)sizeof(json)) {
            fprintf(stderr, "[ndtsdb] ERROR: JSON header overflow at symbol %d/%d — aborting partition write\n", i, n_sym);
            fclose(f); remove(tmppath); return;
        }
        pos += snprintf(json+pos, sizeof(json)-pos, "\"%s\"", sym_dict[i]);
    }
    pos += snprintf(json+pos, sizeof(json)-pos, "],\"interval\":[");
    for (int i = 0; i < n_itv; i++) {
        if (i > 0) json[pos++] = ',';
        if (pos + 32 >= (int)sizeof(json)) {
            fprintf(stderr, "[ndtsdb] ERROR: JSON header overflow at interval %d/%d — aborting partition write\n", i, n_itv);
            fclose(f); remove(tmppath); return;
        }
        pos += snprintf(json+pos, sizeof(json)-pos, "\"%s\"", itv_dict[i]);
    }
    pos += snprintf(json+pos, sizeof(json)-pos, "]}}");

    /* === 写入固定4096字节header区（与Bun RESERVED_HEADER_SIZE=4096对齐） === */
    #define RESERVED_HEADER_SIZE 4096
    uint8_t header_block[RESERVED_HEADER_SIZE];
    memset(header_block, 0, RESERVED_HEADER_SIZE);
    uint32_t hlen = (uint32_t)pos;
    memcpy(header_block, "NDTS", 4);
    memcpy(header_block + 4, &hlen, 4);
    memcpy(header_block + 8, json, pos);

    fwrite(header_block, 1, RESERVED_HEADER_SIZE, f);

    uint32_t hcrc = crc32_buf(header_block, RESERVED_HEADER_SIZE);
    fwrite(&hcrc, 4, 1, f);
    #undef RESERVED_HEADER_SIZE

    /* === Chunk === */
    size_t chunk_size;
    uint8_t* chunk_buf;

    if (use_gorilla) {
        /* 压缩格式: sym_ids(len+delta) + itv_ids(raw) + timestamps(len+delta)
         *           + [len(4)+data](×8 OHLCV+extra_3_double) + trades(len+delta) + flags(raw) */
        chunk_size = 4                       /* row_count */
            + (4 + len_sym_ids)              /* sym_ids: len(4) + delta_compressed_data */
            + n_rows * 4                     /* itv_ids (still raw) */
            + (4 + len_timestamps)           /* timestamps: len(4) + delta_compressed_data */
            + (4 + len_open)                 /* open: len+data */
            + (4 + len_high)
            + (4 + len_low)
            + (4 + len_close)
            + (4 + len_volume)
            + (4 + len_quote_volume)         /* quoteVolume: len+data */
            + (4 + len_taker_buy_volume)     /* takerBuyVolume: len+data */
            + (4 + len_taker_buy_quote_volume) /* takerBuyQuoteVolume: len+data */
            + (4 + len_trades)               /* trades: len(4) + delta_compressed_data */
            + n_rows * 4;                    /* flags */
    } else {
        chunk_size = 4
            + (4 + len_sym_ids)              /* sym_ids: len(4) + delta_compressed_data */
            + n_rows * 4                     /* itv_ids (still raw) */
            + (4 + len_timestamps)           /* timestamps: len(4) + delta_compressed_data */
            + n_rows * 8 * 5                 /* OHLCV (raw) */
            + n_rows * 8 * 3                 /* quoteVolume, takerBuyVolume, takerBuyQuoteVolume */
            + (4 + len_trades)               /* trades: len(4) + delta_compressed_data */
            + n_rows * 4;                    /* flags */
    }

    chunk_buf = (uint8_t*)malloc(chunk_size);
    if (!chunk_buf) {
        if (use_gorilla) {
            free(buf_open); free(buf_high); free(buf_low); free(buf_close); free(buf_volume);
            free(buf_quote_volume); free(buf_taker_buy_volume); free(buf_taker_buy_quote_volume);
        }
        free(buf_sym_ids);
        free(buf_timestamps);
        free(buf_trades);
        fclose(f); remove(tmppath);
        return;
    }

    uint8_t* p = chunk_buf;

    /* row_count */
    memcpy(p, &n_rows, 4); p += 4;

    /* sym_ids: [len(4) + delta_compressed_data] */
    uint32_t u32_len = (uint32_t)len_sym_ids;
    memcpy(p, &u32_len, 4); p += 4;
    if (len_sym_ids > 0) { memcpy(p, buf_sym_ids, len_sym_ids); p += len_sym_ids; }

    /* itv_ids (raw) */
    for (uint32_t i = 0; i < n_rows; i++) { memcpy(p, &itv_ids[i], 4); p += 4; }

    /* timestamps: [len(4) + delta_compressed_data] */
    u32_len = (uint32_t)len_timestamps;
    memcpy(p, &u32_len, 4); p += 4;
    if (len_timestamps > 0) { memcpy(p, buf_timestamps, len_timestamps); p += len_timestamps; }

    if (use_gorilla) {
        /* OHLCV + extra 3 double: gorilla 压缩，每列前缀 uint32_t 长度 */
        uint32_t u32;
        u32 = (uint32_t)len_open;   memcpy(p, &u32, 4); p += 4; memcpy(p, buf_open,   len_open);   p += len_open;
        u32 = (uint32_t)len_high;   memcpy(p, &u32, 4); p += 4; memcpy(p, buf_high,   len_high);   p += len_high;
        u32 = (uint32_t)len_low;    memcpy(p, &u32, 4); p += 4; memcpy(p, buf_low,    len_low);    p += len_low;
        u32 = (uint32_t)len_close;  memcpy(p, &u32, 4); p += 4; memcpy(p, buf_close,  len_close);  p += len_close;
        u32 = (uint32_t)len_volume; memcpy(p, &u32, 4); p += 4; memcpy(p, buf_volume, len_volume); p += len_volume;
        u32 = (uint32_t)len_quote_volume;
        fprintf(stderr, "[WRITE_CHUNK] quoteVolume: writing len=%u, first 8 bytes of data: %02x %02x %02x %02x %02x %02x %02x %02x\n",
            u32, buf_quote_volume[0], buf_quote_volume[1], buf_quote_volume[2], buf_quote_volume[3],
            buf_quote_volume[4], buf_quote_volume[5], buf_quote_volume[6], buf_quote_volume[7]);
        memcpy(p, &u32, 4); p += 4; memcpy(p, buf_quote_volume, len_quote_volume); p += len_quote_volume;
        u32 = (uint32_t)len_taker_buy_volume; memcpy(p, &u32, 4); p += 4; memcpy(p, buf_taker_buy_volume, len_taker_buy_volume); p += len_taker_buy_volume;
        u32 = (uint32_t)len_taker_buy_quote_volume; memcpy(p, &u32, 4); p += 4; memcpy(p, buf_taker_buy_quote_volume, len_taker_buy_quote_volume); p += len_taker_buy_quote_volume;
        free(buf_open); free(buf_high); free(buf_low); free(buf_close); free(buf_volume);
        free(buf_quote_volume); free(buf_taker_buy_volume); free(buf_taker_buy_quote_volume);
        /* trades: [len(4) + delta_compressed_data] */
        u32 = (uint32_t)len_trades;
        memcpy(p, &u32, 4); p += 4;
        if (len_trades > 0) { memcpy(p, buf_trades, len_trades); p += len_trades; }
    } else {
        /* OHLCV + extra 3 double: raw float64 */
        for (uint32_t i = 0; i < n_rows; i++) { memcpy(p, &rows[i].open,   8); p += 8; }
        for (uint32_t i = 0; i < n_rows; i++) { memcpy(p, &rows[i].high,   8); p += 8; }
        for (uint32_t i = 0; i < n_rows; i++) { memcpy(p, &rows[i].low,    8); p += 8; }
        for (uint32_t i = 0; i < n_rows; i++) { memcpy(p, &rows[i].close,  8); p += 8; }
        for (uint32_t i = 0; i < n_rows; i++) { memcpy(p, &rows[i].volume, 8); p += 8; }
        for (uint32_t i = 0; i < n_rows; i++) { memcpy(p, &rows[i].quoteVolume, 8); p += 8; }
        for (uint32_t i = 0; i < n_rows; i++) { memcpy(p, &rows[i].takerBuyVolume, 8); p += 8; }
        for (uint32_t i = 0; i < n_rows; i++) { memcpy(p, &rows[i].takerBuyQuoteVolume, 8); p += 8; }
        /* trades: [len(4) + delta_compressed_data] */
        uint32_t u32 = (uint32_t)len_trades;
        memcpy(p, &u32, 4); p += 4;
        if (len_trades > 0) { memcpy(p, buf_trades, len_trades); p += len_trades; }
    }

    /* flags (raw) */
    for (uint32_t i = 0; i < n_rows; i++) { memcpy(p, &rows[i].flags, 4); p += 4; }

    size_t written = fwrite(chunk_buf, 1, chunk_size, f);
    if (written != chunk_size) {
        free(chunk_buf);
        free(buf_sym_ids);
        free(buf_timestamps);
        free(buf_trades);
        fclose(f);
        unlink(tmppath);
        fprintf(stderr, "[ndtsdb] ERROR: fwrite partial (%zu/%zu) — disk full? Deleting %s\n", written, chunk_size, tmppath);
        return;
    }

    uint32_t ccrc = crc32_buf(chunk_buf, chunk_size);
    size_t crc_written = fwrite(&ccrc, 4, 1, f);
    if (crc_written != 1) {
        free(chunk_buf);
        free(buf_sym_ids);
        free(buf_timestamps);
        free(buf_trades);
        fclose(f);
        unlink(tmppath);
        fprintf(stderr, "[ndtsdb] ERROR: fwrite CRC failed — disk full? Deleting %s\n", tmppath);
        return;
    }

    free(chunk_buf);
    free(buf_sym_ids);
    free(buf_timestamps);
    free(buf_trades);

    // #90: fsync 保证数据落盘，再 rename（POSIX 原子操作）替换目标文件
    NDTS_FSYNC(fileno(f));
    fclose(f);
    if (rename(tmppath, filepath) != 0) {
        remove(tmppath);
        fprintf(stderr, "[ndtsdb] ERROR: rename(%s, %s) failed\n", tmppath, filepath);
    }
}

// ============================================================
// ndtsdb 高级 API 实现 (MVP)
// ============================================================

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// 动态内存存储
#define INITIAL_SYMBOLS_CAPACITY 16   // symbol数组初始容量
#define INITIAL_KLINES_CAPACITY 1024  // klines数组初始容量

typedef struct {
    char symbol[32];
    char interval[16];
    uint32_t count;
    uint32_t capacity;  // 当前分配容量
    KlineRow* klines;   // 动态分配的指针
} SymbolData;

// 简化版数据库结构
struct NDTSDB {
    char path[256];
    int is_dir;   // 1=目录模式（PartitionedTable格式），0=文件模式（旧格式）
    int dirty;    // 1=有写入操作，close时才写出；0=只读，close不写文件
    uint64_t snapshot_size;  // snapshot 模式下的最大读取字节数（0表示不限制）
    // per-handle 数据存储（原全局 g_symbols 已移入此处，使多实例并发安全）
    SymbolData* symbols;
    uint32_t    symbol_count;
    uint32_t    symbols_capacity;
    // #93: 目录级文件锁（POSIX flock），防止多进程并发写同一目录
    int         lock_fd;    // -1 = 未加锁 / 文件模式
};

static SymbolData* find_or_create_symbol(NDTSDB* db, const char* symbol, const char* interval) {
    // 首次使用，lazy init
    if (!db->symbols) {
        db->symbols_capacity = INITIAL_SYMBOLS_CAPACITY;
        db->symbols = (SymbolData*)malloc(db->symbols_capacity * sizeof(SymbolData));
        if (!db->symbols) return NULL;
        memset(db->symbols, 0, db->symbols_capacity * sizeof(SymbolData));
    }

    // 查找已存在的symbol
    for (uint32_t i = 0; i < db->symbol_count; i++) {
        if (strcmp(db->symbols[i].symbol, symbol) == 0 &&
            strcmp(db->symbols[i].interval, interval) == 0) {
            return &db->symbols[i];
        }
    }

    // 需要新增symbol，检查是否需要扩容
    if (db->symbol_count >= db->symbols_capacity) {
        // #91: 防止 uint32_t 翻倍溢出
        if (db->symbols_capacity > UINT32_MAX / 2) return NULL;
        uint32_t new_capacity = db->symbols_capacity * 2;
        // #91: realloc 失败时保留原指针（temp var 模式）
        SymbolData* new_symbols = (SymbolData*)realloc(db->symbols, new_capacity * sizeof(SymbolData));
        if (!new_symbols) return NULL;
        memset(new_symbols + db->symbols_capacity, 0, (new_capacity - db->symbols_capacity) * sizeof(SymbolData));
        db->symbols = new_symbols;
        db->symbols_capacity = new_capacity;
    }

    SymbolData* sd = &db->symbols[db->symbol_count++];
    strncpy(sd->symbol, symbol, sizeof(sd->symbol) - 1);
    sd->symbol[sizeof(sd->symbol) - 1] = '\0';
    strncpy(sd->interval, interval, sizeof(sd->interval) - 1);
    sd->interval[sizeof(sd->interval) - 1] = '\0';
    sd->count = 0;
    sd->capacity = INITIAL_KLINES_CAPACITY;
    sd->klines = (KlineRow*)malloc(sd->capacity * sizeof(KlineRow));
    if (!sd->klines) {
        db->symbol_count--;
        return NULL;
    }
    return sd;
}

/* ── Item 1: find_symbol — 只读查找，不创建新槽位 ──────────── */
static SymbolData* find_symbol(NDTSDB* db, const char* symbol, const char* interval) {
    if (!db || !db->symbols || !symbol || !interval) return NULL;
    for (uint32_t i = 0; i < db->symbol_count; i++) {
        if (strcmp(db->symbols[i].symbol,   symbol)   == 0 &&
            strcmp(db->symbols[i].interval, interval) == 0) {
            return &db->symbols[i];
        }
    }
    return NULL;
}

/* ── Items 2 & 4: ResultRow + collect_rows 基础设施 ─────────── */

/* 多 symbol 查询的扩展行（KlineRow + 元数据），仅内部使用。
 * QueryResult.capacity == NDTSDB_RESULT_EXTENDED 时 rows 指向此类型。 */
typedef struct {
    KlineRow row;
    char     symbol[32];
    char     interval[16];
} ResultRow;

/* 过滤上下文：symbols==NULL 匹配所有；since/until<0 表示无界 */
typedef struct {
    const char** symbols;
    int          n_symbols;
    int64_t      since_ms;  /* -1 = 无下界 */
    int64_t      until_ms;  /* -1 = 无上界 */
} CollectFilter;

/* 判断 db->symbols[sd_idx] 的第 j 行是否满足过滤条件 */
static int row_matches(const SymbolData* sd, uint32_t j, const CollectFilter* f) {
    /* symbol 过滤（NULL = 所有） */
    if (f->symbols != NULL) {
        int ok = 0;
        for (int s = 0; s < f->n_symbols; s++) {
            if (strcmp(sd->symbol, f->symbols[s]) == 0) { ok = 1; break; }
        }
        if (!ok) return 0;
    }
    /* 时间范围 */
    int64_t ts = sd->klines[j].timestamp;
    if (f->since_ms >= 0 && ts < f->since_ms) return 0;
    if (f->until_ms >= 0 && ts > f->until_ms) return 0;
    return 1;
}

/* 两遍扫描：count → malloc → fill；返回带 NDTSDB_RESULT_EXTENDED 标记的结果 */
static QueryResult* collect_rows(NDTSDB* db, const CollectFilter* f) {
    QueryResult* r = (QueryResult*)malloc(sizeof(QueryResult));
    if (!r) return NULL;

    /* 第一遍：统计匹配行数 */
    uint32_t total = 0;
    for (uint32_t i = 0; i < db->symbol_count; i++) {
        SymbolData* sd = &db->symbols[i];
        for (uint32_t j = 0; j < sd->count; j++) {
            if (row_matches(sd, j, f)) total++;
        }
    }

    if (total == 0) {
        r->rows = NULL; r->count = 0; r->capacity = 0;
        return r;
    }

    ResultRow* buf = (ResultRow*)malloc(total * sizeof(ResultRow));
    if (!buf) {
        r->rows = NULL; r->count = 0; r->capacity = 0;
        return r;
    }

    /* 第二遍：填充数据 */
    uint32_t idx = 0;
    for (uint32_t i = 0; i < db->symbol_count; i++) {
        SymbolData* sd = &db->symbols[i];
        for (uint32_t j = 0; j < sd->count; j++) {
            if (!row_matches(sd, j, f)) continue;
            buf[idx].row = sd->klines[j];
            strncpy(buf[idx].symbol,   sd->symbol,   31); buf[idx].symbol[31]   = '\0';
            strncpy(buf[idx].interval, sd->interval, 15); buf[idx].interval[15] = '\0';
            idx++;
        }
    }

    r->rows     = (KlineRow*)buf;
    r->count    = total;
    r->capacity = NDTSDB_RESULT_EXTENDED;
    return r;
}

NDTSDB* ndtsdb_open(const char* path) {
    return ndtsdb_open_snapshot(path, 0);
}

/* ============================================================
 * Phase 2: Sparse Index & Streaming Iterator (Issue #139)
 * Structure definitions moved to ndtsdb.h (public API)
 * ============================================================ */

/* ============================================================
 * load_ndts_file — 将单个 .ndts 文件（NDTS 格式）加载到 db->symbols
 *
 * 支持：
 *   - 无压缩（raw float64）
 *   - gorilla 压缩（compression":"gorilla"）
 * 跳过：
 *   - 旧版 TS 压缩文件（"enabled":true）
 *   - magic 不匹配 / 头部损坏的文件
 * 校验：
 *   - header CRC32（4096字节 header block 后的4字节）
 *   - chunk CRC32（每个 chunk 后的4字节）
 *
 * 返回加载的行数，出错返回 -1。
 * ============================================================ */
/**
 * load_ndtb_file — 读取 .ndtb 列式存储文件
 *
 * 格式：
 *   [0..3]      Magic: "NDTB"
 *   [4..7]      Header JSON length (uint32_t LE)
 *   [8..8+len]  Header JSON
 *   [8+len..4095] Padding
 *   [4096..4099] Header CRC32
 *   [4100..]    Column Data Chunks
 *
 * 返回加载的行数，出错返回 -1。
 */
int load_ndtb_file(NDTSDB* db, const char* filepath) {
    FILE* f = fopen(filepath, "rb");
    if (!f) return -1;

    /* 1. 读取并验证完整 4096 字节 header block */
    uint8_t header_block[4096];
    if (fread(header_block, 1, 4096, f) != 4096) { fclose(f); return -1; }
    if (memcmp(header_block, "NDTB", 4) != 0) { fclose(f); return -1; }

    /* 验证 header CRC32 */
    uint32_t expected_hcrc = crc32_buf(header_block, 4096);
    uint32_t actual_hcrc = 0;
    if (fread(&actual_hcrc, 4, 1, f) != 1) { fclose(f); return -1; }
    if (actual_hcrc != expected_hcrc) { fclose(f); return -1; }

    /* 2. 解析 header JSON */
    uint32_t header_len;
    memcpy(&header_len, header_block + 4, 4);
    if (header_len == 0 || header_len > 4088) { fclose(f); return -1; }

    char* header_json = (char*)malloc(header_len + 1);
    if (!header_json) { fclose(f); return -1; }
    memcpy(header_json, header_block + 8, header_len);
    header_json[header_len] = '\0';

    /* 3. 解析 stringDicts */
#define LNDTB_MAX_SYM 256
#define LNDTB_MAX_ITV 32
    char* sym_dict[LNDTB_MAX_SYM];
    char* itv_dict[LNDTB_MAX_ITV];
    memset(sym_dict, 0, sizeof(sym_dict));  /* MEM-2: 初始化防止 cleanup 泄漏 */
    memset(itv_dict, 0, sizeof(itv_dict));
    int n_sym = 0, n_itv = 0;

    /* 提取 symbol 数组 */
    const char* sym_start = strstr(header_json, "\"symbol\":[");
    if (sym_start) {
        sym_start += 10;
        const char* sym_end = strchr(sym_start, ']');
        if (sym_end) {
            const char* p = sym_start;
            while (p < sym_end && n_sym < LNDTB_MAX_SYM) {
                const char* q1 = strchr(p, '"');
                if (!q1 || q1 >= sym_end) break;
                const char* q2 = strchr(q1 + 1, '"');
                if (!q2 || q2 >= sym_end) break;
                size_t str_len = (size_t)(q2 - q1 - 1);
                if (str_len > 255) str_len = 255;  /* MEM-1: 限制最大字符串长度 */
                sym_dict[n_sym++] = strndup(q1 + 1, str_len);
                p = q2 + 1;
            }
        }
    }

    /* 提取 interval 数组 */
    const char* itv_start = strstr(header_json, "\"interval\":[");
    if (itv_start) {
        itv_start += 12;
        const char* itv_end = strchr(itv_start, ']');
        if (itv_end) {
            const char* p = itv_start;
            while (p < itv_end && n_itv < LNDTB_MAX_ITV) {
                const char* q1 = strchr(p, '"');
                if (!q1 || q1 >= itv_end) break;
                const char* q2 = strchr(q1 + 1, '"');
                if (!q2 || q2 >= itv_end) break;
                size_t str_len = (size_t)(q2 - q1 - 1);
                if (str_len > 255) str_len = 255;  /* MEM-1: 限制最大字符串长度 */
                itv_dict[n_itv++] = strndup(q1 + 1, str_len);
                p = q2 + 1;
            }
        }
    }

    fprintf(stderr, "[ndtsdb debug] %s: n_sym=%d n_itv=%d\n", filepath, n_sym, n_itv);
    free(header_json);

    int total_loaded = 0;

    /* 4. 读取所有列数据块
     * 列顺序（预期）:
     *   0: symbol (dict, int32_t[])
     *   1: interval (dict, int32_t[])
     *   2: timestamp (raw, int64_t[])
     *   3-7: OHLCV (gorilla, double[])
     *   8: quoteVolume (gorilla, double[])
     *   9: trades (delta, uint32_t[])
     *   10-11: takerBuy* (gorilla, double[])
     */

    uint32_t row_count = 0;
    int32_t* sym_ids = NULL;
    int32_t* itv_ids = NULL;
    int64_t* timestamps = NULL;
    double *opens = NULL, *highs = NULL, *lows = NULL, *closes = NULL, *volumes = NULL;
    double *quote_volumes = NULL;
    uint32_t* trades = NULL;
    double *taker_buy_volumes = NULL, *taker_buy_quote_volumes = NULL;

    /* 读取 symbol 列（dict）*/
    {
        uint8_t chunk_type = 0;
        uint32_t clen = 0;
        if (fread(&chunk_type, 1, 1, f) != 1 || chunk_type != 0x03) goto cleanup_ndtb;
        if (fread(&row_count, 4, 1, f) != 1 || row_count == 0 || row_count > 10000000) goto cleanup_ndtb;
        if (fread(&clen, 4, 1, f) != 1 || clen == 0) goto cleanup_ndtb;

        uint8_t* cbuf = (uint8_t*)malloc(clen);
        if (!cbuf) goto cleanup_ndtb;

        if (fread(cbuf, 1, clen, f) != clen) { free(cbuf); goto cleanup_ndtb; }

        uint32_t disk_crc = 0;
        if (fread(&disk_crc, 4, 1, f) != 1) { free(cbuf); goto cleanup_ndtb; }

        /* 验证 CRC */
        uint32_t crc_state = 0xFFFFFFFFu;
        crc_state = crc32_update(crc_state, &chunk_type, 1);
        crc_state = crc32_update(crc_state, &row_count, 4);
        crc_state = crc32_update(crc_state, &clen, 4);
        crc_state = crc32_update(crc_state, cbuf, clen);
        uint32_t computed_crc = crc_state ^ 0xFFFFFFFFu;
        if (disk_crc != computed_crc) { free(cbuf); goto cleanup_ndtb; }

        /* 解码 dict：格式 = n_items (uint32_t) + item_indices (uint32_t[]) */
        if (clen < 4) { free(cbuf); goto cleanup_ndtb; }
        /* MEM-3: 验证缓冲区足够容纳 header + 数据 */
        if (clen < 4 + row_count * 4) { free(cbuf); goto cleanup_ndtb; }
        uint32_t n_items = 0;
        memcpy(&n_items, cbuf, 4);
        if (n_items != row_count) { free(cbuf); goto cleanup_ndtb; }

        sym_ids = (int32_t*)malloc(row_count * 4);
        if (!sym_ids) { free(cbuf); goto cleanup_ndtb; }
        memcpy(sym_ids, cbuf + 4, row_count * 4);
        free(cbuf);
    }

    /* 读取 interval 列（dict）*/
    {
        uint8_t chunk_type = 0;
        uint32_t clen = 0;
        if (fread(&chunk_type, 1, 1, f) != 1 || chunk_type != 0x03) goto cleanup_ndtb;
        uint32_t row_count2 = 0;
        if (fread(&row_count2, 4, 1, f) != 1 || row_count2 != row_count) goto cleanup_ndtb;
        if (fread(&clen, 4, 1, f) != 1 || clen == 0) goto cleanup_ndtb;

        uint8_t* cbuf = (uint8_t*)malloc(clen);
        if (!cbuf) goto cleanup_ndtb;

        if (fread(cbuf, 1, clen, f) != clen) { free(cbuf); goto cleanup_ndtb; }

        uint32_t disk_crc = 0;
        if (fread(&disk_crc, 4, 1, f) != 1) { free(cbuf); goto cleanup_ndtb; }

        /* 验证 CRC */
        uint32_t crc_state = 0xFFFFFFFFu;
        crc_state = crc32_update(crc_state, &chunk_type, 1);
        crc_state = crc32_update(crc_state, &row_count2, 4);
        crc_state = crc32_update(crc_state, &clen, 4);
        crc_state = crc32_update(crc_state, cbuf, clen);
        uint32_t computed_crc = crc_state ^ 0xFFFFFFFFu;
        if (disk_crc != computed_crc) { free(cbuf); goto cleanup_ndtb; }

        if (clen < 4) { free(cbuf); goto cleanup_ndtb; }
        /* MEM-3: 验证缓冲区足够容纳 header + 数据 */
        if (clen < 4 + row_count * 4) { free(cbuf); goto cleanup_ndtb; }
        uint32_t n_items = 0;
        memcpy(&n_items, cbuf, 4);
        if (n_items != row_count) { free(cbuf); goto cleanup_ndtb; }

        itv_ids = (int32_t*)malloc(row_count * 4);
        if (!itv_ids) { free(cbuf); goto cleanup_ndtb; }
        memcpy(itv_ids, cbuf + 4, row_count * 4);
        free(cbuf);
    }

    /* 读取 timestamp 列（raw int64）*/
    {
        uint8_t chunk_type = 0;
        uint32_t clen = 0;
        if (fread(&chunk_type, 1, 1, f) != 1 || chunk_type != 0x00) goto cleanup_ndtb;
        uint32_t row_count2 = 0;
        if (fread(&row_count2, 4, 1, f) != 1 || row_count2 != row_count) goto cleanup_ndtb;
        if (fread(&clen, 4, 1, f) != 1 || clen != row_count * 8) goto cleanup_ndtb;

        timestamps = (int64_t*)malloc(row_count * 8);
        if (!timestamps) goto cleanup_ndtb;

        if (fread(timestamps, 8, row_count, f) != row_count) goto cleanup_ndtb;

        uint32_t disk_crc = 0;
        if (fread(&disk_crc, 4, 1, f) != 1) goto cleanup_ndtb;

        /* 验证 CRC */
        uint32_t crc_state = 0xFFFFFFFFu;
        crc_state = crc32_update(crc_state, &chunk_type, 1);
        crc_state = crc32_update(crc_state, &row_count2, 4);
        crc_state = crc32_update(crc_state, &clen, 4);
        crc_state = crc32_update(crc_state, (const uint8_t*)timestamps, row_count * 8);
        uint32_t computed_crc = crc_state ^ 0xFFFFFFFFu;
        if (disk_crc != computed_crc) goto cleanup_ndtb;
    }

    /* 读取 OHLCV 列（gorilla double，5 列）*/
    double* ohlcv[5];
    ohlcv[0] = opens = (double*)malloc(row_count * 8);
    ohlcv[1] = highs = (double*)malloc(row_count * 8);
    ohlcv[2] = lows = (double*)malloc(row_count * 8);
    ohlcv[3] = closes = (double*)malloc(row_count * 8);
    ohlcv[4] = volumes = (double*)malloc(row_count * 8);

    if (!opens || !highs || !lows || !closes || !volumes) goto cleanup_ndtb;

    for (int col = 0; col < 5; col++) {
        uint8_t chunk_type = 0;
        uint32_t clen = 0;
        if (fread(&chunk_type, 1, 1, f) != 1 || chunk_type != 0x01) goto cleanup_ndtb;
        uint32_t row_count2 = 0;
        if (fread(&row_count2, 4, 1, f) != 1 || row_count2 != row_count) goto cleanup_ndtb;
        if (fread(&clen, 4, 1, f) != 1 || clen == 0) goto cleanup_ndtb;

        uint8_t* cbuf = (uint8_t*)malloc(clen);
        if (!cbuf) goto cleanup_ndtb;

        if (fread(cbuf, 1, clen, f) != clen) { free(cbuf); goto cleanup_ndtb; }

        uint32_t disk_crc = 0;
        if (fread(&disk_crc, 4, 1, f) != 1) { free(cbuf); goto cleanup_ndtb; }

        /* 验证 CRC 和解压 */
        uint32_t crc_state = 0xFFFFFFFFu;
        crc_state = crc32_update(crc_state, &chunk_type, 1);
        crc_state = crc32_update(crc_state, &row_count2, 4);
        crc_state = crc32_update(crc_state, &clen, 4);
        crc_state = crc32_update(crc_state, cbuf, clen);
        uint32_t computed_crc = crc_state ^ 0xFFFFFFFFu;
        if (disk_crc != computed_crc) { free(cbuf); goto cleanup_ndtb; }

        size_t decoded = gorilla_decompress_f64(cbuf, clen, ohlcv[col], row_count);
        free(cbuf);
        if (decoded != row_count) goto cleanup_ndtb;
    }

    /* 读取 quoteVolume（gorilla double）*/
    {
        uint8_t chunk_type = 0;
        uint32_t clen = 0;
        if (fread(&chunk_type, 1, 1, f) != 1 || chunk_type != 0x01) goto cleanup_ndtb;
        uint32_t row_count2 = 0;
        if (fread(&row_count2, 4, 1, f) != 1 || row_count2 != row_count) goto cleanup_ndtb;
        if (fread(&clen, 4, 1, f) != 1 || clen == 0) goto cleanup_ndtb;

        quote_volumes = (double*)malloc(row_count * 8);
        if (!quote_volumes) goto cleanup_ndtb;

        uint8_t* cbuf = (uint8_t*)malloc(clen);
        if (!cbuf) goto cleanup_ndtb;

        if (fread(cbuf, 1, clen, f) != clen) { free(cbuf); goto cleanup_ndtb; }

        uint32_t disk_crc = 0;
        if (fread(&disk_crc, 4, 1, f) != 1) { free(cbuf); goto cleanup_ndtb; }

        /* 验证 CRC 和解压 */
        uint32_t crc_state = 0xFFFFFFFFu;
        crc_state = crc32_update(crc_state, &chunk_type, 1);
        crc_state = crc32_update(crc_state, &row_count2, 4);
        crc_state = crc32_update(crc_state, &clen, 4);
        crc_state = crc32_update(crc_state, cbuf, clen);
        uint32_t computed_crc = crc_state ^ 0xFFFFFFFFu;
        if (disk_crc != computed_crc) { free(cbuf); goto cleanup_ndtb; }

        size_t decoded = gorilla_decompress_f64(cbuf, clen, quote_volumes, row_count);
        free(cbuf);
        if (decoded != row_count) goto cleanup_ndtb;
    }

    /* 读取 trades（delta uint32）*/
    {
        uint8_t chunk_type = 0;
        uint32_t clen = 0;
        if (fread(&chunk_type, 1, 1, f) != 1 || chunk_type != 0x02) goto cleanup_ndtb;
        uint32_t row_count2 = 0;
        if (fread(&row_count2, 4, 1, f) != 1 || row_count2 != row_count) goto cleanup_ndtb;
        if (fread(&clen, 4, 1, f) != 1 || clen == 0) goto cleanup_ndtb;

        trades = (uint32_t*)malloc(row_count * 4);
        if (!trades) goto cleanup_ndtb;

        uint8_t* cbuf = (uint8_t*)malloc(clen);
        if (!cbuf) goto cleanup_ndtb;

        if (fread(cbuf, 1, clen, f) != clen) { free(cbuf); goto cleanup_ndtb; }

        uint32_t disk_crc = 0;
        if (fread(&disk_crc, 4, 1, f) != 1) { free(cbuf); goto cleanup_ndtb; }

        /* 验证 CRC 和解压 */
        uint32_t crc_state = 0xFFFFFFFFu;
        crc_state = crc32_update(crc_state, &chunk_type, 1);
        crc_state = crc32_update(crc_state, &row_count2, 4);
        crc_state = crc32_update(crc_state, &clen, 4);
        crc_state = crc32_update(crc_state, cbuf, clen);
        uint32_t computed_crc = crc_state ^ 0xFFFFFFFFu;
        if (disk_crc != computed_crc) { free(cbuf); goto cleanup_ndtb; }

        /* 注意：delta_decompress_i32 返回 int32_t，但需要 uint32_t */
        int32_t* tmp_trades = (int32_t*)trades;
        size_t decoded = delta_decompress_i32(cbuf, clen, tmp_trades, row_count);
        free(cbuf);
        if (decoded != row_count) goto cleanup_ndtb;
    }

    /* 读取 takerBuyVolume 和 takerBuyQuoteVolume（gorilla double，2 列）*/
    {
        uint8_t chunk_type = 0;
        uint32_t clen = 0;
        if (fread(&chunk_type, 1, 1, f) != 1 || chunk_type != 0x01) goto cleanup_ndtb;
        uint32_t row_count2 = 0;
        if (fread(&row_count2, 4, 1, f) != 1 || row_count2 != row_count) goto cleanup_ndtb;
        if (fread(&clen, 4, 1, f) != 1 || clen == 0) goto cleanup_ndtb;

        taker_buy_volumes = (double*)malloc(row_count * 8);
        if (!taker_buy_volumes) goto cleanup_ndtb;

        uint8_t* cbuf = (uint8_t*)malloc(clen);
        if (!cbuf) goto cleanup_ndtb;

        if (fread(cbuf, 1, clen, f) != clen) { free(cbuf); goto cleanup_ndtb; }

        uint32_t disk_crc = 0;
        if (fread(&disk_crc, 4, 1, f) != 1) { free(cbuf); goto cleanup_ndtb; }

        uint32_t crc_state = 0xFFFFFFFFu;
        crc_state = crc32_update(crc_state, &chunk_type, 1);
        crc_state = crc32_update(crc_state, &row_count2, 4);
        crc_state = crc32_update(crc_state, &clen, 4);
        crc_state = crc32_update(crc_state, cbuf, clen);
        uint32_t computed_crc = crc_state ^ 0xFFFFFFFFu;
        if (disk_crc != computed_crc) { free(cbuf); goto cleanup_ndtb; }

        size_t decoded = gorilla_decompress_f64(cbuf, clen, taker_buy_volumes, row_count);
        free(cbuf);
        if (decoded != row_count) goto cleanup_ndtb;
    }

    {
        uint8_t chunk_type = 0;
        uint32_t clen = 0;
        if (fread(&chunk_type, 1, 1, f) != 1 || chunk_type != 0x01) goto cleanup_ndtb;
        uint32_t row_count2 = 0;
        if (fread(&row_count2, 4, 1, f) != 1 || row_count2 != row_count) goto cleanup_ndtb;
        if (fread(&clen, 4, 1, f) != 1 || clen == 0) goto cleanup_ndtb;

        taker_buy_quote_volumes = (double*)malloc(row_count * 8);
        if (!taker_buy_quote_volumes) goto cleanup_ndtb;

        uint8_t* cbuf = (uint8_t*)malloc(clen);
        if (!cbuf) goto cleanup_ndtb;

        if (fread(cbuf, 1, clen, f) != clen) { free(cbuf); goto cleanup_ndtb; }

        uint32_t disk_crc = 0;
        if (fread(&disk_crc, 4, 1, f) != 1) { free(cbuf); goto cleanup_ndtb; }

        uint32_t crc_state = 0xFFFFFFFFu;
        crc_state = crc32_update(crc_state, &chunk_type, 1);
        crc_state = crc32_update(crc_state, &row_count2, 4);
        crc_state = crc32_update(crc_state, &clen, 4);
        crc_state = crc32_update(crc_state, cbuf, clen);
        uint32_t computed_crc = crc_state ^ 0xFFFFFFFFu;
        if (disk_crc != computed_crc) { free(cbuf); goto cleanup_ndtb; }

        size_t decoded = gorilla_decompress_f64(cbuf, clen, taker_buy_quote_volumes, row_count);
        free(cbuf);
        if (decoded != row_count) goto cleanup_ndtb;
    }

    /* 5. 重建行数据并插入数据库 */
    // Guard: 确保字典非空
    if (n_sym == 0 || n_itv == 0) {
        fprintf(stderr, "[ndtsdb] ERROR: Empty dictionaries (n_sym=%d, n_itv=%d)\n", n_sym, n_itv);
        goto cleanup_ndtb;
    }
    for (uint32_t i = 0; i < row_count; i++) {
        const char* sym = (sym_ids[i] >= 0 && sym_ids[i] < n_sym)
                          ? sym_dict[sym_ids[i]] : "UNKNOWN";
        const char* itv = (itv_ids[i] >= 0 && itv_ids[i] < n_itv)
                          ? itv_dict[itv_ids[i]] : "UNKNOWN";

        SymbolData* sd = find_or_create_symbol(db, sym, itv);
        if (!sd) continue;

        if (sd->count >= sd->capacity) {
            uint32_t nc = sd->capacity * 2;
            KlineRow* nk = (KlineRow*)realloc(sd->klines, nc * sizeof(KlineRow));
            if (!nk) continue;
            sd->klines   = nk;
            sd->capacity = nc;
        }

        sd->klines[sd->count].timestamp = timestamps[i];
        sd->klines[sd->count].open      = opens[i];
        sd->klines[sd->count].high      = highs[i];
        sd->klines[sd->count].low       = lows[i];
        sd->klines[sd->count].close     = closes[i];
        sd->klines[sd->count].volume    = volumes[i];
        sd->klines[sd->count].quoteVolume    = quote_volumes[i];
        sd->klines[sd->count].trades         = trades[i];
        sd->klines[sd->count].takerBuyVolume = taker_buy_volumes[i];
        sd->klines[sd->count].takerBuyQuoteVolume = taker_buy_quote_volumes[i];
        sd->klines[sd->count].flags     = 0;
        sd->count++;
        total_loaded++;
    }

cleanup_ndtb:
    fclose(f);
    free(sym_ids);
    free(itv_ids);
    free(timestamps);
    free(opens);
    free(highs);
    free(lows);
    free(closes);
    free(volumes);
    free(quote_volumes);
    free(trades);
    free(taker_buy_volumes);
    free(taker_buy_quote_volumes);
    for (int i = 0; i < n_sym; i++) free(sym_dict[i]);
    for (int i = 0; i < n_itv; i++) free(itv_dict[i]);

    fprintf(stderr, "[ndtsdb debug] %s: loaded %d rows (ndtb format)\n", filepath, total_loaded);

    return total_loaded;
}

/**
 * write_ndtb_file — 写入 .ndtb 列式存储文件
 *
 * 将内存中的所有 symbol/interval 组合的 KlineRows 写出到 .ndtb 格式文件。
 *
 * 格式：
 *   [0..3]      Magic: "NDTB"
 *   [4..7]      Header JSON length (uint32_t LE)
 *   [8..8+len]  Header JSON
 *   [8+len..4095] Padding
 *   [4096..4099] Header CRC32
 *   [4100..]    Column Data Chunks
 *
 * 返回写入的行数，失败返回 -1。
 */
int write_ndtb_file(const char* filepath, NDTSDB* db) {
    if (!filepath || !db || db->symbol_count == 0) return -1;

    char tmppath[512 + 4];
    snprintf(tmppath, sizeof(tmppath), "%s.tmp", filepath);

    FILE* f = fopen(tmppath, "wb");
    if (!f) return -1;

    /* === 第一步：收集所有 symbol/interval 和行数据 === */
    uint32_t total_rows = 0;
    char* sym_dict[LNDTB_MAX_SYM];
    char* itv_dict[LNDTB_MAX_ITV];
    int32_t n_sym = 0, n_itv = 0;

    int32_t* sym_ids = NULL;
    int32_t* itv_ids = NULL;
    KlineRow* all_rows = NULL;

    /* 第一遍扫描：计算总行数，建立字典 */
    for (uint32_t i = 0; i < db->symbol_count; i++) {
        SymbolData* sd = &db->symbols[i];
        if (sd->count == 0) continue;

        /* 添加 symbol 到字典 */
        int32_t sym_id = -1;
        for (int32_t j = 0; j < n_sym; j++) {
            if (strcmp(sym_dict[j], sd->symbol) == 0) {
                sym_id = j;
                break;
            }
        }
        if (sym_id == -1) {
            if (n_sym >= LNDTB_MAX_SYM) { fclose(f); return -1; }
            sym_dict[n_sym] = strdup(sd->symbol);
            sym_id = n_sym++;
        }

        /* 添加 interval 到字典 */
        int32_t itv_id = -1;
        for (int32_t j = 0; j < n_itv; j++) {
            if (strcmp(itv_dict[j], sd->interval) == 0) {
                itv_id = j;
                break;
            }
        }
        if (itv_id == -1) {
            if (n_itv >= LNDTB_MAX_ITV) { fclose(f); return -1; }
            itv_dict[n_itv] = strdup(sd->interval);
            itv_id = n_itv++;
        }

        total_rows += sd->count;
    }

    if (total_rows == 0 || total_rows > 10000000) {
        fclose(f);
        for (int i = 0; i < n_sym; i++) free(sym_dict[i]);
        for (int i = 0; i < n_itv; i++) free(itv_dict[i]);
        return -1;
    }

    /* === 第二步：构建 Header JSON === */
    char json[4080];
    int pos = 0;
    pos += snprintf(json+pos, sizeof(json)-pos, "{\"version\":\"1.0.0\",\"columns\":[");
    pos += snprintf(json+pos, sizeof(json)-pos,
        "\"symbol\",\"interval\",\"timestamp\",\"open\",\"high\",\"low\",\"close\",\"volume\",");
    pos += snprintf(json+pos, sizeof(json)-pos,
        "\"quoteVolume\",\"trades\",\"takerBuyVolume\",\"takerBuyQuoteVolume\"],");
    pos += snprintf(json+pos, sizeof(json)-pos,
        "\"compression\":{\"symbol\":\"dict\",\"interval\":\"dict\",\"timestamp\":\"raw\",");
    pos += snprintf(json+pos, sizeof(json)-pos,
        "\"open\":\"gorilla\",\"high\":\"gorilla\",\"low\":\"gorilla\",\"close\":\"gorilla\",");
    pos += snprintf(json+pos, sizeof(json)-pos,
        "\"volume\":\"gorilla\",\"quoteVolume\":\"gorilla\",\"trades\":\"delta\",");
    pos += snprintf(json+pos, sizeof(json)-pos,
        "\"takerBuyVolume\":\"gorilla\",\"takerBuyQuoteVolume\":\"gorilla\"},");
    pos += snprintf(json+pos, sizeof(json)-pos, "\"stringDicts\":{\"symbol\":[");
    for (int32_t i = 0; i < n_sym; i++) {
        pos += snprintf(json+pos, sizeof(json)-pos, "%s\"%s\"",
            i > 0 ? "," : "", sym_dict[i]);
    }
    pos += snprintf(json+pos, sizeof(json)-pos, "],\"interval\":[");
    for (int32_t i = 0; i < n_itv; i++) {
        pos += snprintf(json+pos, sizeof(json)-pos, "%s\"%s\"",
            i > 0 ? "," : "", itv_dict[i]);
    }
    pos += snprintf(json+pos, sizeof(json)-pos, "]},\"rowCount\":%u}", total_rows);

    if (pos >= 4080) {
        fclose(f);
        for (int i = 0; i < n_sym; i++) free(sym_dict[i]);
        for (int i = 0; i < n_itv; i++) free(itv_dict[i]);
        return -1;
    }

    /* 构建 header block（4096 字节） */
    uint8_t header_block[4096];
    memcpy(header_block, "NDTB", 4);
    uint32_t json_len = (uint32_t)pos;
    memcpy(header_block + 4, &json_len, 4);
    memcpy(header_block + 8, json, json_len);
    memset(header_block + 8 + json_len, 0, 4096 - 8 - json_len);

    /* 写 header block + CRC32 */
    uint32_t hcrc = crc32_buf(header_block, 4096);
    if (fwrite(header_block, 1, 4096, f) != 4096 ||
        fwrite(&hcrc, 4, 1, f) != 1) {
        fclose(f);
        unlink(tmppath);
        for (int i = 0; i < n_sym; i++) free(sym_dict[i]);
        for (int i = 0; i < n_itv; i++) free(itv_dict[i]);
        return -1;
    }

    /* === 第三步：收集所有行数据并建立 sym_ids/itv_ids === */
    sym_ids = (int32_t*)malloc(total_rows * 4);
    itv_ids = (int32_t*)malloc(total_rows * 4);
    all_rows = (KlineRow*)malloc(total_rows * sizeof(KlineRow));

    if (!sym_ids || !itv_ids || !all_rows) {
        fclose(f);
        unlink(tmppath);
        for (int i = 0; i < n_sym; i++) free(sym_dict[i]);
        for (int i = 0; i < n_itv; i++) free(itv_dict[i]);
        free(sym_ids);
        free(itv_ids);
        free(all_rows);
        return -1;
    }

    uint32_t row_idx = 0;
    for (uint32_t i = 0; i < db->symbol_count; i++) {
        SymbolData* sd = &db->symbols[i];
        if (sd->count == 0) continue;

        /* 查找 sym_id 和 itv_id */
        int32_t sym_id = -1;
        for (int32_t j = 0; j < n_sym; j++) {
            if (strcmp(sym_dict[j], sd->symbol) == 0) {
                sym_id = j;
                break;
            }
        }
        int32_t itv_id = -1;
        for (int32_t j = 0; j < n_itv; j++) {
            if (strcmp(itv_dict[j], sd->interval) == 0) {
                itv_id = j;
                break;
            }
        }

        for (uint32_t j = 0; j < sd->count; j++) {
            sym_ids[row_idx] = sym_id;
            itv_ids[row_idx] = itv_id;
            all_rows[row_idx] = sd->klines[j];
            row_idx++;
        }
    }

    /* === 第四步：提取列数据并压缩 === */
    size_t gorilla_bound = GORILLA_BOUND(total_rows);

    /* symbol 列（dict）*/
    uint8_t* buf_sym = (uint8_t*)malloc(total_rows * 4 + 4);
    size_t len_sym = 0;
    if (buf_sym) {
        memcpy(buf_sym, &total_rows, 4);
        memcpy(buf_sym + 4, sym_ids, total_rows * 4);
        len_sym = total_rows * 4 + 4;
    }

    /* interval 列（dict）*/
    uint8_t* buf_itv = (uint8_t*)malloc(total_rows * 4 + 4);
    size_t len_itv = 0;
    if (buf_itv) {
        memcpy(buf_itv, &total_rows, 4);
        memcpy(buf_itv + 4, itv_ids, total_rows * 4);
        len_itv = total_rows * 4 + 4;
    }

    /* timestamp 列（raw int64）*/
    int64_t* ts_col = (int64_t*)malloc(total_rows * 8);
    if (ts_col) {
        for (uint32_t i = 0; i < total_rows; i++) {
            ts_col[i] = all_rows[i].timestamp;
        }
    }

    /* OHLCV 列（gorilla double，5 列）*/
    double* col_open   = (double*)malloc(total_rows * 8);
    double* col_high   = (double*)malloc(total_rows * 8);
    double* col_low    = (double*)malloc(total_rows * 8);
    double* col_close  = (double*)malloc(total_rows * 8);
    double* col_volume = (double*)malloc(total_rows * 8);
    if (col_open && col_high && col_low && col_close && col_volume) {
        for (uint32_t i = 0; i < total_rows; i++) {
            col_open[i]   = all_rows[i].open;
            col_high[i]   = all_rows[i].high;
            col_low[i]    = all_rows[i].low;
            col_close[i]  = all_rows[i].close;
            col_volume[i] = all_rows[i].volume;
        }
    }

    /* quoteVolume 列（gorilla double）*/
    double* col_quote_vol = (double*)malloc(total_rows * 8);
    if (col_quote_vol) {
        for (uint32_t i = 0; i < total_rows; i++) {
            col_quote_vol[i] = all_rows[i].quoteVolume;
        }
    }

    /* trades 列（delta uint32）*/
    uint32_t* trades_col = (uint32_t*)malloc(total_rows * 4);
    if (trades_col) {
        for (uint32_t i = 0; i < total_rows; i++) {
            trades_col[i] = all_rows[i].trades;
        }
    }

    /* takerBuy* 列（gorilla double，2 列）*/
    double* col_taker_vol = (double*)malloc(total_rows * 8);
    double* col_taker_quote_vol = (double*)malloc(total_rows * 8);
    if (col_taker_vol && col_taker_quote_vol) {
        for (uint32_t i = 0; i < total_rows; i++) {
            col_taker_vol[i]       = all_rows[i].takerBuyVolume;
            col_taker_quote_vol[i] = all_rows[i].takerBuyQuoteVolume;
        }
    }

    /* 压缩缓冲区 */
    uint8_t* buf_open   = (uint8_t*)malloc(gorilla_bound);
    uint8_t* buf_high   = (uint8_t*)malloc(gorilla_bound);
    uint8_t* buf_low    = (uint8_t*)malloc(gorilla_bound);
    uint8_t* buf_close  = (uint8_t*)malloc(gorilla_bound);
    uint8_t* buf_volume = (uint8_t*)malloc(gorilla_bound);
    uint8_t* buf_quote_vol = (uint8_t*)malloc(gorilla_bound);
    uint8_t* buf_trades = (uint8_t*)malloc(total_rows * 5);
    uint8_t* buf_taker_vol = (uint8_t*)malloc(gorilla_bound);
    uint8_t* buf_taker_quote_vol = (uint8_t*)malloc(gorilla_bound);

    size_t len_open = 0, len_high = 0, len_low = 0, len_close = 0, len_volume = 0;
    size_t len_quote_vol = 0, len_trades = 0, len_taker_vol = 0, len_taker_quote_vol = 0;

    if (col_open && buf_open) len_open = gorilla_compress_f64(col_open, total_rows, buf_open);
    if (col_high && buf_high) len_high = gorilla_compress_f64(col_high, total_rows, buf_high);
    if (col_low && buf_low) len_low = gorilla_compress_f64(col_low, total_rows, buf_low);
    if (col_close && buf_close) len_close = gorilla_compress_f64(col_close, total_rows, buf_close);
    if (col_volume && buf_volume) len_volume = gorilla_compress_f64(col_volume, total_rows, buf_volume);
    if (col_quote_vol && buf_quote_vol) len_quote_vol = gorilla_compress_f64(col_quote_vol, total_rows, buf_quote_vol);
    if (trades_col && buf_trades) len_trades = delta_compress_i32((int32_t*)trades_col, total_rows, buf_trades);
    if (col_taker_vol && buf_taker_vol) len_taker_vol = gorilla_compress_f64(col_taker_vol, total_rows, buf_taker_vol);
    if (col_taker_quote_vol && buf_taker_quote_vol) len_taker_quote_vol = gorilla_compress_f64(col_taker_quote_vol, total_rows, buf_taker_quote_vol);

    /* === 第五步：写所有列数据块 === */
#define WRITE_CHUNK(chunk_type, data, len, name) do { \
    uint8_t ct = (chunk_type); \
    uint32_t rowc = total_rows; \
    uint32_t datalen = (len); \
    uint32_t crc_state = 0xFFFFFFFFu; \
    crc_state = crc32_update(crc_state, &ct, 1); \
    crc_state = crc32_update(crc_state, &rowc, 4); \
    crc_state = crc32_update(crc_state, &datalen, 4); \
    crc_state = crc32_update(crc_state, (data), len); \
    uint32_t chunk_crc = crc_state ^ 0xFFFFFFFFu; \
    if (fwrite(&ct, 1, 1, f) != 1 || fwrite(&rowc, 4, 1, f) != 1 || \
        fwrite(&datalen, 4, 1, f) != 1 || fwrite((data), 1, len, f) != len || \
        fwrite(&chunk_crc, 4, 1, f) != 1) { \
        fprintf(stderr, "[ndtsdb] Failed to write chunk: %s\n", name); \
        goto cleanup_write_ndtb; \
    } \
} while(0)

    /* 写 symbol 列（dict, type=0x03）*/
    if (buf_sym) WRITE_CHUNK(0x03, buf_sym, len_sym, "symbol");

    /* 写 interval 列（dict, type=0x03）*/
    if (buf_itv) WRITE_CHUNK(0x03, buf_itv, len_itv, "interval");

    /* 写 timestamp 列（raw, type=0x00）*/
    {
        uint8_t ct = 0x00;
        uint32_t rowc = total_rows;
        uint32_t datalen = total_rows * 8;
        uint32_t crc_state = 0xFFFFFFFFu;
        crc_state = crc32_update(crc_state, &ct, 1);
        crc_state = crc32_update(crc_state, &rowc, 4);
        crc_state = crc32_update(crc_state, &datalen, 4);
        crc_state = crc32_update(crc_state, (const uint8_t*)ts_col, datalen);
        uint32_t chunk_crc = crc_state ^ 0xFFFFFFFFu;
        if (fwrite(&ct, 1, 1, f) != 1 || fwrite(&rowc, 4, 1, f) != 1 ||
            fwrite(&datalen, 4, 1, f) != 1 || fwrite(ts_col, 8, total_rows, f) != total_rows ||
            fwrite(&chunk_crc, 4, 1, f) != 1) {
            fprintf(stderr, "[ndtsdb] Failed to write chunk: timestamp\n");
            goto cleanup_write_ndtb;
        }
    }

    /* 写 OHLCV 列（gorilla, type=0x01，5 列）*/
    if (buf_open) WRITE_CHUNK(0x01, buf_open, len_open, "open");
    if (buf_high) WRITE_CHUNK(0x01, buf_high, len_high, "high");
    if (buf_low) WRITE_CHUNK(0x01, buf_low, len_low, "low");
    if (buf_close) WRITE_CHUNK(0x01, buf_close, len_close, "close");
    if (buf_volume) WRITE_CHUNK(0x01, buf_volume, len_volume, "volume");

    /* 写 quoteVolume 列（gorilla, type=0x01）*/
    if (buf_quote_vol) WRITE_CHUNK(0x01, buf_quote_vol, len_quote_vol, "quoteVolume");

    /* 写 trades 列（delta, type=0x02）*/
    if (buf_trades) WRITE_CHUNK(0x02, buf_trades, len_trades, "trades");

    /* 写 takerBuy* 列（gorilla, type=0x01，2 列）*/
    if (buf_taker_vol) WRITE_CHUNK(0x01, buf_taker_vol, len_taker_vol, "takerBuyVolume");
    if (buf_taker_quote_vol) WRITE_CHUNK(0x01, buf_taker_quote_vol, len_taker_quote_vol, "takerBuyQuoteVolume");

    /* 成功：关闭文件并原子 rename */
    fclose(f);
    if (rename(tmppath, filepath) != 0) {
        unlink(tmppath);
        fprintf(stderr, "[ndtsdb] Failed to rename %s to %s\n", tmppath, filepath);
        goto cleanup_write_ndtb;
    }

    fprintf(stderr, "[ndtsdb debug] %s: wrote %u rows (ndtb format)\n", filepath, total_rows);

    /* 清理 */
    free(sym_ids);
    free(itv_ids);
    free(all_rows);
    free(buf_sym);
    free(buf_itv);
    free(ts_col);
    free(col_open);
    free(col_high);
    free(col_low);
    free(col_close);
    free(col_volume);
    free(col_quote_vol);
    free(trades_col);
    free(buf_open);
    free(buf_high);
    free(buf_low);
    free(buf_close);
    free(buf_volume);
    free(buf_quote_vol);
    free(buf_trades);
    free(col_taker_vol);
    free(col_taker_quote_vol);
    free(buf_taker_vol);
    free(buf_taker_quote_vol);
    for (int i = 0; i < n_sym; i++) free(sym_dict[i]);
    for (int i = 0; i < n_itv; i++) free(itv_dict[i]);

    return (int)total_rows;

cleanup_write_ndtb:
    fclose(f);
    unlink(tmppath);
    free(sym_ids);
    free(itv_ids);
    free(all_rows);
    free(buf_sym);
    free(buf_itv);
    free(ts_col);
    free(col_open);
    free(col_high);
    free(col_low);
    free(col_close);
    free(col_volume);
    free(col_quote_vol);
    free(trades_col);
    free(buf_open);
    free(buf_high);
    free(buf_low);
    free(buf_close);
    free(buf_volume);
    free(buf_quote_vol);
    free(buf_trades);
    free(col_taker_vol);
    free(col_taker_quote_vol);
    free(buf_taker_vol);
    free(buf_taker_quote_vol);
    for (int i = 0; i < n_sym; i++) free(sym_dict[i]);
    for (int i = 0; i < n_itv; i++) free(itv_dict[i]);

    return -1;
}

static int load_ndts_file(NDTSDB* db, const char* filepath) {
    FILE* f = fopen(filepath, "rb");
    if (!f) return -1;

    /* 1. 读取并验证完整 4096 字节 header block */
    uint8_t header_block[4096];
    if (fread(header_block, 1, 4096, f) != 4096) { fclose(f); return -1; }

    /* 检测 Magic — 自动分发到对应的加载器 */
    if (memcmp(header_block, "NDTB", 4) == 0) {
        fclose(f);
        return load_ndtb_file(db, filepath);
    }

    if (memcmp(header_block, "NDTS", 4) != 0) { fclose(f); return -1; }

    /* 验证 header CRC32 */
    uint32_t expected_hcrc = crc32_buf(header_block, 4096);
    uint32_t actual_hcrc = 0;
    if (fread(&actual_hcrc, 4, 1, f) != 1) { fclose(f); return -1; }
    if (actual_hcrc != expected_hcrc) { fclose(f); return -1; }

    /* 2. 解析 header JSON（从 header_block[8] 起，长度由 header_block[4..7] 给出） */
    uint32_t header_len;
    memcpy(&header_len, header_block + 4, 4);
    if (header_len == 0 || header_len > 4088) { fclose(f); return -1; }  /* #99 */

    char* header_json = (char*)malloc(header_len + 1);
    if (!header_json) { fclose(f); return -1; }
    memcpy(header_json, header_block + 8, header_len);
    header_json[header_len] = '\0';

    /* 3. 解析 stringDicts */
#define LNDTS_MAX_SYM 250
#define LNDTS_MAX_ITV 32
    char* sym_dict[LNDTS_MAX_SYM];
    char* itv_dict[LNDTS_MAX_ITV];
    int n_sym = 0, n_itv = 0;

    /* 提取 symbol 数组 */
    const char* sym_start = strstr(header_json, "\"symbol\":[");
    if (sym_start) {
        sym_start += 10;
        const char* sym_end = strchr(sym_start, ']');
        if (sym_end) {
            const char* p = sym_start;
            while (p < sym_end && n_sym < LNDTS_MAX_SYM) {
                const char* q1 = strchr(p, '"');
                if (!q1 || q1 >= sym_end) break;
                const char* q2 = strchr(q1 + 1, '"');
                if (!q2 || q2 >= sym_end) break;
                sym_dict[n_sym++] = strndup(q1 + 1, (size_t)(q2 - q1 - 1));
                p = q2 + 1;
            }
        }
    }

    /* 提取 interval 数组 */
    const char* itv_start = strstr(header_json, "\"interval\":[");
    if (itv_start) {
        itv_start += 12;
        const char* itv_end = strchr(itv_start, ']');
        if (itv_end) {
            const char* p = itv_start;
            while (p < itv_end && n_itv < LNDTS_MAX_ITV) {
                const char* q1 = strchr(p, '"');
                if (!q1 || q1 >= itv_end) break;
                const char* q2 = strchr(q1 + 1, '"');
                if (!q2 || q2 >= itv_end) break;
                itv_dict[n_itv++] = strndup(q1 + 1, (size_t)(q2 - q1 - 1));
                p = q2 + 1;
            }
        }
    }

    /* 4. 检测格式标志 */
    int has_compression_obj = (strstr(header_json, "\"compression\":{") != NULL);
    /* 重新启用 new bucket format 读取 — #132 bug 已修复（itv_ids 读取路径添加） */
    int is_new_bucket_format = (has_compression_obj && strstr(header_json, "\"enabled\":true") != NULL);
    int is_old_ts = (!has_compression_obj && strstr(header_json, "\"enabled\":true") != NULL);
    int is_gorilla = (strstr(header_json, "\"compression\":\"gorilla\"") != NULL) || (has_compression_obj && !is_new_bucket_format);

    /* 检测额外列存在性（用于向后兼容） */
    int has_quoteVolume = (strstr(header_json, "\"quoteVolume\"") != NULL);
    int has_trades = (strstr(header_json, "\"trades\"") != NULL);
    int has_takerBuyVolume = (strstr(header_json, "\"takerBuyVolume\"") != NULL);
    int has_takerBuyQuoteVolume = (strstr(header_json, "\"takerBuyQuoteVolume\"") != NULL);

    /*  consolidated flag: 如果任意一个额外列存在，就假设全部存在（分区文件格式） */
    int has_extra_cols = has_quoteVolume || has_trades || has_takerBuyVolume || has_takerBuyQuoteVolume;

    fprintf(stderr, "[ndtsdb debug] %s: is_new_bucket_format=%d has_extra_cols=%d\n",
            filepath, is_new_bucket_format, has_extra_cols);

    free(header_json);

    if (is_old_ts && !is_new_bucket_format) {
        /* 旧版 TS 压缩格式（纯 enabled:true，无 compression 对象），跳过 */
        for (int i = 0; i < n_sym; i++) free(sym_dict[i]);
        for (int i = 0; i < n_itv; i++) free(itv_dict[i]);
        fclose(f);
        return 0;
    }

    if (is_new_bucket_format) {
        /* 新格式（bucket-*.ndts）：分列压缩 + delta + gorilla */
        int total_loaded = 0;
        int chunk_num = 0;

        while (!feof(f)) {
            chunk_num++;
            /* snapshot 限制 */
            if (db->snapshot_size > 0) {
                long pos = ftell(f);
                if (pos < 0 || (uint64_t)pos >= db->snapshot_size) break;
            }

            uint32_t row_count = 0;
            if (fread(&row_count, 4, 1, f) != 1) {
                fprintf(stderr, "[ndtsdb debug] chunk %d: failed to read row_count\n", chunk_num);
                break;
            }
            if (row_count == 0) {
                fprintf(stderr, "[ndtsdb debug] chunk %d: row_count is 0\n", chunk_num);
                break;
            }
            if (row_count > 10000000) {
                fprintf(stderr, "[ndtsdb debug] chunk %d: row_count %u too large\n", chunk_num, row_count);
                break;
            }
            fprintf(stderr, "[ndtsdb debug] chunk %d: row_count=%u (new bucket format)\n", chunk_num, row_count);

            /* 增量 CRC 状态 */
            uint32_t crc_state = 0xFFFFFFFFu;
            crc_state = crc32_update(crc_state, &row_count, 4);

            /* 分配列缓冲区 */
            int32_t*  sym_ids    = (int32_t*)malloc(row_count * 4);
            int32_t*  itv_ids    = (int32_t*)malloc(row_count * 4);
            int64_t*  timestamps = (int64_t*)malloc(row_count * 8);
            double*   opens      = (double*)malloc(row_count * 8);
            double*   highs      = (double*)malloc(row_count * 8);
            double*   lows       = (double*)malloc(row_count * 8);
            double*   closes     = (double*)malloc(row_count * 8);
            double*   volumes    = (double*)malloc(row_count * 8);
            double*   quote_volumes    = (double*)malloc(row_count * 8);
            int32_t*  trades           = (int32_t*)malloc(row_count * 4);
            double*   taker_buy_volumes      = (double*)malloc(row_count * 8);
            double*   taker_buy_quote_volumes = (double*)malloc(row_count * 8);

            if (!sym_ids || !itv_ids || !timestamps || !opens || !highs || !lows || !closes || !volumes ||
                !quote_volumes || !trades || !taker_buy_volumes || !taker_buy_quote_volumes) {
                free(sym_ids); free(itv_ids); free(timestamps); free(opens); free(highs); free(lows);
                free(closes); free(volumes); free(quote_volumes); free(trades);
                free(taker_buy_volumes); free(taker_buy_quote_volumes);
                break;
            }

            int ok = 1;

            /* 读取 symbol_id: [len(4) + delta_data(len)] */
            /* Issue #137: Allow clen == 0 for new bucket format (all symbols may be same) */
            if (ok) {
                uint32_t clen = 0;
                if (fread(&clen, 4, 1, f) != 1 || clen > row_count * 4) {
                    fprintf(stderr, "[ndtsdb debug] chunk %d: invalid symbol_id length %u\n", chunk_num, clen);
                    ok = 0;
                } else if (clen == 0) {
                    /* Issue #137: clen == 0 means all symbol_ids are 0 (default) */
                    fprintf(stderr, "[ndtsdb debug] chunk %d: symbol_id length is 0, using default value 0\n", chunk_num);
                    for (uint32_t i = 0; i < row_count; i++) {
                        sym_ids[i] = 0;
                    }
                    crc_state = crc32_update(crc_state, &clen, 4);
                } else {
                    uint8_t* cbuf = (uint8_t*)malloc(clen);
                    if (!cbuf) { ok = 0; }
                    else if (fread(cbuf, 1, clen, f) != clen) {
                        fprintf(stderr, "[ndtsdb debug] chunk %d: failed to read symbol_id data\n", chunk_num);
                        free(cbuf);
                        ok = 0;
                    } else {
                        crc_state = crc32_update(crc_state, &clen, 4);
                        crc_state = crc32_update(crc_state, cbuf, clen);
                        size_t decoded = delta_decompress_i32(cbuf, clen, sym_ids, row_count);
                        free(cbuf);
                        if (decoded != row_count) {
                            fprintf(stderr, "[ndtsdb debug] chunk %d: symbol_id decode mismatch %zu vs %u\n", chunk_num, decoded, row_count);
                            ok = 0;
                        }
                    }
                }
            }

            /* 读取 itv_ids (raw int32 × row_count) — 修复 #132 bug */
            if (ok) {
                size_t itv_bytes = (size_t)row_count * 4;
                if (fread(itv_ids, 1, itv_bytes, f) != itv_bytes) {
                    fprintf(stderr, "[ndtsdb debug] chunk %d: failed to read itv_ids data\n", chunk_num);
                    ok = 0;
                } else {
                    crc_state = crc32_update(crc_state, (uint8_t*)itv_ids, itv_bytes);
                }
            }

            /* 读取 timestamp: [len(4) + delta_data(len)] */
            if (ok) {
                uint32_t clen = 0;
                if (fread(&clen, 4, 1, f) != 1 || clen == 0 || clen > row_count * 8) {
                    fprintf(stderr, "[ndtsdb debug] chunk %d: invalid timestamp length %u\n", chunk_num, clen);
                    ok = 0;
                } else {
                    uint8_t* cbuf = (uint8_t*)malloc(clen);
                    if (!cbuf) { ok = 0; }
                    else if (fread(cbuf, 1, clen, f) != clen) {
                        fprintf(stderr, "[ndtsdb debug] chunk %d: failed to read timestamp data\n", chunk_num);
                        free(cbuf);
                        ok = 0;
                    } else {
                        crc_state = crc32_update(crc_state, &clen, 4);
                        crc_state = crc32_update(crc_state, cbuf, clen);
                        size_t decoded = delta_decompress_i64(cbuf, clen, timestamps, row_count);
                        free(cbuf);
                        if (decoded != row_count) {
                            fprintf(stderr, "[ndtsdb debug] chunk %d: timestamp decode mismatch %zu vs %u\n", chunk_num, decoded, row_count);
                            ok = 0;
                        }
                    }
                }
            }

            /* 读取 OHLCV (5 列 gorilla) */
            if (ok) {
                double* ohlcv_basic[5] = { opens, highs, lows, closes, volumes };
                const char* ohlcv_names[5] = { "open", "high", "low", "close", "volume" };
                for (int ci = 0; ci < 5 && ok; ci++) {
                    uint32_t clen = 0;
                    long pos_before = ftell(f);
                    if (fread(&clen, 4, 1, f) != 1 || clen == 0 || clen > (uint32_t)GORILLA_BOUND(row_count)) {
                        fprintf(stderr, "[ndtsdb debug] chunk %d: invalid ohlcv[%d](%s) length %u at pos %ld\n", chunk_num, ci, ohlcv_names[ci], clen, pos_before);
                        ok = 0;
                        break;
                    }
                    uint8_t* cbuf = (uint8_t*)malloc(clen);
                    if (!cbuf) { ok = 0; break; }
                    if (fread(cbuf, 1, clen, f) != clen) {
                        fprintf(stderr, "[ndtsdb debug] chunk %d: failed to read ohlcv[%d] data\n", chunk_num, ci);
                        free(cbuf);
                        ok = 0;
                        break;
                    }
                    crc_state = crc32_update(crc_state, &clen, 4);
                    crc_state = crc32_update(crc_state, cbuf, clen);
                    size_t decoded = gorilla_decompress_f64(cbuf, clen, ohlcv_basic[ci], row_count);
                    free(cbuf);
                    if (decoded != row_count) {
                        fprintf(stderr, "[ndtsdb debug] chunk %d: ohlcv[%d](%s) decode mismatch %zu vs %u\n", chunk_num, ci, ohlcv_names[ci], decoded, row_count);
                        ok = 0;
                    } else {
                        fprintf(stderr, "[ndtsdb debug] chunk %d: ohlcv[%d](%s) OK len=%u decoded=%zu\n", chunk_num, ci, ohlcv_names[ci], clen, decoded);
                    }
                }
                fprintf(stderr, "[ndtsdb debug] chunk %d: after OHLCV, file pos=%ld\n", chunk_num, ftell(f));
            }

            /* 读取 quoteVolume (gorilla) */
            if (ok) {
                uint32_t clen = 0;
                long pos_before = ftell(f);
                if (fread(&clen, 4, 1, f) != 1) {
                    fprintf(stderr, "[ndtsdb debug] chunk %d: failed to read quoteVolume length at pos %ld\n", chunk_num, pos_before);
                    ok = 0;
                } else if (clen == 0) {
                    fprintf(stderr, "[ndtsdb debug] chunk %d: quoteVolume length is 0 (pos %ld), skipping\n", chunk_num, pos_before);
                    ok = 0;
                } else if (clen > (uint32_t)GORILLA_BOUND(row_count)) {
                    fprintf(stderr, "[ndtsdb debug] chunk %d: quoteVolume length %u exceeds bound %u (pos %ld)\n", chunk_num, clen, (uint32_t)GORILLA_BOUND(row_count), pos_before);
                    ok = 0;
                } else {
                    fprintf(stderr, "[ndtsdb debug] chunk %d: reading quoteVolume len=%u at pos %ld\n", chunk_num, clen, pos_before);
                    uint8_t* cbuf = (uint8_t*)malloc(clen);
                    if (!cbuf) {
                        fprintf(stderr, "[ndtsdb debug] chunk %d: malloc failed for quoteVolume\n", chunk_num);
                        ok = 0;
                    }
                    else if (fread(cbuf, 1, clen, f) != clen) {
                        fprintf(stderr, "[ndtsdb debug] chunk %d: failed to read quoteVolume data (%u bytes)\n", chunk_num, clen);
                        free(cbuf);
                        ok = 0;
                    } else {
                        crc_state = crc32_update(crc_state, &clen, 4);
                        crc_state = crc32_update(crc_state, cbuf, clen);
                        fprintf(stderr, "[ndtsdb debug] chunk %d: quoteVolume buf len=%u, first 8 bytes: %02x%02x%02x%02x %02x%02x%02x%02x\n",
                            chunk_num, clen, cbuf[0], cbuf[1], cbuf[2], cbuf[3], cbuf[4], cbuf[5], cbuf[6], clen > 7 ? cbuf[7] : 0);
                        size_t decoded = gorilla_decompress_f64(cbuf, clen, quote_volumes, row_count);
                        fprintf(stderr, "[ndtsdb debug] chunk %d: quoteVolume decoded %zu rows (expected %u)\n", chunk_num, decoded, row_count);
                        free(cbuf);
                        if (decoded != row_count) {
                            fprintf(stderr, "[ndtsdb debug] chunk %d: quoteVolume decode mismatch %zu vs %u\n", chunk_num, decoded, row_count);
                            ok = 0;
                        }
                    }
                }
            }

            /* 读取 takerBuyVolume (gorilla) — 必须在 trades 之前读取 */
            if (ok) {
                uint32_t clen = 0;
                if (fread(&clen, 4, 1, f) != 1 || clen == 0 || clen > (uint32_t)GORILLA_BOUND(row_count)) {
                    fprintf(stderr, "[ndtsdb debug] chunk %d: invalid takerBuyVolume length %u\n", chunk_num, clen);
                    ok = 0;
                } else {
                    uint8_t* cbuf = (uint8_t*)malloc(clen);
                    if (!cbuf) { ok = 0; }
                    else if (fread(cbuf, 1, clen, f) != clen) {
                        fprintf(stderr, "[ndtsdb debug] chunk %d: failed to read takerBuyVolume data\n", chunk_num);
                        free(cbuf);
                        ok = 0;
                    } else {
                        crc_state = crc32_update(crc_state, &clen, 4);
                        crc_state = crc32_update(crc_state, cbuf, clen);
                        size_t decoded = gorilla_decompress_f64(cbuf, clen, taker_buy_volumes, row_count);
                        free(cbuf);
                        if (decoded != row_count) {
                            fprintf(stderr, "[ndtsdb debug] chunk %d: takerBuyVolume decode mismatch %zu vs %u\n", chunk_num, decoded, row_count);
                            ok = 0;
                        }
                    }
                }
            }

            /* 读取 takerBuyQuoteVolume (gorilla) — 在 trades 之前 */
            if (ok) {
                uint32_t clen = 0;
                if (fread(&clen, 4, 1, f) != 1 || clen == 0 || clen > (uint32_t)GORILLA_BOUND(row_count)) {
                    fprintf(stderr, "[ndtsdb debug] chunk %d: invalid takerBuyQuoteVolume length %u\n", chunk_num, clen);
                    ok = 0;
                } else {
                    uint8_t* cbuf = (uint8_t*)malloc(clen);
                    if (!cbuf) { ok = 0; }
                    else if (fread(cbuf, 1, clen, f) != clen) {
                        fprintf(stderr, "[ndtsdb debug] chunk %d: failed to read takerBuyQuoteVolume data\n", chunk_num);
                        free(cbuf);
                        ok = 0;
                    } else {
                        crc_state = crc32_update(crc_state, &clen, 4);
                        crc_state = crc32_update(crc_state, cbuf, clen);
                        size_t decoded = gorilla_decompress_f64(cbuf, clen, taker_buy_quote_volumes, row_count);
                        free(cbuf);
                        if (decoded != row_count) {
                            fprintf(stderr, "[ndtsdb debug] chunk %d: takerBuyQuoteVolume decode mismatch %zu vs %u\n", chunk_num, decoded, row_count);
                            ok = 0;
                        }
                    }
                }
            }

            /* 读取 trades: [len(4) + delta_data(len)] (int32) — 在所有 OHLCV 列之后 */
            if (ok) {
                uint32_t clen = 0;
                if (fread(&clen, 4, 1, f) != 1 || clen == 0 || clen > row_count * 4) {
                    fprintf(stderr, "[ndtsdb debug] chunk %d: invalid trades length %u\n", chunk_num, clen);
                    ok = 0;
                } else {
                    uint8_t* cbuf = (uint8_t*)malloc(clen);
                    if (!cbuf) { ok = 0; }
                    else if (fread(cbuf, 1, clen, f) != clen) {
                        fprintf(stderr, "[ndtsdb debug] chunk %d: failed to read trades data\n", chunk_num);
                        free(cbuf);
                        ok = 0;
                    } else {
                        crc_state = crc32_update(crc_state, &clen, 4);
                        crc_state = crc32_update(crc_state, cbuf, clen);
                        size_t decoded = delta_decompress_i32(cbuf, clen, trades, row_count);
                        free(cbuf);
                        if (decoded != row_count) {
                            fprintf(stderr, "[ndtsdb debug] chunk %d: trades decode mismatch %zu vs %u\n", chunk_num, decoded, row_count);
                            ok = 0;
                        }
                    }
                }
            }

            /* 读取 flags (raw int32 × row_count) */
            if (ok) {
                uint32_t* flags_buf = (uint32_t*)malloc(row_count * 4);
                if (!flags_buf) { ok = 0; }
                else if (fread(flags_buf, 4, row_count, f) != row_count) {
                    fprintf(stderr, "[ndtsdb debug] chunk %d: failed to read flags data\n", chunk_num);
                    free(flags_buf);
                    ok = 0;
                } else {
                    crc_state = crc32_update(crc_state, (uint8_t*)flags_buf, row_count * 4);
                    free(flags_buf);
                }
            }

            /* 验证 chunk CRC32 */
            if (ok) {
                uint32_t computed_crc = crc_state ^ 0xFFFFFFFFu;
                uint32_t disk_crc = 0;
                if (fread(&disk_crc, 4, 1, f) != 1) {
                    fprintf(stderr, "[ndtsdb debug] chunk %d: failed to read crc\n", chunk_num);
                    ok = 0;
                } else if (disk_crc != computed_crc) {
                    fprintf(stderr, "[ndtsdb] chunk CRC mismatch in %s: computed=0x%08X disk=0x%08X rows=%u — skipping\n",
                            filepath, computed_crc, disk_crc, row_count);
                    free(sym_ids); free(itv_ids); free(timestamps); free(opens); free(highs); free(lows);
                    free(closes); free(volumes); free(quote_volumes); free(trades);
                    free(taker_buy_volumes); free(taker_buy_quote_volumes);
                    continue;
                }
            }

            if (!ok) {
                free(sym_ids); free(itv_ids); free(timestamps); free(opens); free(highs); free(lows);
                free(closes); free(volumes); free(quote_volumes); free(trades);
                free(taker_buy_volumes); free(taker_buy_quote_volumes);
                break;
            }

            /* 将行写入 db->symbols */
            /* 使用读取的 sym_ids 和 itv_ids 查找符号和时间间隔 */
            for (uint32_t i = 0; i < row_count; i++) {
                const char* sym = (sym_ids[i] >= 0 && sym_ids[i] < n_sym)
                                  ? sym_dict[sym_ids[i]] : "UNKNOWN";
                const char* itv = (itv_ids[i] >= 0 && itv_ids[i] < n_itv)
                                  ? itv_dict[itv_ids[i]] : "_";

                SymbolData* sd = find_or_create_symbol(db, sym, itv);
                if (!sd) continue;

                if (sd->count >= sd->capacity) {
                    uint32_t nc = sd->capacity * 2;
                    KlineRow* nk = (KlineRow*)realloc(sd->klines, nc * sizeof(KlineRow));
                    if (!nk) continue;
                    sd->klines   = nk;
                    sd->capacity = nc;
                }
                sd->klines[sd->count].timestamp = timestamps[i];
                sd->klines[sd->count].open      = opens[i];
                sd->klines[sd->count].high      = highs[i];
                sd->klines[sd->count].low       = lows[i];
                sd->klines[sd->count].close     = closes[i];
                sd->klines[sd->count].volume    = volumes[i];
                sd->klines[sd->count].quoteVolume    = quote_volumes[i];
                sd->klines[sd->count].trades         = trades[i];
                sd->klines[sd->count].takerBuyVolume = taker_buy_volumes[i];
                sd->klines[sd->count].takerBuyQuoteVolume = taker_buy_quote_volumes[i];
                sd->klines[sd->count].flags     = 0;  /* 新格式无 flags */
                sd->count++;
                total_loaded++;
            }

            free(sym_ids); free(itv_ids); free(timestamps); free(opens); free(highs); free(lows);
            free(closes); free(volumes); free(quote_volumes); free(trades);
            free(taker_buy_volumes); free(taker_buy_quote_volumes);
        }

        fclose(f);
        for (int i = 0; i < n_sym; i++) free(sym_dict[i]);
        for (int i = 0; i < n_itv; i++) free(itv_dict[i]);

        fprintf(stderr, "[ndtsdb debug] %s: loaded %d rows (new bucket format)\n", filepath, total_loaded);
        return total_loaded;
    }

    /* 5. 从偏移 4100 开始读取 chunks（header_block(4096) + CRC(4)） */
    /* fread 已将文件指针推进到 4100，无需额外 seek */

    int total_loaded = 0;

    /* 6. 循环读取所有 chunks */
    int chunk_num = 0;
    while (!feof(f)) {
        chunk_num++;
        /* snapshot 限制 */
        if (db->snapshot_size > 0) {
            long pos = ftell(f);
            if (pos < 0 || (uint64_t)pos >= db->snapshot_size) break;
        }

        uint32_t row_count = 0;
        if (fread(&row_count, 4, 1, f) != 1) {
            fprintf(stderr, "[ndtsdb debug] chunk %d: failed to read row_count\n", chunk_num);
            break;
        }
        if (row_count == 0) {
            fprintf(stderr, "[ndtsdb debug] chunk %d: row_count is 0\n", chunk_num);
            break;
        }
        if (row_count > 10000000) {
            fprintf(stderr, "[ndtsdb debug] chunk %d: row_count %u too large\n", chunk_num, row_count);
            break;  /* 安全上限，防止 OOM */
        }
        fprintf(stderr, "[ndtsdb debug] chunk %d: row_count=%u has_extra_cols=%d\n", chunk_num, row_count, has_extra_cols);

        /* 增量 CRC 状态（与 write 侧 crc32_buf 等价，从同一初始值开始） */
        uint32_t crc_state = 0xFFFFFFFFu;
        crc_state = crc32_update(crc_state, &row_count, 4);

        /* 分配列缓冲区 (8列基础: OHLCV + flags，额外4列根据 has_extra_cols) */
        int32_t*  sym_ids    = (int32_t*)malloc(row_count * 4);
        int32_t*  itv_ids    = (int32_t*)malloc(row_count * 4);
        int64_t*  timestamps = (int64_t*)malloc(row_count * 8);
        double*   opens      = (double*)malloc(row_count * 8);
        double*   highs      = (double*)malloc(row_count * 8);
        double*   lows       = (double*)malloc(row_count * 8);
        double*   closes     = (double*)malloc(row_count * 8);
        double*   volumes    = (double*)malloc(row_count * 8);
        double*   quote_volumes    = has_extra_cols ? (double*)malloc(row_count * 8) : NULL;
        uint32_t* trades           = has_extra_cols ? (uint32_t*)malloc(row_count * 4) : NULL;
        double*   taker_buy_volumes      = has_extra_cols ? (double*)malloc(row_count * 8) : NULL;
        double*   taker_buy_quote_volumes = has_extra_cols ? (double*)malloc(row_count * 8) : NULL;
        uint32_t* flags      = (uint32_t*)malloc(row_count * 4);

        if (!sym_ids || !itv_ids || !timestamps ||
            !opens || !highs || !lows || !closes || !volumes || !flags ||
            (has_extra_cols && (!quote_volumes || !trades || !taker_buy_volumes || !taker_buy_quote_volumes))) {
            free(sym_ids); free(itv_ids); free(timestamps);
            free(opens); free(highs); free(lows);
            free(closes); free(volumes);
            if (has_extra_cols) { free(quote_volumes); free(trades);
            free(taker_buy_volumes); free(taker_buy_quote_volumes); }
            free(flags);
            break;
        }

        /* sym_ids / itv_ids / timestamps — 始终 raw 格式（不支持 delta 压缩的分区文件） */
        /* 新分区文件（由 Bun AppendWriter 写）使用 delta 压缩，尚不支持读取 */
        if (fread(sym_ids,    4, row_count, f) != row_count ||
            fread(itv_ids,    4, row_count, f) != row_count ||
            fread(timestamps, 8, row_count, f) != row_count) {
            free(sym_ids); free(itv_ids); free(timestamps);
            free(opens); free(highs); free(lows);
            free(closes); free(volumes);
            if (has_extra_cols) { free(quote_volumes); free(trades);
            free(taker_buy_volumes); free(taker_buy_quote_volumes); }
            free(flags);
            break;
        }
        crc_state = crc32_update(crc_state, sym_ids,    row_count * 4);
        crc_state = crc32_update(crc_state, itv_ids,    row_count * 4);
        crc_state = crc32_update(crc_state, timestamps, row_count * 8);

        int ok = 1;

        /* OHLCV + 可选额外列：gorilla 解压 或 raw */
        if (is_gorilla) {
            /* 5 列基础 double 数据: OHLCV */
            double* ohlcv_basic[5] = { opens, highs, lows, closes, volumes };
            for (int ci = 0; ci < 5 && ok; ci++) {
                uint32_t clen = 0;
                if (fread(&clen, 4, 1, f) != 1 ||
                    clen == 0 || clen > (uint32_t)GORILLA_BOUND(row_count)) {
                    ok = 0; break;
                }
                uint8_t* cbuf = (uint8_t*)malloc(clen);
                if (!cbuf) { ok = 0; break; }
                if (fread(cbuf, 1, clen, f) != clen) { free(cbuf); ok = 0; break; }
                /* CRC 覆盖压缩字节（与写入侧一致），必须在 free(cbuf) 前计算 */
                crc_state = crc32_update(crc_state, &clen, 4);
                crc_state = crc32_update(crc_state, cbuf, clen);
                size_t decoded = gorilla_decompress_f64(cbuf, clen, ohlcv_basic[ci], row_count);
                free(cbuf);
                if (decoded != row_count) { ok = 0; }
            }
            /* 额外 3 列 double 数据 (has_extra_cols): quoteVolume, takerBuyVolume, takerBuyQuoteVolume */
            if (ok && has_extra_cols) {
                double* extra_cols[3] = { quote_volumes, taker_buy_volumes, taker_buy_quote_volumes };
                for (int ci = 0; ci < 3 && ok; ci++) {
                    uint32_t clen = 0;
                    if (fread(&clen, 4, 1, f) != 1 ||
                        clen == 0 || clen > (uint32_t)GORILLA_BOUND(row_count)) {
                        ok = 0; break;
                    }
                    uint8_t* cbuf = (uint8_t*)malloc(clen);
                    if (!cbuf) { ok = 0; break; }
                    if (fread(cbuf, 1, clen, f) != clen) { free(cbuf); ok = 0; break; }
                    crc_state = crc32_update(crc_state, &clen, 4);
                    crc_state = crc32_update(crc_state, cbuf, clen);
                    size_t decoded = gorilla_decompress_f64(cbuf, clen, extra_cols[ci], row_count);
                    free(cbuf);
                    if (decoded != row_count) { ok = 0; }
                }
            }
            /* trades 列 (uint32_t) - raw format with length prefix */
            if (ok && has_extra_cols) {
                uint32_t trades_clen = 0;
                if (fread(&trades_clen, 4, 1, f) != 1) {
                    fprintf(stderr, "[ndtsdb debug] chunk %d: failed to read trades length\n", chunk_num);
                    ok = 0;
                } else if (trades_clen != row_count * 4) {
                    fprintf(stderr, "[ndtsdb debug] chunk %d: trades length mismatch (expected %u, got %u)\n",
                            chunk_num, row_count * 4, trades_clen);
                    ok = 0;
                } else if (fread(trades, 4, row_count, f) != row_count) {
                    fprintf(stderr, "[ndtsdb debug] chunk %d: failed to read trades data\n", chunk_num);
                    ok = 0;
                } else {
                    crc_state = crc32_update(crc_state, &trades_clen, 4);
                    crc_state = crc32_update(crc_state, trades, trades_clen);
                }
            }
        } else {
            if (fread(opens,   8, row_count, f) != row_count ||
                fread(highs,   8, row_count, f) != row_count ||
                fread(lows,    8, row_count, f) != row_count ||
                fread(closes,  8, row_count, f) != row_count ||
                fread(volumes, 8, row_count, f) != row_count) {
                ok = 0;
            } else {
                crc_state = crc32_update(crc_state, opens,   row_count * 8);
                crc_state = crc32_update(crc_state, highs,   row_count * 8);
                crc_state = crc32_update(crc_state, lows,    row_count * 8);
                crc_state = crc32_update(crc_state, closes,  row_count * 8);
                crc_state = crc32_update(crc_state, volumes, row_count * 8);
            }
            if (ok && has_extra_cols) {
                if (fread(quote_volumes, 8, row_count, f) != row_count) {
                    ok = 0;
                } else {
                    crc_state = crc32_update(crc_state, quote_volumes, row_count * 8);
                }
                /* trades with length prefix */
                if (ok) {
                    uint32_t trades_clen = 0;
                    if (fread(&trades_clen, 4, 1, f) != 1) {
                        ok = 0;
                    } else if (trades_clen != row_count * 4) {
                        ok = 0;
                    } else if (fread(trades, 4, row_count, f) != row_count) {
                        ok = 0;
                    } else {
                        crc_state = crc32_update(crc_state, &trades_clen, 4);
                        crc_state = crc32_update(crc_state, trades, trades_clen);
                    }
                }
                if (ok && (fread(taker_buy_volumes, 8, row_count, f) != row_count ||
                           fread(taker_buy_quote_volumes, 8, row_count, f) != row_count)) {
                    ok = 0;
                } else if (ok) {
                    crc_state = crc32_update(crc_state, taker_buy_volumes, row_count * 8);
                    crc_state = crc32_update(crc_state, taker_buy_quote_volumes, row_count * 8);
                }
            }
        }

        /* flags — 始终 raw */
        if (ok && fread(flags, 4, row_count, f) != row_count) ok = 0;
        if (ok) crc_state = crc32_update(crc_state, flags, row_count * 4);

        /* 验证 chunk CRC32 */
        if (ok) {
            uint32_t computed_crc = crc_state ^ 0xFFFFFFFFu;
            uint32_t disk_crc = 0;
            if (fread(&disk_crc, 4, 1, f) != 1) {
                ok = 0;
            } else if (disk_crc != computed_crc) {
                /* CRC 不匹配：跳过此 chunk（数据损坏），继续尝试下一个 chunk */
                fprintf(stderr, "[ndtsdb] chunk CRC mismatch in %s: "
                        "computed=0x%08X disk=0x%08X rows=%u — skipping\n",
                        filepath, computed_crc, disk_crc, row_count);
                free(sym_ids); free(itv_ids); free(timestamps);
                free(opens); free(highs); free(lows);
                free(closes); free(volumes);
                if (has_extra_cols) { free(quote_volumes); free(trades);
                free(taker_buy_volumes); free(taker_buy_quote_volumes); }
                free(flags);
                continue;
            }
        }

        if (!ok) {
            free(sym_ids); free(itv_ids); free(timestamps);
            free(opens); free(highs); free(lows);
            free(closes); free(volumes);
            if (has_extra_cols) { free(quote_volumes); free(trades);
            free(taker_buy_volumes); free(taker_buy_quote_volumes); }
            free(flags);
            break;
        }

        /* 将行写入 db->symbols */
        for (uint32_t i = 0; i < row_count; i++) {
            const char* sym = (sym_ids[i] >= 0 && sym_ids[i] < n_sym)
                              ? sym_dict[sym_ids[i]] : "UNKNOWN";
            const char* itv = (itv_ids[i] >= 0 && itv_ids[i] < n_itv)
                              ? itv_dict[itv_ids[i]] : "UNKNOWN";

            SymbolData* sd = find_or_create_symbol(db, sym, itv);
            if (!sd) continue;

            if (sd->count >= sd->capacity) {
                uint32_t nc = sd->capacity * 2;
                KlineRow* nk = (KlineRow*)realloc(sd->klines, nc * sizeof(KlineRow));
                if (!nk) continue;
                sd->klines   = nk;
                sd->capacity = nc;
            }
            sd->klines[sd->count].timestamp = timestamps[i];
            sd->klines[sd->count].open      = opens[i];
            sd->klines[sd->count].high      = highs[i];
            sd->klines[sd->count].low       = lows[i];
            sd->klines[sd->count].close     = closes[i];
            sd->klines[sd->count].volume    = volumes[i];
            sd->klines[sd->count].quoteVolume    = has_extra_cols ? quote_volumes[i] : 0.0;
            sd->klines[sd->count].trades         = has_extra_cols ? trades[i] : 0;
            sd->klines[sd->count].takerBuyVolume = has_extra_cols ? taker_buy_volumes[i] : 0.0;
            sd->klines[sd->count].takerBuyQuoteVolume = has_extra_cols ? taker_buy_quote_volumes[i] : 0.0;
            sd->klines[sd->count].flags     = flags[i];
            sd->count++;
            total_loaded++;
        }

        free(sym_ids); free(itv_ids); free(timestamps);
        free(opens); free(highs); free(lows);
        free(closes); free(volumes);
        if (has_extra_cols) { free(quote_volumes); free(trades);
        free(taker_buy_volumes); free(taker_buy_quote_volumes); }
        free(flags);
    }

    fclose(f);

    /* sym_dict / itv_dict 均已 strndup — find_or_create_symbol 已复制到 sd->symbol/interval，
     * 字典可安全释放 */
    for (int i = 0; i < n_sym; i++) free(sym_dict[i]);
    for (int i = 0; i < n_itv; i++) free(itv_dict[i]);

#undef LNDTS_MAX_SYM
#undef LNDTS_MAX_ITV

    fprintf(stderr, "[ndtsdb debug] %s: loaded %d rows\n", filepath, total_loaded);

    return total_loaded;
}

/**
 * ndtsdb_open_any — 自动检测格式打开数据库（快照模式，只读）
 *
 * 支持：
 * - .ndts 和 .ndtb 文件自动识别（Magic 检测）
 * - 文件和目录路径自动切换
 * - 目录递归加载（混合 .ndts + .ndtb）
 *
 * @param path  数据库文件或目录路径
 * @return      数据库句柄，失败返回 NULL
 */
NDTSDB* ndtsdb_open_any(const char* path) {
    return ndtsdb_open_snapshot(path, 0);  /* 0 = 无大小限制 */
}

NDTSDB* ndtsdb_open_snapshot(const char* path, uint64_t snapshot_size) {
    NDTSDB* db = (NDTSDB*)malloc(sizeof(NDTSDB));
    if (!db) return NULL;

    strncpy(db->path, path, sizeof(db->path) - 1);
    db->path[sizeof(db->path) - 1] = '\0';
    db->snapshot_size = snapshot_size;
    db->symbols          = NULL;
    db->symbol_count     = 0;
    db->symbols_capacity = 0;
    db->lock_fd          = NDTS_LOCK_FD_INVALID;

    db->is_dir = path_is_dir(path);

    /* 路径不存在时：若路径无扩展名（不以 .ndts 结尾），自动创建目录并切换为
     * 目录模式（NDTS 分区格式）。以 .ndts 结尾的路径保持文件模式（向后兼容）。 */
    if (!db->is_dir) {
        struct stat st;
        if (stat(path, &st) != 0) {
            /* 路径不存在 — 仅在无 .ndts 扩展名时创建目录 */
            size_t plen = strlen(path);
            int has_ndts_ext = (plen >= 5 &&
                strcmp(path + plen - 5, ".ndts") == 0);
            if (!has_ndts_ext) {
                if (mkdir(path, 0755) == 0)
                    db->is_dir = 1;
            }
        }
        /* 若 stat 成功则为普通文件，保持 is_dir = 0 (文件模式向后兼容) */
    }

    db->dirty  = 0;

#ifndef _WIN32
    /* #93: 目录模式下加 POSIX 排他文件锁，防止多进程并发写同一目录 */
    if (db->is_dir) {
        char lockpath[256 + 6];
        snprintf(lockpath, sizeof(lockpath), "%s/.lock", path);
        int lfd = open(lockpath, O_CREAT | O_RDWR, 0600);
        if (lfd >= 0) {
            if (flock(lfd, LOCK_EX | LOCK_NB) != 0) {
                /* 另一进程持有锁 — 失败返回，不允许并发写 */
                fprintf(stderr, "[ndtsdb] ERROR: database locked by another process: %s\n", path);
                close(lfd);
                free(db);
                return NULL;
            }
            db->lock_fd = lfd;
        }
        /* 若 open 失败（如只读文件系统），静默继续（降级为无锁） */
    }
#endif

    if (db->is_dir) {
        /* 目录模式：递归扫描所有 .ndts 文件 */
        char* dir_stack[64];
        int   dir_top = 0;
        dir_stack[dir_top++] = strdup(path);

        while (dir_top > 0) {
            char* cur_dir = dir_stack[--dir_top];
            DIR*  dir     = opendir(cur_dir);
            if (!dir) { free(cur_dir); continue; }

            struct dirent* ent;
            while ((ent = readdir(dir)) != NULL) {
                if (ent->d_name[0] == '.' && (ent->d_name[1] == '\0' ||
                    (ent->d_name[1] == '.' && ent->d_name[2] == '\0'))) continue;

                char filepath[512];
                snprintf(filepath, sizeof(filepath), "%s/%s", cur_dir, ent->d_name);

                struct stat entry_stat;
                if (stat(filepath, &entry_stat) != 0) continue;

                if (S_ISDIR(entry_stat.st_mode)) {
                    if (dir_top < 64)
                        dir_stack[dir_top++] = strdup(filepath);
                    continue;
                }

                /* 支持 .ndts 和 .ndtb 两种格式 */
                int is_ndts = strstr(ent->d_name, ".ndts") != NULL;
                int is_ndtb = strstr(ent->d_name, ".ndtb") != NULL;
                if (!is_ndts && !is_ndtb) continue;

                load_ndts_file(db, filepath);
            }

            closedir(dir);
            free(cur_dir);
        }

    } else {
        /* 单文件模式：直接加载该 .ndts 文件 */
        load_ndts_file(db, path);
    }

    return db;
}

/* FlatRow: 用于 ndtsdb_close 目录模式排序 */
typedef struct {
    KlineRow row;
    char symbol[32];
    char interval[16];
    char day[12];
} FlatRow;

static int compare_by_timestamp(const void* a, const void* b) {
    const FlatRow* ra = (const FlatRow*)a;
    const FlatRow* rb = (const FlatRow*)b;
    if (ra->row.timestamp < rb->row.timestamp) return -1;
    if (ra->row.timestamp > rb->row.timestamp) return 1;
    return 0;
}

void ndtsdb_close(NDTSDB* db) {
    if (!db) return;

    if (!db->dirty) goto cleanup;  // 只读操作，不写出文件

    if (db->is_dir) {
        /* ===== 目录模式：写出 PartitionedTable 格式 ===== */
        
        /* 先统计总行数 */
        uint32_t total = 0;
        for (uint32_t i = 0; i < db->symbol_count; i++) total += db->symbols[i].count;

        if (total == 0) goto cleanup;

        /* 扁平化所有行 */
        FlatRow* flat = (FlatRow*)malloc(total * sizeof(FlatRow));
        if (!flat) goto cleanup;

        uint32_t fi = 0;
        for (uint32_t i = 0; i < db->symbol_count; i++) {
            for (uint32_t j = 0; j < db->symbols[i].count; j++) {
                flat[fi].row = db->symbols[i].klines[j];
                strncpy(flat[fi].symbol, db->symbols[i].symbol, 31);
                flat[fi].symbol[31] = '\0';
                strncpy(flat[fi].interval, db->symbols[i].interval, 15);
                flat[fi].interval[15] = '\0';
                ts_to_day(flat[fi].row.timestamp, flat[fi].day);
                fi++;
            }
        }

        /* 按timestamp排序，使相同day的数据连续 */
        qsort(flat, total, sizeof(FlatRow), compare_by_timestamp);

        /* 确保目录存在 */
        mkdir(db->path, 0755);

        /* 线性扫描：按day分组，一次性写出 */
        uint32_t i = 0;
        while (i < total) {
            /* 找到当前day的范围 [i, j) */
            const char* current_day = flat[i].day;
            uint32_t j = i + 1;
            while (j < total && strcmp(flat[j].day, current_day) == 0) {
                j++;
            }
            uint32_t day_n = j - i;

            /* 分配该天的缓冲区 */
            KlineRow* day_rows = (KlineRow*)malloc(day_n * sizeof(KlineRow));
            int32_t* sym_ids = (int32_t*)malloc(day_n * sizeof(int32_t));
            int32_t* itv_ids = (int32_t*)malloc(day_n * sizeof(int32_t));

            if (!day_rows || !sym_ids || !itv_ids) {
                free(day_rows); free(sym_ids); free(itv_ids);
                i = j;
                continue;
            }

            /* 建字典并填充数据
             * JSON header 固定 4096 bytes，每条 symbol ~12 bytes → 最多约 320 条。
             * MAX_SYM=4096 不再是瓶颈；JSON overflow 由 write_partition_file 检测并中止。
             * #92: 超出时报错并跳过整行（不写 sym_id=-1 到磁盘）。 */
            #define MAX_SYM 4096
            #define MAX_ITV 256
            char* sym_dict[MAX_SYM]; int n_sym = 0;
            char* itv_dict[MAX_ITV]; int n_itv = 0;

            for (uint32_t k = 0; k < day_n; k++) {
                day_rows[k] = flat[i + k].row;

                /* symbol 字典查询/插入 */
                int si = -1;
                for (int s = 0; s < n_sym; s++) {
                    if (strcmp(sym_dict[s], flat[i + k].symbol) == 0) { si = s; break; }
                }
                if (si < 0) {
                    if (n_sym < MAX_SYM) {
                        sym_dict[n_sym] = strdup(flat[i + k].symbol);
                        si = n_sym++;
                    } else {
                        // #92: dict 满时报错，行将被过滤（不写 sym_id=-1 到磁盘）
                        fprintf(stderr, "[ndtsdb] ERROR: symbol dict full (%d), row lost: %s\n",
                                MAX_SYM, flat[i + k].symbol);
                    }
                }
                sym_ids[k] = si;  // -1 表示该行需跳过

                /* interval 字典查询/插入 */
                int ii = -1;
                for (int v = 0; v < n_itv; v++) {
                    if (strcmp(itv_dict[v], flat[i + k].interval) == 0) { ii = v; break; }
                }
                if (ii < 0) {
                    if (n_itv < MAX_ITV) {
                        itv_dict[n_itv] = strdup(flat[i + k].interval);
                        ii = n_itv++;
                    } else {
                        fprintf(stderr, "[ndtsdb] WARNING: interval dict full (%d), skipping: %s\n",
                                MAX_ITV, flat[i + k].interval);
                    }
                }
                itv_ids[k] = ii;
            }
            #undef MAX_SYM
            #undef MAX_ITV

            /* #92: 过滤掉 sym_id==-1 或 itv_id==-1 的行（dict 溢出时出现） */
            uint32_t valid_n = 0;
            for (uint32_t k = 0; k < day_n; k++) {
                if (sym_ids[k] >= 0 && itv_ids[k] >= 0) {
                    day_rows[valid_n] = day_rows[k];
                    sym_ids[valid_n]  = sym_ids[k];
                    itv_ids[valid_n]  = itv_ids[k];
                    valid_n++;
                }
            }

            /* 写文件 */
            char filepath[512];
            snprintf(filepath, sizeof(filepath), "%s/%s.ndts", db->path, current_day);
            write_partition_file(filepath, day_rows, valid_n,
                                  sym_dict, n_sym, itv_dict, n_itv,
                                  sym_ids, itv_ids);

            /* 清理 */
            for (int s = 0; s < n_sym; s++) free(sym_dict[s]);
            for (int v = 0; v < n_itv; v++) free(itv_dict[v]);
            free(day_rows); free(sym_ids); free(itv_ids);

            i = j;  // 跳到下一个day
        }

        free(flat);
    } else {
        /* ===== 文件模式：保持旧格式（向后兼容）===== */
        /* #90: 同样使用原子写：先写 .tmp，fsync，再 rename */
        char tmppath_fm[256 + 4];
        snprintf(tmppath_fm, sizeof(tmppath_fm), "%s.tmp", db->path);
        FILE* f = fopen(tmppath_fm, "wb");
        if (f) {
            fwrite("NDTS", 1, 4, f);
            uint32_t version = 1;
            fwrite(&version, 4, 1, f);
            fwrite(&db->symbol_count, 4, 1, f);
            for (uint32_t i = 0; i < db->symbol_count; i++) {
                SymbolData* sd = &db->symbols[i];
                fwrite(sd->symbol, 32, 1, f);
                fwrite(sd->interval, 16, 1, f);
                fwrite(&sd->count, 4, 1, f);
                fwrite(sd->klines, sizeof(KlineRow), sd->count, f);
            }
            NDTS_FSYNC(fileno(f));
            fclose(f);
            if (rename(tmppath_fm, db->path) != 0) {
                remove(tmppath_fm);
                fprintf(stderr, "[ndtsdb] ERROR: rename failed for %s\n", db->path);
            }
        }
    }

cleanup:
    /* 释放此 handle 的所有动态分配内存 */
    for (uint32_t i = 0; i < db->symbol_count; i++) {
        if (db->symbols[i].klines) {
            free(db->symbols[i].klines);
            db->symbols[i].klines = NULL;
        }
    }
    if (db->symbols) {
        free(db->symbols);
        db->symbols = NULL;
    }
    db->symbol_count = 0;
    db->symbols_capacity = 0;

#ifndef _WIN32
    /* #93: 释放目录级文件锁 */
    if (db->lock_fd != NDTS_LOCK_FD_INVALID) {
        flock(db->lock_fd, LOCK_UN);
        close(db->lock_fd);
        db->lock_fd = NDTS_LOCK_FD_INVALID;
    }
#endif

    free(db);
}

int ndtsdb_insert(NDTSDB* db, const char* symbol, const char* interval, const KlineRow* row) {
    if (!db) return -1;
    db->dirty = 1;
    SymbolData* sd = find_or_create_symbol(db, symbol, interval);
    if (!sd) return -1;
    
    // 查找是否已存在相同timestamp的记录
    int existing_idx = -1;
    for (uint32_t i = 0; i < sd->count; i++) {
        if (sd->klines[i].timestamp == row->timestamp) {
            existing_idx = (int)i;
            break;
        }
    }
    
    // 如果是tombstone（volume < 0），删除已有记录
    if (row->volume < 0) {
        if (existing_idx >= 0) {
            // 删除该记录：将后面的记录前移
            for (uint32_t i = (uint32_t)existing_idx; i < sd->count - 1; i++) {
                sd->klines[i] = sd->klines[i + 1];
            }
            sd->count--;
        }
        // 不存储tombstone本身
        return 0;
    }
    
    // 如果记录已存在，更新它（UPSERT）
    if (existing_idx >= 0) {
        sd->klines[existing_idx] = *row;
        return 0;
    }
    
    // 动态扩容：count >= capacity 时 realloc
    if (sd->count >= sd->capacity) {
        // #91: 防止 uint32_t 翻倍溢出
        if (sd->capacity > UINT32_MAX / 2) return -1;
        uint32_t new_capacity = sd->capacity * 2;
        KlineRow* new_klines = (KlineRow*)realloc(sd->klines, new_capacity * sizeof(KlineRow));
        if (!new_klines) return -1;  // 扩容失败，sd->klines 仍有效
        sd->klines = new_klines;
        sd->capacity = new_capacity;
    }
    
    // #Bug2: 防止 count 到 UINT32_MAX 时 count++ 溢出
    if (sd->count >= UINT32_MAX) return -1;
    sd->klines[sd->count++] = *row;
    return 0;
}

/**
 * 清空指定 symbol/interval 的所有数据
 * @return 0 成功，-1 失败
 */
int ndtsdb_clear(NDTSDB* db, const char* symbol, const char* interval) {
    if (!db || !symbol || !interval) return -1;

    for (uint32_t i = 0; i < db->symbol_count; i++) {
        if (strcmp(db->symbols[i].symbol, symbol) == 0 &&
            strcmp(db->symbols[i].interval, interval) == 0) {
            db->symbols[i].count = 0;
            if (db->symbols[i].klines) {
                free(db->symbols[i].klines);
                db->symbols[i].klines = (KlineRow*)malloc(INITIAL_KLINES_CAPACITY * sizeof(KlineRow));
                if (!db->symbols[i].klines) return -1;
                db->symbols[i].capacity = INITIAL_KLINES_CAPACITY;
            }
            db->dirty = 1;
            return 0;
        }
    }
    
    // 未找到，视为成功（已经是空）
    return 0;
}

int ndtsdb_insert_batch(NDTSDB* db, const char* symbol, const char* interval, const KlineRow* rows, uint32_t n) {
    if (!db) return -1;
    db->dirty = 1;
    SymbolData* sd = find_or_create_symbol(db, symbol, interval);
    if (!sd) return -1;
    
    // 检查是否需要扩容（批量扩容，避免多次realloc）
    // #Bug2: 防止 uint32_t 加法溢出绕过容量检查
    if (n > 0 && sd->count > UINT32_MAX - n) return -1;
    uint32_t required = sd->count + n;
    if (required > sd->capacity) {
        // 计算新的capacity（至少翻倍，或满足需求）
        uint32_t new_capacity = sd->capacity;
        while (new_capacity < required) {
            // #91: 防止 uint32_t 翻倍溢出
            if (new_capacity > UINT32_MAX / 2) return -1;
            new_capacity *= 2;
        }
        KlineRow* new_klines = (KlineRow*)realloc(sd->klines, new_capacity * sizeof(KlineRow));
        if (!new_klines) return -1;  // 扩容失败，sd->klines 仍有效
        sd->klines = new_klines;
        sd->capacity = new_capacity;
    }
    
    /* Item 3: UPSERT semantics — mirror ndtsdb_insert per-row dedup */
    uint32_t inserted = 0;
    for (uint32_t i = 0; i < n; i++) {
        /* Find existing row with same timestamp */
        int found = -1;
        for (uint32_t j = 0; j < sd->count; j++) {
            if (sd->klines[j].timestamp == rows[i].timestamp) {
                found = (int)j;
                break;
            }
        }
        if (found >= 0) {
            sd->klines[found] = rows[i];  /* update in-place */
        } else {
            sd->klines[sd->count++] = rows[i];  /* append */
        }
        inserted++;
    }
    return (int)inserted;
}

QueryResult* ndtsdb_query(NDTSDB* db, const Query* q) {
    if (!db || !q) return NULL;

    /* Item 7: NULL symbol/interval → collect all symbols with time filter */
    if (!q->symbol || !q->interval) {
        CollectFilter f = {
            NULL, 0,
            (q->startTime > 0) ? (int64_t)q->startTime : -1,
            (q->endTime   > 0) ? (int64_t)q->endTime   : -1
        };
        return collect_rows(db, &f);
    }

    /* Item 1: read-only lookup — does NOT create a slot on miss */
    SymbolData* sd = find_symbol(db, q->symbol, q->interval);
    if (!sd || sd->count == 0) {
        QueryResult* r = (QueryResult*)malloc(sizeof(QueryResult));
        if (!r) return NULL;
        r->rows = NULL; r->count = 0; r->capacity = 0;
        return r;
    }

    /* Single-symbol time-range filter */
    uint32_t capacity = (q->limit > 0) ? q->limit : sd->count;
    KlineRow* rows = (KlineRow*)malloc(capacity * sizeof(KlineRow));
    if (!rows) {
        QueryResult* r = (QueryResult*)malloc(sizeof(QueryResult));
        if (!r) return NULL;
        r->rows = NULL; r->count = 0; r->capacity = 0;
        return r;
    }
    uint32_t count = 0;
    for (uint32_t i = 0; i < sd->count && count < capacity; i++) {
        int64_t ts = sd->klines[i].timestamp;
        if (ts >= q->startTime && ts <= q->endTime)
            rows[count++] = sd->klines[i];
    }

    QueryResult* r = (QueryResult*)malloc(sizeof(QueryResult));
    if (!r) { free(rows); return NULL; }
    r->rows = rows; r->count = count; r->capacity = capacity;
    return r;
}

void ndtsdb_free_result(QueryResult* r) {
    if (r) {
        if (r->rows) free(r->rows);
        free(r);
    }
}

/* ============ query_all: 返回所有 symbol 的所有数据（Item 4） ============ */
QueryResult* ndtsdb_query_all(NDTSDB* db) {
    if (!db) return NULL;
    CollectFilter f = { NULL, 0, -1, -1 };
    return collect_rows(db, &f);
}

/* ============ query_filtered: 按 symbol 白名单查询（Item 4） ============ */
QueryResult* ndtsdb_query_filtered(NDTSDB* db, const char** symbols, int n_symbols) {
    if (!db) return NULL;
    if (!symbols || n_symbols <= 0) {
        /* 空白名单 → 返回空结果（保留原有行为，与 query_all 有意区分） */
        QueryResult* r = (QueryResult*)malloc(sizeof(QueryResult));
        if (!r) return NULL;
        r->rows = NULL; r->count = 0; r->capacity = 0;
        return r;
    }
    CollectFilter f = { symbols, n_symbols, -1, -1 };
    return collect_rows(db, &f);
}

/* ============ query_time_range: 按时间范围查询（Item 4） ============ */
QueryResult* ndtsdb_query_time_range(NDTSDB* db, int64_t since_ms, int64_t until_ms) {
    if (!db) return NULL;
    CollectFilter f = { NULL, 0, since_ms, until_ms };
    return collect_rows(db, &f);
}

/* ============ query_filtered_time: symbol+时间联合过滤（Item 4） ============ */
QueryResult* ndtsdb_query_filtered_time(NDTSDB* db, const char** symbols, int n_symbols,
                                        int64_t since_ms, int64_t until_ms) {
    if (!db) return NULL;
    if (!symbols || n_symbols <= 0) {
        /* 无 symbol 过滤 → 退化为纯时间范围查询（保留原有行为） */
        return ndtsdb_query_time_range(db, since_ms, until_ms);
    }
    CollectFilter f = { symbols, n_symbols, since_ms, until_ms };
    return collect_rows(db, &f);
}

int64_t ndtsdb_get_latest_timestamp(NDTSDB* db, const char* symbol, const char* interval) {
    if (!db) return -1;
    /* Item 1: read-only lookup; Item 5: linear scan for true max timestamp */
    SymbolData* sd = find_symbol(db, symbol, interval);
    if (!sd || sd->count == 0) return -1;
    int64_t max_ts = sd->klines[0].timestamp;
    for (uint32_t i = 1; i < sd->count; i++) {
        if (sd->klines[i].timestamp > max_ts) max_ts = sd->klines[i].timestamp;
    }
    return max_ts;
}

int ndtsdb_list_symbols(NDTSDB* db, char symbols[][32], char intervals[][16], int max_count) {
    if (!db) return 0;
    int count = 0;
    for (uint32_t i = 0; i < db->symbol_count && count < max_count; i++) {
        strncpy(symbols[count], db->symbols[i].symbol, 31);
        symbols[count][31] = '\0';
        strncpy(intervals[count], db->symbols[i].interval, 15);
        intervals[count][15] = '\0';
        count++;
    }
    return count;
}

const char* ndtsdb_get_path(NDTSDB* db) {
    if (!db) return NULL;
    return db->path;
}

/* ─── JSON 序列化 ─────────────────────────────────────────── */

/* #96: JSON string escape helper — replaces \ " \n \r \t with safe sequences */
static void json_escape_str(const char* src, char* dst, size_t dst_sz) {
    size_t di = 0;
    for (size_t si = 0; src[si] && di + 2 < dst_sz; si++) {
        unsigned char c = (unsigned char)src[si];
        if (c == '"' || c == '\\') {
            if (di + 3 >= dst_sz) break;
            dst[di++] = '\\'; dst[di++] = (char)c;
        } else if (c == '\n') {
            if (di + 3 >= dst_sz) break;
            dst[di++] = '\\'; dst[di++] = 'n';
        } else if (c == '\r') {
            if (di + 3 >= dst_sz) break;
            dst[di++] = '\\'; dst[di++] = 'r';
        } else if (c == '\t') {
            if (di + 3 >= dst_sz) break;
            dst[di++] = '\\'; dst[di++] = 't';
        } else if (c < 0x20) {
            /* skip other control chars */
        } else {
            dst[di++] = (char)c;
        }
    }
    dst[di] = '\0';
}

/**
 * ndtsdb_query_all_json — 将所有数据序列化为 JSON 字符串
 *
 * 返回格式：
 * {
 *   "rows": [
 *     {
 *       "symbol": "BTC/USDT",
 *       "interval": "1h",
 *       "timestamp": 1234567890000,
 *       "open": 45000.5,
 *       "high": 46000.0,
 *       "low": 44999.0,
 *       "close": 45500.25,
 *       "volume": 123.45,
 *       "flags": 0
 *     },
 *     ...
 *   ],
 *   "count": 12345
 * }
 *
 * 调用方须通过 ndtsdb_free_json() 释放返回的指针
 *
 * @param db  数据库句柄
 * @return    JSON 字符串指针，失败返回 NULL
 */
char* ndtsdb_query_all_json(NDTSDB* db) {
    if (!db) return NULL;

    // 第一遍：计算所需大小
    size_t json_size = 256;  // 头部开销: {"rows":[...],count:N}
    uint32_t total_count = 0;

    for (uint32_t i = 0; i < db->symbol_count; i++) {
        SymbolData* sd = &db->symbols[i];
        total_count += sd->count;

        // 每行约 200 字节 (symbol + interval + numbers)
        json_size += sd->count * 200;
        // symbol/interval 字符串开销
        json_size += sd->count * (strlen(sd->symbol) + strlen(sd->interval) + 10);
    }

    // 分配缓冲区
    char* json = (char*)malloc(json_size);
    if (!json) return NULL;

    // 第二遍：生成 JSON
    char* p = json;
    size_t remaining = json_size;

    // 写入头部
    int written = snprintf(p, remaining, "{\"rows\":[");
    if (written < 0) {
        free(json);
        return NULL;
    }
    p += written;
    remaining -= written;

    // 写入行数据
    int first_row = 1;
    for (uint32_t i = 0; i < db->symbol_count; i++) {
        SymbolData* sd = &db->symbols[i];
        for (uint32_t j = 0; j < sd->count; j++) {
            KlineRow* kr = &sd->klines[j];

            if (!first_row && remaining > 0) {
                *p++ = ',';
                remaining--;
            }
            first_row = 0;

            /* #96: escape symbol/interval before embedding in JSON */
            char esc_sym[128], esc_itv[32];
            json_escape_str(sd->symbol,   esc_sym, sizeof(esc_sym));
            json_escape_str(sd->interval, esc_itv, sizeof(esc_itv));

            /* 尝试写入当前行；若空间不足则 realloc 并重试 */
            for (;;) {
                /* Item 6: use PRId64 instead of %ld — correct on all platforms */
                written = snprintf(p, remaining,
                    "{\"symbol\":\"%s\",\"interval\":\"%s\",\"timestamp\":%" PRId64 ","
                    "\"open\":%.17g,\"high\":%.17g,\"low\":%.17g,\"close\":%.17g,"
                    "\"volume\":%.17g,\"flags\":%u}",
                    esc_sym, esc_itv, kr->timestamp,
                    kr->open, kr->high, kr->low, kr->close,
                    kr->volume, kr->flags
                );

                if (written >= 0 && (size_t)written < remaining) break;

                /* 缓冲区不足：double 并 realloc */
                size_t used = (size_t)(p - json);
                json_size *= 2;
                char* new_json = (char*)realloc(json, json_size);
                if (!new_json) { free(json); return NULL; }
                json = new_json;
                p = json + used;
                remaining = json_size - used;
            }
            p += written;
            remaining -= written;
        }
    }

    // 写入尾部
    written = snprintf(p, remaining, "],\"count\":%u}", total_count);
    if (written < 0) {
        free(json);
        return NULL;
    }

    return json;
}

/**
 * ndtsdb_free_json — 释放 JSON 字符串
 *
 * @param json  ndtsdb_query_all_json 返回的指针，NULL 安全
 */
void ndtsdb_free_json(char* json) {
    if (json) free(json);
}

/**
 * ndtsdb_list_symbols_json — 将所有 symbol/interval 组合序列化为 JSON 数组
 *
 * 返回格式：[{"symbol":"BTCUSDT","interval":"1h"},...]
 * 调用方须通过 ndtsdb_free_json() 释放返回的指针。
 */
char* ndtsdb_list_symbols_json(NDTSDB* db) {
    if (!db || db->symbol_count == 0) {
        char* empty = malloc(3);
        if (empty) { empty[0] = '['; empty[1] = ']'; empty[2] = '\0'; }
        return empty;
    }
    /* Each entry: {"symbol":"<31 chars>","interval":"<15 chars>"} ~ 70 bytes + separators */
    size_t cap = (size_t)db->symbol_count * 80 + 4;
    char* buf = malloc(cap);
    if (!buf) return NULL;
    size_t pos = 0;
    buf[pos++] = '[';
    for (uint32_t i = 0; i < db->symbol_count; i++) {
        if (i > 0) buf[pos++] = ',';
        /* #96: escape before embedding in JSON */
        char esc_sym[128], esc_itv[32];
        json_escape_str(db->symbols[i].symbol,   esc_sym, sizeof(esc_sym));
        json_escape_str(db->symbols[i].interval, esc_itv, sizeof(esc_itv));
        pos += (size_t)snprintf(buf + pos, cap - pos,
            "{\"symbol\":\"%s\",\"interval\":\"%s\"}",
            esc_sym, esc_itv);
    }
    buf[pos++] = ']';
    buf[pos]   = '\0';
    return buf;
}

/* ─── 二进制序列化（Phase 2 优化）─────────────────────────────── */

/**
 * ndtsdb_query_all_binary — 将所有数据序列化为二进制格式
 *
 * 避免 JSON 序列化开销，返回紧凑二进制格式。
 * 结果包含所有 symbol/interval 的所有 K 线数据。
 * 结果必须通过 ndtsdb_free_binary 释放。
 *
 * @param db  数据库句柄
 * @return    NDTSBinaryResult*（堆分配），失败返回 NULL
 */
NDTSBinaryResult* ndtsdb_query_all_binary(NDTSDB* db) {
    if (!db) return NULL;

    // 第一遍：计算总行数
    uint32_t total_count = 0;
    for (uint32_t i = 0; i < db->symbol_count; i++) {
        total_count += db->symbols[i].count;
    }

    // 处理空数据库
    if (total_count == 0) {
        NDTSBinaryResult* empty = (NDTSBinaryResult*)malloc(sizeof(NDTSBinaryResult));
        if (!empty) return NULL;
        empty->data = NULL;
        empty->count = 0;
        empty->stride = 128;
        memcpy(empty->magic, "NDB\0", 4);
        return empty;
    }

    // 分配连续缓冲区（每行 128 字节）
    size_t buffer_size = total_count * 128;
    uint8_t* buffer = (uint8_t*)malloc(buffer_size);
    if (!buffer) return NULL;

    // 第二遍：填充二进制数据（高效内存复制）
    uint32_t row_idx = 0;
    for (uint32_t i = 0; i < db->symbol_count; i++) {
        SymbolData* sd = &db->symbols[i];
        for (uint32_t j = 0; j < sd->count; j++) {
            KlineRow* kr = &sd->klines[j];
            uint8_t* row = buffer + row_idx * 128;

            // 使用 memcpy 填充数值字段（高效）— 11 列完整格式
            memcpy(row +  0, &kr->timestamp, 8);  // timestamp @ 0
            memcpy(row +  8, &kr->open, 8);       // open @ 8
            memcpy(row + 16, &kr->high, 8);       // high @ 16
            memcpy(row + 24, &kr->low, 8);        // low @ 24
            memcpy(row + 32, &kr->close, 8);      // close @ 32
            memcpy(row + 40, &kr->volume, 8);     // volume @ 40
            memcpy(row + 48, &kr->quoteVolume, 8); // quoteVolume @ 48
            memcpy(row + 56, &kr->trades, 4);     // trades @ 56
            // @ 60: 4 bytes padding
            memcpy(row + 64, &kr->takerBuyVolume, 8);      // takerBuyVolume @ 64
            memcpy(row + 72, &kr->takerBuyQuoteVolume, 8); // takerBuyQuoteVolume @ 72
            memcpy(row + 80, &kr->flags, 4);      // flags @ 80
            // @ 84: 4 bytes padding

            // 填充字符串字段
            strncpy((char*)(row + 88), sd->symbol, 31);
            row[119] = '\0';  // 确保 null-terminated
            strncpy((char*)(row + 120), sd->interval, 15);
            row[135] = '\0';  // 确保 null-terminated
            // @ 136-159: 24 bytes reserved (已由 malloc 初始化为 0)

            row_idx++;
        }
    }

    // 返回结果
    NDTSBinaryResult* result = (NDTSBinaryResult*)malloc(sizeof(NDTSBinaryResult));
    if (!result) {
        free(buffer);
        return NULL;
    }
    result->data = buffer;
    result->count = total_count;
    result->stride = 128;
    memcpy(result->magic, "NDB\0", 4);
    return result;
}

/**
 * ndtsdb_free_binary — 释放二进制查询结果
 *
 * @param result  ndtsdb_query_all_binary 返回的指针，NULL 安全
 */
void ndtsdb_free_binary(NDTSBinaryResult* result) {
    if (!result) return;
    if (result->data) free(result->data);
    free(result);
}

/**
 * ndtsdb_binary_get_data — 获取二进制结果的数据指针
 */
uint8_t* ndtsdb_binary_get_data(NDTSBinaryResult* result) {
    return result ? result->data : NULL;
}

/**
 * ndtsdb_binary_get_count — 获取二进制结果的行数
 */
uint32_t ndtsdb_binary_get_count(NDTSBinaryResult* result) {
    return result ? result->count : 0;
}

/**
 * ndtsdb_binary_get_stride — 获取二进制结果的行大小
 */
uint32_t ndtsdb_binary_get_stride(NDTSBinaryResult* result) {
    return result ? result->stride : 0;
}

/* ============================================================
 * Phase 2 Implementation: Sparse Index & Streaming Iterator
 * ============================================================ */

/**
 * ndtb_sparse_index_create — 为 NDTB 文件构建稀疏索引
 *
 * 扫描 NDTB 文件，为时间戳列构建块级别的 min/max 索引。
 * 用于后续范围查询加速（BOUND 优化）。
 *
 * @param file_path      NDTB 文件路径
 * @param block_rows     每个块的目标行数（默认 1000）
 * @return              SparseIndex 指针（成功）或 NULL（失败）
 */
SparseIndex* ndtb_sparse_index_create(const char* file_path, uint32_t block_rows) {
    if (!file_path || block_rows == 0) return NULL;

    FILE* f = fopen(file_path, "rb");
    if (!f) return NULL;

    /* 读取 header block 以跳过 header 数据 */
    uint8_t header_block[4096];
    if (fread(header_block, 1, 4096, f) != 4096) {
        fclose(f);
        return NULL;
    }

    /* 验证 magic */
    if (memcmp(header_block, "NDTB", 4) != 0) {
        fclose(f);
        return NULL;
    }

    /* 跳过 header CRC */
    uint32_t hcrc;
    if (fread(&hcrc, 4, 1, f) != 1) {
        fclose(f);
        return NULL;
    }

    /* 跳过前两列（symbol 和 interval） */
    uint8_t chunk_type;
    uint32_t row_count, clen;

    for (int col = 0; col < 2; col++) {
        if (fread(&chunk_type, 1, 1, f) != 1) goto idx_cleanup;
        if (fread(&row_count, 4, 1, f) != 1) goto idx_cleanup;
        if (fread(&clen, 4, 1, f) != 1) goto idx_cleanup;
        if (fseek(f, clen + 4, SEEK_CUR) != 0) goto idx_cleanup;  /* skip data + CRC */
    }

    /* 现在准备读取 timestamp 列 */
    if (fread(&chunk_type, 1, 1, f) != 1) goto idx_cleanup;
    if (chunk_type != 0x00) goto idx_cleanup;  /* timestamp 必须是 raw */
    if (fread(&row_count, 4, 1, f) != 1) goto idx_cleanup;
    if (fread(&clen, 4, 1, f) != 1) goto idx_cleanup;

    if (row_count == 0 || clen != row_count * 8) goto idx_cleanup;

    int64_t* timestamps = (int64_t*)malloc(row_count * 8);
    if (!timestamps) goto idx_cleanup;

    if (fread(timestamps, 8, row_count, f) != row_count) {
        free(timestamps);
        goto idx_cleanup;
    }

    /* 构建索引：将 timestamps 分组为块，计算每块的 min/max */
    SparseIndex* idx = (SparseIndex*)malloc(sizeof(SparseIndex));
    if (!idx) {
        free(timestamps);
        goto idx_cleanup;
    }

    uint32_t num_blocks = (row_count + block_rows - 1) / block_rows;
    idx->entries = (SparseIndexEntry*)malloc(num_blocks * sizeof(SparseIndexEntry));
    if (!idx->entries) {
        free(idx);
        free(timestamps);
        goto idx_cleanup;
    }

    idx->entry_count = 0;
    uint64_t ts_offset = ftell(f) - (row_count * 8) - 4 - 4 - 1;  /* timestamp 块的起始位置 */

    for (uint32_t b = 0; b < num_blocks; b++) {
        uint32_t start_row = b * block_rows;
        uint32_t end_row = (start_row + block_rows > row_count) ? row_count : start_row + block_rows;
        uint32_t block_size = end_row - start_row;

        int64_t min_ts = timestamps[start_row];
        int64_t max_ts = timestamps[start_row];

        for (uint32_t i = start_row; i < end_row; i++) {
            if (timestamps[i] < min_ts) min_ts = timestamps[i];
            if (timestamps[i] > max_ts) max_ts = timestamps[i];
        }

        idx->entries[idx->entry_count].block_offset = ts_offset + start_row * 8;
        idx->entries[idx->entry_count].min_ts = min_ts;
        idx->entries[idx->entry_count].max_ts = max_ts;
        idx->entries[idx->entry_count].row_count = block_size;
        idx->entry_count++;
    }

    free(timestamps);
    idx->is_sorted = 1;  /* 已按偏移排序 */
    fclose(f);
    return idx;

idx_cleanup:
    fclose(f);
    return NULL;
}

/**
 * ndtb_sparse_index_query_range — 使用索引过滤块
 *
 * 给定时间范围 [min_ts, max_ts]，返回符合条件的块索引数组。
 * 调用者负责释放返回的数组。
 *
 * @param idx         稀疏索引
 * @param min_ts      时间范围下界
 * @param max_ts      时间范围上界
 * @param out_count   输出：符合条件的块数
 * @return           块索引数组（0-based），失败返回 NULL
 */
uint32_t* ndtb_sparse_index_query_range(const SparseIndex* idx,
                                       int64_t min_ts, int64_t max_ts,
                                       uint32_t* out_count) {
    if (!idx || !out_count) return NULL;

    uint32_t matched = 0;
    uint32_t* result = (uint32_t*)malloc(idx->entry_count * sizeof(uint32_t));
    if (!result) return NULL;

    for (uint32_t i = 0; i < idx->entry_count; i++) {
        SparseIndexEntry* e = &idx->entries[i];
        /* 块的 [min_ts, max_ts] 与查询范围 [min_ts, max_ts] 有交集 */
        if (e->max_ts >= min_ts && e->min_ts <= max_ts) {
            result[matched++] = i;
        }
    }

    *out_count = matched;
    return result;
}

/**
 * ndtb_sparse_index_free — 释放稀疏索引
 */
void ndtb_sparse_index_free(SparseIndex* idx) {
    if (!idx) return;
    free(idx->entries);
    free(idx);
}

/**
 * ndtb_streaming_iterator_create — 创建流式迭代器
 *
 * 打开 NDTB 文件并准备流式读取。调用者通过
 * ndtb_streaming_iterator_next() 逐块读取数据。
 *
 * @param file_path   NDTB 文件路径
 * @param block_rows  单次读取的行数（默认 1000）
 * @return            迭代器指针（成功）或 NULL（失败）
 */
StreamingIterator* ndtb_streaming_iterator_create(const char* file_path,
                                                  uint32_t block_rows) {
    if (!file_path || block_rows == 0) return NULL;

    FILE* f = fopen(file_path, "rb");
    if (!f) return NULL;

    StreamingIterator* iter = (StreamingIterator*)malloc(sizeof(StreamingIterator));
    if (!iter) {
        fclose(f);
        return NULL;
    }

    strncpy(iter->file_path, file_path, sizeof(iter->file_path) - 1);
    iter->file_path[sizeof(iter->file_path) - 1] = '\0';
    iter->f = f;
    iter->block_rows = block_rows;
    iter->current_block = NULL;
    iter->block_size = 0;
    iter->block_idx = 0;
    iter->total_rows = 0;
    iter->eof = 0;
    iter->read_buffer = NULL;
    iter->read_buffer_cap = 0;
    iter->sym_dict = NULL;
    iter->itv_dict = NULL;
    iter->n_sym = 0;
    iter->n_itv = 0;

    /* 分配读缓冲区（初始大小 1MB，自动扩展） */
    iter->read_buffer_cap = 1024 * 1024;
    iter->read_buffer = (uint8_t*)malloc(iter->read_buffer_cap);
    if (!iter->read_buffer) {
        free(iter);
        fclose(f);
        return NULL;
    }

    /* 分配行缓冲区 */
    iter->current_block = (KlineRow*)malloc(block_rows * sizeof(KlineRow));
    if (!iter->current_block) {
        free(iter->read_buffer);
        free(iter);
        fclose(f);
        return NULL;
    }

    return iter;
}

/**
 * ndtb_streaming_iterator_init — 初始化迭代器（内部函数）
 * 读取 header、解析字典、定位数据块起始位置
 * @return 成功返回 0，失败返回 -1
 */
static int ndtb_streaming_iterator_init(StreamingIterator* iter) {
    if (!iter->f) return -1;

    /* 1. 读取 header block */
    uint8_t header_block[4096];
    if (fread(header_block, 1, 4096, iter->f) != 4096) return -1;

    if (memcmp(header_block, "NDTB", 4) != 0) return -1;

    /* 2. 验证 header CRC */
    uint32_t expected_hcrc = crc32_buf(header_block, 4096);
    uint32_t actual_hcrc = 0;
    if (fread(&actual_hcrc, 4, 1, iter->f) != 1) return -1;
    if (actual_hcrc != expected_hcrc) return -1;

    /* 3. 解析 header JSON 和字典 */
    uint32_t header_len;
    memcpy(&header_len, header_block + 4, 4);
    if (header_len == 0 || header_len > 4088) return -1;

    char* header_json = (char*)malloc(header_len + 1);
    if (!header_json) return -1;
    memcpy(header_json, header_block + 8, header_len);
    header_json[header_len] = '\0';

    /* 分配字典数组 */
    iter->sym_dict = (char**)malloc(256 * sizeof(char*));
    iter->itv_dict = (char**)malloc(32 * sizeof(char*));
    if (!iter->sym_dict || !iter->itv_dict) {
        free(header_json);
        return -1;
    }
    memset(iter->sym_dict, 0, 256 * sizeof(char*));
    memset(iter->itv_dict, 0, 32 * sizeof(char*));

    /* 提取 symbol 字典 */
    const char* sym_start = strstr(header_json, "\"symbol\":[");
    if (sym_start) {
        sym_start += 10;
        const char* sym_end = strchr(sym_start, ']');
        if (sym_end) {
            const char* p = sym_start;
            while (p < sym_end && iter->n_sym < 256) {
                const char* q1 = strchr(p, '"');
                if (!q1 || q1 >= sym_end) break;
                const char* q2 = strchr(q1 + 1, '"');
                if (!q2 || q2 >= sym_end) break;
                iter->sym_dict[iter->n_sym++] = strndup(q1 + 1, (size_t)(q2 - q1 - 1));
                p = q2 + 1;
            }
        }
    }

    /* 提取 interval 字典 */
    const char* itv_start = strstr(header_json, "\"interval\":[");
    if (itv_start) {
        itv_start += 12;
        const char* itv_end = strchr(itv_start, ']');
        if (itv_end) {
            const char* p = itv_start;
            while (p < itv_end && iter->n_itv < 32) {
                const char* q1 = strchr(p, '"');
                if (!q1 || q1 >= itv_end) break;
                const char* q2 = strchr(q1 + 1, '"');
                if (!q2 || q2 >= itv_end) break;
                iter->itv_dict[iter->n_itv++] = strndup(q1 + 1, (size_t)(q2 - q1 - 1));
                p = q2 + 1;
            }
        }
    }

    free(header_json);

    if (iter->n_sym == 0 || iter->n_itv == 0) return -1;

    iter->header_offset = ftell(iter->f);

    /* peek at first symbol block to get total_rows */
    uint8_t chunk_type;
    uint32_t total_rows;
    if (fread(&chunk_type, 1, 1, iter->f) != 1) return -1;
    if (fread(&total_rows, 4, 1, iter->f) != 1) return -1;
    iter->total_rows = total_rows;

    /* rewind to data start */
    fseek(iter->f, iter->header_offset, SEEK_SET);
    return 0;
}

/**
 * ndtb_streaming_iterator_next — 读取下一个块
 */
uint32_t ndtb_streaming_iterator_next(StreamingIterator* iter) {
    if (!iter || !iter->f || iter->eof) return 0;

    if (iter->header_offset == 0) {
        if (ndtb_streaming_iterator_init(iter) < 0) {
            iter->eof = 1;
            return 0;
        }
    }

    uint32_t block_rows = iter->block_rows;
    uint32_t remaining = iter->total_rows - iter->block_idx;
    if (remaining == 0) {
        iter->eof = 1;
        return 0;
    }
    if (remaining < block_rows) block_rows = remaining;

    int32_t* sym_ids = (int32_t*)malloc(block_rows * 4);
    int32_t* itv_ids = (int32_t*)malloc(block_rows * 4);
    int64_t* timestamps = (int64_t*)malloc(block_rows * 8);
    double* opens = (double*)malloc(block_rows * 8);
    double* highs = (double*)malloc(block_rows * 8);
    double* lows = (double*)malloc(block_rows * 8);
    double* closes = (double*)malloc(block_rows * 8);
    double* volumes = (double*)malloc(block_rows * 8);
    double* quote_volumes = (double*)malloc(block_rows * 8);
    uint32_t* trades = (uint32_t*)malloc(block_rows * 4);
    double* taker_buy_volumes = (double*)malloc(block_rows * 8);
    double* taker_buy_quote_volumes = (double*)malloc(block_rows * 8);

    if (!sym_ids || !itv_ids || !timestamps || !opens || !highs || !lows || !closes ||
        !volumes || !quote_volumes || !trades || !taker_buy_volumes || !taker_buy_quote_volumes) {
        goto next_cleanup;
    }

    /* symbol column */
    {
        uint8_t chunk_type;
        uint32_t clen;
        if (fread(&chunk_type, 1, 1, iter->f) != 1 || chunk_type != 0x03) goto next_cleanup;
        uint32_t row_count2;
        if (fread(&row_count2, 4, 1, iter->f) != 1 || row_count2 != block_rows) goto next_cleanup;
        if (fread(&clen, 4, 1, iter->f) != 1 || clen == 0) goto next_cleanup;

        if (clen > iter->read_buffer_cap) {
            uint32_t new_cap = clen * 1.5;
            uint8_t* new_buf = (uint8_t*)realloc(iter->read_buffer, new_cap);
            if (!new_buf) goto next_cleanup;
            iter->read_buffer = new_buf;
            iter->read_buffer_cap = new_cap;
        }

        if (fread(iter->read_buffer, 1, clen, iter->f) != clen) goto next_cleanup;
        uint32_t disk_crc;
        if (fread(&disk_crc, 4, 1, iter->f) != 1) goto next_cleanup;

        uint32_t crc_state = 0xFFFFFFFFu;
        crc_state = crc32_update(crc_state, &chunk_type, 1);
        crc_state = crc32_update(crc_state, &row_count2, 4);
        crc_state = crc32_update(crc_state, &clen, 4);
        crc_state = crc32_update(crc_state, iter->read_buffer, clen);
        uint32_t computed_crc = crc_state ^ 0xFFFFFFFFu;
        if (disk_crc != computed_crc) goto next_cleanup;

        if (clen < 4) goto next_cleanup;
        uint32_t n_items;
        memcpy(&n_items, iter->read_buffer, 4);
        if (n_items != block_rows) goto next_cleanup;
        memcpy(sym_ids, iter->read_buffer + 4, block_rows * 4);
    }

    /* interval column */
    {
        uint8_t chunk_type;
        uint32_t clen;
        if (fread(&chunk_type, 1, 1, iter->f) != 1 || chunk_type != 0x03) goto next_cleanup;
        uint32_t row_count2;
        if (fread(&row_count2, 4, 1, iter->f) != 1 || row_count2 != block_rows) goto next_cleanup;
        if (fread(&clen, 4, 1, iter->f) != 1 || clen == 0) goto next_cleanup;

        if (clen > iter->read_buffer_cap) {
            uint32_t new_cap = clen * 1.5;
            uint8_t* new_buf = (uint8_t*)realloc(iter->read_buffer, new_cap);
            if (!new_buf) goto next_cleanup;
            iter->read_buffer = new_buf;
            iter->read_buffer_cap = new_cap;
        }

        if (fread(iter->read_buffer, 1, clen, iter->f) != clen) goto next_cleanup;
        uint32_t disk_crc;
        if (fread(&disk_crc, 4, 1, iter->f) != 1) goto next_cleanup;

        uint32_t crc_state = 0xFFFFFFFFu;
        crc_state = crc32_update(crc_state, &chunk_type, 1);
        crc_state = crc32_update(crc_state, &row_count2, 4);
        crc_state = crc32_update(crc_state, &clen, 4);
        crc_state = crc32_update(crc_state, iter->read_buffer, clen);
        uint32_t computed_crc = crc_state ^ 0xFFFFFFFFu;
        if (disk_crc != computed_crc) goto next_cleanup;

        if (clen < 4) goto next_cleanup;
        uint32_t n_items;
        memcpy(&n_items, iter->read_buffer, 4);
        if (n_items != block_rows) goto next_cleanup;
        memcpy(itv_ids, iter->read_buffer + 4, block_rows * 4);
    }

    /* timestamp column (raw int64) */
    {
        uint8_t chunk_type;
        uint32_t clen;
        if (fread(&chunk_type, 1, 1, iter->f) != 1 || chunk_type != 0x00) goto next_cleanup;
        uint32_t row_count2;
        if (fread(&row_count2, 4, 1, iter->f) != 1 || row_count2 != block_rows) goto next_cleanup;
        if (fread(&clen, 4, 1, iter->f) != 1 || clen != block_rows * 8) goto next_cleanup;

        if (fread(timestamps, 8, block_rows, iter->f) != block_rows) goto next_cleanup;
        uint32_t disk_crc;
        if (fread(&disk_crc, 4, 1, iter->f) != 1) goto next_cleanup;

        uint32_t crc_state = 0xFFFFFFFFu;
        crc_state = crc32_update(crc_state, &chunk_type, 1);
        crc_state = crc32_update(crc_state, &row_count2, 4);
        crc_state = crc32_update(crc_state, &clen, 4);
        crc_state = crc32_update(crc_state, (const uint8_t*)timestamps, block_rows * 8);
        uint32_t computed_crc = crc_state ^ 0xFFFFFFFFu;
        if (disk_crc != computed_crc) goto next_cleanup;
    }

    /* OHLCV columns (5x gorilla) */
    double* ohlcv[5] = { opens, highs, lows, closes, volumes };
    for (int col = 0; col < 5; col++) {
        uint8_t chunk_type;
        uint32_t clen;
        if (fread(&chunk_type, 1, 1, iter->f) != 1 || chunk_type != 0x01) goto next_cleanup;
        uint32_t row_count2;
        if (fread(&row_count2, 4, 1, iter->f) != 1 || row_count2 != block_rows) goto next_cleanup;
        if (fread(&clen, 4, 1, iter->f) != 1 || clen == 0) goto next_cleanup;

        if (clen > iter->read_buffer_cap) {
            uint32_t new_cap = clen * 1.5;
            uint8_t* new_buf = (uint8_t*)realloc(iter->read_buffer, new_cap);
            if (!new_buf) goto next_cleanup;
            iter->read_buffer = new_buf;
            iter->read_buffer_cap = new_cap;
        }

        if (fread(iter->read_buffer, 1, clen, iter->f) != clen) goto next_cleanup;
        uint32_t disk_crc;
        if (fread(&disk_crc, 4, 1, iter->f) != 1) goto next_cleanup;

        uint32_t crc_state = 0xFFFFFFFFu;
        crc_state = crc32_update(crc_state, &chunk_type, 1);
        crc_state = crc32_update(crc_state, &row_count2, 4);
        crc_state = crc32_update(crc_state, &clen, 4);
        crc_state = crc32_update(crc_state, iter->read_buffer, clen);
        uint32_t computed_crc = crc_state ^ 0xFFFFFFFFu;
        if (disk_crc != computed_crc) goto next_cleanup;

        size_t decoded = gorilla_decompress_f64(iter->read_buffer, clen, ohlcv[col], block_rows);
        if (decoded != block_rows) goto next_cleanup;
    }

    /* quoteVolume */
    {
        uint8_t chunk_type;
        uint32_t clen;
        if (fread(&chunk_type, 1, 1, iter->f) != 1 || chunk_type != 0x01) goto next_cleanup;
        uint32_t row_count2;
        if (fread(&row_count2, 4, 1, iter->f) != 1 || row_count2 != block_rows) goto next_cleanup;
        if (fread(&clen, 4, 1, iter->f) != 1 || clen == 0) goto next_cleanup;

        if (clen > iter->read_buffer_cap) {
            uint32_t new_cap = clen * 1.5;
            uint8_t* new_buf = (uint8_t*)realloc(iter->read_buffer, new_cap);
            if (!new_buf) goto next_cleanup;
            iter->read_buffer = new_buf;
            iter->read_buffer_cap = new_cap;
        }

        if (fread(iter->read_buffer, 1, clen, iter->f) != clen) goto next_cleanup;
        uint32_t disk_crc;
        if (fread(&disk_crc, 4, 1, iter->f) != 1) goto next_cleanup;

        uint32_t crc_state = 0xFFFFFFFFu;
        crc_state = crc32_update(crc_state, &chunk_type, 1);
        crc_state = crc32_update(crc_state, &row_count2, 4);
        crc_state = crc32_update(crc_state, &clen, 4);
        crc_state = crc32_update(crc_state, iter->read_buffer, clen);
        uint32_t computed_crc = crc_state ^ 0xFFFFFFFFu;
        if (disk_crc != computed_crc) goto next_cleanup;

        size_t decoded = gorilla_decompress_f64(iter->read_buffer, clen, quote_volumes, block_rows);
        if (decoded != block_rows) goto next_cleanup;
    }

    /* trades (delta) */
    {
        uint8_t chunk_type;
        uint32_t clen;
        if (fread(&chunk_type, 1, 1, iter->f) != 1 || chunk_type != 0x02) goto next_cleanup;
        uint32_t row_count2;
        if (fread(&row_count2, 4, 1, iter->f) != 1 || row_count2 != block_rows) goto next_cleanup;
        if (fread(&clen, 4, 1, iter->f) != 1 || clen == 0) goto next_cleanup;

        if (clen > iter->read_buffer_cap) {
            uint32_t new_cap = clen * 1.5;
            uint8_t* new_buf = (uint8_t*)realloc(iter->read_buffer, new_cap);
            if (!new_buf) goto next_cleanup;
            iter->read_buffer = new_buf;
            iter->read_buffer_cap = new_cap;
        }

        if (fread(iter->read_buffer, 1, clen, iter->f) != clen) goto next_cleanup;
        uint32_t disk_crc;
        if (fread(&disk_crc, 4, 1, iter->f) != 1) goto next_cleanup;

        uint32_t crc_state = 0xFFFFFFFFu;
        crc_state = crc32_update(crc_state, &chunk_type, 1);
        crc_state = crc32_update(crc_state, &row_count2, 4);
        crc_state = crc32_update(crc_state, &clen, 4);
        crc_state = crc32_update(crc_state, iter->read_buffer, clen);
        uint32_t computed_crc = crc_state ^ 0xFFFFFFFFu;
        if (disk_crc != computed_crc) goto next_cleanup;

        int32_t* tmp_trades = (int32_t*)trades;
        size_t decoded = delta_decompress_i32(iter->read_buffer, clen, tmp_trades, block_rows);
        if (decoded != block_rows) goto next_cleanup;
    }

    /* takerBuyVolume */
    {
        uint8_t chunk_type;
        uint32_t clen;
        if (fread(&chunk_type, 1, 1, iter->f) != 1 || chunk_type != 0x01) goto next_cleanup;
        uint32_t row_count2;
        if (fread(&row_count2, 4, 1, iter->f) != 1 || row_count2 != block_rows) goto next_cleanup;
        if (fread(&clen, 4, 1, iter->f) != 1 || clen == 0) goto next_cleanup;

        if (clen > iter->read_buffer_cap) {
            uint32_t new_cap = clen * 1.5;
            uint8_t* new_buf = (uint8_t*)realloc(iter->read_buffer, new_cap);
            if (!new_buf) goto next_cleanup;
            iter->read_buffer = new_buf;
            iter->read_buffer_cap = new_cap;
        }

        if (fread(iter->read_buffer, 1, clen, iter->f) != clen) goto next_cleanup;
        uint32_t disk_crc;
        if (fread(&disk_crc, 4, 1, iter->f) != 1) goto next_cleanup;

        uint32_t crc_state = 0xFFFFFFFFu;
        crc_state = crc32_update(crc_state, &chunk_type, 1);
        crc_state = crc32_update(crc_state, &row_count2, 4);
        crc_state = crc32_update(crc_state, &clen, 4);
        crc_state = crc32_update(crc_state, iter->read_buffer, clen);
        uint32_t computed_crc = crc_state ^ 0xFFFFFFFFu;
        if (disk_crc != computed_crc) goto next_cleanup;

        size_t decoded = gorilla_decompress_f64(iter->read_buffer, clen, taker_buy_volumes, block_rows);
        if (decoded != block_rows) goto next_cleanup;
    }

    /* takerBuyQuoteVolume */
    {
        uint8_t chunk_type;
        uint32_t clen;
        if (fread(&chunk_type, 1, 1, iter->f) != 1 || chunk_type != 0x01) goto next_cleanup;
        uint32_t row_count2;
        if (fread(&row_count2, 4, 1, iter->f) != 1 || row_count2 != block_rows) goto next_cleanup;
        if (fread(&clen, 4, 1, iter->f) != 1 || clen == 0) goto next_cleanup;

        if (clen > iter->read_buffer_cap) {
            uint32_t new_cap = clen * 1.5;
            uint8_t* new_buf = (uint8_t*)realloc(iter->read_buffer, new_cap);
            if (!new_buf) goto next_cleanup;
            iter->read_buffer = new_buf;
            iter->read_buffer_cap = new_cap;
        }

        if (fread(iter->read_buffer, 1, clen, iter->f) != clen) goto next_cleanup;
        uint32_t disk_crc;
        if (fread(&disk_crc, 4, 1, iter->f) != 1) goto next_cleanup;

        uint32_t crc_state = 0xFFFFFFFFu;
        crc_state = crc32_update(crc_state, &chunk_type, 1);
        crc_state = crc32_update(crc_state, &row_count2, 4);
        crc_state = crc32_update(crc_state, &clen, 4);
        crc_state = crc32_update(crc_state, iter->read_buffer, clen);
        uint32_t computed_crc = crc_state ^ 0xFFFFFFFFu;
        if (disk_crc != computed_crc) goto next_cleanup;

        size_t decoded = gorilla_decompress_f64(iter->read_buffer, clen, taker_buy_quote_volumes, block_rows);
        if (decoded != block_rows) goto next_cleanup;
    }

    /* reconstruct KlineRow */
    for (uint32_t i = 0; i < block_rows; i++) {
        iter->current_block[i].timestamp = timestamps[i];
        iter->current_block[i].open = opens[i];
        iter->current_block[i].high = highs[i];
        iter->current_block[i].low = lows[i];
        iter->current_block[i].close = closes[i];
        iter->current_block[i].volume = volumes[i];
        iter->current_block[i].quoteVolume = quote_volumes[i];
        iter->current_block[i].trades = trades[i];
        iter->current_block[i].takerBuyVolume = taker_buy_volumes[i];
        iter->current_block[i].takerBuyQuoteVolume = taker_buy_quote_volumes[i];
        iter->current_block[i].flags = 0;
    }

    iter->block_size = block_rows;
    iter->block_idx += block_rows;

next_cleanup:
    free(sym_ids);
    free(itv_ids);
    free(timestamps);
    free(opens);
    free(highs);
    free(lows);
    free(closes);
    free(volumes);
    free(quote_volumes);
    free(trades);
    free(taker_buy_volumes);
    free(taker_buy_quote_volumes);

    if (iter->block_idx >= iter->total_rows) {
        iter->eof = 1;
    }

    return iter->block_size;
}

/**
 * ndtb_streaming_iterator_free — 释放迭代器
 */
void ndtb_streaming_iterator_free(StreamingIterator* iter) {
    if (!iter) return;
    if (iter->f) fclose(iter->f);
    if (iter->current_block) free(iter->current_block);
    if (iter->read_buffer) free(iter->read_buffer);
    if (iter->sym_dict) {
        for (int i = 0; i < iter->n_sym; i++) {
            if (iter->sym_dict[i]) free(iter->sym_dict[i]);
        }
        free(iter->sym_dict);
    }
    if (iter->itv_dict) {
        for (int i = 0; i < iter->n_itv; i++) {
            if (iter->itv_dict[i]) free(iter->itv_dict[i]);
        }
        free(iter->itv_dict);
    }
    free(iter);
}

/* ─── NULL Bitmap Implementation (Phase 2.3) ─── */

/**
 * ndtb_null_bitmap_create — 为列数据创建 NULL bitmap
 *
 * Bitmap 格式: 每行 1 bit，0=NULL，1=NOT NULL
 * 字节对齐：byte_count = (row_count + 7) / 8
 */
NullBitmap* ndtb_null_bitmap_create(uint32_t row_count, const int* null_flags) {
    if (row_count == 0) return NULL;

    uint32_t byte_count = (row_count + 7) / 8;
    NullBitmap* bitmap = (NullBitmap*)malloc(sizeof(NullBitmap));
    if (!bitmap) return NULL;

    bitmap->data = (uint8_t*)malloc(byte_count);
    if (!bitmap->data) {
        free(bitmap);
        return NULL;
    }

    bitmap->byte_count = byte_count;
    bitmap->row_count = row_count;

    /* 默认初始化所有行为 NOT NULL（位为 1）*/
    memset(bitmap->data, 0xFF, byte_count);

    /* 如果提供了 null_flags，根据标志调整位图 */
    if (null_flags) {
        for (uint32_t i = 0; i < row_count; i++) {
            if (!null_flags[i]) {
                /* null_flags[i] == 0 表示 NULL，清除对应的位 */
                uint32_t byte_idx = i / 8;
                uint32_t bit_idx = i % 8;
                bitmap->data[byte_idx] &= ~(1u << bit_idx);
            }
        }
    }

    return bitmap;
}

/**
 * ndtb_null_bitmap_is_null — 检查指定行是否为 NULL
 */
int ndtb_null_bitmap_is_null(const NullBitmap* bitmap, uint32_t row_idx) {
    if (!bitmap || row_idx >= bitmap->row_count) return -1;

    uint32_t byte_idx = row_idx / 8;
    uint32_t bit_idx = row_idx % 8;

    /* 位为 0 表示 NULL，位为 1 表示非 NULL */
    int bit_set = (bitmap->data[byte_idx] >> bit_idx) & 1;
    return bit_set ? 0 : 1;  /* 返回 1 = NULL，0 = NOT NULL */
}

/**
 * ndtb_null_bitmap_set — 设置指定行的 NULL 状态
 */
int ndtb_null_bitmap_set(NullBitmap* bitmap, uint32_t row_idx, int is_null) {
    if (!bitmap || row_idx >= bitmap->row_count) return -1;

    uint32_t byte_idx = row_idx / 8;
    uint32_t bit_idx = row_idx % 8;

    if (is_null) {
        /* 清除位 = NULL */
        bitmap->data[byte_idx] &= ~(1u << bit_idx);
    } else {
        /* 设置位 = NOT NULL */
        bitmap->data[byte_idx] |= (1u << bit_idx);
    }

    return 0;
}

/**
 * ndtb_null_bitmap_encode — 将 bitmap 编码为字节数据
 */
uint8_t* ndtb_null_bitmap_encode(const NullBitmap* bitmap, uint32_t* out_len) {
    if (!bitmap || !out_len) return NULL;

    /* 编码格式：row_count (4 bytes) + bitmap data (byte_count bytes) */
    uint32_t total_len = 4 + bitmap->byte_count;
    uint8_t* encoded = (uint8_t*)malloc(total_len);
    if (!encoded) return NULL;

    /* 写入 row_count */
    memcpy(encoded, &bitmap->row_count, 4);

    /* 写入 bitmap 数据 */
    memcpy(encoded + 4, bitmap->data, bitmap->byte_count);

    *out_len = total_len;
    return encoded;
}

/**
 * ndtb_null_bitmap_decode — 从字节数据解码 bitmap
 */
NullBitmap* ndtb_null_bitmap_decode(const uint8_t* data, uint32_t byte_count, uint32_t row_count) {
    if (!data || byte_count < 4) return NULL;

    /* 验证：byte_count >= 4 + 实际位图字节数 */
    uint32_t expected_bitmap_bytes = (row_count + 7) / 8;
    if (byte_count < 4 + expected_bitmap_bytes) return NULL;

    /* 读取行数验证 */
    uint32_t stored_row_count = 0;
    memcpy(&stored_row_count, data, 4);
    if (stored_row_count != row_count) return NULL;

    NullBitmap* bitmap = (NullBitmap*)malloc(sizeof(NullBitmap));
    if (!bitmap) return NULL;

    bitmap->data = (uint8_t*)malloc(expected_bitmap_bytes);
    if (!bitmap->data) {
        free(bitmap);
        return NULL;
    }

    memcpy(bitmap->data, data + 4, expected_bitmap_bytes);
    bitmap->byte_count = expected_bitmap_bytes;
    bitmap->row_count = row_count;

    return bitmap;
}

/**
 * ndtb_null_bitmap_free — 释放 NULL bitmap
 */
void ndtb_null_bitmap_free(NullBitmap* bitmap) {
    if (!bitmap) return;
    if (bitmap->data) free(bitmap->data);
    free(bitmap);
}
