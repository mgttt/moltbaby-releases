# GitHub Issue #139: Phase 2 Execution Plan
## Performance Optimization & Feature Enhancement

**Planning Date**: 2026-03-04
**Target Completion**: 2026-04-28 (8 weeks)
**Team Capacity**: 1-2 engineers (standard availability)

---

## Phase 2 Vision

**Goal**: Achieve **10-100x query performance improvement** for range queries while maintaining stability

**Success Metrics**:
- Range query latency: < 100ms for 1M row scans (vs ~2000ms currently)
- Throughput: > 10M rows/second decompression
- Streaming: Process 1GB files without memory explosion
- Backward Compatibility: 100% API compatibility maintained

---

## Work Breakdown Structure (WBS)

### 1. Foundation: Sparse Index Implementation (3-4 weeks)

#### Task 1.1: Design Sparse Index Structure (2-3 days, 16 core-hours)

**Objective**: Design efficient timestamp index for range queries

**Deliverables**:
- [ ] Index format specification document
- [ ] Memory overhead calculation
- [ ] Query optimization algorithm design
- [ ] Performance modeling

**Acceptance Criteria**:
- [ ] Document supports 1-100M row datasets
- [ ] Memory overhead < 5% of original data
- [ ] Index construction time < 100ms for 1M rows
- [ ] Design reviewed and approved

**Technical Details**:
```c
// Proposed index structure
typedef struct {
    int64_t timestamp_min;    // Min timestamp in block
    int64_t timestamp_max;    // Max timestamp in block
    uint32_t block_offset;    // Where data starts
    uint32_t block_size;      // How many bytes in block
    uint16_t row_count;       // Rows in this block (usually 1000s)
} NdtsBlockIndex;

// Index would be: [header] [8KB block metas] [data...]
// Block size: ~1000 rows = ~8-16KB → 1-2 index entries
```

**Technical Risk**: ⚠️ Integer overflow with 32-bit offsets
**Mitigation**: Validate file size < 4GB or use 64-bit offsets

**Effort**: 16 core-hours

---

#### Task 1.2: Write Index Building Logic (3-4 days, 24 core-hours)

**Objective**: Generate sparse index during file write

**Deliverables**:
- [ ] Index building code (write_ndtb_file extension)
- [ ] Unit tests for index generation
- [ ] Index validation logic
- [ ] Performance test showing < 100ms overhead

**Acceptance Criteria**:
- [ ] Index builds during write with < 5% time overhead
- [ ] 100% test coverage for edge cases (empty, single row, exact block boundaries)
- [ ] Index size matches theoretical calculation
- [ ] Backward compatible: can read old files without index

**Code Changes**:
- Modify: write_ndtb_file() to emit index after data
- New: build_sparse_index_from_data()
- New: validate_sparse_index()

**Effort**: 24 core-hours

---

#### Task 1.3: Implement Index-Based Range Query (4-5 days, 32 core-hours)

**Objective**: Use index to skip blocks during range queries

**Deliverables**:
- [ ] Range query implementation with index
- [ ] Block skipping logic
- [ ] Integration tests (PASS/FAIL/partial blocks)
- [ ] Performance comparison: indexed vs non-indexed

**Acceptance Criteria**:
- [ ] Range queries with index: 5-10x faster for selective ranges
- [ ] Correctness: 100% result match with non-indexed version
- [ ] Edge cases: exact boundaries, single block, empty ranges
- [ ] Benchmark shows improvement

**Algorithm Pseudocode**:
```
function query_range_indexed(min_ts, max_ts):
    matching_blocks = []
    for block in index:
        if block.max_ts < min_ts: continue    // Block entirely before range
        if block.min_ts > max_ts: continue    // Block entirely after range
        matching_blocks.append(block)           // Block overlaps range

    result = []
    for block in matching_blocks:
        data = read_and_decompress(block)
        for row in data:
            if min_ts <= row.timestamp <= max_ts:
                result.append(row)
    return result
```

**Effort**: 32 core-hours

---

### 2. Feature: Streaming Iterator (2-3 weeks)

#### Task 2.1: Design Iterator API (2 days, 12 core-hours)

**Objective**: Allow iterating over massive files without loading all in memory

**Deliverables**:
- [ ] Iterator API design document
- [ ] Memory consumption model (< 100KB regardless of file size)
- [ ] Thread safety analysis

**Proposed API**:
```c
typedef struct NdtsIterator NdtsIterator;

// Create iterator for querying range
NdtsIterator* ndtsdb_iter_range(NDTSDB* db, const char* symbol,
                                const char* interval,
                                int64_t ts_min, int64_t ts_max);

// Fetch next batch of rows
uint32_t ndtsdb_iter_next(NdtsIterator* iter, KlineRow* out, uint32_t max_count);

// Status and cleanup
int ndtsdb_iter_eof(NdtsIterator* iter);
void ndtsdb_iter_close(NdtsIterator* iter);
```

