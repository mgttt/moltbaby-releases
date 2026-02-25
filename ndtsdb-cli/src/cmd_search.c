// cmd_search.c - 语义检索命令
#include "cmd_search.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <math.h>
#include "../../ndtsdb/native/ndtsdb.h"
#include "../../ndtsdb/native/ndtsdb_vector.h"
#include "ndtsdb_lock.h"

// 解析向量字符串 "[0.1,0.2,0.3]"
static int parse_vector(const char *str, float *vec, int max_dim) {
    int dim = 0;
    const char *p = strchr(str, '[');
    if (!p) return 0;
    p++;
    
    while (*p && *p != ']' && dim < max_dim) {
        char *end;
        float v = strtof(p, &end);
        if (end == p) { p++; continue; }
        vec[dim++] = v;
        p = end;
        while (*p == ' ' || *p == ',') p++;
    }
    return dim;
}

int cmd_search(int argc, char **argv) {
    const char *database = NULL;
    const char *query_vector_str = NULL;
    const char *format = "json";
    int top_k = 10;
    float threshold = 0.0f;
    int help_flag = 0;
    
    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            help_flag = 1;
        } else if ((strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) && i + 1 < argc) {
            database = argv[++i];
        } else if ((strcmp(argv[i], "--query-vector") == 0 || strcmp(argv[i], "-q") == 0) && i + 1 < argc) {
            query_vector_str = argv[++i];
        } else if ((strcmp(argv[i], "--top-k") == 0 || strcmp(argv[i], "-k") == 0) && i + 1 < argc) {
            top_k = atoi(argv[++i]);
        } else if ((strcmp(argv[i], "--threshold") == 0 || strcmp(argv[i], "-t") == 0) && i + 1 < argc) {
            threshold = atof(argv[++i]);
        } else if ((strcmp(argv[i], "--format") == 0 || strcmp(argv[i], "-f") == 0) && i + 1 < argc) {
            format = argv[++i];
        }
    }
    
    if (help_flag) {
        printf("Usage: ndtsdb-cli search --database <path> --query-vector '<vector>' [options]\n");
        printf("  Semantic search using cosine similarity\n");
        printf("\nOptions:\n");
        printf("  --database, -d    Database path (required)\n");
        printf("  --query-vector    Query vector as JSON array (required)\n");
        printf("  --top-k, -k       Number of top results (default: 10)\n");
        printf("  --threshold, -t   Minimum similarity threshold (default: 0.0)\n");
        printf("  --format, -f      Output format: json|csv (default: json)\n");
        printf("\nExample:\n");
        printf("  ndtsdb-cli search -d ./db -q '[0.1,0.2,0.3]' -k 5 -t 0.8\n");
        return 0;
    }
    
    if (!database || !query_vector_str) {
        fprintf(stderr, "Error: --database and --query-vector are required\n");
        return 1;
    }
    
    // 解析查询向量
    float query_vec[4096];
    int query_dim = parse_vector(query_vector_str, query_vec, 4096);
    if (query_dim == 0) {
        fprintf(stderr, "Error: Invalid query vector format\n");
        return 1;
    }
    
    // 获取锁
    int lock_fd = ndtsdb_lock_acquire(database, false);
    if (lock_fd < 0) {
        fprintf(stderr, "Error: Cannot acquire lock on database\n");
        return 1;
    }
    
    NDTSDB *db = ndtsdb_open(database);
    if (!db) {
        ndtsdb_lock_release(lock_fd);
        fprintf(stderr, "Error: Cannot open database\n");
        return 1;
    }
    
    // 查询所有向量分区
    char syms[256][32], itvs[256][16];
    int n = ndtsdb_list_symbols(db, syms, itvs, 256);
    
    // 收集结果
    typedef struct {
        char agent_id[32];
        char type[16];
        int64_t timestamp;
        float confidence;
        float similarity;
    } SearchResult;
    
    SearchResult results[1024];
    int result_count = 0;
    
    for (int s = 0; s < n && result_count < 1024; s++) {
        // 只处理向量分区
        VectorQueryResult *vr = ndtsdb_query_vectors(db, syms[s], itvs[s]);
        if (!vr) continue;
        
        for (uint32_t i = 0; i < vr->count && result_count < 1024; i++) {
            VectorRecord *rec = &vr->records[i];
            if (rec->embedding_dim != query_dim) continue;
            
            // 计算余弦相似度
            float dot = 0.0f, norm_q = 0.0f, norm_r = 0.0f;
            for (int j = 0; j < query_dim; j++) {
                dot += query_vec[j] * rec->embedding[j];
                norm_q += query_vec[j] * query_vec[j];
                norm_r += rec->embedding[j] * rec->embedding[j];
            }
            float sim = (norm_q > 0 && norm_r > 0) ? dot / (sqrtf(norm_q) * sqrtf(norm_r)) : 0.0f;
            
            if (sim >= threshold) {
                strncpy(results[result_count].agent_id, rec->agent_id, 31);
                results[result_count].agent_id[31] = '\0';
                strncpy(results[result_count].type, rec->type, 15);
                results[result_count].type[15] = '\0';
                results[result_count].timestamp = rec->timestamp;
                results[result_count].confidence = rec->confidence;
                results[result_count].similarity = sim;
                result_count++;
            }
        }
        ndtsdb_vector_free_result(vr);
    }
    
    ndtsdb_close(db);
    ndtsdb_lock_release(lock_fd);
    
    // 按相似度排序
    for (int i = 0; i < result_count - 1; i++) {
        for (int j = i + 1; j < result_count; j++) {
            if (results[j].similarity > results[i].similarity) {
                SearchResult tmp = results[i];
                results[i] = results[j];
                results[j] = tmp;
            }
        }
    }
    
    // 限制 top-k
    if (result_count > top_k) result_count = top_k;
    
    // 输出结果
    if (strcmp(format, "csv") == 0) {
        printf("agent_id,type,timestamp,confidence,similarity\n");
        for (int i = 0; i < result_count; i++) {
            printf("%s,%s,%ld,%.4f,%.6f\n",
                results[i].agent_id,
                results[i].type,
                results[i].timestamp,
                results[i].confidence,
                results[i].similarity);
        }
    } else {
        printf("[\n");
        for (int i = 0; i < result_count; i++) {
            printf("  {\"agent_id\":\"%s\",\"type\":\"%s\",\"timestamp\":%ld,\"confidence\":%.4f,\"similarity\":%.6f}%s\n",
                results[i].agent_id,
                results[i].type,
                results[i].timestamp,
                results[i].confidence,
                results[i].similarity,
                (i < result_count - 1) ? "," : "");
        }
        printf("]\n");
    }
    
    return 0;
}