const INTERNAL_OUTPUT_LINE = /^(?:propose_edit|soul_replace|identity_replace|user_replace|memory_replace|daily_log_append|contextual information retrieval and summarization)\b/i;

/**
 * Removes internal runtime and tool text only from the voice output. The chat
 * transcript remains unmodified so unexpected model behavior is still visible.
 */
export function sanitizeSpeech(text: string): string {
  return text
    .replace(/\[[A-Z][a-z]{2}\s[A-Z][a-z]{2}\s\d{2}\s\d{4}[^\]]*]\s*/g, "")
    .split(/\n+/)
    .filter((line) => {
      const normalized = line.trim().replace(/^["']+|["']+$/g, "");
      return normalized.length > 0 && !INTERNAL_OUTPUT_LINE.test(normalized);
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Pull every complete sentence out of a streaming text buffer. */
export function takeCompleteSentences(text: string): { chunks: string[]; remainder: string } {
  const chunks: string[] = [];
  let remainder = text;

  while (true) {
    const match = remainder.match(/^([\s\S]*?[.!?](?:\s|$))/);
    if (!match) return { chunks, remainder };
    const chunk = match[1];
    if (!chunk) return { chunks, remainder };
    chunks.push(chunk);
    remainder = remainder.slice(chunk.length);
  }
}
