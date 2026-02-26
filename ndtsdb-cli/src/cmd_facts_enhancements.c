// cmd_facts_enhancements.c - facts 命令增强模块
// time_decay, dedup, archive 功能实现

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <math.h>
#include <time.h>
#include "cmd_facts.h"
#include "cmd_embed.h"
#include "ndtsdb_lock.h"
#include "../../ndtsdb/native/ndtsdb.h"
#include "../../ndtsdb/native/ndtsdb_vec.h"

#define MAX_TEXT 4096
#define MAX_AGENT_ID 64
#define MAX_TYPE 32
#define MAX_KEY 128

// ============================================================
// 时间衰减工具函数
// ============================================================

/**
 * 计算时间衰减因子
 * @param ts 记录时间戳 (毫秒)
 * @param half_life_ms 半衰期 (毫秒)
 * @return 衰减因子 (0.0 - 1.0)
 */
static float time_decay_factor(long long ts, long long half_life_ms) {
    if (half_life_ms <= 0) return 1.0f;
    
    long long now_ms = (long long)time(NULL) * 1000LL;
    long long age_ms = now_ms - ts;
    if (age_ms < 0) age_ms = 0;
    
    // 衰减公式: exp(-ln(2) * age / half_life)
    double lambda = log(2.0) / (double)half_life_ms;
    return (float)exp(-lambda * (double)age_ms);
}

/**
 * 解析时间字符串为毫秒
 * 支持: 7d, 24h, 3600s, 或纯数字(毫秒)
 */
static long long parse_duration_ms(const char* str) {
    if (!str || !*str) return 0;
    
    char* end;
    double val = strtod(str, &end);
    if (end == str) return 0;
    
    if (*end == 'd' || *end == 'D') return (long long)(val * 24 * 3600 * 1000);
    if (*end == 'h' || *end == 'H') return (long long)(val * 3600 * 1000);
    if (*end == 'm' || *end == 'M') {
        // 判断是分钟还是月
        if (*(end+1) == 'o' || *(end+1) == 'O') return (long long)(val * 30 * 24 * 3600 * 1000); // 月
        return (long long)(val * 60 * 1000); // 分钟
    }
    if (*end == 's' || *end == 'S') return (long long)(val * 1000);
    
    // 纯数字，假设是毫秒
    return (long long)val;
}

// ============================================================
// facts search --decay (时间衰减搜索)
// ============================================================

typedef struct {
    long long ts;
    float sim;
    float decayed_score;
    char agent_id[32];
    char type[16];
} DecayHit;

static int decay_hit_compare_desc(const void *a, const void *b) {
    const DecayHit *ha = (const DecayHit *)a;
    const DecayHit *hb = (const DecayHit *)b;
    if (hb->decayed_score > ha->decayed_score) return 1;
    if (hb->decayed_score < ha->decayed_score) return -1;
    return 0;
}

/**
 * 带时间衰减的搜索
 * 用法: facts decay --database <path> --query <text> --half-life 7d
 */
