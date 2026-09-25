/**
 * Markdown-aware plain-text excerpts.
 *
 * Excerpts come from extracted markdown bodies (Defuddle, `gh`) and are shown
 * as plain text in list rows and reader fallbacks. Stripping markdown syntax
 * with a naive character filter leaves mangled fragments like
 * `! (https://host/logo.png) Title (https://host/doc)`, so this module first
 * collapses markdown constructs (images, links, emphasis, code, headings)
 * into their readable text, then cleans up whitespace and length.
 */
export function plainExcerpt(text: string, max = 500): string {
  return text
    .replace(/`{3,}[\s\S]*?(?:`{3,}|$)/g, " ") // fenced code blocks
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ") // inline html tags
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images: drop entirely
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links: keep the label
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1") // reference links: keep the label
    .replace(/^\s{0,3}#{1,6}\s+/gm, " ") // heading markers
    .replace(/^\s{0,3}>+\s?/gm, " ") // blockquote markers
    .replace(/^\s*[-*+]\s+/gm, " ") // list markers
    .replace(/[*_~`]+/g, " ") // emphasis, code, strikethrough markers
    .replace(/[\[\]]/g, " ")
    .replace(/https?:\/\/[^\s)]+/g, " ") // bare urls: excerpts are teasers, drop them
    .replace(/\(\s*\)/g, " ") // parens left empty by url/link removal
    .replace(/\s+([,.!?;:])/g, "$1") // tidy space left where markers were stripped
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trimEnd();
}