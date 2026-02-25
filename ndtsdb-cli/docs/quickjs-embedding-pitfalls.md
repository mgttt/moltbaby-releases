# QuickJS 嵌入式开发踩坑记录

> 来源：ndtsdb-cli Phase 1 实战（2026-02-20）

## 1. 静态链接 `-lm` 顺序

**坑**：`fesetround`、`fmod`、`sqrt` 等 math 函数 undefined reference。

**原因**：静态链接下 linker 从左到右处理，`-lm` 放在 LDFLAGS 最前面时，
还没有 .o 文件引用 math 符号，所以不会被链入。

**修法**：`-lm` 必须放在链接命令**最末尾**：
```makefile
# ❌ 错
LDFLAGS = -static -lm
$(CC) $(LDFLAGS) $(OBJS) $(LIBS) -o $(TARGET)

# ✅ 对
LDFLAGS = -static
$(CC) $(LDFLAGS) $(OBJS) $(LIBS) -lm -o $(TARGET)
```

---

## 2. 嵌入式 QuickJS 没有内置 `console`

**坑**：`console.log("hello")` 无任何输出，也不报错。

**原因**：嵌入式 QuickJS（非 qjs 命令行）不自动注册 `console` 对象。
`js_std_add_helpers()` 只在 quickjs-libc 中提供，纯 quickjs.h 没有。

**修法（推荐）**：注册 C 函数 + JS 包装：
```c
// 1. C 层注册 __print / __printerr
static JSValue js_print(JSContext *ctx, JSValueConst this_val,
                        int argc, JSValueConst *argv) {
    for (int i = 0; i < argc; i++) {
        if (i > 0) fputs(" ", stdout);
        const char *str = JS_ToCString(ctx, argv[i]);
        if (str) { fputs(str, stdout); JS_FreeCString(ctx, str); }
    }
    fputs("\n", stdout); fflush(stdout);
    return JS_UNDEFINED;
}

// 在 main 里
JSValue global = JS_GetGlobalObject(ctx);
JS_SetPropertyStr(ctx, global, "__print",
    JS_NewCFunction(ctx, js_print, "__print", 1));
JS_FreeValue(ctx, global);

// 2. JS 层包装 console
const char *console_js =
    "globalThis.console = {"
    "  log: function() { __print.apply(null, Array.from(arguments)); },"
    "  warn: function() { __print.apply(null, Array.from(arguments)); },"
    "  error: function() { __print.apply(null, Array.from(arguments)); }"
    "};";
JSValue r = JS_Eval(ctx, console_js, strlen(console_js), "<stdlib>",
                     JS_EVAL_TYPE_GLOBAL);
JS_FreeValue(ctx, r);
```

**不要用 `write(1, ...)` 代替 `fputs`**：静态链接下 stdio 初始化前调用 write()
行为不定，可能导致 segfault。

---

## 3. ES Module 执行是异步的

**坑**：`JS_Eval(ctx, script, len, filename, JS_EVAL_TYPE_MODULE)` 返回后，
脚本代码**没有执行**，所有 console.log 无输出。

**原因**：QuickJS 把 ES module 的执行放入 job queue（类似 microtask）。
`JS_Eval` 只做编译+链接，模块体要等 `JS_ExecutePendingJob` 才会运行。

**修法**：Eval 之后必须 drain job queue：
```c
JSValue result = JS_Eval(ctx, script, len, filename, JS_EVAL_TYPE_MODULE);
JS_FreeValue(ctx, result);

// 关键：运行 pending jobs（模块体在这里执行）
JSContext *ctx2;
JSRuntime *rt = JS_GetRuntime(ctx);
int r;
while ((r = JS_ExecutePendingJob(rt, &ctx2)) > 0) {}
if (r < 0) { /* handle exception */ }
```

**实用技巧**：检测 `import` 语句自动选择模式：
```c
bool is_module = (strstr(script, "import ") != NULL);
int flags = is_module ? JS_EVAL_TYPE_MODULE : JS_EVAL_TYPE_GLOBAL;
```

---

## 4. `JS_FreeRuntime` GC Assertion

**坑**：程序退出时 `quickjs.c:1991: Assertion 'list_empty(&rt->gc_obj_list)' failed`。

**原因**：ES module 加载后会在 GC list 中留下 namespace 对象的循环引用，
`JS_FreeContext` 无法完全清理，`JS_FreeRuntime` 因此断言失败。

**修法**（CLI 工具可接受的妥协）：
```c
// 方案 A：_exit() 跳过 GC（CLI 工具推荐）
fflush(stdout); fflush(stderr);
_exit(exit_code);

// 方案 B：多次 GC（不保证完全解决）
JS_RunGC(rt);
JS_FreeContext(ctx);
JS_RunGC(rt);
JS_FreeRuntime(rt);  // 仍可能 assert
```

**权衡**：`_exit()` 跳过 C++ 析构和 stdio flush，适合 CLI 工具；
长期运行的服务不能用此方法，需要彻底解决循环引用。

---

## 5. Direct `write()` vs `fputs` in Static Binaries

**坑**：用 `write(1, str, len)` 替代 `fputs` 导致 segfault。

**原因**：在静态链接的 C 程序里，`fputs`/`printf` 依赖 stdio 初始化
（全局 `__iob` 结构体），但 `write()` 是原始系统调用。两者混用时，
如果 C runtime 初始化顺序有问题会崩溃。

**修法**：统一用 `fputs`/`fprintf`，不混用 `write()`。

---

## 参考

- QuickJS 源码：`quickjs.c`（2024-01-13 版本）
- ndtsdb-cli 实现：`src/main.c`、`src/bindings/qjs_ndtsdb.c`
- 静态库：`lib/libquickjs.a`（gcc 编译，含 nolto 优化）
