import { randomUUID } from 'node:crypto'
import type { SessionStore } from '../session/store.js'

export type ApprovalDecision = 'allowed' | 'rejected'

export interface ApprovalRequest {
  appId: string
  userId: string
  turnId: string
  action: 'start_generation'
  approvalId?: string
}

export interface ApprovalDecisionRequest {
  appId: string
  userId: string
  turnId: string
  approvalId: string
  decision: ApprovalDecision
  source: 'human' | 'model' | 'system'
}

export interface ApprovalCheck {
  appId: string
  approvalId: string
}

export interface ApprovalConsumeRequest extends ApprovalCheck {
  userId: string
  turnId: string
}

export interface ApprovalService {
  request(input: ApprovalRequest): Promise<{ approvalId: string }>
  decide(input: ApprovalDecisionRequest): Promise<void>
  assertHumanApproved(input: ApprovalCheck): Promise<{ ok: true } | { ok: false; reason: string }>
  consume(input: ApprovalConsumeRequest): Promise<void>
}

export function createApprovalService(store: SessionStore): ApprovalService {
  return {
    async request(input) {
      const approvalId = input.approvalId ?? `ap-${randomUUID()}`
      await store.appendBatch({
        appId: input.appId,
        userId: input.userId,
        turnId: input.turnId,
        batchSeq: 1,
        events: [{
          kind: 'approval/asked',
          source: 'system',
          payload: { approvalId, action: input.action, turnId: input.turnId },
        }],
      })
      return { approvalId }
    },

    async decide(input) {
      if (input.source !== 'human') throw new Error('审批裁决必须来自人类')
      await store.appendBatch({
        appId: input.appId,
        userId: input.userId,
        turnId: input.turnId,
        batchSeq: 1,
        events: [{
          kind: 'approval/decided',
          source: 'human',
          payload: { approvalId: input.approvalId, decision: input.decision },
        }],
      })
    },

    async assertHumanApproved(input) {
      return store.assertHumanApproved(input)
    },

    async consume(input) {
      const result = await store.assertHumanApproved(input)
      if (!result.ok) throw new Error(`审批不可消费: ${result.reason}`)
      await store.appendBatch({
        appId: input.appId,
        userId: input.userId,
        turnId: input.turnId,
        batchSeq: 1,
        events: [{
          kind: 'approval/consumed',
          source: 'system',
          payload: { approvalId: input.approvalId },
        }],
      })
    },
  }
}