**Acceptance Criteria**:
- [ ] API supports 1GB+ files
- [ ] Memory usage independent of file size
- [ ] Thread-safe (per-iterator locks)

**Effort**: 12 core-hours

---

#### Task 2.2: Implement Iterator (4-5 days, 32 core-hours)

**Objective**: Build streaming decompression engine

**Deliverables**:
- [ ] Iterator implementation with block caching
- [ ] Streaming Gorilla decompression
- [ ] CRC validation per block
- [ ] Comprehensive tests

**Acceptance Criteria**:
- [ ] Can iterate 1GB file with < 50MB peak memory
- [ ] Throughput: > 5M rows/second
- [ ] All rows returned correctly
- [ ] CRC validation on streaming data works

**Technical Challenges**:
- ⚠️ Gorilla codec may need state reset between blocks
- ⚠️ CRC incremental calculation must work across blocks
- ⚠️ Compression state isolation for parallel iteration

**Mitigation**:
- Test extensively with multi-block files
- Add state reset markers to format
- Use thread-local state for parallelism

**Effort**: 32 core-hours

---

### 3. Optimization: Compression & Decompression (2 weeks)

#### Task 3.1: Profile Gorilla Codec (2 days, 12 core-hours)

**Objective**: Identify bottlenecks in compression/decompression

**Deliverables**:
- [ ] Performance profile report
- [ ] Bottleneck identification
- [ ] Optimization recommendations

**Tools**: perf, callgrind, FlameGraph

**Acceptance Criteria**:
- [ ] Profile shows actual hotspots
- [ ] Recommendations are actionable
- [ ] Baseline metrics established

**Effort**: 12 core-hours

---

#### Task 3.2: Optimize Decompression (3-4 days, 24 core-hours)

**Objective**: 2-3x decompression speed improvement

**Candidates**:
- [ ] SIMD vectorization (4x for bit operations)
- [ ] Cache-friendly layout
- [ ] Reduced allocations
- [ ] Parallel decompression

**Acceptance Criteria**:
- [ ] 2x+ decompression speedup measured
- [ ] No accuracy loss
- [ ] Works with existing format
- [ ] Benchmarks documented

**Effort**: 24 core-hours

---

#### Task 3.3: Optimize Compression (2-3 days, 16 core-hours)

**Objective**: Improve compression ratio 10-20%

**Candidates**:
- [ ] Delta encoding on pre-compressed values
- [ ] Bit-packing for small values
- [ ] Block-local compression selection

**Acceptance Criteria**:
- [ ] File size reduction 10-20%
- [ ] Compression time < original + 10%
- [ ] Format extensible for future improvements

**Effort**: 16 core-hours

---

### 4. Testing & Validation (1-2 weeks)

#### Task 4.1: Comprehensive Test Suite (3-4 days, 24 core-hours)

**Objective**: Full test coverage for Phase 2 features

**Test Categories**:
- [ ] Unit tests: each new function (95% coverage target)
- [ ] Integration tests: index with querying
- [ ] Edge cases: empty files, single row, exact boundaries
- [ ] Performance tests: latency & throughput benchmarks
- [ ] Stress tests: 100M+ rows, sustained iteration
- [ ] Regression tests: all Phase 1 functionality

**Acceptance Criteria**:
- [ ] All tests pass
- [ ] Coverage: > 90% for new code
- [ ] Performance: benchmarks meet targets
- [ ] No regressions vs Phase 1

**Effort**: 24 core-hours

---

#### Task 4.2: Performance Benchmark Suite (2-3 days, 16 core-hours)

**Objective**: Establish performance baselines and track improvements

**Benchmarks**:
- [ ] Decompression throughput (rows/sec)
- [ ] Range query latency (percentiles: p50, p95, p99)
- [ ] Iterator memory usage
- [ ] Index generation time
- [ ] Compression ratio

**Deliverables**:
- [ ] benchmark_phase2.c with 10+ test scenarios
- [ ] Results comparison: Phase 1 vs Phase 2
- [ ] Performance dashboard (CSV export)

**Acceptance Criteria**:
- [ ] Benchmarks reproducible (±5% variance)
- [ ] At least 5x improvement on range queries
- [ ] Memory usage < 100MB for 1GB files

**Effort**: 16 core-hours

---

### 5. Documentation & Release (1 week)

#### Task 5.1: Technical Documentation (2-3 days, 16 core-hours)

**Deliverables**:
- [ ] DESIGN.md: Architecture overview
- [ ] API_GUIDE.md: Iterator and index APIs
- [ ] PERFORMANCE.md: Benchmarks and tuning
- [ ] MIGRATION.md: Phase 1 → Phase 2 upgrade guide

**Acceptance Criteria**:
- [ ] Complete API documentation
- [ ] Examples for all major features
- [ ] Performance tuning guidance

**Effort**: 16 core-hours

---

#### Task 5.2: Release Management (1-2 days, 8 core-hours)

