import { describe, expect, it } from 'vitest';
import { classifyBuildFailure, formatBuildFeedback, markBuildFailure, noProgressMessage, sourceFailure } from '@/server/build-feedback';

describe('构建失败分类：只有能定位到生成源码的失败才交给模型', () => {
  it('源码校验失败可修复，缺少文件与非法依赖都算', () => {
    expect(classifyBuildFailure(sourceFailure(new Error('生成结果缺少有效 HTML 页面')))).toMatchObject({ repairable: true, stage: 'source' });
    expect(classifyBuildFailure(sourceFailure('不允许的构建依赖 vue@9.9.9'))).toMatchObject({ repairable: true, stage: 'source' });
  });

  it('类型检查与打包失败可修复，错误消息保持不变', () => {
    const error = markBuildFailure(new Error('构建失败：src/App.vue(3,5): error TS2322'), { stage: 'typecheck', detail: '/work/src/App.vue(3,5): error TS2322' });
    expect(error.message).toBe('构建失败：src/App.vue(3,5): error TS2322');
    expect(classifyBuildFailure(error)).toMatchObject({ repairable: true, stage: 'typecheck' });
    expect(classifyBuildFailure(markBuildFailure(new Error('构建失败：vite'), { stage: 'build', detail: 'build failed' }))).toMatchObject({ repairable: true, stage: 'build' });
  });

  it('容器输出里的环境与资源特征会把可修复阶段降级', () => {
    for (const detail of ['Killed', 'JavaScript heap out of memory', 'npm error ENOSPC: no space left on device', 'read ECONNRESET', 'getaddrinfo ENOTFOUND registry.npmjs.org']) {
      expect(classifyBuildFailure(markBuildFailure(new Error('构建失败：vite'), { stage: 'build', detail }))).toMatchObject({ repairable: false, stage: 'build' });
    }
  });

  it('安装、模板锁与平台失败都不可修复', () => {
    expect(classifyBuildFailure(markBuildFailure(new Error('构建失败：npm'), { stage: 'install' }))).toMatchObject({ repairable: false, stage: 'install' });
    expect(classifyBuildFailure(markBuildFailure(new Error('模板依赖锁已改变'), { stage: 'template' }))).toMatchObject({ repairable: false, stage: 'template' });
    expect(classifyBuildFailure(markBuildFailure(new Error('产物目录过深'), { stage: 'platform' }))).toMatchObject({ repairable: false, stage: 'platform' });
  });

  it('没有阶段标记的失败一律不交给模型', () => {
    expect(classifyBuildFailure(new Error('旧构建目录不安全'))).toMatchObject({ repairable: false, stage: 'unknown' });
    expect(classifyBuildFailure(undefined)).toMatchObject({ repairable: false, stage: 'unknown' });
    expect(classifyBuildFailure('字符串失败')).toMatchObject({ repairable: false, stage: 'unknown' });
  });
});

describe('模型可读诊断', () => {
  it('保留阶段、原始错误与修复约束，并把容器路径归一化成工程相对路径', () => {
    const error = markBuildFailure(new Error('构建失败：src/App.vue(12,7): error TS2339'), { stage: 'typecheck', detail: '  3:1  error  /work/src/App.vue(12,7): error TS2339\n/work/src/main.ts(2,1): error TS2307' });
    const feedback = formatBuildFeedback(error, 1, 2);
    expect(feedback).toContain('验证未通过（第 1 次修复，共 2 次）。阶段：类型检查。');
    expect(feedback).toContain('错误摘要：构建失败：src/App.vue(12,7): error TS2339');
    expect(feedback).toContain('src/App.vue(12,7): error TS2339');
    expect(feedback).not.toContain('/work/');
    expect(feedback).toContain('main.ts(2,1)');
    expect(feedback).toContain('保留换行');
    expect(feedback).toContain('不要修改 package.json 依赖');
  });

  it('没有容器输出时只给摘要，不产生空的输出段', () => {
    const feedback = formatBuildFeedback(sourceFailure(new Error('生成结果缺少 index.html')), 2, 2);
    expect(feedback).toContain('阶段：源码校验');
    expect(feedback).not.toContain('最近构建输出');
  });

  it('超长输出留头留尾并标注省略量，末尾的失败原因不会丢', () => {
    const head = '第一行错误\n'.repeat(1000);
    const tail = '\nvite build 以退出码 1 结束';
    const feedback = formatBuildFeedback(markBuildFailure(new Error('构建失败：很长'), { stage: 'build', detail: head + tail }), 1, 2);
    const output = feedback.split('最近构建输出（保留换行；过长时省略中间）：\n')[1].split('\n请只修改')[0];
    expect(output.length).toBeLessThan(4200);
    expect(output).toContain('已省略');
    expect(output.startsWith('第一行错误')).toBe(true);
    expect(output.endsWith('vite build 以退出码 1 结束')).toBe(true);
  });

  it('无进展终止以原始构建错误为主错误', () => {
    expect(noProgressMessage(sourceFailure(new Error('生成结果缺少有效 HTML 页面')))).toBe('生成结果缺少有效 HTML 页面；本轮模型未修改任何文件，已停止继续修复');
  });
});
