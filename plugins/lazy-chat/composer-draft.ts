import type {
  ComposerDraftReplacement,
  ComposerDraftSnapshot,
  ComposerMention,
} from "@get-bb/plugin-sdk/app";

type TextChange = { from: number; oldTo: number; newTo: number };

function textChange(previous: string, next: string): TextChange {
  let from = 0;
  while (
    from < previous.length &&
    from < next.length &&
    previous[from] === next[from]
  )
    from += 1;

  let oldTo = previous.length;
  let newTo = next.length;
  while (
    oldTo > from &&
    newTo > from &&
    previous[oldTo - 1] === next[newTo - 1]
  ) {
    oldTo -= 1;
    newTo -= 1;
  }
  return { from, oldTo, newTo };
}

function matchingContext(
  previous: string,
  next: string,
  mention: ComposerMention,
  candidate: number,
): number {
  let score = 0;
  const contextLength = 32;
  for (let distance = 1; distance <= contextLength; distance += 1) {
    const before = previous[mention.from - distance];
    if (before === undefined || next[candidate - distance] !== before) break;
    score += 1;
  }
  for (let distance = 0; distance < contextLength; distance += 1) {
    const after = previous[mention.to + distance];
    if (
      after === undefined ||
      next[candidate + mention.to - mention.from + distance] !== after
    )
      break;
    score += 1;
  }
  return score;
}

function rebaseMention(
  mention: ComposerMention,
  change: TextChange,
  previous: string,
  next: string,
): ComposerMention | null {
  if (mention.to <= change.from) return mention;
  if (mention.from >= change.oldTo) {
    const delta = change.newTo - change.oldTo;
    return { ...mention, from: mention.from + delta, to: mention.to + delta };
  }

  const text = previous.slice(mention.from, mention.to);
  if (!text) return null;
  let bestAt: number | null = null;
  let bestScore = -1;
  let bestCount = 0;
  for (
    let at = next.indexOf(text);
    at !== -1;
    at = next.indexOf(text, at + 1)
  ) {
    const score = matchingContext(previous, next, mention, at);
    if (score > bestScore) {
      bestAt = at;
      bestScore = score;
      bestCount = 1;
    } else if (score === bestScore) {
      bestCount += 1;
    }
  }
  if (
    bestAt === null ||
    bestCount !== 1 ||
    (bestScore === 0 && bestAt !== mention.from)
  )
    return null;
  return { ...mention, from: bestAt, to: bestAt + text.length };
}

export function replaceComposerText(
  current: ComposerDraftSnapshot,
  text: string,
): ComposerDraftReplacement {
  const change = textChange(current.text, text);
  return {
    text,
    mentions: current.mentions
      .map((mention) => rebaseMention(mention, change, current.text, text))
      .filter((mention): mention is ComposerMention => mention !== null),
  };
}
