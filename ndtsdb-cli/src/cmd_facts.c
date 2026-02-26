// cmd_facts.c - 知识库管理命令
// 存储: 向量 → ndtsdb(.ndtv), 原文 → {database}/facts-text.jsonl
//
// 子命令:
//   write   --database --text <t> --agent-id <id> [--type T] [--validity V] [--scope S] [--key K] [--dim N]
//   import  --database --input <facts.jsonl>   (JSONL每行: {text, agent_id, type, embedding?})
//   list    --database [--agent-id ID]
//   search  --database --query <text> [--top-k N] [--threshold F] [--agent-id ID] [--json] [--dim N]

#include "cmd_facts.h"
#include "cmd_embed.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <math.h>
#include <time.h>
#include "../../ndtsdb/native/ndtsdb.h"
#include "../../ndtsdb/native/ndtsdb_vec.h"
#include "ndtsdb_lock.h"

// ============================================================
// 内存缓存（进程生命周期内有效，避免重复磁盘 IO）
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

static VectorCache g_vec_cache = {0};

static void cache_init(void) {
    g_vec_cache.capacity = 4096;
    g_vec_cache.items = (CachedVector*)calloc(g_vec_cache.capacity, sizeof(CachedVector));
    g_vec_cache.count = 0;
    g_vec_cache.loaded = false;
}

static void cache_clear(void) {
    if (!g_vec_cache.items) return;
    for (int i = 0; i < g_vec_cache.count; i++) {
        free(g_vec_cache.items[i].embedding);
    }
    g_vec_cache.count = 0;
    g_vec_cache.loaded = false;
}

static void cache_add(const VecRecord* rec, const char* scope) {
    if (!g_vec_cache.items) cache_init();
    if (g_vec_cache.count >= g_vec_cache.capacity) {
        // 扩容
        int new_cap = g_vec_cache.capacity * 2;
        CachedVector* new_items = (CachedVector*)realloc(g_vec_cache.items, new_cap * sizeof(CachedVector));
        if (!new_items) return;
        g_vec_cache.items = new_items;
        g_vec_cache.capacity = new_cap;
    }
    CachedVector* cv = &g_vec_cache.items[g_vec_cache.count++];
    cv->dim = rec->embedding_dim;
    cv->ts = rec->timestamp;
    strncpy(cv->agent_id, rec->agent_id, 31); cv->agent_id[31] = '\0';
    strncpy(cv->type, rec->type, 15); cv->type[15] = '\0';
    strncpy(cv->scope, scope, 63); cv->scope[63] = '\0';
    cv->confidence = rec->confidence;
    cv->embedding = (float*)malloc(rec->embedding_dim * sizeof(float));
    if (cv->embedding) {
        memcpy(cv->embedding, rec->embedding, rec->embedding_dim * sizeof(float));
    }
}

// 加载所有 .ndtv 到缓存
static void cache_load_all(const char* database) {
    if (g_vec_cache.loaded && strcmp(g_vec_cache.db_path, database) == 0) return;
    
    cache_clear();
    strncpy(g_vec_cache.db_path, database, 511);
    g_vec_cache.db_path[511] = '\0';
    
    NDTSDB* db = ndtsdb_open(database);
    if (!db) return;
    
    // 枚举所有 scope/type 分区
    char syms[256][32], itvs[256][16];
    int n = ndtsdb_list_symbols(db, syms, itvs, 256);
    
    for (int s = 0; s < n; s++) {
        VecQueryResult* vr = ndtsdb_vec_query(db, syms[s], itvs[s]);
        if (!vr) continue;
        for (uint32_t i = 0; i < vr->count; i++) {
            cache_add(&vr->records[i], syms[s]);
        }
        ndtsdb_vec_free_result(vr);
    }
    
    ndtsdb_close(db);
    g_vec_cache.loaded = true;
}

// ============================================================
// 工具函数
// ============================================================

#define FACTS_TEXT_FILE "facts-text.jsonl"
#define DEFAULT_DIM 64
#define MAX_TEXT 4096
#define MAX_KEY 128
#define MAX_AGENT_ID 64
#define MAX_TYPE 32
#define MAX_VALIDITY 32

