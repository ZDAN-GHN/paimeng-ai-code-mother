import { jwtVerify } from 'jose'

export interface AgentJwtPayload {
  sub: string
  appId?: string
  workspacePath?: string
  [key: string]: unknown
}

export async function verifyAgentJwt(token: string, secret: string): Promise<AgentJwtPayload> {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    algorithms: ['HS256'],
    requiredClaims: ['exp', 'sub'],
  })
  return payload as AgentJwtPayload
}
