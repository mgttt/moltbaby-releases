// ndtsdb_plugin.h - 插件系统接口定义
#ifndef NDTSDB_PLUGIN_H
#define NDTSDB_PLUGIN_H

#include <stdint.h>
#include <stdbool.h>

// 插件版本
#define NDTSDB_PLUGIN_API_VERSION 1

// 前向声明
typedef struct NDTSDB NDTSDB;
typedef struct JSContext JSContext;

// 插件信息结构
typedef struct {
    const char *name;           // 插件名称
    const char *version;        // 插件版本
    const char *description;    // 插件描述
    int api_version;            // API 版本（NDTSDB_PLUGIN_API_VERSION）
} ndtsdb_plugin_info_t;

// 命令注册回调
typedef int (*ndtsdb_plugin_cmd_fn)(int argc, char **argv, JSContext *ctx);

// 插件上下文（传递给 init 函数）
typedef struct {
    NDTSDB *db;                 // 数据库实例
    JSContext *js_ctx;          // JS 上下文
    
    // 注册命令
    int (*register_cmd)(const char *name, const char *description, 
                        ndtsdb_plugin_cmd_fn fn);
    
    // 注册 hook（预留）
    int (*register_hook)(const char *event, void *callback);
    
    // 日志输出
    void (*log)(const char *level, const char *fmt, ...);
} ndtsdb_plugin_ctx_t;

// 插件必须导出的函数

// 获取插件信息（不需要加载即可调用）
extern const ndtsdb_plugin_info_t* ndtsdb_plugin_info(void);

// 初始化插件（加载时调用）
// 返回 0 表示成功，非 0 表示失败
extern int ndtsdb_plugin_init(ndtsdb_plugin_ctx_t *ctx);

// 关闭插件（卸载时调用，可选）
extern void ndtsdb_plugin_shutdown(void);

#endif // NDTSDB_PLUGIN_H