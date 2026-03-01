# ndtsdb-lib

**C core library — NDTS time-series database**

Provides a high-performance OHLCV kline storage engine as a shared library
(`.so` / `.dylib` / `.dll`), used by:

- `ndtsdb-bun` — TypeScript FFI wrapper for Bun
- `ndtsdb-cli` — standalone command-line tool

---

## Build

```bash
make
```

Outputs:

- `native/dist/libndts-lnx-x86-64.so` — Linux x86-64 shared library
- `native/dist/libndts-lnx-x86-64.a`  — static library

Cross-platform naming: `libndts-{os}-{cpu}-{bits}.{ext}`
where `os` ∈ `lnx|osx|win`, `cpu` ∈ `x86|arm`, `bits` ∈ `32|64`.

---

## File Structure

```
ndtsdb-lib/
├── native/
│   ├── ndts.c          # core implementation (~2300 lines)
│   ├── ndtsdb.h        # public API header
│   ├── ndtsdb_vec.c/h  # SIMD vector operations
│   ├── cosine_sim.c/h  # cosine similarity
│   └── dist/           # build output (gitignored)
├── API.md              # full public API reference
├── Makefile
└── VERSION
```

---

## Quick API Reference

See [API.md](./API.md) for full documentation including stability guarantees,
behavioral notes, and known limitations.

```c
// ── Lifecycle ──────────────────────────────────────────────────
NDTSDB* ndtsdb_open(const char* path);
NDTSDB* ndtsdb_open_snapshot(const char* path, uint64_t snapshot_size);
void    ndtsdb_close(NDTSDB* db);

// ── Write ──────────────────────────────────────────────────────
// insert: UPSERT by timestamp; volume < 0 → tombstone (deletes row)
int ndtsdb_insert(NDTSDB* db, const char* symbol, const char* interval,
                  const KlineRow* row);
// insert_batch: bulk append (no dedup — see API.md)
int ndtsdb_insert_batch(NDTSDB* db, const char* symbol, const char* interval,
                        const KlineRow* rows, uint32_t n);
int ndtsdb_clear(NDTSDB* db, const char* symbol, const char* interval);

// ── Query ──────────────────────────────────────────────────────
QueryResult* ndtsdb_query(NDTSDB* db, const Query* q);
QueryResult* ndtsdb_query_all(NDTSDB* db);
QueryResult* ndtsdb_query_filtered(NDTSDB* db,
                                   const char** symbols, int n);
QueryResult* ndtsdb_query_time_range(NDTSDB* db,
                                     int64_t since_ms, int64_t until_ms);
QueryResult* ndtsdb_query_filtered_time(NDTSDB* db,
                                        const char** symbols, int n,
                                        int64_t since_ms, int64_t until_ms);
void         ndtsdb_free_result(QueryResult* r);

// ── JSON (preferred for cross-language use) ────────────────────
char* ndtsdb_query_all_json(NDTSDB* db);   // malloc'd; free with ndtsdb_free_json
void  ndtsdb_free_json(char* json);

// ── Meta ───────────────────────────────────────────────────────
int64_t     ndtsdb_get_latest_timestamp(NDTSDB* db,
                                        const char* symbol,
                                        const char* interval);
int         ndtsdb_list_symbols(NDTSDB* db,
                                char symbols[][32],
                                char intervals[][16],
                                int max_count);
const char* ndtsdb_get_path(NDTSDB* db);
```

---

## File Format (C format, gorilla-compressed)

```
[0..4095]   Header block: "NDTS"(4) + hlen(4) + JSON(hlen) + zero-padding
[4096..4099] Header CRC32 (over bytes 0..4095)
[4100..]    One or more Chunks:
              row_count(4)
              sym_id[]    (4×n)  — index into header.stringDicts.symbol
              itv_id[]    (4×n)  — index into header.stringDicts.interval
              ts[]        (8×n)  — int64 ms, raw
              open[]      (4+N)  — uint32 len + gorilla-compressed float64[]
              high[]      (4+N)
              low[]       (4+N)
              close[]     (4+N)
              volume[]    (4+N)
              flags[]     (4×n)  — uint32, raw
              CRC32(4)
```

Files without `"compression":"gorilla"` in the header JSON store OHLCV as
raw `float64[]` (no length prefix). Old TS-compressed files (`"enabled":true`)
are skipped on load.

---

## Concurrency

Each `NDTSDB*` handle owns its own in-memory symbol table. Multiple handles
may operate on **different** directories concurrently without synchronisation.
Concurrent writes to the **same** handle require external locking.
