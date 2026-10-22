# 版本历史与回退

每个应用的历史就是工作区里的 Git 仓库（`runtime/code_output/<type>_<appId>/.git`）。面板把 commit 渲染成树：当前版本、分支、合并关系都来自 Git 本身，不是另存的元数据。

用户核心诉求：**回退不新增版本**——回到旧版只是把当前指针切到那个提交，列表不多一行；要接着改，才先建分支再提交，原主线不动。

## Sub-features

- 树状历史：行=提交，连线=父子关系，颜色=所属分支（main 固定蓝）。
- 当前版本标记；detached 时明确显示「历史版本」而不是伪装成 main。
- 回到某版本：二次确认后按 commit SHA 提交，detached HEAD，**版本数不变**。
- 从此版本开分支 / 切换分支 / 采纳分支（祖先无操作、落后快进、真分叉三方合并）。
- 对比两版（改动文件 + 补丁）；版本截图来自该提交内容。
- 回退后预览真实重建，失败时明确说「画面没变」及原因。
- 生成占用应用时所有写操作禁用并说明原因。

## How to get to it (user POV)

1. 进入任意应用的对话页 `/app/chat/<appId>`。
2. 右侧（窄屏是下方抽屉）是版本面板：顶部时间线 + 分支列 + 每行操作。
3. 点某版本的「回到此版本」→ 二次确认 → 预览刷新。
4. 点两版之间的「对比」看差异；点「从此版本开分支」做实验。

## Driving it with Playwright

```bash
node .agents/skills/verify-paimeng-agent/helpers/verify.mjs tests/e2e/version-panel.spec.ts
```

- 现有 13 条用例覆盖：时间线与当前标记、截图与占位、detached 显示、树状渲染（无卡片组件、连线画满）、空态、二次确认、回退后 iframe `src` 换新地址、重建失败提示、忙态禁用、合并、差异、hydration 无错、读取失败重试。
- 面板的 API 在这个 spec 里是 `page.route` mock 的（`**/api/app/versions**`），因为要证明的是渲染与交互；**回退的 Git 语义**由集成用例证明（`tests/integration/version-store.test.ts`、`version-api.test.ts`）。要同时证明两者，就删掉对应 mock 让它打到真实接口，并断言 `git -C <workspace> for-each-ref` 不变。
- 真实 Git 断言（spec 之外）：`git -C runtime/code_output/html_<appId> rev-parse HEAD`、`for-each-ref refs/heads`、`rev-list --count --branches HEAD`。

## Gotchas

- 「版本号」是完整 commit SHA，界面上只显示前 7 位；断言时用短 SHA 或 `title` 属性。
- 回退后 `HEAD` 是 detached 的，`git rev-list --count HEAD` 只数到目标那一支——数历史要用 `--branches HEAD`，否则会以为历史丢了。
- 工作区有未提交源码改动时切版会**拒绝**（保护正在编辑的内容）；与目标树无关的未跟踪素材（`assets/` 之类）不阻塞。
- 版本截图只对静态页面（html / multi_file）有效；vue/react 提交里没有 `dist`，显示占位图，这是预期。
- 撤回/切版都不该产生新提交。如果列表多出一条，先看 `git log --format='%h %p %s'` 的双亲关系，再看 `refs/paimeng/versions/*` 保留引用。
- 采纳分支在当前位于实验分支时会只移动 main、不把你拽走——这是有意设计。
