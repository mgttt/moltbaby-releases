// cmd_script.h - Script and REPL subcommands

#ifndef CMD_SCRIPT_H
#define CMD_SCRIPT_H

#include "quickjs.h"

// Script subcommand: run a JS file
int cmd_script(int argc, char *argv[], JSContext *ctx);

// REPL subcommand: interactive shell
int cmd_repl(int argc, char *argv[], JSContext *ctx);

// Run a script file with given context
int run_script(JSContext *ctx, const char *filename);

// Execute single line (REPL use)
int eval_line(JSContext *ctx, const char *line);

// REPL main loop
void repl(JSContext *ctx);

// Inject indicator functions (sma, ema, rsi, etc.) into ndtsdb module
void inject_indicators(JSContext *ctx, JSRuntime *rt);

#endif // CMD_SCRIPT_H