static long long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return (long long)ts.tv_sec * 1000LL + ts.tv_nsec / 1000000LL;
}

// 构建 facts-text.jsonl 路径
static void facts_text_path(const char *database, char *out, size_t out_size) {
    snprintf(out, out_size, "%s/%s", database, FACTS_TEXT_FILE);
}

// JSON 字符串转义（最小化，只处理 " \ 换行）
static void json_escape(const char *src, char *dst, size_t dst_size) {
    size_t j = 0;
    for (size_t i = 0; src[i] && j + 4 < dst_size; i++) {
        unsigned char c = (unsigned char)src[i];
        if (c == '"') { dst[j++] = '\\'; dst[j++] = '"'; }
        else if (c == '\\') { dst[j++] = '\\'; dst[j++] = '\\'; }
        else if (c == '\n') { dst[j++] = '\\'; dst[j++] = 'n'; }
        else if (c == '\r') { dst[j++] = '\\'; dst[j++] = 'r'; }
        else if (c == '\t') { dst[j++] = '\\'; dst[j++] = 't'; }
        else { dst[j++] = (char)c; }
    }
    dst[j] = '\0';
}

// 将 text 记录追加写入 sidecar JSONL
static int text_index_append(const char *database, long long ts,
                              const char *agent_id, const char *type,
                              const char *validity, const char *scope,
                              const char *key, const char *text) {
    char path[1024];
    facts_text_path(database, path, sizeof(path));

    FILE *fp = fopen(path, "a");
    if (!fp) {
        fprintf(stderr, "Error: cannot open %s for writing\n", path);
        return -1;
    }

    char esc_text[MAX_TEXT * 2];
    char esc_key[MAX_KEY * 2];
    char esc_agent[MAX_AGENT_ID * 2];
    json_escape(text, esc_text, sizeof(esc_text));
    json_escape(key[0] ? key : "", esc_key, sizeof(esc_key));
    json_escape(agent_id, esc_agent, sizeof(esc_agent));

    fprintf(fp,
        "{\"ts\":%lld,\"agent_id\":\"%s\",\"type\":\"%s\","
        "\"validity\":\"%s\",\"scope\":\"%s\","
        "\"key\":\"%s\",\"text\":\"%s\"}\n",
        ts, esc_agent, type, validity, scope, esc_key, esc_text);

    fclose(fp);
    return 0;
}

// 从 sidecar JSONL 按 ts 查找 text（简单线性扫描）
static int text_index_find(const char *database, long long ts, char *text_out, size_t text_size) {
    char path[1024];
    facts_text_path(database, path, sizeof(path));

    FILE *fp = fopen(path, "r");
    if (!fp) return -1;

    char line[MAX_TEXT * 3];
    char ts_str[32];
    snprintf(ts_str, sizeof(ts_str), "\"ts\":%lld,", ts);

    while (fgets(line, sizeof(line), fp)) {
        if (!strstr(line, ts_str)) continue;

        // 找 "text":"..." 字段
        char *tp = strstr(line, "\"text\":\"");
        if (!tp) continue;
        tp += 8;  // skip "text":"

        size_t j = 0;
        bool esc = false;
        while (*tp && j + 1 < text_size) {
            if (esc) {
                if (*tp == 'n') text_out[j++] = '\n';
                else if (*tp == 't') text_out[j++] = '\t';
                else text_out[j++] = *tp;
                esc = false;
            } else if (*tp == '\\') {
                esc = true;
            } else if (*tp == '"') {
                break;
            } else {
                text_out[j++] = *tp;
            }
            tp++;
        }
        text_out[j] = '\0';
        fclose(fp);
        return 0;
    }

    fclose(fp);
    return -1;
}

// ============================================================
// facts write
// ============================================================

