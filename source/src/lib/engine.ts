/**
 * Talk to the Python chord engine via Tauri commands.
 * Audio retrieval follows Analyze, opening a saved recording, or Download MP3.
 */

import type { AnalysisResult, EngineEvent, HistoryEntry, Mp3Quality } from "./types";
import type { Language } from "./languages";
import { translate } from "./i18n";

const isTauri = () =>
  typeof window !== "undefined" &&
  // @ts-expect-error tauri global
  (window.__TAURI_INTERNALS__ != null || window.__TAURI__ != null);

type ProgressFn = (phase: string, pct: number, message?: string) => void;

function runEngineInvoke<T>(
  command: string,
  args: Record<string, unknown>,
  onProgress: ProgressFn,
  signal?: AbortSignal,
): Promise<T> {
  if (!isTauri()) {
    return Promise.reject(
      new Error(
        "Desktop shell required. Run with: npm run tauri:dev (browser-only Vite cannot spawn the engine).",
      ),
    );
  }

  return new Promise<T>((resolve, reject) => {
    let unlisten: (() => void) | undefined;
    let settled = false;
    let abortHandler: (()=>void) | undefined;

    const cleanup = () => {
      if(abortHandler) signal?.removeEventListener("abort",abortHandler);
      unlisten?.();
      unlisten = undefined;
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const ok = (r: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(r);
    };

    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const { listen } = await import("@tauri-apps/api/event");

        unlisten = await listen<EngineEvent>("engine-event", (ev) => {
          const p = ev.payload;
          if (p.type === "progress") {
            onProgress(p.phase, p.pct, p.message);
          }

        });

        if (signal) {
          abortHandler=()=>{void invoke("cancel_analysis").catch(()=>undefined);fail(new DOMException("Analysis cancelled","AbortError"));};
          if(signal.aborted){fail(new DOMException("Analysis cancelled","AbortError"));return;}
          signal.addEventListener("abort",abortHandler,{once:true});
        }

        const result = await invoke<T>(command, args);

        if (result && typeof result === "object" && "ok" in result) {
          const r = result as { ok: boolean; error?: string };
          if (r.ok === false) {
            fail(new Error(r.error || "Engine error"));
            return;
          }
          if (r.ok === true) {
            ok(result);
            return;
          }
        }
        fail(new Error("The analysis engine returned an invalid response."));
      } catch (e) {
        fail(e instanceof Error ? e : new Error(String(e)));
      }
    })();
  });
}

export async function analyzeLocalFile(
  path: string,
  name: string | undefined,
  onProgress: ProgressFn,
  signal?: AbortSignal,
): Promise<AnalysisResult> {
  return runEngineInvoke<AnalysisResult>(
    "analyze_file",
    { path, name: name ?? null },
    onProgress,
    signal,
  );
}

/** Analyze YouTube: downloads temp best-audio only (no permanent MP3). */
export async function analyzeYoutubeUrl(
  url: string,
  onProgress: ProgressFn,
  signal?: AbortSignal,
): Promise<AnalysisResult> {
  return runEngineInvoke<AnalysisResult>(
    "analyze_youtube",
    { url },
    onProgress,
    signal,
  );
}

/** Restore a saved recording while retaining its analysis and edits. */
export async function restoreYoutubeAudio(
  url: string, saved: AnalysisResult, onProgress: ProgressFn, signal?: AbortSignal,
): Promise<AnalysisResult> {
  const fetchAudio = () => runEngineInvoke<Pick<AnalysisResult, "source" | "cache">>(
    "analyze_youtube", { url, audioOnly: true }, onProgress, signal,
  );
  const recovered = await fetchAudio().catch(error => {
    // A media URL can expire after extraction. Retry once to request a fresh URL.
    if (signal?.aborted || !/unable to download video data: HTTP Error (403|5\d\d)\b/i.test(String(error))) throw error;
    return fetchAudio();
  });
  if (youtubeVideoId(url) !== recovered.source.youtubeId ||
      !Number.isFinite(recovered.source.durationSec) ||
      Math.abs(recovered.source.durationSec - saved.source.durationSec) > 0.5) {
    throw new Error("The reloaded recording differs from the saved analysis. Analyze the source again to update its timing.");
  }
  return {
    ...saved,
    source: { ...saved.source, ...recovered.source, name: saved.source.name, durationSec: saved.source.durationSec },
    cache: recovered.cache,
  };
}

