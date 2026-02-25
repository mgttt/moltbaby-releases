// cmd_plugin.c - 插件系统实现
#include "cmd_plugin.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <dlfcn.h>
#include <dirent.h>
#include "ndtsdb_plugin.h"
#include "../../ndtsdb/native/ndtsdb.h"
#include "quickjs.h"

#define MAX_PLUGINS 16
#define MAX_PLUGIN_CMDS 32

// 插件命令结构
typedef struct {
    char name[64];
    char description[256];
    ndtsdb_plugin_cmd_fn fn;
    void *handle;  // dlopen handle
} plugin_cmd_t;

// 已加载的插件
static plugin_cmd_t plugin_cmds[MAX_PLUGIN_CMDS];
static int plugin_cmd_count = 0;
static void *plugin_handles[MAX_PLUGINS];
static int plugin_count = 0;

// 日志函数
static void plugin_log(const char *level, const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    fprintf(stderr, "[%s] ", level);
    vfprintf(stderr, fmt, args);
    fprintf(stderr, "\n");
    va_end(args);
}

// 注册命令回调
static int register_plugin_cmd(const char *name, const char *description, 
                                ndtsdb_plugin_cmd_fn fn) {
    if (plugin_cmd_count >= MAX_PLUGIN_CMDS) {
        plugin_log("ERROR", "Too many plugin commands");
        return -1;
    }
    
    strncpy(plugin_cmds[plugin_cmd_count].name, name, 63);
    plugin_cmds[plugin_cmd_count].name[63] = '\0';
    strncpy(plugin_cmds[plugin_cmd_count].description, description, 255);
    plugin_cmds[plugin_cmd_count].description[255] = '\0';
    plugin_cmds[plugin_cmd_count].fn = fn;
    plugin_cmds[plugin_cmd_count].handle = NULL;  // 稍后设置
    
    plugin_log("INFO", "Registered plugin command: %s", name);
    plugin_cmd_count++;
    return 0;
}

// 注册 hook 回调（预留）
static int register_plugin_hook(const char *event, void *callback) {
    plugin_log("WARN", "Hooks not yet implemented (event: %s)", event);
    return 0;
}

// 加载单个插件
int load_plugin(const char *plugin_path, NDTSDB *db, JSContext *ctx) {
    if (plugin_count >= MAX_PLUGINS) {
        fprintf(stderr, "Error: Too many plugins loaded\n");
        return -1;
    }
    
    void *handle = dlopen(plugin_path, RTLD_NOW | RTLD_LOCAL);
    if (!handle) {
        fprintf(stderr, "Error: Failed to load plugin %s: %s\n", plugin_path, dlerror());
        return -1;
    }
    
    // 查找 ndtsdb_plugin_info
    const ndtsdb_plugin_info_t* (*plugin_info)(void) = dlsym(handle, "ndtsdb_plugin_info");
    if (!plugin_info) {
        fprintf(stderr, "Error: Plugin %s missing ndtsdb_plugin_info\n", plugin_path);
        dlclose(handle);
        return -1;
    }
    
    const ndtsdb_plugin_info_t *info = plugin_info();
    printf("Loading plugin: %s v%s - %s\n", info->name, info->version, info->description);
    
    if (info->api_version != NDTSDB_PLUGIN_API_VERSION) {
        fprintf(stderr, "Error: Plugin API version mismatch (expected %d, got %d)\n",
                NDTSDB_PLUGIN_API_VERSION, info->api_version);
        dlclose(handle);
        return -1;
    }
    
    // 查找 ndtsdb_plugin_init
    int (*plugin_init)(ndtsdb_plugin_ctx_t *ctx) = dlsym(handle, "ndtsdb_plugin_init");
    if (!plugin_init) {
        fprintf(stderr, "Error: Plugin %s missing ndtsdb_plugin_init\n", plugin_path);
        dlclose(handle);
        return -1;
    }
    
    // 准备上下文
    ndtsdb_plugin_ctx_t plugin_ctx = {
        .db = db,
        .js_ctx = ctx,
        .register_cmd = register_plugin_cmd,
        .register_hook = register_plugin_hook,
        .log = plugin_log
    };
    
    // 记录当前命令数，用于失败回滚
    int cmd_count_before = plugin_cmd_count;
    
    // 调用 init
    int ret = plugin_init(&plugin_ctx);
    if (ret != 0) {
        fprintf(stderr, "Error: Plugin %s init failed with code %d\n", plugin_path, ret);
        // 回滚已注册的命令
        plugin_cmd_count = cmd_count_before;
        dlclose(handle);
        return -1;
    }
    
    // 设置 handle 到新注册的命令
    for (int i = cmd_count_before; i < plugin_cmd_count; i++) {
        plugin_cmds[i].handle = handle;
    }
    
    plugin_handles[plugin_count++] = handle;
    printf("Plugin loaded successfully\n");
    return 0;
}

