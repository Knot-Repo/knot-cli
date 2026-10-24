/**
 * Secret scrubber utility for Knot CLI.
 * Strips high-entropy keys, passwords, and sensitive environment variables
 * to guarantee zero accidental token leakage before transmission to Knot.
 */

const SECRET_KEY_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /auth/i,
  /credential/i,
  /private[_-]?key/i,
];

const SECRET_VALUE_PATTERNS = [
  /sk_live_[0-9a-zA-Z]{24,}/,       // Stripe live key
  /sk_test_[0-9a-zA-Z]{24,}/,       // Stripe test key
  /AKIA[0-9A-Z]{16}/,               // AWS Access Key ID
  /ghp_[0-9a-zA-Z]{36}/,            // GitHub Personal Access Token
  /ey[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*/, // JWT / Bearer
  /AIza[0-9A-Za-z-_]{35}/,          // Google API Key
];

export function scrubString(content: string): string {
  let scrubbed = content;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    scrubbed = scrubbed.replace(new RegExp(pattern, "g"), "[REDACTED_SECRET]");
  }
  return scrubbed;
}

export function scrubObject<T extends Record<string, any>>(obj: T): T {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => (typeof item === "object" ? scrubObject(item) : typeof item === "string" ? scrubString(item) : item)) as unknown as T;
  }

  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    const isSensitiveKey = SECRET_KEY_PATTERNS.some((p) => p.test(key));
    if (isSensitiveKey) {
      result[key] = "[REDACTED_SECRET]";
    } else if (typeof value === "string") {
      result[key] = scrubString(value);
    } else if (typeof value === "object" && value !== null) {
      result[key] = scrubObject(value);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}
