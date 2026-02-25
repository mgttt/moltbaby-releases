// cmd_sql.c - SQL/Merge/Resample 子命令实现
#include "cmd_sql.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <stdint.h>
#include <limits.h>
#include <math.h>
#include "quickjs.h"
#include "../../ndtsdb/native/ndtsdb.h"
#include "ndtsdb_lock.h"

// 外部依赖（由 main.c 提供）
extern JSContext *ctx;
extern JSRuntime *rt;
extern void print_exception(JSContext *ctx);

// 字符串转义辅助函数
static char *quote_string(const char *str) {
    if (!str) return strdup("null");
    size_t len = strlen(str);
    char *escaped = (char *)malloc(len * 2 + 3);
    if (!escaped) return NULL;
    escaped[0] = '\"';
    size_t j = 1;
    for (size_t i = 0; i < len; i++) {
        if (str[i] == '\"' || str[i] == '\\') escaped[j++] = '\\';
        escaped[j++] = str[i];
    }
    escaped[j++] = '\"';
    escaped[j] = '\0';
    return escaped;
}

// ==================== SQL 子命令 ====================
int cmd_sql(int argc, char *argv[]) {
    const char *database = NULL;
    const char *query = NULL;
    const char *format = "json";
    int help_flag = 0;
    
    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) { help_flag = 1; }
        else if (strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) {
            if (i + 1 < argc) database = argv[++i];
        } else if (strcmp(argv[i], "--query") == 0 || strcmp(argv[i], "-q") == 0) {
            if (i + 1 < argc) query = argv[++i];
        } else if (strcmp(argv[i], "--format") == 0 || strcmp(argv[i], "-f") == 0) {
            if (i + 1 < argc) format = argv[++i];
        }
    }
    
    if (help_flag) {
        printf("Usage: ndtsdb-cli sql --database <path> --query <sql> [--format <json|csv>]\n");
        printf("  Execute SQL query on the database\n");
        printf("  --database, -d  Database path (required)\n");
        printf("  --query, -q     SQL query string (required)\n");
        printf("  --format, -f    Output format: json or csv (default: json)\n");
        return 0;
    }
    
    if (!database) {
        fprintf(stderr, "Error: --database is required\n");
        return 1;
    }

    // 使用全局的 ctx 和 rt
    
    // 注入输出格式变量
    char fmt_js[64];
    snprintf(fmt_js, sizeof(fmt_js), "globalThis.__outputFormat = '%s';", format);
    JS_Eval(ctx, fmt_js, strlen(fmt_js), "<fmt>", JS_EVAL_TYPE_GLOBAL);
    
    char sql_script[32768];
    snprintf(sql_script, sizeof(sql_script),
        "function smartSplit(str) {\n"
        "    var r=[],d=0,c='';\n"
        "    for(var i=0;i<str.length;i++){var ch=str[i];if(ch==='('){d++;c+=ch;}else if(ch===')'){d--;c+=ch;}else if(ch===','&&d===0){if(c.trim())r.push(c.trim());c='';}else{c+=ch;}}\n"
        "    if(c.trim())r.push(c.trim());return r;\n"
        "}\n"
        "function parseSQL(sql) {\n"
        "    const result = { fields: [], aggregates: [], windowFunctions: [], strftimeFuncs: [], table: null, where: { symbol: null, timestampMin: null, timestampMax: null }, groupBy: null, orderBy: null, limit: null, offset: 0, having: null, distinct: false };\n"
        "    const normalizedSQL = sql.trim().replace(/\\s+/g, ' ');\n"
        "    const upperSQL = normalizedSQL.toUpperCase();\n"
        "    result.distinct = /^\\s*SELECT\\s+DISTINCT\\s+/i.test(sql);\n"
        "    const selectMatch = upperSQL.match(/^SELECT\\s+(DISTINCT\\s+)?(.+?)\\s+FROM\\s/i);\n"
        "    if (!selectMatch) throw new Error('Invalid SQL: expected SELECT ... FROM');\n"
        "    const fieldsStr = normalizedSQL.substring(normalizedSQL.toUpperCase().indexOf('SELECT') + 6, normalizedSQL.toUpperCase().indexOf('FROM')).trim().replace(/^DISTINCT\\s+/i, '');\n"
        "    const aggRegex = /^(COUNT|SUM|AVG|MIN|MAX|FIRST|LAST|STDDEV|VARIANCE)\\s*\\(\\s*(DISTINCT\\s+)?(\\*|\\w+)\\s*\\)(?:\\s+AS\\s+(\\w+))?$/i;\n"
        "    const fields = smartSplit(fieldsStr).filter(f => f);\n"
        "    for (const field of fields) {\n"
        "        const upperField = field.toUpperCase();\n"
        "        const corrMatch = field.match(/^CORR\\s*\\(\\s*(\\w+)\\s*,\\s*(\\w+)\\s*\\)(?:\\s+AS\\s+(\\w+))?$/i);\n"
        "        if(corrMatch){var ca=corrMatch[3]?corrMatch[3].toLowerCase():('CORR('+corrMatch[1]+','+corrMatch[2]+')');result.aggregates.push({func:'CORR',field:corrMatch[1].toLowerCase(),field2:corrMatch[2].toLowerCase(),raw:field,alias:ca});result.fields.push(ca);}\n"
        "        else {\n"
        "        const percMatch = field.match(/^PERCENTILE\\s*\\(\\s*(\\w+)\\s*,\\s*(\\d+(?:\\.\\d+)?)\\s*\\)(?:\\s+AS\\s+(\\w+))?$/i);\n"
        "        const aggMatch = aggRegex.exec(field);\n"
        "        if(percMatch){var palias=percMatch[3]?percMatch[3].toLowerCase():('PERCENTILE('+percMatch[1]+','+percMatch[2]+')');result.aggregates.push({func:'PERCENTILE',field:percMatch[1].toLowerCase(),percentile:parseFloat(percMatch[2]),raw:field,alias:palias});result.fields.push(palias);}\n"
        "        else if (aggMatch) {\n"
        "            const hasDistinct = !!aggMatch[2];\n"
        "            const alias = aggMatch[4] ? aggMatch[4].toLowerCase() : null;\n"
        "            result.aggregates.push({ func: aggMatch[1].toUpperCase(), field: aggMatch[3] === '*' ? '*' : aggMatch[3].toLowerCase(), raw: field, distinct: hasDistinct, alias: alias });\n"
        "            result.fields.push(alias || { func: aggMatch[1].toUpperCase(), field: aggMatch[3] === '*' ? '*' : aggMatch[3].toLowerCase(), raw: field, distinct: hasDistinct });\n"
        "        } else if (field === '*') {\n"
        "            result.fields.push('*');\n"
        "        } else {\n"
        "            const llm = field.match(/\\b(LAG|LEAD)\\s*\\(\\s*(\\w+)\\s*(?:,\\s*(\\d+))?\\s*\\)(?:\\s+AS\\s+(\\w+))?/i);\n"
        "            const strf = field.match(/^strftime\\s*\\(\\s*(\\w+)\\s*,\\s*'([^']+)'\\s*\\)(?:\\s+AS\\s+(\\w+))?$/i);\n"
        "            if(llm){var wt=llm[1].toUpperCase(),wf=llm[2].toLowerCase(),wo=llm[3]?parseInt(llm[3],10):1,wa=llm[4]?llm[4].toLowerCase():(wt+'_'+wf);result.windowFunctions.push({type:wt,field:wf,offset:wo,alias:wa});result.fields.push(wa);}\n"
        "            else if(strf){var sf=strf[1].toLowerCase(),sfmt=strf[2],sa=strf[3]?strf[3].toLowerCase():('strftime_' + sf);result.strftimeFuncs.push({field:sf,format:sfmt,alias:sa});result.fields.push(sa);}\n"
        "            else{result.fields.push(field.toLowerCase());}\n"
        "        }}\n"
        "    }\n"
        "    const fromMatch = upperSQL.match(/FROM\\s+(\\w+)/i);\n"
        "    if (!fromMatch) throw new Error('Invalid SQL: expected FROM clause');\n"
        "    result.table = fromMatch[1];\n"
        "    let whereEndIndex = upperSQL.length;\n"
        "    const groupByIndex = upperSQL.indexOf(' GROUP BY ');\n"
        "    if (groupByIndex !== -1) whereEndIndex = Math.min(whereEndIndex, groupByIndex);\n"
        "    const orderByIndex = upperSQL.indexOf(' ORDER BY ');\n"
        "    if (orderByIndex !== -1) whereEndIndex = Math.min(whereEndIndex, orderByIndex);\n"
        "    const limitIndex = upperSQL.indexOf(' LIMIT ');\n"
        "    if (limitIndex !== -1) whereEndIndex = Math.min(whereEndIndex, limitIndex);\n"
        "    const whereClauseIndex = upperSQL.indexOf(' WHERE ');\n"
        "    if (whereClauseIndex !== -1) {\n"
        "        const whereClause = normalizedSQL.substring(whereClauseIndex + 7, whereEndIndex).trim();\n"
        "        result.where.whereClause = whereClause;\n"
        "        const betweenMatch = whereClause.match(/([a-zA-Z_][a-zA-Z0-9_]*)\\s+BETWEEN\\s+(\\S+)\\s+AND\\s+(\\S+)/i);\n"
        "        if (betweenMatch) { result.where.filter = { type: 'BETWEEN', field: betweenMatch[1], low: betweenMatch[2], high: betweenMatch[3] }; }\n"
        "        const inMatch = whereClause.match(/([a-zA-Z_][a-zA-Z0-9_]*)\\s+IN\\s*\\(([^)]+)\\)/i);\n"
        "        if (inMatch) { result.where.filter = { type: 'IN', field: inMatch[1], values: inMatch[2].split(',').map(v => v.trim()) }; }\n"
        "        const likeMatch = whereClause.match(/([a-zA-Z_]\\w*)\\s+LIKE\\s+'([^']+)'/i);\n"
        "        if (likeMatch) {\n"
        "            const field = likeMatch[1];\n"
        "            const pattern = likeMatch[2];\n"
        "            let regexStr = pattern.replace(/[.+^${}()|[\\]\\\\]/g, '\\$&');\n"
        "            regexStr = regexStr.replace(/%/g, '.*').replace(/_/g, '.');\n"
        "            result.where.filter = { type: 'LIKE', field, regex: '^' + regexStr + '$' };\n"
        "        }\n"
        "        const cosineMatch = whereClause.match(/COSINE_SIM\\s*\\(\\s*(\\w+)\\s*,\\s*\\[([^\\]]+)\\]\\s*\\)\\s*([><=]+)\\s*([\\d.]+)/i);\n"
        "        if (cosineMatch) {\n"
        "            result.where.filter = {\n"
        "                type: 'COSINE_SIM',\n"
        "                field: cosineMatch[1],\n"
        "                query_vector: cosineMatch[2].split(',').map(x => parseFloat(x.trim())),\n"
        "                operator: cosineMatch[3],\n"
        "                threshold: parseFloat(cosineMatch[4])\n"
        "            };\n"
        "        }\n"
        "        const conditions = whereClause.split(/\\s+AND\\s+/i);\n"
        "        for (const cond of conditions) {\n"
        "            const symbolMatch = cond.match(/^symbol\\s*=\\s*['\"]([^'\"]+)['\"]/i);\n"
        "            if (symbolMatch) { result.where.symbol = symbolMatch[1]; continue; }\n"
        "            const agentIdMatch = cond.match(/^agent_id\\s*=\\s*['\"]([^'\"]+)['\"]/i);\n"
        "            if (agentIdMatch) { result.where.symbol = agentIdMatch[1]; continue; }\n"
        "            const timestampGtMatch = cond.match(/^timestamp\\s*>(=?)\\s*(\\d+)/i);\n"
        "            if (timestampGtMatch) { result.where.timestampMin = parseInt(timestampGtMatch[2], 10); continue; }\n"
        "            const timestampLtMatch = cond.match(/^timestamp\\s*<(=?)\\s*(\\d+)/i);\n"
        "            if (timestampLtMatch) { result.where.timestampMax = parseInt(timestampLtMatch[2], 10); continue; }\n"
        "            const intervalMatch = cond.match(/^interval\\s*=\\s*['\"]([^'\"]+)['\"]/i);\n"
        "            if (intervalMatch) { result.where.interval = intervalMatch[1]; continue; }\n"
        "        }\n"
        "    }\n"
        "    if (groupByIndex !== -1) {\n"
        "        let groupByEnd = upperSQL.length;\n"
        "        const havingIndex = upperSQL.indexOf(' HAVING ');\n"
        "        if (havingIndex !== -1 && havingIndex > groupByIndex) groupByEnd = havingIndex;\n"
        "        if (orderByIndex !== -1 && orderByIndex > groupByIndex) groupByEnd = Math.min(groupByEnd, orderByIndex);\n"
        "        if (limitIndex !== -1 && limitIndex > groupByIndex) groupByEnd = Math.min(groupByEnd, limitIndex);\n"
        "        const groupByClause = normalizedSQL.substring(groupByIndex + 10, groupByEnd).trim();\n"
        "        result.groupBy = groupByClause.toLowerCase().split(',').map(s => s.trim());\n"
        "    }\n"
        "    if (orderByIndex !== -1) {\n"
        "        let orderByEnd = upperSQL.length;\n"
        "        if (limitIndex !== -1 && limitIndex > orderByIndex) orderByEnd = limitIndex;\n"
        "        const orderByClause = normalizedSQL.substring(orderByIndex + 10, orderByEnd).trim();\n"
        "        const aggMatch = orderByClause.match(/^(COUNT|SUM|AVG|MIN|MAX)\\s*\\(\\s*(\\*|\\w+)\\s*\\)/i);\n"
        "        if (aggMatch) {\n"
        "            const func = aggMatch[1].toUpperCase();\n"
        "            const field = aggMatch[2] === '*' ? '*' : aggMatch[2].toLowerCase();\n"
        "            const raw = orderByClause.substring(0, aggMatch[0].length);\n"
        "            const rest = orderByClause.substring(aggMatch[0].length).trim();\n"
        "            result.orderBy = { \n"
        "                func: func, \n"
        "                field: field, \n"
        "                raw: raw,\n"
        "                direction: rest.toUpperCase() === 'DESC' ? 'DESC' : 'ASC' \n"
        "            };\n"
        "        } else {\n"
        "            const orderParts = orderByClause.split(/\\s+/);\n"
        "            result.orderBy = { field: orderParts[0].toLowerCase(), direction: 'ASC' };\n"
        "            if (orderParts.length > 1 && orderParts[1].toUpperCase() === 'DESC') {\n"
        "                result.orderBy.direction = 'DESC';\n"
        "            }\n"
        "        }\n"
        "    }\n"
        "    const limitMatch = upperSQL.match(/LIMIT\\s+(\\d+)(?:\\s*$|\\s+ORDER\\s+BY|\\s+GROUP\\s+BY|\\s+OFFSET)/i) || upperSQL.match(/LIMIT\\s+(\\d+)$/i);\n"
        "    if (limitMatch) result.limit = parseInt(limitMatch[1], 10);\n"
        "    const offsetMatch = upperSQL.match(/OFFSET\\s+(\\d+)/i);\n"
        "    if (offsetMatch) result.offset = parseInt(offsetMatch[1], 10);\n"
        "    const havingMatch = upperSQL.match(/HAVING\\s+(.+?)(?:\\s+ORDER\\s+BY|\\s+LIMIT|\\s*$)/i);\n"
        "    if (havingMatch) result.having = havingMatch[1].trim();\n"
        "    return result;\n"
        "}\n"
        "function cosine_sim(vec_a, vec_b) {\n"
        "    if (!vec_a || !vec_b) return 0;\n"
        "    if (vec_a.length !== vec_b.length) return 0;\n"
        "    let dot = 0, norm_a = 0, norm_b = 0;\n"
        "    for (let i = 0; i < vec_a.length; i++) {\n"
        "        dot += vec_a[i] * vec_b[i];\n"
        "        norm_a += vec_a[i] * vec_a[i];\n"
        "        norm_b += vec_b[i] * vec_b[i];\n"
        "    }\n"
        "    if (norm_a === 0 || norm_b === 0) return 0;\n"
        "    return dot / (Math.sqrt(norm_a) * Math.sqrt(norm_b));\n"
        "}\n"
        "function whereToJS(whereClause) {\n"
        "    let js = whereClause;\n"
        "    js = js.replace(/\\bOR\\b/gi, '||');\n"
        "    js = js.replace(/\\bAND\\b/gi, '&&');\n"
        "    js = js.replace(/([a-zA-Z_][a-zA-Z0-9_]*)\\s*=\\s*'([^']*)'/g, \"row.$1 === '$2'\");\n"
        "    js = js.replace(/([a-zA-Z_][a-zA-Z0-9_]*)\\s*=\\s*([0-9.]+)/g, 'row.$1 == $2');\n"
        "    js = js.replace(/([a-zA-Z_][a-zA-Z0-9_]*)\\s*(>=|<=|>|<)\\s*([0-9.]+)/g, 'row.$1 $2 $3');\n"
        "    return js;\n"
        "}\n"
        "function applyWhere(data, filter, whereClause) {\n"
        "    if (!filter && !whereClause) return data;\n"
        "    if (filter) {\n"
        "        if (filter.type === 'BETWEEN') {\n"
        "            const lo = parseFloat(filter.low);\n"
        "            const hi = parseFloat(filter.high);\n"
        "            return data.filter(row => {\n"
        "                const val = parseFloat(row[filter.field]);\n"
        "                return !isNaN(val) && val >= lo && val <= hi;\n"
        "            });\n"
        "        }\n"
        "        if (filter.type === 'IN') {\n"
        "            const vals = filter.values.map(v => {\n"
        "                const s = v.trim();\n"
        "                if ((s.startsWith(\"'\") && s.endsWith(\"'\")) || (s.startsWith('\"') && s.endsWith('\"'))) return s.slice(1, -1);\n"
        "                return isNaN(parseFloat(s)) ? s : parseFloat(s);\n"
        "            });\n"
        "            return data.filter(row => vals.includes(row[filter.field]) || vals.includes(parseFloat(row[filter.field])));\n"
        "        }\n"
        "        if (filter.type === 'LIKE') {\n"
        "            return data.filter(row => new RegExp(filter.regex, 'i').test(String(row[filter.field])));\n"
        "        }\n"
        "        if (filter.type === 'COSINE_SIM') {\n"
        "            const { field, query_vector, operator, threshold } = filter;\n"
        "            return data.filter(row => {\n"
        "                const emb = row[field];\n"
        "                if (!emb || !Array.isArray(emb)) return false;\n"
        "                const sim = cosine_sim(emb, query_vector);\n"
        "                if (operator === '>') return sim > threshold;\n"
        "                if (operator === '>=') return sim >= threshold;\n"
        "                if (operator === '<') return sim < threshold;\n"
        "                if (operator === '<=') return sim <= threshold;\n"
        "                return sim === threshold;\n"
        "            });\n"
        "        }\n"
        "    }\n"
        "    if (whereClause && (/\\bOR\\b/i).test(whereClause)) {\n"
        "        const jsExpr = whereToJS(whereClause);\n"
        "        return data.filter(row => eval(jsExpr));\n"
        "    }\n"
        "    if (whereClause && (/\\bNOT\\b/i).test(whereClause)) {\n"
        "        const notMatch = whereClause.match(/NOT\\s+(.+)/i);\n"
        "        if (notMatch) {\n"
        "            const innerClause = notMatch[1].trim();\n"
        "            const jsExpr = whereToJS(innerClause);\n"
        "            return data.filter(row => !eval(jsExpr));\n"
        "        }\n"
        "    }\n"
        "    return data;\n"
        "}\n"
        "function ndtsdb_strftime(ts, fmt) {\n"
        "    var d = new Date(Number(ts));\n"
        "    return fmt\n"
        "        .replace('%%Y', d.getUTCFullYear())\n"
        "        .replace('%%m', ('0'+(d.getUTCMonth()+1)).slice(-2))\n"
        "        .replace('%%d', ('0'+d.getUTCDate()).slice(-2))\n"
        "        .replace('%%H', ('0'+d.getUTCHours()).slice(-2))\n"
        "        .replace('%%M', ('0'+d.getUTCMinutes()).slice(-2));\n"
        "}\n"
        "function filterFields(data, fields) {\n"
        "    if (fields.length === 1 && fields[0] === '*') return data;\n"
        "    return data.map(row => { const filtered = {}; for (const field of fields) if (field in row) filtered[field] = row[field]; return filtered; });\n"
        "}\n"
        "function executeAggregation(data, aggregates, groupByField) {\n"
        "    if (!aggregates || aggregates.length === 0) return null;\n"
        "    const results = [];\n"
        "    if (groupByField) {\n"
        "        const groups = {};\n"
        "        const isMultiColumn = Array.isArray(groupByField);\n"
        "        const groupByCols = isMultiColumn ? groupByField : [groupByField];\n"
        "        for (const row of data) {\n"
        "            const key = groupByCols.map(col => row[col]).join('|');\n"
        "            if (!groups[key]) groups[key] = [];\n"
        "            groups[key].push(row);\n"
        "        }\n"
        "        for (const key in groups) {\n"
        "            const groupData = groups[key];\n"
        "            const result = {}; const keyParts = key.split('|'); for (let i = 0; i < groupByCols.length; i++) { result[groupByCols[i]] = keyParts[i]; }\n"
        "            for (const agg of aggregates) {\n"
        "                const aggKey = agg.alias || agg.raw || agg.func + '(' + agg.field + ')';\n"
        "                switch (agg.func) {\n"
        "                    case 'COUNT':\n"
        "                        if (agg.distinct && agg.field !== '*') {\n"
        "                            const uniqueVals = new Set(groupData.map(r => r[agg.field]));\n"
        "                            result[aggKey] = uniqueVals.size;\n"
        "                        } else {\n"
        "                            result[aggKey] = groupData.length;\n"
        "                        }\n"
        "                        break;\n"
        "                    case 'SUM': result[aggKey] = groupData.reduce((sum, row) => sum + (parseFloat(row[agg.field]) || 0), 0); break;\n"
        "                    case 'AVG': result[aggKey] = groupData.length === 0 ? null : groupData.reduce((sum, row) => sum + (parseFloat(row[agg.field]) || 0), 0) / groupData.length; break;\n"
        "                    case 'MIN': result[aggKey] = groupData.length === 0 ? null : Math.min(...groupData.map(row => parseFloat(row[agg.field])).filter(v => !isNaN(v))); break;\n"
        "                    case 'MAX': result[aggKey] = groupData.length === 0 ? null : Math.max(...groupData.map(row => parseFloat(row[agg.field])).filter(v => !isNaN(v))); break;\n"
        "                    case 'FIRST': result[aggKey] = groupData.length === 0 ? null : groupData[0][agg.field]; break;\n"
        "                    case 'LAST': result[aggKey] = groupData.length === 0 ? null : groupData[groupData.length-1][agg.field]; break;\n"
        "                    case 'STDDEV': { var vals = groupData.map(function(r){ return Number(r[agg.field]); }).filter(function(v){ return !isNaN(v); }); if(vals.length===0){ result[aggKey]=null; break; } var mean = vals.reduce(function(a,b){return a+b;},0)/vals.length; var variance = vals.reduce(function(a,b){return a+(b-mean)*(b-mean);},0)/vals.length; result[aggKey] = Math.sqrt(variance); break; }\n"
        "                    case 'VARIANCE': { var vals = groupData.map(function(r){ return Number(r[agg.field]); }).filter(function(v){ return !isNaN(v); }); if(vals.length===0){ result[aggKey]=null; break; } var mean = vals.reduce(function(a,b){return a+b;},0)/vals.length; result[aggKey] = vals.reduce(function(a,b){return a+(b-mean)*(b-mean);},0)/vals.length; break; }\n"
        "                    case 'PERCENTILE': { var vals = groupData.map(function(r){return Number(r[agg.field]);}).filter(function(v){return !isNaN(v);}).sort(function(a,b){return a-b;}); if(vals.length===0){result[aggKey]=null;break;} var idx = (agg.percentile/100)*(vals.length-1); var lo = Math.floor(idx), hi = Math.ceil(idx); result[aggKey] = lo===hi ? vals[lo] : vals[lo]+(vals[hi]-vals[lo])*(idx-lo); break; }\n"
        "                    case 'CORR': { var xs = groupData.map(function(r){return Number(r[agg.field]);}); var ys = groupData.map(function(r){return Number(r[agg.field2]);}); if(xs.length<2){result[aggKey]=null;break;} var n=xs.length; var mx=xs.reduce(function(a,b){return a+b;},0)/n; var my=ys.reduce(function(a,b){return a+b;},0)/n; var cov=0,sx=0,sy=0; for(var ci=0;ci<n;ci++){var dx=xs[ci]-mx,dy=ys[ci]-my;cov+=dx*dy;sx+=dx*dx;sy+=dy*dy;} result[aggKey]=(sx*sy===0)?0:cov/Math.sqrt(sx*sy); break; }\n"
        "                    default: result[aggKey] = null;\n"
        "                }\n"
        "            }\n"
        "            results.push(result);\n"
        "        }\n"
        "        return results;\n"
        "    } else {\n"
        "        const result = {};\n"
        "        for (const agg of aggregates) {\n"
        "            const key = agg.alias || agg.raw || agg.func + '(' + agg.field + ')';\n"
        "            switch (agg.func) {\n"
        "                case 'COUNT':\n"
        "                    if (agg.distinct && agg.field !== '*') {\n"
        "                        const uniqueVals = new Set(data.map(r => r[agg.field]));\n"
        "                        result[key] = uniqueVals.size;\n"
        "                    } else {\n"
        "                        result[key] = data.length;\n"
        "                    }\n"
        "                    break;\n"
        "                case 'SUM': result[key] = data.reduce((sum, row) => sum + (parseFloat(row[agg.field]) || 0), 0); break;\n"
        "                case 'AVG': result[key] = data.length === 0 ? null : data.reduce((sum, row) => sum + (parseFloat(row[agg.field]) || 0), 0) / data.length; break;\n"
        "                case 'MIN': result[key] = data.length === 0 ? null : Math.min(...data.map(row => parseFloat(row[agg.field])).filter(v => !isNaN(v))); break;\n"
        "                case 'MAX': result[key] = data.length === 0 ? null : Math.max(...data.map(row => parseFloat(row[agg.field])).filter(v => !isNaN(v))); break;\n"
        "                case 'FIRST': result[key] = data.length === 0 ? null : data[0][agg.field]; break;\n"
        "                case 'LAST': result[key] = data.length === 0 ? null : data[data.length-1][agg.field]; break;\n"
        "                case 'STDDEV': { var vals = data.map(function(r){ return Number(r[agg.field]); }).filter(function(v){ return !isNaN(v); }); if(vals.length===0){ result[key]=null; break; } var mean = vals.reduce(function(a,b){return a+b;},0)/vals.length; var variance = vals.reduce(function(a,b){return a+(b-mean)*(b-mean);},0)/vals.length; result[key] = Math.sqrt(variance); break; }\n"
        "                case 'VARIANCE': { var vals = data.map(function(r){ return Number(r[agg.field]); }).filter(function(v){ return !isNaN(v); }); if(vals.length===0){ result[key]=null; break; } var mean = vals.reduce(function(a,b){return a+b;},0)/vals.length; result[key] = vals.reduce(function(a,b){return a+(b-mean)*(b-mean);},0)/vals.length; break; }\n"
        "                case 'PERCENTILE': { var vals = data.map(function(r){return Number(r[agg.field]);}).filter(function(v){return !isNaN(v);}).sort(function(a,b){return a-b;}); if(vals.length===0){result[key]=null;break;} var idx = (agg.percentile/100)*(vals.length-1); var lo = Math.floor(idx), hi = Math.ceil(idx); result[key] = lo===hi ? vals[lo] : vals[lo]+(vals[hi]-vals[lo])*(idx-lo); break; }\n"
        "                case 'CORR': { var xs = data.map(function(r){return Number(r[agg.field]);}); var ys = data.map(function(r){return Number(r[agg.field2]);}); if(xs.length<2){result[key]=null;break;} var n=xs.length; var mx=xs.reduce(function(a,b){return a+b;},0)/n; var my=ys.reduce(function(a,b){return a+b;},0)/n; var cov=0,sx=0,sy=0; for(var ci=0;ci<n;ci++){var dx=xs[ci]-mx,dy=ys[ci]-my;cov+=dx*dy;sx+=dx*dx;sy+=dy*dy;} result[key]=(sx*sy===0)?0:cov/Math.sqrt(sx*sy); break; }\n"
        "                default: result[key] = null;\n"
        "            }\n"
        "        }\n"
        "        return result;\n"
        "    }\n"
        "}\n"
        "function executeOrderBy(data, orderBy) {\n"
        "    if (!orderBy || (!orderBy.field && !orderBy.func)) return data;\n"
        "    const direction = orderBy.direction === 'DESC' ? -1 : 1;\n"
        "    return data.sort((a, b) => {\n"
        "        let valA, valB;\n"
        "        if (orderBy.func) {\n"
        "            const key = orderBy.raw || orderBy.func + '(' + orderBy.field + ')';\n"
        "            valA = a[key];\n"
        "            valB = b[key];\n"
        "        } else {\n"
        "            valA = a[orderBy.field];\n"
        "            valB = b[orderBy.field];\n"
        "        }\n"
        "        if (typeof valA === 'string') valA = valA.toLowerCase();\n"
        "        if (typeof valB === 'string') valB = valB.toLowerCase();\n"
        "        if (valA === null || valA === undefined) return 1 * direction;\n"
        "        if (valB === null || valB === undefined) return -1 * direction;\n"
        "        if (valA < valB) return -1 * direction;\n"
        "        if (valA > valB) return 1 * direction;\n"
        "        return 0;\n"
        "    });\n"
        "}\n"
        "function evalHaving(row, condition) {\n"
        "    let expr = condition;\n"
        "    expr = expr.replace(/COUNT\\s*\\(\\*\\)/gi, JSON.stringify(row['COUNT(*)'] ?? null));\n"
        "    expr = expr.replace(/AVG\\s*\\(([^)]+)\\)/gi, (m, p1) => JSON.stringify(row['AVG(' + p1.toLowerCase() + ')'] ?? null));\n"
        "    expr = expr.replace(/SUM\\s*\\(([^)]+)\\)/gi, (m, p1) => JSON.stringify(row['SUM(' + p1.toLowerCase() + ')'] ?? null));\n"
        "    expr = expr.replace(/MIN\\s*\\(([^)]+)\\)/gi, (m, p1) => JSON.stringify(row['MIN(' + p1.toLowerCase() + ')'] ?? null));\n"
        "    expr = expr.replace(/MAX\\s*\\(([^)]+)\\)/gi, (m, p1) => JSON.stringify(row['MAX(' + p1.toLowerCase() + ')'] ?? null));\n"
        "    expr = expr.replace(/\\b([a-z_]+)\\b/gi, (m) => {\n"
        "        if (['AND','OR','NOT','NULL','true','false'].includes(m.toUpperCase())) return m;\n"
        "        if (row[m] !== undefined) return JSON.stringify(row[m]);\n"
        "        return m;\n"
        "    });\n"
        "    try {\n"
        "        return eval(expr);\n"
        "    } catch(e) {\n"
        "        return false;\n"
        "    }\n"
        "}\n"
        "import * as ndtsdb from 'ndtsdb';\n"
        "try {\n"
        "    const db = ndtsdb.open('%s/');\n"
        "    let sqlQuery = %s;\n"
        "    if (!sqlQuery) {\n"
        "        const lines = [];\n"
        "        while (true) {\n"
        "            const line = __readStdinLine();\n"
        "            if (line === null) break;\n"
        "            if (line.trim() !== '') lines.push(line);\n"
        "        }\n"
        "        sqlQuery = lines.join(' ');\n"
        "    }\n"
        "    if (!sqlQuery || sqlQuery.trim() === '') { console.error('Error: No SQL query provided'); ndtsdb.close(db); throw new Error('No SQL query'); }\n"
        "    const parsed = parseSQL(sqlQuery);\n"
        "    let result;\n"
        "    // 向量表查询\n"
        "    if (parsed.table && parsed.table.toLowerCase() === 'vectors') {\n"
        "        // 从 WHERE 解析 symbol/interval，或使用默认值\n"
        "        const symbol = parsed.where.symbol || 'bot-006';\n"
        "        const interval = parsed.where.interval || 'semantic';\n"
        "        result = ndtsdb.queryVectors(db, symbol, interval);\n"
        "    } else {\n"
        "        const hasOrClause = parsed.where.whereClause && (/\\bOR\\b/i).test(parsed.where.whereClause);\n"
        "        const hasLikeFilter = parsed.where.filter && parsed.where.filter.type === 'LIKE';\n"
        "        if (!hasOrClause && !hasLikeFilter && parsed.where.symbol && parsed.where.timestampMin !== null && parsed.where.timestampMax !== null) {\n"
        "            result = ndtsdb.queryFilteredTime(db, [parsed.where.symbol], parsed.where.timestampMin, parsed.where.timestampMax);\n"
        "        } else if (!hasOrClause && !hasLikeFilter && parsed.where.symbol) {\n"
        "            result = ndtsdb.queryFiltered(db, [parsed.where.symbol]);\n"
        "        } else if (parsed.where.timestampMin !== null && parsed.where.timestampMax !== null) {\n"
        "            result = ndtsdb.queryTimeRange(db, parsed.where.timestampMin, parsed.where.timestampMax);\n"
        "        } else {\n"
        "            result = ndtsdb.queryAll(db);\n"
        "        }\n"
        "    }\n"
        "    if (parsed.where.filter || parsed.where.whereClause) {\n"
        "        result = applyWhere(result, parsed.where.filter, parsed.where.whereClause);\n"
        "    }\n"
        "    if(parsed.windowFunctions&&parsed.windowFunctions.length>0){parsed.windowFunctions.forEach(function(wf){result.forEach(function(r,i){r[wf.alias]=wf.type==='LAG'?(i>=wf.offset?result[i-wf.offset][wf.field]:null):(i+wf.offset<result.length?result[i+wf.offset][wf.field]:null);});});}\n"
        "    if(parsed.strftimeFuncs&&parsed.strftimeFuncs.length>0){parsed.strftimeFuncs.forEach(function(sf){result.forEach(function(r){r[sf.alias]=ndtsdb_strftime(r[sf.field],sf.format);});});}\n"
        "    if (parsed.aggregates.length > 0) {\n"
        "        const aggResult = executeAggregation(result, parsed.aggregates, parsed.groupBy);\n"
        "        if (Array.isArray(aggResult)) {\n"
        "            result = aggResult;\n"
        "        } else {\n"
        "            result = [aggResult];\n"
        "        }\n"
        "    } else if (parsed.groupBy) {\n"
        "        const groups = {};\n"
        "        const isMultiColumn = Array.isArray(groupByField);\n"
        "        const groupByCols = isMultiColumn ? groupByField : [groupByField];\n"
        "        for (const row of result) {\n"
        "            const key = row[parsed.groupBy];\n"
        "            if (!groups[key]) groups[key] = { [parsed.groupBy]: key, _rows: [] };\n"
        "            groups[key]._rows.push(row);\n"
        "        }\n"
        "        result = Object.values(groups);\n"
        "    } else {\n"
        "        result = filterFields(result, parsed.fields);\n"
        "    }\n"
        "    if (parsed.having) {\n"
        "        result = result.filter(row => evalHaving(row, parsed.having));\n"
        "    }\n"
        "    if (parsed.orderBy) {\n"
        "        result = executeOrderBy(result, parsed.orderBy);\n"
        "    }\n"
        "    if (parsed.limit !== null && parsed.limit > 0) {\n"
        "        result = result.slice(parsed.offset, parsed.offset + parsed.limit);\n"
        "    }\n"
        "    if (parsed.distinct) {\n"
        "        result = result.filter((row, idx, arr) => idx === arr.findIndex(r => JSON.stringify(r) === JSON.stringify(row)));\n"
        "    }\n"
        "    const fmt = globalThis.__outputFormat || 'json';\n"
        "    if (fmt === 'csv' && result.length > 0) {\n"
        "        const keys = Object.keys(result[0]);\n"
        "        console.log(keys.join(','));\n"
        "        for (const row of result) {\n"
        "            console.log(keys.map(k => row[k] !== null && row[k] !== undefined ? row[k] : '').join(','));\n"
        "        }\n"
        "    } else {\n"
        "        result.forEach(row => console.log(JSON.stringify(row)));\n"
        "    }\n"
        "    ndtsdb.close(db);\n"
        "} catch (e) {\n"
        "    console.error('SQL Error:', e.message);\n"
        "    throw e;\n"
        "}\n",
        database, query ? quote_string(query) : "null"
    );
    
    JSValue result = JS_Eval(ctx, sql_script, strlen(sql_script), "<sql>", JS_EVAL_TYPE_MODULE);
    int exit_code = 0;
    if (JS_IsException(result)) { 
        print_exception(ctx); 
        exit_code = 1; 
    }
    JS_FreeValue(ctx, result);
    
    JSContext *ctx2;
    while (JS_ExecutePendingJob(rt, &ctx2) > 0) {}
    
    return exit_code;
}

