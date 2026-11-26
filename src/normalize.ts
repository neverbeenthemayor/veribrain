import { createHash } from "node:crypto";

export function stripBom(input: string): string {
  return input.startsWith("\uFEFF") ? input.slice(1) : input;
}

export function normalizeLf(input: string): string {
  return stripBom(input).replace(/\r\n?/g, "\n");
}

export function normalizeText(input: string): string {
  const lf = normalizeLf(input).normalize("NFC");
  return lf
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n");
}

export function compareAscii(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function computeDecidedBodyHash(body: string): string {
  return sha256Hex(normalizeText(body).trim());
}

export function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonStringify(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort(compareAscii);
  const parts: string[] = [];
  for (const key of keys) {
    const val = obj[key];
    if (val === undefined) {
      continue;
    }
    parts.push(`${JSON.stringify(key)}:${canonicalJsonStringify(val)}`);
  }
  return `{${parts.join(",")}}`;
}

export function estimateTokens(
  text: string,
  blocks: number,
  charsPerToken: number,
  safetyMargin: number,
): number {
  const utf8Bytes = Buffer.byteLength(text, "utf8");
  return Math.ceil((utf8Bytes / charsPerToken) * safetyMargin) + blocks * 4;
}

export function toPlainAscii(input: string): string {
  return normalizeLf(input)
    .normalize("NFKC")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\x20-\x7E]/g, "?")
    .replace(/ {2,}/g, " ")
    .trim();
}

export function truncateAscii(input: string, maxLen: number): string {
  const clean = toPlainAscii(input);
  if (clean.length <= maxLen) {
    return clean;
  }
  if (maxLen <= 3) {
    return clean.slice(0, Math.max(0, maxLen));
  }
  return `${clean.slice(0, maxLen - 3)}...`;
}

export function wrapAsciiLines(input: string, maxCols: number, continuationIndent = ""): string[] {
  const clean = toPlainAscii(input);
  if (clean.length <= maxCols) {
    return [clean];
  }
  const words = clean.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const prefix = lines.length === 0 ? "" : continuationIndent;
    const limit = maxCols;
    if (current.length === 0) {
      const candidate = prefix + word;
      if (candidate.length <= limit) {
        current = candidate;
      } else {
        const available = Math.max(1, limit - prefix.length);
        let offset = 0;
        while (offset < word.length) {
          const chunk = word.slice(offset, offset + available);
          if (offset + available < word.length) {
            lines.push(prefix + chunk);
          } else {
            current = prefix + chunk;
          }
          offset += available;
        }
      }
      continue;
    }
    if (current.length + 1 + word.length <= limit) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      const nextPrefix = continuationIndent;
      if (nextPrefix.length + word.length <= limit) {
        current = `${nextPrefix}${word}`;
      } else {
        const available = Math.max(1, limit - nextPrefix.length);
        let offset = 0;
        current = "";
        while (offset < word.length) {
          const chunk = word.slice(offset, offset + available);
          if (offset + available < word.length) {
            lines.push(nextPrefix + chunk);
          } else {
            current = nextPrefix + chunk;
          }
          offset += available;
        }
      }
    }
  }
  if (current.length > 0) {
    lines.push(current);
  }
  return lines;
}
