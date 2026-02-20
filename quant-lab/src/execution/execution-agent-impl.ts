// execution-agent-impl.ts - ExecutionAgent最小可跑实现
// P1子任务3: 最小可跑示例

import { ExecutionAgent, OrderRequest, OrderResponse, Position } from './agent';

// 硬编码API key（MVP阶段）
const HARDCODED_API_KEY = 'test-api-key-123456';

export class SimpleExecutionAgent implements ExecutionAgent {
  private apiKey: string;
  private positions: Map<string, Position> = new Map();
  private orderCounter = 0;

  constructor(apiKey: string = HARDCODED_API_KEY) {
    this.apiKey = apiKey;
    console.log('[ExecutionAgent] 初始化完成，API Key:', apiKey.substring(0, 10) + '...');
  }

  async submitOrder(request: OrderRequest): Promise<OrderResponse> {
    console.log('[submitOrder] 收到订单请求:', JSON.stringify(request));
    
    // 生成execId（时间戳+计数器）
    const execId = `exec-${Date.now()}-${++this.orderCounter}`;
    const orderId = `order-${Date.now()}`;
    
    // MVP: 模拟订单执行成功
    const response: OrderResponse = {
      execId,
      orderId,
      status: 'FILLED',
      filledQty: request.qty,
      avgPrice: request.type === 'MARKET' ? 50000 : (request.price || 50000),
      timestamp: Date.now()
    };
    
    // 更新持仓
    this.updatePosition(request);
    
    console.log('[submitOrder] 订单执行成功:', execId);
    return response;
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    console.log('[cancelOrder] 取消订单:', orderId);
    return true;
  }

  async getPosition(symbol: string): Promise<Position | null> {
    return this.positions.get(symbol) || null;
  }

  async getAllPositions(): Promise<Position[]> {
    return Array.from(this.positions.values());
  }

  private updatePosition(request: OrderRequest): void {
    const existing = this.positions.get(request.symbol);
    
    if (existing) {
      // 更新现有持仓
      const newSize = request.side === 'BUY' 
        ? existing.size + request.qty 
        : existing.size - request.qty;
      
      existing.size = newSize;
      existing.entryPrice = 50000; // MVP简化
    } else {
      // 新建持仓
      this.positions.set(request.symbol, {
        symbol: request.symbol,
        side: request.side === 'BUY' ? 'LONG' : 'SHORT',
        size: request.qty,
        entryPrice: 50000,
        unrealizedPnl: 0
      });
    }
  }
}

// 最小可跑示例
async function main() {
  console.log('=== ExecutionAgent MVP测试 ===\n');
  
  const agent = new SimpleExecutionAgent();
  
  // 测试1: 提交市价买单
  console.log('测试1: 提交市价买单');
  const buyOrder = await agent.submitOrder({
    symbol: 'BTCUSDT',
    side: 'BUY',
    type: 'MARKET',
    qty: 0.1
  });
  console.log('✅ execId:', buyOrder.execId);
  console.log('   orderId:', buyOrder.orderId);
  console.log('   status:', buyOrder.status);
  console.log('   filledQty:', buyOrder.filledQty);
  console.log();
  
  // 测试2: 查询持仓
  console.log('测试2: 查询持仓');
  const position = await agent.getPosition('BTCUSDT');
  console.log('✅ 持仓:', JSON.stringify(position, null, 2));
  console.log();
  
  // 测试3: 提交市价卖单
  console.log('测试3: 提交市价卖单');
  const sellOrder = await agent.submitOrder({
    symbol: 'BTCUSDT',
    side: 'SELL',
    type: 'MARKET',
    qty: 0.05
  });
  console.log('✅ execId:', sellOrder.execId);
  console.log();
  
  // 测试4: 查询更新后的持仓
  console.log('测试4: 查询更新后的持仓');
  const updatedPosition = await agent.getPosition('BTCUSDT');
  console.log('✅ 持仓:', JSON.stringify(updatedPosition, null, 2));
  
  console.log('\n=== MVP测试完成 ===');
}

// 运行测试
main().catch(console.error);
