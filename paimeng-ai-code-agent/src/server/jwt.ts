// JWT 离线验签：共享密钥 HS256，不回查 Java（架构 §1.1，保证字面上的"Java 不中转生成流量"）
import { jwtVerify } from 'jose'

export interface AgentJwtPayload {
  // 用户 id（Java 签发时的 sub）
  sub: string
  [key: string]: unknown
}

// 校验签名与 exp；缺失 exp/sub、算法不符、过期均抛错，由调用方转 401
export async function verifyAgentJwt(token: string, secret: string): Promise<AgentJwtPayload> {
  // algorithms 白名单锁死 HS256，防 alg 混淆攻击
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    algorithms: ['HS256'],
    requiredClaims: ['exp', 'sub'],
  })
  return payload as AgentJwtPayload
}
