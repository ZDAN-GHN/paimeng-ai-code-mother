import 'server-only';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { WebAccessError } from './types';

export type LookupAddress = { address: string; family: number };
export type Lookup = (hostname: string) => Promise<LookupAddress[]>;

/**
 * 永远拒绝的地址类别：环回、私网、链路本地、唯一本地、保留、运营商级 NAT，以及能嵌入 IPv4 的
 * IPv6 过渡地址。这些类别不能通过任何配置放行，否则地址校验形同虚设。
 * 注意：ipaddr.js 把 198.18.0.0/15 也归在 reserved 下，所以可放行网段必须先于本表判定。
 */
const alwaysBlockedRanges = new Set([
  'unspecified', 'broadcast', 'multicast', 'linkLocal', 'loopback', 'private', 'uniqueLocal',
  'reserved', 'carrierGradeNat', 'as112', 'amt', 'orchid2', 'rfc6145', 'rfc6052', '6to4', 'teredo',
]);

/**
 * 唯一允许部署者放行的网段：本机 TUN/Clash 式 fake-IP 使用的 198.18.0.0/15，以及文档示例网段。
 * 配置项必须完全落在其中之一，因此私网、环回、云元数据地址永远无法通过配置放行。
 */
const tunableCidrs = ['198.18.0.0/15', '192.0.2.0/24', '198.51.100.0/24', '203.0.113.0/24', '2001:2::/48', '2001:db8::/32'] as const;
const minimumPrefix: Record<'ipv4' | 'ipv6', number> = { ipv4: 8, ipv6: 16 };

export type ExtraNetwork = { source: string; network: ipaddr.IPv4 | ipaddr.IPv6; prefix: number };

function normalize(address: string): ipaddr.IPv4 | ipaddr.IPv6 {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    throw new WebAccessError('blocked-url', '目标地址无法识别，已拒绝');
  }
  return parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress() ? parsed.toIPv4Address() : parsed;
}

export function rangeOf(address: string) {
  return normalize(address).range();
}

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

export function matchesExtraNetwork(address: string, networks: readonly ExtraNetwork[]) {
  const parsed = normalize(address);
  return networks.some(entry => parsed.kind() === entry.network.kind() && parsed.match(entry.network, entry.prefix));
}

/** 单个地址是否可连：先看是否命中已放行网段，再拒绝危险类别；字面量地址永不放行。 */
export function assertAllowedAddress(address: string, options: { literal: boolean; networks: readonly ExtraNetwork[] }) {
  if (!options.literal && matchesExtraNetwork(address, options.networks)) return;
  const range = rangeOf(address);
  if (alwaysBlockedRanges.has(range)) throw new WebAccessError('blocked-url', '目标解析到内网或保留地址，已拒绝');
  if (range === 'unicast') return;
  throw new WebAccessError('blocked-url', '目标解析到非公网地址，已拒绝');
}

/**
 * 部署者在环境变量里配置的自建设施端点（如本机 SearXNG）：与 DURABLE_HARNESS_URL 同级的受信地址。
 * URL 不来自模型输入（模型只传 query），放宽它不扩大 SSRF 面。只允许 HTTPS 或字面量本机地址
 * （127.0.0.1/localhost/::1），本机地址允许任意端口；HTTPS 域名保持默认端口限制。
 */
export function trustedFacilityTarget(url: URL): ResolvedTarget {
  const localLiteral = isIP(url.hostname) !== 0 || url.hostname === 'localhost';
  if (url.protocol === 'https:') {
    if (url.port && url.port !== '443') throw new WebAccessError('unsupported', '自建设施端点只允许默认端口');
  } else if (url.protocol === 'http:') {
    if (!localLiteral) throw new WebAccessError('unsupported', '自建设施 HTTP 端点只允许本机地址');
  } else {
    throw new WebAccessError('unsupported', '自建设施端点只支持 HTTP(S)');
  }
  if (url.username || url.password) throw new WebAccessError('unsupported', '自建设施端点不允许携带凭据');
  if (url.hostname === 'localhost') return { url, addresses: [{ address: '127.0.0.1', family: 4 }] };
  if (isIP(url.hostname) !== 0) return { url, addresses: [{ address: url.hostname, family: isIP(url.hostname) as 4 | 6 }] };
  return { url, addresses: null };
}

/** 只接受无凭据的 HTTP(S) 地址；端口限制由各 target 分支按信任级别执行。 */
export function parseTarget(raw: string, label = '目标地址'): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebAccessError('unsupported', `${label}不是有效 URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new WebAccessError('unsupported', `${label}只支持 HTTP(S)`);
  if (url.username || url.password) throw new WebAccessError('unsupported', `${label}不允许携带凭据`);
  if (!url.hostname) throw new WebAccessError('unsupported', `${label}缺少主机名`);
  return url;
}

export type ResolvedTarget = { url: URL; addresses: LookupAddress[] | null };

/** 可信服务商端点：主机由部署配置固定，跳过本地地址校验，但仍要求无凭据 HTTPS。 */
export function trustedTarget(url: URL): ResolvedTarget {
  if (url.protocol !== 'https:') throw new WebAccessError('unsupported', '服务商端点必须是 HTTPS');
  if (url.port && url.port !== '443') throw new WebAccessError('unsupported', '服务商端点只允许默认端口');
  return { url, addresses: null };
}

/** 由可信代理代替本地解析：本地只拒绝字面量内网地址，其余交给代理在出口拦截。 */
export function delegatedTarget(url: URL): ResolvedTarget {
  if (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) throw new WebAccessError('unsupported', '请求地址只允许默认端口');
  if (isIP(url.hostname) !== 0) assertAllowedAddress(url.hostname, { literal: true, networks: [] });
  return { url, addresses: null };
}

export async function resolveTarget(url: URL, options: { lookup?: Lookup; networks: readonly ExtraNetwork[] }): Promise<ResolvedTarget> {
  if (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) throw new WebAccessError('unsupported', '请求地址只允许默认端口');
  if (isIP(url.hostname) !== 0) {
    assertAllowedAddress(url.hostname, { literal: true, networks: options.networks });
    return { url, addresses: [{ address: url.hostname, family: isIP(url.hostname) as 4 | 6 }] };
  }
  const lookup = options.lookup ?? (async (hostname: string) => dnsLookup(hostname, { all: true, verbatim: true }));
  let addresses: LookupAddress[];
  try {
    addresses = await lookup(url.hostname);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new WebAccessError('unavailable', code === 'ENOTFOUND' ? '目标主机无法解析' : '目标主机解析失败');
  }
  if (!addresses.length) throw new WebAccessError('unavailable', '目标主机无法解析');
  // 每个地址都必须合格：解析出多个地址时不能只赌其中一个是公网地址。
  for (const entry of addresses) assertAllowedAddress(entry.address, { literal: false, networks: options.networks });
  return { url, addresses };
}
