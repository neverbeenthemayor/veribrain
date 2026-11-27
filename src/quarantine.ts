import { normalizeLf } from "./normalize.js";
import { hasControlOrBidiChars, stripControlAndBidiChars } from "./sanitize.js";
import {
  EXIT_QUARANTINE_VIOLATION,
  type QuarantineConfig,
  type QuarantineRuleId,
  VeriBrainError,
} from "./types.js";

export interface QuarantineViolation {
  claimId: string;
  rule: QuarantineRuleId;
  line: number;
  field?: string;
}

export interface QuarantineScanOptions {
  claimId: string;
  field?: string;
  config?: QuarantineConfig;
  allowEntropyOnValidatedHashField?: boolean;
  allowHashRefExemption?: boolean;
  allowlistedHashTokens?: ReadonlySet<string>;
  allowlistedLineTokens?: ReadonlyMap<number, ReadonlySet<string>>;
  allowHashRefLineNumbers?: ReadonlySet<number>;
}

const PURE_PRINTABLE_ASCII_RE = /^[\t\n\r\x20-\x7E]*$/;
const SAFE_CLAIM_ID_RE =
  /^(?:(?:DEC|OBS|HYP|SCAR)-[A-Za-z0-9._-]{1,64}|config\.json|scars\.md|zone_b|diff|cli|compile|observe|init|eval|decide|sign|promote|lint-text|hooks|mcp|attest-test|check-citations|retro|stats|metrics|[A-Za-z0-9._-]{1,64}\.(?:md|json))$/;
const SAFE_FIELD_NAME_RE = /^[A-Za-z0-9._-]{1,48}$/;

const HASH_EXEMPT_FIELDS = new Set(["evidence_ref", "git_sha", "sha256_body", "zone_a_sha256"]);

const ANY_SECRET_HINT_RE =
  /AIza|ey[0-9A-Za-z_-]{8,}\.|bearer|PRIVATE|sk[-_]|gh[pousr]_|github_pat_|xox|AKIA|ASIA|ya29\.|GOCSPX-|secret|token|api_?key|private_?key/i;

const GCP_API_KEY_RE = /(?<![0-9A-Za-z])AIza[0-9A-Za-z_-]{16,}/;
const JWT_RE =
  /(?<![0-9A-Za-z])ey[0-9A-Za-z_-]{8,}\.ey[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}(?![0-9A-Za-z])/;
const BEARER_RE = /(Authorization[ \t]*:[ \t]*)?\bBearer[ \t]+([0-9A-Za-z._~+/=-]{8,})/gi;
const PEM_PRIVATE_RE =
  /-----BEGIN[ \t]+(?:[A-Z0-9]+[ \t]+){0,3}PRIVATE[ \t]+KEY(?:[ \t]+BLOCK)?-----/;

const PROVIDER_TOKEN_RE =
  /(?<![0-9A-Za-z])(?:sk-(?:proj-|ant-|live-|test-)?[0-9A-Za-z_-]{16,}|sk_(?:live|test)_[0-9A-Za-z]{16,}|gh[pousr]_[0-9A-Za-z]{20,}|github_pat_[0-9A-Za-z_]{20,}|xox[baprs]-[0-9A-Za-z-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Za-z])|ya29\.[0-9A-Za-z._-]{16,}|GOCSPX-[0-9A-Za-z_-]{16,})/;

const OAUTH_KV_RE =
  /\b(?:client_secret|clientSecret|oauth_secret|oauthSecret|oauth_token|oauthToken|refresh_token|refreshToken|access_token|accessToken|api_key|apiKey|secret_key|secretKey|private_key|privateKey)["']?[ \t]*[:=][ \t]*["']?([0-9A-Za-z._~+/=-]{8,})["']?/i;

const EMAIL_RE =
  /(?<![0-9A-Za-z_%+-])[0-9A-Za-z._%+-]{1,64}@(?:[0-9A-Za-z-]{1,63}\.){1,8}[A-Za-z]{2,24}(?![0-9A-Za-z_%+-])(?!\.[0-9A-Za-z])/g;

const PHONE_E164_RE = /(?<![0-9A-Za-z+])\+[1-9][0-9]{0,2}(?:[ .-]?[0-9]{2,4}){2,4}(?![0-9A-Za-z])/g;
const PHONE_PARENS_RE = /(?<![0-9A-Za-z])\(\d{3}\)[ .-]*\d{3}[ .-]\d{4}(?![0-9A-Za-z])/g;
const PHONE_SEP_RE =
  /(?<![0-9A-Za-z+-])(?<!\d\.)(?:1[ .-])?\d{3}[ .-]\d{3}[ .-]\d{4}(?![0-9A-Za-z-])(?!\.\d)/g;

