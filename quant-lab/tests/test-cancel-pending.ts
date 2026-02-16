#!/usr/bin/env bun
/**
 * P0 回归测试：cancelOrder pending 订单检测
 * 
 * 防止未来改动误删 pending 检测逻辑
 * 
 * 测试场景：
 * 1. 撤销 pending 订单 → 跳过撤单（不发 API）
 * 2. 撤销真实订单（正确格式）→ 发送 API
 * 3. 撤销错误格式订单 → 抛出异常
 */

import { BybitProvider } from '../../quant-lib/src/providers/bybit';

// 模拟 request 方法，记录调用
let requestCalls: Array<{ method: string; endpoint: string; params: any }> = [];

function createTestProvider(): BybitProvider {
  const provider = new BybitProvider({
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    testnet: false,
    category: 'linear',
  });

  // Mock request 方法
  (provider as any).request = async (method: string, endpoint: string, params: any) => {
    requestCalls.push({ method, endpoint, params });
    return { retCode: 0, retMsg: 'OK', result: {} };
  };

  return provider;
}

async function test() {
  console.log('========================================');
  console.log('   P0 回归测试：cancelOrder pending 检测');
  console.log('========================================\n');

  let passed = 0;
  let failed = 0;

  // ============================================================
  // 测试 1: 撤销 pending 订单（应跳过）
  // ============================================================
  console.log('[测试 1] 撤销 pending 订单（应跳过撤单）');
  
  requestCalls = [];
  const provider1 = createTestProvider();
  
  try {
    await provider1.cancelOrder('pending-1234567890-abc');
    
    if (requestCalls.length === 0) {
      console.log('✅ 通过：pending 订单未发送 API 请求\n');
      passed++;
    } else {
      console.log('❌ 失败：pending 订单不应发送 API 请求\n');
      console.log('API 调用:', requestCalls);
      failed++;
    }
  } catch (error: any) {
    console.log('❌ 失败：pending 订单不应抛出异常\n');
    console.log('错误:', error.message);
    failed++;
  }

  // ============================================================
  // 测试 2: 撤销真实订单（正确格式）
  // ============================================================
  console.log('[测试 2] 撤销真实订单（MYXUSDT:12345678）');
  
  requestCalls = [];
  const provider2 = createTestProvider();
  
  try {
    await provider2.cancelOrder('MYXUSDT:12345678');
    
    if (requestCalls.length === 1) {
      const call = requestCalls[0];
      
      if (call.method === 'POST' && 
          call.endpoint === '/v5/order/cancel' &&
          call.params.symbol === 'MYXUSDT' &&
          call.params.orderId === '12345678') {
        console.log('✅ 通过：真实订单正确发送 API 请求\n');
        passed++;
      } else {
        console.log('❌ 失败：API 请求参数不正确\n');
        console.log('API 调用:', call);
        failed++;
      }
    } else {
      console.log('❌ 失败：应该发送 1 次 API 请求\n');
      console.log('实际调用次数:', requestCalls.length);
      failed++;
    }
  } catch (error: any) {
    console.log('❌ 失败：真实订单不应抛出异常\n');
    console.log('错误:', error.message);
    failed++;
  }

  // ============================================================
  // 测试 3: 撤销错误格式订单（无冒号）
  // ============================================================
  console.log('[测试 3] 撤销错误格式订单（无冒号）');
  
  requestCalls = [];
  const provider3 = createTestProvider();
  
  try {
    await provider3.cancelOrder('invalid-format');
    
    console.log('❌ 失败：错误格式订单应抛出异常\n');
    failed++;
  } catch (error: any) {
    if (error.message.includes('Invalid orderId format')) {
      console.log('✅ 通过：错误格式订单抛出正确异常\n');
      passed++;
    } else {
      console.log('❌ 失败：异常信息不正确\n');
      console.log('错误:', error.message);
      failed++;
    }
  }

  // ============================================================
  // 测试 4: 撤销错误格式订单（symbol 为空）
  // ============================================================
  console.log('[测试 4] 撤销错误格式订单（symbol 为空）');
  
  requestCalls = [];
  const provider4 = createTestProvider();
  
  try {
    await provider4.cancelOrder(':12345678');
    
    console.log('❌ 失败：空 symbol 应抛出异常\n');
    failed++;
  } catch (error: any) {
    if (error.message.includes('missing symbol or id')) {
      console.log('✅ 通过：空 symbol 抛出正确异常\n');
      passed++;
    } else {
      console.log('❌ 失败：异常信息不正确\n');
      console.log('错误:', error.message);
      failed++;
    }
  }

  // ============================================================
  // 测试 5: 撤销错误格式订单（orderId 为空）
  // ============================================================
  console.log('[测试 5] 撤销错误格式订单（orderId 为空）');
  
  requestCalls = [];
  const provider5 = createTestProvider();
  
  try {
    await provider5.cancelOrder('MYXUSDT:');
    
    console.log('❌ 失败：空 orderId 应抛出异常\n');
    failed++;
  } catch (error: any) {
    if (error.message.includes('missing symbol or id')) {
      console.log('✅ 通过：空 orderId 抛出正确异常\n');
      passed++;
    } else {
      console.log('❌ 失败：异常信息不正确\n');
      console.log('错误:', error.message);
      failed++;
    }
  }

  // ============================================================
  // 测试总结
  // ============================================================
  console.log('========================================');
  console.log('   测试结果');
  console.log('========================================');
  console.log(`通过: ${passed}/5`);
  console.log(`失败: ${failed}/5`);
  
  if (failed === 0) {
    console.log('\n✅ 所有测试通过！P0 修复未被回归。');
    console.log('========================================\n');
    process.exit(0);
  } else {
    console.log('\n❌ 部分测试失败！P0 修复可能已回归。');
    console.log('========================================\n');
    process.exit(1);
  }
}

test().catch(error => {
  console.error('\n❌ 测试执行失败:', error.message);
  console.error(error.stack);
  process.exit(1);
});