static int cmd_facts_write(int argc, char **argv) {
    const char *database = NULL;
    const char *text = NULL;
    const char *agent_id = "shared";
    const char *type = "semantic";
    const char *validity = "mutable";
    const char *scope = "shared";
    const char *key = "";
    const char *embed_vector_str = NULL;  // pre-computed vector "[f1,f2,...]"
    int dim = DEFAULT_DIM;
    int help_flag = 0;

    for (int i = 3; i < argc; i++) {
        if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            help_flag = 1;
        } else if ((strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) && i + 1 < argc) {
            database = argv[++i];
        } else if (strcmp(argv[i], "--text") == 0 && i + 1 < argc) {
            text = argv[++i];
        } else if (strcmp(argv[i], "--agent-id") == 0 && i + 1 < argc) {
            agent_id = argv[++i];
        } else if (strcmp(argv[i], "--type") == 0 && i + 1 < argc) {
            type = argv[++i];
        } else if (strcmp(argv[i], "--validity") == 0 && i + 1 < argc) {
            validity = argv[++i];
        } else if (strcmp(argv[i], "--scope") == 0 && i + 1 < argc) {
            scope = argv[++i];
        } else if (strcmp(argv[i], "--key") == 0 && i + 1 < argc) {
            key = argv[++i];
        } else if (strcmp(argv[i], "--dim") == 0 && i + 1 < argc) {
            dim = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--embed-vector") == 0 && i + 1 < argc) {
            embed_vector_str = argv[++i];
        }
    }

    if (help_flag) {
        printf("Usage: ndtsdb-cli facts write --database <path> --text <text> --agent-id <id>\n");
        printf("       [--type semantic|episodic|procedural] [--validity permanent|mutable|transient]\n");
        printf("       [--scope shared|bot-xxx|...] [--key <dedup-key>] [--dim N (default 64)]\n");
        printf("       [--embed-vector '[f1,f2,...]'  pre-computed embedding (skips local TF-IDF)]\n");
        printf("\n  Writes text + embedding to knowledge database.\n");
        printf("  Vector stored in ndtsdb (.ndtv), text stored in facts-text.jsonl sidecar.\n");
        return 0;
    }

    if (!database || !text) {
        fprintf(stderr, "Error: --database and --text are required\n");
        return 1;
    }
    if (dim <= 0 || dim > 2048) {
        fprintf(stderr, "Error: --dim must be 1-2048\n");
        return 1;
    }

    // 生成或解析 embedding
    float *embedding = (float *)malloc(dim * sizeof(float));
    if (!embedding) {
        fprintf(stderr, "Error: out of memory\n");
        return 1;
    }

    if (embed_vector_str) {
        // 解析预计算向量 "[f1,f2,...]"
        const char *p = strchr(embed_vector_str, '[');
        if (!p) { fprintf(stderr, "Error: --embed-vector must be '[f1,f2,...]'\n"); free(embedding); return 1; }
        p++;
        int parsed_dim = 0;
        while (*p && *p != ']' && parsed_dim < dim) {
            char *end;
            float v = strtof(p, &end);
            if (end == p) { p++; continue; }
            embedding[parsed_dim++] = v;
            p = end;
            while (*p == ' ' || *p == ',') p++;
        }
        if (parsed_dim != dim) {
            fprintf(stderr, "Error: --embed-vector has %d values, expected --dim=%d\n", parsed_dim, dim);
            free(embedding);
            return 1;
        }
    } else {
        // 本地 TF-IDF 生成（fallback）
        if (embed_generate(text, embedding, dim) != 0) {
            fprintf(stderr, "Error: embedding generation failed\n");
            free(embedding);
            return 1;
        }
    }

    long long ts = now_ms();

    // 写入 ndtsdb vector
    int lock_fd = ndtsdb_lock_acquire(database, true);
    if (lock_fd < 0) {
        fprintf(stderr, "Error: cannot acquire database lock\n");
        free(embedding);
        return 1;
    }

    NDTSDB *db = ndtsdb_open(database);
    if (!db) {
        ndtsdb_lock_release(lock_fd);
        free(embedding);
        fprintf(stderr, "Error: cannot open database: %s\n", database);
        return 1;
    }

    VecRecord vrec;
    vrec.timestamp = ts;
    strncpy(vrec.agent_id, agent_id, 31); vrec.agent_id[31] = '\0';
    strncpy(vrec.type, type, 15);         vrec.type[15] = '\0';
    vrec.confidence = (strcmp(validity, "permanent") == 0) ? 1.0f :
                      (strcmp(validity, "mutable") == 0)   ? 0.8f : 0.5f;
    vrec.embedding_dim = dim;
    vrec.embedding = embedding;

    // symbol = scope, interval = type（与ndtsdb存储键一致）
    int ok = ndtsdb_vec_insert(db, scope, type, &vrec);
    ndtsdb_close(db);
    ndtsdb_lock_release(lock_fd);
    free(embedding);

    if (ok != 0) {
        fprintf(stderr, "Error: ndtsdb_vec_insert failed\n");
        return 1;
    }

    // 写入 text sidecar
    if (text_index_append(database, ts, agent_id, type, validity, scope, key, text) != 0) {
        fprintf(stderr, "Warning: vector written but text index failed\n");
        return 1;
    }

    printf("{\"ok\":true,\"ts\":%lld,\"agent_id\":\"%s\",\"scope\":\"%s\",\"type\":\"%s\",\"dim\":%d}\n",
           ts, agent_id, scope, type, dim);
    return 0;
}

