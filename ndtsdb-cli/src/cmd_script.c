// cmd_script.c - Script and REPL subcommands implementation

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <unistd.h>
#include "quickjs.h"
#include "cmd_script.h"
#include "common.h"

// External function from main.c
extern char *read_file(const char *filename, size_t *len);
extern void print_exception(JSContext *ctx);

// Execute JS script file
int run_script(JSContext *ctx, const char *filename) {
    size_t len;
    char *script = read_file(filename, &len);
    if (!script) {
        fprintf(stderr, "Failed to read file: %s\n", filename);
        return 1;
    }
    
    bool is_module = (strstr(script, "import ") != NULL || strstr(script, "import\t") != NULL);
    int eval_flags = is_module ? JS_EVAL_TYPE_MODULE : JS_EVAL_TYPE_GLOBAL;

    JSValue result = JS_Eval(ctx, script, len, filename, eval_flags);
    free(script);
    
    if (JS_IsException(result)) {
        print_exception(ctx);
        JS_FreeValue(ctx, result);
        return 1;
    }
    JS_FreeValue(ctx, result);
    
    if (is_module) {
        JSRuntime *rt = JS_GetRuntime(ctx);
        JSContext *ctx2;
        int r;
        while ((r = JS_ExecutePendingJob(rt, &ctx2)) > 0) {}
        if (r < 0) {
            print_exception(ctx);
            return 1;
        }
    }
    
    return 0;
}

// Execute single line (REPL use)
int eval_line(JSContext *ctx, const char *line) {
    JSValue result = JS_Eval(ctx, line, strlen(line), "<repl>", JS_EVAL_TYPE_GLOBAL);
    
    if (JS_IsException(result)) {
        print_exception(ctx);
        JS_FreeValue(ctx, result);
        return -1;
    }
    
    if (!JS_IsUndefined(result)) {
        const char *str = JS_ToCString(ctx, result);
        if (str) {
            printf("%s\n", str);
            JS_FreeCString(ctx, str);
        }
    }
    
    JS_FreeValue(ctx, result);
    return 0;
}

// REPL main loop
void repl(JSContext *ctx) {
    printf("ndtsdb-cli REPL (QuickJS)\n");
    printf("Type .exit or press Ctrl+D to exit\n\n");
    
#ifdef HAVE_READLINE
    #include <readline/readline.h>
    #include <readline/history.h>
    
    char *line;
    while ((line = readline("> ")) != NULL) {
        if (strlen(line) == 0) {
            free(line);
            continue;
        }
        add_history(line);
        if (strcmp(line, ".exit") == 0 || strcmp(line, ".quit") == 0) {
            free(line);
            break;
        }
        if (strcmp(line, ".help") == 0) {
            printf("Commands:\n  .exit  - Exit REPL\n  .help  - Show this help\n\n");
            free(line);
            continue;
        }
        eval_line(ctx, line);
        free(line);
    }
#else
    char line[4096];
    while (true) {
        printf("> ");
        fflush(stdout);
        if (!fgets(line, sizeof(line), stdin)) {
            printf("\n");
            break;
        }
        size_t len = strlen(line);
        if (len > 0 && line[len - 1] == '\n') line[len - 1] = '\0';
        if (strlen(line) == 0) continue;
        if (strcmp(line, ".exit") == 0 || strcmp(line, ".quit") == 0) break;
        if (strcmp(line, ".help") == 0) {
            printf("Commands:\n  .exit  - Exit REPL\n  .help  - Show this help\n\n");
            continue;
        }
        eval_line(ctx, line);
    }
#endif
}

