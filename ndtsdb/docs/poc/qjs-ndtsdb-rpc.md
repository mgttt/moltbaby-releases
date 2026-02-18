# qjs-ndtsdb-rpc MVP

目的：把 `ndtsdb` 关键路径从 QuickJS 内存态脱离，改成独立进程，通过 stdio JSON-RPC 做最小验证。

## 运行方式

```bash
cd /home/devali/moltbaby/ndtsdb
./scripts/build-qjs-rpc.sh
bun run test:qjs-rpc   # 3 条回归：open/insert/query/close + 并发
```

## 协议

每行一个 JSON 对象。

- `open`: `{"id":1,"op":"open","path":"/tmp/db.ndts"}`
- `insert`: `{"id":2,"op":"insert","db":1,"symbol":"BTCUSDT","interval":"1m","timestamp":1,"open":1,"high":2,"low":1,"close":1.5,"volume":10}`
- `query`: `{"id":3,"op":"query","db":1,"symbol":"BTCUSDT","interval":"1m","start":0,"end":999999999,"limit":100}`
- `close`: `{"id":4,"op":"close","db":1}`

响应示例：
- 成功：`{"id":1,"ok":true,"result":1}`
- 失败：`{"id":1,"ok":false,"error":"..."}`