const ENTROPY_TOKEN_RE = /[0-9A-Za-z+/=._:@&-]{32,}/g;
const PURE_HEX_RE = /^[0-9a-f]+$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_REF_RE = /^sha256:[0-9a-f]{64}$/i;
const COMMIT_REF_RE = /^(?:https?:\/\/)?(?:[0-9A-Za-z_.-]+\/)*commit\/[0-9a-f]{40}$/i;
const CITATION_ENV_SHA_RE = /^(?:local|pre-staging|staging|prod)@[0-9a-f]{7,40}$/i;
const REPO_PATH_RE =
  /^(?:\.?\.?\/)?(?:\.brain|\.github|src|tests|docs|scripts|dist|[0-9A-Za-z_.-]+)\/(?:[0-9A-Za-z_.-]+\/)*[0-9A-Za-z_.-]+(?:#[0-9A-Za-z._:-]+)?$/;
const KNOWN_FILE_EXT_RE =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|txt|sh|ps1|py|css|html|toml|lock|rules|example)$/i;
const KNOWN_REPO_PREFIX_RE = /^(?:\.?\.?\/)?(?:\.brain|\.github|src|tests|docs|scripts|dist)\//;
const PLAIN_ENGLISH_WORD_RE = /^(?:[a-z]+|[A-Z][a-z]+)$/;