int cmd_facts_decay_search(int argc, char **argv) {
    const char *database = NULL;
    const char *query_text = NULL;
    const char *query_vector_str = NULL;
    const char *agent_filter = NULL;
    const char *half_life_str = "7d";  // 默认7天
    const char *validity_filter = NULL;
    int top_k = 5;
    float threshold = 0.0f;
    int dim = 64;
    bool json_output = false;
    bool show_raw_score = false;
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
        } else if (strcmp(argv[i], "--half-life") == 0 && i + 1 < argc) {
            half_life_str = argv[++i];
        } else if (strcmp(argv[i], "--validity") == 0 && i + 1 < argc) {
            validity_filter = argv[++i];
        } else if ((strcmp(argv[i], "--top-k") == 0 || strcmp(argv[i], "-k") == 0) && i + 1 < argc) {
            top_k = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--threshold") == 0 && i + 1 < argc) {
            threshold = (float)atof(argv[++i]);
        } else if (strcmp(argv[i], "--dim") == 0 && i + 1 < argc) {
            dim = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--json") == 0) {
            json_output = true;
        } else if (strcmp(argv[i], "--show-raw") == 0) {
            show_raw_score = true;
        }
    }

    if (help_flag) {
        printf("Usage: ndtsdb-cli facts decay --database <path> --query <text> [options]\n");
        printf("  Semantic search with time decay (recency boost)\n\n");
        printf("Options:\n");
        printf("  --half-life T     Time decay half-life (default: 7d)\n");
        printf("                    Format: 7d, 24h, 3600s, or milliseconds\n");
        printf("  --validity V      Filter by validity: permanent/mutable/transient/expired\n");
        printf("  --show-raw        Show both similarity and decayed score\n");
        printf("  --top-k N         Return top N results (default 5)\n");
        printf("  --threshold F     Minimum similarity before decay (default 0.0)\n");
        printf("  --json            Output JSON array\n");
        printf("\nExample:\n");
        printf("  ndtsdb-cli facts decay -d ./kb -q \"策略\" --half-life 7d -k 10\n");
        return 0;
    }

    if (!database) { fprintf(stderr, "Error: --database is required\n"); return 1; }
    if (!query_text && !query_vector_str) {
        fprintf(stderr, "Error: --query or --query-vector is required\n"); return 1;
    }

    // 解析半衰期
    long long half_life_ms = parse_duration_ms(half_life_str);
    if (half_life_ms <= 0) {
        fprintf(stderr, "Error: invalid half-life: %s\n", half_life_str);
        return 1;
    }

    // 构建查询向量
    float query_vec[2048];
    int query_dim = 0;

    if (query_text) {
        float *emb = (float *)malloc(dim * sizeof(float));
        if (!emb) { fprintf(stderr, "Error: out of memory\n"); return 1; }
        if (embed_generate(query_text, emb, dim) != 0) {
            free(emb); fprintf(stderr, "Error: embedding failed\n"); return 1;
        }
        memcpy(query_vec, emb, dim * sizeof(float));
        query_dim = dim;
        free(emb);
    } else {
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
    }

    // 加载缓存
    int lock_fd = ndtsdb_lock_acquire(database, false);
    if (lock_fd < 0) { fprintf(stderr, "Error: cannot acquire lock\n"); return 1; }

    NDTSDB *db = ndtsdb_open(database);
    if (!db) {
        ndtsdb_lock_release(lock_fd);
        fprintf(stderr, "Error: cannot open database\n"); return 1;
    }

    cache_load_all(database);
    
    DecayHit hits[4096];
    int hit_count = 0;
    
    for (int i = 0; i < g_vec_cache.count && hit_count < 4096; i++) {
        CachedVector* cv = &g_vec_cache.items[i];
        if (cv->dim != query_dim) continue;
        if (agent_filter && strcmp(cv->scope, agent_filter) != 0) continue;

        // 计算余弦相似度
        float dot = 0, nq = 0, nr = 0;
        for (int j = 0; j < query_dim; j++) {
            dot += query_vec[j] * cv->embedding[j];
            nq  += query_vec[j] * query_vec[j];
            nr  += cv->embedding[j] * cv->embedding[j];
        }
        float sim = (nq > 0 && nr > 0) ? dot / (sqrtf(nq) * sqrtf(nr)) : 0.0f;
        if (sim < threshold) continue;

        // 计算时间衰减
        float decay = time_decay_factor(cv->ts, half_life_ms);
        float score = sim * decay;

        hits[hit_count].ts = cv->ts;
        hits[hit_count].sim = sim;
        hits[hit_count].decayed_score = score;
        strncpy(hits[hit_count].agent_id, cv->agent_id, 31);
        hits[hit_count].agent_id[31] = '\0';
        strncpy(hits[hit_count].type, cv->type, 15);
        hits[hit_count].type[15] = '\0';
        hit_count++;
    }

    ndtsdb_close(db);
    ndtsdb_lock_release(lock_fd);

    // 按衰减后得分排序
    if (hit_count > 1) {
        qsort(hits, hit_count, sizeof(DecayHit), decay_hit_compare_desc);
    }
    if (hit_count > top_k) hit_count = top_k;

    // 输出
    if (json_output) {
        printf("[\n");
        for (int i = 0; i < hit_count; i++) {
            char text_val[MAX_TEXT] = "";
            text_index_find(database, hits[i].ts, text_val, sizeof(text_val));

            if (i > 0) printf(",\n");
            printf("  {\"rank\":%d,\"decayed_score\":%.4f", i+1, hits[i].decayed_score);
            if (show_raw_score) printf(",\"similarity\":%.4f", hits[i].sim);
            printf(",\"agent_id\":\"%s\",\"type\":\"%s\",\"ts\":%lld}",
                   hits[i].agent_id, hits[i].type, hits[i].ts);
        }
        printf("\n]\n");
    } else {
        printf("Top %d results (half-life=%s, decayed_score):\n\n", hit_count, half_life_str);
        for (int i = 0; i < hit_count; i++) {
            printf("[%d] %.4f", i+1, hits[i].decayed_score);
            if (show_raw_score) printf(" (sim=%.4f)", hits[i].sim);
            printf("  %s / %s  (ts=%lld)\n", hits[i].agent_id, hits[i].type, hits[i].ts);
        }
    }

    return 0;
}