// 执行插件命令
int execute_plugin_cmd(const char *name, int argc, char **argv, JSContext *ctx) {
    for (int i = 0; i < plugin_cmd_count; i++) {
        if (strcmp(plugin_cmds[i].name, name) == 0) {
            return plugin_cmds[i].fn(argc, argv, ctx);
        }
    }
    return -1;  // 未找到
}

// 检查命令是否是插件命令
bool is_plugin_cmd(const char *name) {
    for (int i = 0; i < plugin_cmd_count; i++) {
        if (strcmp(plugin_cmds[i].name, name) == 0) {
            return true;
        }
    }
    return false;
}

// 列出所有插件命令
void list_plugin_cmds(void) {
    if (plugin_cmd_count == 0) {
        printf("No plugin commands registered\n");
        return;
    }
    printf("Plugin commands:\n");
    for (int i = 0; i < plugin_cmd_count; i++) {
        printf("  %s - %s\n", plugin_cmds[i].name, plugin_cmds[i].description);
    }
}

// 卸载所有插件
void unload_all_plugins(void) {
    for (int i = 0; i < plugin_count; i++) {
        // 查找 shutdown 函数（可选）
        void (*plugin_shutdown)(void) = dlsym(plugin_handles[i], "ndtsdb_plugin_shutdown");
        if (plugin_shutdown) {
            plugin_shutdown();
        }
        dlclose(plugin_handles[i]);
    }
    plugin_count = 0;
    plugin_cmd_count = 0;
}

// ==================== plugin list 子命令 ====================
// plugin list --plugin-dir <path>
int cmd_plugin_list(int argc, char **argv) {
    const char *plugin_dir = NULL;
    int help_flag = 0;

    for (int i = 3; i < argc; i++) {
        if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            help_flag = 1;
        } else if ((strcmp(argv[i], "--plugin-dir") == 0 || strcmp(argv[i], "-d") == 0) && i + 1 < argc) {
            plugin_dir = argv[++i];
        }
    }
    
    if (help_flag) {
        printf("Usage: ndtsdb-cli plugin list --plugin-dir <path>\n");
        printf("  Scan directory for .so plugins and list info\n");
        return 0;
    }
    
    if (!plugin_dir) {
        fprintf(stderr, "Error: --plugin-dir is required\n");
        return 1;
    }
    
    printf("Scanning plugins in: %s\n", plugin_dir);
    printf("%-20s %-10s %s\n", "NAME", "VERSION", "DESCRIPTION");
    printf("%-20s %-10s %s\n", "----", "-------", "-----------");
    
    // 扫描目录
    DIR *dir = opendir(plugin_dir);
    if (!dir) {
        fprintf(stderr, "Error: Cannot open directory: %s\n", plugin_dir);
        return 1;
    }
    
    int count = 0;
    struct dirent *entry;
    while ((entry = readdir(dir)) != NULL) {
        // 检查 .so 后缀
        int len = strlen(entry->d_name);
        if (len < 3 || strcmp(entry->d_name + len - 3, ".so") != 0) continue;
        
        // 构建完整路径
        char path[512];
        snprintf(path, sizeof(path), "%s/%s", plugin_dir, entry->d_name);
        
        // dlopen 读取信息
        void *handle = dlopen(path, RTLD_NOW | RTLD_LOCAL);
        if (!handle) continue;
        
        const ndtsdb_plugin_info_t* (*plugin_info)(void) = dlsym(handle, "ndtsdb_plugin_info");
        if (plugin_info) {
            const ndtsdb_plugin_info_t *info = plugin_info();
            printf("%-20s %-10s %s\n", info->name, info->version, info->description);
            count++;
        }
        dlclose(handle);
    }
    closedir(dir);
    
    printf("\nTotal: %d plugins\n", count);
    return 0;
}