export function shannonEntropy(input: string): number {
  if (input.length === 0) {
    return 0;
  }
  const counts = new Map<string, number>();
  for (const ch of input) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  const len = input.length;
  for (const count of counts.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function countCharClasses(token: string): number {
  let classes = 0;
  if (/[a-z]/.test(token)) classes += 1;
  if (/[A-Z]/.test(token)) classes += 1;
  if (/[0-9]/.test(token)) classes += 1;
  if (/[^0-9A-Za-z]/.test(token)) classes += 1;
  return classes;
}

function countAlnumClasses(token: string): number {
  let classes = 0;
  if (/[a-z]/.test(token)) classes += 1;
  if (/[A-Z]/.test(token)) classes += 1;
  if (/[0-9]/.test(token)) classes += 1;
  return classes;
}

function isTokenHighEntropy(token: string): boolean {
  if (token.length < 32) {
    return false;
  }
  const h = shannonEntropy(token);
  if (PURE_HEX_RE.test(token)) {
    return h >= 3.5;
  }
  const classes = countCharClasses(token);
  if (classes >= 3 && h >= 4.5) {
    return true;
  }
  if (classes >= 2 && h >= 4.7) {
    return true;
  }
  return false;
}

function isSuspiciousPathSubPart(part: string): boolean {
  if (part.length < 16) {
    return false;
  }
  const h = shannonEntropy(part);
  if (PURE_HEX_RE.test(part)) {
    return h >= 3.2;
  }
  const alnumClasses = countAlnumClasses(part);
  if (alnumClasses >= 3 && h >= 3.7) {
    return true;
  }
  if (alnumClasses >= 2 && /[0-9]/.test(part) && h >= 3.9) {
    return true;
  }
  return false;
}

function isSafeRepoPathToken(token: string): boolean {
  if (
    !token.includes("/") ||
    token.includes("+") ||
    token.includes("=") ||
    token.includes(":") ||
    token.includes("&")
  ) {
    return false;
  }
  if (!REPO_PATH_RE.test(token)) {
    return false;
  }
  const withoutAnchor = token.split("#")[0] ?? token;
  if (!KNOWN_REPO_PREFIX_RE.test(withoutAnchor) && !KNOWN_FILE_EXT_RE.test(withoutAnchor)) {
    return false;
  }
  const segments = withoutAnchor
    .split("/")
    .filter((seg) => seg.length > 0 && seg !== "." && seg !== "..");
  if (segments.length < 2) {
    return false;
  }
  for (const segment of segments) {
    const stem = segment.replace(KNOWN_FILE_EXT_RE, "");
    if (isTokenHighEntropy(segment) || isTokenHighEntropy(stem)) {
      return false;
    }
    const subParts = stem.split(/[._-]+/).filter((p) => p.length > 0);
    for (const part of subParts) {
      if (isSuspiciousPathSubPart(part)) {
        return false;
      }
    }
    const compact = stem.replace(/[._-]+/g, "");
    if (compact.length >= 20) {
      const h = shannonEntropy(compact);
      if (PURE_HEX_RE.test(compact) && h >= 3.3) {
        return false;
      }
      if (countAlnumClasses(compact) >= 3 && h >= 4.25) {
        return false;
      }
    }
  }
  return true;
}

const SAFE_URL_SCHEME_RE = /^https?:\/\//i;
const SAFE_URL_AUTHORITY_RE = /^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/;
const SAFE_DNS_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const SAFE_TLD_RE = /^[A-Za-z]{2,24}$/;
const SAFE_URL_PATH_SEG_RE = /^[A-Za-z0-9._~-]+$/;
const URL_EMBEDDED_SECRET_PREFIX_RE =
  /(?<![0-9A-Za-z])(?:AIza|gh[pousr]_|github_pat_|sk-|sk_|AKIA|ASIA|xox[baprs]-|eyJ|ya29\.|GOCSPX-)/;
const URL_EMBEDDED_SECRET_PREFIX_CI_RE =
  /(?<![0-9a-z])(?:aiza[0-9a-z_-]{8,}|(?:akia|asia)[0-9a-z]{16}(?![0-9a-z])|eyj[0-9a-z_-]{8,}|gh[pousr]_[0-9a-z]{12,}|github_pat_[0-9a-z_]{12,}|sk-(?:proj-|ant-|live-|test-)?[0-9a-z_-]{12,}|sk_(?:live|test)_[0-9a-z]{12,}|xox[baprs]-[0-9a-z-]{10,}|ya29\.[0-9a-z._-]{8,}|gocspx-[0-9a-z_-]{10,})/i;

function isSuspiciousCompactString(compact: string, minLen: number): boolean {
  if (compact.length < minLen) {
    return false;
  }
  const h = shannonEntropy(compact);
  if (PURE_HEX_RE.test(compact) && h >= 3.3) {
    return true;
  }
  const alnumClasses = countAlnumClasses(compact);
  if (alnumClasses >= 3 && h >= 4.25) {
    return true;
  }
  let digitCount = 0;
  for (let i = 0; i < compact.length; i += 1) {
    const code = compact.charCodeAt(i);
    if (code >= 48 && code <= 57) {
      digitCount += 1;
    }
  }
  const digitRatio = digitCount / compact.length;
  if (alnumClasses >= 2 && digitRatio >= 0.25 && h >= 3.85) {
    return true;
  }
  if (alnumClasses >= 2 && digitCount > 0 && h >= 4.5) {
    return true;
  }
  return false;
}

function isSuspiciousUrlSegment(segment: string): boolean {
  if (segment.length === 0) {
    return false;
  }
  if (URL_EMBEDDED_SECRET_PREFIX_CI_RE.test(segment)) {
    return true;
  }
  if (isTokenHighEntropy(segment)) {
    return true;
  }
  const subParts = segment.split(/[._-]+/).filter((p) => p.length > 0);
  for (const part of subParts) {
    if (isSuspiciousPathSubPart(part)) {
      return true;
    }
  }
  const compact = segment.replace(/[._-]+/g, "");
  return isSuspiciousCompactString(compact, 20);
}

function hasSuspiciousUrlPayload(token: string): boolean {
  if (!SAFE_URL_SCHEME_RE.test(token)) {
    return false;
  }
  if (
    URL_EMBEDDED_SECRET_PREFIX_RE.test(token) ||
    URL_EMBEDDED_SECRET_PREFIX_CI_RE.test(token) ||
    GCP_API_KEY_RE.test(token) ||
    JWT_RE.test(token) ||
    PROVIDER_TOKEN_RE.test(token) ||
    OAUTH_KV_RE.test(token)
  ) {
    return true;
  }

  const afterScheme = token.replace(SAFE_URL_SCHEME_RE, "");
  const slashIdx = afterScheme.indexOf("/");
  const rawAuthority = slashIdx === -1 ? afterScheme : afterScheme.slice(0, slashIdx);
  const rawPath = slashIdx === -1 ? "" : afterScheme.slice(slashIdx + 1);
  const authMatch = SAFE_URL_AUTHORITY_RE.exec(rawAuthority);
  if (authMatch?.[1]) {
    const labels = authMatch[1].split(".").filter((l) => l.length > 0);
    for (const label of labels) {
      if (isSuspiciousUrlSegment(label)) {
        return true;
      }
    }
    if (labels.length >= 3) {
      const subCompact = labels
        .slice(0, -2)
        .join("")
        .replace(/[._-]+/g, "");
      if (isSuspiciousCompactString(subCompact, 24)) {
        return true;
      }
    }
    if (labels.length >= 2) {
      const nonTldCompact = labels
        .slice(0, -1)
        .join("")
        .replace(/[._-]+/g, "");
      if (isSuspiciousCompactString(nonTldCompact, 24)) {
        return true;
      }
    }
  }

  if (rawPath.length > 0) {
    const pathSegments = rawPath.split("/").filter((s) => s.length > 0);
    for (const seg of pathSegments) {
      if (isSuspiciousUrlSegment(seg)) {
        return true;
      }
    }
    const joinedPathCompact = pathSegments.join("").replace(/[/._-]+/g, "");
    if (isSuspiciousCompactString(joinedPathCompact, 24)) {
      return true;
    }
  }

  return false;
}

export function isSafeHostnameToken(token: string): boolean {
  if (!SAFE_URL_SCHEME_RE.test(token)) {
    return false;
  }
  if (
    token.includes("@") ||
    token.includes("?") ||
    token.includes("=") ||
    token.includes("+") ||
    token.includes("%") ||
    token.includes("&") ||
    token.includes("#") ||
    /\s/.test(token) ||
    hasControlOrBidiChars(token)
  ) {
    return false;
  }
  if (hasSuspiciousUrlPayload(token)) {
    return false;
  }

  const afterScheme = token.replace(SAFE_URL_SCHEME_RE, "");
  const slashIdx = afterScheme.indexOf("/");
  const rawAuthority = slashIdx === -1 ? afterScheme : afterScheme.slice(0, slashIdx);
  const rawPath = slashIdx === -1 ? "" : afterScheme.slice(slashIdx + 1);

  const authMatch = SAFE_URL_AUTHORITY_RE.exec(rawAuthority);
  if (!authMatch?.[1]) {
    return false;
  }
  const rawHost = authMatch[1];
  if (authMatch[2] !== undefined) {
    const portNum = Number.parseInt(authMatch[2], 10);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      return false;
    }
  }
  if (
    !rawHost.includes(".") ||
    rawHost.startsWith(".") ||
    rawHost.endsWith(".") ||
    rawHost.includes("..")
  ) {
    return false;
  }

  try {
    const parsed = new URL(token);
    if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "") {
      return false;
    }
  } catch {
    return false;
  }

  const labels = rawHost.split(".");
  if (labels.length < 2) {
    return false;
  }
  const tld = labels[labels.length - 1] ?? "";
  if (!SAFE_TLD_RE.test(tld)) {
    return false;
  }

  for (const label of labels) {
    if (!SAFE_DNS_LABEL_RE.test(label)) {
      return false;
    }
  }

  if (rawPath.length > 0) {
    const pathSegments = rawPath.split("/").filter((s) => s.length > 0);
    for (const seg of pathSegments) {
      if (!SAFE_URL_PATH_SEG_RE.test(seg)) {
        return false;
      }
    }
  }

  return true;
}

