#!/usr/bin/env bun
/**
 * ingest-bybit.ts — 从 Bybit 拉取 K 线数据并写入 ndtsdb
 *
 * 用法：
 *   bun tools/ingest-bybit.ts --symbol BTCUSDT --interval 1m --database ./mydb
 *   bun tools/ingest-bybit.ts --symbol BTCUSDT --interval 1h --database ./mydb --since 2024-01-01
 *   bun tools/ingest-bybit.ts --symbol BTCUSDT --interval 1m --database ./mydb --watch 60
 *
 * 参数：
 *   --symbol    交易对（默认 BTCUSDT）
 *   --interval  K线周期：1m/5m/15m/1h/4h/1d
 *   --database  ndtsdb 数据库路径
 *   --since     起始时间（ISO 或 Unix 毫秒，默认最近 1000 根）
 *   --watch N   每 N 秒拉取一次最新数据（增量更新）
 */

import { execSync } from "child_process";
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
const sinceArg = getArg("--since");

if (!database) {
  console.error("Usage: bun ingest-bybit.ts --symbol BTCUSDT --interval 1m --database ./mydb");
  process.exit(1);
}

// interval → Bybit category/interval mapping
// 注意：Bybit API 在部分环境需要代理
// 设置环境变量 HTTPS_PROXY=http://127.0.0.1:8890 启用代理
// 或使用 --proxy 参数（需修改 fetch 选项）

const INTERVAL_MAP: Record<string, string> = {
  "1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30",
  "1h": "60", "2h": "120", "4h": "240", "6h": "360", "12h": "720",
  "1d": "D", "1w": "W", "1M": "M",
};
const bybitInterval = INTERVAL_MAP[interval] ?? interval;

// Ensure database directory exists
if (!existsSync(database)) mkdirSync(database, { recursive: true });

// ndtsdb-cli binary path
const BINARY = path.resolve(import.meta.dir, "../zig-out/bin/ndtsdb-cli");
if (!existsSync(BINARY)) {
  console.error(`Binary not found: ${BINARY}`);
  console.error("Run: zig build -Doptimize=ReleaseFast");
  process.exit(1);
}

/** 获取 ndtsdb 中该 series 的最新 timestamp */
function getLatestTimestamp(): number | null {
  try {
    const out = execSync(`${BINARY} info --database "${database}" --symbol "${symbol}"`, { encoding: "utf8" }).trim();
    const match = out.match(/"last":(\d+)/);
    return match ? parseInt(match[1]) : null;
  } catch { return null; }
}

/** 从 Bybit 拉取 K 线 */
async function fetchKlines(start?: number, limit = 1000): Promise<any[]> {
  const params = new URLSearchParams({
    category: "linear",
    symbol,
    interval: bybitInterval,
    limit: String(limit),
  });
  if (start) params.set("start", String(start));

  const url = `https://api.bybit.com/v5/market/kline?${params}`;
  const res = await fetch(url);
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); }
  catch { throw new Error(`Bybit API returned non-JSON (需要代理？): ${text.substring(0, 200)}`); }

  if (json.retCode !== 0) throw new Error(`Bybit API error: ${json.retMsg}`);

  // Bybit 返回格式: [startTime, open, high, low, close, volume, turnover]
  // 按时间升序排列
  return json.result.list.reverse().map((row: string[]) => ({
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

/** 写入 ndtsdb */
function writeToNdtsdb(rows: any[], upsert = false): void {
  if (rows.length === 0) return;
  const jsonLines = rows.map(r => JSON.stringify(r)).join("\n");
  const upsertFlag = upsert ? " --upsert" : "";
  try {
    execSync(`echo '${jsonLines.replace(/'/g, "'\\''")}'  | ${BINARY} write-json --database "${database}"${upsertFlag}`, {
      stdio: "pipe",
    });
  } catch (e: any) {
    // 使用 stdin 写入
    const proc = Bun.spawn([BINARY, "write-json", "--database", database, ...(upsert ? ["--upsert"] : [])], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(jsonLines);
    proc.stdin.end();
  }
}

/** 单次摄取 */
async function ingestOnce(incremental = false): Promise<number> {
  let startTs: number | undefined;

  if (incremental) {
    const latest = getLatestTimestamp();
    if (latest) {
      startTs = latest + 1; // 从下一毫秒开始
      console.log(`[${symbol}/${interval}] 增量更新，从 ${new Date(startTs).toISOString()} 开始`);
    }
  } else if (sinceArg) {
    startTs = isNaN(Number(sinceArg)) ? new Date(sinceArg).getTime() : parseInt(sinceArg);
    console.log(`[${symbol}/${interval}] 历史同步，从 ${new Date(startTs).toISOString()}`);
  }

  const rows = await fetchKlines(startTs, 1000);
  writeToNdtsdb(rows, incremental);
  console.log(`[${symbol}/${interval}] 写入 ${rows.length} 行`);
  return rows.length;
}

// === 主程序 ===
console.log(`[ingest-bybit] symbol=${symbol} interval=${interval} database=${database}`);

if (watchSecs > 0) {
  // 首次全量摄取
  await ingestOnce(false);
  // 循环增量更新
  while (true) {
    await new Promise(r => setTimeout(r, watchSecs * 1000));
    try {
      await ingestOnce(true);
    } catch (e: any) {
      console.error(`[error] ${e.message}`);
    }
  }
} else {
  await ingestOnce(false);
}
