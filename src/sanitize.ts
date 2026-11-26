import { normalizeLf } from "./normalize.js";
import { EXIT_PROVENANCE_VIOLATION, type HintSource, VeriBrainError } from "./types.js";

const VALID_HINT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const UNSAFE_TEST_REF_CHARS_RE = /[<>"']/;

export function isStrippedControlOrBidiCodePoint(cp: number, preserveNewlines = true): boolean {
  if (preserveNewlines && (cp === 0x09 || cp === 0x0a)) {
    return false;
  }
  if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) {
    return true;
  }
  return (
    cp === 0x00ad ||
    cp === 0x034f ||
    cp === 0x061c ||
    cp === 0x180e ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    cp === 0x2060 ||
    (cp >= 0x2066 && cp <= 0x2069) ||
    cp === 0xfeff ||
    (cp >= 0xe0000 && cp <= 0xe007f)
  );
}

export function stripControlAndBidiChars(input: string, preserveNewlines = true): string {
  let out = "";
  for (const ch of input) {
    const cp = ch.codePointAt(0);
    if (cp === undefined || isStrippedControlOrBidiCodePoint(cp, preserveNewlines)) {
      continue;
    }
    out += cp === 0x09 ? " " : ch;
  }
  return out;
}

export function hasControlOrBidiChars(input: string): boolean {
  for (const ch of input) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) {
      continue;
    }
    if (isStrippedControlOrBidiCodePoint(cp, false)) {
      return true;
    }
  }
  return false;
}

export interface UntrustedHintInput {
  source: HintSource;
  id: string;
  body: string;
  regressionTest?: string;
}

export function escapeXmlText(input: string): string {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeXmlAttr(input: string): string {
  return escapeXmlText(input).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function isValidRepoRelativeTestRef(ref: string): boolean {
  const trimmed = ref.trim();
  if (trimmed.length === 0 || trimmed.length > 260) {
    return false;
  }
  if (hasControlOrBidiChars(trimmed) || UNSAFE_TEST_REF_CHARS_RE.test(trimmed)) {
    return false;
  }
  const filePath = trimmed.split("#")[0]?.split("::")[0]?.trim() ?? "";
  if (filePath.length === 0) {
    return false;
  }
  if (
    filePath.startsWith("/") ||
    filePath.startsWith("\\") ||
    /^[A-Za-z]:/.test(filePath) ||
    filePath.includes("\\")
  ) {
    return false;
  }
  const segments = filePath.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      return false;
    }
  }
  return true;
}

export function sanitizeUntrustedBody(body: string): string {
  const nfkc = normalizeLf(body).normalize("NFKC");
  const stripped = stripControlAndBidiChars(nfkc, true);
  const trimmedLines = stripped
    .split("\n")
    .map((line) => line.replace(/[ ]+$/, ""))
    .join("\n")
    .trim();
  return escapeXmlText(trimmedLines);
}

export function renderUntrustedHint(input: UntrustedHintInput): string {
  if (input.source !== "scar" && input.source !== "hypothesis") {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: String(input.id || "unknown"),
      rule: "invalid_hint_source",
      detail: "Untrusted hint source must be scar or hypothesis.",
      fix: "Store scars in .brain/scars.md or hypotheses in .brain/hypotheses/.",
    });
  }

  const expectedPrefix = input.source === "scar" ? "SCAR-" : "HYP-";
  if (!VALID_HINT_ID_RE.test(input.id) || !input.id.startsWith(expectedPrefix)) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "invalid-hint-id",
      rule: "invalid_hint_id",
      detail: `Untrusted hint id for ${input.source} must start with ${expectedPrefix} and match ^[A-Za-z0-9._-]{1,64}$.`,
      fix: `Use a valid ${expectedPrefix}* identifier.`,
    });
  }

  const attrs: string[] = [
    `source="${escapeXmlAttr(input.source)}"`,
    `id="${escapeXmlAttr(input.id)}"`,
  ];

  if (input.source === "scar") {
    if (!input.regressionTest || !isValidRepoRelativeTestRef(input.regressionTest)) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: input.id,
        rule: "invalid_regression_test",
        detail: "Scar regression_test must be a safe repo-relative path.",
        fix: "Set regression_test to a repo-relative test path (e.g. tests/eval.test.ts#L10).",
      });
    }
    attrs.push(`regression_test="${escapeXmlAttr(input.regressionTest.trim())}"`);
  }

  attrs.push('non_authoritative="true"');

  const sanitizedBody = sanitizeUntrustedBody(input.body);
  const openTag = `<untrusted_hint ${attrs.join(" ")}>`;
  const closeTag = "</untrusted_hint>";
  const rendered = `${openTag}\n${sanitizedBody}\n${closeTag}`;

  assertValidUntrustedHintWrapper(rendered, input.id);
  return rendered;
}

export function assertValidUntrustedHintWrapper(rendered: string, claimId: string): void {
  const closeSuffix = "\n</untrusted_hint>";
  if (!rendered.startsWith("<untrusted_hint ") || !rendered.endsWith(closeSuffix)) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId,
      rule: "hint_wrapper_assertion_failed",
      detail: "Rendered untrusted_hint failed outer boundary check.",
      fix: "Inspect hint renderer sanitization invariants.",
    });
  }

  const openEnd = rendered.indexOf(">\n");
  if (openEnd === -1) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId,
      rule: "hint_wrapper_assertion_failed",
      detail: "Rendered untrusted_hint opening tag malformed.",
      fix: "Inspect hint renderer sanitization invariants.",
    });
  }

  const openTag = rendered.slice(0, openEnd + 1);
  if (!openTag.includes('non_authoritative="true"')) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId,
      rule: "hint_wrapper_assertion_failed",
      detail: "Rendered untrusted_hint missing non_authoritative=true.",
      fix: "Ensure non_authoritative=true is always emitted.",
    });
  }

  const innerBody = rendered.slice(openEnd + 2, rendered.length - closeSuffix.length);
  if (innerBody.includes("<") || innerBody.includes(">")) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId,
      rule: "hint_wrapper_assertion_failed",
      detail: "Rendered untrusted_hint inner body contains unescaped angle brackets.",
      fix: "Escape all angle brackets before rendering untrusted_hint.",
    });
  }

  const openCount = rendered.split("<untrusted_hint").length - 1;
  const closeCount = rendered.split("</untrusted_hint>").length - 1;
  if (openCount !== 1 || closeCount !== 1) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId,
      rule: "hint_wrapper_assertion_failed",
      detail: "Rendered untrusted_hint wrapper count mismatch.",
      fix: "Ensure single untrusted_hint wrapper per item.",
    });
  }
}