function isEntropyAllowlisted(
  token: string,
  allowlistedHashTokens: ReadonlySet<string> | undefined,
  allowHashRefExemption: boolean,
): boolean {
  if (allowlistedHashTokens?.has(token.toLowerCase())) {
    return true;
  }
  if (UUID_RE.test(token)) {
    return true;
  }
  if (allowHashRefExemption) {
    if (SHA256_REF_RE.test(token)) {
      return true;
    }
    if (COMMIT_REF_RE.test(token)) {
      return true;
    }
    if (CITATION_ENV_SHA_RE.test(token)) {
      return true;
    }
  }
  if (isSafeRepoPathToken(token)) {
    return true;
  }
  if (isSafeHostnameToken(token)) {
    return true;
  }
  return false;
}

function trimCandidateToken(raw: string): string {
  return raw.replace(/^[.:@&-]+/, "").replace(/[.:@&-]+$/, "");
}

function expandSubCandidates(token: string): string[] {
  const candidates = new Set<string>([token]);
  const parts = token.split(/[&:@]/);
  for (const part of parts) {
    const cleaned = trimCandidateToken(part);
    if (cleaned.length >= 32) {
      candidates.add(cleaned);
    }
    const eqIdx = cleaned.indexOf("=");
    if (eqIdx > 0 && eqIdx < cleaned.length - 1 && !/^=+$/.test(cleaned.slice(eqIdx))) {
      const rhs = trimCandidateToken(cleaned.slice(eqIdx + 1));
      if (rhs.length >= 32) {
        candidates.add(rhs);
      }
      const eqParts = cleaned.split("=");
      for (const eqPart of eqParts) {
        const sub = trimCandidateToken(eqPart);
        if (sub.length >= 32) {
          candidates.add(sub);
        }
      }
    }
    if (cleaned.includes("/")) {
      for (const slashPart of cleaned.split("/")) {
        const sub = trimCandidateToken(slashPart);
        if (sub.length >= 32) {
          candidates.add(sub);
        }
      }
    }
  }
  return [...candidates];
}

