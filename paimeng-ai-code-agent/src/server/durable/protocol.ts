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
 */
export const harnessProtocol = 10;
