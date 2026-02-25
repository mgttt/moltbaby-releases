// cmd_io.h - Data I/O 子命令声明
#ifndef CMD_IO_H
#define CMD_IO_H

#include "quickjs.h"

// 外部依赖
extern JSContext *ctx;
extern JSRuntime *rt;

// 5个IO子命令
int cmd_write_csv(int argc, char *argv[]);
int cmd_write_json(int argc, char *argv[]);
int cmd_write_vector(int argc, char *argv[]);
int cmd_delete(int argc, char *argv[]);
int cmd_export(int argc, char *argv[]);

#endif
