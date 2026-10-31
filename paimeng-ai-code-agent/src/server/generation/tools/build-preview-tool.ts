import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ConversationId, type ToolRegistration } from '@earendil-works/pi-durable';
import { buildApp, type BuildStageProgress } from '../../delivery/artifacts';
import { classifyBuildFailure, formatBuildDiagnostic } from '../../delivery/build-feedback';
import { projectAt } from '../../workspace/workspace';
import type { AppRef } from './app-ref';

type BuildStageName = "source" | "install" | "typecheck" | "build";

type BuildResult = {
	status: "ok" | "failed";
	milestone: string;
	ms: number;
	stages: { stage: BuildStageName; status: "ok" | "failed"; ms: number }[];
	stage?: string;
	repairable?: boolean;
	diagnostic?: string;
	note: string;
};

export function createBuildPreviewTool(deps: {
	appRefFor: (conversationId: ConversationId) => Promise<AppRef | undefined>;
	workspaceOf: (conversationId: ConversationId) => string | undefined;
}): ToolRegistration {
	return defineTool({
		name: "buildPreview",
		description: "提交一次阶段构建并刷新右侧预览：完成第一个可运行版本后调用一次，之后每完成一个明显功能再调用一次。失败时按返回的诊断修复后再次调用。这只刷新预览，不代表任务完成。",
		parameters: Type.Object({ milestone: Type.String() }),
		replay: "safe",
		execute: async (args, api, context) => {
			const app = await deps.appRefFor(api.conversationId);
			if (!app) throw new Error(`会话 ${api.conversationId} 没有关联应用，拒绝构建`);
			const startedAt = Date.now();
			const stages: BuildResult["stages"] = [];
			let progress: Promise<unknown> = Promise.resolve();
			const note: BuildStageProgress = (stage, status, ms) => {
				if (status !== "started") stages.push({ stage, status, ms });
				progress = progress.then(() => api.details({ stage, status, ms, at: Date.now() }, context)).catch(() => undefined);
			};
			try {
				const root = deps.workspaceOf(api.conversationId);
				await buildApp(root ? projectAt({ id: app.id, codeGenType: app.codeGenType }, root) : { id: app.id, codeGenType: app.codeGenType }, context.abortSignal, note);
				await progress;
				const at = Date.now();
				const result: BuildResult = { status: "ok", milestone: args.milestone, ms: at - startedAt, stages, note: "预览已更新为这次构建的产物。继续开发下一个功能，有明显增量时再调用一次。" };
				await api.details(result, context);
				return { output: [{ type: "text", text: `预览已更新（${args.milestone}），用时 ${at - startedAt}ms。` }], details: result };
			} catch (problem) {
				await progress;
				const verdict = classifyBuildFailure(problem);
				const diagnostic = formatBuildDiagnostic(problem);
				const result: BuildResult = {
					status: "failed",
					milestone: args.milestone,
					ms: Date.now() - startedAt,
					stages,
					stage: verdict.stage,
					repairable: verdict.repairable,
					diagnostic,
					note: "这次构建没有通过，右侧仍是上一次成功的预览。按诊断修改源码后再次调用 buildPreview；不要添加或改动既有依赖，只在诊断指出依赖声明或锁文件被误改时才把 package.json 与锁文件恢复成模板自带的内容。",
				};
				await api.details(result, context);
				return { output: [{ type: "text", text: diagnostic }], details: result };
			}
		},
	});
}
