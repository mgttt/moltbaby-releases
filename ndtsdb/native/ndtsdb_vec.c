/**
 * ndtsdb_vec.c — 向量字段存储实现 (ndtsdb-vec)
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
 * HNSW 索引格式（*.hnsw）：
 *   [文件头 64 字节]
 *     magic[4]        = "NHNS"
 *     version[2]      = 0x0001
 *     M[2]            = uint16_t
 *     ef_construction[4] = uint32_t
 *     ef_search[4]    = uint32_t
 *     dim[4]          = uint32_t
 *     num_nodes[8]    = uint64_t
 *     entry_point[8]  = int64_t（起始节点 ts）
 *     padding[32]     = 0x00
 *
 *   [节点层表]
 *   每个节点：
 *     ts[8]           = int64_t（对应 .ndtv 记录的 timestamp）
 *     max_level[4]    = uint32_t
 *     level_offsets[4*max_level] = uint32_t 数组（指向邻接表的偏移）
 *
 *   [邻接表]
 *     count[4]        = uint32_t
 *     neighbors[count] = { ts[8], distance[4] }
 */

#include "ndtsdb_vec.h"

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
#include <math.h>
#include <time.h>

/* ─── 常量 ─────────────────────────────────────────────── */

#define NDTV_MAGIC          "NDTV"
#define NDTV_VERSION        0x0001u
#define NDTV_FILE_HDR_SIZE  64
#define NDTV_REC_HDR_FIXED  72

#define NDHNSW_MAGIC        "NHNS"
#define NDHNSW_VERSION      0x0001u
#define NDHNSW_FILE_HDR_SIZE 64

#define HNSW_DEFAULT_M              16
#define HNSW_DEFAULT_EF_CONSTRUCTION 200
#define HNSW_DEFAULT_EF_SEARCH      50
#define HNSW_MAX_LEVEL              16
#define HNSW_MAX_M                  64

/* ─── HNSW 内部数据结构 ────────────────────────────────── */

typedef struct HnswNode {
    int64_t ts;                 /* 对应 VecRecord 的 timestamp */
    int max_level;              /* 节点最高层 */
    float* embedding;           /* 向量副本（搜索时用） */
    int dim;                    /* 向量维度 */
    struct HnswNode*** neighbors; /* 邻接表 [level][neighbor_idx] = HnswNode* */
    int* neighbor_counts;       /* 每层邻居数量 */
    int* neighbor_caps;         /* 每层容量 */
} HnswNode;

typedef struct {
    HnswNode** nodes;           /* 所有节点 */
    int node_count;
    int node_cap;
    int64_t entry_point;        /* 入口节点 ts */
    int M;                      /* 最大连接数 */
    int ef_construction;
    int ef_search;
    int dim;                    /* 向量维度 */
    float level_mult;           /* 层数乘数 */
} HnswIndex;

/* ─── 内部：路径构造 ────────────────────────────────────── */

static void build_vector_path(const char* db_path,
                               const char* symbol,
                               const char* interval,
                               char* buf, size_t buf_size)
{
    size_t plen = strlen(db_path);
    char path[256];
    strncpy(path, db_path, sizeof(path) - 1);
    path[sizeof(path) - 1] = '\0';
    if (plen > 0 && path[plen - 1] == '/') path[plen - 1] = '\0';

    snprintf(buf, buf_size, "%s/%s__%s.ndtv", path, symbol, interval);
}

static void build_hnsw_path(const char* db_path,
                             const char* symbol,
                             const char* interval,
                             char* buf, size_t buf_size)
{
    size_t plen = strlen(db_path);
    char path[256];
    strncpy(path, db_path, sizeof(path) - 1);
    path[sizeof(path) - 1] = '\0';
    if (plen > 0 && path[plen - 1] == '/') path[plen - 1] = '\0';

    snprintf(buf, buf_size, "%s/%s__%s.hnsw", path, symbol, interval);
}

/* ─── 内部：文件头读写 ──────────────────────────────────── */

#define NDTV_COUNT_OFFSET  8

