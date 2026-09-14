type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

const REDACTED = '[REDACTED]'
const MAX_TEXT = 120
const SENSITIVE_KEY =
  /(?:authorization|cookie|password|secret|token|api[_-]?key|access[_-]?token|id[_-]?token|credential)/i
const SENSITIVE_ASSIGNMENT =
  /(?:authorization|cookie|password|secret|token|api[_-]?key|access[_-]?token|id[_-]?token)\s*[=:]\s*["']?[^\s,;&"']+/gi
const BEARER = /\bBearer\s+[^\s,;&"']+/gi
const URL_QUERY =
  /([?&](?:authorization|cookie|password|secret|token|api[_-]?key|access[_-]?token|id[_-]?token)=)[^&#\s]*/gi

function redactText(value: string): string {
  return value
    .slice(0, MAX_TEXT)
    .replace(BEARER, 'Bearer [REDACTED]')
    .replace(SENSITIVE_ASSIGNMENT, (match: string) =>
      match.replace(/([=:]\s*["']?)[^\s,;&"']+$/, `$1${REDACTED}`),
    )
    .replace(URL_QUERY, `$1${REDACTED}`)
}

function redactNested(value: JsonValue, key = ''): JsonValue {
  if (SENSITIVE_KEY.test(key)) return REDACTED
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => redactNested(entry))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 50)
        .map(([entryKey, entryValue]) => [entryKey, redactNested(entryValue, entryKey)]),
    )
  return value
}

export function sanitizeString(value: unknown): string {
  if (typeof value !== 'string') return ''
  try {
    const parsed = JSON.parse(value) as JsonValue
    return redactText(JSON.stringify(redactNested(parsed)))
  } catch {
    return redactText(value)
  }
}
