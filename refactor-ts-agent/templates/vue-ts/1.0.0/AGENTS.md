# 开发这个应用

这是已初始化的 Vue 3 + TypeScript + Vite 工程。先 listFiles，再 readFile 阅读本文件、package.json、src/App.vue 和与需求相关的文件，在现有工程上修改。

- 用 `<script setup lang="ts">` 编写 Vue 组件。入口为 `src/main.ts`，不要新建 `src/main.js` 或另一套 Vite 配置。
- 小型 UI 组件放 `src/components/`，状态逻辑放 `src/composables/`，共享类型放 `src/types/`。需要路由或状态库时使用已安装的 Vue Router、Pinia。
- 保留 `index.html` 的 `#app` 挂载点、TypeScript 入口和 `vite.config.ts` 的 `base: './'`，确保静态子路径可以访问资源。
- 示例业务可以按用户需求替换，不必保留任务清单。相关组件和类型一起修改，避免留下类型错误。
- package.json 的依赖与 package-lock.json 由模板版本固定。不要增删依赖、修改锁文件、写 .env 或密钥。禁止 shell、安装脚本和服务端代码。
- 平台保存后在隔离容器中执行 `vue-tsc --noEmit` 和 `vite build --base=./`，通过后才提供预览。无需调用构建命令。
- 用语义化 HTML、可访问的表单标签和按钮，支持键盘操作与窄屏显示。
