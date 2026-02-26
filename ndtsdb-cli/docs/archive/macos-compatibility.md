# macOS 跨平台兼容性分析报告

## 分析日期
2026-02-22

## 分析目标
ndtsdb-cli 当前仅在 Linux x64 测试过，本报告分析 macOS 编译兼容性问题。

---

## 1. 发现的 Linux 特有 API

### 1.1 clock_gettime() - ⚠️ 需要适配

**位置**: `src/main.c:386`
```c
clock_gettime(CLOCK_REALTIME, &ts);
```

**问题**:
- `clock_gettime()` 在 macOS 10.12 之前不可用
- macOS 上需要链接 `-lrt` 或使用替代方案

**适配方案**:
```c
#ifdef __APPLE__
#include <mach/mach_time.h>
// 或使用 gettimeofday()
#else
#include <time.h>
#endif
```

**优先级**: 高（影响 `__getTimeMs()` 函数）

### 1.2 getline() - ⚠️ 需要适配

**位置**: `src/main.c:396`
```c
ssize_t len = getline(&line_buffer, &buffer_size, stdin);
```

**问题**:
- `getline()` 是 GNU 扩展，macOS 原生不支持
- Windows 完全不支持

**适配方案**:
```c
#ifdef __APPLE__
// 使用 fgets 替代
static char *getline_compat(char **lineptr, size_t *n, FILE *stream) {
    if (*lineptr == NULL || *n == 0) {
        *n = 128;
        *lineptr = malloc(*n);
    }
    if (fgets(*lineptr, *n, stream) == NULL) return -1;
    size_t len = strlen(*lineptr);
    while (len > 0 && (*lineptr)[len-1] == '\n') {
        (*lineptr)[--len] = '\0';
    }
    return len;
}
#define getline getline_compat
#endif
```

**优先级**: 高（影响 `write-csv`, `write-json`, `sql` 子命令）

### 1.3 struct sockaddr_in - ✅ 100% 兼容

**位置**: `src/main.c` (serve 子命令)
```c
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
```

**分析**: 这些是 POSIX 标准头文件，macOS 完全支持。

**状态**: 无需修改

### 1.4 setsockopt() / SO_REUSEADDR - ✅ 100% 兼容

**位置**: `src/main.c:1362`
```c
setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt))
```

**分析**: POSIX 标准接口，macOS 完全支持。

**状态**: 无需修改

### 1.5 accept() / recv() / send() - ✅ 100% 兼容

**位置**: `src/main.c` (HTTP server 实现)

**分析**: BSD socket API，macOS 原生支持。

**状态**: 无需修改

### 1.6 stat() / struct stat - ✅ 100% 兼容

**位置**: `src/main.c:359-360`
```c
struct stat st;
int exists = (stat(path, &st) == 0);
```

**分析**: POSIX 标准接口，macOS 完全支持。

**状态**: 无需修改

### 1.7 pclose() - ✅ 100% 兼容

**位置**: `src/main.c:80` (ws_accept 函数)
```c
pclose(p);
```

**分析**: POSIX 标准接口，macOS 完全支持。

**状态**: 无需修改

---

## 2. 未发现的 Linux 特有 API

以下 API **未在代码中使用**，无兼容性问题：

- ❌ `epoll` - 未使用（使用 `select()` 风格的同步阻塞）
- ❌ `kqueue` - 未使用
- ❌ `O_DIRECT` - 未使用
- ❌ `SOCK_NONBLOCK` - 未使用
- ❌ `accept4()` - 未使用（使用 `accept()`）
- ❌ `SO_REUSEPORT` - 未使用
- ❌ `flock()` - 未使用
- ❌ `fcntl()` - 未使用

---

## 3. 需要添加的平台适配

### 3.1 clock_gettime 适配（高优先级）

在 `src/main.c` 开头添加：

```c
// macOS 兼容性
#ifdef __APPLE__
#include <mach/mach_time.h>
#include <AvailabilityMacros.h>

// macOS 10.12+ 支持 clock_gettime，旧版本需要替代
#if !defined(MAC_OS_X_VERSION_10_12) || MAC_OS_X_VERSION_MAX_ALLOWED < MAC_OS_X_VERSION_10_12
static int clock_gettime_compat(int clk_id, struct timespec *ts) {
    clock_serv_t cclock;
    mach_timespec_t mts;
    host_get_clock_service(mach_host_self(), CALENDAR_CLOCK, &cclock);
    clock_get_time(cclock, &mts);
    mach_port_deallocate(mach_task_self(), cclock);
    ts->tv_sec = mts.tv_sec;
    ts->tv_nsec = mts.tv_nsec;
    return 0;
}
#define clock_gettime clock_gettime_compat
#endif
#endif
```

