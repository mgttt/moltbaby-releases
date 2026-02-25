// cmd_embed.c - 轻量 embedding 生成器
// TF-IDF + hash trick，纯C实现，无外部依赖

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <math.h>
#include <stdint.h>
#include <stdbool.h>
#include "cmd_embed.h"

#define MAX_TEXT_LEN 4096
#define MAX_TOKENS 1024
#define NUM_HASH_SEEDS 4
// 基础贡献数 - 会根据维度动态调整

// 多哈希种子 - 每个token将贡献到多个维度
static const uint32_t HASH_SEEDS[NUM_HASH_SEEDS] = {
    0x9e3779b9, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f
};

// MurmurHash3 32bit 变体 - 更好的分布
static uint32_t hash32_seed(const char* key, size_t len, uint32_t seed) {
    uint32_t h = seed;
    const uint8_t* data = (const uint8_t*)key;
    
    // 混合4字节块
    while (len >= 4) {
        uint32_t k = *(uint32_t*)data;
        k *= 0xcc9e2d51;
        k = (k << 15) | (k >> 17);
        k *= 0x1b873593;
        
        h ^= k;
        h = (h << 13) | (h >> 19);
        h = h * 5 + 0xe6546b64;
        
        data += 4;
        len -= 4;
    }
    
    // 处理剩余字节
    uint32_t k = 0;
    switch (len) {
        case 3: k ^= data[2] << 16;
        case 2: k ^= data[1] << 8;
        case 1: k ^= data[0];
                k *= 0xcc9e2d51;
                k = (k << 15) | (k >> 17);
                k *= 0x1b873593;
                h ^= k;
    }
    
    // 最终化
    h ^= len;
    h ^= h >> 16;
    h *= 0x85ebca6b;
    h ^= h >> 13;
    h *= 0xc2b2ae35;
    h ^= h >> 16;
    
    return h;
}

// 兼容性保留
static uint32_t hash32(const char* key, size_t len) {
    return hash32_seed(key, len, HASH_SEEDS[0]);
}

// 分词：空格+标点分割，支持中文（UTF-8多字节字符）
static int tokenize(const char* text, char tokens[][64], int max_tokens) {
    int count = 0;
    const char* p = text;
    char buffer[64];
    int buf_idx = 0;
    
    while (*p && count < max_tokens) {
        unsigned char c = (unsigned char)*p;
        
        // UTF-8多字节字符（中文等）
        if (c >= 0x80) {
            // 处理UTF-8多字节序列
            int seq_len = 0;
            if ((c & 0xF0) == 0xF0) seq_len = 4;      // 4字节
            else if ((c & 0xE0) == 0xE0) seq_len = 3; // 3字节（中文常用）
            else if ((c & 0xC0) == 0xC0) seq_len = 2; // 2字节
            
            if (seq_len > 0 && buf_idx + seq_len < 63) {
                // 结束之前的token（如果有）
                if (buf_idx > 0) {
                    buffer[buf_idx] = '\0';
                    strncpy(tokens[count], buffer, 63);
                    tokens[count][63] = '\0';
                    count++;
                    buf_idx = 0;
                }
                // 将UTF-8字符作为独立token
                for (int i = 0; i < seq_len && *p; i++) {
                    buffer[i] = *p++;
                }
                buffer[seq_len] = '\0';
                strncpy(tokens[count], buffer, 63);
                tokens[count][63] = '\0';
                count++;
                continue;  // p已经移动，跳过p++
            }
        }
        // ASCII字母数字下划线
        else if (isalnum(c) || c == '_') {
            if (buf_idx < 63) {
                buffer[buf_idx++] = tolower(c);
            }
        }
        // 分隔符（空格、标点等）
        else {
            if (buf_idx > 0) {
                buffer[buf_idx] = '\0';
                strncpy(tokens[count], buffer, 63);
                tokens[count][63] = '\0';
                count++;
                buf_idx = 0;
            }
        }
        p++;
    }
    
    // 处理最后一个token
    if (buf_idx > 0 && count < max_tokens) {
        buffer[buf_idx] = '\0';
        strncpy(tokens[count], buffer, 63);
        tokens[count][63] = '\0';
        count++;
    }
    
    return count;
}

