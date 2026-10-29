import "server-only";
import type { JsonValue } from "@earendil-works/chord";
import { defineDoc, type ConversationDocToken } from "@earendil-works/pi-durable";
import { z } from "zod";
import { activeExecution, assertAuthority, openQuestionOf, type ExecutionRecord } from "../control-store";
import type { ExecutionStatus } from "../schema";

/**
 * 实际 effect 门（docs/plans/archive/harness-reliability.md §4）：harness 的工具读写在落盘前先确认「本次执行」还允许它。
 *
 * 门禁只读控制面事实，不复制控制面逻辑：执行是否还是那条未收束的执行、应用写权限是否仍由
 * 同一次执行的 epoch 持有，全部问 control-store。这里只做三件控制面没有的事：
 *
 * 1. 把 conversationId 映射到产品给的 (generationId, executionId) 绑定；
 * 2. 把「读」和「写」分开：交接中（draining）仍可读，写一律停止；
 * 3. 记住本次执行有没有改过源码（dirty），给后续 ask/草稿交接用。
 *
 * 未绑定 executionId 的旧会话按 legacy 处理：不查库、不拦截，行为和接入门禁之前完全一样。
 */

/** 一次执行级的准入结果缓存：读工具每秒最多查一次库，写工具每次调用都重查。 */
const CACHE_TTL_MS = 1_000;

export type EffectTarget = {
	readonly conversationId: number;
	readonly appId: string;
	readonly generationId: string;
	readonly executionId: string;
};

/** `null`/`undefined` 都表示 legacy：这条会话没有执行绑定，门禁不启用。 */
export type EffectBinding = EffectTarget | null | undefined;

export type EffectAdmission = { readonly legacy: boolean };

export type EffectSnapshot = {
	readonly legacy: boolean;
	readonly generationId: string | null;
	readonly executionId: string | null;
	/** 本次执行是否已有源码修改；重启后无法确定时保守为 true。 */
	readonly dirty: boolean;
	/** 最近一次真的问过数据库的时间（毫秒），从未查询过为 null。 */
	readonly checkedAt: number | null;
};

/** 门禁拒绝：工具调用必须当作失败交回模型，不允许静默成功。 */
export class EffectGateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EffectGateError";
	}
}

type Admission =
	| { readonly ok: true; readonly status: ExecutionStatus; readonly epoch: number }
	| { readonly ok: false; readonly reason: string };

const registry = new Map<number, EffectTarget>();
/** conversationId → 是否已改过源码；没有条目表示「本进程不知道」，按已修改处理。 */
const dirtyState = new Map<number, boolean>();
const admissions = new Map<number, { readonly at: number; readonly executionId: string; readonly admission: Admission }>();
/** conversationId → 最近一次真的问过数据库的时间（通过或拒绝都算），只用于诊断。 */
const lastChecked = new Map<number, number>();

/**
 * 会话文档里的执行绑定。绑定随会话一起持久化，harness 重启后还能知道这条会话属于哪次执行；
 * 文档很小，每次都存完整 base。
 */
export const effectBindingDoc: ConversationDocToken<{ binding?: JsonValue }> = defineDoc({
	kind: "app.effect-binding",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: (): { binding?: JsonValue } => ({}),
	checkpointWhen: () => true,
});

const storedBindingSchema = z.strictObject({
	appId: z.string().min(1),
	generationId: z.string().min(1),
	executionId: z.string().min(1),
});

function requiredText(value: unknown, label: string): string {
	const text = typeof value === "string" ? value.trim() : "";
	if (!text) throw new EffectGateError(`执行绑定缺少 ${label}`);
	return text;
}

function requiredConversation(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new EffectGateError("执行绑定缺少合法的 conversationId");
	return value;
}

function normalize(input: { conversationId: number; appId: string; generationId: string; executionId: string }): EffectTarget {
	return {
		conversationId: requiredConversation(input.conversationId),
		appId: requiredText(input.appId, "appId"),
		generationId: requiredText(input.generationId, "generationId"),
		executionId: requiredText(input.executionId, "executionId"),
	};
}

function record(target: EffectTarget, dirty: boolean): EffectTarget {
	registry.set(target.conversationId, target);
	dirtyState.set(target.conversationId, dirty);
	admissions.delete(target.conversationId);
	lastChecked.delete(target.conversationId);
	return target;
}

/** 新执行的绑定：本进程第一次见到这次执行，视为还没改过源码。 */
export function bindEffect(input: { conversationId: number; appId: string; generationId: string; executionId: string }): EffectTarget {
	return record(normalize(input), false);
}

/**
 * 从会话文档恢复绑定（重启、或会话第一次在本进程里被读到）。
 * 内存里的 dirty 已经丢了，而重启前可能刚好改过源码，所以保守记成已修改。
 */
export function restoreEffectBinding(input: { conversationId: number; appId: string; generationId: string; executionId: string }): EffectTarget {
	return record(normalize(input), true);
}

export function effectBindingOf(conversationId: number): EffectTarget | undefined {
	return registry.get(conversationId);
}

