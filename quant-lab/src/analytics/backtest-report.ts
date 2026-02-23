#!/usr/bin/env bun
/**
 * 回测报告生成器 (Backtest Report Generator)
 *
 * 基于回测结果生成HTML报告，包含参数对比表和权益曲线图
 *
 * 用法:
 *   bun run backtest-report.ts --input results.json --output report.html
 *
 * 参数:
 *   --input   输入结果文件 (JSON格式，BacktestResult[] 或 SweepResult[])
 *   --output  输出HTML文件路径 (默认: report.html)
 *   --title   报告标题 (默认: 回测报告)
 *
 * 示例:
 *   bun run backtest-report.ts --input results.json --output report.html
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';

// ============================================================
// 类型定义
// ============================================================

interface ParamSet {
  spacing: number;
  orderSize: number;
}

interface SweepResult {
  params: ParamSet;
  sharpeRatio: number;
  totalPnL: number;
  maxDrawdown: number;
  winRate: number;
  totalTrades: number;
  annualizedReturn: number;
  profitFactor: number;
}

// ============================================================
// 命令行参数解析
// ============================================================

function parseArgs() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }

  let input: string | undefined;
  let output = 'report.html';
  let title = '回测报告';

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--input':
      case '-i':
        input = args[++i];
        break;
      case '--output':
      case '-o':
        output = args[++i];
        break;
      case '--title':
      case '-t':
        title = args[++i];
        break;
    }
  }

  if (!input) {
    console.error('错误: 必须指定 --input <results.json>');
    process.exit(1);
  }

  if (!existsSync(input)) {
    console.error(`错误: 输入文件不存在: ${input}`);
    process.exit(1);
  }

  return { input: resolve(input), output: resolve(output), title };
}

function showHelp() {
  console.log(`
回测报告生成器 (Backtest Report Generator)

用法:
  bun run backtest-report.ts --input results.json --output report.html

参数:
  --input, -i   输入结果文件 (JSON格式)
  --output, -o  输出HTML文件路径 (默认: report.html)
  --title, -t   报告标题 (默认: 回测报告)

示例:
  bun run backtest-report.ts --input results.json
  bun run backtest-report.ts --input sweep-results.json --output my-report.html --title "参数扫描报告"
`);
}

// ============================================================
// 数据加载
// ============================================================

function loadResults(inputPath: string): SweepResult[] {
  const content = readFileSync(inputPath, 'utf-8');
  const data = JSON.parse(content);

  // 支持两种格式: SweepResult[] 或 { results: SweepResult[] }
  if (Array.isArray(data)) {
    return data;
  } else if (data.results && Array.isArray(data.results)) {
    return data.results;
  } else {
    throw new Error('输入文件格式错误: 需要 SweepResult[] 或 { results: SweepResult[] }');
  }
}

// ============================================================
// HTML生成
// ============================================================

function generateHTML(results: SweepResult[], title: string): string {
  // 按 Sharpe 排序
  const sorted = [...results].sort((a, b) => b.sharpeRatio - a.sharpeRatio);

  // 计算统计信息
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  const avgSharpe = sorted.reduce((sum, r) => sum + r.sharpeRatio, 0) / sorted.length;
  const avgPnL = sorted.reduce((sum, r) => sum + r.totalPnL, 0) / sorted.length;

  // 生成表格行
  const tableRows = sorted.map((r, i) => {
    const rank = i + 1;
    const spacing = r.params.spacing.toFixed(3);
    const orderSize = r.params.orderSize;
    const sharpe = r.sharpeRatio.toFixed(2);
    const pnl = r.totalPnL.toFixed(2);
    const maxDD = (r.maxDrawdown * 100).toFixed(1);
    const winRate = (r.winRate * 100).toFixed(1);
    const trades = r.totalTrades;
    const annRet = (r.annualizedReturn * 100).toFixed(1);
    const pf = r.profitFactor.toFixed(2);

    // 高亮最佳行
    const rowClass = i === 0 ? 'class="best"' : '';

    return `
      <tr ${rowClass}>
        <td>${rank}</td>
        <td>${spacing}</td>
        <td>${orderSize}</td>
        <td>${sharpe}</td>
        <td class="${r.totalPnL >= 0 ? 'positive' : 'negative'}">${pnl}</td>
        <td>${maxDD}%</td>
        <td>${winRate}%</td>
        <td>${trades}</td>
        <td>${annRet}%</td>
        <td>${pf}</td>
      </tr>
    `;
  }).join('');

  // 生成权益曲线数据（JSON格式供外部可视化使用）
  const equityData = JSON.stringify(sorted.map(r => ({
    params: r.params,
    sharpe: r.sharpeRatio,
    pnl: r.totalPnL,
    maxDD: r.maxDrawdown,
  })));

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: #f5f7fa;
      color: #333;
      line-height: 1.6;
      padding: 20px;
    }
    .container {
      max-width: 1400px;
      margin: 0 auto;
    }
    header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 40px;
      border-radius: 12px;
      margin-bottom: 30px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.1);
    }
    header h1 {
      font-size: 2.5em;
      margin-bottom: 10px;
    }
    header p {
      opacity: 0.9;
      font-size: 1.1em;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 20px;
      margin-bottom: 30px;
    }
    .stat-card {
      background: white;
      padding: 25px;
      border-radius: 10px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.08);
      transition: transform 0.2s;
    }
    .stat-card:hover {
      transform: translateY(-3px);
    }
    .stat-card h3 {
      font-size: 0.9em;
      color: #666;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 10px;
    }
    .stat-card .value {
      font-size: 2em;
      font-weight: bold;
      color: #333;
    }
    .stat-card.best .value {
      color: #28a745;
    }
    .stat-card.worst .value {
      color: #dc3545;
    }
    .section {
      background: white;
      padding: 30px;
      border-radius: 10px;
      margin-bottom: 30px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.08);
    }
    .section h2 {
      margin-bottom: 20px;
      color: #444;
      border-bottom: 2px solid #667eea;
      padding-bottom: 10px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 20px;
    }
    th, td {
      padding: 12px 15px;
      text-align: left;
      border-bottom: 1px solid #eee;
    }
    th {
      background: #f8f9fa;
      font-weight: 600;
      color: #555;
      position: sticky;
      top: 0;
    }
    tr:hover {
      background: #f8f9fa;
    }
    tr.best {
      background: #d4edda !important;
      font-weight: bold;
    }
    tr.best td:first-child::before {
      content: "🏆 ";
    }
    .positive {
      color: #28a745;
      font-weight: 600;
    }
    .negative {
      color: #dc3545;
      font-weight: 600;
    }
    .chart-container {
      margin-top: 30px;
      padding: 20px;
      background: #f8f9fa;
      border-radius: 8px;
    }
    .chart-placeholder {
      text-align: center;
      padding: 60px 20px;
      color: #666;
    }
    .data-export {
      margin-top: 20px;
      padding: 15px;
      background: #f8f9fa;
      border-radius: 6px;
      font-family: 'Monaco', 'Menlo', monospace;
      font-size: 0.85em;
      overflow-x: auto;
    }
    footer {
      text-align: center;
      color: #666;
      padding: 30px;
      font-size: 0.9em;
    }
    @media (max-width: 768px) {
      header h1 {
        font-size: 1.8em;
      }
      th, td {
        padding: 8px 10px;
        font-size: 0.9em;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>${title}</h1>
      <p>生成时间: ${new Date().toLocaleString('zh-CN')}</p>
      <p>共测试 ${results.length} 组参数组合</p>
    </header>

    <div class="stats-grid">
      <div class="stat-card best">
        <h3>最佳 Sharpe 比率</h3>
        <div class="value">${best.sharpeRatio.toFixed(2)}</div>
        <small>参数: spacing=${best.params.spacing}, size=${best.params.orderSize}</small>
      </div>
      <div class="stat-card ${avgSharpe >= 0 ? 'best' : 'worst'}">
        <h3>平均 Sharpe 比率</h3>
        <div class="value">${avgSharpe.toFixed(2)}</div>
      </div>
      <div class="stat-card ${best.totalPnL >= 0 ? 'best' : 'worst'}">
        <h3>最佳收益</h3>
        <div class="value">${best.totalPnL.toFixed(0)}</div>
        <small>USDT</small>
      </div>
      <div class="stat-card worst">
        <h3>最差收益</h3>
        <div class="value">${worst.totalPnL.toFixed(0)}</div>
        <small>USDT</small>
      </div>
    </div>

    <div class="section">
      <h2>参数对比排名表</h2>
      <div style="overflow-x: auto;">
        <table>
          <thead>
            <tr>
              <th>排名</th>
              <th>网格间距</th>
              <th>订单大小</th>
              <th>Sharpe</th>
              <th>总收益</th>
              <th>最大回撤</th>
              <th>胜率</th>
              <th>交易次数</th>
              <th>年化收益</th>
              <th>盈亏比</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows}
          </tbody>
        </table>
      </div>
    </div>

    <div class="section">
      <h2>数据导出</h2>
      <p>以下数据可用于外部可视化工具（如 TradingView、Matplotlib）:</p>
      <div class="data-export">
        <pre>${equityData}</pre>
      </div>
    </div>

    <footer>
      <p>由 OpenClaw 回测引擎生成 | param-sweep + QuickJSBacktestEngine</p>
    </footer>
  </div>
</body>
</html>`;
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  const args = parseArgs();

  console.log('='.repeat(60));
  console.log('          回测报告生成器 (Backtest Report Generator)');
  console.log('='.repeat(60));
  console.log('');
  console.log(`输入文件: ${args.input}`);
  console.log(`输出文件: ${args.output}`);
  console.log(`报告标题: ${args.title}`);
  console.log('');

  // 加载结果
  console.log('[Report] 加载回测结果...');
  const results = loadResults(args.input);
  console.log(`[Report] 加载完成: ${results.length} 组结果`);

  // 生成HTML
  console.log('[Report] 生成HTML报告...');
  const html = generateHTML(results, args.title);

  // 写入文件
  const outputDir = dirname(args.output);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }
  writeFileSync(args.output, html);

  console.log('');
  console.log('='.repeat(60));
  console.log('✅ 报告生成成功!');
  console.log('='.repeat(60));
  console.log(`文件路径: ${args.output}`);
  console.log(`文件大小: ${(html.length / 1024).toFixed(1)} KB`);
  console.log('');
  console.log('打开方式:');
  console.log(`  浏览器: file://${args.output}`);
  console.log(`  命令:   open ${args.output}`);
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('[Report] 错误:', err);
  process.exit(1);
});
