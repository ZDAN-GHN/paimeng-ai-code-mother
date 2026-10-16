import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BusinessError } from '@/server/http';
import {
  createModelRegistry,
  modelLoadBackoffMs,
  modelRegistryTtlMs,
  modelSnapshotStaleGraceMs,
  type ModelRegistryStore,
} from '@/server/models/registry';
import type { ModelAlias, ModelConfigSnapshot, ModelProvider } from '@/shared/model-config';

const requiredAliasNames = ['codegen.default', 'route.classify'] as const;

function providerFixture(): ModelProvider {
  return {
    id: 'primary',
    displayName: '主提供商',
    apiFormat: 'openai-chat',
    baseUrl: 'https://models.example.test/v1',
    apiKeySource: 'env',
    apiKeyEnv: 'AI_API_KEY',
    options: {},
    enabled: true,
    createTime: '',
    updateTime: '',
  };
}

function aliasFixture(alias: string, modelName: string, enabled = true): ModelAlias {
  return {
    alias,
    providerId: 'primary',
    modelName,
    capabilities: alias === 'codegen.default'
      ? { streaming: true, toolCalling: true, structuredOutput: false, imageInput: false }
      : { streaming: false, toolCalling: false, structuredOutput: true, imageInput: false },
    settings: {},
    enabled,
    createTime: '',
    updateTime: '',
  };
}

function snapshot(revision: string, refreshEpoch: string, modelName: string): ModelConfigSnapshot {
  return {
    revision,
    refreshEpoch,
    providers: [providerFixture()],
    aliases: requiredAliasNames.map(alias => aliasFixture(alias, modelName)),
  };
}

function emptySnapshot(revision: string, refreshEpoch: string): ModelConfigSnapshot {
  return { revision, refreshEpoch, providers: [], aliases: [] };
}

