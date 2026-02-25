import { PartitionedTable } from '../../../../ndtsdb/src/index.ts';

export const columns = [
  { name: 'symbol', type: 'string' },
  { name: 'interval', type: 'string' },
  { name: 'timestamp', type: 'int64' },
  { name: 'open', type: 'float64' },
  { name: 'high', type: 'float64' },
  { name: 'low', type: 'float64' },
  { name: 'close', type: 'float64' },
  { name: 'volume', type: 'float64' },
];

export const strategy = {
  type: 'time' as const,
  column: 'timestamp',
  interval: 'day' as const,
};

export function createTable(basePath: string): PartitionedTable {
  return new PartitionedTable(basePath, columns, strategy);
}
