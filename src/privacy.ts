const SECRET_ASSIGNMENT = /\b((?:[A-Z][A-Z0-9_]*_)?(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const BEARER_TOKEN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi;
const PRIVATE_KEY_BLOCK = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g;
const COMMON_API_KEY = /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{20,})\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const AWS_ACCESS_KEY = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+@/gi;

export function sanitizeForRouter(text: string, maxLength = 4_000): string {
  const redacted = text
    .replace(PRIVATE_KEY_BLOCK, "[REDACTED PRIVATE KEY]")
    .replace(SECRET_ASSIGNMENT, "$1[REDACTED]")
    .replace(BEARER_TOKEN, "$1[REDACTED]")
    .replace(COMMON_API_KEY, "[REDACTED API KEY]")
    .replace(JWT, "[REDACTED JWT]")
    .replace(AWS_ACCESS_KEY, "[REDACTED AWS ACCESS KEY]")
    .replace(URL_PASSWORD, "$1[REDACTED]@");
  if (redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, maxLength)}\n[truncated for routing]`;
}
