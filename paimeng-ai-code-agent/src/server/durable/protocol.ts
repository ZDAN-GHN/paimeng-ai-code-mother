/**
 * 产品服务端与常驻 harness 之间的协议版本。
 *
 * 任何一侧改了 `/messages`、`/state`、`/submit` 的形状就 +1。原因：**常驻 harness 不热加载，而 Next 会热加载**
 * —— 只重启一半时，版本错位会表现成静默的产品故障（例如 `/messages` 少了助手条目 → 助手回复凭空消失）。
 * 引擎在第一次通话时校验 `/health` 里的版本，不一致就报可操作的消息。
 */
export const harnessProtocol = 2;
