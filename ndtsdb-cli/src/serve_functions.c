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
    char path[65536] = {0};  // 增加到 64KB 以支持大 embedding
    sscanf(request, "%15s %65535s", method, path);
    
    char response_body[32768] = {0};
    int status = 200;
    const char *content_type = "application/json";
    
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
    
    // ========== M3-P1: POST /write-vector (C原生路径) ==========
    if (strcmp(method, "POST") == 0 && strcmp(path, "/write-vector") == 0) {
        // 解析 body 中的向量 JSON
        int inserted = 0, errors = 0;
        
        // 获取独占锁
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
                // 解析单行向量 JSON
                // 简单解析：找 agent_id, type, timestamp, confidence, embedding
                VectorRecord vrec;
                memset(&vrec, 0, sizeof(vrec));
                
                // 从 body 解析字段 (简单JSON解析)
                const char *p;
                
                // 解析 agent_id: 找 "agent_id" 后的值
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
                
                // 解析 type
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
                
                // 解析 timestamp
                p = strstr(body, "\"timestamp\"");
                if (p) {
                    p = strchr(p, ':');
                    if (p) vrec.timestamp = atoll(p + 1);
                }
                
                // 解析 confidence
                p = strstr(body, "\"confidence\"");
                if (p) {
                    p = strchr(p, ':');
                    if (p) vrec.confidence = (float)atof(p + 1);
                }
                
                // 解析 embedding 数组
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
                
                // 写入
                if (vrec.timestamp > 0 && vrec.agent_id[0] && vrec.embedding && vrec.embedding_dim > 0) {
                    int ok = ndtsdb_insert_vector(db, vrec.agent_id, vrec.type, &vrec);
                    if (ok == 0) {
                        inserted++;
                        // 同时写入 KlineRow 标记
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
        snprintf(http_response, sizeof(http_response),
            "HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %zu\r\nConnection: close\r\n\r\n%s",
            status, status_text, content_type, strlen(response_body), response_body
        );
        send(client_fd, http_response, strlen(http_response), 0);
        close(client_fd);
        return;
    }
    // ========== M3-P2: GET /query-vectors (C原生路径) ==========
    if (strcmp(method, "GET") == 0 && strncmp(path, "/query-vectors", 14) == 0) {
        // 解析 query string 参数
        float query_embedding[4096];
        int query_dim = 0;
        float threshold = 0.8f;
        int limit = 10;
        char agent_filter[32] = {0};  // 可选的 agent_id 过滤
        
        fprintf(stderr, "[DEBUG] query-vectors path length: %zu\n", strlen(path));
        
        const char *query_start = strchr(path, '?');
        if (query_start) {
            query_start++;
            fprintf(stderr, "[DEBUG] query string length: %zu\n", strlen(query_start));
            char query_copy[65536];  // 增加到 64KB 以支持大 embedding
            strncpy(query_copy, query_start, sizeof(query_copy) - 1);
            query_copy[sizeof(query_copy) - 1] = '\0';
            
            char *token = strtok(query_copy, "&");
            while (token) {
                if (strncmp(token, "embedding=", 10) == 0) {
                    fprintf(stderr, "[DEBUG] embedding token length: %zu\n", strlen(token));
                    // 解析 [0.1,0.2,0.3] 或 0.1,0.2,0.3 格式
                    const char *p = token + 10;  // 跳过 "embedding="
                    // 跳过可能的 [ 前缀
                    if (*p == '[') p++;
                    query_dim = 0;
                    while (*p && *p != ']' && query_dim < 4096) {
                        char *end;
                        float v = strtof(p, &end);
                        if (end == p) { p++; continue; }
                        query_embedding[query_dim++] = v;
                        p = end;
                        while (*p == ' ' || *p == ',') p++;
                    }
                    fprintf(stderr, "[DEBUG] parsed query_dim: %d\n", query_dim);
                } else if (strncmp(token, "threshold=", 10) == 0) {
                    threshold = atof(token + 10);
                } else if (strncmp(token, "limit=", 6) == 0) {
                    limit = atoi(token + 6);
                    if (limit < 1) limit = 10;
                    if (limit > 100) limit = 100;
                } else if (strncmp(token, "agent_id=", 9) == 0) {
                    strncpy(agent_filter, token + 9, 31);
                    agent_filter[31] = '\0';
                    // URL decode
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
            // 获取共享锁
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
                    // 查询所有向量记录（遍历所有 symbol/interval 组合）
                    char symbols[100][32];
                    char intervals[100][16];
                    int sym_count = ndtsdb_list_symbols(db, symbols, intervals, 100);
                    
                    typedef struct {
                        char agent_id[32];
                        char type[16];
                        float similarity;
                        int64_t timestamp;
                        float confidence;
                    } VectorMatch;
                    
                    VectorMatch matches[1024];
                    int match_count = 0;
                    
                    for (int i = 0; i < sym_count && match_count < 1024; i++) {
                        // 如果指定了 agent_filter，跳过不匹配的
                        if (agent_filter[0] && strcmp(symbols[i], agent_filter) != 0) continue;
                        
                        fprintf(stderr, "[DEBUG] Checking symbol=%s, interval=%s\n", symbols[i], intervals[i]);
                        
                        VectorQueryResult *vresult = ndtsdb_query_vectors(db, symbols[i], intervals[i]);
                        if (vresult && vresult->count > 0) {
                            fprintf(stderr, "[DEBUG] Found %u records in %s__%s\n", vresult->count, symbols[i], intervals[i]);
                            for (uint32_t j = 0; j < vresult->count && match_count < 1024; j++) {
                                VectorRecord *rec = &vresult->records[j];
                                fprintf(stderr, "[DEBUG] Record %u: dim=%u, query_dim=%d\n", j, rec->embedding_dim, query_dim);
                                if (rec->embedding_dim != query_dim) {
                                    fprintf(stderr, "[DEBUG] Skipping: dimension mismatch\n");
                                    continue;
                                }
                                
                                // 计算余弦相似度
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
                    
                    ndtsdb_close(db);
                    ndtsdb_lock_release(lock_fd);
                    
                    // 按相似度降序排序
                    for (int i = 0; i < match_count - 1; i++) {
                        for (int j = i + 1; j < match_count; j++) {
                            if (matches[j].similarity > matches[i].similarity) {
                                VectorMatch tmp = matches[i];
                                matches[i] = matches[j];
                                matches[j] = tmp;
                            }
                        }
                    }
                    
                    // 限制返回数量
                    int return_count = (match_count < limit) ? match_count : limit;
                    
                    // 构建 JSON 响应
                    char json_buf[65536] = {0};
                    strcat(json_buf, "[");
                    for (int i = 0; i < return_count; i++) {
                        char item[512];
                        snprintf(item, sizeof(item), 
                            "%s{\"agent_id\":\"%s\",\"type\":\"%s\",\"similarity\":%.6f,\"timestamp\":%ld,\"confidence\":%.4f}",
                            i > 0 ? "," : "",
                            matches[i].agent_id,
                            matches[i].type,
                            matches[i].similarity,
                            matches[i].timestamp,
                            matches[i].confidence);
                        strcat(json_buf, item);
                    }
                    strcat(json_buf, "]");
                    
                    strncpy(response_body, json_buf, sizeof(response_body) - 1);
                }
            }
        }
        
        char http_response[65536];
        const char *status_text = (status == 200) ? "OK" : (status == 400 ? "Bad Request" : (status == 503 ? "Service Unavailable" : "Error"));
        snprintf(http_response, sizeof(http_response),
