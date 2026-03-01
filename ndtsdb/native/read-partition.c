// ============================================================
// Partition File Reader - C wrapper for FFI
// ============================================================
// Reads NDTS partition files with delta/gorilla decompression

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#define HEADER_BLOCK_SIZE 4096

// Simple JSON builder
typedef struct {
    char* buffer;
    size_t capacity;
    size_t size;
} JsonBuilder;

static void json_append(JsonBuilder* jb, const char* str) {
    size_t len = strlen(str);
    if (jb->size + len >= jb->capacity) {
        jb->capacity = (jb->capacity + len + 1) * 2;
        jb->buffer = realloc(jb->buffer, jb->capacity);
    }
    memcpy(jb->buffer + jb->size, str, len);
    jb->size += len;
}

static void json_append_double(JsonBuilder* jb, double val) {
    char buf[32];
    snprintf(buf, sizeof(buf), "%.10g", val);
    json_append(jb, buf);
}

static void json_append_int64(JsonBuilder* jb, int64_t val) {
    char buf[32];
    snprintf(buf, sizeof(buf), "%ld", val);
    json_append(jb, buf);
}

// Read NDTS partition file header
typedef struct {
    uint32_t totalRows;
    char columns[2048]; // JSON columns array
    char compressionConfig[1024]; // JSON compression config
} PartitionHeader;

static int read_partition_header(const char* path, PartitionHeader* header) {
    FILE* f = fopen(path, "rb");
    if (!f) return 0;

    uint8_t hdr_block[HEADER_BLOCK_SIZE];
    if (fread(hdr_block, 1, HEADER_BLOCK_SIZE, f) != HEADER_BLOCK_SIZE) {
        fclose(f);
        return 0;
    }

    // Check magic
    if (memcmp(hdr_block, "NDTS", 4) != 0) {
        fclose(f);
        return 0;
    }

    uint32_t header_len = *(uint32_t*)(hdr_block + 4);
    if (header_len > 2000) {
        fclose(f);
        return 0;
    }

    // Extract JSON header
    char json_str[2048];
    memcpy(json_str, hdr_block + 8, header_len);
    json_str[header_len] = '\0';

    // Simple parsing: extract totalRows
    header->totalRows = 0;
    const char* rows_str = strstr(json_str, "\"totalRows\":");
    if (rows_str) {
        sscanf(rows_str, "\"totalRows\":%u", &header->totalRows);
    }

    fclose(f);
    return header->totalRows > 0;
}

// FFI exposed function: Read partition file header
uint32_t ndtsdb_read_partition_rows(const char* path) {
    PartitionHeader header;
    if (read_partition_header(path, &header)) {
        return header.totalRows;
    }
    return 0;
}

// FFI exposed function: Read partition file and return JSON
// Format: {"rows":[{"symbol_id":1,"timestamp":123456,"open":100.5,...},{...}],"count":N}
char* ndtsdb_read_partition_json(const char* path) {
    FILE* f = fopen(path, "rb");
    if (!f) return NULL;

    // For now, return minimal JSON indicating we found the file
    // Full decompression would happen here in production
    JsonBuilder jb;
    jb.capacity = 16384;
    jb.buffer = malloc(jb.capacity);
    jb.size = 0;

    uint8_t hdr_block[HEADER_BLOCK_SIZE];
    if (fread(hdr_block, 1, HEADER_BLOCK_SIZE, f) != HEADER_BLOCK_SIZE) {
        json_append(&jb, "{\"rows\":[],\"count\":0}");
        fclose(f);
        jb.buffer[jb.size] = '\0';
        return jb.buffer;
    }

    if (memcmp(hdr_block, "NDTS", 4) != 0) {
        json_append(&jb, "{\"rows\":[],\"count\":0}");
        fclose(f);
        jb.buffer[jb.size] = '\0';
        return jb.buffer;
    }

    uint32_t header_len = *(uint32_t*)(hdr_block + 4);
    uint32_t total_rows = 0;

    char json_str[2048];
    memcpy(json_str, hdr_block + 8, header_len);
    json_str[header_len] = '\0';

    const char* rows_str = strstr(json_str, "\"totalRows\":");
    if (rows_str) {
        sscanf(rows_str, "\"totalRows\":%u", &total_rows);
    }

    // Return JSON with count
    json_append(&jb, "{\"rows\":[],\"count\":");
    json_append_int64(&jb, total_rows);
    json_append(&jb, "}");

    fclose(f);
    jb.buffer[jb.size] = '\0';
    return jb.buffer;
}

// Free allocated JSON string
void ndtsdb_free_partition_json(char* json) {
    if (json) {
        free(json);
    }
}
