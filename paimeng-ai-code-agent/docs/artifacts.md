# 产物、构建与预览限制

## 文件工作目录

生成模型的文件工具在 `src/server/generation/tools/file-tools.ts` 用 `@earendil-works/pi-durable/tools` 的 `createCodingTools()` 取 `read`、`write`、`edit`，由 harness 注册。`read` 支持 offset/limit，使用内置的 2000 行 / 50KB 双限截断；`write` 和 `edit` 使用内置文件写入队列。`write` 一次写一个 `{ path, content }`，`edit` 使用 `{ path, edits: [{ oldText, newText }] }`。`listFiles`、`buildPreview`、`git`、`ask` 与四个联网工具的定义在 `src/server/generation/tools/`，同样由 harness 注册。

应用目录固定为 `runtime/code_output/{codeGenType}_{appId}/`，类型限于 `html`、`multi_file`、`vue_project` 和 `react_project`。应用 ID 与工具 cwd 由服务端绑定；文件工具入口拒绝绝对路径和 `..`。未注册 `bash`：工具在宿主机应用工作区运行，开放 shell 等于允许以宿主用户身份执行任意命令。

`src/server/workspace/workspace.ts` 仍服务附件、源码导出和构建。它的写入辅助函数限制单文件 256 KiB、总计 16 MiB、最多 256 个文件，并使用临时文件与重命名；路径校验拒绝敏感文件、符号链接和特殊文件。这些辅助函数的限制不包装生成模型的原生工具，构建与导出仍通过它们检查源码。

应用生成、源码工具、构建、下载、发布与删除使用数据库中的应用写入锁及任务租约。旧任务失去租约后不能继续写入。文件安全假设运行目录不被另一个具有宿主文件权限的进程恶意修改。它不是用于抵御已获得宿主账号权限的攻击者的隔离机制。

## 静态模板与预览

HTML 与多文件类型没有构建步骤，源码目录直接静态托管。新建应用分别初始化 `html@1.0.0` 与 `multi-file@1.0.0`，包含可改写骨架和 `AGENTS.md`。骨架的 `index.html` 未改动时不显示预览，避免将初始化骨架当作已生成内容。

写入时不再检查产品形状，`project-shape.ts` 及其工具层、源码扫描调用已删除。静态类型的 `buildApp` 检查 `index.html` 存在且包含有效 HTML，不因目录里有工程脚手架而拒绝。生成指令仍要求静态应用使用 HTML/CSS/JS；需要框架时应选择 React/Vue 模板。

## Vue 构建依赖

`BUILD_DEPENDENCIES` 在 `src/server/delivery/build-contract.ts` 中固定允许依赖和版本。生成工程只能使用以下版本。

- `vue` 使用 `3.5.17`。
- `vite` 使用 `7.0.0`。
- `@vitejs/plugin-vue` 使用 `6.0.0`。
- `vue-router` 使用 `4.5.1`。
- `pinia` 使用 `3.0.3`。
- `axios` 使用 `1.11.0`。
- `ant-design-vue` 使用 `4.2.6`。
- `typescript` 使用 `5.9.3`。
- `vue-tsc` 使用 `2.2.10`。
- `@types/node` 使用 `22.15.32`。

Vue、Vite 和 Vue 插件必需。React 工程使用另一套允许依赖（`react`、`react-dom`、`vite`、`@vitejs/plugin-react` 必需，另含 `react-router-dom`、`axios`、`antd`、`typescript`、`@types/react`、`@types/react-dom`、`@types/node`），外部 tarball、Git 依赖、文件依赖、版本范围及其他依赖均拒绝。顶层版本固定，传递依赖由 npm 解析。工程模板自带 `package-lock.json`，模板应用的依赖集合必须与模板版本完全一致且锁文件逐字节相同；旧的无模板 Vue 工程没有可复现依赖锁或离线依赖缓存。

## 两阶段容器构建

依赖安装阶段只能看到服务端重建的 `package.json`。该文件只包含批准的依赖，不包含生成的生命周期脚本、npm 配置或可执行源码。模板工程使用模板原版 `package.json` 与 `package-lock.json` 执行 `npm ci --ignore-scripts`，其余工程执行 `npm install --ignore-scripts`。安装阶段使用的 registry 由 `BUILD_NPM_REGISTRY` 决定（默认官方源，国内网络可改成镜像；锁文件带 `integrity`，镜像无法改变装出来的产物内容）。

