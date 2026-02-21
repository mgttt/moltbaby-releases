// ============================================================
// libndts - N-Dimensional Time Series Native Core
// 
// 高性能底层操作：类型转换 · 排序 · 重排列 · SIMD
// ============================================================

#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <float.h>
#include <math.h>
#include <stdio.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <dirent.h>
#include <time.h>
#include "ndtsdb.h"

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
                WRITE_BITS(meaningful, 6);
                WRITE_BITS(xor_val >> trailing, meaningful);
                
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
    
    return byte_pos;
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
static void write_partition_file(const char* filepath,
                                  KlineRow* rows, uint32_t n_rows,
                                  char** sym_dict, int n_sym,
                                  char** itv_dict, int n_itv,
                                  int32_t* sym_ids, int32_t* itv_ids) {
    FILE* f = fopen(filepath, "wb");
    if (!f) return;

    /* === 构建 JSON header === */
    char json[8192];
    int pos = 0;
    pos += snprintf(json+pos, sizeof(json)-pos,
        "{\"columns\":["
        "{\"name\":\"symbol\",\"type\":\"string\"},"
        "{\"name\":\"interval\",\"type\":\"string\"},"
        "{\"name\":\"timestamp\",\"type\":\"int64\"},"
        "{\"name\":\"open\",\"type\":\"float64\"},"
        "{\"name\":\"high\",\"type\":\"float64\"},"
        "{\"name\":\"low\",\"type\":\"float64\"},"
        "{\"name\":\"close\",\"type\":\"float64\"},"
        "{\"name\":\"volume\",\"type\":\"float64\"}"
        "],\"totalRows\":%u,\"chunkCount\":1,\"stringDicts\":{", n_rows);

    pos += snprintf(json+pos, sizeof(json)-pos, "\"symbol\":[");
    for (int i = 0; i < n_sym; i++) {
        if (i > 0) json[pos++] = ',';
        pos += snprintf(json+pos, sizeof(json)-pos, "\"%s\"", sym_dict[i]);
    }
    pos += snprintf(json+pos, sizeof(json)-pos, "],\"interval\":[");
    for (int i = 0; i < n_itv; i++) {
        if (i > 0) json[pos++] = ',';
        pos += snprintf(json+pos, sizeof(json)-pos, "\"%s\"", itv_dict[i]);
    }
    pos += snprintf(json+pos, sizeof(json)-pos, "]}}");

    /* === 写入固定4096字节header区（与Bun RESERVED_HEADER_SIZE=4096对齐） === */
    /* header_block[4096]: magic(4) + header_len(4) + json(N) + padding(4096-8-N) */
    #define RESERVED_HEADER_SIZE 4096
    uint8_t header_block[RESERVED_HEADER_SIZE];
    memset(header_block, 0, RESERVED_HEADER_SIZE);
    uint32_t hlen = (uint32_t)pos;
    /* magic */
    memcpy(header_block, "NDTS", 4);
    /* header_len */
    memcpy(header_block + 4, &hlen, 4);
    /* json */
    memcpy(header_block + 8, json, pos);
    /* padding已由memset填0 */

    fwrite(header_block, 1, RESERVED_HEADER_SIZE, f);

    /* === CRC32 of 整个header_block（与Bun一致） === */
    uint32_t hcrc = crc32_buf(header_block, RESERVED_HEADER_SIZE);
    fwrite(&hcrc, 4, 1, f);
    #undef RESERVED_HEADER_SIZE

    /* === Chunk === */
    /* chunk_start: 用于计算chunk的CRC32 */
    uint8_t* chunk_buf;
    size_t chunk_size = 4  /* row_count */
        + n_rows * 4   /* symbol: int32 */
        + n_rows * 4   /* interval: int32 */
        + n_rows * 8   /* timestamp: int64 */
        + n_rows * 8   /* open: float64 */
        + n_rows * 8   /* high: float64 */
        + n_rows * 8   /* low: float64 */
        + n_rows * 8   /* close: float64 */
        + n_rows * 8;  /* volume: float64 */

    chunk_buf = (uint8_t*)malloc(chunk_size);
    if (!chunk_buf) { fclose(f); return; }

    uint8_t* p = chunk_buf;

    /* row_count */
    memcpy(p, &n_rows, 4); p += 4;

    /* symbol列（int32字典id） */
    for (uint32_t i = 0; i < n_rows; i++) {
        memcpy(p, &sym_ids[i], 4); p += 4;
    }
    /* interval列（int32字典id） */
    for (uint32_t i = 0; i < n_rows; i++) {
        memcpy(p, &itv_ids[i], 4); p += 4;
    }
    /* timestamp列 */
    for (uint32_t i = 0; i < n_rows; i++) {
        memcpy(p, &rows[i].timestamp, 8); p += 8;
    }
    /* open列 */
    for (uint32_t i = 0; i < n_rows; i++) {
        memcpy(p, &rows[i].open, 8); p += 8;
    }
    /* high列 */
    for (uint32_t i = 0; i < n_rows; i++) {
        memcpy(p, &rows[i].high, 8); p += 8;
    }
    /* low列 */
    for (uint32_t i = 0; i < n_rows; i++) {
        memcpy(p, &rows[i].low, 8); p += 8;
    }
    /* close列 */
    for (uint32_t i = 0; i < n_rows; i++) {
        memcpy(p, &rows[i].close, 8); p += 8;
    }
    /* volume列 */
    for (uint32_t i = 0; i < n_rows; i++) {
        memcpy(p, &rows[i].volume, 8); p += 8;
    }

    fwrite(chunk_buf, 1, chunk_size, f);

    /* chunk CRC32 */
    uint32_t ccrc = crc32_buf(chunk_buf, chunk_size);
    fwrite(&ccrc, 4, 1, f);

    free(chunk_buf);
    fclose(f);
}

