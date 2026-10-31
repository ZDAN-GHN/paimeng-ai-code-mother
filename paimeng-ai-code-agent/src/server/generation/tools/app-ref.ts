import type { CodeGenType } from '@/shared/contracts';

export type AppRef = { id: string; codeGenType: CodeGenType };

export function appRefFromWorkspace(cwd: string | undefined): AppRef | undefined {
	const match = /(?:^|\/)(html|multi_file|vue_project|react_project)_([0-9]+)\/?$/.exec(cwd ?? "");
	if (!match) return undefined;
	const codeGenType = match[1];
	if (codeGenType !== "html" && codeGenType !== "multi_file" && codeGenType !== "vue_project" && codeGenType !== "react_project") return undefined;
	return { id: match[2]!, codeGenType };
}