// Inject indicator functions into ndtsdb module
void inject_indicators(JSContext *ctx, JSRuntime *rt) {
    const char *indicators_src =
        "(function(){"
        "  var _nd = Object.assign({}, globalThis.ndtsdb);"
        "  _nd.sma = function(rows, period) {"
        "    if (!rows || rows.length < period) return [];"
        "    var result = [];"
        "    for (var i = period - 1; i < rows.length; i++) {"
        "      var sum = 0;"
        "      for (var j = 0; j < period; j++) sum += parseFloat(rows[i-j].close) || 0;"
        "      result.push({ timestamp: rows[i].timestamp, value: sum / period });"
        "    }"
        "    return result;"
        "  };"
        "  _nd.ema = function(rows, period) {"
        "    if (!rows || rows.length < period) return [];"
        "    var result = [];"
        "    var k = 2 / (period + 1);"
        "    var ema = parseFloat(rows[0].close) || 0;"
        "    for (var i = 1; i < rows.length; i++) {"
        "      ema = (parseFloat(rows[i].close) || 0) * k + ema * (1 - k);"
        "      if (i >= period - 1) result.push({ timestamp: rows[i].timestamp, value: ema });"
        "    }"
        "    return result;"
        "  };"
        "  _nd.atr = function(rows, period) {"
        "    if (!rows || rows.length < period + 1) return [];"
        "    var result = [];"
        "    var trs = [];"
        "    for (var i = 1; i < rows.length; i++) {"
        "      var h = parseFloat(rows[i].high) || 0;"
        "      var l = parseFloat(rows[i].low) || 0;"
        "      var pc = parseFloat(rows[i-1].close) || 0;"
        "      trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));"
        "    }"
        "    for (var i = period - 1; i < trs.length; i++) {"
        "      var sum = 0;"
        "      for (var j = 0; j < period; j++) sum += trs[i-j];"
        "      result.push({ timestamp: rows[i+1].timestamp, value: sum / period });"
        "    }"
        "    return result;"
        "  };"
        "  _nd.bollinger = function(rows, period, mult) {"
        "    if (!rows || rows.length < period) return [];"
        "    if (mult === undefined) mult = 2;"
        "    var result = [];"
        "    for (var i = period - 1; i < rows.length; i++) {"
        "      var sum = 0;"
        "      for (var j = 0; j < period; j++) sum += parseFloat(rows[i-j].close) || 0;"
        "      var mid = sum / period;"
        "      var vsum = 0;"
        "      for (var j = 0; j < period; j++) {"
        "        var d = (parseFloat(rows[i-j].close) || 0) - mid;"
        "        vsum += d * d;"
        "      }"
        "      var std = Math.sqrt(vsum / period);"
        "      result.push({ timestamp: rows[i].timestamp, mid: mid, upper: mid + mult*std, lower: mid - mult*std, std: std });"
        "    }"
        "    return result;"
        "  };"
        "  _nd.rsi = function(rows, period) {"
        "    if (!rows || rows.length < period + 1) return [];"
        "    if (period === undefined) period = 14;"
        "    var result = [];"
        "    var gains = 0, losses = 0;"
        "    for (var i = 1; i <= period; i++) {"
        "      var d = (parseFloat(rows[i].close)||0) - (parseFloat(rows[i-1].close)||0);"
        "      if (d > 0) gains += d; else losses -= d;"
        "    }"
        "    var avgGain = gains / period, avgLoss = losses / period;"
        "    for (var i = period; i < rows.length; i++) {"
        "      var d = (parseFloat(rows[i].close)||0) - (parseFloat(rows[i-1].close)||0);"
        "      if (d > 0) { avgGain = (avgGain * (period-1) + d) / period; avgLoss = (avgLoss * (period-1)) / period; }"
        "      else { avgGain = (avgGain * (period-1)) / period; avgLoss = (avgLoss * (period-1) - d) / period; }"
        "      var rs = avgGain / (avgLoss || 1e-10);"
        "      result.push({ timestamp: rows[i].timestamp, value: 100 - 100/(1+rs) });"
        "    }"
        "    return result;"
        "  };"
        "  _nd.macd = function(rows, fast, slow, signal) {"
        "    if (!rows || rows.length < slow) return [];"
        "    if (fast === undefined) fast = 12;"
        "    if (slow === undefined) slow = 26;"
        "    if (signal === undefined) signal = 9;"
        "    var fastEMA = _nd.ema(rows, fast);"
        "    var slowEMA = _nd.ema(rows, slow);"
        "    var macdLine = [];"
        "    for (var i = 0; i < fastEMA.length && i < slowEMA.length; i++) {"
        "      macdLine.push({ timestamp: fastEMA[i].timestamp, value: fastEMA[i].value - slowEMA[i].value });"
        "    }"
        "    var signalInput = macdLine.map(function(x){ return { timestamp: x.timestamp, close: x.value }; });"
        "    var signalEMA = _nd.ema(signalInput, signal);"
        "    var result = [];"
        "    for (var i = 0; i < signalEMA.length; i++) {"
        "      var macdVal = macdLine[i + signalEMA.length - signalEMA.length];"
        "      result.push({ timestamp: signalEMA[i].timestamp, macd: macdVal.value, signal: signalEMA[i].value, histogram: macdVal.value - signalEMA[i].value });"
        "    }"
        "    return result;"
        "  };"
        "  _nd.vwap = function(rows) {"
        "    if (!rows || rows.length === 0) return [];"
        "    var result = [];"
        "    var cumTPV = 0, cumVol = 0;"
        "    for (var i = 0; i < rows.length; i++) {"
        "      var h = parseFloat(rows[i].high) || 0;"
        "      var l = parseFloat(rows[i].low) || 0;"
        "      var c = parseFloat(rows[i].close) || 0;"
        "      var v = parseFloat(rows[i].volume) || 0;"
        "      var tp = (h + l + c) / 3;"
        "      cumTPV += tp * v;"
        "      cumVol += v;"
        "      result.push({ timestamp: rows[i].timestamp, value: cumTPV / (cumVol || 1) });"
        "    }"
        "    return result;"
        "  };"
        "  _nd.obv = function(rows) {"
        "    if (!rows || rows.length === 0) return [];"
        "    var result = [];"
        "    var obv = 0;"
        "    for (var i = 0; i < rows.length; i++) {"
        "      var v = parseFloat(rows[i].volume) || 0;"
        "      if (i > 0) {"
        "        var c = parseFloat(rows[i].close) || 0;"
        "        var pc = parseFloat(rows[i-1].close) || 0;"
        "        if (c > pc) obv += v; else if (c < pc) obv -= v;"
        "      }"
        "      result.push({ timestamp: rows[i].timestamp, value: obv });"
        "    }"
        "    return result;"
        "  };"
        "  globalThis.ndtsdb = _nd;"
        "  return 'indicators injected';"
        "})();";
    
    JSValue result = JS_Eval(ctx, indicators_src, strlen(indicators_src), "<indicators>", JS_EVAL_TYPE_GLOBAL);
    JS_FreeValue(ctx, result);
    
    // Execute pending jobs
    JSContext *ctx_tmp;
    while (JS_ExecutePendingJob(rt, &ctx_tmp) > 0) {}
}