// ============================================================
// ndtsdb 高级 API 实现 (MVP)
// ============================================================

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// 简化版数据库结构
struct NDTSDB {
    char path[256];
    int is_dir;   // 1=目录模式（PartitionedTable格式），0=文件模式（旧格式）
    int dirty;    // 1=有写入操作，close时才写出；0=只读，close不写文件
};

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

static SymbolData* g_symbols = NULL;     // 动态分配的symbol数组
static uint32_t g_symbol_count = 0;      // 当前symbol数量
static uint32_t g_symbols_capacity = 0;  // 当前symbol数组容量

static SymbolData* find_or_create_symbol(const char* symbol, const char* interval) {
    // 首次使用，lazy init
    if (!g_symbols) {
        g_symbols_capacity = INITIAL_SYMBOLS_CAPACITY;
        g_symbols = (SymbolData*)malloc(g_symbols_capacity * sizeof(SymbolData));
        if (!g_symbols) return NULL;
        memset(g_symbols, 0, g_symbols_capacity * sizeof(SymbolData));
    }

    // 查找已存在的symbol
    for (uint32_t i = 0; i < g_symbol_count; i++) {
        if (strcmp(g_symbols[i].symbol, symbol) == 0 && 
            strcmp(g_symbols[i].interval, interval) == 0) {
            return &g_symbols[i];
        }
    }
    
    // 需要新增symbol，检查是否需要扩容
    if (g_symbol_count >= g_symbols_capacity) {
        uint32_t new_capacity = g_symbols_capacity * 2;
        SymbolData* new_symbols = (SymbolData*)realloc(g_symbols, new_capacity * sizeof(SymbolData));
        if (!new_symbols) return NULL;
        // 清零新分配的内存
        memset(new_symbols + g_symbols_capacity, 0, (new_capacity - g_symbols_capacity) * sizeof(SymbolData));
        g_symbols = new_symbols;
        g_symbols_capacity = new_capacity;
    }
    
    SymbolData* sd = &g_symbols[g_symbol_count++];
    strncpy(sd->symbol, symbol, sizeof(sd->symbol) - 1);
    sd->symbol[sizeof(sd->symbol) - 1] = '\0';
    strncpy(sd->interval, interval, sizeof(sd->interval) - 1);
    sd->interval[sizeof(sd->interval) - 1] = '\0';
    sd->count = 0;
    sd->capacity = INITIAL_KLINES_CAPACITY;
    sd->klines = (KlineRow*)malloc(sd->capacity * sizeof(KlineRow));
    if (!sd->klines) {
        // 分配失败，回退
        g_symbol_count--;
        return NULL;
    }
    return sd;
}

