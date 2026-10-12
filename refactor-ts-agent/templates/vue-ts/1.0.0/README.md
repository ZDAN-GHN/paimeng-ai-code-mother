# Vue + TypeScript 应用

来自派蒙 `vue-ts@1.0.0` 模板。默认示例是一个可添加、完成、删除和筛选任务的清单，任务保存到浏览器 localStorage。

需要 Node.js 24。下载源码后在当前工程目录运行：

```sh
npm ci --ignore-scripts
npm run dev
```

`npm run type-check` 检查类型，`npm run build` 检查类型并生成 `dist/`，`npm run preview` 查看构建产物。

业务入口在 `src/App.vue`，组件在 `src/components/`，状态逻辑在 `src/composables/`，类型在 `src/types/`。这是纯前端应用，没有服务端 API、账号系统或数据库。

模板包含固定版本的 Vue、Vue Router、Pinia、Axios、Ant Design Vue 和构建工具。平台构建使用对应模板版本的依赖锁，第一版不支持增删依赖。可以修改页面、组件、样式和构建配置，平台仍会校验构建产物。
