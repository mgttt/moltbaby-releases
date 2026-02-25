// common.c - 公共工具函数实现

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include "common.h"

// 读取文件内容
char *read_file(const char *filename, size_t *len) {
    FILE *fp = fopen(filename, "rb");
    if (!fp) return NULL;
    
    fseek(fp, 0, SEEK_END);
    long size = ftell(fp);
    fseek(fp, 0, SEEK_SET);
    
    char *buf = (char *)malloc(size + 1);
    if (!buf) {
        fclose(fp);
        return NULL;
    }
    
    size_t n = fread(buf, 1, size, fp);
    fclose(fp);
    
    if (len) *len = n;
    buf[n] = '\0';
    return buf;
}

// 写入文件
int write_file(const char *filename, const char *data, size_t len) {
    FILE *fp = fopen(filename, "wb");
    if (!fp) return -1;
    
    size_t written = fwrite(data, 1, len, fp);
    fclose(fp);
    
    return (written == len) ? 0 : -1;
}

// JSON 字符串转义
char *escape_json(const char *str) {
    size_t len = strlen(str);
    char *result = (char *)malloc(len * 2 + 1);
    if (!result) return NULL;
    
    size_t j = 0;
    for (size_t i = 0; i < len; i++) {
        switch (str[i]) {
            case '"': result[j++] = '\\'; result[j++] = '"'; break;
            case '\\': result[j++] = '\\'; result[j++] = '\\'; break;
            case '\b': result[j++] = '\\'; result[j++] = 'b'; break;
            case '\f': result[j++] = '\\'; result[j++] = 'f'; break;
            case '\n': result[j++] = '\\'; result[j++] = 'n'; break;
            case '\r': result[j++] = '\\'; result[j++] = 'r'; break;
            case '\t': result[j++] = '\\'; result[j++] = 't'; break;
            default: result[j++] = str[i]; break;
        }
    }
    result[j] = '\0';
    return result;
}

// 打印 QuickJS 异常
void print_exception(JSContext *ctx) {
    JSValue exception = JS_GetException(ctx);
    const char *str = JS_ToCString(ctx, exception);
    if (str) {
        fprintf(stderr, "Error: %s\n", str);
        JS_FreeCString(ctx, str);
    }
    JS_FreeValue(ctx, exception);
}
