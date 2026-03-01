/**
 * cosine_sim.c — 余弦相似度计算实现
 *
 * 当前实现：标量版本（便携）
 * TODO: AVX2/NEON SIMD 优化（Phase 3）
 */

#include "cosine_sim.h"
#include <math.h>

float cosine_similarity(const float* vec_a, const float* vec_b, size_t dim)
{
    if (!vec_a || !vec_b || dim == 0) return 0.0f;

    float dot = 0.0f;
    float norm_a = 0.0f;
    float norm_b = 0.0f;

    /* 4路展开优化 */
    size_t i = 0;
    for (; i + 4 <= dim; i += 4) {
        float a0 = vec_a[i],     a1 = vec_a[i+1], a2 = vec_a[i+2], a3 = vec_a[i+3];
        float b0 = vec_b[i],     b1 = vec_b[i+1], b2 = vec_b[i+2], b3 = vec_b[i+3];
        dot    += a0*b0 + a1*b1 + a2*b2 + a3*b3;
        norm_a += a0*a0 + a1*a1 + a2*a2 + a3*a3;
        norm_b += b0*b0 + b1*b1 + b2*b2 + b3*b3;
    }
    /* 处理剩余 */
    for (; i < dim; i++) {
        dot    += vec_a[i] * vec_b[i];
        norm_a += vec_a[i] * vec_a[i];
        norm_b += vec_b[i] * vec_b[i];
    }

    if (norm_a == 0.0f || norm_b == 0.0f) return 0.0f;
    return dot / (sqrtf(norm_a) * sqrtf(norm_b));
}

size_t cosine_similarity_batch(const float* query_vec,
                               const float* target_vecs,
                               size_t n,
                               size_t dim,
                               float* out_sims)
{
    if (!query_vec || !target_vecs || !out_sims || n == 0 || dim == 0)
        return 0;

    for (size_t i = 0; i < n; i++) {
        out_sims[i] = cosine_similarity(query_vec, target_vecs + i * dim, dim);
    }
    return n;
}