interface NormalizedWhitelist {
  emails: Set<string>;
  domains: Set<string>;
  phones: Set<string>;
}

const EMPTY_WHITELIST: NormalizedWhitelist = {
  emails: new Set(),
  domains: new Set(),
  phones: new Set(),
};

const whitelistCache = new WeakMap<QuarantineConfig, NormalizedWhitelist>();

function normalizeWhitelist(config?: QuarantineConfig): NormalizedWhitelist {
  if (!config) {
    return EMPTY_WHITELIST;
  }
  const existing = whitelistCache.get(config);
  if (existing !== undefined) {
    return existing;
  }
  const computed: NormalizedWhitelist = {
    emails: new Set(config.allowed_emails.map((s) => s.trim().toLowerCase())),
    domains: new Set(config.allowed_domains.map((s) => s.trim().toLowerCase())),
    phones: new Set(config.allowed_phones.map((s) => s.trim().toLowerCase())),
  };
  whitelistCache.set(config, computed);
  return computed;
}

function scanLineForSecretOrPii(
  line: string,
  whitelist: NormalizedWhitelist,
): QuarantineRuleId | null {
  if (ANY_SECRET_HINT_RE.test(line)) {
    if (line.includes("PRIVATE") && PEM_PRIVATE_RE.test(line)) {
      return "pem_private";
    }
    if (line.includes("AIza") && GCP_API_KEY_RE.test(line)) {
      return "gcp_api_key";
    }
    if (line.includes("ey") && line.includes(".") && JWT_RE.test(line)) {
      return "jwt";
    }
    if (/bearer/i.test(line)) {
      BEARER_RE.lastIndex = 0;
      let bearerMatch = BEARER_RE.exec(line);
      while (bearerMatch !== null) {
        const hasAuthPrefix = Boolean(bearerMatch[1]);
        const tokenPart = bearerMatch[2] ?? "";
        if (hasAuthPrefix || (tokenPart.length >= 10 && !PLAIN_ENGLISH_WORD_RE.test(tokenPart))) {
          return "bearer";
        }
        bearerMatch = BEARER_RE.exec(line);
      }
    }
    if (PROVIDER_TOKEN_RE.test(line)) {
      return "provider_token";
    }
    if (OAUTH_KV_RE.test(line)) {
      return "oauth_kv";
    }
  }

  if (line.includes("@")) {
    EMAIL_RE.lastIndex = 0;
    let emailMatch = EMAIL_RE.exec(line);
    while (emailMatch !== null) {
      const emailLower = emailMatch[0].toLowerCase();
      const atIdx = emailLower.indexOf("@");
      const domain = emailLower.slice(atIdx + 1);
      if (!whitelist.emails.has(emailLower) && !whitelist.domains.has(domain)) {
        return "pii_email";
      }
      emailMatch = EMAIL_RE.exec(line);
    }
  }

  if (line.length >= 9 && /\d/.test(line)) {
    const whitelistedPhoneSpans: Array<[number, number]> = [];
    if (line.includes("+")) {
      PHONE_E164_RE.lastIndex = 0;
      let phoneMatch = PHONE_E164_RE.exec(line);
      while (phoneMatch !== null) {
        const raw = phoneMatch[0].trim();
        const digitCount = raw.replace(/\D/g, "").length;
        if (digitCount >= 8 && digitCount <= 15) {
          if (whitelist.phones.has(raw.toLowerCase())) {
            whitelistedPhoneSpans.push([phoneMatch.index, phoneMatch.index + phoneMatch[0].length]);
          } else {
            return "pii_phone";
          }
        }
        phoneMatch = PHONE_E164_RE.exec(line);
      }
    }

    const isInsideWhitelistedPhone = (start: number, end: number): boolean =>
      whitelistedPhoneSpans.some(([s, e]) => start >= s && end <= e);

    if (line.includes("(")) {
      PHONE_PARENS_RE.lastIndex = 0;
      let m = PHONE_PARENS_RE.exec(line);
      while (m !== null) {
        const start = m.index;
        const end = start + m[0].length;
        const raw = m[0].trim();
        if (!isInsideWhitelistedPhone(start, end) && !whitelist.phones.has(raw.toLowerCase())) {
          return "pii_phone";
        }
        m = PHONE_PARENS_RE.exec(line);
      }
    }

    if (line.length >= 12) {
      PHONE_SEP_RE.lastIndex = 0;
      let m = PHONE_SEP_RE.exec(line);
      while (m !== null) {
        const start = m.index;
        const end = start + m[0].length;
        const raw = m[0].trim();
        if (!isInsideWhitelistedPhone(start, end) && !whitelist.phones.has(raw.toLowerCase())) {
          return "pii_phone";
        }
        m = PHONE_SEP_RE.exec(line);
      }
    }
  }

  return null;
}

