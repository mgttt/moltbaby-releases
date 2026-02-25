/**
 * test-cosine-sim-parse.js — 验证 COSINE_SIM SQL 解析
 *
 * 运行: ./zig-out/bin/ndtsdb-cli tests/test-cosine-sim-parse.js
 */

// ==================== Mock parseSQL ====================
// 从 cmd_sql.c 抽取的 parseSQL 函数（简化版，仅测试 COSINE_SIM 解析）

function smartSplit(str) {
    var r=[],d=0,c='';
    for(var i=0;i<str.length;i++){
        var ch=str[i];
        if(ch==='('){d++;c+=ch;}
        else if(ch===')'){d--;c+=ch;}
        else if(ch===','&&d===0){if(c.trim())r.push(c.trim());c='';}
        else{c+=ch;}
    }
    if(c.trim())r.push(c.trim());
    return r;
}

function parseSQL(sql) {
    const result = { 
        fields: [], 
        table: null, 
        where: { filter: null } 
    };
    
    const normalizedSQL = sql.trim().replace(/\s+/g, ' ');
    const upperSQL = normalizedSQL.toUpperCase();
    
    const fromMatch = upperSQL.match(/FROM\s+(\w+)/i);
    if (!fromMatch) throw new Error('Invalid SQL: expected FROM clause');
    result.table = fromMatch[1];
    
    const whereClauseIndex = upperSQL.indexOf(' WHERE ');
    if (whereClauseIndex !== -1) {
        const whereClause = normalizedSQL.substring(whereClauseIndex + 7).trim();
        
        const cosineMatch = whereClause.match(/COSINE_SIM\s*\(\s*(\w+)\s*,\s*\[([^\]]+)\]\s*\)\s*([><=]+)\s*([\d.]+)/i);
        if (cosineMatch) {
            result.where.filter = {
                type: 'COSINE_SIM',
                field: cosineMatch[1],
                query_vector: cosineMatch[2].split(',').map(x => parseFloat(x.trim())),
                operator: cosineMatch[3],
                threshold: parseFloat(cosineMatch[4])
            };
        }
    }
    
    return result;
}

// ==================== cosine_sim 实现 ====================

function cosine_sim(vec_a, vec_b) {
    if (!vec_a || !vec_b) return 0;
    if (vec_a.length !== vec_b.length) return 0;
    let dot = 0, norm_a = 0, norm_b = 0;
    for (let i = 0; i < vec_a.length; i++) {
        dot += vec_a[i] * vec_b[i];
        norm_a += vec_a[i] * vec_a[i];
        norm_b += vec_b[i] * vec_b[i];
    }
    if (norm_a === 0 || norm_b === 0) return 0;
    return dot / (Math.sqrt(norm_a) * Math.sqrt(norm_b));
}

// ==================== 测试 ====================

let pass = 0, fail = 0;

function CHECK(cond, msg) {
    if (cond) { 
        console.log('  ✓ ' + msg); 
        pass++; 
    } else { 
        console.log('  ✗ ' + msg); 
        fail++; 
    }
}

function test_parse_basic() {
    console.log('\n[1] 基本 COSINE_SIM 解析');
    const sql = "SELECT * FROM vectors WHERE COSINE_SIM(embedding, [0.1, 0.2, 0.3]) > 0.8";
    const parsed = parseSQL(sql);
    
    CHECK(parsed.table === 'vectors', 'table=vectors');
    CHECK(parsed.where.filter !== null, 'filter not null');
    CHECK(parsed.where.filter.type === 'COSINE_SIM', 'type=COSINE_SIM');
    CHECK(parsed.where.filter.field === 'embedding', 'field=embedding');
    CHECK(parsed.where.filter.query_vector.length === 3, 'query_vector.length=3');
    CHECK(Math.abs(parsed.where.filter.query_vector[0] - 0.1) < 1e-6, 'query_vector[0]=0.1');
    CHECK(parsed.where.filter.operator === '>', 'operator=>');
    CHECK(Math.abs(parsed.where.filter.threshold - 0.8) < 1e-6, 'threshold=0.8');
}

function test_parse_operators() {
    console.log('\n[2] 不同运算符');
    
    const tests = [
        { sql: "SELECT * FROM v WHERE COSINE_SIM(emb, [1]) >= 0.9", op: '>=' },
        { sql: "SELECT * FROM v WHERE COSINE_SIM(emb, [1]) < 0.5", op: '<' },
        { sql: "SELECT * FROM v WHERE COSINE_SIM(emb, [1]) <= 0.3", op: '<=' },
        { sql: "SELECT * FROM v WHERE COSINE_SIM(emb, [1]) = 0.95", op: '=' }
    ];
    
    for (const t of tests) {
        const parsed = parseSQL(t.sql);
        CHECK(parsed.where.filter.operator === t.op, `operator=${t.op}`);
    }
}

function test_cosine_sim_function() {
    console.log('\n[3] cosine_sim 函数');
    
    const a = [1, 0, 0];
    const b = [1, 0, 0];
    const c = [0, 1, 0];
    const d = [-1, 0, 0];
    
    const sim_aa = cosine_sim(a, b);
    const sim_ac = cosine_sim(a, c);
    const sim_ad = cosine_sim(a, d);
    
    CHECK(Math.abs(sim_aa - 1.0) < 1e-6, 'identical vectors sim=1.0');
    CHECK(Math.abs(sim_ac - 0.0) < 1e-6, 'orthogonal vectors sim=0.0');
    CHECK(Math.abs(sim_ad - (-1.0)) < 1e-6, 'opposite vectors sim=-1.0');
}

function test_filter_logic() {
    console.log('\n[4] 过滤逻辑模拟');
    
    // Mock data: vectors with 3D embeddings
    const data = [
        { id: 1, embedding: [1.0, 0.0, 0.0] },    // sim=1.0
        { id: 2, embedding: [0.8, 0.6, 0.0] },    // sim=0.8
        { id: 3, embedding: [0.0, 1.0, 0.0] },    // sim=0.0
        { id: 4, embedding: [-1.0, 0.0, 0.0] }    // sim=-1.0
    ];
    
    const query_vector = [1.0, 0.0, 0.0];
    const threshold = 0.7;
    
    const filtered = data.filter(row => {
        const sim = cosine_sim(row.embedding, query_vector);
        return sim > threshold;
    });
    
    CHECK(filtered.length === 2, 'filtered 2 vectors (>0.7)');
    CHECK(filtered[0].id === 1, 'id=1 in result');
    CHECK(filtered[1].id === 2, 'id=2 in result');
}

// ==================== 运行测试 ====================

console.log('=== COSINE_SIM SQL 解析测试 ===');

test_parse_basic();
test_parse_operators();
test_cosine_sim_function();
test_filter_logic();

console.log('\n================================');
console.log('结果: ' + pass + ' passed, ' + fail + ' failed');
console.log('================================');

if (fail > 0) throw new Error('Test failed');