/** Explicit Download MP3 — user-chosen path. */
export async function downloadYoutubeMp3(
  url: string,
  dest: string,
  quality: Mp3Quality,
  onProgress: ProgressFn,
  signal?: AbortSignal,
): Promise<{ ok: true; path: string; title?: string; quality: string }> {
  return runEngineInvoke(
    "download_youtube_mp3",
    { url, dest, quality },
    onProgress,
    signal,
  );
}

/** Export cached source (after Analyze) to MP3 — no re-download. */
export async function exportCachedMp3(
  source: string,
  dest: string,
  quality: Mp3Quality,
  onProgress: ProgressFn,
  signal?: AbortSignal,
): Promise<{ ok: true; path: string; quality: string }> {
  return runEngineInvoke(
    "export_mp3",
    { source, dest, quality },
    onProgress,
    signal,
  );
}

export async function cleanupYoutubeCache(keep?: string | null): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("cleanup_youtube_cache", { keep: keep ?? null });
}

export async function pickAudioFile(language: Language = "en"): Promise<{ path: string; name: string } | null> {
  if (!isTauri()) {
    return null;
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    title: translate(language, "Open audio file"),
    multiple: false,
    filters: [
      {
        name: translate(language, "Audio"),
        extensions: ["wav", "mp3", "flac", "ogg", "m4a", "aac", "webm", "opus"],
      },
    ],
  });
  if (!selected || Array.isArray(selected)) return null;
  const path = typeof selected === "string" ? selected : (selected as { path: string }).path;
  const name = path.split(/[/\\]/).pop() || "audio";
  return { path, name };
}

/**
 * Check if a path exists on the host filesystem.
 */
export async function checkPathExists(path: string): Promise<boolean> {
  if (!isTauri() || !path) return false;
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<boolean>("path_exists", { path });
}

function exportFileName(defaultName: string, extension: string, fallback: string): string {
  // A suggested name must stay a filename, never override the selected folder.
  let name = defaultName.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim().replace(/[. ]+$/, "");
  if (!name) name = fallback;
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return name.toLowerCase().endsWith(`.${extension}`) ? name : `${name}.${extension}`;
}

async function exportDefaultPath(name: string, defaultFolder: string): Promise<string> {
  if (!defaultFolder) return name;
  const { join } = await import("@tauri-apps/api/path");
  return join(defaultFolder, name);
}

export async function pickSaveMp3(
  defaultName = "audio.mp3", language: Language = "en", defaultFolder = "", askSaveLocation = true,
): Promise<string | null> {
  if (!isTauri()) return null;
  const defaultPath = await exportDefaultPath(exportFileName(defaultName, "mp3", "audio"), defaultFolder);
  if (!askSaveLocation && defaultFolder && await checkPathExists(defaultFolder)) return defaultPath;
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    title: translate(language, "Save MP3"),
    defaultPath,
    filters: [{ name: translate(language, "MP3"), extensions: ["mp3"] }],
  });
  return path ?? null;
}

export async function pickExportFolder(defaultFolder: string, language: Language): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    title: translate(language, "Choose export folder"),
    directory: true,
    multiple: false,
    ...(defaultFolder ? { defaultPath: defaultFolder } : {}),
  });
  return typeof selected === "string" ? selected : null;
}

/** Put a file name inside a chosen folder. */
export async function joinExportPath(folder: string, name: string): Promise<string> {
  const { join } = await import("@tauri-apps/api/path");
  return join(folder, name);
}

