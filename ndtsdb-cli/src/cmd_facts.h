// cmd_facts.h - 知识库管理命令
#ifndef CMD_FACTS_H
#define CMD_FACTS_H

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

// ============================================================
// 共享类型定义
// ============================================================

typedef struct {
    float* embedding;
    uint16_t dim;
    int64_t ts;
    char agent_id[32];
    char type[16];
    char scope[64];
    float confidence;
} CachedVector;

typedef struct {
    CachedVector* items;
    int count;
    int capacity;
    char db_path[512];
    bool loaded;
} VectorCache;

// 全局缓存（用于搜索加速）
extern VectorCache g_vec_cache;

// ============================================================
// 共享函数
// ============================================================

void cache_init(void);
void cache_clear(void);
void cache_load_all(const char* database);
int text_index_find(const char *database, long long ts, char *text_out, size_t text_size);

// ============================================================
// 子命令
// ============================================================

int cmd_facts(int argc, char **argv);
int cmd_facts_decay_search(int argc, char **argv);
int cmd_facts_dedup(int argc, char **argv);
int cmd_facts_archive(int argc, char **argv);

#endif // CMD_FACTS_H