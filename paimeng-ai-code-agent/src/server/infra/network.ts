import 'server-only';
import ipaddr from 'ipaddr.js';

/**
 * `WEB_ACCESS_ALLOW_NETWORKS` 的网段解析。配置层与联网工具实现共用，所以它属于最底层：
 * `infra/config` 不能反向依赖 `generation/tools/web`，否则配置与联网实现互相引用。
 * 这里只解析"部署者允许放行哪些网段"，地址分类与拒绝策略仍在联网实现里。
 */
export type ExtraNetwork = { source: string; network: ipaddr.IPv4 | ipaddr.IPv6; prefix: number };

/**
 * 唯一允许部署者放行的网段：本机 TUN/Clash 式 fake-IP 使用的 198.18.0.0/15，以及文档示例网段。
 * 配置项必须完全落在其中之一，因此私网、环回、云元数据地址永远无法通过配置放行。
 */
const tunableCidrs = ['198.18.0.0/15', '192.0.2.0/24', '198.51.100.0/24', '203.0.113.0/24', '2001:2::/48', '2001:db8::/32'] as const;
const minimumPrefix: Record<'ipv4' | 'ipv6', number> = { ipv4: 8, ipv6: 16 };

export function parseExtraNetwork(entry: string): ExtraNetwork {
  const isIpv4 = ipaddr.IPv4.isValidCIDR(entry);
  const isIpv6 = ipaddr.IPv6.isValidCIDR(entry);
  if (!isIpv4 && !isIpv6) throw new Error(`WEB_ACCESS_ALLOW_NETWORKS 条目不是有效网段：${entry}`);
  const [network, prefix] = isIpv4 ? ipaddr.IPv4.parseCIDR(entry) : ipaddr.IPv6.parseCIDR(entry);
  const kind = isIpv4 ? 'ipv4' : 'ipv6';
  if (prefix < minimumPrefix[kind]) throw new Error(`WEB_ACCESS_ALLOW_NETWORKS 不允许这么宽的网段：${entry}`);
  if (!isInsideTunable(entry, isIpv4)) throw new Error(`WEB_ACCESS_ALLOW_NETWORKS 只能放行本机 fake-IP 与文档示例网段：${entry}`);
  return { source: entry, network, prefix };
}

function isInsideTunable(entry: string, isIpv4: boolean): boolean {
  const [network, prefix] = isIpv4 ? ipaddr.IPv4.parseCIDR(entry) : ipaddr.IPv6.parseCIDR(entry);
  return tunableCidrs.some(candidate => {
    const candidateIsIpv4 = ipaddr.IPv4.isValidCIDR(candidate);
    if (candidateIsIpv4 !== isIpv4) return false;
    const [base, basePrefix] = candidateIsIpv4 ? ipaddr.IPv4.parseCIDR(candidate) : ipaddr.IPv6.parseCIDR(candidate);
    return prefix >= basePrefix && network.match(base, basePrefix);
  });
}

export function parseExtraNetworks(entries: readonly string[]): ExtraNetwork[] {
  return entries.map(parseExtraNetwork);
}