static int write_file_header(FILE* f, uint64_t record_count)
{
    uint8_t hdr[NDTV_FILE_HDR_SIZE];
    memset(hdr, 0, sizeof(hdr));

    memcpy(hdr,     NDTV_MAGIC, 4);
    uint16_t ver = NDTV_VERSION;
    memcpy(hdr + 4, &ver, 2);
    memcpy(hdr + NDTV_COUNT_OFFSET, &record_count, 8);

    rewind(f);
    size_t written = fwrite(hdr, 1, sizeof(hdr), f);
    return (written == sizeof(hdr)) ? 0 : -1;
}

static int read_file_header(FILE* f, uint64_t* out_count)
{
    uint8_t hdr[NDTV_FILE_HDR_SIZE];
    rewind(f);
    if (fread(hdr, 1, sizeof(hdr), f) != sizeof(hdr)) return -1;
    if (memcmp(hdr, NDTV_MAGIC, 4) != 0) return -1;
    memcpy(out_count, hdr + NDTV_COUNT_OFFSET, 8);
    return 0;
}

/* ─── 距离计算 ──────────────────────────────────────────── */

static inline float vec_distance(const float* a, const float* b, int dim)
{
    float dot = 0.0f, norm_a = 0.0f, norm_b = 0.0f;
    for (int i = 0; i < dim; i++) {
        dot += a[i] * b[i];
        norm_a += a[i] * a[i];
        norm_b += b[i] * b[i];
    }
    /* 余弦距离 = 1 - 余弦相似度 */
    if (norm_a > 0 && norm_b > 0) {
        return 1.0f - dot / (sqrtf(norm_a) * sqrtf(norm_b));
    }
    return 1.0f;
}

/* ─── HNSW 核心算法 ────────────────────────────────────── */

static float random_float(void)
{
    return (float)rand() / (float)RAND_MAX;
}

static int random_level(float level_mult)
{
    float r = random_float();
    int level = 0;
    while (r < level_mult && level < HNSW_MAX_LEVEL) {
        r = random_float();
        level++;
    }
    return level;
}

/* ─── HNSW 层搜索 ──────────────────────────────────────── */

/* 单层贪婪搜索：找到最近的节点 */
static HnswNode* hnsw_search_layer_simple(HnswIndex* idx, HnswNode* entry,
                                          const float* query, int level)
{
    HnswNode* curr = entry;
    float min_dist = vec_distance(curr->embedding, query, idx->dim);
    int improved = 1;
    
    while (improved) {
        improved = 0;
        for (int i = 0; i < curr->neighbor_counts[level]; i++) {
            HnswNode* nb = (HnswNode*)curr->neighbors[level][i];
            if (!nb) continue;
            float d = vec_distance(nb->embedding, query, idx->dim);
            if (d < min_dist) {
                min_dist = d;
                curr = nb;
                improved = 1;
            }
        }
    }
    return curr;
}

/* 带 ef 参数的多候选搜索 */
static HnswNode* hnsw_search_layer_ef(HnswIndex* idx, HnswNode* entry,
                                      const float* query, int level, int ef)
{
    /* 简化实现：贪婪搜索后返回最近的一个 */
    /* TODO: 实现完整的 ef-搜索，维护候选集和访问集 */
    return hnsw_search_layer_simple(idx, entry, query, level);
}

static HnswNode* hnsw_node_create(int64_t ts, const float* emb, int dim, int max_level, int M)
{
    HnswNode* node = (HnswNode*)calloc(1, sizeof(HnswNode));
    if (!node) return NULL;
    
    node->ts = ts;
    node->max_level = max_level;
    node->dim = dim;
    
    node->embedding = (float*)malloc(dim * sizeof(float));
    if (!node->embedding) { free(node); return NULL; }
    memcpy(node->embedding, emb, dim * sizeof(float));
    
    node->neighbors = (struct HnswNode***)calloc(max_level + 1, sizeof(struct HnswNode**));
    node->neighbor_counts = (int*)calloc(max_level + 1, sizeof(int));
    node->neighbor_caps = (int*)calloc(max_level + 1, sizeof(int));
    
    int cap = M * 2;
    for (int i = 0; i <= max_level; i++) {
        node->neighbor_caps[i] = cap;
        node->neighbors[i] = (struct HnswNode**)calloc(cap, sizeof(struct HnswNode*));
    }
    
    return node;
}

