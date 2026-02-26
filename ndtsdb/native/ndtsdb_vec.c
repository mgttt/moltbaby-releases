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

/* ═══════════════════════════════════════════════════════════════════════════
 * P3: ef-搜索优化 —— 完整 HNSW ef-search 实现
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 算法: HNSW Layer Search with ef parameter
 * 参考: "Efficient and robust approximate nearest neighbor search using 
 *        Hierarchical Navigable Small World graphs" (Malkov & Yashunin, 2018)
 *
 * 核心思想:
 *   - 贪婪搜索只维护一个当前最近点，容易陷入局部最优
 *   - ef-search 同时维护 ef 个候选，通过广度探索提高召回率
 *
 * 数据结构:
 *   - W: 动态候选集 (大小最多 ef)，按距离排序，保存当前找到的最近邻
 *   - C: 待检查队列 (priority queue)，按距离排序
 *   - visited: 哈希/数组标记已访问节点，避免重复处理
 *
 * 算法流程:
 *   1. 初始化 W={entry}, C={entry}, visited={entry}
 *   2. while C 非空:
 *      a. 从 C 弹出最近点 c
 *      b. 找到 W 中最远点 f
 *      c. 如果 dist(c) > dist(f): break (无法改进)
 *      d. 遍历 c 的邻居 e:
 *         - 如果 e ∉ visited:
 *           * 标记 visited
 *           * 找到 W 中最远点 f
 *           * 如果 dist(e) < dist(f) 或 |W| < ef:
 *             · 将 e 插入 W 和 C
 *             · 如果 |W| > ef: 从 W 移除最远点
 *   3. 返回 W (大小为 ef 的候选集)
 *
 * 复杂度: O(ef * M * log(ef))，其中 M 为每层最大连接数
 * ═══════════════════════════════════════════════════════════════════════════ */

/* 最小堆元素：用于 ef-search 的优先队列 */
typedef struct {
    HnswNode* node;
    float dist;
    int is_candidate;  /* 1=在候选集W中, 0=只在待检查集C中 */
} EfSearchItem;

/*  ef-search 比较函数：用于最小堆 (距离小的在前)  */
static int ef_item_compare(const void* a, const void* b)
{
    const EfSearchItem* ia = (const EfSearchItem*)a;
    const EfSearchItem* ib = (const EfSearchItem*)b;
    if (ia->dist < ib->dist) return -1;
    if (ia->dist > ib->dist) return 1;
    return 0;
}