function scanLineForEntropy(
  line: string,
  allowlistedHashTokens: ReadonlySet<string> | undefined,
  allowHashRefExemption: boolean,
): boolean {
  if (line.length < 32) {
    return false;
  }
  ENTROPY_TOKEN_RE.lastIndex = 0;
  let match = ENTROPY_TOKEN_RE.exec(line);
  while (match !== null) {
    const trimmed = trimCandidateToken(match[0]);
    if (
      trimmed.length >= 32 &&
      !isEntropyAllowlisted(trimmed, allowlistedHashTokens, allowHashRefExemption)
    ) {
      if (SAFE_URL_SCHEME_RE.test(trimmed) && hasSuspiciousUrlPayload(trimmed)) {
        return true;
      }
      for (const candidate of expandSubCandidates(trimmed)) {
        if (
          candidate.length >= 32 &&
          !isEntropyAllowlisted(candidate, allowlistedHashTokens, allowHashRefExemption) &&
          isTokenHighEntropy(candidate)
        ) {
          return true;
        }
      }
    }
    match = ENTROPY_TOKEN_RE.exec(line);
  }
  return false;
}

function scanLinesInternal(
  lines: readonly string[],
  whitelist: { emails: Set<string>; domains: Set<string>; phones: Set<string> },
  options: QuarantineScanOptions,
): QuarantineViolation | null {
  const defaultHashRefExempt =
    options.allowHashRefExemption !== undefined
      ? options.allowHashRefExemption
      : options.field !== undefined && HASH_EXEMPT_FIELDS.has(options.field);

  for (let i = 0; i < lines.length; i += 1) {
    const lineNum = i + 1;
    const line = lines[i] ?? "";
    const rule = scanLineForSecretOrPii(line, whitelist);
    if (rule !== null) {
      return options.field !== undefined
        ? { claimId: options.claimId, rule, line: lineNum, field: options.field }
        : { claimId: options.claimId, rule, line: lineNum };
    }
    if (!options.allowEntropyOnValidatedHashField) {
      const lineAllow =
        options.allowlistedLineTokens?.get(lineNum) ?? options.allowlistedHashTokens;
      const allowHashRef =
        defaultHashRefExempt || Boolean(options.allowHashRefLineNumbers?.has(lineNum));
      if (scanLineForEntropy(line, lineAllow, allowHashRef)) {
        return options.field !== undefined
          ? {
              claimId: options.claimId,
              rule: "high_entropy_secret",
              line: lineNum,
              field: options.field,
            }
          : { claimId: options.claimId, rule: "high_entropy_secret", line: lineNum };
      }
    }
  }
  return null;
}

export function scanTextForQuarantine(
  text: string,
  options: QuarantineScanOptions,
): QuarantineViolation | null {
  const whitelist = normalizeWhitelist(options.config);
  const lf = normalizeLf(text);
  const rawViolation = scanLinesInternal(lf.split("\n"), whitelist, options);
  if (rawViolation !== null) {
    return rawViolation;
  }

  if (!PURE_PRINTABLE_ASCII_RE.test(lf)) {
    const canonical = stripControlAndBidiChars(lf.normalize("NFKC"), true);
    if (canonical !== lf) {
      return scanLinesInternal(canonical.split("\n"), whitelist, options);
    }
  }

  return null;
}

