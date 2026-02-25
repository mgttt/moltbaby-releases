// common.h - 公共工具函数

#ifndef COMMON_H
#define COMMON_H

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include "quickjs.h"

// 文件操作
char *read_file(const char *filename, size_t *len);
int write_file(const char *filename, const char *data, size_t len);

// JSON 转义
char *escape_json(const char *str);

// QuickJS 异常打印
void print_exception(JSContext *ctx);

#endif // COMMON_H