static void hnsw_node_add_neighbor(HnswNode* node, int level, HnswNode* neighbor)
{
    if (!node || !neighbor || level > node->max_level) return;
    if (node->neighbor_counts[level] >= node->neighbor_caps[level]) return;
    
    /* 检查是否已存在 */
    for (int i = 0; i < node->neighbor_counts[level]; i++) {
        if (node->neighbors[level][i] == (struct HnswNode*)neighbor) return;
    }
    
    node->neighbors[level][node->neighbor_counts[level]++] = (struct HnswNode*)neighbor;
}

static void hnsw_node_free(HnswNode* node)
{
    if (!node) return;
    free(node->embedding);
    if (node->neighbors) {
        for (int i = 0; i <= node->max_level; i++) {
            free(node->neighbors[i]);
        }
        free(node->neighbors);
    }
    free(node->neighbor_counts);
    free(node->neighbor_caps);
    free(node);
}

static HnswIndex* hnsw_index_create(int M, int ef_construction, int ef_search, int dim)
{
    HnswIndex* idx = (HnswIndex*)calloc(1, sizeof(HnswIndex));
    if (!idx) return NULL;
    
    idx->M = M;
    idx->ef_construction = ef_construction;
    idx->ef_search = ef_search;
    idx->dim = dim;
    idx->entry_point = -1;
    idx->level_mult = 1.0f / logf(M);
    
    idx->node_cap = 1024;
    idx->nodes = (HnswNode**)calloc(idx->node_cap, sizeof(HnswNode*));
    
    return idx;
}

static void hnsw_index_free(HnswIndex* idx)
{
    if (!idx) return;
    for (int i = 0; i < idx->node_count; i++) {
        hnsw_node_free(idx->nodes[i]);
    }
    free(idx->nodes);
    free(idx);
}

static HnswNode* hnsw_index_find_node(HnswIndex* idx, int64_t ts)
{
    for (int i = 0; i < idx->node_count; i++) {
        if (idx->nodes[i]->ts == ts) return idx->nodes[i];
    }
    return NULL;
}

static int hnsw_index_add_node(HnswIndex* idx, HnswNode* node)
{
    if (idx->node_count >= idx->node_cap) {
        int new_cap = idx->node_cap * 2;
        HnswNode** new_nodes = realloc(idx->nodes, new_cap * sizeof(HnswNode*));
        if (!new_nodes) return -1;
        idx->nodes = new_nodes;
        idx->node_cap = new_cap;
    }
    
    idx->nodes[idx->node_count++] = node;
    return 0;
}

/* ─── HNSW K-NN 搜索 ───────────────────────────────────── */

static int hnsw_knn_search(HnswIndex* idx, const float* query, int k,
                            HnswNode** results, float* distances)
{
    if (!idx->entry_point) return 0;
    
    HnswNode* curr_entry = hnsw_index_find_node(idx, idx->entry_point);
    if (!curr_entry) return 0;
    
    int max_level = curr_entry->max_level;
    
    /* 从最高层开始 */
    for (int lc = max_level; lc >= 1; lc--) {
        HnswNode* nearest = hnsw_search_layer_simple(idx, curr_entry, query, lc);
        if (nearest) curr_entry = nearest;
    }
    
    /* 第 0 层收集候选 */
    typedef struct { HnswNode* node; float dist; } Cand;
    Cand* candidates = (Cand*)malloc(idx->node_count * sizeof(Cand));
    int cand_count = 0;
    
    int* visited = (int*)calloc(idx->node_count, sizeof(int));
    
    /* BFS 收集候选 */
    HnswNode** queue = (HnswNode**)malloc(idx->node_count * sizeof(HnswNode*));
    int qhead = 0, qtail = 0;
    
    queue[qtail++] = curr_entry;
    int entry_idx = -1;
    for (int i = 0; i < idx->node_count; i++) {
        if (idx->nodes[i] == curr_entry) { entry_idx = i; break; }
    }
    if (entry_idx >= 0) visited[entry_idx] = 1;
    
    while (qhead < qtail && cand_count < idx->ef_search) {
        HnswNode* curr = queue[qhead++];
        float d = vec_distance(curr->embedding, query, idx->dim);
        candidates[cand_count].node = curr;
        candidates[cand_count].dist = d;
        cand_count++;
        
        for (int i = 0; i < curr->neighbor_counts[0]; i++) {
            HnswNode* nb = (HnswNode*)curr->neighbors[0][i];
            if (!nb) continue;
            
            int nb_idx = -1;
            for (int j = 0; j < idx->node_count; j++) {
                if (idx->nodes[j] == nb) { nb_idx = j; break; }
            }
            if (nb_idx < 0 || visited[nb_idx]) continue;
            visited[nb_idx] = 1;
            
            queue[qtail++] = nb;
        }
    }
    
    /* 排序取前 k */
    for (int i = 0; i < cand_count - 1 && i < k; i++) {
        for (int j = i + 1; j < cand_count; j++) {
            if (candidates[j].dist < candidates[i].dist) {
                Cand tmp = candidates[i];
                candidates[i] = candidates[j];
                candidates[j] = tmp;
            }
        }
    }
    
    int count = (cand_count < k) ? cand_count : k;
    for (int i = 0; i < count; i++) {
        results[i] = candidates[i].node;
        distances[i] = candidates[i].dist;
    }
    
    free(candidates);
    free(visited);
    free(queue);
    
    return count;
}