/* 完整 ef-search 实现：返回找到的候选数量，结果写入 out_results */
static int hnsw_search_layer_ef_full(HnswIndex* idx, HnswNode* entry,
                                     const float* query, int level, int ef,
                                     HnswNode** out_results, float* out_dists)
{
    /* ═══ 初始化 ═══ */
    int max_visited = idx->node_count + 16;  /* 留点余量 */
    
    /* visited 集合：使用动态数组 + 线性查找 (小数据集够用，大数据可改哈希) */
    HnswNode** visited = (HnswNode**)calloc(max_visited, sizeof(HnswNode*));
    int visited_count = 0;
    
    /* W (候选集) 和 C (待检查队列)：使用简单数组 + 插入排序
     * 注意：生产环境可换成二叉堆或 fibonacci heap */
    EfSearchItem* W = (EfSearchItem*)malloc(ef * sizeof(EfSearchItem));
    EfSearchItem* C = (EfSearchItem*)malloc(ef * 2 * sizeof(EfSearchItem));  /* C 可能临时膨胀 */
    int W_count = 0, C_count = 0;
    
    float entry_dist = vec_distance(entry->embedding, query, idx->dim);
    
    /* 初始化：entry 同时加入 W, C, visited */
    W[W_count++] = (EfSearchItem){entry, entry_dist, 1};
    C[C_count++] = (EfSearchItem){entry, entry_dist, 1};
    visited[visited_count++] = entry;
    
    /* ═══ 主循环 ═══ */
    while (C_count > 0) {
        /* 从 C 中找到并移除距离最小的点 c */
        int c_idx = 0;
        for (int i = 1; i < C_count; i++) {
            if (C[i].dist < C[c_idx].dist) c_idx = i;
        }
        EfSearchItem c_item = C[c_idx];
        /* 从 C 中移除 (用最后一个元素覆盖) */
        C[c_idx] = C[--C_count];
        
        /* 找到 W 中最远的点 f */
        float f_dist = W[0].dist;
        for (int i = 1; i < W_count; i++) {
            if (W[i].dist > f_dist) f_dist = W[i].dist;
        }
        
        /* 终止条件：如果 c 比 W 中最远的还远，无法改进 */
        if (c_item.dist > f_dist) break;
        
        /* 遍历 c 的邻居 */
        HnswNode* c_node = c_item.node;
        for (int ni = 0; ni < c_node->neighbor_counts[level]; ni++) {
            HnswNode* e = (HnswNode*)c_node->neighbors[level][ni];
            if (!e) continue;
            
            /* 检查是否访问过 */
            int already_visited = 0;
            for (int vi = 0; vi < visited_count; vi++) {
                if (visited[vi] == e) { already_visited = 1; break; }
            }
            if (already_visited) continue;
            
            /* 标记已访问 */
            if (visited_count < max_visited) {
                visited[visited_count++] = e;
            }
            
            /* 计算距离 */
            float e_dist = vec_distance(e->embedding, query, idx->dim);
            
            /* 找到当前 W 中最远的点 */
            float w_max_dist = W[0].dist;
            int w_max_idx = 0;
            for (int i = 1; i < W_count; i++) {
                if (W[i].dist > w_max_dist) {
                    w_max_dist = W[i].dist;
                    w_max_idx = i;
                }
            }
            
            /* 如果 e 比 W 中最远的近，或 W 还没满，则加入 */
            if (e_dist < w_max_dist || W_count < ef) {
                /* 加入 W */
                if (W_count < ef) {
                    W[W_count++] = (EfSearchItem){e, e_dist, 1};
                } else {
                    /* 替换 W 中最远的 */
                    W[w_max_idx] = (EfSearchItem){e, e_dist, 1};
                }
                
                /* 同时加入 C 继续探索 */
                if (C_count < ef * 2) {
                    C[C_count++] = (EfSearchItem){e, e_dist, 0};
                }
            }
        }
    }
    
    /* ═══ 输出结果 ═══ */
    /* 按距离排序 W */
    for (int i = 0; i < W_count - 1; i++) {
        for (int j = i + 1; j < W_count; j++) {
            if (W[j].dist < W[i].dist) {
                EfSearchItem tmp = W[i];
                W[i] = W[j];
                W[j] = tmp;
            }
        }
    }
    
    /* 复制到输出 */
    int result_count = W_count;
    for (int i = 0; i < result_count; i++) {
        out_results[i] = W[i].node;
        out_dists[i] = W[i].dist;
    }
    
    /* 清理 */
    free(visited);
    free(W);
    free(C);
    
    return result_count;
}

