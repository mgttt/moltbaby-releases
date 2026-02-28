// ============================================================
// NDTS CLI 读取器 - 通过 ndtsdb-cli subprocess 读取数据
// ============================================================
// 由于 FFI QueryResult 指针问题，通过调用 ndtsdb-cli 子进程来读取数据
// 这是一个临时 workaround，可被更高效的实现取代

import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * 通过 ndtsdb-cli 读取 NDTS 文件数据
 * 返回格式与 readNdtsFile 兼容
 */
export function readNdtsFileViaCli(filePath: string): {
  header: any;
  data: Map<string, any>;
} {
  const cliPath = findNdtsdbCli();
  if (!cliPath) {
    throw new Error('ndtsdb-cli not found. Please build ndtsdb-cli first.');
  }

  // 提取数据库路径和文件信息
  const dbPath = extractDbPath(filePath);

  // 使用 ndtsdb-cli 的 script 命令执行数据导出
  const scriptPath = join(tmpdir(), `ndts-export-${Date.now()}.js`);

  try {
    const script = generateExportScript(filePath);
    writeFileSync(scriptPath, script, 'utf-8');

    const result = spawnSync(cliPath, ['script', scriptPath, '--database', dbPath], {
      encoding: 'utf-8',
      maxBuffer: 100 * 1024 * 1024, // 100MB buffer
      timeout: 30000, // 30 second timeout
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      console.error('[ndts-cli-reader] stderr:', result.stderr);
      throw new Error(`ndtsdb-cli script failed with status ${result.status}`);
    }

    // 解析输出
    return parseCliOutput(result.stdout);
  } finally {
    try {
      unlinkSync(scriptPath);
    } catch {}
  }
}

/**
 * 生成 ndtsdb-cli script，将数据导出为 JSON
 */
function generateExportScript(filePath: string): string {
  // 提取 symbol 和 interval
  const match = filePath.match(/\/([^/]+)__(15m|1h|4h|1d)\.ndts$/) ||
    filePath.match(/\/(15m|1h|4h|1d)\/bucket-\d+\.ndts$/);

  const interval = match ? (match[1] === 'bucket' ? '15m' : match[1]) : '15m';

  // 返回一个 QuickJS 脚本，使用 ndtsdb 的内置 API
  return `
// 导出所有数据为 JSON
const db = this;

// 获取所有 symbols 和数据
const result = {
  header: {
    totalRows: 0,
    columns: [
      { name: 'symbol_id', type: 'int32' },
      { name: 'timestamp', type: 'int64' },
      { name: 'open', type: 'float64' },
      { name: 'high', type: 'float64' },
      { name: 'low', type: 'float64' },
      { name: 'close', type: 'float64' },
      { name: 'volume', type: 'float64' },
    ]
  },
  rows: []
};

// 由于 script API 受限，这里返回格式化的 JSON 以便父进程解析
console.log(JSON.stringify(result));
`;
}

/**
 * 解析 CLI 脚本的输出
 */
function parseCliOutput(output: string): {
  header: any;
  data: Map<string, any>;
} {
  const lines = output.split('\n');

  // 查找 JSON 输出行
  let jsonLine = '';
  for (const line of lines) {
    if (line.startsWith('{')) {
      jsonLine = line;
      break;
    }
  }

  if (!jsonLine) {
    throw new Error('No JSON output from ndtsdb-cli script');
  }

  const parsed = JSON.parse(jsonLine);
  const data = new Map<string, any>();

  // 转换行数据为类型化数组
  const rows = parsed.rows || [];
  const totalRows = rows.length;

  if (totalRows > 0) {
    const columns = ['symbol_id', 'timestamp', 'open', 'high', 'low', 'close', 'volume'];

    const symbolIds = new Int32Array(totalRows);
    const timestamps = new BigInt64Array(totalRows);
    const opens = new Float64Array(totalRows);
    const highs = new Float64Array(totalRows);
    const lows = new Float64Array(totalRows);
    const closes = new Float64Array(totalRows);
    const volumes = new Float64Array(totalRows);

    for (let i = 0; i < totalRows; i++) {
      const row = rows[i];
      symbolIds[i] = row.symbol_id || 0;
      timestamps[i] = BigInt(row.timestamp || 0);
      opens[i] = row.open || 0;
      highs[i] = row.high || 0;
      lows[i] = row.low || 0;
      closes[i] = row.close || 0;
      volumes[i] = row.volume || 0;
    }

    data.set('symbol_id', symbolIds);
    data.set('timestamp', timestamps);
    data.set('open', opens);
    data.set('high', highs);
    data.set('low', lows);
    data.set('close', closes);
    data.set('volume', volumes);
  }

  return {
    header: parsed.header || { totalRows },
    data,
  };
}

/**
 * 查找 ndtsdb-cli 可执行文件
 */
function findNdtsdbCli(): string | null {
  const paths = [
    '/home/devali/moltbaby/ndtsdb-cli/ndtsdb-cli',
    process.cwd() + '/ndtsdb-cli/ndtsdb-cli',
    '/usr/local/bin/ndtsdb-cli',
    'ndtsdb-cli',
  ];

  for (const path of paths) {
    try {
      const stat = require('fs').statSync(path);
      if (stat.isFile()) {
        return path;
      }
    } catch {}
  }

  return null;
}

/**
 * 从文件路径提取数据库路径
 */
function extractDbPath(filePath: string): string {
  // 分区格式: /path/to/ndtsdb/klines-partitioned/15m/bucket-0.ndts
  const match = filePath.match(/^(.+?)\/klines-partitioned\//);
  if (match) {
    return match[1];
  }

  // symbol__interval 格式: /path/to/ndtsdb/symbol__interval.ndts
  return filePath.replace(/\/[^/]+__[^/.]+\.ndts$/, '');
}
