/**
 * ndtsdb_vector.c — 向量字段存储实现
 *
 * 文件格式（*.ndtv）：
 *
 *   [文件头 64 字节]
 *     magic[4]        = "NDTV"
 *     version[2]      = 0x0001
 *     reserved[2]     = 0x0000
 *     record_count[8] = uint64_t（写入时追加，关闭时更新）
 *     padding[48]     = 0x00（保留）
 *
 *   [记录序列，追加写]
 *   每条记录：
 *     rec_size[4]         = uint32_t（本记录字节数，含此字段本身）
 *     timestamp[8]        = int64_t
 *     agent_id[32]        = char[32]（NUL 终止）
 *     type[16]            = char[16]（NUL 终止）
 *     confidence[4]       = float32
 *     embedding_dim[2]    = uint16_t
 *     flags[4]            = uint32_t
 *     _pad[2]             = 0x0000（对齐）
 *     embedding[dim*4]    = float32 数组
 *
 * 总记录头固定部分 = 4+8+32+16+4+2+4+2 = 72 字节
 * 总记录大小 = 72 + embedding_dim * 4
 */

#include "ndtsdb_vector.h"

#ifdef _WIN32
#include <windows.h>
#include <io.h>
#define fsync(fd) _commit(fd)
#else
#include <unistd.h>
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include <errno.h>

/* ─── 常量 ─────────────────────────────────────────────── */

#define NDTV_MAGIC          "NDTV"
#define NDTV_VERSION        0x0001u
#define NDTV_FILE_HDR_SIZE  64
#define NDTV_REC_HDR_FIXED  72   /* 不含 embedding 的记录头大小 */

/* ─── 内部：路径构造 ────────────────────────────────────── */

/**
 * 构造 .ndtv 文件路径：<db_path>/<symbol>__<interval>.ndtv
 * 调用方保证 buf 大小 ≥ 512。
 */
static void build_vector_path(const char* db_path,
                               const char* symbol,
                               const char* interval,
                               char* buf, size_t buf_size)
{
    /* 去掉末尾 '/' */
    size_t plen = strlen(db_path);
    char path[256];
    strncpy(path, db_path, sizeof(path) - 1);
    path[sizeof(path) - 1] = '\0';
    if (plen > 0 && path[plen - 1] == '/') path[plen - 1] = '\0';

    snprintf(buf, buf_size, "%s/%s__%s.ndtv", path, symbol, interval);
}

/* ─── 内部：文件头读写 ──────────────────────────────────── */

/* 在文件头偏移 8 处存放 record_count（uint64_t）*/
#define NDTV_COUNT_OFFSET  8

static int write_file_header(FILE* f, uint64_t record_count)
{
    uint8_t hdr[NDTV_FILE_HDR_SIZE];
    memset(hdr, 0, sizeof(hdr));

    memcpy(hdr,     NDTV_MAGIC, 4);
    uint16_t ver = NDTV_VERSION;
    memcpy(hdr + 4, &ver, 2);
    /* reserved[2] = 0 */
    memcpy(hdr + NDTV_COUNT_OFFSET, &record_count, 8);
    /* padding 剩余填 0 */

    rewind(f);
    size_t written = fwrite(hdr, 1, sizeof(hdr), f);
    return (written == sizeof(hdr)) ? 0 : -1;
}

static int read_file_header(FILE* f, uint64_t* out_count)
{
    uint8_t hdr[NDTV_FILE_HDR_SIZE];
    rewind(f);
    if (fread(hdr, 1, sizeof(hdr), f) != sizeof(hdr)) return -1;

    if (memcmp(hdr, NDTV_MAGIC, 4) != 0) return -1; /* magic 不符 */

    memcpy(out_count, hdr + NDTV_COUNT_OFFSET, 8);
    return 0;
}

/* ─── 公开 API ──────────────────────────────────────────── */