**Deliverables**:
- [ ] Version bump: 2.0.0 → 2.1.0
- [ ] CHANGELOG.md with full feature list
- [ ] Release notes highlighting improvements
- [ ] Tag and GitHub release

**Effort**: 8 core-hours

---

## Timeline & Milestones

```
Week 1-2:    Sparse Index Design & Build            (40 core-hours)
Week 3-4:    Iterator Implementation                (44 core-hours)
Week 5-6:    Compression Optimization               (52 core-hours)
Week 7-8:    Testing, Documentation, Release        (40 core-hours)

Total:       ~176 core-hours ≈ 5-6 person-weeks
```

### Milestones

| Date | Milestone | Criteria | Status |
|------|-----------|----------|--------|
| **Week 2** | Sparse Index MVP | Builds index, basic queries work | Pending |
| **Week 4** | Iterator Complete | Streams 1GB files | Pending |
| **Week 6** | Performance Targets | 10x improvement measured | Pending |
| **Week 8** | Release v2.1.0 | Full documentation + benchmarks | Pending |

---

## Risk Analysis & Mitigation

### Risk 1: Index Breaks Compatibility (MEDIUM)
**Impact**: Existing .ndtb files can't be read
**Mitigation**:
- Mark index as optional
- Code must work with/without index
- Extensive testing with old files

---

### Risk 2: Streaming Iterator Deadlocks (HIGH)
**Impact**: Iterator hangs, file system locks
**Mitigation**:
- Thread safety review before coding
- Deadlock detection tests
- Stress tests with concurrent access

---

### Risk 3: Performance Improvement Not Achieved (MEDIUM)
**Impact**: Phase 2 doesn't meet goals
**Mitigation**:
- Early profiling (Task 3.1) identifies issues
- Progressive optimization with benchmarking
- Fallback: release Phase 2 with achieved gains

---

### Risk 4: Compression Format Incompatibility (HIGH)
**Impact**: Can't read compressed files from other versions
**Mitigation**:
- Magic number or version field in format
- Comprehensive backward/forward compat tests
- Document format versioning

---

## Success Criteria

### Performance
- [ ] Range queries: 10-50x faster for selective ranges
- [ ] Throughput: > 10M rows/second decompression
- [ ] Memory: < 100MB for any file size
- [ ] Index overhead: < 5% of data size

### Reliability
- [ ] 100% test pass rate
- [ ] Zero regressions vs Phase 1
- [ ] 99.9% uptime on stress tests
- [ ] All error cases handled gracefully

### User Experience
- [ ] Simple, intuitive iterator API
- [ ] Clear performance tuning guidance
- [ ] Examples for common patterns
- [ ] Seamless upgrade path

---

## Resource Requirements

### Personnel
- 1 Senior Engineer (design, architecture review): 20% capacity
- 1-2 Mid-level Engineers (implementation): 100% capacity
- 1 QA Engineer (testing): 50% capacity

### Infrastructure
- Build machine: Linux x86-64 with 16GB RAM
- Benchmark data: 1GB+ .ndtb files
- Performance testing tools: perf, valgrind, custom harness

### Skills Required
- C systems programming (advanced)
- Compression algorithms (Gorilla)
- Data structures (B-tree or similar)
- Performance optimization

---

## Dependency Analysis

### Internal Dependencies
- **Requires**: Phase 1 complete and stable
- **Blocks**: Nothing (Phase 2 doesn't affect other projects)
- **Integration Points**:
  - ndtsdb.h API extensions
  - CLI tool integration (new query commands)
  - FFI bindings (Bun/JavaScript)

### External Dependencies
- GCC 11+ with AVX2 support (for SIMD)
- No new external libraries

---

## Success Definition

Phase 2 is **SUCCESSFUL** when:
1. ✅ Index-based range queries deliver 10x+ speedup
2. ✅ Iterator streams 1GB files with < 100MB memory
3. ✅ All Phase 1 functionality still works
4. ✅ Comprehensive tests pass (> 95% coverage)
5. ✅ Documentation complete and reviewed
6. ✅ Performance benchmarks published
7. ✅ v2.1.0 released and deployed

---

## Cost Estimate

| Category | Hours | Cost (@ $150/hr) | Status |
|----------|-------|-----------------|--------|
| Design & Planning | 28 | $4,200 | In Progress |
| Implementation | 112 | $16,800 | Pending |
| Testing | 24 | $3,600 | Pending |
| Documentation | 16 | $2,400 | Pending |
| **TOTAL** | **180** | **$27,000** | **On Track** |

---

## Sign-Off & Approval

- **Architecture Review**: Pending
- **PM Approval**: Pending
- **Stakeholder Sign-Off**: Pending

**Next Steps**:
1. Review this plan with team
2. Adjust timeline based on capacity
3. Begin Task 1.1 (Design) immediately
4. Weekly status updates

---

Generated: 2026-03-04 15:00
Plan Version: 1.0
Status: **DRAFT - Ready for Review**
