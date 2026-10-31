import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable';
import { openQuestion } from '../control-store';
import { effectBindingOf, effectSnapshot } from '../durable/effect-gate';

/**
 * 提问：本轮还没改过源码时，把问题登记到控制面并结束这一轮，等用户回答后从草稿继续。
 * `control.terminate` 让这一轮不再请求模型或继续调工具；`executionMode: "sequential"` 与
 * `callers: ["model"]` 保证它不会被并行调用、也不允许被其他工具嵌套调用。
 * 它自己不记 dirty：ask 不是源码修改。
 */
export function createAskTool(recordToolEvent: (event: string, name: string, detail: Record<string, unknown>) => void): ToolRegistration {
	return defineTool({
		name: "ask",
		description: "本轮还没有修改任何源码时，向用户提一个必须由用户决定的问题，并结束本轮；用户回答后会基于当前草稿继续。只在缺少关键信息、无法合理假设时使用，同一轮最多一次，提问后不能再改源码。",
		parameters: Type.Object({ question: Type.String({ minLength: 3, maxLength: 500 }) }),
		replay: "unsafe",
		executionMode: "sequential",
		callers: ["model"],
		execute: async (args, api) => {
			const binding = effectBindingOf(api.conversationId);
			if (!binding) throw new Error("当前会话没有绑定执行（legacy 会话不能提问）");
			if (effectSnapshot(binding).dirty) throw new Error("本轮已经修改过源码，不能再提问");
			const question = await openQuestion({ appId: binding.appId, generationId: binding.generationId, prompt: args.question });
			recordToolEvent("end", "ask", { conversationId: api.conversationId, appId: binding.appId, generationId: binding.generationId, questionId: question.id });
			return {
				output: [{ type: "text", text: "问题已记录，本轮结束，等待用户回答后继续" }],
				details: { questionId: question.id, prompt: question.prompt, generationId: question.generationId },
				control: { terminate: true },
			};
		},
	});
}
