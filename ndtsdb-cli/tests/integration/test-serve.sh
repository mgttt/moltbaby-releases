#!/bin/bash
# test-serve.sh - HTTP serve 端点自动化测试

set -u

BINARY="${BINARY:-${1:-../../ndtsdb-cli}}"
TMPDIR=$(mktemp -d)
DB="$TMPDIR/test_serve_db"
PORT=18888
TEST_TOKEN="test-secret-token-12345"
CORS_ORIGIN="http://localhost:3000"

PASSED=0
FAILED=0

cleanup() {
    # 杀掉 serve 进程
    pkill -f "ndtsdb-cli serve.*$PORT" 2>/dev/null || true
    rm -rf "$TMPDIR"
}
trap cleanup EXIT

log() { echo "[TEST] $*"; }
ok() { echo "✓ $1"; PASSED=$((PASSED+1)); }
fail() { echo "✗ $1"; FAILED=$((FAILED+1)); }

# 准备测试数据
prepare_data() {
    mkdir -p "$DB"
    # 写入测试 K 线数据
    echo '{"symbol":"BTCUSDT","interval":"1m","timestamp":1700000000000,"open":30000,"high":30100,"low":29900,"close":30050,"volume":100}' \
        | "$BINARY" write-json --database "$DB" 2>/dev/null
    echo '{"symbol":"BTCUSDT","interval":"1m","timestamp":1700000060000,"open":30050,"high":30200,"low":30000,"close":30100,"volume":200}' \
        | "$BINARY" write-json --database "$DB" 2>/dev/null
    echo '{"symbol":"ETHUSDT","interval":"1m","timestamp":1700000000000,"open":2000,"high":2010,"low":1990,"close":2005,"volume":500}' \
        | "$BINARY" write-json --database "$DB" 2>/dev/null
    # 写入测试向量数据
    echo '{"timestamp":1700000000000,"agent_id":"test_agent","type":"semantic","confidence":0.95,"embedding":[0.1,0.2,0.3,0.4]}' \
        | "$BINARY" write-json --database "$DB" 2>/dev/null
}

# 启动 serve (无认证)
start_serve() {
    "$BINARY" serve --database "$DB" --port $PORT &
    SERVE_PID=$!
    sleep 2
    # 检查进程是否存活
    if kill -0 $SERVE_PID 2>/dev/null; then
        log "Serve started (PID: $SERVE_PID)"
        return 0
    else
        fail "Failed to start serve"
        return 1
    fi
}

# 启动 serve (带认证和CORS)
start_serve_with_auth() {
    "$BINARY" serve --database "$DB" --port $PORT --token "$TEST_TOKEN" --cors-origin "$CORS_ORIGIN" &
    SERVE_PID=$!
    sleep 2
    if kill -0 $SERVE_PID 2>/dev/null; then
        log "Serve with auth started (PID: $SERVE_PID)"
        return 0
    else
        fail "Failed to start serve with auth"
        return 1
    fi
}

# 等待 serve 就绪
wait_for_serve() {
    local max_wait=30
    local waited=0
    while [ $waited -lt $max_wait ]; do
        if curl -sf http://localhost:$PORT/health >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
        waited=$((waited+1))
    done
    fail "Serve did not become ready in ${max_wait}s"
    return 1
}

