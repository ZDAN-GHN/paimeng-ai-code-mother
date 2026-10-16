import { isProjectCodeGenType, type AppInfo, type CodeGenType } from '@/shared/contracts';
import type { TemplateIdentity } from '@/shared/templates';
import { BUILD_DEPENDENCIES, REACT_DEPENDENCIES } from './build-contract';

const staticProhibitions = '禁止写 package.json、vite.config.*、tsconfig*.json，禁止使用 Vue/React/JSX/TS 源文件、npm 依赖或任何构建工具。平台直接静态托管，没有构建步骤。';

export const typeRules: Record<CodeGenType, string> = {
  html: `只写 index.html，样式放 <style>、脚本放 <script>，素材放 assets/ 并用相对路径引用。${staticProhibitions}`,
  multi_file: `入口为 index.html，样式放 css/、脚本放 js/、素材放 assets/，全部用相对路径引用。${staticProhibitions}`,
  vue_project: `Vue 工程必须使用 Vue、Vite，base './'，必须包含 package.json、index.html、vite.config.js 和 src/main.js。package.json 必须包含 Vue、Vite 和 Vue 插件，依赖只允许以下精确版本，禁止 ^、~、latest ${JSON.stringify(BUILD_DEPENDENCIES)}。`,
  react_project: `React 工程必须使用 React、React DOM、Vite 和 React 插件，base './'，必须包含 package.json、index.html、vite.config.js 和 src/main.jsx。package.json 必须包含这些插件与 React 类型包，依赖只允许以下精确版本，禁止 ^、~、latest ${JSON.stringify(REACT_DEPENDENCIES)}。`,
};

export function staticPathHint(type: CodeGenType) {
  if (type === 'html') return '原生 HTML 只写 index.html（内联样式与脚本），素材放 assets/，禁止工程脚手架与构建工具。';
  if (type === 'multi_file') return '原生多文件使用 index.html、css/、js/ 与 assets/，禁止工程脚手架与构建工具。';
  return 'Vue 或 React 工程使用对应框架与 Vite，并保留模板入口。';
}

export function generationInstructions({ app, template, entry, webInstruction, hasImages = false }: {
  app: Pick<AppInfo, 'codeGenType' | 'initPrompt'>;
  template: TemplateIdentity | null | undefined;
  entry: string | null;
  webInstruction: string;
  hasImages?: boolean;
}): string {
  const project = isProjectCodeGenType(app.codeGenType);
  let opening = '';
  if (template) {
    opening = project
      ? `当前工程已从 ${template.id}@${template.version} 模板初始化。先使用 listFiles，再 readFile 阅读 AGENTS.md、package.json、入口 ${entry} 及与需求相关的源码，然后在现有工程上实现用户需求。保留 TypeScript 入口 ${entry} 和 vite.config.ts，不要另起一套 JS 工程。模板依赖和锁文件固定，可用库见 package.json，不要增删依赖。平台在隔离容器中检查类型并构建静态产物。`
      : `当前工程已从 ${template.id}@${template.version} 模板初始化，骨架可直接使用或改写。先使用 listFiles，再 readFile 阅读 AGENTS.md 与 index.html${app.codeGenType === 'multi_file' ? '、css/ 与 js/ 下的文件' : ''}，然后在现有文件上实现用户需求，保留 index.html 作为唯一入口，并优先复用骨架里的设计令牌与布局类。`;
  } else if (!project) {
    opening = 'HTML 与多文件应用必须有 index.html，只写静态文件，不要引入构建工具。';
  }
  const rules = project && template ? '' : typeRules[app.codeGenType];
  const preview = project
    ? '最终验证时服务端会自动构建前端工程并提供 dist/index.html 预览，无需调用 shell。'
    : '平台直接静态托管这个目录，写出的文件即刻可预览，无需构建、无需调用 shell。不要执行任何安装或构建命令。';
  // 有图片时补一句：图片已随消息提供可直接看图；工作区副本只在用户明确要求当素材时才引用。
  const imageInstruction = hasImages
    ? ' 本轮用户上传了图片，图片已随消息一起提供，你可以直接看图理解需求。工作区里的上传原图只有用户明确要求用作页面素材时才在页面里引用（用相对路径）；仅用于理解布局或风格的参考图不要写进网站。'
    : '';
  const milestone = project
    ? '构建前用户看不到任何页面，所以不要等全部写完才交付：完成第一个可运行的版本（入口页 + 主要数据与交互，且不再引用尚未创建的文件）后立刻调用一次 buildPreview，让用户先看到页面，之后每完成一个明显功能再调用一次。构建失败时先按返回的诊断修好再继续，不要把失败留到最后。'
    : '写完第一个完整页面后调用一次 buildPreview 校验并刷新预览，之后每完成一个明显功能再调用一次；失败先按诊断修好再继续。';
  return `你是应用生成 Agent。当前应用类型 ${app.codeGenType}。所有读写必须使用工具，禁止仅输出代码而不写入文件。只能修改当前应用。禁止写密钥或 .env。${opening}${rules}${webInstruction} 禁止安装脚本和任意 shell。工具返回错误时根据错误修正并重试。${milestone}${preview}${imageInstruction}完成后简短说明改动。初始化需求 ${app.initPrompt}`;
}
