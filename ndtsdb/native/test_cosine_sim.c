/**
 * test_cosine_sim.c — 余弦相似度单元测试
 *
 * 编译: gcc -o test_cosine_sim test_cosine_sim.c cosine_sim.c -lm
 * 运行: ./test_cosine_sim
 */

#include <stdio.h>
#include <math.h>
#include "cosine_sim.h"

#define CHECK(cond, msg) do { \
    if (cond) { printf("  ✓ %s\n", msg); pass++; } \
    else { printf("  ✗ %s (line %d)\n", msg, __LINE__); fail++; } \
} while(0)

#define FCHECK(a, b, eps, msg) CHECK(fabsf((a)-(b)) < (eps), msg)

static int pass = 0, fail = 0;

void test_identical_vectors(void)
{
    printf("\n[1] 相同向量（应返回 1.0）\n");
    float a[] = {1.0f, 2.0f, 3.0f};
    float sim = cosine_similarity(a, a, 3);
    FCHECK(sim, 1.0f, 1e-6f, "identical vectors sim=1.0");
}

void test_orthogonal_vectors(void)
{
    printf("\n[2] 正交向量（应返回 0.0）\n");
    float a[] = {1.0f, 0.0f, 0.0f};
    float b[] = {0.0f, 1.0f, 0.0f};
    float sim = cosine_similarity(a, b, 3);
    FCHECK(sim, 0.0f, 1e-6f, "orthogonal vectors sim=0.0");
}

void test_opposite_vectors(void)
{
    printf("\n[3] 反向向量（应返回 -1.0）\n");
    float a[] = {1.0f, 2.0f, 3.0f};
    float b[] = {-1.0f, -2.0f, -3.0f};
    float sim = cosine_similarity(a, b, 3);
    FCHECK(sim, -1.0f, 1e-6f, "opposite vectors sim=-1.0");
}

void test_normalized_vectors(void)
{
    printf("\n[4] 归一化向量（手动验证）\n");
    float a[] = {0.6f, 0.8f};        /* norm = 1.0 */
    float b[] = {0.8f, 0.6f};        /* norm = 1.0 */
    float sim = cosine_similarity(a, b, 2);
    float expected = 0.6f * 0.8f + 0.8f * 0.6f;  /* dot product = 0.96 */
    FCHECK(sim, expected, 1e-6f, "normalized vectors correct");
}

void test_zero_vector(void)
{
    printf("\n[5] 零向量（应返回 0.0）\n");
    float a[] = {1.0f, 2.0f};
    float b[] = {0.0f, 0.0f};
    float sim = cosine_similarity(a, b, 2);
    FCHECK(sim, 0.0f, 1e-6f, "zero vector sim=0.0");
}

void test_high_dim(void)
{
    printf("\n[6] 高维向量（768D）\n");
    float a[768], b[768];
    for (int i = 0; i < 768; i++) {
        a[i] = (float)i * 0.01f;
        b[i] = (float)i * 0.01f + 0.1f;
    }
    float sim = cosine_similarity(a, b, 768);
    CHECK(sim > 0.99f && sim < 1.0f, "768D vectors high similarity");
}

void test_batch(void)
{
    printf("\n[7] 批量计算\n");
    float query[] = {1.0f, 0.0f};
    float targets[] = {
        1.0f, 0.0f,  /* identical */
        0.0f, 1.0f,  /* orthogonal */
        -1.0f, 0.0f  /* opposite */
    };
    float sims[3];
    size_t n = cosine_similarity_batch(query, targets, 3, 2, sims);
    CHECK(n == 3, "batch computed 3 vectors");
    FCHECK(sims[0], 1.0f, 1e-6f, "batch[0]=1.0");
    FCHECK(sims[1], 0.0f, 1e-6f, "batch[1]=0.0");
    FCHECK(sims[2], -1.0f, 1e-6f, "batch[2]=-1.0");
}

void test_edge_cases(void)
{
    printf("\n[8] 边界情况\n");
    float a[] = {1.0f};
    CHECK(cosine_similarity(NULL, a, 1) == 0.0f, "NULL vec_a");
    CHECK(cosine_similarity(a, NULL, 1) == 0.0f, "NULL vec_b");
    CHECK(cosine_similarity(a, a, 0) == 0.0f, "dim=0");
}

int main(void)
{
    printf("=== cosine_sim 单元测试 ===\n");

    test_identical_vectors();
    test_orthogonal_vectors();
    test_opposite_vectors();
    test_normalized_vectors();
    test_zero_vector();
    test_high_dim();
    test_batch();
    test_edge_cases();

    printf("\n================================\n");
    printf("结果: %d passed, %d failed\n", pass, fail);
    printf("================================\n");

    return fail > 0 ? 1 : 0;
}
