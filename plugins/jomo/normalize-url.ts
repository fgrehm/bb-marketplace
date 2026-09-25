const TRACKING_PARAM = /^(utm_.*|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|ref|ref_src|s|si)$/i;

function youtubeVideoId(url: URL): string | null {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "youtu.be") return /^\/([\w-]{11})(?:[/?#]|$)/.exec(url.pathname)?.[1] ?? null;
  if (host !== "youtube.com" && host !== "m.youtube.com" && host !== "music.youtube.com") return null;
  const v = url.searchParams.get("v");
  if (v && /^[\w-]{11}$/.test(v)) return v;
  return /^\/(?:shorts|embed|live|v)\/([\w-]{11})(?:[/?#]|$)/.exec(url.pathname)?.[1] ?? null;
}

/**
 * Canonical URL form: tracking parameters and the hash stripped, every
 * YouTube shape (youtu.be, watch, shorts, embed) folded to one watch URL,
 * so the same video reached via a share link, a short link, or a playlist
 * dedupes to one item instead of archiving under several forms.
 */
export function normalizeUrl(value: string): string {
  const parsed = new URL(value);
  for (const key of [...parsed.searchParams.keys()]) if (TRACKING_PARAM.test(key)) parsed.searchParams.delete(key);
  parsed.hash = "";
  const videoId = youtubeVideoId(parsed);
  if (videoId) {
    const timestamp = parsed.searchParams.get("t") ?? parsed.searchParams.get("start");
    return `https://www.youtube.com/watch?v=${videoId}${timestamp ? `&t=${encodeURIComponent(timestamp)}` : ""}`;
  }
  return parsed.toString();
}

/**
 * Follow redirects manually (cap 10 hops), normalizing each hop, so archives
 * land under the final origin's domain rather than the shortener's.
 * Origins that reject HEAD keep their incoming URL as-is.
 */
export async function resolveUrl(value: string, fetchPage: typeof fetch = fetch, signal?: AbortSignal): Promise<string> {
  let current = normalizeUrl(value);
  for (let hop = 0; hop < 10; hop++) {
    let response: Response;
    try {
      response = await fetchPage(current, { method: "HEAD", redirect: "manual", signal });
    } catch {
      return current;
    }
    if (response.status === 405 || response.status === 501) return current;
    const location = response.headers.get("location");
    if (!location || !String(response.status).startsWith("3")) return current;
    current = normalizeUrl(new URL(location, current).toString());
  }
  return current;
}