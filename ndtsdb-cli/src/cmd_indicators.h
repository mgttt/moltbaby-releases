// cmd_indicators.h - 技术指标子命令声明
#ifndef CMD_INDICATORS_H
#define CMD_INDICATORS_H

#include <stdint.h>
#include "../../ndtsdb-lib/native/ndtsdb.h"

// 8个技术指标子命令
int cmd_sma(int argc, char *argv[]);
int cmd_ema(int argc, char *argv[]);
int cmd_atr(int argc, char *argv[]);
int cmd_vwap(int argc, char *argv[]);
int cmd_obv(int argc, char *argv[]);
int cmd_rsi(int argc, char *argv[]);
int cmd_macd(int argc, char *argv[]);
int cmd_bollinger(int argc, char *argv[]);

#endif
