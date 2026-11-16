import type { YouTubeVideo } from "./engine";

export const youtubeFavoritesKey = "sion-keys-youtube-favorites";

function favoriteVideo(value: unknown): YouTubeVideo | null {
  if (typeof value !== "object" || value === null) return null;
  const { id, title, channel, duration } = value as Partial<YouTubeVideo>;
  if (typeof id !== "string" || !/^[\w-]{11}$/.test(id) || typeof title !== "string" || !title.trim()) return null;
  return {
    id, title,
    channel: typeof channel === "string" ? channel : null,
    duration: typeof duration === "number" && Number.isFinite(duration) && duration >= 0 ? duration : null,
    views: null,
  };
}

export function readYoutubeFavorites(raw: string | null): YouTubeVideo[] {
  try {
    const entries: unknown = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(entries)) return [];
    const favorites = new Map<string, YouTubeVideo>();
    for (const item of entries) {
      const video = favoriteVideo(item);
      if (video && !favorites.has(video.id)) favorites.set(video.id, video);
    }
    return [...favorites.values()];
  } catch {
    return [];
  }
}

export function toggleYoutubeFavorite(storage: Pick<Storage, "getItem" | "setItem">, video: YouTubeVideo) {
  const current = readYoutubeFavorites(storage.getItem(youtubeFavoritesKey));
  const favorite = favoriteVideo(video);
  if (!favorite) return current;
  const next = current.some(item => item.id === favorite.id)
    ? current.filter(item => item.id !== favorite.id) : [favorite, ...current];
  storage.setItem(youtubeFavoritesKey, JSON.stringify(next));
  return next;
}