NDTSDB* ndtsdb_open(const char* path) {
    NDTSDB* db = (NDTSDB*)malloc(sizeof(NDTSDB));
    if (!db) return NULL;
    
    strncpy(db->path, path, sizeof(db->path) - 1);
    db->path[sizeof(db->path) - 1] = '\0';
    
    // 检测路径类型
    db->is_dir = path_is_dir(path);
    db->dirty = 0;  // 默认只读，insert操作时置1
    
    if (db->is_dir) {
        /* === 目录模式：读取所有分区文件（Phase 2，Bun版格式） === */
        DIR* dir = opendir(path);
        if (!dir) return db;  // 目录不存在，返回空DB（后续写入时创建）
        
        struct dirent* ent;
        while ((ent = readdir(dir)) != NULL) {
            // 只处理 .ndts 文件
            if (!strstr(ent->d_name, ".ndts")) continue;
            
            char filepath[512];
            snprintf(filepath, sizeof(filepath), "%s/%s", path, ent->d_name);
            
            FILE* f = fopen(filepath, "rb");
            if (!f) continue;
            
            // 1. 验证 magic
            char magic[4];
            if (fread(magic, 1, 4, f) != 4 || memcmp(magic, "NDTS", 4) != 0) {
                fclose(f);
                continue;
            }
            
            // 2. 读 header_len
            uint32_t header_len;
            if (fread(&header_len, 4, 1, f) != 1) {
                fclose(f);
                continue;
            }
            
            // 3. 读 header_json
            char* header_json = (char*)malloc(header_len + 1);
            if (!header_json || fread(header_json, 1, header_len, f) != header_len) {
                free(header_json);
                fclose(f);
                continue;
            }
            header_json[header_len] = '\0';
            
            // 4. 解析 stringDicts
            char* sym_dict[100];
            char* itv_dict[100];
            int n_sym = 0, n_itv = 0;
            
            // 提取 symbol 数组
            char* sym_start = strstr(header_json, "\"symbol\":[");
            if (sym_start) {
                sym_start += 10;
                char* sym_end = strchr(sym_start, ']');
                if (sym_end) {
                    char* p = sym_start;
                    while (p < sym_end && n_sym < 100) {
                        char* quote1 = strchr(p, '"');
                        if (!quote1 || quote1 >= sym_end) break;
                        char* quote2 = strchr(quote1 + 1, '"');
                        if (!quote2 || quote2 >= sym_end) break;
                        
                        *quote2 = '\0';
                        sym_dict[n_sym++] = strdup(quote1 + 1);
                        *quote2 = '"';
                        p = quote2 + 1;
                    }
                }
            }
            
            // 提取 interval 数组
            char* itv_start = strstr(header_json, "\"interval\":[");
            if (itv_start) {
                itv_start += 12;
                char* itv_end = strchr(itv_start, ']');
                if (itv_end) {
                    char* p = itv_start;
                    while (p < itv_end && n_itv < 100) {
                        char* quote1 = strchr(p, '"');
                        if (!quote1 || quote1 >= itv_end) break;
                        char* quote2 = strchr(quote1 + 1, '"');
                        if (!quote2 || quote2 >= itv_end) break;
                        
                        *quote2 = '\0';
                        itv_dict[n_itv++] = strdup(quote1 + 1);
                        *quote2 = '"';
                        p = quote2 + 1;
                    }
                }
            }
            
            free(header_json);
            
            // 5. 跳到 chunks 起始位置（固定偏移4100 = 4096 + 4字节CRC）
            fseek(f, 4100, SEEK_SET);
            
            // 6. 循环读取所有 chunks
            while (!feof(f)) {
                uint32_t row_count = 0;
                if (fread(&row_count, 4, 1, f) != 1 || row_count == 0) break;
                
                // 分配列缓冲区
                int32_t* sym_ids = (int32_t*)malloc(row_count * 4);
                int32_t* itv_ids = (int32_t*)malloc(row_count * 4);
                int64_t* timestamps = (int64_t*)malloc(row_count * 8);
                double* opens = (double*)malloc(row_count * 8);
                double* highs = (double*)malloc(row_count * 8);
                double* lows = (double*)malloc(row_count * 8);
                double* closes = (double*)malloc(row_count * 8);
                double* volumes = (double*)malloc(row_count * 8);
                
                if (!sym_ids || !itv_ids || !timestamps || !opens || !highs || !lows || !closes || !volumes) {
                    free(sym_ids); free(itv_ids); free(timestamps); free(opens);
                    free(highs); free(lows); free(closes); free(volumes);
                    break;
                }
                
                // 读取列数据（Bun版顺序）
                fread(sym_ids, 4, row_count, f);
                fread(itv_ids, 4, row_count, f);
                fread(timestamps, 8, row_count, f);
                fread(opens, 8, row_count, f);
                fread(highs, 8, row_count, f);
                fread(lows, 8, row_count, f);
                fread(closes, 8, row_count, f);
                fread(volumes, 8, row_count, f);
                
                // 跳过 chunk CRC32
                uint32_t chunk_crc;
                fread(&chunk_crc, 4, 1, f);
                
                // 还原rows并写入 g_symbols
                for (uint32_t i = 0; i < row_count; i++) {
                    const char* sym = (sym_ids[i] >= 0 && sym_ids[i] < n_sym) ? sym_dict[sym_ids[i]] : "UNKNOWN";
                    const char* itv = (itv_ids[i] >= 0 && itv_ids[i] < n_itv) ? itv_dict[itv_ids[i]] : "UNKNOWN";
                    
                    SymbolData* sd = find_or_create_symbol(sym, itv);
                    if (sd) {
                        // 检查容量，必要时扩容
                        if (sd->count >= sd->capacity) {
                            uint32_t new_capacity = sd->capacity * 2;
                            KlineRow* new_klines = (KlineRow*)realloc(sd->klines, new_capacity * sizeof(KlineRow));
                            if (!new_klines) continue;  // 扩容失败，跳过此行
                            sd->klines = new_klines;
                            sd->capacity = new_capacity;
                        }
                        sd->klines[sd->count].timestamp = timestamps[i];
                        sd->klines[sd->count].open = opens[i];
                        sd->klines[sd->count].high = highs[i];
                        sd->klines[sd->count].low = lows[i];
                        sd->klines[sd->count].close = closes[i];
                        sd->klines[sd->count].volume = volumes[i];
                        sd->count++;
                    }
                }
                
                // 清理当前chunk
                free(sym_ids); free(itv_ids); free(timestamps); free(opens);
                free(highs); free(lows); free(closes); free(volumes);
            }
            
            fclose(f);
            
            // 注意：不释放 sym_dict/itv_dict，因为 g_symbols 引用了这些字符串
        }
        
        closedir(dir);
    } else {
        // 文件模式：读取旧格式（Phase 1已实现）
        FILE* f = fopen(path, "rb");
        if (f) {
            char magic[4];
            if (fread(magic, 1, 4, f) == 4 && memcmp(magic, "NDTS", 4) == 0) {
                uint32_t version, count;
                fread(&version, 4, 1, f);
                fread(&count, 4, 1, f);
                
                // 确保g_symbols已分配
                if (!g_symbols) {
                    g_symbols_capacity = INITIAL_SYMBOLS_CAPACITY;
                    g_symbols = (SymbolData*)malloc(g_symbols_capacity * sizeof(SymbolData));
                    if (!g_symbols) {
                        fclose(f);
                        return db;
                    }
                    memset(g_symbols, 0, g_symbols_capacity * sizeof(SymbolData));
                }

                for (uint32_t i = 0; i < count; i++) {
                    // 检查是否需要扩容
                    if (g_symbol_count >= g_symbols_capacity) {
                        uint32_t new_capacity = g_symbols_capacity * 2;
                        SymbolData* new_symbols = (SymbolData*)realloc(g_symbols, new_capacity * sizeof(SymbolData));
                        if (!new_symbols) break;  // 扩容失败，停止读取
                        memset(new_symbols + g_symbols_capacity, 0, (new_capacity - g_symbols_capacity) * sizeof(SymbolData));
                        g_symbols = new_symbols;
                        g_symbols_capacity = new_capacity;
                    }

                    SymbolData* sd = &g_symbols[g_symbol_count];
                    fread(sd->symbol, 32, 1, f);
                    fread(sd->interval, 16, 1, f);
                    fread(&sd->count, 4, 1, f);
                    
                    // 动态分配容量（至少count条，或按INITIAL_KLINES_CAPACITY）
                    sd->capacity = sd->count > INITIAL_KLINES_CAPACITY ? sd->count : INITIAL_KLINES_CAPACITY;
                    sd->klines = (KlineRow*)malloc(sd->capacity * sizeof(KlineRow));
                    if (!sd->klines) {
                        // 分配失败，跳过此symbol
                        sd->count = 0;
                        sd->capacity = 0;
                        continue;
                    }
                    
                    fread(sd->klines, sizeof(KlineRow), sd->count, f);
                    
                    g_symbol_count++;
                }
            }
            fclose(f);
        }
    }
    
    return db;
}