// ==================== Merge 子命令 ====================
typedef struct {
    char symbol[32];
    char interval[16];
    KlineRow row;
} MergeRow;

// 去重用的 hash set 条目
typedef struct {
    char key[80];  // symbol + interval + timestamp 组合键
    bool exists;
} DedupEntry;

#define DEDUP_BUCKETS 65536  // 2^16 buckets

static unsigned int dedup_hash(const char *key) {
    unsigned int h = 5381;
    while (*key) {
        h = ((h << 5) + h) + *key++;
    }
    return h % DEDUP_BUCKETS;
}

static void build_dedup_key(char *buf, size_t buf_sz, const char *symbol, const char *interval, int64_t timestamp) {
    snprintf(buf, buf_sz, "%s|%s|%ld", symbol, interval, timestamp);
}

int cmd_merge(int argc, char *argv[]) {
    const char *from_db = NULL;
    const char *to_db = NULL;
    const char *filter_symbol = NULL;
    const char *filter_interval = NULL;
    int help_flag = 0;

    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) { help_flag = 1; }
        else if (strcmp(argv[i], "--from") == 0 && i+1 < argc) { from_db = argv[++i]; }
        else if (strcmp(argv[i], "--to")   == 0 && i+1 < argc) { to_db   = argv[++i]; }
        else if (strcmp(argv[i], "--symbol")   == 0 && i+1 < argc) { filter_symbol   = argv[++i]; }
        else if (strcmp(argv[i], "--interval") == 0 && i+1 < argc) { filter_interval = argv[++i]; }
    }

    if (help_flag) {
        printf("Usage: ndtsdb-cli merge --from <src> --to <dst> [--symbol <sym>] [--interval <intv>]\n");
        printf("  Merge data from source database to target (tombstones filtered)\n");
        printf("  --from, -f    Source database path (required)\n");
        printf("  --to, -t      Target database path (required)\n");
        printf("  --symbol      Filter by symbol\n");
        printf("  --interval    Filter by interval (requires --symbol)\n");
        return 0;
    }

    if (!from_db || !to_db) {
        fprintf(stderr, "Error: --from and --to are required\n");
        return 1;
    }

    MergeRow *buf = NULL;
    int buf_count = 0;
    int buf_capacity = 4096;
    int total_skipped = 0;
    int total_duplicates = 0;  // 去重计数

    // 去重 hash set
    DedupEntry **dedup_set = calloc(DEDUP_BUCKETS, sizeof(DedupEntry*));
    if (!dedup_set) {
        fprintf(stderr, "Error: OOM allocating dedup set\n");
        return 1;
    }

    buf = (MergeRow*)malloc(buf_capacity * sizeof(MergeRow));
    if (!buf) {
        fprintf(stderr, "Error: OOM allocating merge buffer\n");
        free(dedup_set);
        return 1;
    }

    // ========== 第一步：读取目标库，构建去重集合 ==========
    {
        int lock_fd = ndtsdb_lock_acquire(to_db, false);
        if (lock_fd < 0) {
            fprintf(stderr, "Error: cannot lock target DB: %s\n", to_db);
            free(buf);
            free(dedup_set);
            return 1;
        }

        NDTSDB *to = ndtsdb_open(to_db);
        if (!to) {
            ndtsdb_lock_release(lock_fd);
            fprintf(stderr, "Error: cannot open target DB: %s\n", to_db);
            free(buf);
            free(dedup_set);
            return 1;
        }

        char syms[256][32]; char itvs[256][16];
        int n = ndtsdb_list_symbols(to, syms, itvs, 256);

        for (int s = 0; s < n; s++) {
            if (filter_symbol && strcmp(syms[s], filter_symbol) != 0) continue;
            if (filter_interval && strcmp(itvs[s], filter_interval) != 0) continue;

            Query q = { .symbol = syms[s], .interval = itvs[s],
                         .startTime = 0, .endTime = INT64_MAX, .limit = 0 };
            QueryResult *qr = ndtsdb_query(to, &q);
            if (!qr) continue;

            for (uint32_t r = 0; r < qr->count; r++) {
                if (qr->rows[r].volume < 0) continue;  // 跳过 tombstone

                char key[80];
                build_dedup_key(key, sizeof(key), syms[s], itvs[s], qr->rows[r].timestamp);
                unsigned int h = dedup_hash(key);

                // 检查是否已存在（处理碰撞）
                DedupEntry *entry = dedup_set[h];
                while (entry) {
                    if (strcmp(entry->key, key) == 0) {
                        entry->exists = true;
                        break;
                    }
                    // 简单线性探测：在同一 bucket 内找下一个
                    h = (h + 1) % DEDUP_BUCKETS;
                    entry = dedup_set[h];
                }

                if (!entry) {
                    entry = malloc(sizeof(DedupEntry));
                    if (entry) {
                        strncpy(entry->key, key, sizeof(entry->key) - 1);
                        entry->key[sizeof(entry->key) - 1] = '\0';
                        entry->exists = true;
                        dedup_set[h] = entry;
                    }
                }
            }
            ndtsdb_free_result(qr);
        }

        ndtsdb_close(to);
        ndtsdb_lock_release(lock_fd);
    }

    // ========== 第二步：读取源库，过滤重复 ==========
    {
        int lock_fd = ndtsdb_lock_acquire(from_db, false);
        if (lock_fd < 0) {
            fprintf(stderr, "Error: cannot lock source DB: %s\n", from_db);
            free(buf);
            // 清理 dedup_set
            for (int i = 0; i < DEDUP_BUCKETS; i++) {
                if (dedup_set[i]) free(dedup_set[i]);
            }
            free(dedup_set);
            return 1;
        }

        NDTSDB *from = ndtsdb_open(from_db);
        if (!from) {
            ndtsdb_lock_release(lock_fd);
            fprintf(stderr, "Error: cannot open source DB: %s\n", from_db);
            free(buf);
            for (int i = 0; i < DEDUP_BUCKETS; i++) {
                if (dedup_set[i]) free(dedup_set[i]);
            }
            free(dedup_set);
            return 1;
        }

        char syms[256][32]; char itvs[256][16];
        int n = ndtsdb_list_symbols(from, syms, itvs, 256);

        for (int s = 0; s < n; s++) {
            if (filter_symbol && strcmp(syms[s], filter_symbol) != 0) continue;
            if (filter_interval && strcmp(itvs[s], filter_interval) != 0) continue;

            Query q = { .symbol = syms[s], .interval = itvs[s],
                         .startTime = 0, .endTime = INT64_MAX, .limit = 0 };
            QueryResult *qr = ndtsdb_query(from, &q);
            if (!qr) continue;

            for (uint32_t r = 0; r < qr->count; r++) {
                if (qr->rows[r].volume < 0) { total_skipped++; continue; }

                // 检查是否在目标库已存在
                char key[80];
                build_dedup_key(key, sizeof(key), syms[s], itvs[s], qr->rows[r].timestamp);
                unsigned int h = dedup_hash(key);
                bool exists = false;

                DedupEntry *entry = dedup_set[h];
                while (entry) {
                    if (strcmp(entry->key, key) == 0) {
                        exists = entry->exists;
                        break;
                    }
                    h = (h + 1) % DEDUP_BUCKETS;
                    entry = dedup_set[h];
                }

                if (exists) {
                    total_duplicates++;
                    continue;  // 跳过重复
                }

                if (buf_count >= buf_capacity) {
                    buf_capacity *= 2;
                    MergeRow *tmp = (MergeRow*)realloc(buf, buf_capacity * sizeof(MergeRow));
                    if (!tmp) {
                        ndtsdb_free_result(qr);
                        ndtsdb_close(from);
                        ndtsdb_lock_release(lock_fd);
                        for (int di = 0; di < DEDUP_BUCKETS; di++) if (dedup_set[di]) free(dedup_set[di]);
                        free(dedup_set);
                        free(buf);
                        fprintf(stderr, "Error: out of memory during merge\n");
                        return 1;
                    }
                    buf = tmp;
                }
                strncpy(buf[buf_count].symbol, syms[s], 31);
                buf[buf_count].symbol[31] = '\0';
                strncpy(buf[buf_count].interval, itvs[s], 15);
                buf[buf_count].interval[15] = '\0';
                buf[buf_count].row = qr->rows[r];
                buf_count++;
            }
            ndtsdb_free_result(qr);
        }

        ndtsdb_close(from);
        ndtsdb_lock_release(lock_fd);
    }

    // 清理 dedup_set
    for (int i = 0; i < DEDUP_BUCKETS; i++) {
        if (dedup_set[i]) free(dedup_set[i]);
    }
    free(dedup_set);

    // ========== 第三步：批量插入目标库 ==========
    {
        int lock_fd = ndtsdb_lock_acquire(to_db, true);
        if (lock_fd < 0) {
            fprintf(stderr, "Error: cannot lock target DB: %s\n", to_db);
            free(buf);
            return 1;
        }

        NDTSDB *to = ndtsdb_open(to_db);
        if (!to) {
            ndtsdb_lock_release(lock_fd);
            fprintf(stderr, "Error: cannot open target DB: %s\n", to_db);
            free(buf);
            return 1;
        }

        int total_merged = 0;
        int i = 0;
        while (i < buf_count) {
            int j = i;
            while (j < buf_count &&
                   strcmp(buf[j].symbol, buf[i].symbol) == 0 &&
                   strcmp(buf[j].interval, buf[i].interval) == 0) j++;

            int batch_n = j - i;
            KlineRow *batch = (KlineRow*)malloc(batch_n * sizeof(KlineRow));
            if (!batch) goto merge_oom2;
            for (int k = 0; k < batch_n; k++) batch[k] = buf[i+k].row;
            int ins = ndtsdb_insert_batch(to, buf[i].symbol, buf[i].interval, batch, (uint32_t)batch_n);
            if (ins > 0) total_merged += ins;
            free(batch);
            i = j;
        }

        ndtsdb_close(to);
        ndtsdb_lock_release(lock_fd);
        free(buf);

        printf("Merged %d rows (skipped %d tombstones, %d duplicates)\n", total_merged, total_skipped, total_duplicates);
        return 0;

merge_oom2:
        ndtsdb_close(to);
        ndtsdb_lock_release(lock_fd);
        free(buf);
        fprintf(stderr, "Error: out of memory during merge\n");
        return 1;
    }
}

