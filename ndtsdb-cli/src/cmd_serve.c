// cmd_serve.c - serve 子命令实现
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <time.h>
#include <fcntl.h>
#include <errno.h>
#include <signal.h>
#include <math.h>
#include "quickjs.h"
#include "../../ndtsdb-lib/native/ndtsdb.h"
#include "../../ndtsdb-lib/native/ndtsdb_vec.h"
#include "ndtsdb_lock.h"
#include "cmd_serve.h"
#include "common.h"

#ifdef _WIN32
#include <winsock2.h>
#include <windows.h>
#include <ws2tcpip.h>
#include <io.h>
#define close(fd) closesocket(fd)
#define read(fd, buf, count) recv(fd, buf, count, 0)
#define write(fd, buf, count) send(fd, buf, count, 0)
#define strncasecmp _strnicmp
#pragma comment(lib, "ws2_32.lib")
// Windows 简易目录遍历结构
typedef struct DIR {
    HANDLE handle;
    WIN32_FIND_DATA data;
    struct dirent *entry;
    int first;
} DIR;

typedef struct dirent {
    char d_name[MAX_PATH];
} dirent;

static DIR* opendir(const char *path) {
    DIR *dir = malloc(sizeof(DIR));
    if (!dir) return NULL;
    char pattern[MAX_PATH];
    snprintf(pattern, MAX_PATH, "%s/*", path);
    dir->handle = FindFirstFile(pattern, &dir->data);
    if (dir->handle == INVALID_HANDLE_VALUE) {
        free(dir);
        return NULL;
    }
    dir->first = 1;
    dir->entry = malloc(sizeof(struct dirent));
    return dir;
}

static struct dirent* readdir(DIR *dir) {
    if (!dir || !dir->entry) return NULL;
    if (!dir->first) {
        if (!FindNextFile(dir->handle, &dir->data)) return NULL;
    }
    dir->first = 0;
    strncpy(dir->entry->d_name, dir->data.cFileName, MAX_PATH);
    return dir->entry;
}

static void closedir(DIR *dir) {
    if (dir) {
        FindClose(dir->handle);
        free(dir->entry);
        free(dir);
    }
}
#else
#include <strings.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <sys/select.h>
#include <dirent.h>
#endif

// ==================== 安全配置 ====================
static char *auth_token = NULL;      // Bearer token (NULL = 无认证)
static char *cors_origin = NULL;     // CORS origin (NULL = 不开启)

// ==================== WebSocket 支持 ====================
#define MAX_WS_CLIENTS 100
#define WS_HEARTBEAT_INTERVAL 1
#define WS_PORT 8080
#define WS_BUFFER_SIZE 32768

typedef struct {
    int fd;
    char symbol[64];
    char interval[16];
    int64_t last_timestamp;
    time_t last_heartbeat;
    time_t last_data_push;
    bool active;
    bool is_websocket;
    bool handshake_complete;
} ws_client_t;

static ws_client_t ws_clients[MAX_WS_CLIENTS];
static int server_fd_global = -1;
static volatile bool server_running = true;
static time_t server_start_time = 0;

