import { createCodingTools } from '@earendil-works/pi-durable/tools';
import type { ToolRegistration } from '@earendil-works/pi-durable';

export const fileToolNames = new Set(["read", "write", "edit"]);

/** read/write 可安全重放；edit 匹配的旧文本在首次执行后会消失，不能重放。 */
export const fileTools: ToolRegistration[] = createCodingTools()
	.tools!.filter((tool) => fileToolNames.has(tool.name))
	.map((tool) => {
		const replay: "safe" | "unsafe" = tool.name === "edit" ? "unsafe" : "safe";
		return { ...tool, replay };
	});
