/**
 * harness 与 Next 之间的线上契约版本。
 *
 * 7：新增版本工具（listVersions / getVersion / restoreVersion / branchFromVersion / adoptBranch）；
 *    常驻 harness 不热加载，未重启的 harness 会缺这组工具，模型就发不出回退。
 * 8：回退语义从「新增一版」改为「指针移动」。旧 harness 仍会按追加语义执行，
 *    表现为用户点回退后时间线多一条记录；语义变更必须靠版本号挡住。
 * 9：版本包装工具退役，新增 git 工具（模型直接管理版本）；指令更新。
 *    旧 harness 仍暴露 restoreVersion 等包装工具且缺 git 工具。
 * 10：版本以 git 为唯一事实源——回退只切游离 HEAD 不产生提交，提交前先落到分支，
 *    生成收尾只在真有未提交改动时兜底。旧 harness 仍教模型「复制旧内容再提交」，
 *    会把一次回退记成新版本，必须重启换掉。
 * 11：git 工具收成只读，版本改由平台在收尾时提交并记账（docs/plans/archive/version-ledger.md）。
 *    旧 harness 仍会教模型 git add/commit，也会在建版分支上自作主张；必须重启换掉。
 * 12：生成改为每轮独立 execution/conversation，conversation 携带 generation/execution 绑定，
 *    工具写入受产品 authority 与持久输入状态约束（docs/plans/archive/harness-reliability.md 的 harness 可靠性重构）。
 *    旧 harness 会继续复用共享工作区、绕过写入门禁，必须与 Next 一起升级并重启。
 */
export const harnessProtocol = 12;