/** 本进程已知的全部执行绑定，给 `/inspection` 用。 */
export function effectTargets(): readonly EffectTarget[] {
	return [...registry.values()];
}

/** 会话文档 → 绑定；缺字段或不是对象都当 legacy，不抛错（旧会话没有这条文档）。 */
export function effectTargetFrom(conversationId: number, state: Readonly<{ binding?: JsonValue }> | undefined): EffectTarget | null {
	const parsed = storedBindingSchema.safeParse(state?.binding);
	if (!parsed.success) return null;
	return { conversationId, ...parsed.data };
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * 未收束的执行（preparing/active/draining）就是「本次执行还在」。sealed/failed 之后
 * activeExecution 查不到它，读和写一起关闭：源码已经交给封存流程，不能再被读写。
 */
async function query(target: EffectTarget): Promise<Admission> {
	let execution: ExecutionRecord | null;
	try {
		execution = await activeExecution(target.appId);
	} catch (error) {
		return { ok: false, reason: `查询执行状态失败：${describe(error)}` };
	}
	if (!execution) return { ok: false, reason: "执行已结束" };
	if (execution.id !== target.executionId) return { ok: false, reason: "该会话的执行已结束" };
	if (execution.generationId !== target.generationId) return { ok: false, reason: "执行与 generation 不匹配" };
	return { ok: true, status: execution.status, epoch: execution.epoch };
}

/** `fresh` 只给写路径用：写前重查一次，关闸后不用等缓存过期。拒绝结果不进缓存，下次照样重查。 */
async function check(target: EffectTarget, fresh: boolean): Promise<Admission> {
	const cached = admissions.get(target.conversationId);
	if (!fresh && cached && cached.executionId === target.executionId && Date.now() - cached.at < CACHE_TTL_MS) return cached.admission;
	const admission = await query(target);
	const at = Date.now();
	lastChecked.set(target.conversationId, at);
	if (admission.ok) admissions.set(target.conversationId, { at, executionId: target.executionId, admission });
	else admissions.delete(target.conversationId);
	return admission;
}

/**
 * 只读工具的准入：执行还在（preparing/active/draining）就放行。
 * 执行已封存/失败后源码不再可读——那一份内容已经交给封存流程，读到的可能是被清理中的目录。
 */
export async function assertReadable(binding: EffectBinding): Promise<EffectAdmission> {
	const target = binding ?? null;
	if (!target) return { legacy: true };
	const admission = await check(target, false);
	if (!admission.ok) throw new EffectGateError(`本轮执行已结束，不能读取源码（${admission.reason}）。不要重试，直接结束本轮。`);
	return { legacy: false };
}

/**
 * 写工具的准入：执行必须仍是 active，本次执行持有的 epoch 还是应用写权限的持有者，
 * 并且应用没有等待回答的提问（ask 之后本轮不能再写源码，直到用户回答开启新一轮）。
 * 写前重查（不用缓存），所以关闸、撤销 epoch、换主人、用户提问之后的下一次写立刻被拒。
 */
export async function assertWritable(binding: EffectBinding): Promise<EffectAdmission> {
	const target = binding ?? null;
	if (!target) return { legacy: true };
	const admission = await check(target, true);
	if (!admission.ok) throw new EffectGateError(`本轮已停止写入（${admission.reason}）。这次调用已拒绝，不要重试。`);
	if (admission.status !== "active") throw new EffectGateError(`本轮已停止写入（执行状态为 ${admission.status}）。这次调用已拒绝，不要重试。`);
	try {
		await assertAuthority({ appId: target.appId, epoch: admission.epoch });
	} catch (error) {
		throw new EffectGateError(`本轮已停止写入（应用写权限已失效：${describe(error)}）。这次调用已拒绝，不要重试。`);
	}
	// ask 之后本轮只等回答：先查提问再看写权限，顺序与「提问即停写」的语义一致。
	let question: Awaited<ReturnType<typeof openQuestionOf>>;
	try {
		question = await openQuestionOf(target.appId);
	} catch (error) {
		throw new EffectGateError(`本轮已停止写入（查询提问状态失败：${describe(error)}）。这次调用已拒绝，不要重试。`);
	}
	if (question) throw new EffectGateError("正在等待用户回答，本轮不能继续写源码。这次调用已拒绝，不要重试。");
	return { legacy: false };
}

/** 记一次源码修改。写工具执行成功后才调用，legacy 会话没有可记的执行。 */
export function markDirty(binding: EffectBinding): EffectAdmission {
	const target = binding ?? null;
	if (!target) return { legacy: true };
	dirtyState.set(target.conversationId, true);
	return { legacy: false };
}

export function effectSnapshot(binding: EffectBinding): EffectSnapshot {
	const target = binding ?? null;
	if (!target) return { legacy: true, generationId: null, executionId: null, dirty: false, checkedAt: null };
	return {
		legacy: false,
		generationId: target.generationId,
		executionId: target.executionId,
		dirty: dirtyState.get(target.conversationId) ?? true,
		checkedAt: lastChecked.get(target.conversationId) ?? null,
	};
}