安装完成后，服务端复制已校验的源码，忽略源工程的 `package.json` 和 `package-lock.json`。第二个容器使用 `--network=none`，模板工程先执行模板定义的检查命令（Vue 为 `vue-tsc --noEmit`，React 为 `tsc --noEmit`），再统一直接执行 Vite CLI。生成的 Vite 配置在这个断网容器中运行。生成工程的 `npm run build` 脚本不执行。

两个阶段都使用非 root 用户、只读根文件系统、全部移除的 Linux capabilities、`no-new-privileges`、128 个进程上限、768 MiB 内存上限、一个 CPU，以及 256 MiB 的临时文件系统。每阶段最长 `BUILD_TIMEOUT_MS`（默认 180 秒）。容器只挂载独立临时构建目录，不挂载平台源码、数据库文件、Docker socket 或 `.env`。平台数据库和模型环境变量不传入容器。

构建因任务失效、租约丢失或构建超时而停止时会终止命令并清理容器和临时目录；客户端断开不会中止构建。超时与命令失败会带可读原因返回给客户端（超时 `504/50400`，命令非零退出 `500/50001`），完整容器输出只写服务端日志。Docker 守护进程由平台宿主访问，生成代码无法访问其 socket。该边界仍依赖宿主 Docker 和内核安全，不代表无漏洞的通用多租户沙箱。

HTML 和多文件类型不执行容器构建。它们必须提供包含 HTML 标签的 `index.html`，浏览器脚本只在隔离预览来源执行。

## 构建与发布产物

Vue 构建输出必须包含普通文件 `dist/index.html`。输出复制拒绝符号链接及敏感路径，限制单文件 20 MiB、总计 64 MiB、最多 1024 个文件。构建成功后通过临时目录替换当前 `dist/`，失败不替换已存在的成功产物。依赖版本核对与模板锁文件比较在 source 阶段执行；依赖声明或锁文件被误改时，以可修复源码诊断返回模型。`buildPreview` 将失败诊断作为工具结果交回当前轮，模型恢复模板内容后可再次构建；最终验证仍独立执行。

首次发布生成 UUID，重复发布复用应用已有 `deployKey`，包括旧 Java 的六位字母数字发布键。先校验并复制到临时目录，再替换 `runtime/deploy/{deployKey}/`；替换失败恢复旧目录，原链接在发布成功后访问新版内容。最新生成失败或取消不隐藏仍有效的既有预览。Vue 每次发布都在应用写锁内执行受限构建，确保部署当前源码；构建失败则拒绝此次发布并保留旧产物。

ZIP 下载包含经过路径校验的真实源文件，不包含 `dist/`、`node_modules/` 或环境文件。文件名使用应用 ID。下载及发布仅允许创建者，管理员不能代替其他用户执行这两项操作。

## 独立预览服务

`src/server/delivery/preview.ts` 创建 HTTP 服务，`scripts/dev/preview.ts` 负责在配置的回环地址启动它。该服务不提供管理 API，也不授予管理端 Cookie 或跨域凭据权限。

- `/preview/{类型}_{ID}/` 提供生成源码或 Vue 的 `dist/`。
- `/deploy/{deployKey}/` 提供已发布副本。
- `/covers/{deployKey}.png` 提供本地封面。

服务仅接受 GET 和 HEAD，以及配置的 Host。它拒绝路径遍历、符号链接、隐藏文件和特殊文件。无扩展名路径可以使用 SPA 回退。响应包含 MIME 限制、`no-store` 和内容安全策略，约束连接、工作线程、表单、对象与父级嵌入来源。

预览使用不同主机名，以隔离管理端 Cookie。iframe 的可视化编辑消息同时验证来源和发送窗口。预览桥接只接受指定的编辑命令，点击切换单个元素的选中状态（最多同时选中 5 个），每次把整份选中列表的快照（选择器、标签、ID、class、文本及页面路径）发给管理端；父页面逐个展示、可单独移除，并在修改请求（普通发送或插话）中一起发送定位上下文。

预览和发布内容在本地服务中是公开可读的。来源隔离不等于私人文件授权。当前本地 HTTP 模式不适合直接对公网开放，公网运行需要另行设计 HTTPS、域名、资源访问控制和部署配置。

## 本地封面

`captureCover` 只接受有效发布键，不接受任意 URL。Chromium 启用浏览器沙箱，禁用 service worker，并拦截目标发布路径以外的请求。截图先写入临时 PNG，再重命名到 `runtime/covers/{deployKey}.png`。

截图失败不会撤销已经完成的发布，服务端记录失败并保留原封面。封面目前存储在本地，未配置 COS 上传，也未验证外部对象存储。
