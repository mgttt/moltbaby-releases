// ============================================================
// B-Tree 索引 - 适合范围查询（如时间戳、价格）
// 支持 O(log n) 点查和范围查询
// ============================================================

/**
 * B-Tree 节点
 */
class BTreeNode<T> {
  keys: T[] = [];
  values: number[][] = [];  // 每个key对应的行号列表
  children: BTreeNode<T>[] = [];
  isLeaf: boolean = true;

  constructor(isLeaf: boolean = true) {
    this.isLeaf = isLeaf;
  }
}

/**
 * B-Tree 索引
 * 支持范围查询和点查
 */
export class BTreeIndex<T extends number | bigint> {
  private root: BTreeNode<T>;
  private order: number;
  private size: number = 0;

  constructor(order: number = 32) {
    this.order = order;
    this.root = new BTreeNode<T>(true);
  }

  /**
   * 插入键值对
   */
  insert(key: T, rowIndex: number): void {
    const root = this.root;
    
    if (root.keys.length === (2 * this.order) - 1) {
      // 根节点满，分裂
      const newRoot = new BTreeNode<T>(false);
      newRoot.children.push(root);
      this.splitChild(newRoot, 0, root);
      this.root = newRoot;
      this.insertNonFull(newRoot, key, rowIndex);
    } else {
      this.insertNonFull(root, key, rowIndex);
    }
    
    this.size++;
  }

  /**
   * 非满节点插入
   */
  private insertNonFull(node: BTreeNode<T>, key: T, rowIndex: number): void {
    let i = node.keys.length - 1;

    if (node.isLeaf) {
      // 在叶子节点找到位置
      while (i >= 0 && key < node.keys[i]) {
        i--;
      }

      if (i >= 0 && key === node.keys[i]) {
        // 键已存在，添加行号
        node.values[i].push(rowIndex);
      } else {
        // 插入新键
        node.keys.splice(i + 1, 0, key);
        node.values.splice(i + 1, 0, [rowIndex]);
      }
    } else {
      // 找到合适的子节点
      while (i >= 0 && key < node.keys[i]) {
        i--;
      }
      i++;

      if (node.children[i].keys.length === (2 * this.order) - 1) {
        this.splitChild(node, i, node.children[i]);
        if (key > node.keys[i]) {
          i++;
        }
      }

      this.insertNonFull(node.children[i], key, rowIndex);
    }
  }

  /**
   * 分裂子节点
   */
  private splitChild(parent: BTreeNode<T>, index: number, child: BTreeNode<T>): void {
    const mid = this.order - 1;
    const newNode = new BTreeNode<T>(child.isLeaf);

    // 复制后半部分到新节点
    newNode.keys = child.keys.splice(mid + 1);
    newNode.values = child.values.splice(mid + 1);

    if (!child.isLeaf) {
      newNode.children = child.children.splice(mid + 1);
    }

    // 提升中间键到父节点
    parent.keys.splice(index, 0, child.keys[mid]);
    parent.values.splice(index, 0, child.values[mid]);
    parent.children.splice(index + 1, 0, newNode);

    // 移除已提升的键
    child.keys.pop();
    child.values.pop();
  }

  /**
   * 精确查询
   */
  query(key: T): number[] {
    return this.queryNode(this.root, key);
  }

  private queryNode(node: BTreeNode<T>, key: T): number[] {
    let i = 0;
    while (i < node.keys.length && key > node.keys[i]) {
      i++;
    }

    if (i < node.keys.length && key === node.keys[i]) {
      return node.values[i];
    }

    if (node.isLeaf) {
      return [];
    }

    return this.queryNode(node.children[i], key);
  }

  /**
   * 范围查询 [start, end]
   */
  rangeQuery(start: T, end: T): number[] {
    const result: number[] = [];
    this.rangeQueryNode(this.root, start, end, result);
    return result.sort((a, b) => a - b);
  }

  private rangeQueryNode(node: BTreeNode<T>, start: T, end: T, result: number[]): void {
    let i = 0;

    // 找到起始位置
    while (i < node.keys.length && node.keys[i] < start) {
      i++;
    }

    // 收集范围内的键
    while (i < node.keys.length && node.keys[i] <= end) {
      result.push(...node.values[i]);

      // 如果有子节点，递归查询
      if (!node.isLeaf) {
        this.rangeQueryNode(node.children[i], start, end, result);
      }

      i++;
    }

    // 检查最后一个子节点
    if (!node.isLeaf && i < node.children.length) {
      this.rangeQueryNode(node.children[i], start, end, result);
    }
  }

  /**
   * 小于查询
   */
  lessThan(key: T): number[] {
    const result: number[] = [];
    this.lessThanNode(this.root, key, result);
    return result.sort((a, b) => a - b);
  }

