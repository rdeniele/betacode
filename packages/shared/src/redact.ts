/** Secret redaction used by logs and anything persisted outside the model context. */

const SECRET_KEY = /(api[_-]?key|secret|token|password|passwd|database_url|service_role|private[_-]?key|authorization|credential)/i;

const VALUE_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export const REDACTED = "[REDACTED]";

export function isSecretKey(name: string): boolean {
  return SECRET_KEY.test(name);
}

/** Redact secrets inside free text (KEY=value assignments and well-known token shapes). */
export function redactText(text: string): string {
  let out = text.replace(
    /\b([A-Z0-9_]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL|SERVICE_ROLE_KEY)[A-Z0-9_]*)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s"']+)/gi,
    (_m, k: string) => `${k}=${REDACTED}`,
  );
  for (const re of VALUE_PATTERNS) out = out.replace(re, REDACTED);
  out = out.replace(/(postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/([^:\s/]+):([^@\s]+)@/gi, `$1://$2:${REDACTED}@`);
  return out;
}

/** Deep-redact an arbitrary JSON-ish value. */
export function redactValue<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) && typeof v === "string" && v.length > 0 ? REDACTED : redactValue(v);
    }
    return out as T;
  }
  return value;
}

/** Filter an environment so secrets are not handed to child processes. */
export function filterEnv(env: NodeJS.ProcessEnv, extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (isSecretKey(k)) continue;
    out[k] = v;
  }
  return { ...out, ...extra };
}
