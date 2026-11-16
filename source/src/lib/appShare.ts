import type { Language } from "./languages";
import type { ThemeId } from "./types";

export const APP_SHARE_COPY = "Find the key and chords of your favorite songs, follow the music, and practice with interactive piano, guitar, and bass diagrams.";
export const APP_SHARE_TITLE = "Discover Sion Keys!";
export const APP_SHARE_UNAVAILABLE = "The public Sion Keys page is not configured yet.";
export const SHARE_PLATFORMS = ["Instagram", "TikTok", "Facebook", "WhatsApp", "X", "Telegram"] as const;
export type SharePlatform = typeof SHARE_PLATFORMS[number];
export type ShareDesign = "light" | "dark";

export function shareDesign(theme: ThemeId): ShareDesign {
  return theme === "orange" || theme === "white" ? "light" : "dark";
}

export function publicShareBase(value: unknown): URL | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return null;
    const pages = /^[a-z0-9][a-z0-9-]*\.github\.io$/i.test(url.hostname);
    const project = url.hostname === "github.com"
      && /^\/[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+(?:\/releases(?:\/latest|\/tag\/[a-z0-9_.-]+)?)?\/?$/i.test(url.pathname);
    return pages || project ? url : null;
  } catch {
    return null;
  }
}

export function socialPage(base: URL, language: Language, design: ShareDesign) {
  return base.hostname.endsWith(".github.io")
    ? new URL(`share/${design}/${language}/`, base.href.replace(/\/?$/, "/")).href
    : base.href;
}

export function appShareTargets(language: Language, design: ShareDesign, title: string, description: string, base: URL | null) {
  const url = base && socialPage(base, language, design);
  const caption = url ? `${title}\n\n${description}\n\n${url}` : "";
  const text = `${title}\n\n${description}`;
  const target = (path: string, params: Record<string, string>) => `${path}?${new URLSearchParams(params)}`;
  return {
    caption,
    targets: {
      Instagram: url ? "https://www.instagram.com/" : undefined,
      TikTok: url ? "https://www.tiktok.com/upload" : undefined,
      Facebook: url ? target("https://www.facebook.com/sharer/sharer.php", { u: url }) : undefined,
      WhatsApp: url ? target("https://wa.me/", { text: caption }) : undefined,
      X: url ? target("https://twitter.com/intent/tweet", { text: title, url }) : undefined,
      Telegram: url ? target("https://t.me/share/url", { url, text }) : undefined,
    },
  };
}
