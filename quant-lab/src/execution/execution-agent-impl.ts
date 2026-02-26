// execution-agent-impl.ts - ExecutionAgent最小可跑实现
// P1子任务3: 最小可跑示例

import { createLogger } from '../utils/logger';
const logger = createLogger('ExecutionAgent');

import { ExecutionAgent, OrderRequest, OrderResponse, Position } from './agent';

export class SimpleExecutionAgent implements ExecutionAgent {
  private apiKey: string;
  private positions: Map<string, Position> = new Map();
  private orderCounter = 0;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error('ExecutionAgent: apiKey is required');
    }
    this.apiKey = apiKey;
    logger.info('[ExecutionAgent] 初始化完成，API Key:', apiKey.substring(0, 10) + '...');
  }

  async submitOrder(request: OrderRequest): Promise<OrderResponse> {
    logger.info('[submitOrder] 收到订单请求:', JSON.stringify(request));
    
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
    
    logger.info('[submitOrder] 订单执行成功:', execId);
    return response;
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    logger.info('[cancelOrder] 取消订单:', orderId);
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
  logger.info('=== ExecutionAgent MVP测试 ===\n');
  
  const agent = new SimpleExecutionAgent();
  
  // 测试1: 提交市价买单
  logger.info('测试1: 提交市价买单');
  const buyOrder = await agent.submitOrder({
    symbol: 'BTCUSDT',
    side: 'BUY',
    type: 'MARKET',
    qty: 0.1
  });
  logger.info('✅ execId:', buyOrder.execId);
  logger.info('   orderId:', buyOrder.orderId);
  logger.info('   status:', buyOrder.status);
  logger.info('   filledQty:', buyOrder.filledQty);
  logger.info();
  
  // 测试2: 查询持仓
  logger.info('测试2: 查询持仓');
  const position = await agent.getPosition('BTCUSDT');
  logger.info('✅ 持仓:', JSON.stringify(position, null, 2));
  logger.info();
  
  // 测试3: 提交市价卖单
  logger.info('测试3: 提交市价卖单');
  const sellOrder = await agent.submitOrder({
    symbol: 'BTCUSDT',
    side: 'SELL',
    type: 'MARKET',
    qty: 0.05
  });
  logger.info('✅ execId:', sellOrder.execId);
  logger.info();
  
  // 测试4: 查询更新后的持仓
  logger.info('测试4: 查询更新后的持仓');
  const updatedPosition = await agent.getPosition('BTCUSDT');
  logger.info('✅ 持仓:', JSON.stringify(updatedPosition, null, 2));
  
  logger.info('\n=== MVP测试完成 ===');
}

// 运行测试
main().catch((err) => logger.error(err));