// ============================================================
// facts import (JSONL: {text, agent_id, type?, embedding?})
// ============================================================

static int cmd_facts_import(int argc, char **argv) {
    const char *database = NULL;
    const char *input = NULL;
    int dim = DEFAULT_DIM;
    int help_flag = 0;

    for (int i = 3; i < argc; i++) {
        if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            help_flag = 1;
        } else if ((strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) && i + 1 < argc) {
            database = argv[++i];
        } else if ((strcmp(argv[i], "--input") == 0 || strcmp(argv[i], "-i") == 0) && i + 1 < argc) {
            input = argv[++i];
        } else if (strcmp(argv[i], "--dim") == 0 && i + 1 < argc) {
            dim = atoi(argv[++i]);
        }
    }

    if (help_flag) {
        printf("Usage: ndtsdb-cli facts import --database <path> --input <facts.jsonl> [--dim N]\n");
        printf("  JSONL format: {\"text\":\"...\",\"agent_id\":\"bot-006\",\"type\":\"semantic\",\"scope\":\"bot-006\"}\n");
        printf("  Optional: provide pre-computed \"embedding\":[...] to skip local generation.\n");
        return 0;
    }

    if (!database || !input) {
        fprintf(stderr, "Error: --database and --input are required\n");
        return 1;
    }

    int lock_fd = ndtsdb_lock_acquire(database, true);
    if (lock_fd < 0) {
        fprintf(stderr, "Error: cannot acquire database lock\n");
        return 1;
    }

    NDTSDB *db = ndtsdb_open(database);
    if (!db) {
        ndtsdb_lock_release(lock_fd);
        fprintf(stderr, "Error: cannot open database: %s\n", database);
        return 1;
    }

    FILE *fp = fopen(input, "r");
    if (!fp) {
        ndtsdb_close(db);
        ndtsdb_lock_release(lock_fd);
        fprintf(stderr, "Error: cannot open input file: %s\n", input);
        return 1;
    }

    int imported = 0, errors = 0;
    char line[MAX_TEXT * 3];

    while (fgets(line, sizeof(line), fp)) {
        if (line[0] == '\n' || line[0] == '\0') continue;

        // 提取 text
        char text_val[MAX_TEXT] = "";
        char *tp = strstr(line, "\"text\":\"");
        if (tp) {
            tp += 8;
            size_t j = 0;
            bool esc = false;
            while (*tp && j + 1 < sizeof(text_val)) {
                if (esc) {
                    if (*tp == 'n') text_val[j++] = '\n';
                    else if (*tp == 't') text_val[j++] = '\t';
                    else text_val[j++] = *tp;
                    esc = false;
                } else if (*tp == '\\') { esc = true; }
                else if (*tp == '"') { break; }
                else { text_val[j++] = *tp; }
                tp++;
            }
            text_val[j] = '\0';
        }

        // 提取 agent_id
        char agent_val[MAX_AGENT_ID] = "shared";
        char *ap = strstr(line, "\"agent_id\":\"");
        if (ap) {
            ap += 12;
            size_t j = 0;
            while (*ap && *ap != '"' && j + 1 < sizeof(agent_val)) agent_val[j++] = *ap++;
            agent_val[j] = '\0';
        }

        // 提取 type
        char type_val[MAX_TYPE] = "semantic";
        char *xp = strstr(line, "\"type\":\"");
        if (xp) {
            xp += 8;
            size_t j = 0;
            while (*xp && *xp != '"' && j + 1 < sizeof(type_val)) type_val[j++] = *xp++;
            type_val[j] = '\0';
        }

        // 提取 scope
        char scope_val[MAX_AGENT_ID] = "shared";
        char *sp = strstr(line, "\"scope\":\"");
        if (sp) {
            sp += 9;
            size_t j = 0;
            while (*sp && *sp != '"' && j + 1 < sizeof(scope_val)) scope_val[j++] = *sp++;
            scope_val[j] = '\0';
        }

        // 提取 validity
        char validity_val[MAX_VALIDITY] = "mutable";
        char *vp = strstr(line, "\"validity\":\"");
        if (vp) {
            vp += 12;
            size_t j = 0;
            while (*vp && *vp != '"' && j + 1 < sizeof(validity_val)) validity_val[j++] = *vp++;
            validity_val[j] = '\0';
        }

        // 提取 key
        char key_val[MAX_KEY] = "";
        char *kp = strstr(line, "\"key\":\"");
        if (kp) {
            kp += 7;
            size_t j = 0;
            while (*kp && *kp != '"' && j + 1 < sizeof(key_val)) key_val[j++] = *kp++;
            key_val[j] = '\0';
        }

        // 尝试提取预计算 embedding
        float embedding[2048];
        int emb_dim = 0;
        char *ep = strstr(line, "\"embedding\":");
        if (ep) {
            ep = strchr(ep, '[');
            if (ep) {
                ep++;
                while (*ep && *ep != ']' && emb_dim < 2048) {
                    char *end;
                    float v = strtof(ep, &end);
                    if (end == ep) { ep++; continue; }
                    embedding[emb_dim++] = v;
                    ep = end;
                    while (*ep == ' ' || *ep == ',') ep++;
                }
            }
        }

        // 如果没有预计算 embedding，用本地生成（需要 text）
        if (emb_dim == 0) {
            if (text_val[0] == '\0') { errors++; continue; }
            float *emb = (float *)malloc(dim * sizeof(float));
            if (!emb) { errors++; continue; }
            if (embed_generate(text_val, emb, dim) != 0) { free(emb); errors++; continue; }
            memcpy(embedding, emb, dim * sizeof(float));
            emb_dim = dim;
            free(emb);
        }

        long long ts = now_ms() + imported;  // 确保唯一

        VecRecord vrec;
        vrec.timestamp = ts;
        strncpy(vrec.agent_id, agent_val, 31); vrec.agent_id[31] = '\0';
        strncpy(vrec.type, type_val, 15);      vrec.type[15] = '\0';
        vrec.confidence = (strcmp(validity_val, "permanent") == 0) ? 1.0f :
                          (strcmp(validity_val, "mutable") == 0)   ? 0.8f : 0.5f;
        vrec.embedding_dim = emb_dim;
        vrec.embedding = embedding;

        if (ndtsdb_vec_insert(db, scope_val, type_val, &vrec) == 0) {
            if (text_val[0] != '\0') {
                text_index_append(database, ts, agent_val, type_val,
                                  validity_val, scope_val, key_val, text_val);
            }
            imported++;
        } else {
            errors++;
        }
    }

    fclose(fp);
    ndtsdb_close(db);
    ndtsdb_lock_release(lock_fd);

    printf("{\"imported\":%d,\"errors\":%d}\n", imported, errors);
    return errors > 0 ? 1 : 0;
}

