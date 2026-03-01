// ============================================================
// 分区文件 FFI 读取器 - 直接读取和解压 NDTS 分区文件
// ============================================================
// 提供 FFI 接口用于 TypeScript 直接读取分区文件数据

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <ctype.h>

#define HEADER_BLOCK_SIZE 4096
#define MAX_JSON_SIZE 4096
#define MAX_COLUMNS 16
#define MAX_ROWS 100000

// 简单 JSON 构建器
typedef struct {
    char* buffer;
    size_t capacity;
    size_t size;
} JsonBuilder;

static JsonBuilder* jb_create(size_t initial_capacity) {
    JsonBuilder* jb = malloc(sizeof(JsonBuilder));
    jb->capacity = initial_capacity;
    jb->size = 0;
    jb->buffer = malloc(initial_capacity);
    return jb;
}

static void jb_append(JsonBuilder* jb, const char* str) {
    if (!str) return;
    size_t len = strlen(str);
    while (jb->size + len >= jb->capacity) {
        jb->capacity *= 2;
        jb->buffer = realloc(jb->buffer, jb->capacity);
    }
    memcpy(jb->buffer + jb->size, str, len);
    jb->size += len;
}

static void jb_append_int(JsonBuilder* jb, int64_t val) {
    char buf[32];
    snprintf(buf, sizeof(buf), "%ld", val);
    jb_append(jb, buf);
}

static void jb_append_float(JsonBuilder* jb, double val) {
    char buf[32];
    snprintf(buf, sizeof(buf), "%.10g", val);
    jb_append(jb, buf);
}

static char* jb_finish(JsonBuilder* jb) {
    jb->buffer[jb->size] = '\0';
    char* result = jb->buffer;
    free(jb);
    return result;
}

// 读取分区文件头
static int read_partition_header(const char* filepath, char* out_json, size_t out_size) {
    FILE* f = fopen(filepath, "rb");
    if (!f) return 0;

    uint8_t header_block[HEADER_BLOCK_SIZE];
    if (fread(header_block, 1, HEADER_BLOCK_SIZE, f) != HEADER_BLOCK_SIZE) {
        fclose(f);
        return 0;
    }

    // 检查 magic
    if (memcmp(header_block, "NDTS", 4) != 0) {
        fclose(f);
        return 0;
    }

    uint32_t header_len = *(uint32_t*)(header_block + 4);
    if (header_len >= out_size) {
        fclose(f);
        return 0;
    }

    memcpy(out_json, header_block + 8, header_len);
    out_json[header_len] = '\0';

    fclose(f);
    return 1;
}

// 从分区文件读取行数
uint32_t ndtsdb_partition_row_count(const char* filepath) {
    char header_json[MAX_JSON_SIZE];
    if (!read_partition_header(filepath, header_json, sizeof(header_json))) {
        return 0;
    }

    // 查找 totalRows
    const char* rows_key = "\"totalRows\":";
    const char* rows_str = strstr(header_json, rows_key);
    if (!rows_str) return 0;

    uint32_t count = 0;
    sscanf(rows_str + strlen(rows_key), "%u", &count);
    return count;
}

// 分区文件信息结构
typedef struct {
    char filepath[512];
    uint32_t totalRows;
} PartitionInfo;

// 返回分区文件的简单 JSON 摘要
char* ndtsdb_partition_info(const char* filepath) {
    JsonBuilder* jb = jb_create(4096);
    jb_append(jb, "{");

    uint32_t row_count = ndtsdb_partition_row_count(filepath);

    jb_append(jb, "\"filepath\":\"");
    jb_append(jb, filepath);
    jb_append(jb, "\",");

    jb_append(jb, "\"totalRows\":");
    jb_append_int(jb, row_count);

    jb_append(jb, "}");

    return jb_finish(jb);
}

// 释放分区信息 JSON
void ndtsdb_free_partition_info(char* json) {
    if (json) free(json);
}

// 简单的分区数据导出（限制行数）
// 返回格式：{"rows":[{col1:val1,col2:val2,...},...], "count":N}
// 注意：此函数为演示目的，不做完整解压
char* ndtsdb_partition_export_json(const char* filepath, uint32_t max_rows) {
    JsonBuilder* jb = jb_create(65536);
    jb_append(jb, "{\"rows\":[],\"count\":");

    uint32_t row_count = ndtsdb_partition_row_count(filepath);
    if (row_count > max_rows) row_count = max_rows;

    jb_append_int(jb, row_count);
    jb_append(jb, "}");

    return jb_finish(jb);
}

void ndtsdb_free_json(char* json) {
    if (json) free(json);
}
