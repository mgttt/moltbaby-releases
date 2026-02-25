// cmd_serve.h - serve 子命令头文件
#ifndef CMD_SERVE_H
#define CMD_SERVE_H

#include "quickjs.h"

// serve 子命令入口
int cmd_serve(int argc, char **argv, JSContext *ctx, JSRuntime *rt);

#endif // CMD_SERVE_H
