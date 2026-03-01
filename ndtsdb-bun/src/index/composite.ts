// ============================================================
// 复合索引（多列组合）
// 目标：覆盖最常见的 (symbol, timestamp) 场景
//
// 结构（N 列）：
// - 前 N-1 列：嵌套 Map（key -> next）
// - 最后一列：BTreeIndex（key -> rowIndices）
//
// 例子：columns = ['symbol','timestamp']
//   root: Map<symbol, BTreeIndex<timestamp>>
// ============================================================

import { BTreeIndex } from './btree.js';

type PrefixKey = number | bigint | string;

type RangeFilter<T> = {
  gte?: T;
  lte?: T;
  gt?: T;
  lt?: T;
};

type FilterValue = PrefixKey | RangeFilter<number | bigint>;

export class CompositeIndex {
  private readonly columns: string[];
  private readonly root: Map<string, any>; // Map<string, Map|BTreeIndex>

  constructor(columns: string[]) {
    if (columns.length < 2) {
      throw new Error('Composite index requires at least 2 columns');
    }
    this.columns = columns;
    this.root = new Map();
  }

  getColumns(): string[] {
    return [...this.columns];
  }

  clear(): void {
    this.root.clear();
  }

  /**
   * 插入一条记录
   * @param values 与 columns 一一对应
   */
  insert(values: PrefixKey[], rowIndex: number): void {
    if (values.length !== this.columns.length) {
      throw new Error(`Expected ${this.columns.length} values, got ${values.length}`);
    }

    const lastVal = values[values.length - 1];
    if (typeof lastVal !== 'number' && typeof lastVal !== 'bigint') {
      throw new Error(`CompositeIndex last column must be number|bigint, got ${typeof lastVal}`);
    }

    let level: Map<string, any> = this.root;

    // 遍历前 N-1 列
    for (let depth = 0; depth < values.length - 1; depth++) {
      const key = String(values[depth]);
      const isPrefixLast = depth === values.length - 2;

      if (isPrefixLast) {
        // 这一层存放 BTreeIndex<lastVal>
        if (!level.has(key)) {
          level.set(key, new BTreeIndex<number | bigint>(32));
        }
        const tree = level.get(key) as BTreeIndex<number | bigint>;
        tree.insert(lastVal as any, rowIndex);
      } else {
        if (!level.has(key)) {
          level.set(key, new Map());
        }
        level = level.get(key) as Map<string, any>;
      }
    }
  }

  /**
   * 查询
   * - 前缀列：支持精确匹配（=）或不提供（扫描所有）
   * - 最后一列：支持精确匹配或范围（gt/gte/lt/lte）
   */
  query(filters: Record<string, FilterValue>): number[] {
    const trees = this.collectTrees(this.root, 0, filters);

    const lastCol = this.columns[this.columns.length - 1];
    const lastFilter = filters[lastCol];

    const out: number[] = [];
    for (const tree of trees) {
      out.push(...this.queryLast(tree, lastFilter as any));
    }

    // 去重 + 排序
    return [...new Set(out)].sort((a, b) => a - b);
  }

  private collectTrees(level: Map<string, any>, depth: number, filters: Record<string, FilterValue>): Array<BTreeIndex<number | bigint>> {
    const colName = this.columns[depth];
    const filter = filters[colName];
    const isPrefixLast = depth === this.columns.length - 2;

    // prefixLast: 这一层的 value 就是 BTreeIndex
    if (isPrefixLast) {
      if (filter === undefined) {
        return Array.from(level.values()) as Array<BTreeIndex<number | bigint>>;
      }

      if (typeof filter === 'object' && (filter as any) && ('gte' in (filter as any) || 'lte' in (filter as any) || 'gt' in (filter as any) || 'lt' in (filter as any))) {
        throw new Error('Range filter is only supported on the last column');
      }

      const key = String(filter);
      const tree = level.get(key) as BTreeIndex<number | bigint> | undefined;
      return tree ? [tree] : [];
    }

    // 非 prefixLast：继续向下遍历 Map
    if (filter === undefined) {
      const out: Array<BTreeIndex<number | bigint>> = [];
      for (const child of level.values()) {
        out.push(...this.collectTrees(child as Map<string, any>, depth + 1, filters));
      }
      return out;
    }

    if (typeof filter === 'object' && (filter as any) && ('gte' in (filter as any) || 'lte' in (filter as any) || 'gt' in (filter as any) || 'lt' in (filter as any))) {
      throw new Error('Range filter is only supported on the last column');
    }

    const key = String(filter);
    const child = level.get(key) as Map<string, any> | undefined;
    if (!child) return [];
    return this.collectTrees(child, depth + 1, filters);
  }

  private queryLast(tree: BTreeIndex<number | bigint>, filter: FilterValue | undefined): number[] {
    if (filter === undefined) {
      return tree.getAllRows();
    }

    // range on last col
    if (typeof filter === 'object' && (filter as any) && ('gte' in (filter as any) || 'lte' in (filter as any) || 'gt' in (filter as any) || 'lt' in (filter as any))) {
      const { gte, lte, gt, lt } = filter as RangeFilter<number | bigint>;

      // 组合范围：用集合求交（宁可返回略多候选，再由 WHERE 二次过滤）
      if (gte !== undefined && lte !== undefined) {
        // [gte, lte]
        return tree.rangeQuery(gte as any, lte as any);
      }

      const lower =
        gte !== undefined
          ? tree.greaterThanOrEqual(gte as any)
          : gt !== undefined
            ? tree.greaterThan(gt as any)
            : tree.getAllRows();

      let upper: number[] | null = null;
      if (lte !== undefined) {
        upper = [...tree.lessThan(lte as any), ...tree.query(lte as any)];
      } else if (lt !== undefined) {
        upper = tree.lessThan(lt as any);
      }

      if (!upper) return lower;

      const upperSet = new Set(upper);
      return lower.filter((r) => upperSet.has(r));
    }

    // exact
    const v = filter as any;
    if (typeof v !== 'number' && typeof v !== 'bigint') {
      // last 列必须是数值/时间戳
      return [];
    }
    return tree.query(v);
  }
}