// 计算 TF - 改进版：unigram + bigram + 字符级特征 + 动态贡献
// 目标：在任何维度下都能达到约50%非零值，同时保持区分度
static void compute_tf(char tokens[][64], int token_count, 
                       float* tf, int dim, const char* original_text) {
    // 初始化
    for (int i = 0; i < dim; i++) {
        tf[i] = 0.0f;
    }
    
    // 贡献计数（用于TF归一化）
    int total_contributions = 0;
    
    // 动态计算贡献数：目标是覆盖约60%的维度
    // 估计总特征数：tokens + bigrams + chars ≈ 2*tokens + text_len
    int text_len = (int)strlen(original_text);
    int estimated_features = token_count * 2 + text_len;
    if (estimated_features < 1) estimated_features = 1;
    // 每个特征贡献的维度 = 目标覆盖维度 / 特征数
    int target_coverage = dim * 6 / 10;  // 60%覆盖
    int contrib_per_feature = target_coverage / estimated_features;
    if (contrib_per_feature < 4) contrib_per_feature = 4;
    if (contrib_per_feature > dim/8) contrib_per_feature = dim/8;  // 上限：不超过维度的1/8
    
    // unigram: 每个token贡献
    for (int i = 0; i < token_count; i++) {
        size_t len = strlen(tokens[i]);
        for (int k = 0; k < contrib_per_feature; k++) {
            // 使用不同种子产生分散的维度
            uint32_t h = hash32_seed(tokens[i], len, HASH_SEEDS[k % NUM_HASH_SEEDS] ^ (k * 0x9e3779b9));
            int idx = h % dim;
            tf[idx] += 1.0f;
            total_contributions++;
        }
    }
    
    // bigram: 相邻token对贡献（顺序敏感）
    for (int i = 0; i < token_count - 1; i++) {
        char bigram[128];
        snprintf(bigram, sizeof(bigram), "%s|%s", tokens[i], tokens[i+1]);
        size_t len = strlen(bigram);
        for (int k = 0; k < contrib_per_feature; k++) {
            uint32_t h = hash32_seed(bigram, len, HASH_SEEDS[k % NUM_HASH_SEEDS] ^ 0xdeadbeef ^ (k * 0x9e3779b9));
            int idx = h % dim;
            tf[idx] += 1.5f;  // bigram权重更高
            total_contributions++;
        }
    }
    
    // 字符级特征：区分ASCII和UTF-8
    for (size_t i = 0; i < (size_t)text_len; ) {
        unsigned char c = (unsigned char)original_text[i];
        int char_bytes = 1;
        uint32_t char_seed = 0xAAAAAAAA;  // ASCII默认种子
        
        if ((c & 0xE0) == 0xC0) { char_bytes = 2; char_seed = 0x55555555; }
        else if ((c & 0xF0) == 0xE0) { char_bytes = 3; char_seed = 0x55555555; }
        else if ((c & 0xF8) == 0xF0) { char_bytes = 4; char_seed = 0x55555555; }
        
        // 跳过空格
        if (c != ' ') {
            for (int k = 0; k < contrib_per_feature; k++) {
                uint32_t h = hash32_seed(&original_text[i], char_bytes, char_seed ^ (k * 0x87654321));
                int idx = h % dim;
                tf[idx] += 0.7f;
                total_contributions++;
            }
        }
        i += char_bytes;
    }
    
    // 归一化 TF
    if (total_contributions > 0) {
        for (int i = 0; i < dim; i++) {
            tf[i] /= total_contributions;
        }
    }
}

// L2 归一化
static void l2_normalize(float* vec, int dim) {
    float sum_sq = 0.0f;
    for (int i = 0; i < dim; i++) {
        sum_sq += vec[i] * vec[i];
    }
    
    float norm = sqrtf(sum_sq);
    if (norm > 1e-8f) {
        for (int i = 0; i < dim; i++) {
            vec[i] /= norm;
        }
    }
}

// 生成 embedding
int embed_generate(const char* text, float* embedding, int dim) {
    if (!text || !embedding || dim <= 0 || dim > 512) {
        return -1;
    }
    
    char tokens[MAX_TOKENS][64];
    int token_count = tokenize(text, tokens, MAX_TOKENS);
    
    if (token_count == 0) {
        // 空文本，返回零向量
        for (int i = 0; i < dim; i++) {
            embedding[i] = 0.0f;
        }
        return 0;
    }
    
    // 计算 TF（使用 hash trick）
    compute_tf(tokens, token_count, embedding, dim, text);
    
    // L2 归一化
    l2_normalize(embedding, dim);
    
    return 0;
}

// 计算余弦相似度
float embed_cosine_similarity(const float* a, const float* b, int dim) {
    float dot = 0.0f, norm_a = 0.0f, norm_b = 0.0f;
    
    for (int i = 0; i < dim; i++) {
        dot += a[i] * b[i];
        norm_a += a[i] * a[i];
        norm_b += b[i] * b[i];
    }
    
    float denom = sqrtf(norm_a) * sqrtf(norm_b);
    if (denom < 1e-8f) return 0.0f;
    
    return dot / denom;
}

// CLI: embed 命令实现
int cmd_embed(int argc, char** argv) {
    const char* text = NULL;
    int dim = 64;  // 默认64维
    
    // 解析参数
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--text") == 0 && i + 1 < argc) {
            text = argv[++i];
        } else if (strcmp(argv[i], "--dim") == 0 && i + 1 < argc) {
            dim = atoi(argv[++i]);
        }
    }
    
    if (!text) {
        fprintf(stderr, "Usage: ndtsdb-cli embed --text '<text>' [--dim <n>]\n");
        return 1;
    }
    
    if (dim <= 0 || dim > 512) {
        fprintf(stderr, "Error: dim must be between 1 and 512\n");
        return 1;
    }
    
    float* embedding = (float*)malloc(dim * sizeof(float));
    if (!embedding) {
        fprintf(stderr, "Error: failed to allocate memory\n");
        return 1;
    }
    
    if (embed_generate(text, embedding, dim) != 0) {
        fprintf(stderr, "Error: failed to generate embedding\n");
        free(embedding);
        return 1;
    }
    
    // 输出 JSON
    printf("{\"embedding\":[");
    for (int i = 0; i < dim; i++) {
        printf("%.6f", embedding[i]);
        if (i < dim - 1) printf(",");
    }
    printf("]}\n");
    
    free(embedding);
    return 0;
}