export async function pickSaveChordFile(
  defaultName: string, extension: "json" | "csv" | "html", language: Language, defaultFolder: string, askSaveLocation = true,
): Promise<string | null> {
  if (!isTauri()) return null;
  const defaultPath = await exportDefaultPath(exportFileName(defaultName, extension, "chords"), defaultFolder);
  if (!askSaveLocation && defaultFolder && await checkPathExists(defaultFolder)) return defaultPath;
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    title: translate(language, "Save chord sheet"),
    defaultPath,
    filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
  });
  return path ?? null;
}

/** Caller must check existence and confirm overwrite before invoking. */
export async function writeTextExport(path: string, text: string): Promise<void> {
  if (!isTauri()) throw new Error("Not in Tauri");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("write_text_export", { path, text });
}

export function isTauriRuntime(): boolean {
  return isTauri();
}

/** Read file bytes for Web Audio playback when path is absolute (Tauri). */
export async function readFileBytes(path: string): Promise<Uint8Array> {
  if (!isTauri()) throw new Error("Not in Tauri");
  const { invoke } = await import("@tauri-apps/api/core");
  const bytes = await invoke<number[]>("read_file_bytes", { path });
  return new Uint8Array(bytes);
}

/** Parse a single-video URL without contacting YouTube. */
export function youtubeVideoId(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    let id: string | null = null;
    if (host === "youtu.be") id = u.pathname.split("/")[1];
    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      if (u.pathname === "/watch") id = u.searchParams.get("v");
      else id = /^\/(?:shorts|live|embed)\/([^/]+)/.exec(u.pathname)?.[1] ?? null;
    }
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function isLikelyYoutubeUrl(raw: string): boolean {
  return youtubeVideoId(raw) !== null;
}

export function youtubeWatchUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}

export function recordingYoutubeId(source?: AnalysisResult["source"], entryUrl = "", entryPath = ""): string | null {
  if (source?.youtubeId && /^[\w-]{11}$/.test(source.youtubeId)) return source.youtubeId;
  const fromUrl = youtubeVideoId(source?.url ?? "") ?? youtubeVideoId(entryUrl);
  if (fromUrl) return fromUrl;
  // Older re-analyses could lose their source metadata. Only the app's own
  // temporary download layout identifies a recording by filename.
  for (const path of [source?.cachedSourcePath, source?.path, entryPath]) {
    const cached = path && /(?:^|[/\\])com\.chordai\.learn[/\\]youtube[/\\]job_\d+[/\\]([\w-]{11})\.(?:webm|m4a|opus|ogg|mp4|aac|mp3|wav)$/i.exec(path);
    if (cached) return cached[1];
  }
  return null;
}

export function repairYoutubeHistoryEntry(entry: HistoryEntry): HistoryEntry {
  const youtubeId = recordingYoutubeId(entry.result?.source, entry.url, entry.path);
  if (!youtubeId) return entry;
  const url = youtubeWatchUrl(youtubeId);
  const result = entry.result && {
    ...entry.result,
    source: { ...entry.result.source, fromYoutube: true, youtubeId, url },
  };
  return { ...entry, url, result };
}

export type YouTubeVideo = {
  id: string;
  title: string;
  channel: string | null;
  duration: number | null;
  views: number | null;
};

export const youtubeMetadata = new Map<string, YouTubeVideo>();
export async function searchYoutube(query: string): Promise<YouTubeVideo[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  const videos = await invoke<YouTubeVideo[]>("search_youtube", { query });
  for (const video of videos) youtubeMetadata.set(video.id, video);
  while (youtubeMetadata.size > 60) youtubeMetadata.delete(youtubeMetadata.keys().next().value!);
  return videos;
}

export async function storageUsage(): Promise<{ cacheBytes: number; engineReady: boolean }> {
  if (!isTauri()) return { cacheBytes: 0, engineReady: false };
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<{ cacheBytes: number; engineReady: boolean }>("storage_usage");
}
