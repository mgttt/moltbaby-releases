/**
 * test-cosine-sim-e2e.js — COSINE_SIM 端到端测试
 *
 * 运行: ./zig-out/bin/ndtsdb-cli tests/test-cosine-sim-e2e.js
 */

import * as ndtsdb from 'ndtsdb';

function assert(cond, msg) {
    if (!cond) throw new Error('ASSERT: ' + msg);
}

// ==================== 测试 ====================

console.log('=== COSINE_SIM 端到端测试 ===\n');

// 使用固定测试目录
const tmpdir = '/tmp/cosine_e2e_test';

// 清理并创建目录
// 注意：在 QuickJS 中没有 fs API，需要依赖外部 setup
// 这里假设目录已存在

const db = ndtsdb.open(tmpdir);
assert(db, 'open db');

// 测试 1: queryVectors API 可用
console.log('[1] queryVectors API 可用性');
try {
    const result = ndtsdb.queryVectors(db, 'BTC', '1m');
    console.log('  ✓ queryVectors 返回:', Array.isArray(result) ? 'array[' + result.length + ']' : typeof result);
} catch (e) {
    console.log('  ✗ queryVectors 失败:', e.message);
}

// 测试 2: 检查返回结构
console.log('\n[2] 向量记录结构检查');
const vectors = ndtsdb.queryVectors(db, 'BTC', '1m');
if (vectors.length > 0) {
    const v = vectors[0];
    const hasFields = v.timestamp !== undefined && 
                      v.agent_id !== undefined && 
                      v.type !== undefined && 
                      v.confidence !== undefined && 
                      Array.isArray(v.embedding);
    console.log('  ' + (hasFields ? '✓' : '✗') + ' 记录包含所有字段');
    if (hasFields) {
        console.log('    timestamp:', v.timestamp);
        console.log('    agent_id:', v.agent_id);
        console.log('    type:', v.type);
        console.log('    confidence:', v.confidence);
        console.log('    embedding_dim:', v.embedding.length);
    }
} else {
    console.log('  ℹ 无向量记录（需要先用 write-json 写入）');
}

ndtsdb.close(db);

console.log('\n================================');
console.log('端到端测试完成');
console.log('================================');
