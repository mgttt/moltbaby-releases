#!/usr/bin/env bun
import { AppendWriterFFI } from '../src/index.js';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';

const DATA_DIR = '/home/devali/moltbaby/quant-lib/data/ndtsdb/klines-partitioned/15m';

console.log('Quick validation...');

const files = readdirSync(DATA_DIR).filter(f => f.endsWith('.ndts'));
console.log('Files:', files.length);

let total = 0;
for (const file of files.slice(0, 3)) {
  const path = join(DATA_DIR, file);
  const header = AppendWriterFFI.readHeader(path);
  console.log(file, 'rows:', header.totalRows);
  total += header.totalRows;
}

console.log('Total rows (first 3 files):', total);
console.log('Success!');