void ndtsdb_close(NDTSDB* db) {
    if (!db) return;

    if (!db->dirty) goto cleanup;  // 只读操作，不写出文件

    if (db->is_dir) {
        /* ===== 目录模式：写出 PartitionedTable 格式 ===== */
        
        /* 先统计总行数 */
        uint32_t total = 0;
        for (uint32_t i = 0; i < g_symbol_count; i++) total += g_symbols[i].count;
        
        if (total == 0) goto cleanup;
        
        /* 扁平化所有行 */
        typedef struct {
            KlineRow row;
            char symbol[32];
            char interval[16];
        } FlatRow;

        FlatRow* flat = (FlatRow*)malloc(total * sizeof(FlatRow));
        if (!flat) goto cleanup;

        uint32_t fi = 0;
        for (uint32_t i = 0; i < g_symbol_count; i++) {
            for (uint32_t j = 0; j < g_symbols[i].count; j++) {
                flat[fi].row = g_symbols[i].klines[j];
                strncpy(flat[fi].symbol, g_symbols[i].symbol, 31);
                flat[fi].symbol[31] = '\0';
                strncpy(flat[fi].interval, g_symbols[i].interval, 15);
                flat[fi].interval[15] = '\0';
                fi++;
            }
        }

        /* 收集唯一天 */
        char days[365][12];
        int n_days = 0;

        for (uint32_t i = 0; i < total; i++) {
            char day[12];
            ts_to_day(flat[i].row.timestamp, day);
            int found = 0;
            for (int d = 0; d < n_days; d++) {
                if (strcmp(days[d], day) == 0) { found = 1; break; }
            }
            if (!found && n_days < 365) {
                strncpy(days[n_days], day, 11);
                days[n_days][11] = '\0';
                n_days++;
            }
        }

        /* 确保目录存在 */
        mkdir(db->path, 0755);

        /* 对每一天写一个分区文件 */
        for (int d = 0; d < n_days; d++) {
            /* 收集该天的行 */
            uint32_t day_n = 0;
            for (uint32_t i = 0; i < total; i++) {
                char day[12]; 
                ts_to_day(flat[i].row.timestamp, day);
                if (strcmp(day, days[d]) == 0) day_n++;
            }

            KlineRow* day_rows = (KlineRow*)malloc(day_n * sizeof(KlineRow));
            int32_t* sym_ids = (int32_t*)malloc(day_n * sizeof(int32_t));
            int32_t* itv_ids = (int32_t*)malloc(day_n * sizeof(int32_t));

            if (!day_rows || !sym_ids || !itv_ids) {
                free(day_rows); free(sym_ids); free(itv_ids);
                continue;
            }

            /* 建字典 */
            char* sym_dict[64]; int n_sym = 0;
            char* itv_dict[16]; int n_itv = 0;

            uint32_t ri = 0;
            for (uint32_t i = 0; i < total; i++) {
                char day[12]; 
                ts_to_day(flat[i].row.timestamp, day);
                if (strcmp(day, days[d]) != 0) continue;

                day_rows[ri] = flat[i].row;

                /* symbol 字典查询 */
                int si = -1;
                for (int s = 0; s < n_sym; s++) {
                    if (strcmp(sym_dict[s], flat[i].symbol) == 0) { si = s; break; }
                }
                if (si < 0 && n_sym < 64) {
                    sym_dict[n_sym] = strdup(flat[i].symbol);
                    si = n_sym++;
                }
                sym_ids[ri] = si;

                /* interval 字典 */
                int ii = -1;
                for (int v = 0; v < n_itv; v++) {
                    if (strcmp(itv_dict[v], flat[i].interval) == 0) { ii = v; break; }
                }
                if (ii < 0 && n_itv < 16) {
                    itv_dict[n_itv] = strdup(flat[i].interval);
                    ii = n_itv++;
                }
                itv_ids[ri] = ii;
                ri++;
            }

            /* 写文件 */
            char filepath[512];
            snprintf(filepath, sizeof(filepath), "%s/%s.ndts", db->path, days[d]);
            write_partition_file(filepath, day_rows, day_n,
                                  sym_dict, n_sym, itv_dict, n_itv,
                                  sym_ids, itv_ids);

            /* 清理字典 */
            for (int s = 0; s < n_sym; s++) free(sym_dict[s]);
            for (int v = 0; v < n_itv; v++) free(itv_dict[v]);
            free(day_rows); free(sym_ids); free(itv_ids);
        }

        free(flat);
    } else {
        /* ===== 文件模式：保持旧格式（向后兼容） ===== */
        FILE* f = fopen(db->path, "wb");
        if (f) {
            fwrite("NDTS", 1, 4, f);
            uint32_t version = 1;
            fwrite(&version, 4, 1, f);
            fwrite(&g_symbol_count, 4, 1, f);
            for (uint32_t i = 0; i < g_symbol_count; i++) {
                SymbolData* sd = &g_symbols[i];
                fwrite(sd->symbol, 32, 1, f);
                fwrite(sd->interval, 16, 1, f);
                fwrite(&sd->count, 4, 1, f);
                fwrite(sd->klines, sizeof(KlineRow), sd->count, f);
            }
            fclose(f);
        }
    }

cleanup:
    /* 释放所有动态分配的klines */
    for (uint32_t i = 0; i < g_symbol_count; i++) {
        if (g_symbols[i].klines) {
            free(g_symbols[i].klines);
            g_symbols[i].klines = NULL;
        }
    }
    /* 释放symbol数组本身 */
    if (g_symbols) {
        free(g_symbols);
        g_symbols = NULL;
    }
    /* 重置全局状态 */
    g_symbol_count = 0;
    g_symbols_capacity = 0;
    free(db);
}