// ============================================================
// facts list
// ============================================================

static int cmd_facts_list(int argc, char **argv) {
    const char *database = NULL;
    const char *agent_filter = NULL;
    int help_flag = 0;

    for (int i = 3; i < argc; i++) {
        if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            help_flag = 1;
        } else if ((strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) && i + 1 < argc) {
            database = argv[++i];
        } else if (strcmp(argv[i], "--agent-id") == 0 && i + 1 < argc) {
            agent_filter = argv[++i];
        }
    }

    if (help_flag) {
        printf("Usage: ndtsdb-cli facts list --database <path> [--agent-id ID]\n");
        return 0;
    }
    if (!database) { fprintf(stderr, "Error: --database is required\n"); return 1; }

    // 读 text sidecar
    char path[1024];
    facts_text_path(database, path, sizeof(path));

    FILE *fp = fopen(path, "r");
    if (!fp) {
        printf("No facts found (sidecar missing: %s)\n", path);
        return 0;
    }

    char line[MAX_TEXT * 3];
    int count = 0;
    while (fgets(line, sizeof(line), fp)) {
        if (line[0] == '\n') continue;

        // 过滤 agent_id
        if (agent_filter) {
            char needle[MAX_AGENT_ID + 20];
            snprintf(needle, sizeof(needle), "\"agent_id\":\"%s\"", agent_filter);
            if (!strstr(line, needle)) continue;
        }

        // 提取 ts
        long long ts = 0;
        char *tp = strstr(line, "\"ts\":");
        if (tp) ts = atoll(tp + 5);

        // 提取 agent_id
        char agent_val[MAX_AGENT_ID] = "";
        char *ap = strstr(line, "\"agent_id\":\"");
        if (ap) { ap += 12; size_t j=0; while(*ap&&*ap!='"'&&j+1<sizeof(agent_val)) agent_val[j++]=*ap++; agent_val[j]='\0'; }

        // 提取 type
        char type_val[MAX_TYPE] = "";
        char *xp = strstr(line, "\"type\":\"");
        if (xp) { xp += 8; size_t j=0; while(*xp&&*xp!='"'&&j+1<sizeof(type_val)) type_val[j++]=*xp++; type_val[j]='\0'; }

        // 提取 key
        char key_val[MAX_KEY] = "";
        char *kp = strstr(line, "\"key\":\"");
        if (kp) { kp += 7; size_t j=0; while(*kp&&*kp!='"'&&j+1<sizeof(key_val)) key_val[j++]=*kp++; key_val[j]='\0'; }

        // 提取 text（截断显示）
        char text_val[MAX_TEXT] = "";
        char *tep = strstr(line, "\"text\":\"");
        if (tep) {
            tep += 8;
            size_t j = 0;
            bool esc = false;
            while (*tep && j + 1 < sizeof(text_val)) {
                if (esc) { if(*tep=='n') text_val[j++]='\n'; else text_val[j++]=*tep; esc=false; }
                else if (*tep == '\\') { esc=true; }
                else if (*tep == '"') break;
                else text_val[j++] = *tep;
                tep++;
            }
            text_val[j] = '\0';
        }

        // 截断显示
        char preview[81] = "";
        strncpy(preview, text_val, 80);
        preview[80] = '\0';
        if (strlen(text_val) > 80) strcat(preview, "…");

        printf("[%d] ts=%lld agent=%s type=%s", ++count, ts, agent_val, type_val);
        if (key_val[0]) printf(" key=%s", key_val);
        printf("\n    %s\n", preview);
    }

    fclose(fp);
    printf("\nTotal: %d facts\n", count);
    return 0;
}

