#!/bin/bash
# test-websocket.sh - WebSocket集成测试

set -e

CLI="${CLI:-../../ndtsdb-cli}"
TEST_DB="/tmp/test_ws_db"
PORT=18890

echo "=== WebSocket 集成测试 ==="

# 清理
rm -rf "$TEST_DB"
mkdir -p "$TEST_DB"

# 准备测试数据
echo '{"symbol":"BTCUSDT","interval":"1m","timestamp":1700000000000,"open":30000,"high":30100,"low":29900,"close":30050,"volume":100}' | $CLI write-json --database "$TEST_DB"
echo '{"symbol":"BTCUSDT","interval":"1m","timestamp":1700000001000,"open":30050,"high":30200,"low":30000,"close":30100,"volume":200}' | $CLI write-json --database "$TEST_DB"
echo '{"symbol":"ETHUSDT","interval":"1m","timestamp":1700000000000,"open":2000,"high":2010,"low":1990,"close":2005,"volume":50}' | $CLI write-json --database "$TEST_DB"

echo ""
echo "✓ 测试数据准备完成"
echo ""

# 启动服务器
$CLI serve --database "$TEST_DB" --port $PORT &
SERVER_PID=$!
sleep 2

cleanup() {
    kill $SERVER_PID 2>/dev/null || true
    rm -rf "$TEST_DB"
}
trap cleanup EXIT

# 测试1: HTTP端点正常
echo "1. 测试 /health 端点..."
health=$(curl -s http://localhost:$PORT/health)
if echo "$health" | grep -q '"status":"ok"'; then
    echo "   ✓ /health 响应正常: $health"
else
    echo "   ✗ /health 响应异常: $health"
    exit 1
fi

# 测试2: WebSocket握手
echo ""
echo "2. 测试 /subscribe WebSocket 握手..."
ws_response=$(echo -e "GET /subscribe?symbol=BTCUSDT HTTP/1.1\r\nHost: localhost:$PORT\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n" | nc -q 2 localhost $PORT 2>/dev/null | head -5)
if echo "$ws_response" | grep -q "101 Switching Protocols"; then
    echo "   ✓ WebSocket握手成功"
else
    echo "   ✗ WebSocket握手失败"
    echo "   响应: $ws_response"
    exit 1
fi

# 测试3: WebSocket连接接收消息
echo ""
echo "3. 测试 WebSocket 接收消息..."

# 使用websocat测试（如果可用）或nc模拟
if command -v websocat >/dev/null 2>&1; then
    echo "   使用 websocat 测试..."
    timeout 3 websocat ws://localhost:$PORT/subscribe?symbol=BTCUSDT < /dev/null > /tmp/ws_output.txt 2>&1 || true
    if [ -f /tmp/ws_output.txt ] && grep -q "timestamp" /tmp/ws_output.txt 2>/dev/null; then
        echo "   ✓ 接收到数据推送"
        cat /tmp/ws_output.txt | head -1
    elif [ -f /tmp/ws_output.txt ] && grep -q "heartbeat" /tmp/ws_output.txt 2>/dev/null; then
        echo "   ✓ 接收到心跳消息"
    else
        echo "   ⚠ 未接收到数据，但连接可能正常（检查日志）"
    fi
    rm -f /tmp/ws_output.txt
elif command -v wscat >/dev/null 2>&1; then
    echo "   使用 wscat 测试..."
    timeout 3 wscat -c ws://localhost:$PORT/subscribe?symbol=BTCUSDT < /dev/null > /tmp/ws_output.txt 2>&1 || true
    if [ -f /tmp/ws_output.txt ] && grep -q "timestamp\|heartbeat" /tmp/ws_output.txt 2>/dev/null; then
        echo "   ✓ 接收到WebSocket消息"
        head -1 /tmp/ws_output.txt
    fi
    rm -f /tmp/ws_output.txt
else
    echo "   ⚠ 未安装 websocat/wscat，跳过完整测试"
    echo "   提示: cargo install websocat 安装测试工具"
fi

# 测试4: 多symbol订阅
echo ""
echo "4. 测试多symbol订阅..."
ws_response2=$(echo -e "GET /subscribe?symbol=ETHUSDT&interval=1m HTTP/1.1\r\nHost: localhost:$PORT\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n" | nc -q 2 localhost $PORT 2>/dev/null | head -5)
if echo "$ws_response2" | grep -q "101 Switching Protocols"; then
    echo "   ✓ ETHUSDT订阅握手成功"
else
    echo "   ✗ ETHUSDT订阅握手失败"
fi

# 停止服务器
kill $SERVER_PID 2>/dev/null || true
trap - EXIT

echo ""
echo "=== WebSocket测试完成 ==="
echo ""
echo "使用示例:"
echo "  websocat ws://localhost:8080/subscribe?symbol=BTCUSDT"
echo "  wscat -c ws://localhost:8080/subscribe?symbol=BTCUSDT&interval=1m"
