import { describe, expect, it } from 'vitest';
import { assertAllowedAddress, delegatedTarget, parseExtraNetworks, parseTarget, resolveTarget, trustedTarget, type Lookup } from '@/server/web-access/network';
import { WebAccessError } from '@/server/web-access/types';

const networks = parseExtraNetworks(['198.18.0.0/15']);
const none = [] as const;

async function rejectsWithCode(work: () => Promise<unknown>, code: string) {
  await expect(work()).rejects.toBeInstanceOf(WebAccessError);
  await work().catch(error => expect((error as WebAccessError).code).toBe(code));
}

describe('目标地址只接受无凭据的 HTTP(S)，端口限制由 target 分支执行', () => {
  it('parseTarget 拒绝非 HTTP(S)、携带凭据；trusted/resolve 路径拒绝非默认端口', async () => {
    for (const raw of ['ftp://example.com/x', 'file:///etc/passwd', 'https://user:pass@example.com/', 'https://']) {
      expect(() => parseTarget(raw)).toThrow(WebAccessError);
    }
    // 非默认端口在模型可控路径（resolveTarget/trustedTarget/delegatedTarget）拒绝；
    // trustedFacilityTarget 是部署者自建设施（如本机 SearXNG 任意端口），不受此限。
    for (const url of [new URL('https://example.com:8443/'), new URL('http://example.com:443/')]) {
      expect(() => trustedTarget(url)).toThrow(WebAccessError);
      // resolveTarget 是 async：体内 throw 变成 rejected promise，用 rejects 断言。
      await expect(resolveTarget(url, { networks: [] })).rejects.toThrow(WebAccessError);
    }
    expect(parseTarget('https://example.com/a?b=1').hostname).toBe('example.com');
    expect(() => parseTarget('http://example.com:80/a')).not.toThrow();
    expect(() => parseTarget('https://example.com:443/a')).not.toThrow();
  });
});

describe('地址校验永远拒绝内网、环回与保留地址', () => {
  const blocked = ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.1.2.3', '172.16.5.4', '192.168.1.1', '169.254.169.254', '100.100.100.200', '0.0.0.0', '224.0.0.1', 'fd00::1', 'fe80::1'];

  it('即使配置了放行网段也拒绝这些地址', () => {
    for (const address of blocked) {
      expect(() => assertAllowedAddress(address, { literal: true, networks })).toThrow(WebAccessError);
      expect(() => assertAllowedAddress(address, { literal: false, networks })).toThrow(WebAccessError);
    }
  });

  it('公网地址始终放行', () => {
    for (const address of ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']) {
      expect(() => assertAllowedAddress(address, { literal: false, networks: none })).not.toThrow();
    }
  });
});

describe('fake-IP 网段必须由部署者显式放行', () => {
  it('未配置时拒绝，配置后只放行解析结果，不放行字面量地址', () => {
    expect(() => assertAllowedAddress('198.18.0.84', { literal: false, networks: none })).toThrow(WebAccessError);
    expect(() => assertAllowedAddress('198.18.0.84', { literal: false, networks })).not.toThrow();
    expect(() => assertAllowedAddress('198.18.0.84', { literal: true, networks })).toThrow(WebAccessError);
    expect(() => assertAllowedAddress('2001:2::1', { literal: false, networks })).toThrow(WebAccessError);
    expect(() => assertAllowedAddress('2001:2::1', { literal: false, networks: parseExtraNetworks(['2001:2::/48']) })).not.toThrow();
  });
});

describe('额外放行网段只允许无害类别', () => {
  it('拒绝会覆盖私网、环回或过宽的写法', () => {
    for (const entry of ['10.0.0.0/8', '192.168.0.0/16', '127.0.0.0/8', '0.0.0.0/0', '192.0.0.0/2', '198.18.0.0/4', '198.24.0.0/13', '100.64.0.0/10', '::1/128', '169.254.0.0/16', 'not-an-address']) {
      expect(() => parseExtraNetworks([entry]), entry).toThrow();
    }
  });

  it('接受 fake-IP 与文档示例网段', () => {
    expect(parseExtraNetworks(['198.18.0.0/15', '192.0.2.0/24', '2001:2::/48'])).toHaveLength(3);
    expect(parseExtraNetworks(['198.18.0.84/15'])).toHaveLength(1);
  });
});

describe('解析结果逐地址校验', () => {
  it('解析到内网、保留地址或解析失败都拒绝', async () => {
    const lookup = (addresses: { address: string; family: number }[]): Lookup => async () => addresses;
    await rejectsWithCode(() => resolveTarget(new URL('https://a.test/'), { lookup: lookup([{ address: '127.0.0.1', family: 4 }]), networks: none }), 'blocked-url');
    await rejectsWithCode(() => resolveTarget(new URL('https://a.test/'), { lookup: lookup([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.9', family: 4 }]), networks: none }), 'blocked-url');
    await rejectsWithCode(() => resolveTarget(new URL('https://a.test/'), { lookup: async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); }, networks: none }), 'unavailable');
    await rejectsWithCode(() => resolveTarget(new URL('https://a.test/'), { lookup: lookup([]), networks: none }), 'unavailable');
    const ok = await resolveTarget(new URL('https://a.test/p'), { lookup: lookup([{ address: '93.184.216.34', family: 4 }]), networks: none });
    expect(ok.addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('字面量地址不经过 DNS 就完成校验', async () => {
    await rejectsWithCode(() => resolveTarget(new URL('http://169.254.169.254/latest/meta-data/'), { lookup: async () => { throw new Error('不应调用 DNS'); }, networks }), 'blocked-url');
    const ok = await resolveTarget(new URL('https://93.184.216.34/'), { lookup: async () => { throw new Error('不应调用 DNS'); }, networks: none });
    expect(ok.addresses?.[0].address).toBe('93.184.216.34');
  });
});

describe('可信服务商端点与代理模式', () => {
  it('服务商端点跳过地址校验但必须是 HTTPS', () => {
    expect(trustedTarget(new URL('https://api.tavily.com/search')).addresses).toBeNull();
    expect(() => trustedTarget(new URL('http://api.tavily.com/search'))).toThrow(WebAccessError);
  });

  it('代理模式下仍拒绝字面量内网地址', () => {
    expect(delegatedTarget(new URL('https://example.com/')).addresses).toBeNull();
    expect(() => delegatedTarget(new URL('http://127.0.0.1:80/'))).toThrow(WebAccessError);
  });
});
