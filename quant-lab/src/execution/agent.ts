// ExecutionAgent - 执行代理层接口定义
// P1子任务2: ExecutionAgent接口

export interface OrderRequest {
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT';
  qty: number;
  price?: number;
}

export interface OrderResponse {
  execId: string;
  orderId: string;
  status: 'PENDING' | 'FILLED' | 'REJECTED';
  filledQty: number;
  avgPrice: number;
  timestamp: number;
}

export interface Position {
  symbol: string;
  side: 'LONG' | 'SHORT';
  size: number;
  entryPrice: number;
  unrealizedPnl: number;
}

export interface ExecutionAgent {
  // 提交订单
  submitOrder(request: OrderRequest): Promise<OrderResponse>;
  
  // 取消订单
  cancelOrder(orderId: string): Promise<boolean>;
  
  // 获取持仓
  getPosition(symbol: string): Promise<Position | null>;
  
  // 获取所有持仓
  getAllPositions(): Promise<Position[]>;
}

// API Key管理接口
export interface ApiKeyManager {
  getActiveKey(): string;
  rotateKey(): void;
  validateKey(key: string): boolean;
}

// 熔断器接口
export interface CircuitBreaker {
  canExecute(): boolean;
  recordSuccess(): void;
  recordFailure(): void;
  getState(): 'CLOSED' | 'OPEN' | 'HALF_OPEN';
}
