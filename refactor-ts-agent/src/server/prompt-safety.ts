import { BusinessError } from './http';

const sensitiveWords = ['忽略之前的指令', 'ignore previous instructions', 'ignore above', '破解', 'hack', '绕过', 'bypass', '越狱', 'jailbreak'];
const injectionPatterns = [
  /ignore\s+(?:previous|above|all)\s+(?:instructions?|commands?|prompts?)/i,
  /(?:forget|disregard)\s+(?:everything|all)\s+(?:above|before)/i,
  /(?:pretend|act|behave)\s+(?:as|like)\s+(?:if|you\s+are)/i,
  /system\s*:\s*you\s+are/i,
  /new\s+(?:instructions?|commands?|prompts?)\s*:/i,
];

/** Keep the input rules of the original generation guardrail. */
export function validatePrompt(input: string) {
  if (input.length > 1000) throw new BusinessError(400, 40000, '输入内容过长，不要超过 1000 字');
  if (!input.trim()) throw new BusinessError(400, 40000, '输入内容不能为空');
  if (sensitiveWords.some(word => input.toLowerCase().includes(word))) throw new BusinessError(400, 40000, '输入包含不当内容，请修改后重试');
  if (injectionPatterns.some(pattern => pattern.test(input))) throw new BusinessError(400, 40000, '检测到恶意输入，请求被拒绝');
}