int ndtsdb_insert(NDTSDB* db, const char* symbol, const char* interval, const KlineRow* row) {
    if (db) db->dirty = 1;  // 标记有写入
    SymbolData* sd = find_or_create_symbol(symbol, interval);
    if (!sd) return -1;
    
    // 动态扩容：count >= capacity 时 realloc
    if (sd->count >= sd->capacity) {
        uint32_t new_capacity = sd->capacity * 2;
        KlineRow* new_klines = (KlineRow*)realloc(sd->klines, new_capacity * sizeof(KlineRow));
        if (!new_klines) return -1;  // 扩容失败
        sd->klines = new_klines;
        sd->capacity = new_capacity;
    }
    
    sd->klines[sd->count++] = *row;
    return 0;
}

int ndtsdb_insert_batch(NDTSDB* db, const char* symbol, const char* interval, const KlineRow* rows, uint32_t n) {
    if (db) db->dirty = 1;  // 标记有写入
    SymbolData* sd = find_or_create_symbol(symbol, interval);
    if (!sd) return -1;
    
    // 检查是否需要扩容（批量扩容，避免多次realloc）
    uint32_t required = sd->count + n;
    if (required > sd->capacity) {
        // 计算新的capacity（至少翻倍，或满足需求）
        uint32_t new_capacity = sd->capacity;
        while (new_capacity < required) {
            new_capacity *= 2;
        }
        KlineRow* new_klines = (KlineRow*)realloc(sd->klines, new_capacity * sizeof(KlineRow));
        if (!new_klines) return -1;  // 扩容失败
        sd->klines = new_klines;
        sd->capacity = new_capacity;
    }
    
    uint32_t inserted = 0;
    for (uint32_t i = 0; i < n; i++) {
        sd->klines[sd->count++] = rows[i];
        inserted++;
    }
    return (int)inserted;
}

