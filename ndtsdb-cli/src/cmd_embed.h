// cmd_embed.h - 轻量 embedding 生成器接口

#ifndef CMD_EMBED_H
#define CMD_EMBED_H

// 生成文本的 embedding 向量
// text: 输入文本
// embedding: 输出向量（调用者分配，dim个float）
// dim: 向量维度（建议64或128）
// 返回: 0成功，-1失败
int embed_generate(const char* text, float* embedding, int dim);

// 计算两个embedding向量的余弦相似度
// a, b: 输入向量
// dim: 向量维度
// 返回: 相似度[-1, 1]，越接近1越相似
float embed_cosine_similarity(const float* a, const float* b, int dim);

// CLI命令实现
int cmd_embed(int argc, char** argv);

#endif // CMD_EMBED_H