/* ─── 简化版 HNSW 搜索 ─────────────────────────────────── */

/* 单层贪婪搜索，返回最近节点的 ts */
static int64_t hnsw_search_layer(HnswIndex* idx, HnswNode* entry,
                                  const float* query, int dim,
                                  int level, int ef)
{
    /* 简化实现：直接扫描该层所有节点（对于小数据集够用） */
    float min_dist = vec_distance(entry->embedding, query, dim);
    int64_t best_ts = entry->ts;
    
    for (int i = 0; i < entry->neighbor_counts[level]; i++) {
        HnswNode* neighbor = ((HnswNode**)entry->neighbors[level])[i];
        if (!neighbor) continue;
        float dist = vec_distance(neighbor->embedding, query, dim);
        if (dist < min_dist) {
            min_dist = dist;
            best_ts = neighbor->ts;
        }
    }
    
    return best_ts;
}

/* ─── 公开 API：向量写入 ───────────────────────────────── */

int ndtsdb_vec_insert(NDTSDB* db,
                      const char* symbol,
                      const char* interval,
                      const VecRecord* record)
{
    if (!db || !symbol || !interval || !record) return -1;
    if (record->embedding_dim > 0 && !record->embedding) return -1;

    char filepath[512];
    build_vector_path(ndtsdb_get_path(db), symbol, interval, filepath, sizeof(filepath));

    uint64_t record_count = 0;
    FILE* f = fopen(filepath, "r+b");
    if (!f) {
        f = fopen(filepath, "w+b");
        if (!f) return -1;
        if (write_file_header(f, 0) != 0) { fclose(f); return -1; }
    } else {
        if (read_file_header(f, &record_count) != 0) {
            fclose(f); return -1;
        }
    }

    if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return -1; }

    uint32_t emb_bytes  = (uint32_t)record->embedding_dim * sizeof(float);
    uint32_t rec_size   = (uint32_t)NDTV_REC_HDR_FIXED + emb_bytes;

    uint8_t* buf = (uint8_t*)malloc(rec_size);
    if (!buf) { fclose(f); return -1; }
    memset(buf, 0, rec_size);

    uint8_t* p = buf;

    memcpy(p, &rec_size, 4);             p += 4;
    memcpy(p, &record->timestamp, 8);    p += 8;
    strncpy((char*)p, record->agent_id, 31); p[31] = '\0'; p += 32;
    strncpy((char*)p, record->type, 15);     p[15] = '\0'; p += 16;
    memcpy(p, &record->confidence, 4);   p += 4;
    memcpy(p, &record->embedding_dim, 2); p += 2;
    memcpy(p, &record->flags, 4);        p += 4;
    p += 2;
    if (emb_bytes > 0)
        memcpy(p, record->embedding, emb_bytes);

    size_t written = fwrite(buf, 1, rec_size, f);
    free(buf);

    if (written != rec_size) { fclose(f); return -1; }

    record_count++;
    if (write_file_header(f, record_count) != 0) { fclose(f); return -1; }

    fflush(f);
    if (fsync(fileno(f)) != 0) { fclose(f); return -1; }
    fclose(f);
    return 0;
}