// ============================================================
// facts dedup (查重/去重)
// ============================================================

typedef struct {
    int idx1, idx2;
    float similarity;
} DupPair;

static int dup_pair_compare_desc(const void *a, const void *b) {
    const DupPair *pa = (const DupPair *)a;
    const DupPair *pb = (const DupPair *)b;
    if (pb->similarity > pa->similarity) return 1;
    if (pb->similarity < pa->similarity) return -1;
    return 0;
}

/**
 * 查重/去重
 * 用法: facts dedup --database <path> --threshold 0.95 [--dry-run]
 */
int cmd_facts_dedup(int argc, char **argv) {
    const char *database = NULL;
    const char *agent_filter = NULL;
    float threshold = 0.95f;
    bool dry_run = false;
    int top_n = 20;
    bool json_output = false;
    int help_flag = 0;

    for (int i = 3; i < argc; i++) {
        if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            help_flag = 1;
        } else if ((strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) && i + 1 < argc) {
            database = argv[++i];
        } else if (strcmp(argv[i], "--agent-id") == 0 && i + 1 < argc) {
            agent_filter = argv[++i];
        } else if (strcmp(argv[i], "--threshold") == 0 && i + 1 < argc) {
            threshold = (float)atof(argv[++i]);
        } else if (strcmp(argv[i], "--top-n") == 0 && i + 1 < argc) {
            top_n = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--dry-run") == 0) {
            dry_run = true;
        } else if (strcmp(argv[i], "--json") == 0) {
            json_output = true;
        }
    }

    if (help_flag) {
        printf("Usage: ndtsdb-cli facts dedup --database <path> [options]\n");
        printf("  Find duplicate/similar facts in knowledge base\n\n");
        printf("Options:\n");
        printf("  --threshold F     Similarity threshold (default: 0.95)\n");
        printf("  --top-n N         Show top N duplicate pairs (default: 20)\n");
        printf("  --dry-run         Only show duplicates, don't delete\n");
        printf("  --json            Output JSON array\n");
        printf("\nExample:\n");
        printf("  ndtsdb-cli facts dedup -d ./kb --threshold 0.95 --dry-run\n");
        return 0;
    }

    if (!database) { fprintf(stderr, "Error: --database is required\n"); return 1; }
    if (threshold <= 0 || threshold > 1) {
        fprintf(stderr, "Error: --threshold must be 0.0-1.0\n"); return 1;
    }

    // 加载缓存
    int lock_fd = ndtsdb_lock_acquire(database, true);
    if (lock_fd < 0) { fprintf(stderr, "Error: cannot acquire lock\n"); return 1; }

    NDTSDB *db = ndtsdb_open(database);
    if (!db) {
        ndtsdb_lock_release(lock_fd);
        fprintf(stderr, "Error: cannot open database\n"); return 1;
    }

    cache_load_all(database);
    
    // 两两比较找相似对
    DupPair pairs[1024];
    int pair_count = 0;
    
    for (int i = 0; i < g_vec_cache.count && pair_count < 1024; i++) {
        CachedVector* cv1 = &g_vec_cache.items[i];
        if (agent_filter && strcmp(cv1->scope, agent_filter) != 0) continue;
        
        for (int j = i + 1; j < g_vec_cache.count && pair_count < 1024; j++) {
            CachedVector* cv2 = &g_vec_cache.items[j];
            if (agent_filter && strcmp(cv2->scope, agent_filter) != 0) continue;
            if (cv1->dim != cv2->dim) continue;

            // 计算余弦相似度
            float dot = 0, n1 = 0, n2 = 0;
            for (int k = 0; k < cv1->dim; k++) {
                dot += cv1->embedding[k] * cv2->embedding[k];
                n1  += cv1->embedding[k] * cv1->embedding[k];
                n2  += cv2->embedding[k] * cv2->embedding[k];
            }
            float sim = (n1 > 0 && n2 > 0) ? dot / (sqrtf(n1) * sqrtf(n2)) : 0.0f;
            
            if (sim >= threshold) {
                pairs[pair_count].idx1 = i;
                pairs[pair_count].idx2 = j;
                pairs[pair_count].similarity = sim;
                pair_count++;
            }
        }
    }

    ndtsdb_close(db);
    ndtsdb_lock_release(lock_fd);

    // 按相似度排序
    if (pair_count > 1) {
        qsort(pairs, pair_count, sizeof(DupPair), dup_pair_compare_desc);
    }
    if (pair_count > top_n) pair_count = top_n;

    // 输出结果
    if (json_output) {
        printf("[\n");
        for (int i = 0; i < pair_count; i++) {
            CachedVector* cv1 = &g_vec_cache.items[pairs[i].idx1];
            CachedVector* cv2 = &g_vec_cache.items[pairs[i].idx2];
            if (i > 0) printf(",\n");
            printf("  {\"rank\":%d,\"similarity\":%.4f,", i+1, pairs[i].similarity);
            printf("\"item1\":{\"ts\":%lld,\"agent\":\"%s\"},", cv1->ts, cv1->agent_id);
            printf("\"item2\":{\"ts\":%lld,\"agent\":\"%s\"}}", cv2->ts, cv2->agent_id);
        }
        printf("\n]\n");
    } else {
        printf("Found %d duplicate pairs (threshold >= %.2f):\n\n", pair_count, threshold);
        for (int i = 0; i < pair_count; i++) {
            CachedVector* cv1 = &g_vec_cache.items[pairs[i].idx1];
            CachedVector* cv2 = &g_vec_cache.items[pairs[i].idx2];
            printf("[%d] %.4f  %s(ts=%lld) ~ %s(ts=%lld)\n",
                   i+1, pairs[i].similarity, cv1->agent_id, cv1->ts, cv2->agent_id, cv2->ts);
        }
        if (pair_count == 0) printf("No duplicates found.\n");
        else if (dry_run) printf("\n(Dry run - no changes made)\n");
    }

    // TODO: 实际删除逻辑（如果非 dry-run）
    if (!dry_run && pair_count > 0) {
        printf("\nNote: Auto-deletion not implemented yet. Use --dry-run to review.\n");
    }

    return 0;
}

