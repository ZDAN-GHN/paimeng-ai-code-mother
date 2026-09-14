import { describe, expect, it } from 'vitest'
import { createScriptedLlm } from '../../../src/llm/index.js'
import { runGenerationWorkflow } from '../../../src/generation/workflow/index.js'
import { makePassingReviewGates, makeWorkspaceRoot } from '../../helpers.js'
import type { AgentEvent } from '../../../src/protocol/events.js'

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
    }

    const codegenCall = provider.records.find((record) => record.modelId === 'scripted-standard')
    expect(codegenCall?.system).toContain('宠物店官网')
    expect(codegenCall?.system).toContain('小微商家')
    expect(codegenCall?.system).toContain('商品页')
    expect(codegenCall?.system).toContain('page-0')
    expect(codegenCall?.system).toContain('三列内容卡片')
    expect(codegenCall?.system).toContain('wireframe/wireframe.html')
  })

  it('routes multi_file through its default build gate instead of the html gate', async () => {
    const provider = createScriptedLlm('success')
    const workspaceRoot = makeWorkspaceRoot()
    const events: AgentEvent[] = []

    for await (const event of runGenerationWorkflow(
      { runId: 'run-multi-file-default-gates', appId: 1, message: '生成多文件页面', workspacePath: workspaceRoot, codeGenType: 'multi_file' },
      { workspaceRoot, provider },
    )) {
      events.push(event)
    }

    expect(events.at(-1)).toMatchObject({ type: 'error' })
    expect(events.at(-1)).toMatchObject({ message: expect.stringContaining('至少需要 2 个项目文件') })
    expect(provider.records.some((record) => record.modelId === 'scripted-quality')).toBe(true)
  })
})
