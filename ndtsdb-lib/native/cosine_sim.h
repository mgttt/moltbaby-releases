/**
 * cosine_sim.h — 余弦相似度计算
 *
 * 提供标量和 SIMD 优化版本的余弦相似度计算。
 */
#ifndef COSINE_SIM_H
#define COSINE_SIM_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * cosine_similarity — 标量版本余弦相似度计算
 *
 * @param vec_a    向量 A（float32 数组）
 * @param vec_b    向量 B（float32 数组）
 * @param dim      向量维度
 * @return         余弦相似度 [-1, 1]，维度不匹配或零向量返回 0
 *
 * 计算公式：sim = dot(a, b) / (||a|| × ||b||)
 */
float cosine_similarity(const float* vec_a, const float* vec_b, size_t dim);

/**
 * cosine_similarity_batch — 批量计算查询向量与多个目标向量的相似度
 *
 * @param query_vec    查询向量（float32[dim]）
 * @param target_vecs  目标向量数组（float32[n][dim]，连续存储）
 * @param n            目标向量数量
 * @param dim          向量维度
 * @param out_sims     输出相似度数组（调用方分配，float[n]）
 * @return             计算成功的向量数
 */
size_t cosine_similarity_batch(const float* query_vec,
                               const float* target_vecs,
                               size_t n,
                               size_t dim,
                               float* out_sims);

#ifdef __cplusplus
}
#endif

#endif /* COSINE_SIM_H */
