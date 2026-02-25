# ndtsdb-cli serve 高可用设计

## 1. 执行摘要

**目标**: 设计 ndtsdb-cli serve 的进程守护、数据持久化和健康检查方案
**现状**: serve 进程为单进程模型，无自动重启、无健康检查、无 fsync 保证
**设计原则**: 简单可靠、渐进增强、不引入分布式复杂度

---

## 2. 现状分析

### 2.1 当前 serve 架构 (cmd_serve.c)

```
┌─────────────────────────────────────────┐
│         ndtsdb-cli serve                │
│                                         │
│  ┌─────────┐    ┌───────────────┐      │
│  │ HTTP    │    │ QuickJS Context│      │
│  │ Server  │────│ + ndtsdb module │      │
│  │ :8080   │    │                 │      │
│  └─────────┘    └───────────────┘      │
│        │                                │
│        ▼                                │
│  ┌─────────────┐                        │
│  │   Database  │                        │
│  │  (内存+文件) │                        │
│  └─────────────┘                        │
└─────────────────────────────────────────┘
```

### 2.2 关键代码分析

**写入处理** (main.c:handle_http_request):
```c
// POST /write-json 处理
JSValue result = JS_Eval(ctx, js_code, strlen(js_code), "<serve>", JS_EVAL_TYPE_GLOBAL);
// ... 发送响应
```

**问题**:
1. 无 fsync 保证 - 写入响应成功后数据可能仍在页缓存
2. 无写入确认 - QuickJS 执行异常不会返回错误给客户端
3. 单进程模型 - crash 后服务完全不可用

### 2.3 信号处理

```c
static void signal_handler(int sig) {
    server_running = false;
    if (server_fd_global >= 0) {
        close(server_fd_global);
        server_fd_global = -1;
    }
}
```

**问题**: SIGSEGV/SIGABRT 未处理，会导致进程直接退出

---

## 3. 高可用设计方案

### 3.1 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                    Systemd / Container                  │
│  ┌─────────────────────────────────────────────────┐   │
│  │  ndtsdb-serve.service (Restart=always)          │   │
│  │                                                 │   │
│  │  ┌─────────────┐    ┌─────────────────────┐    │   │
│  │  │  Supervisor │────│  ndtsdb-cli serve   │    │   │
│  │  │  (health)   │    │                     │    │   │
│  │  └─────────────┘    │  ┌───────────────┐  │    │   │
│  │        │            │  │  fsync after  │  │    │   │
│  │        ▼            │  │  each write   │  │    │   │
│  │  ┌─────────────┐    │  └───────────────┘  │    │   │
│  │  │  Health     │    └─────────────────────┘    │   │
│  │  │  Check      │                               │   │
│  │  └─────────────┘                               │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### 3.2 子系统 1: Systemd 守护 (必须)

**服务文件** `~/.config/systemd/user/ndtsdb-serve.service`:

```ini
[Unit]
Description=NDTSDB HTTP/WebSocket Server
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/ndtsdb-cli serve --database %h/.ndtsdb/data --port 8080
ExecStartPre=/usr/local/bin/ndtsdb-cli doctor --database %h/.ndtsdb/data --auto-fix
Restart=always
RestartSec=5
StartLimitInterval=60
StartLimitBurst=3

# 健康检查
ExecCondition=/usr/local/bin/ndtsdb-cli health --port 8080 --timeout 5

# 资源限制
MemoryMax=256M
CPUQuota=50%

# 优雅关闭
TimeoutStopSec=30
KillSignal=SIGTERM

[Install]
WantedBy=default.target
```

**关键配置**:
- `Restart=always`: crash 后自动重启
- `ExecStartPre`: 启动前执行数据完整性检查
- `StartLimitBurst`: 防止崩溃循环

### 3.3 子系统 2: 写入持久化 (必须)

**C 层修改** (cmd_io.c / main.c):

```c
// 写入后强制刷盘
int write_with_fsync(const char* path, const void* data, size_t len) {
    int fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0644);
    if (fd < 0) return -1;
    
    ssize_t written = write(fd, data, len);
    if (written != len) {
        close(fd);
        return -1;
    }
    
    // 关键: 强制刷盘
    if (fsync(fd) < 0) {
        close(fd);
        return -1;
    }
    
    close(fd);
    return 0;
}
```

**fsync 策略**:

| 场景 | 策略 | 原因 |
|-----|------|------|
| POST /write-json | 每条记录 fsync | 确保写入成功 |
| POST /write-vector | 每条记录 fsync | 向量数据重要 |
| 批量导入 | 每 1000 条 fsync | 平衡性能和可靠性 |

### 3.4 子系统 3: 健康检查 (必须)

**端点设计**:

```
GET /health
Response:
{
  "status": "ok",           // ok | degraded | error
  "version": "1.0.0",
  "uptime_seconds": 3600,
  "database": {
    "path": "/path/to/db",
    "writable": true,
    "last_write_ms": 100
  },
  "connections": {
    "active": 5,
    "max": 100
  }
}
```