int ndtsdb_insert_vector(NDTSDB* db,
                         const char* symbol,
                         const char* interval,
                         const VectorRecord* record)
{
    if (!db || !symbol || !interval || !record) return -1;
    if (record->embedding_dim > 0 && !record->embedding) return -1;

    /* 构造路径 */
    char filepath[512];
    build_vector_path(ndtsdb_get_path(db), symbol, interval, filepath, sizeof(filepath));

    /* 打开文件（追加或新建） */
    uint64_t record_count = 0;
    FILE* f = fopen(filepath, "r+b");
    if (!f) {
        /* 新文件：先创建并写文件头 */
        f = fopen(filepath, "w+b");
        if (!f) return -1;
        if (write_file_header(f, 0) != 0) { fclose(f); return -1; }
    } else {
        /* 已存在：读取当前 record_count */
        if (read_file_header(f, &record_count) != 0) {
            fclose(f); return -1;
        }
    }

    /* 移到文件末尾追加 */
    if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return -1; }

    /* 计算本记录大小 */
    uint32_t emb_bytes  = (uint32_t)record->embedding_dim * sizeof(float);
    uint32_t rec_size   = (uint32_t)NDTV_REC_HDR_FIXED + emb_bytes;

    /* 序列化记录 */
    uint8_t* buf = (uint8_t*)malloc(rec_size);
    if (!buf) { fclose(f); return -1; }
    memset(buf, 0, rec_size);

    uint8_t* p = buf;

    /* rec_size[4] */
    memcpy(p, &rec_size, 4);             p += 4;
    /* timestamp[8] */
    memcpy(p, &record->timestamp, 8);    p += 8;
    /* agent_id[32] */
    strncpy((char*)p, record->agent_id, 31);
    p[31] = '\0';                        p += 32;
    /* type[16] */
    strncpy((char*)p, record->type, 15);
    p[15] = '\0';                        p += 16;
    /* confidence[4] */
    memcpy(p, &record->confidence, 4);   p += 4;
    /* embedding_dim[2] */
    memcpy(p, &record->embedding_dim, 2); p += 2;
    /* flags[4] */
    memcpy(p, &record->flags, 4);        p += 4;
    /* _pad[2] */
    p += 2;
    /* embedding */
    if (emb_bytes > 0)
        memcpy(p, record->embedding, emb_bytes);

    size_t written = fwrite(buf, 1, rec_size, f);
    free(buf);

    if (written != rec_size) { fclose(f); return -1; }

    /* 更新文件头 record_count */
    record_count++;
    if (write_file_header(f, record_count) != 0) { fclose(f); return -1; }

    fflush(f);
    /* Phase 1: 确保数据持久化到磁盘 */
    if (fsync(fileno(f)) != 0) {
        fclose(f);
        return -1;
    }
    fclose(f);
    return 0;
}

VectorQueryResult* ndtsdb_query_vectors(NDTSDB* db,
                                         const char* symbol,
                                         const char* interval)
{
    if (!db || !symbol || !interval) return NULL;

    /* 分配结果 */
    VectorQueryResult* result = (VectorQueryResult*)malloc(sizeof(VectorQueryResult));
    if (!result) return NULL;
    result->records = NULL;
    result->count   = 0;

    /* 构造路径 */
    char filepath[512];
    build_vector_path(ndtsdb_get_path(db), symbol, interval, filepath, sizeof(filepath));

    FILE* f = fopen(filepath, "rb");
    if (!f) return result;  /* 文件不存在 → 返回空结果（正常） */

    /* 读文件头 */
    uint64_t record_count = 0;
    if (read_file_header(f, &record_count) != 0 || record_count == 0) {
        fclose(f); return result;
    }

    /* 分配记录数组 */
    result->records = (VectorRecord*)calloc(record_count, sizeof(VectorRecord));
    if (!result->records) { fclose(f); free(result); return NULL; }

    /* 跳到第一条记录 */
    if (fseek(f, NDTV_FILE_HDR_SIZE, SEEK_SET) != 0) {
        fclose(f); ndtsdb_vector_free_result(result); return NULL;
    }

    uint32_t idx = 0;
    while (idx < (uint32_t)record_count) {
        uint32_t rec_size = 0;
        if (fread(&rec_size, 4, 1, f) != 1) break;
        if (rec_size < (uint32_t)NDTV_REC_HDR_FIXED) break;

        VectorRecord* rec = &result->records[idx];

        /* timestamp[8] */
        if (fread(&rec->timestamp, 8, 1, f) != 1) break;
        /* agent_id[32] */
        if (fread(rec->agent_id, 32, 1, f) != 1) break;
        rec->agent_id[31] = '\0';
        /* type[16] */
        if (fread(rec->type, 16, 1, f) != 1) break;
        rec->type[15] = '\0';
        /* confidence[4] */
        if (fread(&rec->confidence, 4, 1, f) != 1) break;
        /* embedding_dim[2] */
        if (fread(&rec->embedding_dim, 2, 1, f) != 1) break;
        /* flags[4] */
        if (fread(&rec->flags, 4, 1, f) != 1) break;
        /* _pad[2] */
        uint16_t pad = 0;
        if (fread(&pad, 2, 1, f) != 1) break;

        /* embedding */
        uint32_t emb_bytes = (uint32_t)rec->embedding_dim * sizeof(float);
        if (emb_bytes > 0) {
            rec->embedding = (float*)malloc(emb_bytes);
            if (!rec->embedding) break;
            if (fread(rec->embedding, emb_bytes, 1, f) != 1) {
                free(rec->embedding); rec->embedding = NULL; break;
            }
        } else {
            rec->embedding = NULL;
        }

        idx++;
    }
    result->count = idx;

    fclose(f);
    return result;
}

void ndtsdb_vector_free_result(VectorQueryResult* result)
{
    if (!result) return;
    if (result->records) {
        for (uint32_t i = 0; i < result->count; i++) {
            free(result->records[i].embedding);
        }
        free(result->records);
    }
    free(result);
}
