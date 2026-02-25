import { createTable } from './common.ts';

const dataDir = process.env.NDTS_DATA_DIR!;
const table = createTable(dataDir);
const rows = table.query(r => r.symbol === 'BTCUSDT' && r.interval === '1h');

console.log('[verify-read-cli] rows:', rows.length);
if (rows.length !== 1000) {
  console.error('FAIL: expected 1000, got ' + rows.length);
  process.exit(1);
}
console.log('[verify-read-cli] ✅ PASS');