// ============================================================
// facts archive (归档)
// ============================================================

/**
 * 解析日期字符串为时间戳
 * 支持: 2024-01-01, -30d (30天前), -1w (1周前)
 */
static long long parse_date_ts(const char* str) {
    if (!str || !*str) return 0;
    
    // 相对时间: -30d, -1w, -7d
    if (str[0] == '-') {
        long long now = (long long)time(NULL) * 1000LL;
        long long offset = parse_duration_ms(str + 1);
        return now - offset;
    }
    
    // 绝对日期: 2024-01-01
    struct tm tm = {0};
    if (sscanf(str, "%d-%d-%d", &tm.tm_year, &tm.tm_mon, &tm.tm_mday) == 3) {
        tm.tm_year -= 1900;
        tm.tm_mon -= 1;
        return (long long)mktime(&tm) * 1000LL;
    }
    
    // 尝试直接解析为时间戳
    return atoll(str);
}

/**
 * 归档旧知识
 * 用法: facts archive --database <path> --before -30d [--validity mutable]
 */
int cmd_facts_archive(int argc, char **argv) {
    const char *database = NULL;
    const char *before_str = NULL;
    const char *validity_filter = NULL;
    const char *archive_dir = NULL;
    bool dry_run = false;
    bool json_output = false;
    int help_flag = 0;

    for (int i = 3; i < argc; i++) {
        if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            help_flag = 1;
        } else if ((strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) && i + 1 < argc) {
            database = argv[++i];
        } else if (strcmp(argv[i], "--before") == 0 && i + 1 < argc) {
            before_str = argv[++i];
        } else if (strcmp(argv[i], "--validity") == 0 && i + 1 < argc) {
            validity_filter = argv[++i];
        } else if (strcmp(argv[i], "--to") == 0 && i + 1 < argc) {
            archive_dir = argv[++i];
        } else if (strcmp(argv[i], "--dry-run") == 0) {
            dry_run = true;
        } else if (strcmp(argv[i], "--json") == 0) {
            json_output = true;
        }
    }

    if (help_flag) {
        printf("Usage: ndtsdb-cli facts archive --database <path> --before <date> [options]\n");
        printf("  Archive old/expired facts\n\n");
        printf("Options:\n");
        printf("  --before DATE     Archive facts before this date\n");
        printf("                    Format: 2024-01-01, -30d (30 days ago), -1w, -12h\n");
        printf("  --validity V      Only archive facts with this validity\n");
        printf("  --to DIR          Move archived facts to directory (default: mark expired)\n");
        printf("  --dry-run         Preview what would be archived\n");
        printf("\nExample:\n");
        printf("  ndtsdb-cli facts archive -d ./kb --before -30d --dry-run\n");
        return 0;
    }

    if (!database) { fprintf(stderr, "Error: --database is required\n"); return 1; }
    if (!before_str) { fprintf(stderr, "Error: --before is required\n"); return 1; }

    long long before_ts = parse_date_ts(before_str);
    if (before_ts <= 0) {
        fprintf(stderr, "Error: invalid date: %s\n", before_str); return 1;
    }

    // 加载缓存
    int lock_fd = ndtsdb_lock_acquire(database, true);
    if (lock_fd < 0) { fprintf(stderr, "Error: cannot acquire lock\n"); return 1; }

    NDTSDB *db = ndtsdb_open(database);
    if (!db) {
        ndtsdb_lock_release(lock_fd);
        fprintf(stderr, "Error: cannot open database\n"); return 1;
    }

    cache_load_all(database);
    
    int archive_count = 0;
    long long total_bytes = 0;
    
    for (int i = 0; i < g_vec_cache.count; i++) {
        CachedVector* cv = &g_vec_cache.items[i];
        if (cv->ts >= before_ts) continue;
        if (validity_filter && strcmp(cv->type, validity_filter) != 0) continue;
        
        archive_count++;
        // 估算大小: embedding + metadata
        total_bytes += cv->dim * sizeof(float) + 256;
    }

    ndtsdb_close(db);
    ndtsdb_lock_release(lock_fd);

    if (json_output) {
        printf("{\"would_archive\":%d,\"total_bytes\":%lld,\"before_ts\":%lld,\"dry_run\":%s}\n",
               archive_count, total_bytes, before_ts, dry_run ? "true" : "false");
    } else {
        printf("Archive candidates (before %s):\n", before_str);
        printf("  Count: %d items\n", archive_count);
        printf("  Size:  %.2f KB\n", total_bytes / 1024.0);
        if (archive_dir) printf("  Target: %s/\n", archive_dir);
        else printf("  Action: Mark as expired\n");
        if (dry_run) printf("\n(Dry run - no changes made)\n");
        else printf("\nNote: Actual archiving not yet implemented. Use --dry-run to preview.\n");
    }

    return 0;
}
