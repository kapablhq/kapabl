// SPDX-License-Identifier: Apache-2.0
// Escaping for values placed into generated Markdown and XML. Capability text is
// owner-reviewed data, but it must still not be able to change the document's structure.

/**
 * One line of Markdown text: newlines collapsed, characters that start structure escaped,
 * including block markers at the start of the line (lists, setext underlines).
 */
export function inlineMarkdown(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\`*_[\]<>|#~]/g, (c) => `\\${c}`)
    .replace(/^[-+=]/, (c) => `\\${c}`)
    .replace(/^(\d+)([.)])/, "$1\\$2");
}

function longestBacktickRun(text: string): number {
  return Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
}

/** A CommonMark code span that holds `text` verbatim, whatever backticks it contains. */
export function inlineCode(text: string): string {
  const fence = "`".repeat(longestBacktickRun(text) + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** A fenced code block whose fence is longer than any backtick run inside `text`. */
export function codeBlock(text: string, lang: string): string {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
  return `${fence}${lang}\n${text.trimEnd()}\n${fence}`;
}

export function xmlText(text: string): string {
  return text.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);
}
