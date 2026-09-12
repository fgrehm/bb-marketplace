import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import "./app.css";

function UploadCard({ variant, description }: { variant: "light" | "dark"; description: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [fileName, setFileName] = useState<string>("");
  const [data, setData] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await rpc.call("get", { variant });
      setData(result.data);
    } catch { setData(null); }
  }, [rpc, variant]);

  useEffect(() => { void load(); }, [load]);

  async function remove() {
    setBusy(true);
    try {
      await rpc.call("remove", { variant });
      setData(null);
      setFileName("");
      window.dispatchEvent(new CustomEvent("bb-favicon-updated"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Remove failed.");
    } finally { setBusy(false); }
  }

  async function upload(file?: File) {
    if (!file) return;
    setError("");
    const isSvg = file.type === "image/svg+xml" || file.name.endsWith(".svg");
    if (!isSvg) { setError("Only SVG files are supported."); return; }
    if (file.size > 250_000) { setError("Maximum file size is 250 KB."); return; }
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      await rpc.call("upload", { variant, data: btoa(binary) });
      setFileName(file.name);
      void load();
      window.dispatchEvent(new CustomEvent("bb-favicon-updated"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Upload failed.");
    } finally { setBusy(false); }
  }

  return <div className={`favicon-card ${variant}`}>
    <div className="favicon-card-heading"><span className="favicon-swatch" /> <strong>{variant === "light" ? "Light mode" : "Dark mode"}</strong></div>
    <p>{description}</p>
    {data && (
      <div className="favicon-preview" aria-label={`Current ${variant} favicon`}>
        <img src={`data:image/svg+xml;base64,${data}`} alt="" width={48} height={48} />
        <span>48px preview</span>
      </div>
    )}
    <label className="file-button">
      {busy ? "Uploading..." : fileName ? "Replace file" : "Choose an SVG"}
      <input type="file" accept=".svg,image/svg+xml" disabled={busy} onChange={(event) => upload(event.currentTarget.files?.[0])} />
    </label>
    {fileName && <span className="filename">{fileName}</span>}
    {data && !fileName && <span className="filename">Uploaded</span>}
    {data && <button type="button" className="remove-button" onClick={() => void remove()} disabled={busy}>Remove</button>}
    {error && <span className="upload-error">{error}</span>}
  </div>;
}

function UploadFavicon() {
  return <section className="favicon-upload">
    <div className="favicon-intro"><div className="favicon-mark">✦</div><div><h3>Browser favicon</h3><p>Upload separate SVG artwork for light and dark mode. bb's favicon color tint is applied on top.</p></div></div>
    <div className="favicon-cards"><UploadCard variant="light" description="Used when BB is in light mode." /><UploadCard variant="dark" description="Used when BB is in dark mode." /></div>
    <p className="favicon-note">Changes apply after reloading the Favicon plugin.</p>
  </section>;
}

export default definePluginApp((app) => {
  app.slots.settingsSection({ id: "upload", title: "", component: UploadFavicon });
  app.contentScripts.register({
    id: "set-favicon",
    mount({ pluginId, signal }) {
      const FAVICON_COLOR_STORAGE_KEY = "bb.faviconColor";
      // Mirrors apps/app/src/lib/favicon-color-preference.ts in the bb client.
      const TINT_COLORS: Record<string, string> = {
        red: "#e5484d", orange: "#f76b15", yellow: "#ffba18", green: "#30a46c",
        teal: "#12a594", blue: "#0090ff", purple: "#8e4ec6", pink: "#d6409f",
      };
      const BADGE_FILL: [number, number, number] = [224, 0, 0]; // #e00000

      // We take over BB's own favicon links (#favicon-32 / #favicon-16) instead
      // of adding our own: browsers may ignore unlabeled links in favor of
      // BB's typed/sized ones. `lastWritten` guards against reacting to our
      // own writes, and `bbHref` remembers the last BB-authored href (which
      // our writes overwrite) so badge detection stays truthful.
      const targets = () =>
        ["favicon-32", "favicon-16"]
          .map((id) => document.getElementById(id))
          .filter((element): element is HTMLLinkElement => element instanceof HTMLLinkElement);

      let lastWritten: string | null = null;
      let bbHref: string | null = null;

      function artworkHref(variant: "light" | "dark", bust: number): string {
        return `/api/v1/plugins/${encodeURIComponent(pluginId)}/http/favicon?variant=${variant}&t=${bust}`;
      }

      function loadImage(src: string): Promise<HTMLImageElement> {
        return new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = () => reject(new Error(`Failed to load image: ${src}`));
          image.src = src;
        });
      }

      function readTintPreference(): string | null {
        try {
          const value = localStorage.getItem(FAVICON_COLOR_STORAGE_KEY);
          return value && value in TINT_COLORS ? value : null;
        } catch { return null; }
      }

      // BB composites the unread badge at a fixed dot position and fill
      // (getUnreadBadgeDot / UNREAD_BADGE_FILL in the bb client). Detect it by
      // sampling the last BB-authored favicon href at the dot's center.
      async function detectBadge(): Promise<boolean> {
        const href = bbHref ?? "";
        if (!href.startsWith("data:")) return false;
        try {
          const image = await loadImage(href);
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context) return false;
          context.drawImage(image, 0, 0);
          const scale = canvas.width / 32;
          const pixel = context.getImageData(Math.round(28 * scale), Math.round(6 * scale), 1, 1).data;
          const [r, g, b] = BADGE_FILL;
          return Math.abs(pixel[0] - r) <= 24 && Math.abs(pixel[1] - g) <= 24 && Math.abs(pixel[2] - b) <= 24;
        } catch { return false; }
      }

      let applyToken = 0;
      let cacheBust = Date.now();

      async function render(): Promise<void> {
        const token = ++applyToken;
        const badge = await detectBadge();
        const tint = readTintPreference();
        const variant: "light" | "dark" = darkQuery.matches ? "dark" : "light";
        if (token !== applyToken) return;
        try {
          const image = await loadImage(artworkHref(variant, cacheBust));
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth || 32; canvas.height = image.naturalHeight || 32;
          const context = canvas.getContext("2d");
          if (!context) return;
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          if (tint) {
            context.globalCompositeOperation = "source-in";
            context.fillStyle = TINT_COLORS[tint];
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.globalCompositeOperation = "source-over";
          }
          if (badge) {
            const scale = canvas.width / 32;
            context.beginPath();
            context.arc(28 * scale, 6 * scale, 3.5 * scale, 0, Math.PI * 2);
            context.fillStyle = "#e00000";
            context.fill();
          }
          const href = canvas.toDataURL("image/png");
          lastWritten = href;
          for (const link of targets()) link.setAttribute("href", href);
        } catch {
          // Artwork not configured or failed to load; leave BB's favicon visible.
        }
      }

      let scheduled = false;
      function scheduleRender(): void {
        if (scheduled) return;
        scheduled = true;
        queueMicrotask(() => { scheduled = false; void render(); });
      }

      // React to BB rewriting the favicon links, but ignore our own writes.
      // Record the last BB-authored 32px href for badge detection.
      const observer = new MutationObserver((mutations) => {
        let bbUpdated = false;
        for (const mutation of mutations) {
          const element = mutation.target;
          if (!(element instanceof HTMLLinkElement)) continue;
          const id = element.getAttribute("id");
          if (id !== "favicon-32" && id !== "favicon-16") continue;
          const href = element.getAttribute("href");
          if (href === lastWritten) continue;
          if (id === "favicon-32") bbHref = href;
          bbUpdated = true;
        }
        if (bbUpdated) scheduleRender();
      });
      observer.observe(document.head, { subtree: true, attributes: true, attributeFilter: ["href"] });
      const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
      const onSchemeChange = () => { void render(); };
      darkQuery.addEventListener("change", onSchemeChange);
      const refresh = () => { cacheBust = Date.now(); void render(); };
      window.addEventListener("bb-favicon-updated", refresh, { signal });
      const cleanup = () => { observer.disconnect(); darkQuery.removeEventListener("change", onSchemeChange); };
      signal.addEventListener("abort", cleanup, { once: true });
      void render();
      return cleanup;
    },
  });
});