function scanLineAllSecretOrPii(line: string, whitelist: NormalizedWhitelist): QuarantineRuleId[] {
  const rules: QuarantineRuleId[] = [];
  if (ANY_SECRET_HINT_RE.test(line)) {
    if (line.includes("PRIVATE") && PEM_PRIVATE_RE.test(line)) {
      rules.push("pem_private");
    }
    if (line.includes("AIza") && GCP_API_KEY_RE.test(line)) {
      rules.push("gcp_api_key");
    }
    if (line.includes("ey") && line.includes(".") && JWT_RE.test(line)) {
      rules.push("jwt");
    }
    if (/bearer/i.test(line)) {
      BEARER_RE.lastIndex = 0;
      let bearerMatch = BEARER_RE.exec(line);
      while (bearerMatch !== null) {
        const hasAuthPrefix = Boolean(bearerMatch[1]);
        const tokenPart = bearerMatch[2] ?? "";
        if (hasAuthPrefix || (tokenPart.length >= 10 && !PLAIN_ENGLISH_WORD_RE.test(tokenPart))) {
          rules.push("bearer");
          break;
        }
        bearerMatch = BEARER_RE.exec(line);
      }
    }
    if (PROVIDER_TOKEN_RE.test(line)) {
      rules.push("provider_token");
    }
    if (OAUTH_KV_RE.test(line)) {
      rules.push("oauth_kv");
    }
  }

  if (line.includes("@")) {
    EMAIL_RE.lastIndex = 0;
    let emailMatch = EMAIL_RE.exec(line);
    while (emailMatch !== null) {
      const emailLower = emailMatch[0].toLowerCase();
      const atIdx = emailLower.indexOf("@");
      const domain = emailLower.slice(atIdx + 1);
      if (!whitelist.emails.has(emailLower) && !whitelist.domains.has(domain)) {
        rules.push("pii_email");
        break;
      }
      emailMatch = EMAIL_RE.exec(line);
    }
  }

  if (line.length >= 9 && /\d/.test(line)) {
    const whitelistedPhoneSpans: Array<[number, number]> = [];
    let phoneHit = false;
    if (line.includes("+")) {
      PHONE_E164_RE.lastIndex = 0;
      let phoneMatch = PHONE_E164_RE.exec(line);
      while (phoneMatch !== null) {
        const raw = phoneMatch[0].trim();
        const digitCount = raw.replace(/\D/g, "").length;
        if (digitCount >= 8 && digitCount <= 15) {
          if (whitelist.phones.has(raw.toLowerCase())) {
            whitelistedPhoneSpans.push([phoneMatch.index, phoneMatch.index + phoneMatch[0].length]);
          } else {
            phoneHit = true;
            break;
          }
        }
        phoneMatch = PHONE_E164_RE.exec(line);
      }
    }
    const isInsideWhitelistedPhone = (start: number, end: number): boolean =>
      whitelistedPhoneSpans.some(([s, e]) => start >= s && end <= e);

    if (!phoneHit && line.includes("(")) {
      PHONE_PARENS_RE.lastIndex = 0;
      let m = PHONE_PARENS_RE.exec(line);
      while (m !== null) {
        const start = m.index;
        const end = start + m[0].length;
        const raw = m[0].trim();
        if (!isInsideWhitelistedPhone(start, end) && !whitelist.phones.has(raw.toLowerCase())) {
          phoneHit = true;
          break;
        }
        m = PHONE_PARENS_RE.exec(line);
      }
    }

    if (!phoneHit && line.length >= 12) {
      PHONE_SEP_RE.lastIndex = 0;
      let m = PHONE_SEP_RE.exec(line);
      while (m !== null) {
        const start = m.index;
        const end = start + m[0].length;
        const raw = m[0].trim();
        if (!isInsideWhitelistedPhone(start, end) && !whitelist.phones.has(raw.toLowerCase())) {
          phoneHit = true;
          break;
        }
        m = PHONE_SEP_RE.exec(line);
      }
    }

    if (phoneHit) {
      rules.push("pii_phone");
    }
  }

  return rules;
}

