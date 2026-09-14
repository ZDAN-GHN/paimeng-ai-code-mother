


const MAX_INPUT_LENGTH = 1000


const SENSITIVE_WORDS = [
  '忽略之前的指令',
  'ignore previous instructions',
  'ignore above',
  '破解',
  'hack',
  '绕过',
  'bypass',
  '越狱',
  'jailbreak',
]


const INJECTION_PATTERNS = [
  /ignore\s+(?:previous|above|all)\s+(?:instructions?|commands?|prompts?)/i,
  /(?:forget|disregard)\s+(?:everything|all)\s+(?:above|before)/i,
  /(?:pretend|act|behave)\s+(?:as|like)\s+(?:if|you\s+are)/i,
  /system\s*:\s*you\s+are/i,
  /new\s+(?:instructions?|commands?|prompts?)\s*:/i,
]

export interface GuardrailResult {
  isAllowed: boolean
  reason: string
}

function allowed(): GuardrailResult {
  return { isAllowed: true, reason: '' }
}

function rejected(reason: string): GuardrailResult {
  return { isAllowed: false, reason }
}

export function validatePrompt(input: string): GuardrailResult {

  if (input.length > MAX_INPUT_LENGTH) {
    return rejected('输入内容过长，不要超过 1000 字')
  }
  if (input.trim() === '') {
    return rejected('输入内容不能为空')
  }
  const lowerInput = input.toLowerCase()
  for (const word of SENSITIVE_WORDS) {
    if (lowerInput.includes(word.toLowerCase())) {
      return rejected('输入包含不当内容，请修改后重试')
    }
  }
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(input)) {
      return rejected('检测到恶意输入，请求被拒绝')
    }
  }
  return allowed()
}
