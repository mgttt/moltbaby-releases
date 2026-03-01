// cmd_plugin.h - 插件系统接口
#ifndef CMD_PLUGIN_H
#define CMD_PLUGIN_H

#include <stdbool.h>
#include "quickjs.h"
#include "../../ndtsdb-lib/native/ndtsdb.h"

// 加载插件
int load_plugin(const char *plugin_path, NDTSDB *db, JSContext *ctx);

// 执行插件命令
int execute_plugin_cmd(const char *name, int argc, char **argv, JSContext *ctx);

// 检查命令是否是插件命令
bool is_plugin_cmd(const char *name);

// 列出所有插件命令
void list_plugin_cmds(void);

// 卸载所有插件
void unload_all_plugins(void);

// plugin 子命令
int cmd_plugin(int argc, char **argv);
int cmd_plugin_list(int argc, char **argv);
int cmd_plugin_info(int argc, char **argv);

#endif // CMD_PLUGIN_H