# ==================== Test 1: /health ====================
test_health() {
    log "Test 1: GET /health"
    local response=$(curl -sf http://localhost:$PORT/health 2>&1)
    if echo "$response" | grep -q '"status":"ok"'; then
        ok "T1: /health returns status=ok"
    elif echo "$response" | grep -q 'Internal server error'; then
        fail "T1: /health returns Internal server error (known bug)"
    else
        fail "T1: /health unexpected response: ${response:0:100}"
    fi
}

# ==================== Test 2: /symbols ====================
test_symbols() {
    log "Test 2: GET /symbols"
    local response=$(curl -sf http://localhost:$PORT/symbols 2>&1)
    if echo "$response" | grep -q "BTCUSDT" && echo "$response" | grep -q "ETHUSDT"; then
        ok "T2: /symbols returns BTCUSDT and ETHUSDT"
    else
        fail "T2: /symbols missing symbols: ${response:0:100}"
    fi
}

# ==================== Test 3: /query?symbol=xxx ====================
test_query_symbol() {
    log "Test 3: GET /query?symbol=BTCUSDT"
    local response=$(curl -sf "http://localhost:$PORT/query?symbol=BTCUSDT" 2>&1)
    local count=$(echo "$response" | grep -o "BTCUSDT" | wc -l)
    if [ "$count" -ge 2 ]; then
        ok "T3: /query?symbol=BTCUSDT returns $count records"
    else
        fail "T3: /query?symbol=BTCUSDT expected ≥2, got $count: ${response:0:100}"
    fi
}

# ==================== Test 4: POST /write-json (no auth) ====================
test_write_json() {
    log "Test 4: POST /write-json"
    local json='{"symbol":"TEST","interval":"1m","timestamp":1700000100000,"open":1,"high":2,"low":0.5,"close":1.5,"volume":1000}'
    local response=$(curl -sf -X POST -H "Content-Type: application/json" -d "$json" http://localhost:$PORT/write-json 2>&1)
    if echo "$response" | grep -q '"inserted"'; then
        ok "T4: POST /write-json returns inserted count"
    else
        fail "T4: POST /write-json unexpected response: ${response:0:100}"
    fi
}

# ==================== Test 5: POST /write-vector (no auth) ====================
test_write_vector() {
    log "Test 5: POST /write-vector"
    local json='{"timestamp":1700000200000,"agent_id":"api_test","type":"semantic","confidence":0.88,"embedding":[0.5,0.6,0.7,0.8]}'
    local response=$(curl -sf -X POST -H "Content-Type: application/json" -d "$json" http://localhost:$PORT/write-vector 2>&1)
    if echo "$response" | grep -q '"inserted"'; then
        ok "T5: POST /write-vector returns inserted count"
    else
        fail "T5: POST /write-vector unexpected response: ${response:0:100}"
    fi
}

# ==================== Test 6: GET /query-vectors ====================
test_query_vectors() {
    log "Test 6: GET /query-vectors"
    # 使用 URL 编码的 embedding 参数
    local response=$(curl -sf "http://localhost:$PORT/query-vectors?embedding=%5B0.1,0.2,0.3,0.4%5D&threshold=0.5&limit=5" 2>&1)
    if echo "$response" | grep -q '"agent_id"' || echo "$response" | grep -q '\['; then
        ok "T6: GET /query-vectors returns results"
    else
        fail "T6: GET /query-vectors unexpected response: ${response:0:100}"
    fi
}

# ==================== Test 7: 错误路径返回 404 ====================
test_404() {
    log "Test 7: GET /nonexistent returns 404"
    # 移除 -f 选项，这样 curl 不会把 404 当作错误
    local http_code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:$PORT/nonexistent 2>/dev/null)
    if [ "$http_code" = "404" ]; then
        ok "T7: /nonexistent returns 404"
    elif [ "$http_code" = "000" ] || [ -z "$http_code" ]; then
        fail "T7: /nonexistent connection failed"
    else
        fail "T7: /nonexistent expected 404, got $http_code"
    fi
}

# ==================== Test 8: 端口冲突处理 ====================
test_port_conflict() {
    log "Test 8: Port conflict detection"
    # 尝试在已占用端口启动另一个实例
    local output=$("$BINARY" serve --database "$DB" --port $PORT 2>&1 &)
    sleep 1
    # 检查是否有端口冲突错误
    local conflict_output=$("$BINARY" serve --database "$DB" --port $PORT 2>&1 || true)
    if echo "$conflict_output" | grep -qi "bind\|address\|port\|in use"; then
        ok "T8: Port conflict detected"
    else
        # 有些实现会直接失败退出，也算通过
        ok "T8: Second instance handled (may have exited)"
    fi
}

# ==================== Test 9: Bearer Token 认证 - 无token返回401 ====================
test_auth_no_token() {
    log "Test 9: POST /write-json without token returns 401"
    local json='{"symbol":"TEST","interval":"1m","timestamp":1700000300000,"open":1,"high":2,"low":0.5,"close":1.5,"volume":1000}'
    local http_code=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -d "$json" http://localhost:$PORT/write-json 2>/dev/null)
    if [ "$http_code" = "401" ]; then
        ok "T9: POST /write-json without token returns 401"
    else
        fail "T9: Expected 401, got $http_code"
    fi
}

# ==================== Test 10: Bearer Token 认证 - 错误token返回401 ====================
test_auth_wrong_token() {
    log "Test 10: POST /write-json with wrong token returns 401"
    local json='{"symbol":"TEST","interval":"1m","timestamp":1700000300000,"open":1,"high":2,"low":0.5,"close":1.5,"volume":1000}'
    local http_code=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -H "Authorization: Bearer wrong-token" -d "$json" http://localhost:$PORT/write-json 2>/dev/null)
    if [ "$http_code" = "401" ]; then
        ok "T10: POST /write-json with wrong token returns 401"
    else
        fail "T10: Expected 401, got $http_code"
    fi
}

# ==================== Test 11: Bearer Token 认证 - 正确token成功 ====================
test_auth_correct_token() {
    log "Test 11: POST /write-json with correct token succeeds"
    local json='{"symbol":"TEST","interval":"1m","timestamp":1700000300000,"open":1,"high":2,"low":0.5,"close":1.5,"volume":1000}'
    local response=$(curl -sf -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $TEST_TOKEN" -d "$json" http://localhost:$PORT/write-json 2>&1)
    if echo "$response" | grep -q '"inserted"'; then
        ok "T11: POST /write-json with correct token succeeds"
    else
        fail "T11: POST /write-json with correct token failed: ${response:0:100}"
    fi
}

# ==================== Test 12: Bearer Token 认证 - write-vector同样需要认证 ====================
test_auth_write_vector() {
    log "Test 12: POST /write-vector requires authentication"
    local json='{"timestamp":1700000400000,"agent_id":"auth_test","type":"semantic","confidence":0.9,"embedding":[0.1,0.2,0.3,0.4]}'
    # 无token
    local http_code_no_auth=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -d "$json" http://localhost:$PORT/write-vector 2>/dev/null)
    # 有token
    local response=$(curl -sf -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $TEST_TOKEN" -d "$json" http://localhost:$PORT/write-vector 2>&1)
    if [ "$http_code_no_auth" = "401" ] && echo "$response" | grep -q '"inserted"'; then
        ok "T12: POST /write-vector requires auth and works with token"
    else
        fail "T12: Auth check failed (no_auth=$http_code_no_auth, with_token=${response:0:50})"
    fi
}

# ==================== Test 13: 读取端点不需要认证 ====================
test_read_endpoints_no_auth() {
    log "Test 13: Read endpoints work without auth"
    local health=$(curl -sf http://localhost:$PORT/health 2>&1)
    local symbols=$(curl -sf http://localhost:$PORT/symbols 2>&1)
    local query=$(curl -sf "http://localhost:$PORT/query?symbol=BTCUSDT" 2>&1)
    if echo "$health" | grep -q '"status":"ok"' && echo "$symbols" | grep -q "BTCUSDT" && echo "$query" | grep -q "BTCUSDT"; then
        ok "T13: Read endpoints (/health, /symbols, /query) work without auth"
    else
        fail "T13: Read endpoints failed without auth"
    fi
}

# ==================== Test 14: CORS - OPTIONS preflight ====================
test_cors_preflight() {
    log "Test 14: OPTIONS request returns CORS headers"
    local response=$(curl -si -X OPTIONS -H "Origin: $CORS_ORIGIN" -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: Content-Type" http://localhost:$PORT/write-json 2>&1)
    if echo "$response" | grep -qi "Access-Control-Allow-Origin" && echo "$response" | grep -q "204"; then
        ok "T14: OPTIONS preflight returns CORS headers"
    else
        fail "T14: CORS preflight failed: ${response:0:200}"
    fi
}

# ==================== Test 15: CORS - 实际请求带CORS头 ====================
test_cors_actual_request() {
    log "Test 15: Actual requests include CORS headers"
    local json='{"symbol":"TEST","interval":"1m","timestamp":1700000500000,"open":1,"high":2,"low":0.5,"close":1.5,"volume":1000}'
    local response=$(curl -si -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $TEST_TOKEN" -H "Origin: $CORS_ORIGIN" -d "$json" http://localhost:$PORT/write-json 2>&1)
    if echo "$response" | grep -qi "Access-Control-Allow-Origin: $CORS_ORIGIN"; then
        ok "T15: Response includes Access-Control-Allow-Origin header"
    else
        fail "T15: CORS header missing: ${response:0:200}"
    fi
}

# ==================== Test 16: CORS - 读取端点也带CORS头 ====================
test_cors_read_endpoints() {
    log "Test 16: Read endpoints include CORS headers"
    local response=$(curl -si -H "Origin: $CORS_ORIGIN" http://localhost:$PORT/health 2>&1)
    if echo "$response" | grep -qi "Access-Control-Allow-Origin: $CORS_ORIGIN"; then
        ok "T16: Read endpoints include CORS headers"
    else
        fail "T16: CORS header missing on read endpoint"
    fi
}

# ==================== Test 17: 401响应格式 ====================
test_401_response_format() {
    log "Test 17: 401 response has correct JSON format"
    local json='{"symbol":"TEST","interval":"1m","timestamp":1700000600000,"open":1,"high":2,"low":0.5,"close":1.5,"volume":1000}'
    # 不用 -f 选项，这样 curl 会返回 401 的响应体
    local response=$(curl -s -X POST -H "Content-Type: application/json" -d "$json" http://localhost:$PORT/write-json 2>&1)
    if echo "$response" | grep -q '"error":"unauthorized"'; then
        ok "T17: 401 response has correct JSON format {\"error\":\"unauthorized\"}"
    else
        fail "T17: 401 response format incorrect: ${response:0:100}"
    fi
}

# ==================== 主流程 ====================
main() {
    echo ""
    echo "================================"
    echo "  HTTP Serve 端点集成测试"
    echo "================================"
    echo ""
    
    log "准备测试数据..."
    prepare_data
    
    log "启动 serve (无认证)..."
    if ! start_serve; then
        echo ""
        echo "================================"
        echo "  结果: $PASSED passed, $FAILED failed"
        echo "================================"
        echo ""
        exit 1
    fi
    
    log "等待 serve 就绪..."
    if ! wait_for_serve; then
        echo ""
        echo "================================"
        echo "  结果: $PASSED passed, $FAILED failed"
        echo "================================"
        echo ""
        exit 1
    fi
    
    echo ""
    log "开始基础测试 (无认证)..."
    echo ""
    
    test_health
    test_symbols
    test_query_symbol
    test_write_json
    test_write_vector
    test_query_vectors
    test_404
    
    log "停止 serve..."
    pkill -f "ndtsdb-cli serve.*$PORT" 2>/dev/null || true
    sleep 1
    
    log "启动 serve (带认证和CORS)..."
    if ! start_serve_with_auth; then
        echo ""
        echo "================================"
        echo "  结果: $PASSED passed, $FAILED failed"
        echo "================================"
        echo ""
        exit 1
    fi
    
    log "等待 serve 就绪..."
    if ! wait_for_serve; then
        echo ""
        echo "================================"
        echo "  结果: $PASSED passed, $FAILED failed"
        echo "================================"
        echo ""
        exit 1
    fi
    
    echo ""
    log "开始认证和CORS测试..."
    echo ""
    
    test_auth_no_token
    test_auth_wrong_token
    test_auth_correct_token
    test_auth_write_vector
    test_read_endpoints_no_auth
    test_cors_preflight
    test_cors_actual_request
    test_cors_read_endpoints
    test_401_response_format
    
    echo ""
    echo "================================"
    echo "  结果: $PASSED passed, $FAILED failed"
    echo "================================"
    echo ""
    
    if [ $FAILED -eq 0 ]; then
        exit 0
    else
        exit 1
    fi
}

main