**实现代码** (main.c):

```c
// 健康检查端点
if (strcmp(path, "/health") == 0) {
    // 检查数据库可写性
    int writable = check_database_writable(database);
    
    char response[1024];
    snprintf(response, sizeof(response),
        "{\"status\":\"%s\",\"version\":\"1.0.0\",\"uptime\":%ld,\"db_writable\":%s}",
        writable ? "ok" : "error",
        time(NULL) - server_start_time,
        writable ? "true" : "false"
    );
    
    status = writable ? 200 : 503;
}
```

**外部健康检查脚本**:

```bash
#!/bin/bash
# ndtsdb-health-check.sh

PORT=${1:-8080}
TIMEOUT=${2:-5}

# HTTP 健康检查
response=$(curl -sf -m $TIMEOUT http://localhost:$PORT/health)
if [ $? -ne 0 ]; then
    echo "CRITICAL: HTTP endpoint unreachable"
    exit 2
fi

# 解析状态
status=$(echo "$response" | jq -r '.status')
if [ "$status" != "ok" ]; then
    echo "WARNING: Service status is $status"
    exit 1
fi

echo "OK: Service healthy"
exit 0
```

### 3.5 子系统 4: 数据完整性校验 (推荐)

**启动时校验**:

```c
// ndtsdb_doctor.c
int ndtsdb_doctor_check(const char* db_path, bool auto_fix) {
    int issues = 0;
    
    DIR* dir = opendir(db_path);
    struct dirent* ent;
    
    while ((ent = readdir(dir)) != NULL) {
        if (strstr(ent->d_name, ".ndts")) {
            // 检查 .ndts 文件完整性
            if (!check_ndts_integrity(filepath)) {
                issues++;
                if (auto_fix) {
                    repair_ndts_file(filepath);
                }
            }
        }
        else if (strstr(ent->d_name, ".ndtv")) {
            // 检查 .ndtv 文件完整性
            if (!check_ndtv_integrity(filepath)) {
                issues++;
            }
        }
    }
    
    // 检查并修复 WAL
    issues += wal_replay_if_needed(db_path);
    
    return issues;
}
```

**校验项目**:

| 校验项 | 方法 | 自动修复 |
|-------|------|---------|
| .ndts Magic | 读取前4字节 | ❌ |
| .ndts Header CRC | CRC32 校验 | ❌ |
| .ndts Chunk CRC | CRC32 校验 | ❌ |
| .ndtv Magic | 读取前4字节 | ❌ |
| .ndtv Record Count | 与实际记录对比 | ⚠️ 可调整 |
| WAL 未提交记录 | 检查 committed 标志 | ✅ 重放 |

### 3.6 子系统 5: 优雅关闭 (必须)

**信号处理增强**:

```c
static volatile bool shutdown_requested = false;

static void signal_handler(int sig) {
    if (sig == SIGTERM || sig == SIGINT) {
        shutdown_requested = true;
        // 不再立即关闭 socket，让正在处理的请求完成
    }
}

// 主循环
while (server_running && !shutdown_requested) {
    // 设置 select 超时，定期检查 shutdown_requested
    struct timeval tv = {1, 0};  // 1秒超时
    int ready = select(max_fd + 1, &readfds, NULL, NULL, &tv);
    
    if (shutdown_requested) {
        // 等待正在处理的请求完成（最多10秒）
        wait_for_pending_requests(10000);
        break;
    }
}

// 清理资源
ndtsdb_close(db);
ndtsdb_lock_release(lock_fd);
```

---

## 4. 实施路线图

### Phase 1: 立即实施 (本周)

1. **创建 systemd 服务文件**
   ```bash
   mkdir -p ~/.config/systemd/user
   # 写入 ndtsdb-serve.service
   systemctl --user daemon-reload
   systemctl --user enable ndtsdb-serve
   ```

2. **添加基础健康检查端点**
   - 修改 main.c 增强 /health 端点
   - 添加数据库可写性检查

3. **增强信号处理**
   - 处理 SIGTERM/SIGINT 优雅关闭
   - 设置 shutdown_requested 标志

### Phase 2: 短期 (2周)

1. **写入持久化**
   - 在 write-json 和 write-vector 后添加 fsync
   - 添加写入确认响应

2. **启动时数据校验**
   - 实现 ndtsdb_doctor_check()
   - 在 ExecStartPre 中调用

3. **WAL 自动重放**
   - ndtsdb_open() 时自动检查 WAL
   - 自动重放未提交记录

### Phase 3: 中期 (1个月)

1. **向量文件 CRC**
   - 添加 ndtv 记录 CRC 校验
   - 读取时校验并跳过损坏记录

