export type RedactionKind = "pem" | "key" | "token" | "secret";

export interface RedactionRule {
  kind: RedactionKind;
  pattern: RegExp;
  keepPrefixGroup?: number;
  keepSuffixGroup?: number;
}

const KEY = "key";
const TOKEN = "token";
const SECRET = "secret";

// Keep this list at eleven rules. The sk- and sk-ant- forms share one rule.
export const REDACTION_RULES: readonly RedactionRule[] = [
  {
    kind: "pem",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    kind: KEY,
    pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g,
  },
  {
    kind: TOKEN,
    pattern: /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/g,
  },
  {
    kind: TOKEN,
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    kind: KEY,
    pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  },
  {
    kind: KEY,
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    kind: TOKEN,
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  },
  {
    kind: TOKEN,
    pattern: /\b(?:access|refresh|id)_token["'\s:=]+[A-Za-z0-9._~+/-]{12,}/gi,
  },
  {
    kind: SECRET,
    pattern: /\b((?:api[_-]?key|apikey|secret|password|passwd|token)["'\s:=]+)([^\s"',;]{8,})/gi,
    keepPrefixGroup: 1,
  },
  {
    kind: SECRET,
    pattern: /([?&](?:api[_-]?key|apikey|token|access_token|key)=)([^&\s]+)/gi,
    keepPrefixGroup: 1,
  },
  {
    kind: SECRET,
    pattern: /(:\/\/[^/\s:@]+:)([^@\s/]+)(@)/gi,
    keepPrefixGroup: 1,
    keepSuffixGroup: 3,
  },
] as const;

function replacement(rule: RedactionRule, match: string): string {
  if (rule.kind === "secret" && rule.keepPrefixGroup !== undefined) {
    const groups = new RegExp(rule.pattern.source, rule.pattern.flags).exec(match);
    const prefix = groups?.[rule.keepPrefixGroup] ?? "";
    const suffix =
      rule.keepSuffixGroup === undefined ? "" : (groups?.[rule.keepSuffixGroup] ?? "");
    return `${prefix}[redacted:secret]${suffix}`;
  }
  return `[redacted:${rule.kind}]`;
}

export function redact(text: string): string {
  if (!text) {
    return text;
  }
  let output = text;
  for (const rule of REDACTION_RULES) {
    output = output.replace(new RegExp(rule.pattern.source, rule.pattern.flags), (match: string) =>
      replacement(rule, match),
    );
  }
  return output;
}
