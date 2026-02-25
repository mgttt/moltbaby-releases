// cmd_facts.c - 知识库管理命令
#include "cmd_facts.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <math.h>
#include "../../ndtsdb/native/ndtsdb.h"
#include "../../ndtsdb/native/ndtsdb_vector.h"
#include "ndtsdb_lock.h"

// facts import --database <path> --input facts.jsonl
static int cmd_facts_import(int argc, char **argv) {
    const char *database = NULL;
    const char *input = NULL;
    int help_flag = 0;
    
    for (int i = 3; i < argc; i++) {
        if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            help_flag = 1;
        } else if ((strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) && i + 1 < argc) {
            database = argv[++i];
        } else if ((strcmp(argv[i], "--input") == 0 || strcmp(argv[i], "-i") == 0) && i + 1 < argc) {
            input = argv[++i];
        }
    }
    
    if (help_flag) {
        printf("Usage: ndtsdb-cli facts import --database <path> --input <facts.jsonl>\n");
        printf("  Import knowledge facts from JSON Lines file\n");
        return 0;
    }
    
    if (!database || !input) {
        fprintf(stderr, "Error: --database and --input are required\n");
        return 1;
    }
    
    int lock_fd = ndtsdb_lock_acquire(database, true);
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
    
    FILE *fp = fopen(input, "r");
    if (!fp) {
        ndtsdb_close(db);
        ndtsdb_lock_release(lock_fd);
        fprintf(stderr, "Error: Cannot open input file: %s\n", input);
        return 1;
    }
    
    int imported = 0, errors = 0;
    char line[4096];
    
    while (fgets(line, sizeof(line), fp)) {
        char *emb_start = strstr(line, "\"embedding\":");
        if (!emb_start) continue;
        emb_start = strchr(emb_start, '[');
        if (!emb_start) continue;
        
        float embedding[4096];
        int emb_dim = 0;
        char *p = emb_start + 1;
        
        while (*p && *p != ']' && emb_dim < 4096) {
            char *end;
            float v = strtof(p, &end);
            if (end == p) { p++; continue; }
            embedding[emb_dim++] = v;
            p = end;
            while (*p == ' ' || *p == ',') p++;
        }
        
        if (emb_dim == 0) { errors++; continue; }
        
        VectorRecord vrec;
        vrec.timestamp = 1700000000000LL + imported;
        strncpy(vrec.agent_id, "fact", 31);
        vrec.agent_id[31] = '\0';
        strncpy(vrec.type, "knowledge", 15);
        vrec.type[15] = '\0';
        vrec.confidence = 1.0f;
        vrec.embedding_dim = emb_dim;
        vrec.embedding = malloc(emb_dim * sizeof(float));
        if (!vrec.embedding) { errors++; continue; }
        memcpy(vrec.embedding, embedding, emb_dim * sizeof(float));
        
        if (ndtsdb_insert_vector(db, "facts", "embeddings", &vrec) == 0) {
            imported++;
        } else {
            errors++;
        }
        free(vrec.embedding);
    }
    
    fclose(fp);
    ndtsdb_close(db);
    ndtsdb_lock_release(lock_fd);
    
    printf("Imported %d facts (%d errors)\n", imported, errors);
    return errors > 0 ? 1 : 0;
}

// facts list --database <path> [--tag xxx]
static int cmd_facts_list(int argc, char **argv) {
    const char *database = NULL;
    int help_flag = 0;
    
    for (int i = 3; i < argc; i++) {
        if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            help_flag = 1;
        } else if ((strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) && i + 1 < argc) {
            database = argv[++i];
        }
    }
    
    if (help_flag) {
        printf("Usage: ndtsdb-cli facts list --database <path>\n");
        printf("  List knowledge facts in database\n");
        return 0;
    }
    
    if (!database) {
        fprintf(stderr, "Error: --database is required\n");
        return 1;
    }
    
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
    
    // 查询 facts 向量分区
    VectorQueryResult *vr = ndtsdb_query_vectors(db, "facts", "embeddings");
    if (!vr) {
        printf("No facts found\n");
        ndtsdb_close(db);
        ndtsdb_lock_release(lock_fd);
        return 0;
    }
    
    printf("Found %u facts:\n", vr->count);
    for (uint32_t i = 0; i < vr->count; i++) {
        VectorRecord *rec = &vr->records[i];
        printf("  [%u] %s/%s ts=%ld dim=%d\n", 
               i, rec->agent_id, rec->type, rec->timestamp, rec->embedding_dim);
    }
    
    ndtsdb_vector_free_result(vr);
    ndtsdb_close(db);
    ndtsdb_lock_release(lock_fd);
    return 0;
}

