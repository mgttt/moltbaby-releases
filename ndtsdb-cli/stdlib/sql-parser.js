// sql-parser.js - 简单SQL解析器
// 支持SQL子集：SELECT ... FROM ... WHERE ... LIMIT ...

/**
 * 解析SQL查询，返回结构化对象
 * @param {string} sql - SQL查询语句
 * @returns {Object} 解析结果
 */
export function parseSQL(sql) {
    if (!sql || typeof sql !== 'string') {
        throw new Error('SQL must be a non-empty string');
    }

    const result = {
        fields: [],      // ['*'] 或 ['symbol', 'timestamp', 'close']
        table: null,     // 表名（忽略，仅验证）
        where: {         // WHERE条件
            symbol: null,
            timestampMin: null,
            timestampMax: null
        },
        limit: null      // LIMIT数值
    };

    // 规范化SQL（移除多余空格，转大写用于解析）
    const normalizedSQL = sql.trim().replace(/\s+/g, ' ');
    const upperSQL = normalizedSQL.toUpperCase();

    // 1. 解析 SELECT
    const selectMatch = upperSQL.match(/^SELECT\s+(.+?)\s+FROM\s/i);
    if (!selectMatch) {
        throw new Error('Invalid SQL: expected SELECT ... FROM');
    }

    const fieldsStr = normalizedSQL.substring(7, 7 + selectMatch[1].length).trim();
    if (fieldsStr === '*') {
        result.fields = ['*'];
    } else {
        result.fields = fieldsStr.split(',').map(f => f.trim()).filter(f => f);
    }

    // 2. 解析 FROM
    const fromMatch = upperSQL.match(/FROM\s+(\w+)/i);
    if (!fromMatch) {
        throw new Error('Invalid SQL: expected FROM clause');
    }
    result.table = fromMatch[1];

    // 3. 解析 WHERE（可选）
    const whereIndex = upperSQL.indexOf(' WHERE ');
    if (whereIndex !== -1) {
        // 找到LIMIT位置（如果存在）
        let limitIndex = upperSQL.indexOf(' LIMIT ', whereIndex);
        if (limitIndex === -1) limitIndex = upperSQL.length;

        const whereClause = normalizedSQL.substring(whereIndex + 7, limitIndex).trim();
        parseWhereClause(whereClause, result.where);
    }

    // 4. 解析 LIMIT（可选）
    const limitMatch = upperSQL.match(/LIMIT\s+(\d+)$/i);
    if (limitMatch) {
        result.limit = parseInt(limitMatch[1], 10);
    }

    return result;
}

/**
 * 解析WHERE子句
 * @param {string} clause - WHERE子句内容
 * @param {Object} whereObj - 结果对象
 */
function parseWhereClause(clause, whereObj) {
    // 按AND分割条件
    const conditions = clause.split(/\s+AND\s+/i);

    for (const cond of conditions) {
        const trimmed = cond.trim();
        if (!trimmed) continue;

        // 尝试匹配 symbol = 'xxx'
        const symbolMatch = trimmed.match(/^symbol\s*=\s*['"]([^'"]+)['"]/i);
        if (symbolMatch) {
            whereObj.symbol = symbolMatch[1];
            continue;
        }

        // 尝试匹配 timestamp > xxx
        const timestampGtMatch = trimmed.match(/^timestamp\s*>\s*(\d+)/i);
        if (timestampGtMatch) {
            whereObj.timestampMin = parseInt(timestampGtMatch[1], 10);
            continue;
        }

        // 尝试匹配 timestamp < xxx
        const timestampLtMatch = trimmed.match(/^timestamp\s*<\s*(\d+)/i);
        if (timestampLtMatch) {
            whereObj.timestampMax = parseInt(timestampLtMatch[1], 10);
            continue;
        }

        // 尝试匹配 timestamp >= xxx
        const timestampGteMatch = trimmed.match(/^timestamp\s*>=\s*(\d+)/i);
        if (timestampGteMatch) {
            whereObj.timestampMin = parseInt(timestampGteMatch[1], 10);
            continue;
        }

        // 尝试匹配 timestamp <= xxx
        const timestampLteMatch = trimmed.match(/^timestamp\s*<=\s*(\d+)/i);
        if (timestampLteMatch) {
            whereObj.timestampMax = parseInt(timestampLteMatch[1], 10);
            continue;
        }
    }
}

/**
 * 过滤查询结果，只保留SELECT的字段
 * @param {Array} data - 原始数据
 * @param {Array} fields - 字段列表
 * @returns {Array} 过滤后的数据
 */
export function filterFields(data, fields) {
    if (fields.length === 1 && fields[0] === '*') {
        return data;
    }

    return data.map(row => {
        const filtered = {};
        for (const field of fields) {
            if (field in row) {
                filtered[field] = row[field];
            }
        }
        return filtered;
    });
}

// 默认导出
export default { parseSQL, filterFields };
