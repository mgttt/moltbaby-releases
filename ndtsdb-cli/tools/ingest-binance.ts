#!/usr/bin/env bun
/**
 * ingest-binance.ts — 从 Binance 拉取 K 线数据并写入 ndtsdb
 *
 * 用法：
 *   bun tools/ingest-binance.ts --symbol BTCUSDT --interval 1m --database ./mydb
 *   bun tools/ingest-binance.ts --symbol BTCUSDT --interval 1h --database ./mydb --since 2024-01-01
 *   bun tools/ingest-binance.ts --symbol BTCUSDT --interval 1m --database ./mydb --watch 60
 *
 * 参数：
 *   --symbol    交易对（默认 BTCUSDT）
 *   --interval  K线周期：1m/3m/5m/15m/30m/1h/2h/4h/6h/8h/12h/1d/3d/1w/1M
 *   --database  ndtsdb 数据库路径
 *   --since     起始时间（ISO 或 Unix 毫秒，默认最近 1000 根）
 *   --limit     每次拉取条数（默认 1000，最大 1000）
 *   --watch N   每 N 秒增量更新
 */

import { existsSync, mkdirSync } from "fs";
import path from "path";

const args = Bun.argv.slice(2);
function getArg(name: string, def?: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return def;
}

const symbol   = getArg("--symbol", "BTCUSDT")!;
const interval = getArg("--interval", "1m")!;
const database = getArg("--database");
const watchSecs = parseInt(getArg("--watch", "0")!);
const sinceArg  = getArg("--since");
const limitArg  = parseInt(getArg("--limit", "1000")!);
const proxyUrl  = getArg("--proxy") ?? process.env.HTTPS_PROXY ?? process.env.https_proxy;

// 代理说明：
// Binance/Bybit 在阿里云等受限地区需要代理
// 方式1：bun tools/ingest-binance.ts ... --proxy http://127.0.0.1:8890
// 方式2：export HTTPS_PROXY=http://127.0.0.1:8890

if (!database) {
  console.error("Usage: bun ingest-binance.ts --symbol BTCUSDT --interval 1m --database ./mydb");
  process.exit(1);
}

if (!existsSync(database)) mkdirSync(database, { recursive: true });

const BINARY = path.resolve(import.meta.dir, "../zig-out/bin/ndtsdb-cli");
if (!existsSync(BINARY)) {
  console.error(`Binary not found: ${BINARY}\nRun: zig build -Doptimize=ReleaseFast`);
  process.exit(1);
}

/** 获取最新 timestamp from ndtsdb */
function getLatestTimestamp(): number | null {
  try {
    const proc = Bun.spawnSync([BINARY, "info", "--database", database, "--symbol", symbol]);
    const out = proc.stdout.toString().trim();
    const match = out.match(/"last":(\d+)/);
    return match ? parseInt(match[1]) : null;
  } catch { return null; }
}

/** 从 Binance 拉取 K 线 */
async function fetchKlines(startTime?: number, limit = 1000): Promise<any[]> {
  const params = new URLSearchParams({
    symbol,
    interval,
    limit: String(Math.min(limit, 1000)),
  });
  if (startTime) params.set("startTime", String(startTime));

  const url = `https://api.binance.com/api/v3/klines?${params}`;
  const fetchOpts: RequestInit = {};
  if (proxyUrl) (fetchOpts as any).proxy = proxyUrl;
  const res = await fetch(url, fetchOpts);
  const text = await res.text();
  
  let data: any[];
  try { data = JSON.parse(text); }
  catch { throw new Error(`Binance API returned non-JSON: ${text.substring(0, 200)}`); }
  
  if (!Array.isArray(data)) {
    throw new Error(`Binance API error: ${JSON.stringify(data).substring(0, 200)}`);
  }

  // Binance kline 格式: [openTime, open, high, low, close, volume, closeTime, ...]
  return data.map((row: any[]) => ({
    symbol,
    interval,
    timestamp: parseInt(row[0]),
    open:   parseFloat(row[1]),
    high:   parseFloat(row[2]),
    low:    parseFloat(row[3]),
    close:  parseFloat(row[4]),
    volume: parseFloat(row[5]),
  }));
}

/** 写入 ndtsdb（通过 stdin 避免参数长度限制） */
async function writeToNdtsdb(rows: any[], upsert = false): Promise<void> {
  if (rows.length === 0) return;
  const jsonLines = rows.map(r => JSON.stringify(r)).join("\n");
  const cmdArgs = [BINARY, "write-json", "--database", database];
  if (upsert) cmdArgs.push("--upsert");
  
  const proc = Bun.spawn(cmdArgs, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(jsonLines + "\n");
  proc.stdin.end();
  await proc.exited;
}

/** 批量历史拉取（处理超过1000条的情况） */
async function fetchHistory(startMs?: number): Promise<number> {
  let total = 0;
  let currentStart = startMs;
  
  while (true) {
    const rows = await fetchKlines(currentStart, limitArg);
    if (rows.length === 0) break;
    
    await writeToNdtsdb(rows, !!currentStart);
    total += rows.length;
    console.log(`[${symbol}/${interval}] +${rows.length} 行，总计 ${total} 行`);
    
    if (rows.length < limitArg) break;  // 已到最新
    currentStart = rows[rows.length - 1].timestamp + 1;
    
    // 避免请求过快
    await new Promise(r => setTimeout(r, 300));
  }
  return total;
}

/** 增量更新（只拉最新的） */
async function ingestIncremental(): Promise<number> {
  const latest = getLatestTimestamp();
  const startMs = latest ? latest + 1 : undefined;
  
  if (latest) {
    console.log(`[${symbol}/${interval}] 增量更新，从 ${new Date(latest).toISOString()}`);
  }
  
  const rows = await fetchKlines(startMs, 200);
  if (rows.length === 0) {
    console.log(`[${symbol}/${interval}] 无新数据`);
    return 0;
  }
  await writeToNdtsdb(rows, true);
  console.log(`[${symbol}/${interval}] 增量 +${rows.length} 行`);
  return rows.length;
}

// === 主程序 ===
console.log(`[ingest-binance] symbol=${symbol} interval=${interval} database=${database}`);

const sinceMs = sinceArg
  ? (isNaN(Number(sinceArg)) ? new Date(sinceArg).getTime() : parseInt(sinceArg))
  : undefined;

if (watchSecs > 0) {
  // 首次全量（或增量）
  await fetchHistory(sinceMs);
  console.log(`\n[watch] 每 ${watchSecs} 秒更新...`);
  while (true) {
    await new Promise(r => setTimeout(r, watchSecs * 1000));
    try {
      await ingestIncremental();
    } catch (e: any) {
      console.error(`[error] ${e.message}`);
    }
  }
} else {
  await fetchHistory(sinceMs);
}