// Script subcommand: run a JS file
int cmd_script(int argc, char *argv[], JSContext *ctx) {
    const char *script_file = NULL;
    const char *database = NULL;
    int repeat_secs = 0;
    
    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) {
            if (i + 1 < argc) database = argv[++i];
        } else if (strcmp(argv[i], "--repeat") == 0 || strcmp(argv[i], "-r") == 0) {
            if (i + 1 < argc) repeat_secs = atoi(argv[++i]);
        } else if (script_file == NULL && argv[i][0] != '-') {
            script_file = argv[i];
        }
    }
    
    if (!script_file) {
        fprintf(stderr, "Usage: ndtsdb-cli script <file.js> [--database <path>] [--repeat <secs>]\n");
        return 1;
    }
    
    // Set database in global
    if (database) {
        JSValue global_obj = JS_GetGlobalObject(ctx);
        JS_SetPropertyStr(ctx, global_obj, "__database", JS_NewString(ctx, database));
        JS_SetPropertyStr(ctx, global_obj, "__db", JS_NewString(ctx, database));
        JS_SetPropertyStr(ctx, global_obj, "__file", JS_NewString(ctx, script_file));
        JS_FreeValue(ctx, global_obj);
    }
    
    if (repeat_secs > 0) {
        // Repeat mode
        while (1) {
            int ret = run_script(ctx, script_file);
            if (ret != 0) return ret;
            sleep(repeat_secs);
        }
    } else {
        return run_script(ctx, script_file);
    }
}

// REPL subcommand: interactive shell
int cmd_repl(int argc, char *argv[], JSContext *ctx) {
    const char *database = NULL;
    
    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "--database") == 0 || strcmp(argv[i], "-d") == 0) {
            if (i + 1 < argc) database = argv[++i];
        }
    }
    
    // Set database in global
    JSValue global_obj = JS_GetGlobalObject(ctx);
    if (database) {
        JS_SetPropertyStr(ctx, global_obj, "__database", JS_NewString(ctx, database));
        JS_SetPropertyStr(ctx, global_obj, "__db", JS_NewString(ctx, database));
    } else {
        JS_SetPropertyStr(ctx, global_obj, "__database", JS_NULL);
        JS_SetPropertyStr(ctx, global_obj, "__db", JS_NULL);
    }
    JS_FreeValue(ctx, global_obj);
    
    repl(ctx);
    return 0;
}
