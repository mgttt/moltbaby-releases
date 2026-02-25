# Embedding 降维实施报告

## 1. 实施内容

### 1.1 generate-embeddings.js
- 添加 `--dims` 参数，默认 256
- Gemini API 请求添加 `outputDimensionality: 256`
- dry-run 模式根据 dims 参数生成对应维度

### 1.2 mem-find/index.ts  
- 添加 `--dims` 参数，默认 256
- 查询 embedding 使用 256 维
- 缓存维度不匹配时重新生成

## 2. 存储对比估算

| 维度 | 每向量大小 | 1万条占用 | 100万条占用 |
|------|-----------|----------|------------|
| 3072 | ~24KB | ~240MB | ~24GB |
| 768  | ~6KB  | ~60MB  | ~6GB  |
| 256  | ~2KB  | ~20MB  | ~2GB  |

**降维收益**: 256维 vs 3072维 = **12倍存储节省**

## 3. 检索质量对比方法

同一查询分别用 256 维和 3072 维 embedding，对比 top-5 结果：

```bash
# 3072 维查询
bun tools/mem-find/index.ts --query "交易系统回撤" --db ~/knowledge --dims 3072

# 256 维查询  
bun tools/mem-find/index.ts --query "交易系统回撤" --db ~/knowledge --dims 256
```

对比指标：
- Score 分布（是否 > 0.7）
- 结果相关性（人工判断）
- 延迟对比

## 4. 待完成

- [ ] ndtsdb-cli serve 修复后实际写入 256 维 embedding
- [ ] 同一查询 256 vs 3072 对比测试
- [ ] 存储占用实际测量

## 5. Commit

- a9e3ee9fc: embedding: add 256-dim support via outputDimensionality