/* ─── 公开 API：全表扫描查询 ───────────────────────────── */

VecQueryResult* ndtsdb_vec_query(NDTSDB* db,
                                 const char* symbol,
                                 const char* interval)
{
    if (!db || !symbol || !interval) return NULL;

    VecQueryResult* result = (VecQueryResult*)malloc(sizeof(VecQueryResult));
    if (!result) return NULL;
    result->records = NULL;
    result->count   = 0;

    char filepath[512];
    build_vector_path(ndtsdb_get_path(db), symbol, interval, filepath, sizeof(filepath));

    FILE* f = fopen(filepath, "rb");
    if (!f) return result;

    uint64_t record_count = 0;
    if (read_file_header(f, &record_count) != 0 || record_count == 0) {
        fclose(f); return result;
    }

    result->records = (VecRecord*)calloc(record_count, sizeof(VecRecord));
    if (!result->records) { fclose(f); free(result); return NULL; }

    if (fseek(f, NDTV_FILE_HDR_SIZE, SEEK_SET) != 0) {
        fclose(f); ndtsdb_vec_free_result(result); return NULL;
    }

    uint32_t idx = 0;
    while (idx < (uint32_t)record_count) {
        uint32_t rec_size = 0;
        if (fread(&rec_size, 4, 1, f) != 1) break;
        if (rec_size < (uint32_t)NDTV_REC_HDR_FIXED) break;

        VecRecord* rec = &result->records[idx];

        if (fread(&rec->timestamp, 8, 1, f) != 1) break;
        if (fread(rec->agent_id, 32, 1, f) != 1) break;
        rec->agent_id[31] = '\0';
        if (fread(rec->type, 16, 1, f) != 1) break;
        rec->type[15] = '\0';
        if (fread(&rec->confidence, 4, 1, f) != 1) break;
        if (fread(&rec->embedding_dim, 2, 1, f) != 1) break;
        if (fread(&rec->flags, 4, 1, f) != 1) break;
        uint16_t pad = 0;
        if (fread(&pad, 2, 1, f) != 1) break;

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

/* ─── 内部：HNSW 索引加载（前向声明） ───────────────────── */

static HnswIndex* hnsw_index_load(const char* hnsw_path, VecQueryResult* vectors);

/* ─── 公开 API：HNSW 近似搜索 ───────────────────────────── */

VecQueryResult* ndtsdb_vec_search(NDTSDB* db,
                                  const char* symbol,
                                  const char* interval,
                                  const float* query,
                                  int dim,
                                  int top_k,
                                  const VecHnswConfig* config)
{
    if (!db || !symbol || !interval || !query || dim <= 0 || top_k <= 0) return NULL;

    /* 检查是否有 HNSW 索引 */
    char hnsw_path[512];
    build_hnsw_path(ndtsdb_get_path(db), symbol, interval, hnsw_path, sizeof(hnsw_path));
    
    if (access(hnsw_path, F_OK) != 0) {
        /* 无索引，回退到全表扫描 */
        VecQueryResult* all = ndtsdb_vec_query(db, symbol, interval);
        if (!all || all->count == 0) return all;
        
        /* 计算距离并排序 */
        typedef struct { int idx; float dist; } DistItem;
        DistItem* items = (DistItem*)malloc(all->count * sizeof(DistItem));
        for (uint32_t i = 0; i < all->count; i++) {
            items[i].idx = i;
            if (all->records[i].embedding && all->records[i].embedding_dim == dim) {
                items[i].dist = vec_distance(all->records[i].embedding, query, dim);
            } else {
                items[i].dist = 2.0f; /* 最大距离 */
            }
        }
        
        /* 简单选择 top_k */
        for (int i = 0; i < (int)all->count - 1; i++) {
            for (int j = i + 1; j < (int)all->count && i < top_k; j++) {
                if (items[j].dist < items[i].dist) {
                    DistItem tmp = items[i]; items[i] = items[j]; items[j] = tmp;
                }
            }
        }
        
        /* 复制结果 */
        int result_count = (top_k < (int)all->count) ? top_k : (int)all->count;
        VecRecord* new_records = (VecRecord*)malloc(result_count * sizeof(VecRecord));
        for (int i = 0; i < result_count; i++) {
            new_records[i] = all->records[items[i].idx];
            /* 转移所有权 */
            all->records[items[i].idx].embedding = NULL;
        }
        
        free(items);
        ndtsdb_vec_free_result(all);
        
        VecQueryResult* result = (VecQueryResult*)malloc(sizeof(VecQueryResult));
        result->records = new_records;
        result->count = result_count;
        return result;
    }
    
    /* 有 HNSW 索引，加载并使用 HNSW 搜索 */
    VecQueryResult* all = ndtsdb_vec_query(db, symbol, interval);
    if (!all || all->count == 0) return all;
    
    HnswIndex* idx = hnsw_index_load(hnsw_path, all);
    if (!idx) {
        /* 加载失败，回退到全表扫描 */
        ndtsdb_vec_free_result(all);
        return ndtsdb_vec_query(db, symbol, interval);
    }
    
    /* 使用 HNSW 搜索 */
    HnswNode** results = (HnswNode**)malloc(top_k * sizeof(HnswNode*));
    float* distances = (float*)malloc(top_k * sizeof(float));
    
    int count = hnsw_knn_search(idx, query, top_k, results, distances);
    
    /* 构建返回结果 */
    VecQueryResult* result = (VecQueryResult*)malloc(sizeof(VecQueryResult));
    result->records = (VecRecord*)malloc(count * sizeof(VecRecord));
    result->count = count;
    
    for (int i = 0; i < count; i++) {
        /* 找到对应的 VecRecord */
        for (uint32_t j = 0; j < all->count; j++) {
            if (all->records[j].timestamp == results[i]->ts) {
                result->records[i] = all->records[j];
                all->records[j].embedding = NULL;  /* 转移所有权 */
                break;
            }
        }
    }
    
    free(results);
    free(distances);
    hnsw_index_free(idx);
    ndtsdb_vec_free_result(all);
    
    return result;
}

/* ─── 公开 API：释放结果 ───────────────────────────────── */

void ndtsdb_vec_free_result(VecQueryResult* result)
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

/* ─── 公开 API：HNSW 索引管理 ───────────────────────────── */

int ndtsdb_vec_build_index(NDTSDB* db,
                           const char* symbol,
                           const char* interval,
                           const VecHnswConfig* config)
{
    if (!db || !symbol || !interval) return -1;

    int M = config ? config->M : HNSW_DEFAULT_M;
    int ef_construction = config ? config->ef_construction : HNSW_DEFAULT_EF_CONSTRUCTION;

    /* 读取所有向量 */
    VecQueryResult* all = ndtsdb_vec_query(db, symbol, interval);
    if (!all || all->count == 0) {
        ndtsdb_vec_free_result(all);
        return -1;
    }

    /* 构建 HNSW 索引（简化版：顺序插入） */
    HnswIndex* idx = hnsw_index_create(M, ef_construction, HNSW_DEFAULT_EF_SEARCH, 
                                        all->records[0].embedding_dim);
    if (!idx) {
        ndtsdb_vec_free_result(all);
        return -1;
    }

    srand((unsigned)time(NULL));

    for (uint32_t i = 0; i < all->count; i++) {
        VecRecord* rec = &all->records[i];
        int max_level = random_level(idx->level_mult);
        
        HnswNode* node = hnsw_node_create(rec->timestamp, rec->embedding, 
                                           rec->embedding_dim, max_level, M);
        if (!node) continue;
        
        /* 扩容 */
        if (idx->node_count >= idx->node_cap) {
            idx->node_cap *= 2;
            HnswNode** new_nodes = realloc(idx->nodes, idx->node_cap * sizeof(HnswNode*));
            if (!new_nodes) { hnsw_node_free(node); continue; }
            idx->nodes = new_nodes;
        }
        
        idx->nodes[idx->node_count++] = node;
        
        /* 第一个节点作为 entry_point */
        if (idx->entry_point < 0) {
            idx->entry_point = rec->timestamp;
            continue;
        }
        
        /* HNSW 插入算法 */
        HnswNode* curr_ep = hnsw_index_find_node(idx, idx->entry_point);
        float min_dist = vec_distance(node->embedding, curr_ep->embedding, idx->dim);
        
        /* 从最高层开始搜索 */
        int ep_level = curr_ep->max_level;
        for (int lc = ep_level; lc > max_level; lc--) {
            HnswNode* nearest = hnsw_search_layer_simple(idx, curr_ep, node->embedding, lc);
            if (nearest) {
                float d = vec_distance(node->embedding, nearest->embedding, idx->dim);
                if (d < min_dist) {
                    min_dist = d;
                    curr_ep = nearest;
                }
            }
        }
        
        /* 从当前节点层向下处理 */
        HnswNode* ep_w = curr_ep;
        for (int lc = (max_level < ep_level ? max_level : ep_level); lc >= 0; lc--) {
            /* 搜索近邻 */
            HnswNode* nearest = hnsw_search_layer_ef(idx, ep_w, node->embedding, lc, idx->ef_construction);
            
            /* 选择邻居并连接 */
            if (nearest && nearest != node) {
                hnsw_node_add_neighbor(node, lc, nearest);
                hnsw_node_add_neighbor(nearest, lc, node);
                
                /* 收集更多邻居 */
                for (int ni = 0; ni < nearest->neighbor_counts[lc] && node->neighbor_counts[lc] < idx->M; ni++) {
                    HnswNode* nn = (HnswNode*)nearest->neighbors[lc][ni];
                    if (nn && nn != node) {
                        hnsw_node_add_neighbor(node, lc, nn);
                        hnsw_node_add_neighbor(nn, lc, node);
                    }
                }
            }
            
            ep_w = nearest ? nearest : ep_w;
        }
        
        /* 更新 entry_point */
        if (max_level > ep_level) {
            idx->entry_point = rec->timestamp;
        }
    }

    /* 保存索引到文件 */
    char hnsw_path[512];
    build_hnsw_path(ndtsdb_get_path(db), symbol, interval, hnsw_path, sizeof(hnsw_path));
    
    FILE* f = fopen(hnsw_path, "wb");
    if (f) {
        /* 写文件头 */
        uint8_t hdr[NDHNSW_FILE_HDR_SIZE] = {0};
        memcpy(hdr, NDHNSW_MAGIC, 4);
        uint16_t ver = NDHNSW_VERSION;
        memcpy(hdr + 4, &ver, 2);
        memcpy(hdr + 6, &M, 2);
        memcpy(hdr + 8, &ef_construction, 4);
        uint32_t ef_search = HNSW_DEFAULT_EF_SEARCH;
        memcpy(hdr + 12, &ef_search, 4);
        uint32_t dim = idx->dim;
        memcpy(hdr + 16, &dim, 4);
        uint64_t num_nodes = idx->node_count;
        memcpy(hdr + 20, &num_nodes, 8);
        memcpy(hdr + 28, &idx->entry_point, 8);
        
        fwrite(hdr, 1, sizeof(hdr), f);
        
        /* 写节点表 */
        for (int i = 0; i < idx->node_count; i++) {
            HnswNode* node = idx->nodes[i];
            fwrite(&node->ts, sizeof(int64_t), 1, f);
            fwrite(&node->max_level, sizeof(int), 1, f);
            
            /* 写每层的邻居数量 */
            for (int lc = 0; lc <= node->max_level; lc++) {
                fwrite(&node->neighbor_counts[lc], sizeof(int), 1, f);
            }
            
            /* 写邻居 ts */
            for (int lc = 0; lc <= node->max_level; lc++) {
                for (int ni = 0; ni < node->neighbor_counts[lc]; ni++) {
                    HnswNode* nb = (HnswNode*)node->neighbors[lc][ni];
                    int64_t nb_ts = nb ? nb->ts : -1;
                    fwrite(&nb_ts, sizeof(int64_t), 1, f);
                }
            }
        }
        
        fclose(f);
    }

    hnsw_index_free(idx);
    ndtsdb_vec_free_result(all);
    return 0;
}

int ndtsdb_vec_has_index(NDTSDB* db,
                         const char* symbol,
                         const char* interval)
{
    if (!db || !symbol || !interval) return 0;
    
    char hnsw_path[512];
    build_hnsw_path(ndtsdb_get_path(db), symbol, interval, hnsw_path, sizeof(hnsw_path));
    
    return (access(hnsw_path, F_OK) == 0) ? 1 : 0;
}

/* ─── 内部：加载 HNSW 索引 ─────────────────────────────── */

static HnswIndex* hnsw_index_load(const char* hnsw_path, VecQueryResult* vectors)
{
    FILE* f = fopen(hnsw_path, "rb");
    if (!f) return NULL;
    
    /* 读文件头 */
    uint8_t hdr[NDHNSW_FILE_HDR_SIZE];
    if (fread(hdr, 1, sizeof(hdr), f) != sizeof(hdr)) {
        fclose(f);
        return NULL;
    }
    
    if (memcmp(hdr, NDHNSW_MAGIC, 4) != 0) {
        fclose(f);
        return NULL;
    }
    
    uint16_t ver;
    memcpy(&ver, hdr + 4, 2);
    if (ver != NDHNSW_VERSION) {
        fclose(f);
        return NULL;
    }
    
    int M;
    memcpy(&M, hdr + 6, 2);
    int ef_construction;
    memcpy(&ef_construction, hdr + 8, 4);
    int ef_search;
    memcpy(&ef_search, hdr + 12, 4);
    int dim;
    memcpy(&dim, hdr + 16, 4);
    int64_t num_nodes;
    memcpy(&num_nodes, hdr + 20, 8);
    int64_t entry_point_ts;
    memcpy(&entry_point_ts, hdr + 28, 8);
    
    /* 创建索引 */
    HnswIndex* idx = hnsw_index_create(M, ef_construction, ef_search, dim);
    if (!idx) {
        fclose(f);
        return NULL;
    }
    
    /* 创建 ts->vector 映射 */
    /* 先创建所有节点（不连接） */
    for (int i = 0; i < num_nodes; i++) {
        int64_t ts;
        int max_level;
        
        if (fread(&ts, sizeof(int64_t), 1, f) != 1) goto load_error;
        if (fread(&max_level, sizeof(int), 1, f) != 1) goto load_error;
        
        /* 找到对应的向量 */
        VecRecord* vec = NULL;
        for (uint32_t j = 0; j < vectors->count; j++) {
            if (vectors->records[j].timestamp == ts) {
                vec = &vectors->records[j];
                break;
            }
        }
        
        if (!vec) goto load_error;
        
        /* 创建节点 */
        HnswNode* node = hnsw_node_create(ts, vec->embedding, dim, max_level, M);
        if (!node) goto load_error;
        
        /* 读邻居数量 */
        for (int lc = 0; lc <= max_level; lc++) {
            if (fread(&node->neighbor_counts[lc], sizeof(int), 1, f) != 1) {
                hnsw_node_free(node);
                goto load_error;
            }
        }
        
        if (hnsw_index_add_node(idx, node) != 0) {
            hnsw_node_free(node);
            goto load_error;
        }
        
        if (ts == entry_point_ts) {
            idx->entry_point = ts;
        }
    }
    
    /* 重新定位到邻居数据 */
    /* 重新打开文件，跳过头部和节点表，读取邻居 ts */
    fseek(f, sizeof(hdr), SEEK_SET);
    
    for (int i = 0; i < num_nodes; i++) {
        int64_t ts;
        int max_level;
        if (fread(&ts, sizeof(int64_t), 1, f) != 1) goto load_error;
        if (fread(&max_level, sizeof(int), 1, f) != 1) goto load_error;
        
        /* 跳过邻居数量 */
        for (int lc = 0; lc <= max_level; lc++) {
            int count;
            if (fread(&count, sizeof(int), 1, f) != 1) goto load_error;
        }
        
        HnswNode* node = hnsw_index_find_node(idx, ts);
        if (!node) goto load_error;
        
        /* 读取并连接邻居 */
        for (int lc = 0; lc <= max_level; lc++) {
            for (int ni = 0; ni < node->neighbor_counts[lc]; ni++) {
                int64_t nb_ts;
                if (fread(&nb_ts, sizeof(int64_t), 1, f) != 1) goto load_error;
                
                if (nb_ts >= 0) {
                    HnswNode* nb = hnsw_index_find_node(idx, nb_ts);
                    if (nb) {
                        hnsw_node_add_neighbor(node, lc, nb);
                    }
                }
            }
        }
    }
    
    fclose(f);
    return idx;
    
load_error:
    hnsw_index_free(idx);
    fclose(f);
    return NULL;
}