### 3.2 getline 适配（高优先级）

在 `src/main.c` 中添加：

```c
// macOS/Windows 兼容的 getline
#ifdef __APPLE__
static ssize_t portable_getline(char **lineptr, size_t *n, FILE *stream) {
    if (!lineptr || !stream) return -1;
    
    if (*lineptr == NULL || *n == 0) {
        *n = 256;
        *lineptr = malloc(*n);
        if (!*lineptr) return -1;
    }
    
    size_t len = 0;
    int c;
    while ((c = fgetc(stream)) != EOF && c != '\n') {
        if (len + 1 >= *n) {
            *n *= 2;
            char *new_buf = realloc(*lineptr, *n);
            if (!new_buf) return -1;
            *lineptr = new_buf;
        }
        (*lineptr)[len++] = (char)c;
    }
    
    if (len == 0 && c == EOF) return -1;
    (*lineptr)[len] = '\0';
    return (ssize_t)len;
}
#define getline portable_getline
#endif
```

---

## 4. Makefile / build.zig 适配

### 4.1 Makefile 当前状态

当前 Makefile 使用 `-static` 链接：
```makefile
LDFLAGS = -static
```

**问题**: macOS 不支持静态链接系统库。

**适配方案**:
```makefile
# macOS 不支持静态链接
ifeq ($(shell uname -s),Darwin)
LDFLAGS = 
else
LDFLAGS = -static
endif
```

### 4.2 build.zig 目标配置

Zig 已支持 macOS 目标：
```bash
zig build -Dtarget=x86_64-macos
zig build -Dtarget=aarch64-macos
```

**建议**: 在 `build.zig` 中添加明确的 macOS 目标支持。

---

## 5. 100% 兼容的部分

以下代码**无需任何修改**即可在 macOS 上编译运行：

1. **核心数据库操作** (qjs_ndtsdb.c)
   - libndtsdb 调用（已在 native 层处理平台差异）
   - QuickJS API（跨平台）

2. **HTTP Server**
   - socket/bind/listen/accept
   - recv/send
   - setsockopt(SO_REUSEADDR)

3. **文件操作**
   - fopen/fread/fwrite/fclose
   - stat

4. **REPL**
   - fgets (fallback mode)
   - printf/scanf

5. **JS 引擎**
   - QuickJS 完全跨平台

---

## 6. 需要在 macOS 机器上测试才能确认

以下部分理论上兼容，但需要实际 macOS 测试验证：

1. **clock_gettime 替代方案**
   - mach 时间 API 是否正确返回毫秒精度
   - 需要验证 `__getTimeMs()` 返回值

2. **getline 替代方案**
   - UTF-8 字符处理
   - 超长行（>256字符）的动态扩展

3. **链接器行为**
   - 静态库与动态库混合链接
   - 符号导出

4. **运行时行为**
   - WebSocket 握手（openssl 命令）
   - 文件描述符限制

---

## 7. 总结

| 项目 | 状态 | 优先级 |
|------|------|--------|
| clock_gettime | ⚠️ 需适配 | 高 |
| getline | ⚠️ 需适配 | 高 |
| socket API | ✅ 兼容 | - |
| 文件操作 | ✅ 兼容 | - |
| Makefile | ⚠️ 需修改 | 中 |
| build.zig | ✅ 支持 | - |

**预计修改量**: 约 50 行 C 代码 + 5 行 Makefile

**风险评估**: 低风险，主要是添加兼容层，不改变核心逻辑。

---

## 8. 下一步行动

1. **立即执行**（可在 Linux 上完成）:
   - 添加 clock_gettime 兼容层
   - 添加 getline 兼容层
   - 修改 Makefile

2. **需要 macOS 环境**:
   - 编译测试
   - 运行单元测试
   - 运行集成测试
   - 性能基准对比

3. **文档更新**:
   - README.md 平台支持说明
   - 添加 macOS 构建指南