/* 简化接口：ef-search 返回最近的一个 (兼容旧接口) */
static HnswNode* hnsw_search_layer_ef(HnswIndex* idx, HnswNode* entry,
                                      const float* query, int level, int ef)
{
    HnswNode* results[1];
    float dists[1];
    int found = hnsw_search_layer_ef_full(idx, entry, query, level, ef, results, dists);
    return (found > 0) ? results[0] : entry;
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

/* ═══════════════════════════════════════════════════════════════════════════
 * P2: 启发式邻居选择 —— 多样性优化
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 问题背景:
 *   原始 HNSW 在选择邻居时，简单地取最近的 M 个节点。这会导致：
 *   - 图连通性虽好，但搜索时容易陷入局部最优
 *   - 邻居之间高度重叠，减少有效搜索路径
 *
 * 算法: Heuristic Neighbor Selection (HNSW 论文 Algorithm 2)
 *
 * 核心思想:
 *   不仅考虑候选点到查询点 q 的距离，还考虑候选点之间的相互距离。
 *   优先保留与已选集合距离较远的点，提高图的全局连通性和多样性。
 *
 * 算法流程 (select_neighbors_heuristic):
 *   输入: 查询点 q, 候选集 candidates, 数量 M, 层数 level
 *   输出: 选中的 M 个邻居
 *
 *   1. 按距离排序 candidates
 *   2. R ← [] (结果集), W ← candidates (工作队列)
 *   3. while |R| < M 且 W 非空:
 *      a. 从 W 弹出最近的点 c
 *      b. 检查多样性: c 应该与 R 中所有点保持一定距离
 *         - 计算 min_dist(c, R) = min{dist(c, r) for r in R}
 *         - 如果 R 为空 或 min_dist(c, R) > α * dist(c, q): 
 *           * 将 c 加入 R (保留，因为与已选点差异大)
 *         - 否则:
 *           * 如果 |R| < M/2: 仍然加入 (保证最小连通性)
 *   4. 如果 |R| < M: 从 W 剩余元素补齐 (保证连通性)
 *   5. 返回 R
 *
 * 参数 α (extend_candidates_factor):
 *   - α = 0: 只考虑距离 q 的远近，等同原始算法
 *   - α = 1.0: 严格多样性检查 (默认)
 *   - α > 1.0: 更激进的多样性选择，可能牺牲精度
 *
 * 复杂度: O(M * |candidates|)，由于 M 很小(通常 16-32)，实际开销可忽略
 * ═══════════════════════════════════════════════════════════════════════════ */

typedef struct {
    HnswNode* node;
    float dist_to_q;      /* 到查询点的距离 */
    float min_dist_to_R;  /* 到已选集合的最小距离 */
} NeighborCandidate;

/* 启发式邻居选择主函数 */
static void select_neighbors_heuristic(HnswIndex* idx, 
                                        const float* query,
                                        HnswNode** candidates,
                                        float* candidate_dists,
                                        int candidate_count,
                                        int M,
                                        HnswNode** out_selected,
                                        int* out_selected_count)
{
    if (candidate_count <= M) {
        /* 候选不够，全部选中 */
        for (int i = 0; i < candidate_count; i++) {
            out_selected[i] = candidates[i];
        }
        *out_selected_count = candidate_count;
        return;
    }
    
    /* 按距离排序候选 (简单冒泡，因为数量不多) */
    NeighborCandidate* work = (NeighborCandidate*)malloc(candidate_count * sizeof(NeighborCandidate));
    for (int i = 0; i < candidate_count; i++) {
        work[i].node = candidates[i];
        work[i].dist_to_q = candidate_dists[i];
        work[i].min_dist_to_R = 0.0f;
    }
    
    for (int i = 0; i < candidate_count - 1; i++) {
        for (int j = i + 1; j < candidate_count; j++) {
            if (work[j].dist_to_q < work[i].dist_to_q) {
                NeighborCandidate tmp = work[i];
                work[i] = work[j];
                work[j] = tmp;
            }
        }
    }
    
    /* 启发式选择 */
    HnswNode** R = (HnswNode**)malloc(M * sizeof(HnswNode*));
    int R_count = 0;
    int* selected_flags = (int*)calloc(candidate_count, sizeof(int));
    
    const float ALPHA = 1.0f;  /* 多样性因子，可配置 */
    const int MIN_GUARANTEE = M / 2;  /* 至少保证一半连通性 */
    
    for (int i = 0; i < candidate_count && R_count < M; i++) {
        if (selected_flags[i]) continue;
        
        HnswNode* c = work[i].node;
        float dist_cq = work[i].dist_to_q;
        
        /* 计算到已选集合的最小距离 */
        float min_dist_to_selected = 2.0f;  /* 最大距离为 2 (余弦距离) */
        for (int j = 0; j < R_count; j++) {
            float d = vec_distance(c->embedding, R[j]->embedding, idx->dim);
            if (d < min_dist_to_selected) min_dist_to_selected = d;
        }
        
        /* 启发式决策:
         * 1. 如果 R 为空，直接加入
         * 2. 如果与已选集合距离足够远 (多样性)，加入
         * 3. 如果还没满足最小连通性保证，加入
         */
        int should_select = 0;
        if (R_count == 0) {
            should_select = 1;
        } else if (min_dist_to_selected > ALPHA * dist_cq) {
            /* 多样性检查通过：与已选点距离大于 α * dist(c,q) */
            should_select = 1;
        } else if (R_count < MIN_GUARANTEE) {
            /* 连通性保证：至少选 M/2 个最近的 */
            should_select = 1;
        }
        
        if (should_select) {
            R[R_count++] = c;
            selected_flags[i] = 1;
        }
    }
    
    /* 如果选不够 M 个，从剩余候选补齐 */
    for (int i = 0; i < candidate_count && R_count < M; i++) {
        if (!selected_flags[i]) {
            R[R_count++] = work[i].node;
        }
    }
    
    /* 输出 */
    *out_selected_count = R_count;
    for (int i = 0; i < R_count; i++) {
        out_selected[i] = R[i];
    }
    
    /* 清理 */
    free(work);
    free(R);
    free(selected_flags);
}

/* ─── HNSW K-NN 搜索 (使用 ef-search) ───────────────────── */

static int hnsw_knn_search(HnswIndex* idx, const float* query, int k,
                            HnswNode** results, float* distances)
{
    if (!idx->entry_point) return 0;
    
    HnswNode* curr_entry = hnsw_index_find_node(idx, idx->entry_point);
    if (!curr_entry) return 0;
    
    int max_level = curr_entry->max_level;
    
    /* ═══ P3 优化：使用 ef-search 替代贪婪搜索 ═══
     * 
     * 原始代码使用贪婪搜索，每层只返回一个最近点，容易局部最优。
     * 使用 ef_search 参数，在顶层向下传播时保持 ef 个候选，
     * 显著提高搜索质量和召回率。
     */
    
    /* 高层使用 ef_search 进行多候选搜索，结果作为下一层入口 */
    HnswNode** layer_results = (HnswNode**)malloc(idx->ef_search * sizeof(HnswNode*));
    float* layer_dists = (float*)malloc(idx->ef_search * sizeof(float));
    
    for (int lc = max_level; lc >= 1; lc--) {
        int found = hnsw_search_layer_ef_full(idx, curr_entry, query, lc, 
                                               idx->ef_search, layer_results, layer_dists);
        if (found > 0) {
            /* 使用最近的结果作为下一层入口 */
            curr_entry = layer_results[0];
        }
    }
    
    free(layer_results);
    free(layer_dists);
    
    /* ═══ 第 0 层使用 ef-search 收集最终候选 ═══
     * 第 0 层包含所有节点，使用 ef_search 收集足够候选后取前 k
     */
    HnswNode** final_results = (HnswNode**)malloc(idx->ef_search * sizeof(HnswNode*));
    float* final_dists = (float*)malloc(idx->ef_search * sizeof(float));
    
    int final_found = hnsw_search_layer_ef_full(idx, curr_entry, query, 0,
                                                 idx->ef_search, final_results, final_dists);
    
    /* 取前 k 个作为最终结果 */
    int count = (final_found < k) ? final_found : k;
    for (int i = 0; i < count; i++) {
        results[i] = final_results[i];
        distances[i] = final_dists[i];
    }
    
    free(final_results);
    free(final_dists);
    
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
        
        /* ═══ P2 + P3: 优化的邻居选择和连接 ═══
         *
         * 原实现问题:
         *   1. 只使用贪婪搜索，每层只找一个最近点
         *   2. 邻居选择简单，没有考虑多样性
         *   3. 只是机械地收集邻居的邻居，没有策略
         *
         * 优化方案:
         *   1. 使用 ef-search 收集 ef_construction 个候选 (P3)
         *   2. 使用启发式选择从中挑选最多 M 个多样性邻居 (P2)
         *   3. 建立双向连接，保证图的无向性
         */
        
        HnswNode* ep_w = curr_ep;
        for (int lc = (max_level < ep_level ? max_level : ep_level); lc >= 0; lc--) {
            /* ═══ Step 1: ef-search 收集候选 (P3) ═══
             * 使用 ef_construction 参数进行多候选搜索，
             * 返回该层上距离最近的 ef_construction 个节点
             */
            HnswNode** ef_results = (HnswNode**)malloc(idx->ef_construction * sizeof(HnswNode*));
            float* ef_dists = (float*)malloc(idx->ef_construction * sizeof(float));
            
            int ef_found = hnsw_search_layer_ef_full(idx, ep_w, node->embedding, lc, 
                                                      idx->ef_construction, ef_results, ef_dists);
            
            /* 过滤掉自己 */
            int valid_count = 0;
            for (int i = 0; i < ef_found; i++) {
                if (ef_results[i] != node) valid_count++;
            }
            
            if (valid_count > 0) {
                /* 准备候选数组 */
                HnswNode** candidates = (HnswNode**)malloc(valid_count * sizeof(HnswNode*));
                float* candidate_dists = (float*)malloc(valid_count * sizeof(float));
                
                int ci = 0;
                for (int i = 0; i < ef_found; i++) {
                    if (ef_results[i] != node) {
                        candidates[ci] = ef_results[i];
                        candidate_dists[ci] = ef_dists[i];
                        ci++;
                    }
                }
                
                /* ═══ Step 2: 启发式邻居选择 (P2) ═══
                 * 从候选中选择最多 M 个邻居，兼顾距离和多样性
                 * 参考 HNSW 论文 Algorithm 2: heuristic selection
                 */
                HnswNode** selected = (HnswNode**)malloc(idx->M * sizeof(HnswNode*));
                int selected_count = 0;
                
                select_neighbors_heuristic(idx, node->embedding, 
                                            candidates, candidate_dists, valid_count,
                                            idx->M, selected, &selected_count);
                
                /* ═══ Step 3: 建立双向连接 ═══
                 * 对新节点：添加 selected 作为邻居
                 * 对已有节点：反向添加新节点作为邻居
                 */
                for (int si = 0; si < selected_count; si++) {
                    HnswNode* neighbor = selected[si];
                    
                    /* 双向连接 */
                    hnsw_node_add_neighbor(node, lc, neighbor);
                    hnsw_node_add_neighbor(neighbor, lc, node);
                    
                    /* ═══ Step 4: 邻居剪枝 (Shrink) ═══
                     * 如果邻居的连接数超过 M，也需要用启发式方法剪枝
                     * 这是 HNSW 保持稀疏图的关键
                     */
                    if (neighbor->neighbor_counts[lc] > idx->M) {
                        /* 收集邻居的所有邻居作为候选 */
                        int nb_nc = neighbor->neighbor_counts[lc];
                        HnswNode** nb_cands = (HnswNode**)malloc(nb_nc * sizeof(HnswNode*));
                        float* nb_dists = (float*)malloc(nb_nc * sizeof(float));
                        
                        for (int ni = 0; ni < nb_nc; ni++) {
                            HnswNode* nn = (HnswNode*)neighbor->neighbors[lc][ni];
                            nb_cands[ni] = nn;
                            nb_dists[ni] = vec_distance(neighbor->embedding, nn->embedding, idx->dim);
                        }
                        
                        /* 启发式选择保留的邻居 */
                        HnswNode** nb_selected = (HnswNode**)malloc(idx->M * sizeof(HnswNode*));
                        int nb_sel_count = 0;
                        
                        select_neighbors_heuristic(idx, neighbor->embedding,
                                                    nb_cands, nb_dists, nb_nc,
                                                    idx->M, nb_selected, &nb_sel_count);
                        
                        /* 重建邻居列表 */
                        /* 注意：简单实现是直接清空后重建，生产环境可用更高效的 swap-remove */
                        for (int ni = 0; ni < nb_nc; ni++) {
                            neighbor->neighbors[lc][ni] = NULL;
                        }
                        neighbor->neighbor_counts[lc] = 0;
                        
                        for (int ni = 0; ni < nb_sel_count; ni++) {
                            neighbor->neighbors[lc][ni] = (struct HnswNode*)nb_selected[ni];
                        }
                        neighbor->neighbor_counts[lc] = nb_sel_count;
                        
                        free(nb_cands);
                        free(nb_dists);
                        free(nb_selected);
                    }
                }
                
                /* 更新下一层入口点：使用最近的那个 */
                if (selected_count > 0) {
                    ep_w = selected[0];
                }
                
                free(candidates);
                free(candidate_dists);
                free(selected);
            }
            
            free(ef_results);
            free(ef_dists);
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