  private lessThanNode(node: BTreeNode<T>, key: T, result: number[]): void {
    for (let i = 0; i < node.keys.length; i++) {
      if (node.keys[i] < key) {
        result.push(...node.values[i]);
        if (!node.isLeaf) {
          this.lessThanNode(node.children[i], key, result);
        }
      } else {
        if (!node.isLeaf) {
          this.lessThanNode(node.children[i], key, result);
        }
        break;
      }
    }

    // 最后一个子节点
    if (!node.isLeaf && node.keys[node.keys.length - 1] < key) {
      this.lessThanNode(node.children[node.children.length - 1], key, result);
    }
  }

  /**
   * 大于查询（严格大于）
   */
  greaterThan(key: T): number[] {
    const result: number[] = [];
    this.greaterThanNode(this.root, key, result);
    return result.sort((a, b) => a - b);
  }

  private greaterThanNode(node: BTreeNode<T>, key: T, result: number[]): void {
    let i = node.keys.length - 1;

    while (i >= 0 && node.keys[i] > key) {
      result.push(...node.values[i]);
      if (!node.isLeaf) {
        this.greaterThanNode(node.children[i + 1], key, result);
      }
      i--;
    }

    if (!node.isLeaf) {
      this.greaterThanNode(node.children[i + 1], key, result);
    }
  }

  /**
   * 大于等于查询
   */
  greaterThanOrEqual(key: T): number[] {
    const result: number[] = [];
    this.greaterThanOrEqualNode(this.root, key, result);
    return result.sort((a, b) => a - b);
  }

  private greaterThanOrEqualNode(node: BTreeNode<T>, key: T, result: number[]): void {
    let i = node.keys.length - 1;

    while (i >= 0 && node.keys[i] >= key) {
      result.push(...node.values[i]);
      if (!node.isLeaf) {
        this.greaterThanOrEqualNode(node.children[i + 1], key, result);
      }
      i--;
    }

    if (!node.isLeaf) {
      this.greaterThanOrEqualNode(node.children[i + 1], key, result);
    }
  }

  /**
   * 从数组构建索引
   */
  buildFromArray(array: T[]): void {
    this.root = new BTreeNode<T>(true);
    this.size = 0;

    for (let i = 0; i < array.length; i++) {
      this.insert(array[i], i);
    }
  }

  /**
   * 获取索引大小
   */
  getSize(): number {
    return this.size;
  }

  /**
   * 获取树高度
   */
  getHeight(): number {
    let height = 1;
    let node = this.root;
    while (!node.isLeaf) {
      height++;
      node = node.children[0];
    }
    return height;
  }

  /**
   * 获取所有行号（用于复合索引扫描）
   */
  getAllRows(): number[] {
    const result: number[] = [];
    this.collectAllRows(this.root, result);
    return result;
  }

  private collectAllRows(node: BTreeNode<T>, result: number[]): void {
    if (node.isLeaf) {
      for (const rowList of node.values) {
        result.push(...rowList);
      }
    } else {
      for (const child of node.children) {
        this.collectAllRows(child, result);
      }
    }
  }
}

/**
 * 时间戳索引（专用优化）
 * 利用时间序列的有序性
 */
export class TimestampIndex {
  private timestamps: BigInt64Array;
  private rowIndices: Int32Array;

  constructor(timestamps: BigInt64Array) {
    // 假设时间戳是有序的，直接存储
    this.timestamps = timestamps;
    this.rowIndices = new Int32Array(timestamps.length);
    for (let i = 0; i < timestamps.length; i++) {
      this.rowIndices[i] = i;
    }
  }

  /**
   * 二分查找
   */
  private binarySearch(target: bigint): number {
    let left = 0;
    let right = this.timestamps.length - 1;

    while (left <= right) {
      const mid = (left + right) >>> 1;
      if (this.timestamps[mid] === target) {
        return mid;
      }
      if (this.timestamps[mid] < target) {
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }

    return left; // 插入位置
  }

  /**
   * 范围查询
   */
  rangeQuery(start: bigint, end: bigint): number[] {
    const startIdx = this.binarySearch(start);
    const endIdx = this.binarySearch(end);

    const result: number[] = [];
    for (let i = startIdx; i < endIdx && i < this.timestamps.length; i++) {
      if (this.timestamps[i] >= start && this.timestamps[i] <= end) {
        result.push(this.rowIndices[i]);
      }
    }

    return result;
  }

  /**
   * 查找最近的一个时间点
   */
  findNearest(timestamp: bigint): { index: number; timestamp: bigint } | null {
    if (this.timestamps.length === 0) return null;

    const idx = this.binarySearch(timestamp);
    
    if (idx === 0) {
      return { index: 0, timestamp: this.timestamps[0] };
    }
    
    if (idx >= this.timestamps.length) {
      const last = this.timestamps.length - 1;
      return { index: last, timestamp: this.timestamps[last] };
    }

    // 比较前后哪个更近
    const prev = this.timestamps[idx - 1];
    const curr = this.timestamps[idx];
    
    if (timestamp - prev < curr - timestamp) {
      return { index: idx - 1, timestamp: prev };
    } else {
      return { index: idx, timestamp: curr };
    }
  }
}