function collectLineViolations(
  lines: readonly string[],
  whitelist: NormalizedWhitelist,
  options: QuarantineScanOptions,
  seen: Set<string>,
  out: QuarantineViolation[],
): void {
  const defaultHashRefExempt =
    options.allowHashRefExemption !== undefined
      ? options.allowHashRefExemption
      : options.field !== undefined && HASH_EXEMPT_FIELDS.has(options.field);

  const pushUnique = (lineNum: number, rule: QuarantineRuleId): void => {
    const key = `${lineNum}:${rule}:${options.field ?? ""}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push(
      options.field !== undefined
        ? { claimId: options.claimId, rule, line: lineNum, field: options.field }
        : { claimId: options.claimId, rule, line: lineNum },
    );
  };

  for (let i = 0; i < lines.length; i += 1) {
    const lineNum = i + 1;
    const line = lines[i] ?? "";
    const rules = scanLineAllSecretOrPii(line, whitelist);
    for (const rule of rules) {
      pushUnique(lineNum, rule);
    }
    const hasSecretRule = rules.some((r) => r !== "pii_email" && r !== "pii_phone");
    if (!options.allowEntropyOnValidatedHashField && !hasSecretRule) {
      const lineAllow =
        options.allowlistedLineTokens?.get(lineNum) ?? options.allowlistedHashTokens;
      const allowHashRef =
        defaultHashRefExempt || Boolean(options.allowHashRefLineNumbers?.has(lineNum));
      if (scanLineForEntropy(line, lineAllow, allowHashRef)) {
        pushUnique(lineNum, "high_entropy_secret");
      }
    }
  }
}

export function scanAllTextForQuarantine(
  text: string,
  options: QuarantineScanOptions,
): QuarantineViolation[] {
  const whitelist = normalizeWhitelist(options.config);
  const lf = normalizeLf(text);
  const seen = new Set<string>();
  const out: QuarantineViolation[] = [];

  collectLineViolations(lf.split("\n"), whitelist, options, seen, out);

  if (!PURE_PRINTABLE_ASCII_RE.test(lf)) {
    const canonical = stripControlAndBidiChars(lf.normalize("NFKC"), true);
    if (canonical !== lf) {
      collectLineViolations(canonical.split("\n"), whitelist, options, seen, out);
    }
  }

  out.sort((a, b) => (a.line !== b.line ? a.line - b.line : a.rule.localeCompare(b.rule)));
  return out;
}

export function sanitizeQuarantineClaimId(
  claimId: string,
  field?: string,
  config?: QuarantineConfig,
): string {
  if (field === "claim_id") {
    return "<redacted-claim-id>";
  }
  const trimmed = claimId.trim();
  if (!SAFE_CLAIM_ID_RE.test(trimmed)) {
    return "<redacted-claim-id>";
  }
  const whitelist = normalizeWhitelist(config);
  const probes = [trimmed];
  const withoutExt = trimmed.replace(/\.(?:md|json)$/i, "");
  const dashIdx = withoutExt.indexOf("-");
  if (dashIdx > 0 && dashIdx < withoutExt.length - 1) {
    probes.push(withoutExt.slice(dashIdx + 1));
  }
  for (const probe of probes) {
    if (
      scanLineForSecretOrPii(probe, whitelist) !== null ||
      scanLineForEntropy(probe, undefined, false)
    ) {
      return "<redacted-claim-id>";
    }
  }
  return trimmed;
}

export function sanitizeQuarantineField(field: string, config?: QuarantineConfig): string {
  const trimmed = field.trim();
  if (!SAFE_FIELD_NAME_RE.test(trimmed)) {
    return "<redacted-field>";
  }
  const whitelist = normalizeWhitelist(config);
  if (
    scanLineForSecretOrPii(trimmed, whitelist) !== null ||
    scanLineForEntropy(trimmed, undefined, false)
  ) {
    return "<redacted-field>";
  }
  return trimmed;
}

export function createQuarantineError(
  violation: QuarantineViolation,
  config?: QuarantineConfig,
): VeriBrainError {
  const safeClaimId = sanitizeQuarantineClaimId(violation.claimId, violation.field, config);
  const safeField = violation.field ? sanitizeQuarantineField(violation.field, config) : undefined;
  const fieldNote = safeField ? ` field=${safeField}` : "";
  const isPii = violation.rule === "pii_email" || violation.rule === "pii_phone";
  const fix = isPii
    ? "Remove PII or whitelist approved contact in .brain/config.json, then run `veribrain eval --strict`."
    : `Remove secret from ${safeClaimId}, then run \`veribrain eval --strict\`.`;
  return new VeriBrainError({
    exitCode: EXIT_QUARANTINE_VIOLATION,
    code: "QUARANTINE_VIOLATION",
    claimId: safeClaimId,
    rule: violation.rule,
    line: violation.line,
    detail: `Blocked sensitive pattern at line ${violation.line}${fieldNote} (raw value redacted).`,
    fix,
  });
}

export function assertQuarantineClean(text: string, options: QuarantineScanOptions): void {
  const violation = scanTextForQuarantine(text, options);
  if (violation !== null) {
    throw createQuarantineError(violation, options.config);
  }
}
