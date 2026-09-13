export default {
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // 成功剧本等集成用例需 3-5s（AI SDK v2 兼容层 + 流式消费），全量并行争抢易误触 5s 默认上限；
    // 提到 20s：真实死循环/挂起仍会超时暴露，仅给正常偏慢用例余量
    testTimeout: 20000,
  },
}
