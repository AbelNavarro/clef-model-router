// Keeps credentials out of anything shown or logged. The token is only ever
// put in an Authorization header; these are belt-and-braces for error text
// that echoes a request, and for configuration summaries.

const PATTERNS: readonly RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /(authorization|api[_-]?token|api[_-]?key|token)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
  // Cloudflare API tokens are 40 URL-safe characters; long opaque runs in
  // general are not something an error message needs to show.
  /\b[A-Za-z0-9_-]{32,}\b/g,
]

export function redact(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join("[redacted]")
  }
  out = out.replace(PATTERNS[0]!, "Bearer [redacted]")
  out = out.replace(PATTERNS[1]!, (_m, key: string, sep: string) => `${key}${sep}[redacted]`)
  out = out.replace(PATTERNS[2]!, "[redacted]")
  return out
}

/** "set" / "not set": how a secret appears in a status report. */
export function presence(secret: string | undefined): string {
  return secret ? "set" : "not set"
}