// facts search --database <path> --query-vector '[...]' --top-k 5
static int cmd_facts_search(int argc, char **argv) {
    const char *database = NULL;
    const char *query_vector = NULL;
    int top_k = 10;
    int help_flag = 0;
    
    for (int i = 3; i < argc; i++) {
        if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            help_flag = 1;
        } else if ((strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) && i + 1 < argc) {
            database = argv[++i];
        } else if ((strcmp(argv[i], "--query-vector") == 0 || strcmp(argv[i], "-q") == 0) && i + 1 < argc) {
            query_vector = argv[++i];
        } else if ((strcmp(argv[i], "--top-k") == 0 || strcmp(argv[i], "-k") == 0) && i + 1 < argc) {
            top_k = atoi(argv[++i]);
        }
    }
    
    if (help_flag) {
        printf("Usage: ndtsdb-cli facts search --database <path> --query-vector '<vector>' [--top-k N]\n");
        printf("  Semantic search in knowledge base\n");
        return 0;
    }
    
    if (!database || !query_vector) {
        fprintf(stderr, "Error: --database and --query-vector are required\n");
        return 1;
    }
    
    // 解析查询向量
    float query_vec[4096];
    int query_dim = 0;
    const char *p = strchr(query_vector, '[');
    if (p) {
        p++;
        while (*p && *p != ']' && query_dim < 4096) {
            char *end;
            float v = strtof(p, &end);
            if (end == p) { p++; continue; }
            query_vec[query_dim++] = v;
            p = end;
            while (*p == ' ' || *p == ',') p++;
        }
    }
    
    if (query_dim == 0) {
        fprintf(stderr, "Error: Invalid query vector\n");
        return 1;
    }
    
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
    
    // 查询并计算相似度
    VectorQueryResult *vr = ndtsdb_query_vectors(db, "facts", "embeddings");
    if (!vr) {
        printf("No facts found\n");
        ndtsdb_close(db);
        ndtsdb_lock_release(lock_fd);
        return 0;
    }
    
    typedef struct { int idx; float sim; } Result;
    Result results[1024];
    int count = 0;
    
    for (uint32_t i = 0; i < vr->count && count < 1024; i++) {
        VectorRecord *rec = &vr->records[i];
        if (rec->embedding_dim != query_dim) continue;
        
        float dot = 0, norm_q = 0, norm_r = 0;
        for (int j = 0; j < query_dim; j++) {
            dot += query_vec[j] * rec->embedding[j];
            norm_q += query_vec[j] * query_vec[j];
            norm_r += rec->embedding[j] * rec->embedding[j];
        }
        float sim = (norm_q > 0 && norm_r > 0) ? dot / (sqrtf(norm_q) * sqrtf(norm_r)) : 0;
        
        results[count].idx = i;
        results[count].sim = sim;
        count++;
    }
    
    // 排序
    for (int i = 0; i < count - 1; i++) {
        for (int j = i + 1; j < count; j++) {
            if (results[j].sim > results[i].sim) {
                Result t = results[i]; results[i] = results[j]; results[j] = t;
            }
        }
    }
    
    if (count > top_k) count = top_k;
    
    printf("Top %d results:\n", count);
    for (int i = 0; i < count; i++) {
        VectorRecord *rec = &vr->records[results[i].idx];
        printf("  [%d] similarity=%.4f %s/%s ts=%ld\n", 
               i+1, results[i].sim, rec->agent_id, rec->type, rec->timestamp);
    }
    
    ndtsdb_vector_free_result(vr);
    ndtsdb_close(db);
    ndtsdb_lock_release(lock_fd);
    return 0;
}

int cmd_facts(int argc, char **argv) {
    if (argc < 3 || strcmp(argv[2], "--help") == 0 || strcmp(argv[2], "-h") == 0) {
        printf("Usage: ndtsdb-cli facts <command> [options]\n");
        printf("\nCommands:\n");
        printf("  import   Import facts from JSONL file\n");
        printf("  list     List facts in database\n");
        printf("  search   Semantic search in knowledge base\n");
        printf("\nUse 'ndtsdb-cli facts <command> --help' for more info\n");
        return argc < 3 ? 1 : 0;
    }
    
    if (strcmp(argv[2], "import") == 0) return cmd_facts_import(argc, argv);
    if (strcmp(argv[2], "list") == 0) return cmd_facts_list(argc, argv);
    if (strcmp(argv[2], "search") == 0) return cmd_facts_search(argc, argv);
    
    fprintf(stderr, "Error: Unknown facts command: %s\n", argv[2]);
    return 1;
}