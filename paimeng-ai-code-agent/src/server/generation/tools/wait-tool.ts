import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable';

/** 脚本桩工具：真实模型不提供 `m1_wait`，只有 faux 模式注册它。 */
export function createWaitTool(recordToolEvent: (event: string, name: string, detail: Record<string, unknown>) => void): ToolRegistration {
	return defineTool({
		name: "m1_wait",
		description: "Sleep for the given number of milliseconds, then return. Use it when the user asks to wait.",
		parameters: Type.Object({ ms: Type.Number() }),
		replay: "unsafe",
		execute: async (args) => {
			const ms = Math.max(0, Math.min(args.ms, 120_000));
			recordToolEvent("start", "m1_wait", { ms });
			await new Promise((done) => setTimeout(done, ms));
			recordToolEvent("end", "m1_wait", { ms });
			return { output: [{ type: "text", text: `waited ${ms}ms` }] };
		},
	});
}