// SHA1实现
static const char b64_table[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

typedef struct {
    uint32_t state[5];
    uint32_t count[2];
    unsigned char buffer[64];
} SHA1_CTX;

#define SHA1_ROL(v, b) (((v) << (b)) | ((v) >> (32 - (b))))

static void SHA1_Transform(SHA1_CTX *ctx, const unsigned char data[64]) {
    uint32_t a = ctx->state[0], b = ctx->state[1], c = ctx->state[2], d = ctx->state[3], e = ctx->state[4];
    uint32_t w[80], t, i;
    
    for (i = 0; i < 16; i++) {
        w[i] = (data[i * 4] << 24) | (data[i * 4 + 1] << 16) | (data[i * 4 + 2] << 8) | data[i * 4 + 3];
    }
    for (i = 16; i < 80; i++) {
        w[i] = SHA1_ROL(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }
    
    for (i = 0; i < 20; i++) {
        t = SHA1_ROL(a, 5) + ((b & c) | (~b & d)) + e + w[i] + 0x5a827999;
        e = d; d = c; c = SHA1_ROL(b, 30); b = a; a = t;
    }
    for (i = 20; i < 40; i++) {
        t = SHA1_ROL(a, 5) + (b ^ c ^ d) + e + w[i] + 0x6ed9eba1;
        e = d; d = c; c = SHA1_ROL(b, 30); b = a; a = t;
    }
    for (i = 40; i < 60; i++) {
        t = SHA1_ROL(a, 5) + ((b & c) | (b & d) | (c & d)) + e + w[i] + 0x8f1bbcdc;
        e = d; d = c; c = SHA1_ROL(b, 30); b = a; a = t;
    }
    for (i = 60; i < 80; i++) {
        t = SHA1_ROL(a, 5) + (b ^ c ^ d) + e + w[i] + 0xca62c1d6;
        e = d; d = c; c = SHA1_ROL(b, 30); b = a; a = t;
    }
    
    ctx->state[0] += a; ctx->state[1] += b; ctx->state[2] += c; ctx->state[3] += d; ctx->state[4] += e;
}

static void SHA1_Init(SHA1_CTX *ctx) {
    ctx->state[0] = 0x67452301;
    ctx->state[1] = 0xefcdab89;
    ctx->state[2] = 0x98badcfe;
    ctx->state[3] = 0x10325476;
    ctx->state[4] = 0xc3d2e1f0;
    ctx->count[0] = ctx->count[1] = 0;
}

static void SHA1_Update(SHA1_CTX *ctx, const unsigned char *data, size_t len) {
    size_t i, j;
    j = (ctx->count[0] >> 3) & 63;
    if ((ctx->count[0] += (uint32_t)(len << 3)) < (len << 3)) ctx->count[1]++;
    ctx->count[1] += (uint32_t)(len >> 29);
    if ((j + len) > 63) {
        memcpy(&ctx->buffer[j], data, i = 64 - j);
        SHA1_Transform(ctx, ctx->buffer);
        for (; i + 63 < len; i += 64) SHA1_Transform(ctx, &data[i]);
        j = 0;
    } else i = 0;
    memcpy(&ctx->buffer[j], &data[i], len - i);
}

static void SHA1_Final(unsigned char digest[20], SHA1_CTX *ctx) {
    unsigned char finalcount[8];
    unsigned char c;
    int i;
    for (i = 0; i < 8; i++) {
        finalcount[i] = (unsigned char)((ctx->count[(i >= 4) ? 0 : 1] >> ((3 - (i & 3)) * 8)) & 255);
    }
    c = 0x80;
    SHA1_Update(ctx, &c, 1);
    while ((ctx->count[0] & 504) != 448) {
        c = 0;
        SHA1_Update(ctx, &c, 1);
    }
    SHA1_Update(ctx, finalcount, 8);
    for (i = 0; i < 20; i++) {
        digest[i] = (unsigned char)((ctx->state[i >> 2] >> ((3 - (i & 3)) * 8)) & 255);
    }
}

static char *base64_encode(const unsigned char *data, size_t len) {
    char *result = malloc((len + 2) / 3 * 4 + 1);
    if (!result) return NULL;
    size_t i, j;
    for (i = 0, j = 0; i < len; i += 3, j += 4) {
        unsigned char b1 = data[i];
        unsigned char b2 = (i + 1 < len) ? data[i + 1] : 0;
        unsigned char b3 = (i + 2 < len) ? data[i + 2] : 0;
        result[j] = b64_table[b1 >> 2];
        result[j + 1] = b64_table[((b1 & 3) << 4) | (b2 >> 4)];
        result[j + 2] = (i + 1 < len) ? b64_table[((b2 & 15) << 2) | (b3 >> 6)] : '=';
        result[j + 3] = (i + 2 < len) ? b64_table[b3 & 63] : '=';
    }
    result[j] = '\0';
    return result;
}

static void compute_ws_accept(const char *key, char *result) {
    const char *magic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    char concat[128];
    snprintf(concat, sizeof(concat), "%s%s", key, magic);
    
    unsigned char digest[20];
    SHA1_CTX ctx;
    SHA1_Init(&ctx);
    SHA1_Update(&ctx, (unsigned char *)concat, strlen(concat));
    SHA1_Final(digest, &ctx);
    
    char *encoded = base64_encode(digest, 20);
    strcpy(result, encoded);
    free(encoded);
}

static void send_ws_text(int fd, const char *text) {
    size_t len = strlen(text);
    unsigned char frame[WS_BUFFER_SIZE];
    size_t frame_len = 0;
    
    frame[frame_len++] = 0x81;
    
    if (len < 126) {
        frame[frame_len++] = (unsigned char)len;
    } else if (len < 65536) {
        frame[frame_len++] = 126;
        frame[frame_len++] = (unsigned char)((len >> 8) & 0xFF);
        frame[frame_len++] = (unsigned char)(len & 0xFF);
    } else {
        frame[frame_len++] = 127;
        frame[frame_len++] = 0;
        frame[frame_len++] = 0;
        frame[frame_len++] = 0;
        frame[frame_len++] = 0;
        frame[frame_len++] = (unsigned char)((len >> 24) & 0xFF);
        frame[frame_len++] = (unsigned char)((len >> 16) & 0xFF);
        frame[frame_len++] = (unsigned char)((len >> 8) & 0xFF);
        frame[frame_len++] = (unsigned char)(len & 0xFF);
    }
    
    memcpy(frame + frame_len, text, len);
    frame_len += len;
    
    send(fd, frame, frame_len, 0);
}

static void send_ws_ping(int fd) {
    unsigned char ping[2] = {0x89, 0x00};
    send(fd, ping, 2, 0);
}

static void send_ws_pong(int fd) {
    unsigned char pong[2] = {0x8A, 0x00};
    send(fd, pong, 2, 0);
}

static int parse_ws_frame(const unsigned char *data, size_t len, unsigned char *opcode, unsigned char **payload, size_t *payload_len) {
    if (len < 2) return -1;
    
    *opcode = data[0] & 0x0F;
    bool masked = (data[1] & 0x80) != 0;
    size_t payload_length = data[1] & 0x7F;
    size_t header_len = 2;
    
    if (payload_length == 126) {
        if (len < 4) return -1;
        payload_length = ((size_t)data[2] << 8) | data[3];
        header_len = 4;
    } else if (payload_length == 127) {
        if (len < 10) return -1;
        payload_length = 0;
        for (int i = 0; i < 8; i++) {
            payload_length = (payload_length << 8) | data[2 + i];
        }
        header_len = 10;
    }
    
    if (masked) {
        header_len += 4;
    }
    
    if (len < header_len + payload_length) return -1;
    
    *payload = (unsigned char *)malloc(payload_length + 1);
    if (!*payload) return -1;
    
    memcpy(*payload, data + header_len, payload_length);
    (*payload)[payload_length] = '\0';
    
    if (masked) {
        unsigned char mask[4];
        memcpy(mask, data + header_len - 4, 4);
        for (size_t i = 0; i < payload_length; i++) {
            (*payload)[i] ^= mask[i % 4];
        }
    }
    
    *payload_len = payload_length;
    return header_len + payload_length;
}

// 辅助函数：检查请求是否需要认证
static bool endpoint_requires_auth(const char *method, const char *path) {
    // 写入端点需要认证
    if (strcmp(method, "POST") == 0) {
        if (strcmp(path, "/write-json") == 0 || strcmp(path, "/write-vector") == 0) {
            return true;
        }
    }
    // 读取端点免认证
    return false;
}

// 辅助函数：验证 Bearer token
static bool check_bearer_auth(const char *request) {
    if (!auth_token) return true;  // 未配置token，免认证
    
    const char *auth_header = strstr(request, "Authorization:");
    if (!auth_header) auth_header = strstr(request, "authorization:");
    if (!auth_header) return false;
    
    // 跳过 "Authorization:" 或 "authorization:"
    auth_header += 14;
    while (*auth_header == ' ' || *auth_header == '\t') auth_header++;
    
    // 检查 Bearer 前缀
    if (strncasecmp(auth_header, "Bearer ", 7) != 0) return false;
    auth_header += 7;
    
    // 提取token值
    char token[256] = {0};
    int i = 0;
    while (*auth_header && *auth_header != '\r' && *auth_header != '\n' && i < 255) {
        token[i++] = *auth_header++;
    }
    token[i] = '\0';
    
    return strcmp(token, auth_token) == 0;
}

// 辅助函数：发送401响应
static void send_unauthorized(int client_fd) {
    const char *body = "{\"error\":\"unauthorized\"}";
    char response[512];
    snprintf(response, sizeof(response),
        "HTTP/1.1 401 Unauthorized\r\n"
        "Content-Type: application/json\r\n"
        "Content-Length: %zu\r\n"
        "Connection: close\r\n"
        "\r\n"
        "%s",
        strlen(body), body);
    send(client_fd, response, strlen(response), 0);
    close(client_fd);
}

// 辅助函数：发送CORS预检响应
static void send_cors_preflight(int client_fd) {
    char response[512];
    snprintf(response, sizeof(response),
        "HTTP/1.1 204 No Content\r\n"
        "Access-Control-Allow-Origin: %s\r\n"
        "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
        "Access-Control-Allow-Headers: Content-Type, Authorization\r\n"
        "Access-Control-Max-Age: 86400\r\n"
        "Connection: close\r\n"
        "\r\n",
        cors_origin ? cors_origin : "*");
    send(client_fd, response, strlen(response), 0);
    close(client_fd);
}

// 辅助函数：构建带CORS头的HTTP响应
static void build_http_response_with_cors(char *response, size_t response_size, 
                                          int status, const char *status_text,
                                          const char *content_type, const char *body) {
    if (cors_origin) {
        snprintf(response, response_size,
            "HTTP/1.1 %d %s\r\n"
            "Content-Type: %s\r\n"
            "Content-Length: %zu\r\n"
            "Access-Control-Allow-Origin: %s\r\n"
            "Connection: close\r\n"
            "\r\n"
            "%s",
            status, status_text, content_type, strlen(body), cors_origin, body);
    } else {
        snprintf(response, response_size,
            "HTTP/1.1 %d %s\r\n"
            "Content-Type: %s\r\n"
            "Content-Length: %zu\r\n"
            "Connection: close\r\n"
            "\r\n"
            "%s",
            status, status_text, content_type, strlen(body), body);
    }
}

// 辅助函数：转义字符串
static char *quote_string(const char *str) {
    if (!str) return strdup("null");
    size_t len = strlen(str);
    size_t escaped_len = 2;
    for (size_t i = 0; i < len; i++) {
        if (str[i] == '\'' || str[i] == '"' || str[i] == '\\' || str[i] == '\n' || str[i] == '\r' || str[i] == '\t') {
            escaped_len += 2;
        } else {
            escaped_len += 1;
        }
    }
    char *result = malloc(escaped_len + 1);
    if (!result) return strdup("null");
    result[0] = '\'';
    size_t j = 1;
    for (size_t i = 0; i < len; i++) {
        switch (str[i]) {
            case '\'': result[j++] = '\\'; result[j++] = '\''; break;
            case '"': result[j++] = '\\'; result[j++] = '"'; break;
            case '\\': result[j++] = '\\'; result[j++] = '\\'; break;
            case '\n': result[j++] = '\\'; result[j++] = 'n'; break;
            case '\r': result[j++] = '\\'; result[j++] = 'r'; break;
            case '\t': result[j++] = '\\'; result[j++] = 't'; break;
            default: result[j++] = str[i];
        }
    }
    result[j++] = '\'';
    result[j] = '\0';
    return result;
}

// 信号处理
static void signal_handler(int sig) {
    server_running = false;
    if (server_fd_global >= 0) {
        close(server_fd_global);
        server_fd_global = -1;
    }
}

// 获取symbol的最新数据
static void get_latest_for_symbol(JSContext *ctx, const char *symbol, const char *interval, char *result, size_t result_size) {
    char js_code[4096];
    snprintf(js_code, sizeof(js_code),
        "(() => { try { const db = ndtsdb.open(globalThis.__db_path); const data = ndtsdb.queryFiltered(db, ['%s']); ndtsdb.close(db); if (data.length === 0) return null; const latest = data.reduce((max, row) => row.timestamp > max.timestamp ? row : max, data[0]); return JSON.stringify(latest); } catch (e) { return null; } })();",
        symbol
    );
    
    JSValue js_result = JS_Eval(ctx, js_code, strlen(js_code), "<ws>", JS_EVAL_TYPE_GLOBAL);
    if (!JS_IsException(js_result) && !JS_IsNull(js_result) && !JS_IsUndefined(js_result)) {
        const char *str = JS_ToCString(ctx, js_result);
        if (str) {
            strncpy(result, str, result_size - 1);
            result[result_size - 1] = '\0';
            JS_FreeCString(ctx, str);
        }
    }
    JS_FreeValue(ctx, js_result);
}

// 查找空闲客户端槽
static int find_free_client_slot() {
    for (int i = 0; i < MAX_WS_CLIENTS; i++) {
        if (!ws_clients[i].active) return i;
    }
    return -1;
}

// 关闭客户端连接
static void close_client(int idx) {
    if (ws_clients[idx].active && ws_clients[idx].fd >= 0) {
        close(ws_clients[idx].fd);
    }
    ws_clients[idx].active = false;
    ws_clients[idx].fd = -1;
    ws_clients[idx].is_websocket = false;
    ws_clients[idx].handshake_complete = false;
    ws_clients[idx].symbol[0] = '\0';
}

// 广播数据更新到订阅的WebSocket客户端
static void broadcast_data_update(const char *symbol, const char *interval, const char *data_json) {
    for (int i = 0; i < MAX_WS_CLIENTS; i++) {
        if (ws_clients[i].active && ws_clients[i].is_websocket && ws_clients[i].handshake_complete) {
            // 检查是否订阅了该symbol
            if (ws_clients[i].symbol[0] == '\0' || strcmp(ws_clients[i].symbol, symbol) == 0) {
                send_ws_text(ws_clients[i].fd, data_json);
            }
        }
    }
}

// 处理WebSocket握手
static bool handle_websocket_handshake(int client_fd, const char *request, const char *symbol) {
    char *key_start = strstr(request, "Sec-WebSocket-Key: ");
    if (!key_start) key_start = strstr(request, "sec-websocket-key: ");
    if (!key_start) return false;
    
    key_start += 19;
    char key[64] = {0};
    sscanf(key_start, "%63s", key);
    if (strlen(key) == 0) return false;
    
    char accept[64] = {0};
    compute_ws_accept(key, accept);
    
    char response[512];
    snprintf(response, sizeof(response),
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Accept: %s\r\n"
        "\r\n",
        accept
    );
    
    if (send(client_fd, response, strlen(response), 0) < 0) return false;
    return true;
}

// 处理HTTP请求
static void handle_http_request(int client_fd, const char *request, const char *database, JSContext *ctx) {
    char method[16] = {0};
    char path[65536] = {0};
    sscanf(request, "%15s %65535s", method, path);
    
    char response_body[32768] = {0};
    int status = 200;
    const char *content_type = "application/json";
    
    // 处理CORS预检请求
    if (strcmp(method, "OPTIONS") == 0) {
        send_cors_preflight(client_fd);
        return;
    }
    
    // 检查认证（写入端点需要）
    if (endpoint_requires_auth(method, path)) {
        if (!check_bearer_auth(request)) {
            send_unauthorized(client_fd);
            return;
        }
    }
    
    char *body = strstr(request, "\r\n\r\n");
    if (body) body += 4;
    else {
        body = strstr(request, "\n\n");
        if (body) body += 2;
        else body = "";
    }
    
    char escaped_body[65536] = {0};
    int j = 0;
    for (int i = 0; body[i] && j < sizeof(escaped_body) - 2; i++) {
        if (body[i] == '\\' || body[i] == '"') escaped_body[j++] = '\\';
        else if (body[i] == '\n') { escaped_body[j++] = '\\'; escaped_body[j++] = 'n'; continue; }
        else if (body[i] == '\r') continue;
        escaped_body[j++] = body[i];
    }
    escaped_body[j] = '\0';
    
    // ========== POST /write-vector ==========
    if (strcmp(method, "POST") == 0 && strcmp(path, "/write-vector") == 0) {
        int inserted = 0, errors = 0;
        
        int lock_fd = ndtsdb_lock_acquire(database, true);
        if (lock_fd < 0) {
            status = 503;
            snprintf(response_body, sizeof(response_body), 
                "{\"error\":\"Service Unavailable\",\"message\":\"Failed to acquire lock\"}");
        } else {
            NDTSDB *db = ndtsdb_open(database);
            if (!db) {
                status = 500;
                snprintf(response_body, sizeof(response_body), 
                    "{\"error\":\"Internal Server Error\",\"message\":\"Failed to open database\"}");
                ndtsdb_lock_release(lock_fd);
            } else {
                VecRecord vrec;
                memset(&vrec, 0, sizeof(vrec));
                
                const char *p;
                
                p = strstr(body, "\"agent_id\"");
                if (p) {
                    p = strstr(p, ":");
                    if (p) {
                        p++;
                        while (*p == ' ' || *p == '\t') p++;
                        if (*p == '"') {
                            p++;
                            int i = 0;
                            while (p && *p && *p != '"' && i < 31) vrec.agent_id[i++] = *p++;
                            vrec.agent_id[i] = '\0';
                        }
                    }
                }
                
                p = strstr(body, "\"type\"");
                if (p) {
                    p = strstr(p, ":");
                    if (p) {
                        p++;
                        while (*p == ' ' || *p == '\t') p++;
                        if (*p == '"') {
                            p++;
                            int i = 0;
                            while (p && *p && *p != '"' && i < 15) vrec.type[i++] = *p++;
                            vrec.type[i] = '\0';
                        }
                    }
                }
                
                p = strstr(body, "\"timestamp\"");
                if (p) {
                    p = strchr(p, ':');
                    if (p) vrec.timestamp = atoll(p + 1);
                }
                
                p = strstr(body, "\"confidence\"");
                if (p) {
                    p = strchr(p, ':');
                    if (p) vrec.confidence = (float)atof(p + 1);
                }
                
                p = strstr(body, "\"embedding\"");
                if (p) {
                    p = strchr(p, '[');
                    if (p) {
                        p++;
                        float emb[4096];
                        int dim = 0;
                        while (p && *p && *p != ']' && dim < 4096) {
                            char *end;
                            float v = strtof(p, &end);
                            if (end == p) { p++; continue; }
                            emb[dim++] = v;
                            p = end;
                            while (*p == ' ' || *p == ',') p++;
                        }
                        if (dim > 0) {
                            vrec.embedding = malloc(dim * sizeof(float));
                            if (vrec.embedding) {
                                memcpy(vrec.embedding, emb, dim * sizeof(float));
                                vrec.embedding_dim = dim;
                            }
                        }
                    }
                }
                
                if (vrec.timestamp > 0 && vrec.agent_id[0] && vrec.embedding && vrec.embedding_dim > 0) {
                    int ok = ndtsdb_vec_insert(db, vrec.agent_id, vrec.type, &vrec);
                    if (ok == 0) {
                        inserted++;
                        KlineRow marker = {
                            .timestamp = vrec.timestamp,
                            .open = vrec.confidence,
                            .high = (double)vrec.embedding_dim,
                            .low = 0.0,
                            .close = 0.0,
                            .volume = 0.0,
                            .flags = 0x01
                        };
                        ndtsdb_insert(db, vrec.agent_id, vrec.type, &marker);
                    } else {
                        errors++;
                    }
                } else {
                    errors++;
                }
                
                if (vrec.embedding) free(vrec.embedding);
                ndtsdb_close(db);
                ndtsdb_lock_release(lock_fd);
                
                snprintf(response_body, sizeof(response_body), 
                    "{\"inserted\":%d,\"errors\":%d}", inserted, errors);
            }
        }
        
        char http_response[65536];
        const char *status_text = (status == 200) ? "OK" : (status == 503 ? "Service Unavailable" : "Error");
        build_http_response_with_cors(http_response, sizeof(http_response),
            status, status_text, content_type, response_body);
        send(client_fd, http_response, strlen(http_response), 0);
        close(client_fd);
        return;
    }
    
    // ========== GET /query-vectors ==========
    if (strcmp(method, "GET") == 0 && strncmp(path, "/query-vectors", 14) == 0) {
        float query_embedding[4096];
        int query_dim = 0;
        float threshold = 0.8f;
        int limit = 10;
        char agent_filter[32] = {0};
        
        const char *query_start = strchr(path, '?');
        if (query_start) {
            query_start++;
            char query_copy[65536];
            strncpy(query_copy, query_start, sizeof(query_copy) - 1);
            query_copy[sizeof(query_copy) - 1] = '\0';
            
            char *token = strtok(query_copy, "&");
            while (token) {
                if (strncmp(token, "embedding=", 10) == 0) {
                    const char *p = token + 10;
                    // 处理 URL 编码: %5B=[, %5D=], %20=space
                    if (*p == '[' || (*p == '%' && strncmp(p, "%5B", 3) == 0)) {
                        if (*p == '%') p += 3;
                        else p++;
                    }
                    query_dim = 0;
                    while (*p && query_dim < 4096) {
                        // 检查结束符: ] 或 %5D
                        if (*p == ']' || (*p == '%' && strncmp(p, "%5D", 3) == 0)) break;
                        char *end;
                        float v = strtof(p, &end);
                        if (end == p) { p++; continue; }
                        query_embedding[query_dim++] = v;
                        p = end;
                        // 跳过分隔符: 空格, 逗号, 或 URL 编码的 %20
                        while (*p == ' ' || *p == ',' || (*p == '%' && strncmp(p, "%20", 3) == 0)) {
                            if (*p == '%') p += 3;
                            else p++;
                        }
                    }
                } else if (strncmp(token, "threshold=", 10) == 0) {
                    threshold = atof(token + 10);
                } else if (strncmp(token, "limit=", 6) == 0) {
                    limit = atoi(token + 6);
                    if (limit < 1) limit = 10;
                    if (limit > 100) limit = 100;
                } else if (strncmp(token, "agent_id=", 9) == 0) {
                    strncpy(agent_filter, token + 9, 31);
                    agent_filter[31] = '\0';
                    for (char *p = agent_filter; *p; p++) {
                        if (*p == '+') *p = ' ';
                    }
                }
                token = strtok(NULL, "&");
            }
        }
        
        if (query_dim == 0) {
            status = 400;
            snprintf(response_body, sizeof(response_body), 
                "{\"error\":\"Bad Request\",\"message\":\"Missing or invalid embedding parameter\"}");
        } else {
            int lock_fd = ndtsdb_lock_acquire(database, false);
            if (lock_fd < 0) {
                status = 503;
                snprintf(response_body, sizeof(response_body), 
                    "{\"error\":\"Service Unavailable\",\"message\":\"Failed to acquire lock\"}");
            } else {
                NDTSDB *db = ndtsdb_open(database);
                if (!db) {
                    status = 500;
                    snprintf(response_body, sizeof(response_body), 
                        "{\"error\":\"Internal Server Error\",\"message\":\"Failed to open database\"}");
                    ndtsdb_lock_release(lock_fd);
                } else {
                    // 扫描所有 .ndtv 文件
                    typedef struct {
                        char agent_id[32];
                        char type[16];
                        float similarity;
                        int64_t timestamp;
                        float confidence;
                    } VectorMatch;
                    
                    VectorMatch matches[1024];
                    int match_count = 0;
                    
                    // 打开数据库目录扫描 .ndtv 文件
                    DIR *dir = opendir(database);
                    if (dir) {
                        struct dirent *entry;
                        while ((entry = readdir(dir)) != NULL && match_count < 1024) {
                            // 检查是否是 .ndtv 文件
                            size_t len = strlen(entry->d_name);
                            if (len < 6 || strcmp(entry->d_name + len - 5, ".ndtv") != 0) continue;
                            
                            // 解析文件名获取 symbol 和 interval
                            // 格式: symbol__interval.ndtv
                            char symbol[32] = {0};
                            char interval[16] = {0};
                            char *underscore = strstr(entry->d_name, "__");
                            if (underscore) {
                                size_t sym_len = underscore - entry->d_name;
                                if (sym_len < 32) {
                                    strncpy(symbol, entry->d_name, sym_len);
                                    symbol[sym_len] = '\0';
                                }
                                size_t intv_len = len - 5 - (underscore - entry->d_name) - 2;
                                if (intv_len < 16) {
                                    strncpy(interval, underscore + 2, intv_len);
                                    interval[intv_len] = '\0';
                                }
                            }
                            
                            if (agent_filter[0] && strcmp(symbol, agent_filter) != 0) continue;
                            
                            VecQueryResult *vresult = ndtsdb_vec_query(db, symbol, interval);
                            if (vresult && vresult->count > 0) {
                                for (uint32_t j = 0; j < vresult->count && match_count < 1024; j++) {
                                    VecRecord *rec = &vresult->records[j];
                                    if (rec->embedding_dim != query_dim) continue;
                                    
                                    float dot = 0.0f, norm_q = 0.0f, norm_r = 0.0f;
                                    for (int k = 0; k < query_dim; k++) {
                                        dot += query_embedding[k] * rec->embedding[k];
                                        norm_q += query_embedding[k] * query_embedding[k];
                                        norm_r += rec->embedding[k] * rec->embedding[k];
                                    }
                                    float similarity = 0.0f;
                                    if (norm_q > 0.0f && norm_r > 0.0f) {
                                        similarity = dot / (sqrtf(norm_q) * sqrtf(norm_r));
                                    }
                                    
                                    if (similarity >= threshold) {
                                        strncpy(matches[match_count].agent_id, rec->agent_id, 31);
                                        strncpy(matches[match_count].type, rec->type, 15);
                                        matches[match_count].similarity = similarity;
                                        matches[match_count].timestamp = rec->timestamp;
                                        matches[match_count].confidence = rec->confidence;
                                        match_count++;
                                    }
                                }
                            }
                            if (vresult) ndtsdb_vec_free_result(vresult);
                        }
                        closedir(dir);
                    }
                    
                    ndtsdb_close(db);
                    ndtsdb_lock_release(lock_fd);
                    
                    // 按相似度排序
                    for (int i = 0; i < match_count - 1; i++) {
                        for (int j = i + 1; j < match_count; j++) {
                            if (matches[j].similarity > matches[i].similarity) {
                                VectorMatch tmp = matches[i];
                                matches[i] = matches[j];
                                matches[j] = tmp;
                            }
                        }
                    }
                    
                    int return_count = (match_count < limit) ? match_count : limit;
                    
                    // 构建JSON响应
                    char json_buf[65536] = {0};
                    int jlen = 0;
                    jlen += snprintf(json_buf + jlen, sizeof(json_buf) - jlen, "[");
                    for (int i = 0; i < return_count; i++) {
                        jlen += snprintf(json_buf + jlen, sizeof(json_buf) - jlen,
                            "%s{\"agent_id\":\"%s\",\"type\":\"%s\",\"similarity\":%.6f,\"timestamp\":%ld,\"confidence\":%.4f}",
                            i > 0 ? "," : "",
                            matches[i].agent_id,
                            matches[i].type,
                            matches[i].similarity,
                            matches[i].timestamp,
                            matches[i].confidence);
                        if (jlen >= (int)sizeof(json_buf) - 2) break;
                    }
                    snprintf(json_buf + jlen, sizeof(json_buf) - jlen, "]");
                    
                    strncpy(response_body, json_buf, sizeof(response_body) - 1);
                    response_body[sizeof(response_body) - 1] = '\0';
                }
            }
        }
        
        char http_response[65536];
        const char *status_text = (status == 200) ? "OK" : (status == 400 ? "Bad Request" : (status == 503 ? "Service Unavailable" : "Error"));
        build_http_response_with_cors(http_response, sizeof(http_response),
            status, status_text, content_type, response_body);
        send(client_fd, http_response, strlen(http_response), 0);
        close(client_fd);
        return;
    }
    
    // ========== GET /health ==========
    if (strcmp(method, "GET") == 0 && strcmp(path, "/health") == 0) {
        // 使用纯C实现，避免JS执行问题
        int kline_count = 0;
        int vector_count = 0;
        
        int lock_fd = ndtsdb_lock_acquire(database, false);
        if (lock_fd >= 0) {
            NDTSDB *db = ndtsdb_open(database);
            if (db) {
                QueryResult *r = ndtsdb_query_all(db);
                if (r) {
                    for (uint32_t i = 0; i < r->count; i++) {
                        // 通过volume字段判断：kline有volume，vector有embedding（通过volume=0或特殊值判断）
                        // 简单判断：volume >= 0 是 kline，volume < 0 是 tombstone，这里简化处理
                        kline_count++;
                    }
                    ndtsdb_free_result(r);
                }
                ndtsdb_close(db);
            }
            ndtsdb_lock_release(lock_fd);
        }
        
        long uptime_seconds = 0;
        if (server_start_time > 0) {
            uptime_seconds = time(NULL) - server_start_time;
        }
        
        snprintf(response_body, sizeof(response_body),
            "{\"status\":\"ok\",\"version\":\"ndtsdb-cli v1.0.0-beta\",\"uptime_seconds\":%ld,\"database\":\"%s\",\"kline_count\":%d,\"vector_count\":%d}",
            uptime_seconds, database, kline_count, vector_count);
        
        char http_response[4096];
        build_http_response_with_cors(http_response, sizeof(http_response),
            200, "OK", content_type, response_body);
        
        send(client_fd, http_response, strlen(http_response), 0);
        close(client_fd);
        return;
    }
    
    // ========== GET /symbols ==========
    if (strcmp(method, "GET") == 0 && strcmp(path, "/symbols") == 0) {
        // 纯C实现，查询所有symbol/interval统计
        int lock_fd = ndtsdb_lock_acquire(database, false);
        if (lock_fd < 0) {
            status = 503;
            snprintf(response_body, sizeof(response_body), 
                "{\"error\":\"Service Unavailable\",\"message\":\"Failed to acquire lock\"}");
        } else {
            NDTSDB *db = ndtsdb_open(database);
            if (!db) {
                status = 500;
                snprintf(response_body, sizeof(response_body), 
                    "{\"error\":\"Internal Server Error\",\"message\":\"Failed to open database\"}");
                ndtsdb_lock_release(lock_fd);
            } else {
                // 获取所有symbol/interval
                char symbols[1000][32];
                char intervals[1000][16];
                int count = ndtsdb_list_symbols(db, symbols, intervals, 1000);
                
                // 统计每个symbol@interval的行数
                typedef struct {
                    char key[64];
                    char symbol[32];
                    char interval[16];
                    int count;
                } SymbolStat;
                
                SymbolStat stats[1000];
                int stat_count = 0;
                
                // 查询所有数据并统计
                QueryResult *r = ndtsdb_query_all(db);
                if (r) {
                    typedef struct { KlineRow row; char sym[32]; char iv[16]; } ResultRow;
                    ResultRow *rows = (ResultRow*)r->rows;
                    
                    for (uint32_t i = 0; i < r->count; i++) {
                        // 跳过tombstone
                        if (rows[i].row.volume < 0) continue;
                        
                        char key[64];
                        snprintf(key, sizeof(key), "%s@%s", rows[i].sym, rows[i].iv);
                        
                        // 查找是否已存在
                        int found = -1;
                        for (int j = 0; j < stat_count; j++) {
                            if (strcmp(stats[j].key, key) == 0) {
                                found = j;
                                break;
                            }
                        }
                        
                        if (found >= 0) {
                            stats[found].count++;
                        } else if (stat_count < 1000) {
                            strncpy(stats[stat_count].key, key, 63);
                            strncpy(stats[stat_count].symbol, rows[i].sym, 31);
                            strncpy(stats[stat_count].interval, rows[i].iv, 15);
                            stats[stat_count].count = 1;
                            stat_count++;
                        }
                    }
                    ndtsdb_free_result(r);
                }
                
                ndtsdb_close(db);
                ndtsdb_lock_release(lock_fd);
                
                // 构建JSON响应
                char json_buf[32768] = {0};
                int jlen = 0;
                jlen += snprintf(json_buf + jlen, sizeof(json_buf) - jlen, "[");
                for (int i = 0; i < stat_count; i++) {
                    jlen += snprintf(json_buf + jlen, sizeof(json_buf) - jlen,
                        "%s{\"symbol\":\"%s\",\"interval\":\"%s\",\"count\":%d}",
                        i > 0 ? "," : "",
                        stats[i].symbol,
                        stats[i].interval,
                        stats[i].count);
                    if (jlen >= (int)sizeof(json_buf) - 2) break;
                }
                snprintf(json_buf + jlen, sizeof(json_buf) - jlen, "]");
                
                strncpy(response_body, json_buf, sizeof(response_body) - 1);
                response_body[sizeof(response_body) - 1] = '\0';
            }
        }
        
        char http_response[65536];
        const char *status_text = (status == 200) ? "OK" : (status == 503 ? "Service Unavailable" : "Error");
        build_http_response_with_cors(http_response, sizeof(http_response),
            status, status_text, content_type, response_body);
        send(client_fd, http_response, strlen(http_response), 0);
        close(client_fd);
        return;
    }
    
    // ========== GET /query ==========
    if (strcmp(method, "GET") == 0 && strncmp(path, "/query", 6) == 0) {
        // 解析查询参数
        char symbol[64] = {0};
        int64_t since = 0;
        int64_t until = 0;
        int limit = 0;
        bool has_symbol = false;
        bool has_since = false;
        bool has_until = false;
        bool has_limit = false;
        
        const char *query_start = strchr(path, '?');
        if (query_start) {
            query_start++;
            char query_copy[1024];
            strncpy(query_copy, query_start, sizeof(query_copy) - 1);
            query_copy[sizeof(query_copy) - 1] = '\0';
            
            char *token = strtok(query_copy, "&");
            while (token) {
                if (strncmp(token, "symbol=", 7) == 0) {
                    strncpy(symbol, token + 7, 63);
                    symbol[63] = '\0';
                    has_symbol = true;
                } else if (strncmp(token, "since=", 6) == 0) {
                    since = atoll(token + 6);
                    has_since = true;
                } else if (strncmp(token, "until=", 6) == 0) {
                    until = atoll(token + 6);
                    has_until = true;
                } else if (strncmp(token, "limit=", 6) == 0) {
                    limit = atoi(token + 6);
                    has_limit = true;
                }
                token = strtok(NULL, "&");
            }
        }
        
        int lock_fd = ndtsdb_lock_acquire(database, false);
        if (lock_fd < 0) {
            status = 503;
            snprintf(response_body, sizeof(response_body), 
                "{\"error\":\"Service Unavailable\",\"message\":\"Failed to acquire lock\"}");
        } else {
            NDTSDB *db = ndtsdb_open(database);
            if (!db) {
                status = 500;
                snprintf(response_body, sizeof(response_body), 
                    "{\"error\":\"Internal Server Error\",\"message\":\"Failed to open database\"}");
                ndtsdb_lock_release(lock_fd);
            } else {
                QueryResult *r = NULL;
                
                if (has_symbol && has_since && has_until) {
                    // 使用 queryFilteredTime
                    const char *symbols[] = {symbol};
                    r = ndtsdb_query_filtered_time(db, symbols, 1, since, until);
                } else if (has_symbol) {
                    // 使用 queryFiltered
                    const char *symbols[] = {symbol};
                    r = ndtsdb_query_filtered(db, symbols, 1);
                } else if (has_since && has_until) {
                    // 使用 queryTimeRange
                    r = ndtsdb_query_time_range(db, since, until);
                } else {
                    // 查询所有
                    r = ndtsdb_query_all(db);
                }
                
                if (r) {
                    // 构建JSON响应
                    char *json_buf = malloc(1024 * 1024); // 1MB buffer
                    if (json_buf) {
                        size_t json_len = 0;
                        json_len += snprintf(json_buf + json_len, 1024 * 1024 - json_len, "[");
                        
                        typedef struct { KlineRow row; char sym[32]; char iv[16]; } ResultRow;
                        ResultRow *rows = (ResultRow*)r->rows;
                        
                        int output_count = 0;
                        for (uint32_t i = 0; i < r->count && (limit == 0 || output_count < limit); i++) {
                            // 跳过tombstone
                            if (rows[i].row.volume < 0) continue;
                            
                            if (output_count > 0) {
                                json_len += snprintf(json_buf + json_len, 1024 * 1024 - json_len, ",");
                            }
                            
                            json_len += snprintf(json_buf + json_len, 1024 * 1024 - json_len,
                                "{\"symbol\":\"%s\",\"interval\":\"%s\",\"timestamp\":%ld,\"open\":%.8f,\"high\":%.8f,\"low\":%.8f,\"close\":%.8f,\"volume\":%.8f}",
                                rows[i].sym,
                                rows[i].iv,
                                rows[i].row.timestamp,
                                rows[i].row.open,
                                rows[i].row.high,
                                rows[i].row.low,
                                rows[i].row.close,
                                rows[i].row.volume);
                            
                            output_count++;
                        }
                        
                        json_len += snprintf(json_buf + json_len, 1024 * 1024 - json_len, "]");
                        
                        strncpy(response_body, json_buf, sizeof(response_body) - 1);
                        response_body[sizeof(response_body) - 1] = '\0';
                        free(json_buf);
                    }
                    ndtsdb_free_result(r);
                }
                
                ndtsdb_close(db);
                ndtsdb_lock_release(lock_fd);
            }
        }
        
        char http_response[65536];
        const char *status_text = (status == 200) ? "OK" : (status == 503 ? "Service Unavailable" : "Error");
        build_http_response_with_cors(http_response, sizeof(http_response),
            status, status_text, content_type, response_body);
        send(client_fd, http_response, strlen(http_response), 0);
        close(client_fd);
        return;
    }
    
    // ========== POST /write-json ==========
    if (strcmp(method, "POST") == 0 && strcmp(path, "/write-json") == 0) {
        // 解析请求体中的JSON Lines
        int inserted = 0;
        int errors = 0;
        
        int lock_fd = ndtsdb_lock_acquire(database, true);
        if (lock_fd < 0) {
            status = 503;
            snprintf(response_body, sizeof(response_body), 
                "{\"error\":\"Service Unavailable\",\"message\":\"Failed to acquire lock\"}");
        } else {
            NDTSDB *db = ndtsdb_open(database);
            if (!db) {
                status = 500;
                snprintf(response_body, sizeof(response_body), 
                    "{\"error\":\"Internal Server Error\",\"message\":\"Failed to open database\"}");
                ndtsdb_lock_release(lock_fd);
            } else {
                // 解析body中的JSON Lines
                // 简单解析：每行一个JSON对象
                char *line = strtok(body, "\n");
                while (line) {
                    // 跳过空行
                    while (*line == ' ' || *line == '\t' || *line == '\r') line++;
                    if (*line == '\0') {
                        line = strtok(NULL, "\n");
                        continue;
                    }
                    
                    // 简单解析JSON字段
                    char sym[64] = {0};
                    char iv[16] = {0};
                    int64_t ts = 0;
                    double open_val = 0, high = 0, low = 0, close_val = 0, volume = 0;
                    bool valid = true;
                    
                    // 查找symbol
                    char *p = strstr(line, "\"symbol\"");
                    if (p) {
                        p = strchr(p, ':');
                        if (p) {
                            p++;
                            while (*p == ' ' || *p == '\t' || *p == '"') p++;
                            int i = 0;
                            while (*p && *p != '"' && i < 63) sym[i++] = *p++;
                            sym[i] = '\0';
                        }
                    }
                    
                    // 查找interval
                    p = strstr(line, "\"interval\"");
                    if (p) {
                        p = strchr(p, ':');
                        if (p) {
                            p++;
                            while (*p == ' ' || *p == '\t' || *p == '"') p++;
                            int i = 0;
                            while (*p && *p != '"' && i < 15) iv[i++] = *p++;
                            iv[i] = '\0';
                        }
                    }
                    
                    // 查找timestamp
                    p = strstr(line, "\"timestamp\"");
                    if (p) {
                        p = strchr(p, ':');
                        if (p) ts = atoll(p + 1);
                    }
                    
                    // 查找open
                    p = strstr(line, "\"open\"");
                    if (p) {
                        p = strchr(p, ':');
                        if (p) open_val = atof(p + 1);
                    }
                    
                    // 查找high
                    p = strstr(line, "\"high\"");
                    if (p) {
                        p = strchr(p, ':');
                        if (p) high = atof(p + 1);
                    }
                    
                    // 查找low
                    p = strstr(line, "\"low\"");
                    if (p) {
                        p = strchr(p, ':');
                        if (p) low = atof(p + 1);
                    }
                    
                    // 查找close
                    p = strstr(line, "\"close\"");
                    if (p) {
                        p = strchr(p, ':');
                        if (p) close_val = atof(p + 1);
                    }
                    
                    // 查找volume
                    p = strstr(line, "\"volume\"");
                    if (p) {
                        p = strchr(p, ':');
                        if (p) volume = atof(p + 1);
                    }
                    
                    // 验证并插入
                    if (sym[0] && iv[0] && ts > 0) {
                        KlineRow row = {
                            .timestamp = ts,
                            .open = open_val,
                            .high = high,
                            .low = low,
                            .close = close_val,
                            .volume = volume,
                            .flags = 0
                        };
                        if (ndtsdb_insert(db, sym, iv, &row) == 0) {
                            inserted++;
                        } else {
                            errors++;
                        }
                    } else {
                        errors++;
                    }
                    
                    line = strtok(NULL, "\n");
                }
                
                ndtsdb_close(db);
                ndtsdb_lock_release(lock_fd);
                
                snprintf(response_body, sizeof(response_body), 
                    "{\"inserted\":%d,\"errors\":%d}", inserted, errors);
            }
        }
        
        char http_response[4096];
        const char *status_text = (status == 200) ? "OK" : (status == 503 ? "Service Unavailable" : "Error");
        build_http_response_with_cors(http_response, sizeof(http_response),
            status, status_text, content_type, response_body);
        send(client_fd, http_response, strlen(http_response), 0);
        close(client_fd);
        return;
    }
    snprintf(response_body, sizeof(response_body), "{\"error\":\"Not found\"}");
    char http_response[4096];
    build_http_response_with_cors(http_response, sizeof(http_response),
        404, "Not Found", content_type, response_body);
    send(client_fd, http_response, strlen(http_response), 0);
    close(client_fd);
}

// 从路径解析symbol参数
static bool parse_subscribe_params(const char *path, char *symbol, size_t symbol_size, char *interval, size_t interval_size) {
    const char *query = strchr(path, '?');
    if (!query) return false;
    query++;
    
    symbol[0] = '\0';
    interval[0] = '\0';
    
    char query_copy[256];
    strncpy(query_copy, query, sizeof(query_copy) - 1);
    query_copy[sizeof(query_copy) - 1] = '\0';
    
    char *token = strtok(query_copy, "&");
    while (token) {
        if (strncmp(token, "symbol=", 7) == 0) {
            strncpy(symbol, token + 7, symbol_size - 1);
            symbol[symbol_size - 1] = '\0';
        } else if (strncmp(token, "interval=", 9) == 0) {
            strncpy(interval, token + 9, interval_size - 1);
            interval[interval_size - 1] = '\0';
        }
        token = strtok(NULL, "&");
    }
    
    if (strlen(symbol) == 0) strcpy(symbol, "BTCUSDT");
    if (strlen(interval) == 0) strcpy(interval, "1m");
    
    return true;
}

// 外部打印异常函数（来自 common.h）
extern void print_exception(JSContext *ctx);

// cmd_serve 主函数
int cmd_serve(int argc, char **argv, JSContext *ctx, JSRuntime *rt) {
    const char *database = NULL;
    int port = WS_PORT;
    int help_flag = 0;
    
    // 重置全局配置
    auth_token = NULL;
    cors_origin = NULL;
    
    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            help_flag = 1;
        } else if ((strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) && i + 1 < argc) {
            database = argv[++i];
        } else if ((strcmp(argv[i], "--port") == 0 || strcmp(argv[i], "-p") == 0) && i + 1 < argc) {
            port = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--token") == 0 && i + 1 < argc) {
            auth_token = strdup(argv[++i]);
        } else if (strcmp(argv[i], "--cors-origin") == 0 && i + 1 < argc) {
            cors_origin = strdup(argv[++i]);
        }
    }
    
    if (help_flag) {
        printf("Usage: ndtsdb-cli serve --database <path> [--port <port>] [--token <secret>] [--cors-origin <origin>]\n");
        printf("  Start WebSocket/HTTP server for real-time data streaming\n");
        printf("  --database, -d    Database directory path (required)\n");
        printf("  --port, -p        Server port (default: %d)\n", WS_PORT);
        printf("  --token           Bearer token for write endpoint authentication\n");
        printf("  --cors-origin     CORS allowed origin (e.g., http://localhost:3000)\n");
        return 0;
    }
    
    if (!database) {
        fprintf(stderr, "Error: --database is required\n");
        fprintf(stderr, "Usage: ndtsdb-cli serve --database <path> [--port <port>] [--token <secret>] [--cors-origin <origin>]\n");
        return 1;
    }
    
    // 初始化客户端数组
    memset(ws_clients, 0, sizeof(ws_clients));
    for (int i = 0; i < MAX_WS_CLIENTS; i++) {
        ws_clients[i].fd = -1;
    }
    
    // 设置信号处理
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);
    
    // 创建服务器socket
    int server_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (server_fd < 0) {
        fprintf(stderr, "Error: Failed to create socket\n");
        return 1;
    }
    
    // 允许地址重用
    int opt = 1;
    if (setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt)) < 0) {
        fprintf(stderr, "Error: Failed to set socket options\n");
        close(server_fd);
        return 1;
    }
    
    // 绑定地址
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons(port);
    
    if (bind(server_fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        fprintf(stderr, "Error: Failed to bind to port %d\n", port);
        close(server_fd);
        return 1;
    }
    
    // 开始监听
    if (listen(server_fd, 10) < 0) {
        fprintf(stderr, "Error: Failed to listen on socket\n");
        close(server_fd);
        return 1;
    }
    
    server_fd_global = server_fd;
    server_start_time = time(NULL);
    
    printf("ndtsdb server listening on port %d\n", port);
    printf("Database: %s\n", database);
    if (auth_token) {
        printf("Auth: Bearer token enabled (write endpoints protected)\n");
    } else {
        printf("Auth: disabled (all endpoints open)\n");
    }
    if (cors_origin) {
        printf("CORS: enabled for origin %s\n", cors_origin);
    }
    printf("Press Ctrl+C to stop\n\n");
    
    // 使用传入的 ctx（main.c 已初始化 ndtsdb 模块）
    fprintf(stderr, "[ENTRY] ctx pointer: %p\n", (void*)ctx);
    fprintf(stderr, "[ENTRY] rt pointer: %p\n", (void*)rt);
    
    // 导入 ndtsdb 模块到 globalThis（关键：让 JS 代码可以使用 ndtsdb.xxx）
    const char *import_ndtsdb = "import * as ndtsdb from 'ndtsdb'; globalThis.ndtsdb = ndtsdb; 'ndtsdb imported';";
    JSValue import_result = JS_Eval(ctx, import_ndtsdb, strlen(import_ndtsdb), "<import>", JS_EVAL_TYPE_MODULE);
    if (JS_IsException(import_result)) {
        JSValue exc = JS_GetException(ctx);
        const char *err = JS_ToCString(ctx, exc);
        fprintf(stderr, "[ERROR] Failed to import ndtsdb module: %s\n", err ? err : "(null)");
        JS_FreeCString(ctx, err);
        JS_FreeValue(ctx, exc);
        close(server_fd);
        return 1;
    }
    JS_FreeValue(ctx, import_result);
    
    // 执行 pending jobs 等待模块导入完成
    JSContext *ctx_tmp;
    while (JS_ExecutePendingJob(rt, &ctx_tmp) > 0) {}
    
    fprintf(stderr, "[ENTRY] ndtsdb module imported to globalThis\n");
    
    // 在入口处测试 ctx 是否正常
    const char *entry_test = "2+2;";
    JSValue entry_result = JS_Eval(ctx, entry_test, strlen(entry_test), "<entry>", JS_EVAL_TYPE_GLOBAL);
    if (!JS_IsException(entry_result)) {
        int32_t val;
        if (JS_ToInt32(ctx, &val, entry_result) == 0) {
            fprintf(stderr, "[ENTRY] JS test (2+2): %d\n", val);
        }
    } else {
        fprintf(stderr, "[ENTRY] JS test failed in cmd_serve entry\n");
        JSValue exc = JS_GetException(ctx);
        const char *err = JS_ToCString(ctx, exc);
        fprintf(stderr, "[ENTRY] Error: %s\n", err ? err : "(null)");
        JS_FreeCString(ctx, err);
        JS_FreeValue(ctx, exc);
    }
    JS_FreeValue(ctx, entry_result);
    
    // 设置数据库路径到全局变量供JS使用
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "__db_path", JS_NewString(ctx, database));
    JS_FreeValue(ctx, global);
    
    // 主循环
    fprintf(stderr, "[LOOP] Starting server loop, ctx=%p\n", (void*)ctx);
    
    // 在循环开始前测试 ctx
    const char *loop_test = "4+4;";
    JSValue loop_r = JS_Eval(ctx, loop_test, strlen(loop_test), "<loop>", JS_EVAL_TYPE_GLOBAL);
    fprintf(stderr, "[LOOP] Test (4+4): %s\n", JS_IsException(loop_r) ? "EXCEPTION" : "OK");
    JS_FreeValue(ctx, loop_r);
    
    while (server_running) {
        fd_set read_fds;
        FD_ZERO(&read_fds);
        FD_SET(server_fd, &read_fds);
        int max_fd = server_fd;
        
        for (int i = 0; i < MAX_WS_CLIENTS; i++) {
            if (ws_clients[i].active && ws_clients[i].fd >= 0) {
                FD_SET(ws_clients[i].fd, &read_fds);
                if (ws_clients[i].fd > max_fd) max_fd = ws_clients[i].fd;
            }
        }
        
        struct timeval tv;
        tv.tv_sec = 0;
        tv.tv_usec = 100000; // 100ms timeout
        
        int activity = select(max_fd + 1, &read_fds, NULL, NULL, &tv);
        if (activity < 0 && errno != EINTR) {
            fprintf(stderr, "Error: select failed\n");
            break;
        }
        
        // 处理新连接
        if (FD_ISSET(server_fd, &read_fds)) {
            struct sockaddr_in client_addr;
            socklen_t addr_len = sizeof(client_addr);
            int client_fd = accept(server_fd, (struct sockaddr *)&client_addr, &addr_len);
            
            if (client_fd >= 0) {
                int slot = find_free_client_slot();
                if (slot >= 0) {
                    ws_clients[slot].fd = client_fd;
                    ws_clients[slot].active = true;
                    ws_clients[slot].is_websocket = false;
                    ws_clients[slot].handshake_complete = false;
                    ws_clients[slot].last_heartbeat = time(NULL);
                    ws_clients[slot].symbol[0] = '\0';
                    ws_clients[slot].interval[0] = '\0';
                    
                    // 设置非阻塞模式
                    int flags = fcntl(client_fd, F_GETFL, 0);
                    fcntl(client_fd, F_SETFL, flags | O_NONBLOCK);
                    
                    printf("New client connected from %s:%d (slot %d)\n",
                           inet_ntoa(client_addr.sin_addr), ntohs(client_addr.sin_port), slot);
                } else {
                    fprintf(stderr, "Error: Max clients reached, rejecting connection\n");
                    close(client_fd);
                }
            }
        }
        
        // 处理客户端数据
        for (int i = 0; i < MAX_WS_CLIENTS; i++) {
            if (!ws_clients[i].active || ws_clients[i].fd < 0) continue;
            
            if (FD_ISSET(ws_clients[i].fd, &read_fds)) {
                char buffer[WS_BUFFER_SIZE];
                ssize_t n = recv(ws_clients[i].fd, buffer, sizeof(buffer) - 1, 0);
                
                if (n <= 0) {
                    if (n < 0 && errno == EAGAIN) continue;
                    printf("Client %d disconnected\n", i);
                    close_client(i);
                    continue;
                }
                
                buffer[n] = '\0';
                ws_clients[i].last_heartbeat = time(NULL);
                
                // WebSocket握手
                if (!ws_clients[i].handshake_complete) {
                    if (strstr(buffer, "Upgrade: websocket") || strstr(buffer, "upgrade: websocket")) {
                        char symbol[64] = {0}, interval[16] = {0};
                        
                        // 检查是否是 /ws 端点（JSON消息订阅）
                        bool is_ws_endpoint = (strstr(buffer, "GET /ws") != NULL);
                        
                        if (!is_ws_endpoint) {
                            // 传统 /subscribe 端点，从URL解析参数
                            parse_subscribe_params(buffer, symbol, sizeof(symbol), interval, sizeof(interval));
                        }
                        
                        if (handle_websocket_handshake(ws_clients[i].fd, buffer, symbol)) {
                            ws_clients[i].is_websocket = true;
                            ws_clients[i].handshake_complete = true;
                            if (!is_ws_endpoint) {
                                strncpy(ws_clients[i].symbol, symbol, sizeof(ws_clients[i].symbol) - 1);
                                strncpy(ws_clients[i].interval, interval, sizeof(ws_clients[i].interval) - 1);
                                printf("WebSocket client %d subscribed to %s@%s\n", i, symbol, interval);
                                
                                // 发送初始数据
                                char latest[1024];
                                get_latest_for_symbol(ctx, symbol, interval, latest, sizeof(latest));
                                if (strlen(latest) > 0) {
                                    send_ws_text(ws_clients[i].fd, latest);
                                }
                            } else {
                                // /ws 端点，等待JSON subscribe消息
                                printf("WebSocket client %d connected to /ws endpoint\n", i);
                                ws_clients[i].symbol[0] = '\0';
                                ws_clients[i].interval[0] = '1';
                                ws_clients[i].interval[1] = 'm';
                                ws_clients[i].interval[2] = '\0';
                                // 发送连接确认
                                send_ws_text(ws_clients[i].fd, "{\"type\":\"connected\",\"message\":\"Send {action:subscribe,symbol:XXX} to subscribe\"}");
                            }
                        } else {
                            printf("WebSocket handshake failed for client %d\n", i);
                            close_client(i);
                        }
                    } else {
                        // HTTP请求
                        handle_http_request(ws_clients[i].fd, buffer, database, ctx);
                        close_client(i);
                    }
                } else {
                    // WebSocket数据帧
                    unsigned char opcode;
                    unsigned char *payload;
                    size_t payload_len;
                    
                    int frame_len = parse_ws_frame((unsigned char *)buffer, n, &opcode, &payload, &payload_len);
                    if (frame_len > 0) {
                        switch (opcode) {
                            case 0x01: // Text frame
                                // 处理客户端JSON消息
                                if (payload_len > 0) {
                                    char *msg = (char *)payload;
                                    // 解析JSON subscribe消息: {"action":"subscribe","symbol":"BTCUSDT"}
                                    if (strstr(msg, "\"action\"") && strstr(msg, "\"subscribe\"")) {
                                        char *sym_start = strstr(msg, "\"symbol\":");
                                        if (sym_start) {
                                            sym_start = strchr(sym_start, ':');
                                            if (sym_start) {
                                                sym_start++;
                                                while (*sym_start == ' ' || *sym_start == '\"') sym_start++;
                                                char new_symbol[64] = {0};
                                                int j = 0;
                                                while (*sym_start && *sym_start != '\"' && j < 63) {
                                                    new_symbol[j++] = *sym_start++;
                                                }
                                                new_symbol[j] = '\0';
                                                if (new_symbol[0]) {
                                                    strncpy(ws_clients[i].symbol, new_symbol, sizeof(ws_clients[i].symbol) - 1);
                                                    printf("WebSocket client %d subscribed to %s\n", i, new_symbol);
                                                    // 发送确认
                                                    char ack[256];
                                                    snprintf(ack, sizeof(ack), "{\"type\":\"subscribed\",\"symbol\":\"%s\"}", new_symbol);
                                                    send_ws_text(ws_clients[i].fd, ack);
                                                    // 发送最新数据
                                                    char latest[1024];
                                                    get_latest_for_symbol(ctx, new_symbol, ws_clients[i].interval, latest, sizeof(latest));
                                                    if (strlen(latest) > 0) {
                                                        send_ws_text(ws_clients[i].fd, latest);
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                                break;
                            case 0x08: // Close frame
                                printf("WebSocket client %d sent close frame\n", i);
                                close_client(i);
                                break;
                            case 0x09: // Ping frame
                                send_ws_pong(ws_clients[i].fd);
                                break;
                            case 0x0A: // Pong frame
                                // 收到pong，更新心跳
                                break;
                        }
                        free(payload);
                    }
                }
            }
            
            // 心跳检测
            time_t now = time(NULL);
            if (ws_clients[i].active && ws_clients[i].handshake_complete && 
                now - ws_clients[i].last_heartbeat > WS_HEARTBEAT_INTERVAL * 3) {
                printf("Client %d heartbeat timeout\n", i);
                close_client(i);
            }
        }
        
        // 定期发送心跳
        static time_t last_ping = 0;
        time_t now = time(NULL);
        if (now - last_ping >= WS_HEARTBEAT_INTERVAL) {
            for (int i = 0; i < MAX_WS_CLIENTS; i++) {
                if (ws_clients[i].active && ws_clients[i].handshake_complete) {
                    send_ws_ping(ws_clients[i].fd);
                }
            }
            last_ping = now;
        }
    }
    
    // 清理
    printf("\nShutting down server...\n");
    for (int i = 0; i < MAX_WS_CLIENTS; i++) {
        if (ws_clients[i].active) {
            close_client(i);
        }
    }
    close(server_fd);
    server_fd_global = -1;
    
    return 0;
}
