// Match recognizable credential paths, including shell arguments and grep headers.
const credentialPath = /(?:^|[\s/\\'"=:])(?:\.env(?:\.[\w.-]*)?|\.npmrc|\.netrc|\.pypirc|\.git-credentials|id_(?:rsa|ed25519|ecdsa)|(?:application_default_)?credentials(?:\.(?:json|ini|txt|ya?ml|toml))?|secrets?\.(?:json|ya?ml|toml)|auth\.json)(?=$|[\s/\\'":*?\[])/i;
const credentialDirectory = /(?:\.aws|\.ssh|\.gnupg|\.docker|\.kube)(?:[/\\]|\b)/i;
const secretField = /(?:api[_-]?key|auth[_-]?token|access[_-]?token|secret|password|passwd)/i;
const credentialEnvName = /(?:^|[_-])(?:token|secret|password|passwd|api[_-]?key|auth|credentials?|private[_-]?key|access[_-]?key)(?:$|[_-])/i;

export function sensitiveInvocation(input: string, output = ""): boolean {
  return credentialPath.test(input) || credentialDirectory.test(input) || credentialPath.test(output) || credentialDirectory.test(output)
    || /(?:^|[\s;|&"'])(?:printenv|env|set|export)(?:[\s"']|$)/.test(input);
}

export function prepareInvocation(input: Record<string, unknown>, redact: (text: string) => string): { text: string; sensitive: boolean } {
  let sensitive = false;
  const visit = (value: unknown, depth = 0): unknown => {
    if (depth > 64) throw new Error("input-depth");
    if (typeof value === "string") {
      sensitive ||= sensitiveInvocation(value);
      return redact(value);
    }
    if (Array.isArray(value)) return value.map(item => visit(item, depth + 1));
    if (value !== null && typeof value === "object") {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("input-object");
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [
        redact(key), secretField.test(key) ? "[REDACTED]" : visit(item, depth + 1),
      ]));
    }
    if (value !== null && value !== undefined && typeof value !== "number" && typeof value !== "boolean") throw new Error("input-value");
    return value;
  };
  // Encoding first hides quote/backslash/newline-containing credentials from exact matching.
  return { text: JSON.stringify(visit(input)), sensitive };
}

export function createRedactor(env: NodeJS.ProcessEnv): (text: string) => string {
  const values = [...new Set(Object.entries(env).filter(([name]) => credentialEnvName.test(name))
    .map(([, value]) => value).filter((value): value is string => !!value))].sort((a, b) => b.length - a.length);
  return (text: string) => {
    let result = text
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]")
      .replace(/\bBearer\s+[^\s'";,]+/gi, "Bearer [REDACTED]")
      .replace(/\b([\w.-]{0,80}(?:api[_-]?key|auth[_-]?token|access[_-]?token|secret|password|passwd)[\w.-]{0,80}["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, "$1[REDACTED]")
      .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/g, "[REDACTED]");
    for (const value of values) {
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Even short credentials must be hidden, without masking every occurrence of a letter.
      const pattern = value.length < 4 ? `(?<![\\w])${escaped}(?![\\w])` : escaped;
      result = result.replace(new RegExp(pattern, "g"), "[REDACTED ENV]");
    }
    return result;
  };
}