function controlledClock(start = 0) {
  let current = start;
  return {
    clock: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function fakeStore(initial: ModelConfigSnapshot) {
  const state = {
    snapshot: initial,
    currentEpoch: initial.refreshEpoch,
    snapshotError: null as Error | null,
    epochError: null as Error | null,
    snapshotCalls: 0,
    epochCalls: 0,
  };
  const store: ModelRegistryStore = {
    async readConfigSnapshot() {
      state.snapshotCalls += 1;
      if (state.snapshotError) throw state.snapshotError;
      return state.snapshot;
    },
    async readRefreshEpoch() {
      state.epochCalls += 1;
      if (state.epochError) throw state.epochError;
      return state.currentEpoch;
    },
  };
  return { state, store };
}

const savedEnvironment = {
  AI_MODEL: process.env.AI_MODEL,
  AI_BASE_URL: process.env.AI_BASE_URL,
  AI_API_KEY: process.env.AI_API_KEY,
};

beforeEach(() => {
  process.env.AI_API_KEY = 'test-secret';
  process.env.AI_MODEL = '';
  process.env.AI_BASE_URL = 'https://env.example.test/v1';
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('模型注册表 TTL 与刷新序号', () => {
  it('TTL 从一致读事务开始计时，未到期前不重读快照，到期后按新快照解析', async () => {
    const { state, store } = fakeStore(snapshot('1', '0', 'model-a'));
    const time = controlledClock();
    const registry = createModelRegistry({ store, clock: time.clock });

    expect((await registry.resolveBinding('codegen.default')).modelName).toBe('model-a');
    expect(state.snapshotCalls).toBe(1);

    // 未立即生效的保存：revision 变了但 refreshEpoch 不变。
    state.snapshot = snapshot('2', '0', 'model-b');
    time.advance(modelRegistryTtlMs - 1);
    expect((await registry.resolveBinding('codegen.default')).modelName).toBe('model-a');
    expect(state.snapshotCalls).toBe(1);
    expect(state.epochCalls).toBe(2);

    time.advance(1);
    expect((await registry.resolveBinding('codegen.default')).modelName).toBe('model-b');
    expect(state.snapshotCalls).toBe(2);
  });

  it('TTL 以读取开始为准，慢加载完成后不会重新计时', async () => {
    const time = controlledClock();
    let snapshotModel = 'model-a';
    const store: ModelRegistryStore = {
      async readConfigSnapshot() {
        time.advance(modelRegistryTtlMs + 1000);
        return snapshot('1', '0', snapshotModel);
      },
      async readRefreshEpoch() {
        return '0';
      },
    };
    const registry = createModelRegistry({ store, clock: time.clock });

    expect((await registry.resolveBinding('codegen.default')).modelName).toBe('model-a');
    expect(registry.status().loadedAt).toBe(modelRegistryTtlMs + 1000);

    // 距离上次一致读开始已经超过 TTL，尽管距加载完成只有 0ms。
    snapshotModel = 'model-b';
    expect((await registry.resolveBinding('codegen.default')).modelName).toBe('model-b');
  });

  it('refreshEpoch 变化时无需等待 TTL，立即解析新快照', async () => {
    const { state, store } = fakeStore(snapshot('1', '0', 'model-a'));
    const time = controlledClock();
    const registry = createModelRegistry({ store, clock: time.clock });

    expect((await registry.resolveBinding('codegen.default')).modelName).toBe('model-a');
    state.snapshot = snapshot('2', '1', 'model-b');
    state.currentEpoch = '1';
    time.advance(100);

    expect((await registry.resolveBinding('codegen.default')).modelName).toBe('model-b');
    expect(state.snapshotCalls).toBe(2);
  });

  it('缓存不因滞后/更旧快照而降级覆盖', async () => {
    const { state, store } = fakeStore(snapshot('2', '2', 'model-b'));
    const time = controlledClock();
    const registry = createModelRegistry({ store, clock: time.clock });

    expect((await registry.resolveBinding('codegen.default')).modelName).toBe('model-b');

    // 读到旧副本：revision 与 epoch 都更低。
    state.snapshot = snapshot('1', '1', 'model-a');
    state.currentEpoch = '1';
    time.advance(modelRegistryTtlMs);

    expect((await registry.resolveBinding('codegen.default')).modelName).toBe('model-b');
    expect(registry.status().revision).toBe('2');
  });

  it('revision 更高但 epoch 回退的快照同样不被安装', async () => {
    const { state, store } = fakeStore(snapshot('2', '2', 'model-b'));
    const time = controlledClock();
    const registry = createModelRegistry({ store, clock: time.clock });

    expect((await registry.resolveBinding('codegen.default')).modelName).toBe('model-b');

    state.snapshot = snapshot('3', '1', 'model-a');
    state.currentEpoch = '1';
    time.advance(modelRegistryTtlMs);

    expect((await registry.resolveBinding('codegen.default')).modelName).toBe('model-b');
    expect(registry.status().revision).toBe('2');
    expect(registry.status().refreshEpoch).toBe('2');
  });
});

describe('并发与单飞', () => {
  it('并发解析共享同一次快照读取', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let reads = 0;
    const store: ModelRegistryStore = {
      async readConfigSnapshot() {
        reads += 1;
        await gate;
        return snapshot('1', '0', 'model-a');
      },
      async readRefreshEpoch() {
        return '0';
      },
    };
    const registry = createModelRegistry({ store, clock: controlledClock().clock });

    const first = registry.resolveBinding('codegen.default');
    const second = registry.resolveBinding('codegen.default');
    await new Promise(resolve => setTimeout(resolve, 0));
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(reads).toBe(1);
    expect(a.modelName).toBe('model-a');
    expect(b.modelName).toBe('model-a');
  });

  it('单飞中的旧结果不能满足已观察到更高 epoch 的请求', async () => {
    const time = controlledClock();
    let calls = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    let epoch = '0';
    const store: ModelRegistryStore = {
      async readConfigSnapshot() {
        calls += 1;
        if (calls === 1) {
          await firstGate;
          return snapshot('1', '0', 'model-a');
        }
        return snapshot('2', '1', 'model-b');
      },
      async readRefreshEpoch() {
        return epoch;
      },
    };
    const registry = createModelRegistry({ store, clock: time.clock });

    const slow = registry.resolveBinding('codegen.default');
    await new Promise(resolve => setTimeout(resolve, 0));
    epoch = '1';
    const fresh = registry.resolveBinding('codegen.default');
    await new Promise(resolve => setTimeout(resolve, 0));
    releaseFirst();
    const [a, b] = await Promise.all([slow, fresh]);

    expect(a.modelName).toBe('model-a');
    expect(b.modelName).toBe('model-b');
    expect(calls).toBe(2);
  });
});

describe('故障回退与不可掩盖的错误', () => {
  it('冷启动读取失败返回 503，绝不回退到环境变量', async () => {
    process.env.AI_MODEL = 'env-model';
    const store: ModelRegistryStore = {
      async readConfigSnapshot() {
        throw new Error('connect ECONNREFUSED');
      },
      async readRefreshEpoch() {
        throw new Error('connect ECONNREFUSED');
      },
    };
    const registry = createModelRegistry({ store, clock: controlledClock().clock });

    await expect(registry.resolveBinding('codegen.default')).rejects.toMatchObject({ status: 503, code: 50300 });
  });

  it('配置行缺失（缺表/未迁移）同样返回 503，不回退环境变量', async () => {
    process.env.AI_MODEL = 'env-model';
    const store: ModelRegistryStore = {
      async readConfigSnapshot() {
        throw new BusinessError(503, 50300, '模型配置状态行缺失，请先执行数据库迁移');
      },
      async readRefreshEpoch() {
        throw new BusinessError(503, 50300, '模型配置状态行缺失，请先执行数据库迁移');
      },
    };
    const registry = createModelRegistry({ store, clock: controlledClock().clock });

    await expect(registry.resolveBinding('codegen.default')).rejects.toMatchObject({ status: 503, code: 50300 });
  });

  it('DB 读取失败时，宽限期内继续使用旧快照并标记降级', async () => {
    const { state, store } = fakeStore(snapshot('1', '0', 'model-a'));
    const time = controlledClock();
    const registry = createModelRegistry({ store, clock: time.clock });

    await registry.resolveBinding('codegen.default');
    const baselineEpochCalls = state.epochCalls;

    state.snapshotError = new Error('database unavailable');
    state.epochError = new Error('database unavailable');
    time.advance(modelRegistryTtlMs);

    const degraded = await registry.resolveBinding('codegen.default');
    expect(degraded.modelName).toBe('model-a');
    expect(registry.status().degraded).toBe(true);
    expect(state.epochCalls).toBe(baselineEpochCalls + 1);

    // 退避窗口内每次解析仍会探测共享 epoch（否则可能掩盖新版本），但不再重载整份快照。
    time.advance(modelLoadBackoffMs - 1);
    expect((await registry.resolveBinding('codegen.default')).modelName).toBe('model-a');
    expect(state.epochCalls).toBe(baselineEpochCalls + 2);
    expect(state.snapshotCalls).toBe(1);
  });

  it('退避窗口内 epoch 未前进时暂缓整份快照重载，窗口过后再重试', async () => {
    const { state, store } = fakeStore(snapshot('1', '0', 'model-a'));
    const time = controlledClock();
    const registry = createModelRegistry({ store, clock: time.clock });

    await registry.resolveBinding('codegen.default');
    expect(state.snapshotCalls).toBe(1);

    // epoch 仍可读且未变，只有整份快照读取失败：宽限期内降级使用旧快照。
    state.snapshotError = new Error('database unavailable');
    time.advance(modelRegistryTtlMs);
    expect((await registry.resolveBinding('codegen.default')).modelName).toBe('model-a');
    expect(state.snapshotCalls).toBe(2);

    // 退避窗口内不重复重载整份快照。
    time.advance(modelLoadBackoffMs - 1);
    expect((await registry.resolveBinding('codegen.default')).modelName).toBe('model-a');
    expect(state.snapshotCalls).toBe(2);

    // 窗口过后恢复重试。
    time.advance(1);
    expect((await registry.resolveBinding('codegen.default')).modelName).toBe('model-a');
    expect(state.snapshotCalls).toBe(3);
  });

  it('退避窗口内 DB 恢复并手动 apply（epoch 前进）时立即换用新绑定', async () => {
    const { state, store } = fakeStore(snapshot('1', '0', 'model-a'));
    const time = controlledClock();
    const registry = createModelRegistry({ store, clock: time.clock });

    await registry.resolveBinding('codegen.default');

    // 瞬时故障：epoch 与快照都读不到，宽限期内降级到 model-a 并进入退避。
    state.snapshotError = new Error('database unavailable');
    state.epochError = new Error('database unavailable');
    time.advance(modelRegistryTtlMs);
    expect((await registry.resolveBinding('codegen.default')).modelName).toBe('model-a');
    expect(registry.status().degraded).toBe(true);

    // 退避窗口尚未结束时 DB 恢复，且有一次手动 apply 把 refreshEpoch 推进到 1。
    state.snapshotError = null;
    state.epochError = null;
    state.snapshot = snapshot('2', '1', 'model-b');
    state.currentEpoch = '1';
    const recovered = await registry.resolveBinding('codegen.default');
    expect(recovered.modelName).toBe('model-b');
    expect(registry.status().degraded).toBe(false);
  });

  it('旧快照超过宽限期仍读不到时返回 503', async () => {
    const { state, store } = fakeStore(snapshot('1', '0', 'model-a'));
    const time = controlledClock();
    const registry = createModelRegistry({ store, clock: time.clock });

    await registry.resolveBinding('codegen.default');
    state.epochError = new Error('database unavailable');
    state.snapshotError = new Error('database unavailable');
    time.advance(modelSnapshotStaleGraceMs + 1);

    await expect(registry.resolveBinding('codegen.default')).rejects.toMatchObject({ status: 503, code: 50300 });
  });

  it('已观察到更高 epoch 后加载失败，即使之后读不到版本也拒绝旧快照', async () => {
    const { state, store } = fakeStore(snapshot('1', '0', 'model-a'));
    const time = controlledClock();
    const registry = createModelRegistry({ store, clock: time.clock });

    await registry.resolveBinding('codegen.default');
    state.currentEpoch = '1';
    state.snapshotError = new Error('database unavailable');
    time.advance(modelRegistryTtlMs);

    await expect(registry.resolveBinding('codegen.default')).rejects.toMatchObject({ status: 503, code: 50300 });

    // 之后连版本都读不到，仍然不能用旧快照兜底。
    state.epochError = new Error('database unavailable');
    time.advance(modelLoadBackoffMs);
    await expect(registry.resolveBinding('codegen.default')).rejects.toMatchObject({ status: 503, code: 50300 });
  });

  it('无效配置不会被旧快照掩盖', async () => {
    const { state, store } = fakeStore(snapshot('1', '0', 'model-a'));
    const time = controlledClock();
    const registry = createModelRegistry({ store, clock: time.clock });

    await registry.resolveBinding('codegen.default');

    const broken = snapshot('2', '1', 'model-b');
    broken.aliases = broken.aliases.map(alias => (alias.alias === 'codegen.default' ? { ...alias, enabled: false } : alias));
    state.snapshot = broken;
    state.currentEpoch = '1';
    time.advance(modelRegistryTtlMs);

    await expect(registry.resolveBinding('codegen.default')).rejects.toMatchObject({ status: 503, code: 50300 });
    expect(registry.status().revision).toBe('1');
  });

  it.each(['not-a-number', '0x10', '-1', '', '1e3'])('刷新序号 %j 非法时视为无效配置且失败关闭', async invalidEpoch => {
    const { state, store } = fakeStore(snapshot('1', '0', 'model-a'));
    const time = controlledClock();
    const registry = createModelRegistry({ store, clock: time.clock });

    await registry.resolveBinding('codegen.default');
    state.currentEpoch = invalidEpoch;
    time.advance(modelRegistryTtlMs);

    const error = await registry.resolveBinding('codegen.default').catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 503, code: 50300 });
    expect((error as BusinessError).message).toContain('刷新序号');
    expect(registry.status().lastError).toContain('刷新序号');
  });

  it('一旦判定配置无效，之后的 DB 故障与退避期间仍返回 503，不得回退旧快照', async () => {
    const { state, store } = fakeStore(snapshot('1', '0', 'model-a'));
    const time = controlledClock();
    const registry = createModelRegistry({ store, clock: time.clock });

    await registry.resolveBinding('codegen.default');

    const broken = snapshot('2', '1', 'model-b');
    broken.aliases = broken.aliases.map(alias => (alias.alias === 'codegen.default' ? { ...alias, enabled: false } : alias));
    state.snapshot = broken;
    state.currentEpoch = '1';
    time.advance(modelRegistryTtlMs);
    await expect(registry.resolveBinding('codegen.default')).rejects.toMatchObject({ status: 503, code: 50300 });

    // 配置仍无效、DB 又读不到：退避与宽限期内也不能用旧快照兜底。
    state.epochError = new Error('database unavailable');
    state.snapshotError = new Error('database unavailable');
    time.advance(modelLoadBackoffMs);
    await expect(registry.resolveBinding('codegen.default')).rejects.toMatchObject({ status: 503, code: 50300 });

    // 修好配置后可以恢复，失败关闭不是永久锁定（退避窗口内仍会拒绝探测）。
    state.epochError = null;
    state.snapshotError = null;
    state.snapshot = snapshot('3', '2', 'model-c');
    state.currentEpoch = '2';
    time.advance(modelLoadBackoffMs);
    expect((await registry.resolveBinding('codegen.default')).modelName).toBe('model-c');
  });

  it('配置无效后读到回退快照：仍 503，直到加载到不回退的合法快照', async () => {
    const { state, store } = fakeStore(snapshot('2', '0', 'model-b'));
    const time = controlledClock();
    const registry = createModelRegistry({ store, clock: time.clock });

    expect((await registry.resolveBinding('codegen.default')).modelName).toBe('model-b');

    const broken = snapshot('3', '1', 'model-c');
    broken.aliases = broken.aliases.map(alias => (alias.alias === 'codegen.default' ? { ...alias, enabled: false } : alias));
    state.snapshot = broken;
    state.currentEpoch = '1';
    time.advance(modelRegistryTtlMs);
    await expect(registry.resolveBinding('codegen.default')).rejects.toMatchObject({ status: 503, code: 50300 });

    // 修复过程中读到的是更旧的合法快照：install 因版本回退拒绝，但不能因此把已装的旧模型放行。
    state.snapshot = snapshot('1', '0', 'model-a');
    state.currentEpoch = '0';
    await expect(registry.resolveBinding('codegen.default')).rejects.toMatchObject({ status: 503, code: 50300 });
    expect(registry.status().lastError).toContain('codegen.default');

    // 不回退的合法快照到达后才恢复。
    state.snapshot = snapshot('4', '1', 'model-d');
    state.currentEpoch = '1';
    expect((await registry.resolveBinding('codegen.default')).modelName).toBe('model-d');
    expect(registry.status().lastError).toBeNull();
  });

  it('DB 异常细节（连接串、SQL、密钥）不进入错误消息与状态', async () => {
    const sentinel = 'sentinel-secret-value';
    const leaky = `connect ECONNREFUSED password=${sentinel} SELECT * FROM ts_model_provider`;

    const coldStore: ModelRegistryStore = {
      async readConfigSnapshot() {
        throw new Error(leaky);
      },
      async readRefreshEpoch() {
        throw new Error(leaky);
      },
    };
    const coldRegistry = createModelRegistry({ store: coldStore, clock: controlledClock().clock });
    const coldError = await coldRegistry.resolveBinding('codegen.default').catch((caught: unknown) => caught);
    expect(coldError).toBeInstanceOf(BusinessError);
    expect((coldError as BusinessError).message).not.toContain(sentinel);
    expect((coldError as BusinessError).message).not.toContain('SELECT');

    const { state, store } = fakeStore(snapshot('1', '0', 'model-a'));
    const time = controlledClock();
    const registry = createModelRegistry({ store, clock: time.clock });
    await registry.resolveBinding('codegen.default');

    state.epochError = new Error(leaky);
    state.snapshotError = new Error(leaky);
    time.advance(modelRegistryTtlMs);
    await registry.resolveBinding('codegen.default');

    expect(registry.status().lastError).not.toContain(sentinel);
    expect(registry.status().lastError).not.toContain('SELECT');
    expect(registry.status().lastError).toBe('模型配置读取失败');
  });

  it('真正空库且版本为零时，按环境变量建立模型', async () => {
    process.env.AI_MODEL = 'env-model';
    const { store } = fakeStore(emptySnapshot('0', '0'));
    const registry = createModelRegistry({ store, clock: controlledClock().clock });

    const binding = await registry.resolveBinding('codegen.default');
    expect(binding.modelName).toBe('env-model');
    expect(binding.providerId).toBe('env-default');
    expect(registry.status().source).toBe('environment');
  });

  it('空库但版本非零视为状态不一致，不按环境变量兜底', async () => {
    process.env.AI_MODEL = 'env-model';
    const { store } = fakeStore(emptySnapshot('3', '0'));
    const registry = createModelRegistry({ store, clock: controlledClock().clock });

    await expect(registry.resolveBinding('codegen.default')).rejects.toMatchObject({ status: 503, code: 50300 });
  });

  it('请求未配置或未启用的别名返回 503', async () => {
    const { store } = fakeStore(snapshot('1', '0', 'model-a'));
    const registry = createModelRegistry({ store, clock: controlledClock().clock });

    await expect(registry.resolveBinding('codegen.extra')).rejects.toMatchObject({ status: 503, code: 50300 });
  });

  it('modelFor 使用的 resolveModel 返回冻结的 LanguageModel', async () => {
    const { store } = fakeStore(snapshot('1', '0', 'model-a'));
    const registry = createModelRegistry({ store, clock: controlledClock().clock });

    const model = await registry.resolveModel('codegen.default');
    const binding = await registry.resolveBinding('codegen.default');
    expect(model).toBe(binding.model);
    expect(Object.isFrozen(model)).toBe(true);
  });
});
