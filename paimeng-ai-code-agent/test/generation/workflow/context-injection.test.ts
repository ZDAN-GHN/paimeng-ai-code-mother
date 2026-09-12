import { describe, expect, it } from 'vitest'
import { createScriptedLlm } from '../../../src/llm/index.js'
import { runGenerationWorkflow } from '../../../src/generation/workflow/index.js'
import { makePassingReviewGates, makeWorkspaceRoot } from '../../helpers.js'

describe('codegen system context injection (#23)', () => {
  it('injects the server-side five-dimension conclusion and bounded planning artifact', async () => {
    const provider = createScriptedLlm('success')
    const workspaceRoot = makeWorkspaceRoot()
    const sessionConclusion = {
      message: '宠物店官网',
      audience: '小微商家',
      style: '温暖活泼',
      pages: ['首页', '商品页'],
      data: '图文 + 商品列表',
      interaction: '商品浏览与咨询表单',
    }
    const planningArtifact = {
      pages: ['首页', '商品页'],
      siteMap: [
        { page: '首页', anchor: 'page-0', linksTo: ['商品页'] },
        { page: '商品页', anchor: 'page-1', linksTo: ['首页'] },
      ],
      pageSummaries: [
        { page: '首页', blocks: ['顶部导航栏', '主视觉 Banner', '三列内容卡片', '页脚'] },
        { page: '商品页', blocks: ['顶部导航栏', '主视觉 Banner', '三列内容卡片', '页脚'] },
      ],
    }

    for await (const _event of runGenerationWorkflow(
      { runId: 'run-context-injection', appId: 1, message: '开始生成', workspacePath: workspaceRoot },
      {
        workspaceRoot,
        provider,
        reviewGates: makePassingReviewGates(),
        sessionConclusion,
        planningArtifact,
        wireframePath: '/workspace/wireframe/wireframe.html',
        wireframeRelativePath: 'wireframe/wireframe.html',
      },
    )) {
      // Consume the complete stream so the provider records the real model request.
    }

    const codegenCall = provider.records.find((record) => record.modelId === 'scripted-standard')
    expect(codegenCall?.system).toContain('宠物店官网')
    expect(codegenCall?.system).toContain('小微商家')
    expect(codegenCall?.system).toContain('商品页')
    expect(codegenCall?.system).toContain('page-0')
    expect(codegenCall?.system).toContain('三列内容卡片')
    expect(codegenCall?.system).toContain('wireframe/wireframe.html')
  })
})