2. **监控集成**
   - 定期自检测（每60秒）
   - 异常情况上报（通过 Telegram bot）

---

## 5. 故障处理流程

### 5.1 故障检测

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ Systemd     │────▶│ Health      │────▶│ Log         │
│ Watchdog    │     │ Check       │     │ Monitoring  │
└─────────────┘     └─────────────┘     └─────────────┘
       │                   │                   │
       ▼                   ▼                   ▼
  Process crash      Service degraded     Error pattern
```

### 5.2 自动恢复流程

```
1. Systemd 检测到进程退出
   ↓
2. ExecStartPre: 运行数据校验
   ↓
3a. 校验通过 ──▶ 启动服务
   ↓
3b. 校验失败 ──▶ 修复数据 ──▶ 启动服务
   ↓
4. 健康检查确认服务正常
```

### 5.3 手动干预场景

| 场景 | 症状 | 处理 |
|-----|------|------|
| 数据文件严重损坏 | 校验无法修复 | 从备份恢复 |
| 磁盘满 | 写入失败 | 清理旧数据 |
| 内存溢出 | OOM killed | 调整 MemoryMax |
| 端口冲突 | 启动失败 | 修改端口配置 |

---

## 6. 配置示例

### 6.1 完整 systemd 配置

```ini
# ~/.config/systemd/user/ndtsdb-serve.service
[Unit]
Description=NDTSDB HTTP/WebSocket Server
Documentation=https://github.com/openclaw/openclaw/tree/main/ndtsdb-cli
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
NotifyAccess=all

Environment="NDTSDB_HOME=%h/.ndtsdb"
Environment="NDTSDB_PORT=8080"
Environment="NDTSDB_FFSYNC=1"

ExecStartPre=/bin/mkdir -p ${NDTSDB_HOME}/data
ExecStartPre=/usr/local/bin/ndtsdb-cli doctor --database ${NDTSDB_HOME}/data --auto-fix

ExecStart=/usr/local/bin/ndtsdb-cli serve \
    --database ${NDTSDB_HOME}/data \
    --port ${NDTSDB_PORT} \
    --fsync=${NDTSDB_FFSYNC}

ExecReload=/bin/kill -HUP $MAINPID

Restart=on-failure
RestartSec=5
StartLimitInterval=300
StartLimitBurst=10

# 资源限制
MemoryMax=512M
MemorySwapMax=0
TasksMax=50
CPUQuota=80%

# 安全限制
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${NDTSDB_HOME}/data

# 日志
StandardOutput=journal
StandardError=journal
SyslogIdentifier=ndtsdb-serve

[Install]
WantedBy=default.target
```

### 6.2 健康检查定时任务

```bash
# ~/.config/systemd/user/ndtsdb-health.timer
[Unit]
Description=NDTSDB Health Check Timer

[Timer]
OnBootSec=60
OnUnitActiveSec=60

[Install]
WantedBy=timers.target
```

```ini
# ~/.config/systemd/user/ndtsdb-health.service
[Unit]
Description=NDTSDB Health Check

[Service]
Type=oneshot
ExecStart=/usr/local/bin/ndtsdb-cli health-check --port 8080 --notify-on-failure
```

---

## 7. 测试验证

### 7.1 故障注入测试

```bash
#!/bin/bash
# test-ha.sh

DB_PATH="/tmp/test-ndtsdb-ha"
PORT=18080

echo "=== Test 1: Process crash recovery ==="
ndtsdb-cli serve --database $DB_PATH --port $PORT &
PID=$!
sleep 2

# 写入数据
echo '{"symbol":"TEST","interval":"1m","timestamp":1234567890,"open":1}' | \
    ndtsdb-cli write-json --database $DB_PATH

# 强制 kill
kill -9 $PID

# 等待重启
sleep 6

# 验证数据
curl -s http://localhost:$PORT/query?symbol=TEST | grep -q "TEST" && echo "PASS" || echo "FAIL"

echo "=== Test 2: Data corruption detection ==="
# 损坏文件头
echo "CORRUPT" > $DB_PATH/2024-01-01.ndts
ndtsdb-cli doctor --database $DB_PATH 2>&1 | grep -q "corrupt" && echo "PASS" || echo "FAIL"
```

---

## 8. 附录

### 8.1 相关文件

- 当前 serve 实现: `ndtsdb-cli/src/cmd_serve.c`
- HTTP 处理: `ndtsdb-cli/src/main.c:handle_http_request()`
- 写入逻辑: `ndtsdb-cli/src/cmd_io.c`
- WAL 实现: `ndtsdb-cli/src/ndtsdb_lock.c`

### 8.2 参考实现

- SQLite WAL 模式: https://sqlite.org/wal.html
- systemd.service 文档: https://www.freedesktop.org/software/systemd/man/systemd.service.html
- Linux fsync: man 2 fsync

---

*设计完成时间: 2026-02-21*
*设计者: bot-00d*