// ==================== Resample 子命令 ====================
typedef struct { int64_t timestamp; double open, high, low, close, volume; } OHLCV;
typedef struct { int64_t timestamp; double open, high, low, close, volume; } AggCandle;

int cmd_resample(int argc, char *argv[]) {
    const char *database = NULL;
    const char *symbol = NULL;
    const char *from_interval = NULL;
    const char *to_interval = NULL;
    const char *output_db = NULL;
    int help_flag = 0;

    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) { help_flag = 1; }
        else if ((strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) && i+1 < argc) database = argv[++i];
        else if ((strcmp(argv[i], "--symbol") == 0 || strcmp(argv[i], "-s") == 0) && i+1 < argc) symbol = argv[++i];
        else if ((strcmp(argv[i], "--from") == 0 || strcmp(argv[i], "-f") == 0) && i+1 < argc) from_interval = argv[++i];
        else if ((strcmp(argv[i], "--to") == 0 || strcmp(argv[i], "-t") == 0) && i+1 < argc) to_interval = argv[++i];
        else if ((strcmp(argv[i], "--output") == 0 || strcmp(argv[i], "-o") == 0) && i+1 < argc) output_db = argv[++i];
    }

    if (help_flag) {
        printf("Usage: ndtsdb-cli resample --database <path> --symbol <sym> --from <intv> --to <intv> [--output <db>]\n");
        printf("  Resample OHLCV data from smaller to larger timeframe\n");
        printf("  --database, -d  Source database path (required)\n");
        printf("  --symbol, -s    Symbol to resample (required)\n");
        printf("  --from, -f      Source interval, e.g., 1m (required)\n");
        printf("  --to, -t        Target interval, e.g., 5m, 15m, 1h (required)\n");
        printf("  --output, -o    Output database (default: stdout as JSONL)\n");
        printf("  Supported: 1m->5m(N=5), 1m->15m(N=15), 1m->1h(N=60), 5m->1h(N=12)\n");
        return 0;
    }

    if (!database || !symbol || !from_interval || !to_interval) {
        fprintf(stderr, "Error: --database, --symbol, --from, and --to are required\n");
        return 1;
    }

    int N = 0;
    if (strcmp(from_interval, "1m") == 0) {
        if (strcmp(to_interval, "5m") == 0) N = 5;
        else if (strcmp(to_interval, "15m") == 0) N = 15;
        else if (strcmp(to_interval, "1h") == 0) N = 60;
    } else if (strcmp(from_interval, "5m") == 0) {
        if (strcmp(to_interval, "1h") == 0) N = 12;
    }
    if (N == 0) {
        fprintf(stderr, "Error: Unsupported resample conversion: %s -> %s\n", from_interval, to_interval);
        return 1;
    }

    NDTSDB *db = ndtsdb_open(database);
    if (!db) { fprintf(stderr, "Error: Cannot open database: %s\n", database); return 1; }

    const char *syms[1] = {symbol};
    QueryResult *result = ndtsdb_query_filtered(db, syms, 1);
    if (!result) { ndtsdb_close(db); return 1; }

    typedef struct { KlineRow row; char symbol[32]; char interval[16]; } ResampleRow;
    ResampleRow *rows = (ResampleRow*)result->rows;

    OHLCV *candles = NULL;
    int candle_count = 0;
    int candle_capacity = 1024;
    candles = (OHLCV*)malloc(candle_capacity * sizeof(OHLCV));
    if (!candles) { ndtsdb_free_result(result); ndtsdb_close(db); return 1; }

    for (int i = 0; i < (int)result->count; i++) {
        if (rows[i].row.volume < 0) continue;
        if (strcmp(rows[i].interval, from_interval) != 0) continue;
        if (candle_count >= candle_capacity) {
            candle_capacity *= 2;
            OHLCV *tmp = (OHLCV*)realloc(candles, candle_capacity * sizeof(OHLCV));
            if (!tmp) { free(candles); ndtsdb_free_result(result); ndtsdb_close(db); return 1; }
            candles = tmp;
        }
        candles[candle_count].timestamp = rows[i].row.timestamp;
        candles[candle_count].open = rows[i].row.open;
        candles[candle_count].high = rows[i].row.high;
        candles[candle_count].low = rows[i].row.low;
        candles[candle_count].close = rows[i].row.close;
        candles[candle_count].volume = rows[i].row.volume;
        candle_count++;
    }
    ndtsdb_free_result(result);
    ndtsdb_close(db);

    if (candle_count == 0) {
        fprintf(stderr, "Error: No data found for %s/%s\n", symbol, from_interval);
        free(candles);
        return 1;
    }

    for (int i = 0; i < candle_count - 1; i++) {
        for (int j = i + 1; j < candle_count; j++) {
            if (candles[j].timestamp < candles[i].timestamp) {
                OHLCV tmp = candles[i]; candles[i] = candles[j]; candles[j] = tmp;
            }
        }
    }

    AggCandle *agg = NULL;
    int agg_count = 0;
    int agg_capacity = (candle_count + N - 1) / N + 1;
    agg = (AggCandle*)malloc(agg_capacity * sizeof(AggCandle));
    if (!agg) { free(candles); return 1; }

    for (int i = 0; i < candle_count; i += N) {
        int64_t ts = candles[i].timestamp;
        double open = candles[i].open;
        double high = candles[i].high;
        double low = candles[i].low;
        double close = candles[i].close;
        double volume = candles[i].volume;
        for (int j = i + 1; j < i + N && j < candle_count; j++) {
            if (candles[j].high > high) high = candles[j].high;
            if (candles[j].low < low) low = candles[j].low;
            close = candles[j].close;
            volume += candles[j].volume;
        }
        agg[agg_count].timestamp = ts;
        agg[agg_count].open = open;
        agg[agg_count].high = high;
        agg[agg_count].low = low;
        agg[agg_count].close = close;
        agg[agg_count].volume = volume;
        agg_count++;
    }
    free(candles);

    if (output_db) {
        NDTSDB *out_db = ndtsdb_open(output_db);
        if (!out_db) {
            fprintf(stderr, "Error: Cannot open output database: %s\n", output_db);
            free(agg);
            return 1;
        }
        KlineRow *batch = (KlineRow*)malloc(agg_count * sizeof(KlineRow));
        if (!batch) { ndtsdb_close(out_db); free(agg); return 1; }
        for (int i = 0; i < agg_count; i++) {
            batch[i].timestamp = agg[i].timestamp;
            batch[i].open = agg[i].open;
            batch[i].high = agg[i].high;
            batch[i].low = agg[i].low;
            batch[i].close = agg[i].close;
            batch[i].volume = agg[i].volume;
            batch[i].flags = 0;  // 初始化flags，避免垃圾值
        }
        int inserted = ndtsdb_insert_batch(out_db, symbol, to_interval, batch, agg_count);
        ndtsdb_close(out_db);
        free(batch);
        free(agg);
        printf("Resampled %d rows into %d %s candles (inserted: %d)\n", candle_count, agg_count, to_interval, inserted);
    } else {
        for (int i = 0; i < agg_count; i++) {
            printf("{\"symbol\":\"%s\",\"interval\":\"%s\",\"timestamp\":%lld,\"open\":%.8f,\"high\":%.8f,\"low\":%.8f,\"close\":%.8f,\"volume\":%.8f}\n",
                symbol, to_interval, (long long)agg[i].timestamp,
                agg[i].open, agg[i].high, agg[i].low, agg[i].close, agg[i].volume);
        }
        free(agg);
    }
    return 0;
}