// ============================================================
// facts search
// ============================================================

typedef struct { long long ts; float sim; char agent_id[32]; char type[16]; } Hit;

static int hit_compare_desc(const void *a, const void *b) {
    const Hit *ha = (const Hit *)a;
    const Hit *hb = (const Hit *)b;
    if (hb->sim > ha->sim) return 1;
    if (hb->sim < ha->sim) return -1;
    return 0;
}

static int cmd_facts_search(int argc, char **argv) {
    const char *database = NULL;
    const char *query_text = NULL;
    const char *query_vector_str = NULL;
    const char *agent_filter = NULL;
    int top_k = 5;
    float threshold = 0.0f;
    int dim = DEFAULT_DIM;
    bool json_output = false;
    int help_flag = 0;

    for (int i = 3; i < argc; i++) {
        if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            help_flag = 1;
        } else if ((strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) && i + 1 < argc) {
            database = argv[++i];
        } else if (strcmp(argv[i], "--query") == 0 && i + 1 < argc) {
            query_text = argv[++i];
        } else if (strcmp(argv[i], "--query-vector") == 0 && i + 1 < argc) {
            query_vector_str = argv[++i];
        } else if (strcmp(argv[i], "--agent-id") == 0 && i + 1 < argc) {
            agent_filter = argv[++i];
        } else if ((strcmp(argv[i], "--top-k") == 0 || strcmp(argv[i], "-k") == 0) && i + 1 < argc) {
            top_k = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--threshold") == 0 && i + 1 < argc) {
            threshold = (float)atof(argv[++i]);
        } else if (strcmp(argv[i], "--dim") == 0 && i + 1 < argc) {
            dim = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--json") == 0) {
            json_output = true;
        }
    }

    if (help_flag) {
        printf("Usage: ndtsdb-cli facts search --database <path> --query <text> [options]\n");
        printf("       OR --query-vector '[f1,f2,...]' for raw vector search\n");
        printf("  --top-k N         Return top N results (default 5)\n");
        printf("  --threshold F     Minimum similarity score 0.0-1.0 (default 0.0)\n");
        printf("  --agent-id ID     Filter by agent\n");
        printf("  --dim N           Embedding dimensions for --query (default 64)\n");
        printf("  --json            Output JSON array\n");
        return 0;
    }

    if (!database) { fprintf(stderr, "Error: --database is required\n"); return 1; }
    if (!query_text && !query_vector_str) {
        fprintf(stderr, "Error: --query or --query-vector is required\n");
        return 1;
    }

    // 构建查询向量
    float query_vec[2048];
    int query_dim = 0;

    if (query_text) {
        if (dim <= 0 || dim > 2048) { fprintf(stderr, "Error: --dim must be 1-2048\n"); return 1; }
        float *emb = (float *)malloc(dim * sizeof(float));
        if (!emb) { fprintf(stderr, "Error: out of memory\n"); return 1; }
        if (embed_generate(query_text, emb, dim) != 0) {
            free(emb); fprintf(stderr, "Error: embedding failed\n"); return 1;
        }
        memcpy(query_vec, emb, dim * sizeof(float));
        query_dim = dim;
        free(emb);
    } else {
        // 解析 --query-vector '[...]'
        const char *p = strchr(query_vector_str, '[');
        if (!p) { fprintf(stderr, "Error: --query-vector must be '[f1,f2,...]'\n"); return 1; }
        p++;
        while (*p && *p != ']' && query_dim < 2048) {
            char *end;
            float v = strtof(p, &end);
            if (end == p) { p++; continue; }
            query_vec[query_dim++] = v;
            p = end;
            while (*p == ' ' || *p == ',') p++;
        }
        if (query_dim == 0) { fprintf(stderr, "Error: empty query vector\n"); return 1; }
    }

    // 打开 ndtsdb，扫描所有 scope/type 分区
    int lock_fd = ndtsdb_lock_acquire(database, false);
    if (lock_fd < 0) { fprintf(stderr, "Error: cannot acquire lock\n"); return 1; }

    NDTSDB *db = ndtsdb_open(database);
    if (!db) {
        ndtsdb_lock_release(lock_fd);
        fprintf(stderr, "Error: cannot open database: %s\n", database);
        return 1;
    }

    // 使用内存缓存进行搜索
    cache_load_all(database);
    
    Hit hits[4096];
    int hit_count = 0;
    
    for (int i = 0; i < g_vec_cache.count && hit_count < 4096; i++) {
        CachedVector* cv = &g_vec_cache.items[i];
        if (cv->dim != query_dim) continue;
        
        // 过滤 agent（这里 scope 对应 agent namespace）
        if (agent_filter && strcmp(cv->scope, agent_filter) != 0) continue;
        
        float dot = 0, nq = 0, nr = 0;
        for (int j = 0; j < query_dim; j++) {
            dot += query_vec[j] * cv->embedding[j];
            nq  += query_vec[j] * query_vec[j];
            nr  += cv->embedding[j] * cv->embedding[j];
        }
        float sim = (nq > 0 && nr > 0) ? dot / (sqrtf(nq) * sqrtf(nr)) : 0.0f;
        if (sim < threshold) continue;
        
        hits[hit_count].ts  = cv->ts;
        hits[hit_count].sim = sim;
        strncpy(hits[hit_count].agent_id, cv->agent_id, 31); hits[hit_count].agent_id[31]='\0';
        strncpy(hits[hit_count].type, cv->type, 15);          hits[hit_count].type[15]='\0';
        hit_count++;
    }

    ndtsdb_lock_release(lock_fd);

    // 排序（按相似度降序）
    if (hit_count > 1) {
        qsort(hits, hit_count, sizeof(Hit), hit_compare_desc);
    }
    if (hit_count > top_k) hit_count = top_k;

    // 输出
    if (json_output) {
        printf("[\n");
        for (int i = 0; i < hit_count; i++) {
            char text_val[MAX_TEXT] = "";
            text_index_find(database, hits[i].ts, text_val, sizeof(text_val));

            char esc[MAX_TEXT * 2];
            json_escape(text_val, esc, sizeof(esc));

            if (i > 0) printf(",\n");
            printf("  {\"rank\":%d,\"similarity\":%.4f,\"agent_id\":\"%s\",\"type\":\"%s\","
                   "\"ts\":%lld,\"text\":\"%s\"}",
                   i+1, hits[i].sim, hits[i].agent_id, hits[i].type, hits[i].ts, esc);
        }
        printf("\n]\n");
    } else {
        printf("Top %d results (query_dim=%d):\n\n", hit_count, query_dim);
        for (int i = 0; i < hit_count; i++) {
            char text_val[MAX_TEXT] = "";
            text_index_find(database, hits[i].ts, text_val, sizeof(text_val));

            printf("[%d] %.4f  %s / %s  (ts=%lld)\n",
                   i+1, hits[i].sim, hits[i].agent_id, hits[i].type, hits[i].ts);
            if (text_val[0]) printf("    %s\n", text_val);
            printf("\n");
        }
        if (hit_count == 0) printf("No results found.\n");
    }

    return 0;
}

// ============================================================
// 入口
// ============================================================

int cmd_facts(int argc, char **argv) {
    if (argc < 3 || strcmp(argv[2], "--help") == 0 || strcmp(argv[2], "-h") == 0) {
        printf("Usage: ndtsdb-cli facts <command> [options]\n\n");
        printf("Commands:\n");
        printf("  write    Write a text entry (generates embedding locally)\n");
        printf("  import   Batch import from JSONL file\n");
        printf("  list     List all facts [--agent-id ID]\n");
        printf("  search   Semantic search by text query or raw vector\n\n");
        printf("Use 'ndtsdb-cli facts <command> --help' for details.\n");
        return argc < 3 ? 1 : 0;
    }

    if (strcmp(argv[2], "write")  == 0) return cmd_facts_write(argc, argv);
    if (strcmp(argv[2], "import") == 0) return cmd_facts_import(argc, argv);
    if (strcmp(argv[2], "list")   == 0) return cmd_facts_list(argc, argv);
    if (strcmp(argv[2], "search") == 0) return cmd_facts_search(argc, argv);

    fprintf(stderr, "Error: unknown facts command: %s\n", argv[2]);
    fprintf(stderr, "Run 'ndtsdb-cli facts --help' for available commands.\n");
    return 1;
}
