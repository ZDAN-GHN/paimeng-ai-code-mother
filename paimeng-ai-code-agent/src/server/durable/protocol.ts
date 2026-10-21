/**
 * harness 与 Next 之间的线上契约版本。
 *
 * 7：新增版本工具（listVersions / getVersion / restoreVersion / branchFromVersion / adoptBranch）；
 *    常驻 harness 不热加载，未重启的 harness 会缺这组工具，模型就发不出回退。
 * 8：回退语义从「新增一版」改为「指针移动」。旧 harness 仍会按追加语义执行，
 *    表现为用户点回退后时间线多一条记录；语义变更必须靠版本号挡住。
 */
export const harnessProtocol = 8;