// ==================== plugin info 子命令 ====================
// plugin info <name.so> [--plugin-dir <path>]
int cmd_plugin_info(int argc, char **argv) {
    const char *plugin_file = NULL;
    const char *plugin_dir = ".";
    int help_flag = 0;

    for (int i = 3; i < argc; i++) {
        if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            help_flag = 1;
        } else if ((strcmp(argv[i], "--plugin-dir") == 0 || strcmp(argv[i], "-d") == 0) && i + 1 < argc) {
            plugin_dir = argv[++i];
        } else if (argv[i][0] != '-' && !plugin_file) {
            plugin_file = argv[i];
        }
    }
    
    if (help_flag) {
        printf("Usage: ndtsdb-cli plugin info <plugin.so> [--plugin-dir <path>]\n");
        printf("  Show detailed info for a plugin\n");
        return 0;
    }
    
    if (!plugin_file) {
        fprintf(stderr, "Error: Plugin file is required\n");
        return 1;
    }
    
    // 构建完整路径
    char path[512];
    if (plugin_file[0] == '/') {
        strncpy(path, plugin_file, sizeof(path) - 1);
    } else {
        snprintf(path, sizeof(path), "%s/%s", plugin_dir, plugin_file);
    }
    path[sizeof(path) - 1] = '\0';
    
    // dlopen 读取信息
    void *handle = dlopen(path, RTLD_NOW | RTLD_LOCAL);
    if (!handle) {
        fprintf(stderr, "Error: Cannot load plugin: %s\n", dlerror());
        return 1;
    }
    
    const ndtsdb_plugin_info_t* (*plugin_info)(void) = dlsym(handle, "ndtsdb_plugin_info");
    if (!plugin_info) {
        fprintf(stderr, "Error: Plugin missing ndtsdb_plugin_info\n");
        dlclose(handle);
        return 1;
    }
    
    const ndtsdb_plugin_info_t *info = plugin_info();
    printf("Plugin: %s\n", info->name);
    printf("Version: %s\n", info->version);
    printf("Description: %s\n", info->description);
    printf("API Version: %d\n", info->api_version);
    
    dlclose(handle);
    return 0;
}

// ==================== plugin 主命令 ====================
int cmd_plugin(int argc, char **argv) {
    if (argc < 3 || strcmp(argv[2], "--help") == 0 || strcmp(argv[2], "-h") == 0) {
        printf("Usage: ndtsdb-cli plugin <command> [options]\n");
        printf("\nCommands:\n");
        printf("  list   List all plugins in directory\n");
        printf("  info   Show detailed info for a plugin\n");
        printf("\nUse 'ndtsdb-cli plugin <command> --help' for more info\n");
        return argc < 3 ? 1 : 0;
    }
    
    if (strcmp(argv[2], "list") == 0) {
        return cmd_plugin_list(argc, argv);
    } else if (strcmp(argv[2], "info") == 0) {
        return cmd_plugin_info(argc, argv);
    } else {
        fprintf(stderr, "Error: Unknown plugin command: %s\n", argv[2]);
        return 1;
    }
}