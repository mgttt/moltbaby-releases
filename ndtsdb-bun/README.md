# ndtsdb-bun

TypeScript/Bun FFI bindings for the ndtsdb C library.

Supports two on-disk formats:

| Format | Extension | Use case |
|--------|-----------|----------|
| **NDTS** | `.ndts` | Time-series OHLCV / multi-column data (KlineRow) |
| **NDTV** | `.ndtv` | Vector embeddings for knowledge base (cosine similarity) |

---

## NDTS — Time-series API

### NdtsDatabase (low-level)

```typescript
import { openDatabase } from 'ndtsdb';

const db = openDatabase('./data');

// Insert a KlineRow
db.insert('BTC/USDT', '1m', {
  timestamp: BigInt(Date.now()),
  open: 65000, high: 65500, low: 64800, close: 65200, volume: 12.5,
});

// Batch insert
db.insertBatch('BTC/USDT', '1m', rows);

// Query all rows (sorted by timestamp asc)
const rows = db.queryAll();

// List symbols
const symbols = db.listSymbols(); // [{ symbol, interval }, ...]

// Latest timestamp for a symbol
const ts = db.getLatestTimestamp('BTC/USDT', '1m'); // BigInt, or -1n if empty

db.close(); // or use `using db = openDatabase(path)` (Symbol.dispose)
```

### PartitionedTable (multi-symbol, time-partitioned)

```typescript
import { PartitionedTable } from 'ndtsdb';

const table = new PartitionedTable('./data', { type: 'daily' });

// Write
table.appendBatch('ETH/USDT', '1h', rows);

// Read
const results = table.query('ETH/USDT', '1h', {
  from: new Date('2024-01-01'),
  to:   new Date('2024-01-31'),
});
```

### AppendWriter (single writer, columnar read)

```typescript
import { AppendWriter } from 'ndtsdb';

const writer = new AppendWriter('./mydb', 'AAPL', '1d');
writer.append(row);
writer.flush();

const all = writer.readAll();
writer.close();
```

---

## NDTV — Vector (Knowledge Base) API

`vec-ffi.ts` provides direct Bun FFI bindings for the NDTV vector format.
Each vector file is keyed by `(scope, type)` → stored as `{scope}__{type}.ndtv`.

### Types

```typescript
interface VecRecord {
  timestamp:  bigint;       // ms epoch
  agentId:    string;       // up to 31 bytes
  type:       string;       // up to 15 bytes
  confidence: number;       // float32
  dim:        number;       // embedding dimensions
  embedding:  Float32Array; // float32 values
  flags:      number;       // uint32
}
```

### Open / Close

```typescript
import { ffi_vec_open, ffi_vec_close } from 'ndtsdb/src/vec-ffi.ts';

const db = ffi_vec_open('./knowledge');
// ... use db ...
ffi_vec_close(db);
```

### Insert

```typescript
import { ffi_vec_insert } from 'ndtsdb/src/vec-ffi.ts';

const embedding = new Float32Array(1536); // fill with your model output
const ok = ffi_vec_insert(db, 'bot-001', 'semantic', {
  timestamp:  BigInt(Date.now()),
  agentId:    'bot-001',
  type:       'semantic',
  confidence: 0.95,
  dim:        1536,
  embedding,
  flags:      0,
});
```

### Query all records for a (scope, type)

```typescript
import { ffi_vec_query } from 'ndtsdb/src/vec-ffi.ts';

const records = ffi_vec_query(db, 'bot-001', 'semantic');
// records: VecRecord[]
```

### Cosine similarity search (top-k)

```typescript
import { ffi_vec_search } from 'ndtsdb/src/vec-ffi.ts';

const queryVec = new Float32Array(1536); // your query embedding
const topK = 5;
const results = ffi_vec_search(db, 'bot-001', 'semantic', queryVec, topK);

for (const r of results) {
  console.log(r.agentId, r.type, r.timestamp, r.confidence);
}
```

### Partition isolation

Different `(scope, type)` pairs are fully isolated:

```typescript
ffi_vec_insert(db, 'alice', 'episodic', recA);
ffi_vec_insert(db, 'bob',   'semantic', recB);
ffi_vec_insert(db, 'alice', 'semantic', recC);

ffi_vec_query(db, 'alice', 'episodic'); // → [recA]
ffi_vec_query(db, 'bob',   'semantic'); // → [recB]
ffi_vec_query(db, 'alice', 'semantic'); // → [recC]
```

---

## Tests

```bash
bun test tests/
```

Test coverage:

| Suite | Tests | Coverage |
|-------|-------|----------|
| `ndts.test.ts` | basic NDTS round-trip | core path |
| `edge.test.ts` | 60 edge cases (NDTS) | error paths, lifecycle, SQL |
| `vec.test.ts`  | 18 tests (NDTV) | insert/query/search/isolation |

---

## Native library

The FFI bindings load `libndts-{os}-{arch}.{so,dylib}` from:

1. `../../ndtsdb-lib/native/dist/` (monorepo layout)
2. `../lib/` (standalone)

Build the native lib:

```bash
cd /path/to/moltbaby
make -f ndtsdb-cli/Makefile gcc-linux   # Linux x86-64
```