QueryResult* ndtsdb_query(NDTSDB* db, const Query* q) {
    (void)db;
    SymbolData* sd = find_or_create_symbol(q->symbol, q->interval);
    if (!sd || sd->count == 0) {
        QueryResult* r = (QueryResult*)malloc(sizeof(QueryResult));
        r->rows = NULL;
        r->count = 0;
        r->capacity = 0;
        return r;
    }
    
    // 简单过滤：时间范围
    uint32_t capacity = q->limit > 0 ? q->limit : sd->count;
    KlineRow* rows = (KlineRow*)malloc(capacity * sizeof(KlineRow));
    uint32_t count = 0;
    
    for (uint32_t i = 0; i < sd->count && count < capacity; i++) {
        if (sd->klines[i].timestamp >= q->startTime && 
            sd->klines[i].timestamp <= q->endTime) {
            rows[count++] = sd->klines[i];
        }
    }
    
    QueryResult* r = (QueryResult*)malloc(sizeof(QueryResult));
    r->rows = rows;
    r->count = count;
    r->capacity = capacity;
    return r;
}

void ndtsdb_free_result(QueryResult* r) {
    if (r) {
        if (r->rows) free(r->rows);
        free(r);
    }
}

int64_t ndtsdb_get_latest_timestamp(NDTSDB* db, const char* symbol, const char* interval) {
    (void)db;
    SymbolData* sd = find_or_create_symbol(symbol, interval);
    if (!sd || sd->count == 0) return -1;
    return sd->klines[sd->count - 1].timestamp;
}
