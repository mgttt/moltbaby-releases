/**
 * 熔断器主入口（集成版）
 * 
 * 统一导出新的分级熔断框架
 * 保持向后兼容
 */

// 新的分级熔断框架
export * from './tiered-circuit-breaker';

// 集成模块（向后兼容）
export * from './circuit-breaker-integration';

// 默认导出集成熔断器
export { IntegratedCircuitBreaker as default } from './circuit-breaker-integration';
