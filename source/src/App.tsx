import { useSmartLyrics } from "./lib/smartLyrics";
import { HeaderWave } from "./components/HeaderWave";
import { languageDirection, languages, navLabels, type Language } from "./lib/languages";
import { localizeMessage, translate } from "./lib/i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ChordDashboard, { type ChordDashboardShortcuts } from "./components/ChordDashboard";
import { Sidebar } from "./components/Sidebar";
import { TitleBar } from "./components/TitleBar";
import { LanguagePicker } from "./components/LanguagePicker";
import { Icon } from "./components/Icon";
import { SettingsPage, MP3_QUALITY_LABELS } from "./components/SettingsPage";
import { PresenceGlow } from "./components/PresenceGlow";
import { HistoryPage } from "./components/HistoryPage";
import { AboutPage } from "./components/AboutPage";
import { DiagnosticDetails } from "./components/DiagnosticDetails";
import { AnalyzeGuide } from "./components/AnalyzeGuide";
import { useAppUpdates } from "./components/UpdateSettings";
import { contributeAnalysis, localRecordingKey, readSharedAnalysis } from "./lib/sharedLibrary";

import { AudioPlayer } from "./lib/audioPlayer";
import {
  analyzeLocalFile,
  analyzeYoutubeUrl,
  restoreYoutubeAudio,
  cleanupYoutubeCache,
  downloadYoutubeMp3,
  exportCachedMp3,
  isLikelyYoutubeUrl,
  youtubeVideoId,
  youtubeWatchUrl,
  recordingYoutubeId,
  repairYoutubeHistoryEntry,
  isTauriRuntime,
  pickAudioFile,
  pickSaveMp3,
  pickExportFolder,
  joinExportPath,
  checkPathExists,
  readFileBytes,
  storageUsage,
  pickSaveChordFile,
  writeTextExport,
} from "./lib/engine";
import { downloadText, printableChart, resultToCsv, resultToJson } from "./lib/format";
import { transposeChordLabel } from "./lib/practice";
import { acceptsShortcut, actionForKey, readShortcuts, shortcutStorageKey } from "./lib/shortcuts";
import type { AnalysisResult, AppStatus, HistoryEntry, Mp3Quality, NavId, ThemeId } from "./lib/types";

const THEME_KEY = "chord-ai-theme";
const VOLUME_KEY = "chord-ai-volume";
const HISTORY_KEY = "chord-ai-history";
const MP3_QUALITY_KEY = "chord-ai-mp3-quality";
const AUTOPLAY_KEY = "hearthkeys-autoplay-preview";
const MP3_FOLDER_KEY = "hearthkeys-mp3-export-folder";
const ASK_SAVE_KEY = "hearthkeys-ask-save-location";
const CHORD_FOLDER_KEY = "hearthkeys-chord-export-folder";
const GLOW_KEY = "hearthkeys-edge-glow";
const COMPACT_KEY = "hearthkeys-compact-layout";
const NAV_ICON: Record<NavId, string> = { analyze: "bars", history: "clock", settings: "settings", about: "info" };
const NAV_SUBTITLE: Record<NavId, string> = {
  analyze: "Detect the key and chords from an audio file or a YouTube link.",
  history: "Your past analyses and opened songs",
  settings: "Customize Sion Keys to fit your workflow.",
  about: "Learn more about Sion Keys, its purpose, and the people behind it.",
};
type Mp3Notice = { kind: "working" | "saved" | "failed" | "cancelled"; detail: string; pct?: number; phase?: string };

function loadTheme(): ThemeId {
  const t = localStorage.getItem(THEME_KEY);
  if (t === "orange" || t === "purple" || t === "blue" || t === "white") return t;
  return "white";
}

function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const entries: unknown = JSON.parse(raw);
    return Array.isArray(entries) ? entries.filter(entry => entry && typeof entry === "object")
      .map(repairYoutubeHistoryEntry) : [];
  } catch {
    return [];
  }
}

function loadMp3Quality(): Mp3Quality {
  const q = localStorage.getItem(MP3_QUALITY_KEY);
  if (q === "high" || q === "192" || q === "128") return q;
  return "high";
}

function mimeForName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "wav";
  if (ext === "mp3") return "audio/mpeg";
  if (ext === "wav") return "audio/wav";
  if (ext === "ogg" || ext === "opus") return "audio/ogg";
  if (ext === "aac") return "audio/aac";
  if (ext === "m4a" || ext === "mp4") return "audio/mp4";
  if (ext === "webm") return "audio/webm";
  if (ext === "flac") return "audio/flac";
  return "audio/*";
}

export default function App() {
  const [language, setLanguage] = useState<Language>(() => {
    const saved = localStorage.getItem("hearthkeys-language");
    return saved && Object.hasOwn(languages, saved) ? saved as Language : "en";
  });
  const labels = languages[language];
  const t = (key: string, params?: Record<string, string | number>) => translate(language, key, params);
  const proseDirection = languageDirection(language);
  useEffect(() => {
    localStorage.setItem("hearthkeys-language", language);
    document.documentElement.lang = language;
    document.title = translate(language, "Sion Keys · Chord & Key Analyzer");
  }, [language]);
  const [theme, setTheme] = useState<ThemeId>(loadTheme);
  // The printed key offset. It moves every chord name the app shows and the
  // chord sheets it writes; the recording and the detected times stay as they
  // are.
  const [transpose, setTranspose] = useState(0);
  const [autoplayPreview] = useState(() => localStorage.getItem(AUTOPLAY_KEY) !== "0");
  const [nav, setNav] = useState<NavId>("analyze");
  const [shortcuts, setShortcuts] = useState(() => readShortcuts(localStorage.getItem(shortcutStorageKey)));
  const dashboardShortcuts = useRef<ChordDashboardShortcuts>(null);
  const [youtubeSearchRequested, setYoutubeSearchRequested] = useState(false);
  const onYoutubeSearchFocused = useCallback(() => setYoutubeSearchRequested(false), []);
  useEffect(() => { localStorage.setItem(shortcutStorageKey, JSON.stringify(shortcuts)); }, [shortcuts]);
  const [showWelcome, setShowWelcome] = useState(false);
  const welcomeOpen = useRef(false);
  const setWelcome = useCallback((open: boolean) => {
    welcomeOpen.current = open;
    setShowWelcome(open);
  }, []);
  const { lookup: lyricsLookup, start: startLyrics, attach: attachLyrics, cancel: cancelLyrics, action: lyricsAction } = useSmartLyrics();
  const [status, setStatus] = useState<AppStatus>({ kind: "idle" });
  const [history, setHistory] = useState<HistoryEntry[]>(loadHistory);
  const [currentTime, setCurrentTime] = useState(0);
  const [volume, setVolume] = useState(() => {
    const stored = localStorage.getItem(VOLUME_KEY);
    const value = stored === null ? 0.75 : Number(stored);
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.75;
  });
  const [playing, setPlaying] = useState(false);
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [mp3Quality, setMp3Quality] = useState<Mp3Quality>(loadMp3Quality);
  const [askSaveLocation, setAskSaveLocation] = useState(() => localStorage.getItem(ASK_SAVE_KEY) !== "0");
  useEffect(() => { localStorage.setItem(ASK_SAVE_KEY, askSaveLocation ? "1" : "0"); }, [askSaveLocation]);
  const [edgeGlow, setEdgeGlow] = useState(() => localStorage.getItem(GLOW_KEY) !== "0");
  const [compactLayout, setCompactLayout] = useState(() => localStorage.getItem(COMPACT_KEY) === "1");
  useEffect(() => { localStorage.setItem(GLOW_KEY, edgeGlow ? "1" : "0"); }, [edgeGlow]);
  useEffect(() => {
    localStorage.setItem(COMPACT_KEY, compactLayout ? "1" : "0");
    if (compactLayout) document.documentElement.setAttribute("data-compact", "1");
    else document.documentElement.removeAttribute("data-compact");
  }, [compactLayout]);
  const [mp3Folder, setMp3Folder] = useState(() => localStorage.getItem(MP3_FOLDER_KEY) || "");
  const [chordFolder, setChordFolder] = useState(() => localStorage.getItem(CHORD_FOLDER_KEY) || "");
  const textExportBusy = useRef(false);
  const rememberedAudio = useRef(new Map<string, string>());
  const [exportNotice, setExportNotice] = useState<{ saved: boolean; detail: string } | null>(null);
  useEffect(() => { localStorage.setItem(MP3_FOLDER_KEY, mp3Folder); }, [mp3Folder]);
  useEffect(() => { localStorage.setItem(CHORD_FOLDER_KEY, chordFolder); }, [chordFolder]);
  const [version, setVersion] = useState("");
  const [cacheNotice, setCacheNotice] = useState("");
  const [cacheError, setCacheError] = useState("");
  const [cacheBusy, setCacheBusy] = useState(false);
  const [storage, setStorage] = useState<{ cacheBytes: number | null; engineReady: boolean }>({ cacheBytes: null, engineReady: false });
  const [mp3Busy, setMp3Busy] = useState(false);
  const [mp3Notice, setMp3Notice] = useState<Mp3Notice | null>(null);
  const mp3Job = useRef<AbortController | null>(null);
  const previewTimer = useRef<number | null>(null);
  const autoplayEnabled = useRef(autoplayPreview);
  const [confirmDialog, setConfirmDialog] = useState<{
    path: string;
    onConfirm: () => void;
    onCancel: () => void;
  } | null>(null);
  const [actionDialog, setActionDialog] = useState<{
    title: string;
    body: string;
    detail?: string;
    confirmLabel: string;
    onConfirm: () => void;
  } | null>(null);

  const [player] = useState(() => new AudioPlayer());
  useEffect(() => {
    player.volume = volume;
    localStorage.setItem(VOLUME_KEY, String(volume));
  }, [player, volume]);
  const abortRef = useRef<AbortController | null>(null);
  const pendingCacheCleanup = useRef<Promise<void>>(Promise.resolve());
  const tauri = useMemo(() => isTauriRuntime(), []);
  const updates = useAppUpdates(tauri);

  useEffect(() => {
    if (tauri) void import("@tauri-apps/api/app").then(({ getVersion }) => getVersion())
      .then(setVersion).catch(() => {});
  }, [tauri]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    autoplayEnabled.current = autoplayPreview;
    localStorage.setItem(AUTOPLAY_KEY, autoplayPreview ? "1" : "0");
    if (!autoplayPreview && previewTimer.current !== null) {
      clearTimeout(previewTimer.current);
      previewTimer.current = null;
      player.pause();
    }
  }, [autoplayPreview, player]);

  useEffect(() => {
    if (nav !== "settings" || !tauri) return;
    let live = true;
    void storageUsage().then(
      (usage) => { if (live) setStorage(usage); },
      () => { if (live) setStorage({ cacheBytes: null, engineReady: false }); },
    );
    return () => { live = false; };
  }, [nav, tauri, history, cacheBusy, status.kind, mp3Busy]);

  const historyBytes = useMemo(() => new TextEncoder().encode(localStorage.getItem(HISTORY_KEY) ?? "").length, [history]);

  useEffect(() => {
    localStorage.setItem(MP3_QUALITY_KEY, mp3Quality);
  }, [mp3Quality]);

  useEffect(() => {
    const p = player;
    return p.subscribe((t, pl) => {
      setCurrentTime(t);
      setPlaying(pl);
    });
  }, []);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      cancelLyrics();
      mp3Job.current?.abort();
      if (previewTimer.current !== null) clearTimeout(previewTimer.current);
      previewTimer.current = null;
      player.dispose();
      // Clear YouTube cache on quit (best-effort)
      void cleanupYoutubeCache(null);
    };
  }, []);

  const pushHistory = useCallback((entry: HistoryEntry) => {
    setHistory((prev) => {
      const next = [entry, ...prev.filter(h => (h.url || h.path) !== (entry.url || entry.path))].slice(0, 40);
      // Keep the most recent results when the local library reaches its storage quota.
      while (next.length) {
        try {
          localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
          return next;
        } catch {
          next.pop();
        }
      }
      return prev;
    });
  }, []);

  const clearHistory = useCallback(() => {
    setHistory([]);
    localStorage.removeItem(HISTORY_KEY);
  }, []);

  const askOverwrite = useCallback(
    async (path: string): Promise<boolean> => {
      const exists = await checkPathExists(path);
      if (!exists) return true;
      return new Promise((resolve) => {
        setConfirmDialog({
          path,
          onConfirm: () => {
            setConfirmDialog(null);
            resolve(true);
          },
          onCancel: () => {
            setConfirmDialog(null);
            resolve(false);
          },
        });
      });
    },
    [],
  );

  const releaseCache = useCallback((keep?: string | null) => {
    const cleanup = pendingCacheCleanup.current
      .then(() => cleanupYoutubeCache(keep ?? null))
      .catch(() => {});
    pendingCacheCleanup.current = cleanup;
    return cleanup;
  }, []);

  const cancelPreview = useCallback(() => {
    if (previewTimer.current !== null) {
      clearTimeout(previewTimer.current);
      previewTimer.current = null;
    }
  }, []);

  const startPreview = useCallback(() => {
    if (welcomeOpen.current) return;
    cancelPreview();
    player.seek(0);
    void player.play().catch(() => {});
    previewTimer.current = window.setTimeout(() => {
      previewTimer.current = null;
      player.pause();
    }, 15000);
  }, [player, cancelPreview]);

  const clearSong = useCallback(() => {
    if (mp3Job.current) return;
    cancelPreview();
    abortRef.current?.abort();
    cancelLyrics();
    abortRef.current = null;
    player.clear();
    setStatus({ kind: "idle" });
    setCurrentTime(0);
    setPlaying(false);
    void releaseCache(null);
  }, [player, releaseCache, cancelPreview]);

  const goHome = () => {
    cancelPreview();
    player.pause();
    setWelcome(true);
    setNav("analyze");
  };

  const changeYoutubeUrl = (value: string) => {
    if (mp3Job.current) return;
    setYoutubeUrl(value);
  };

  const saveAnalysis = useCallback((result: AnalysisResult, playbackPath: string) => {
    const { cache: _cache, ...analysis } = result;
    const { cachedSourcePath: _cachedSource, ...source } = analysis.source;
    const id = source.fromYoutube ? source.youtubeId ?? youtubeVideoId(source.url ?? "") : null;
    const url = id ? youtubeWatchUrl(id) : undefined;
    pushHistory({
      id: `${Date.now()}`,
      name: result.source.name,
      path: source.fromYoutube ? "" : playbackPath,
      url,
      result: { ...analysis, source: { ...source, url, path: source.fromYoutube ? "" : playbackPath } },
      keyLabel: result.key.label,
      durationSec: result.source.durationSec,
      analyzedAt: new Date().toISOString(),
    });
  }, [pushHistory]);

  const finishReady = useCallback(
    async (result: AnalysisResult, playbackPath: string, signal: AbortSignal,
      saveToHistory = true, requirePlayback = false, preloadedAudio?: Uint8Array) => {
      signal.throwIfAborted();
      attachLyrics(result.source);
      const cached =
        result.source.cachedSourcePath ||
        result.cache?.sourcePath ||
        (result.source.fromYoutube ? result.source.path || null : null) ||
        null;
      const cacheDir = result.cache?.dir || null;
      if (cached) {
        // Drop other jobs; keep this source
        await releaseCache(cached);
      } else {
        await releaseCache(null);
      }

      signal.throwIfAborted();
      let objectUrl = "";
      let playbackError: string | undefined;
      try {
        if (!playbackPath) throw new Error("Saved analysis. Click Analyze to load the YouTube audio again.");
        if (!saveToHistory && !(await checkPathExists(playbackPath))) {
          throw new Error("Original audio is missing. Browse for the file to analyze it again.");
        }
        signal.throwIfAborted();
        const bytes = preloadedAudio ?? await readFileBytes(playbackPath);
        signal.throwIfAborted();
        objectUrl = await player.loadFromBytes(bytes, mimeForName(playbackPath));
      } catch (e) {
        signal.throwIfAborted();
        if (requirePlayback) throw e;
        player.clear();
        playbackError = e instanceof Error ? e.message : String(e);
      }
      signal.throwIfAborted();

      if (saveToHistory) {
        const id = result.source.youtubeId ?? youtubeVideoId(result.source.url ?? "");
        const saved = loadHistory().find(entry => id ? youtubeVideoId(entry.url ?? "") === id : entry.path === playbackPath)?.result;
        // Reattach manual edits only if the fresh engine returned the same original segments.
        if (saved?.originalChords && JSON.stringify(saved.originalChords) === JSON.stringify(result.chords)) {
          result = { ...result, chords: saved.chords, originalChords: saved.originalChords };
        }
      }
      const remembered = cached || playbackPath;
      if (remembered) {
        const videoId = result.source.youtubeId ?? youtubeVideoId(result.source.url ?? "");
        if (result.source.fromYoutube && videoId) rememberedAudio.current.set(`yt:${videoId}`, remembered);
        rememberedAudio.current.set(`file:${remembered}`, remembered);
      }
      setStatus({
        kind: "ready",
        result,
        filePath: playbackPath,
        objectUrl,
        playbackError,
        cachedSourcePath: cached,
        cacheDir,
      });
      if (saveToHistory) saveAnalysis(result, playbackPath);
      if (saveToHistory && autoplayEnabled.current && objectUrl) startPreview();
      return objectUrl;
    },
    [player, saveAnalysis, releaseCache, startPreview, attachLyrics],
  );

  const runLocalAnalysis = useCallback(
    async (path: string, name: string, held?: AnalysisResult) => {
      if (mp3Job.current) return;
      setWelcome(false);
      abortRef.current?.abort();
      if (!held) cancelLyrics();
      const ac = new AbortController();
      abortRef.current = ac;
      if (!held) startLyrics({ path, name }, ac.signal);

      setStatus({ kind: "loading", phase: "start", pct: 0, message: "Starting…", held });
      cancelPreview();
      player.clear();

      try {
        await releaseCache(held ? path : null);
        ac.signal.throwIfAborted();
        let recording: string | undefined;
        let preloadedAudio: Uint8Array | undefined;
        try {
          preloadedAudio = await readFileBytes(path);
          ac.signal.throwIfAborted();
          recording = await localRecordingKey(preloadedAudio);
        } catch { ac.signal.throwIfAborted(); }
        if (recording && !held) {
          const shared = await readSharedAnalysis(recording, ac.signal).catch(() => null);
          ac.signal.throwIfAborted();
          if (shared) {
            const result = { ...shared, source: { ...shared.source, name, path, libraryRecording: recording } };
            try { return await finishReady(result, path, ac.signal, true, true, preloadedAudio); }
            catch { ac.signal.throwIfAborted(); }
          }
        }
        const result = await analyzeLocalFile(
          path,
          name,
          (phase, pct, message) => {
            if (!ac.signal.aborted && abortRef.current === ac) setStatus({ kind: "loading", phase, pct, message, held });
          },
          ac.signal,
        );
        if (recording) {
          result.source.libraryRecording = recording;
          void contributeAnalysis(recording, result).catch(() => {});
        }
        return await finishReady(result, path, ac.signal, true, false, preloadedAudio);
      } catch (e) {
        if (abortRef.current !== ac) return;
        if (e instanceof DOMException && e.name === "AbortError") {
          setStatus({ kind: "idle" });
          await releaseCache(null);
          return;
        }
        const msg = e instanceof Error ? e.message : String(e);
        if (held) setStatus({ kind: "ready", result: held, filePath: path, objectUrl: "", playbackError: msg });
        else setStatus({ kind: "error", message: msg });
        await releaseCache(held ? path : null);
      } finally {
        if (abortRef.current === ac) abortRef.current = null;
      }
    },
    [finishReady, player, releaseCache, cancelPreview, startLyrics, cancelLyrics, setWelcome],
  );

  const runYoutubeAnalysis = useCallback(async (sourceUrl?: string, saved?: AnalysisResult, held?: AnalysisResult) => {
    if (mp3Job.current) return;
    setWelcome(false);
    const url = (sourceUrl ?? youtubeUrl).trim();
    const videoId = youtubeVideoId(url);
    if (!videoId) {
      setStatus({ kind: "error", message: "Enter a single-video YouTube URL before Analyze." });
      return;
    }
    const cacheKey = `yt:${videoId}`;
    const reused = saved ? undefined : rememberedAudio.current.get(cacheKey);
    abortRef.current?.abort();
    if (!saved && !held) cancelLyrics();
    const ac = new AbortController();
    abortRef.current = ac;
    // Reloading playback for the same recording keeps the selected lyric body in memory.
    if (!saved && !held) startLyrics({ url }, ac.signal);

    const downloadMessage = saved ? "Preparing audio…" : "Loading temporary audio for analysis…";
    setStatus({ kind: "loading", phase: reused ? "start" : "download", pct: 0,
      message: reused ? "Starting…" : downloadMessage, held: held ?? saved, recoveringAudio: !!saved });
    cancelPreview();
    player.clear();

    try {
      const contribute = (result: AnalysisResult) => { void contributeAnalysis(videoId, result).catch(() => {}); };
      const progress = (phase: string, pct: number, message?: string) => {
        if (!ac.signal.aborted && abortRef.current === ac) setStatus({
          kind: "loading", phase, pct, held: held ?? saved, recoveringAudio: !!saved,
          message: phase === "download" ? downloadMessage : message,
        });
      };
      if (reused) {
        try {
          await releaseCache(reused);
          ac.signal.throwIfAborted();
          if (await checkPathExists(reused)) {
            ac.signal.throwIfAborted();
            const name = held?.source.name || loadHistory().find(entry => youtubeVideoId(entry.url ?? "") === videoId)?.name;
            const cached = await analyzeLocalFile(reused, name, progress, ac.signal);
            const result = {
              ...cached,
              source: { ...cached.source, path: reused, cachedSourcePath: reused,
                fromYoutube: true, youtubeId: videoId, url: youtubeWatchUrl(videoId) },
              cache: { sourcePath: reused },
            };
            const playback = await finishReady(result, reused, ac.signal, true, true);
            contribute(result);
            return playback;
          }
        } catch {
          ac.signal.throwIfAborted();
        }
        if (rememberedAudio.current.get(cacheKey) === reused) rememberedAudio.current.delete(cacheKey);
        progress("download", 0);
      }
      await releaseCache(null);
      ac.signal.throwIfAborted();
      if (!saved && !held) {
        const shared = await readSharedAnalysis(videoId, ac.signal).catch(() => null);
        ac.signal.throwIfAborted();
        if (shared) {
          try {
            const restored = await restoreYoutubeAudio(url, shared, progress,
              AbortSignal.any([ac.signal, AbortSignal.timeout(120000)]));
            return await finishReady(restored, restored.source.cachedSourcePath || restored.source.path, ac.signal, true, true);
          } catch {
            ac.signal.throwIfAborted();
            await releaseCache(null);
            ac.signal.throwIfAborted();
          }
        }
      }
      const result = saved
        ? await restoreYoutubeAudio(url, saved, progress, AbortSignal.any([ac.signal, AbortSignal.timeout(120000)]))
        : await analyzeYoutubeUrl(url, progress, ac.signal);
      const playPath =
        result.source.cachedSourcePath || result.cache?.sourcePath || result.source.path;
      const playback = await finishReady(result, playPath, ac.signal, !saved);
      if (!saved) contribute(result);
      return playback;
    } catch (e) {
      if (abortRef.current !== ac) return;
      if (!saved && e instanceof DOMException && e.name === "AbortError") {
        setStatus({ kind: "idle" });
        await releaseCache(null);
        return;
      }
      const msg = e instanceof DOMException && e.name === "AbortError" && saved
        ? "Playback unavailable" : e instanceof Error ? e.message : String(e);
      if (saved) {
        attachLyrics(saved.source);
        setStatus({ kind: "ready", result: saved, filePath: "", objectUrl: "", playbackError: msg });
      } else if (held) {
        setStatus({ kind: "ready", result: held, filePath: "", objectUrl: "", playbackError: msg });
      } else setStatus({ kind: "error", message: msg });
      await releaseCache(null);
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
    }
  }, [finishReady, player, releaseCache, youtubeUrl, cancelPreview, startLyrics, cancelLyrics, attachLyrics, setWelcome]);

  const reopenHistory = async (entry: HistoryEntry, autoplay = false) => {
    if (mp3Job.current || abortRef.current) return;
    cancelPreview();
    setNav("analyze");
    setWelcome(false);
    setYoutubeUrl(entry.url ?? "");
    if (!entry.result) {
      const url = entry.url && isLikelyYoutubeUrl(entry.url)
        ? await runYoutubeAnalysis(entry.url) : await runLocalAnalysis(entry.path, entry.name);
      if (autoplay && url && !welcomeOpen.current) {
        cancelPreview();
        void player.play().catch(() => {});
      }
      return;
    }
    const ac = new AbortController();
    abortRef.current = ac;
    startLyrics(entry.result.source, ac.signal);
    player.clear();
    setStatus({ kind: "loading", phase: "start", pct: 0, message: "Opening saved analysis…", held: entry.result });
    try {
      const videoId = entry.result.source.youtubeId ?? youtubeVideoId(entry.url ?? entry.result.source.url ?? "");
      const remembered = videoId ? rememberedAudio.current.get(`yt:${videoId}`) : rememberedAudio.current.get(`file:${entry.path}`);
      const kept = remembered && await checkPathExists(remembered) ? remembered : "";
      const opened = kept ? {
        ...entry.result,
        source: { ...entry.result.source, cachedSourcePath: kept },
        cache: { dir: entry.result.cache?.dir ?? "", sourcePath: kept },
      } : entry.result;
      const playbackPath = kept || entry.path;
      let url = playbackPath || !videoId ? await finishReady(opened, playbackPath, ac.signal, false) : "";
      ac.signal.throwIfAborted();
      if (!url && videoId && abortRef.current === ac) {
        abortRef.current = null;
        url = await runYoutubeAnalysis(youtubeWatchUrl(videoId), entry.result) || "";
      }
      if (autoplay && url && !welcomeOpen.current) void player.play().catch(() => {});
    } catch (error) {
      if (abortRef.current !== ac) return;
      if (ac.signal.aborted) setStatus({ kind: "idle" });
      else setStatus({ kind: "error", message: String(error) });
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
    }
  };

  const removeHistory = useCallback((ids: ReadonlySet<string>) => {
    setHistory((prev) => {
      const next = prev.filter((h) => !ids.has(h.id));
      if (next.length) localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      else localStorage.removeItem(HISTORY_KEY);
      return next;
    });
  }, []);

  const askClearHistory = () => setActionDialog({
    title: t("Clear history?"),
    body: t("Remove all past analyses from this device. This cannot be undone."),
    confirmLabel: t("Clear history"),
    onConfirm: () => { setActionDialog(null); clearHistory(); },
  });

  const askRemoveHistory = (entry: HistoryEntry) => setActionDialog({
    title: t("Remove entry?"),
    body: t("Remove this entry from history? The saved analysis will be deleted from this device."),
    detail: entry.name,
    confirmLabel: t("Remove from history"),
    onConfirm: () => { setActionDialog(null); removeHistory(new Set([entry.id])); },
  });

  const askRemoveSelectedHistory = (entries: HistoryEntry[]) => {
    if (entries.length === 1) {
      askRemoveHistory(entries[0]);
      return;
    }
    const ids = new Set(entries.map(entry => entry.id));
    setActionDialog({
      title: t("Delete selected"),
      body: t("Remove the selected analyses from history?"),
      confirmLabel: t("Delete selected"),
      onConfirm: () => { setActionDialog(null); removeHistory(ids); },
    });
  };

  const clearCache = useCallback(async () => {
    if (abortRef.current || mp3Job.current) return;
    setCacheError("");
    setCacheBusy(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("clear_analysis_cache");
      setCacheNotice("Analysis cache cleared. Saved History is still available.");
    } catch (error) {
      setCacheNotice("Could not clear the analysis cache.");
      setCacheError(error instanceof Error ? error.message : String(error));
    } finally {
      setCacheBusy(false);
    }
  }, []);

  const saveMp3 = async (mode: "download" | "export", entries: readonly (HistoryEntry | undefined)[] = [undefined]) => {
    if (mp3Job.current || textExportBusy.current || abortRef.current || status.kind === "loading") return;
    const ac = new AbortController();
    mp3Job.current = ac;
    setMp3Busy(true);
    setMp3Notice(null);
    setExportNotice(null);
    try {
      // A batch asks for the folder once. Every song then lands in it with
      // its own file name, so the native dialog is not repeated per song.
      const batch = entries.length > 1;
      let batchFolder = "";
      if (batch) {
        if (!askSaveLocation && mp3Folder && await checkPathExists(mp3Folder)) {
          batchFolder = mp3Folder;
        } else {
          batchFolder = (await pickExportFolder(mp3Folder, language)) ?? "";
          if (!batchFolder) { setMp3Notice(null); return; }
        }
      }
      const usedNames = new Set<string>();
      const saved: string[] = [];
      for (const entry of entries) {
        const itemMode = entry ? (entry.url ? "download" : "export") : mode;
        const url = (entry ? entry.url ?? "" : youtubeUrl).trim();
        const ready = status.kind === "ready" ? status : null;
        const source = entry && !entry.url ? entry.path : ready?.cachedSourcePath;
        if (itemMode === "download" ? !isLikelyYoutubeUrl(url) : !source) continue;
        ac.signal.throwIfAborted();
        const id = youtubeVideoId(url);
        const analyzedSource = ready?.result.source;
        const sameVideo = id && id === (analyzedSource?.youtubeId ?? youtubeVideoId(analyzedSource?.url ?? ""));
        let title = entry?.name.replace(/\.[a-z0-9]{2,5}$/i, "") || (itemMode === "export" || sameVideo ? analyzedSource?.name : undefined);
        if (!title && id) {
          const { invoke } = await import("@tauri-apps/api/core");
          title = await invoke<string>("youtube_video_title", { id }).catch(() => undefined);
        }
        ac.signal.throwIfAborted();
        const base = (title || (id ? `YouTube-${id}` : "audio"))
          .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim().slice(0, 140).replace(/[. ]+$/, "");
        const filename = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base) ? `_${base}` : base;
        const wanted = `${filename || "audio"}${entry && !entry.url ? "-export" : ""}.mp3`;
        let dest: string | null = null;
        if (batch) {
          let name = wanted;
          let count = 2;
          while (usedNames.has(name.toLowerCase())) name = wanted.replace(/\.mp3$/i, ` (${count++}).mp3`);
          usedNames.add(name.toLowerCase());
          dest = await joinExportPath(batchFolder, name);
        } else {
          dest = await pickSaveMp3(wanted, language, mp3Folder, askSaveLocation);
        }
        if (!dest || !(await askOverwrite(dest))) {
          setMp3Notice(null);
          return;
        }
        await pendingCacheCleanup.current;
        ac.signal.throwIfAborted();
        setMp3Notice({ kind: "working", detail: "Preparing audio…", pct: 0 });
        const progress = (phase: string, pct: number, detail?: string) => {
          if (!ac.signal.aborted) setMp3Notice({ kind: "working", detail: detail || "Preparing audio…", pct, phase });
        };
        const result = source && (itemMode === "export" || sameVideo)
          ? await exportCachedMp3(source, dest, mp3Quality, progress, ac.signal)
          : await downloadYoutubeMp3(url, dest, mp3Quality, progress, ac.signal);
        saved.push(result.path);
        setMp3Notice({ kind: "saved", detail: result.path });
      }
      if (batch && saved.length > 1) {
        setMp3Notice({ kind: "saved", detail: translate(language, "{count} files saved", { count: saved.length }) });
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        setMp3Notice({ kind: "cancelled", detail: "The MP3 save was cancelled." });
      } else {
        setMp3Notice({ kind: "failed", detail: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      mp3Job.current = null;
      setMp3Busy(false);
    }
  };

  const onBrowse = useCallback(async () => {
    try { const picked = await pickAudioFile(language);
    if (picked) void runLocalAnalysis(picked.path, picked.name); } catch(e) { setStatus({kind:"error",message:String(e)}); }
  }, [language, runLocalAnalysis]);

  const onExportText = async (extension: "json" | "csv" | "html") => {
    if (status.kind !== "ready" || textExportBusy.current || mp3Job.current) return;
    const result = status.result;
    const stem = result.source.name.replace(/\.[^.]+$/, "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim().slice(0, 140).replace(/[. ]+$/, "") || "chords";
    const base = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem) ? `_${stem}` : stem;
    const filename = `${base}.chords.${extension}`;
    // The written sheet follows the printed key. The raw detections in the JSON
    // stay exactly as the engine reported them.
    const shown = transpose
      ? { ...result, chords: result.chords.map(chord => ({ ...chord, display: transposeChordLabel(chord.display, transpose) })) }
      : result;
    const text = extension === "json" ? resultToJson(shown) : extension === "csv" ? resultToCsv(shown.chords) : printableChart(shown, language);
    if (!tauri) {
      downloadText(filename, text, extension === "json" ? "application/json" : `text/${extension}`);
      return;
    }
    textExportBusy.current = true;
    setExportNotice(null);
    setMp3Notice(null);
    try {
      const dest = await pickSaveChordFile(filename, extension, language, chordFolder, askSaveLocation);
      if (!dest || !(await askOverwrite(dest))) return;
      await writeTextExport(dest, text);
      setExportNotice({ saved: true, detail: dest });
    } catch (error) {
      setExportNotice({ saved: false, detail: String(error) });
    } finally {
      textExportBusy.current = false;
    }
  };

  const result = status.kind === "ready" ? status.result : null;
  const duration =
    result?.source.durationSec ||
    (status.kind === "ready" ? player.duration : 0);

  const urlOk = isLikelyYoutubeUrl(youtubeUrl);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (!acceptsShortcut(event) || document.querySelector('dialog[open], [aria-modal="true"], .language-picker .language-panel')
        || (event.target instanceof Element && event.target.closest("[data-analyze-guide-layer]"))
        || (CSS.supports("selector(:popover-open)") && document.querySelector(":popover-open"))) return;
      const action = actionForKey(shortcuts, event.key);
      if (action === "youtube") {
        if (status.kind === "loading" || mp3Busy) return;
        event.preventDefault();
        setNav("analyze");
        setYoutubeSearchRequested(true);
      } else if (action && dashboardShortcuts.current?.run(action)) {
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [shortcuts, status.kind, mp3Busy]);

  return (
    <div className="app-shell" lang={language} dir="ltr"><TitleBar tauri={tauri} language={language} onHome={goHome} /><div className="app-body">
      <Sidebar theme={theme} language={language} nav={nav} onNav={page => { setWelcome(false); setNav(page); }}
        version={version || "0.1.0"} />

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden" data-page={nav}>
        <header className="page-heading page-heading-analyze"><HeaderWave theme={theme} /><div className="page-heading-copy" dir={proseDirection}>
          <div className="page-heading-title">
            <h1><Icon name={NAV_ICON[nav]} size={30} />{nav === "analyze" ? t("Analyze a Song") : labels[navLabels[nav]]}</h1>
          </div>
          <p>{t(NAV_SUBTITLE[nav])}</p>
        </div>
          <div className="page-heading-tools">
            <LanguagePicker value={language} onChange={setLanguage} />
            {nav === "analyze" && <AnalyzeGuide language={language} shortcuts={shortcuts}
              layout={`${status.kind}:${showWelcome}:${compactLayout}`} />}
          </div>
        </header>
        <div className={`page-content page-content-${nav}`}>
          {nav === "analyze" && (
            <ChordDashboard
              shortcutRef={dashboardShortcuts}
              shortcuts={shortcuts}
              youtubeSearchRequested={youtubeSearchRequested}
              onYoutubeSearchFocused={onYoutubeSearchFocused}
              showWelcome={showWelcome}
              lightLayout={theme === "orange" || theme === "white"}
              language={language}
              transpose={transpose}
              onTranspose={setTranspose}
              status={status}
              lyricsLookup={lyricsLookup}
              onLyricsAction={lyricsAction}
              tauri={tauri}
              youtubeUrl={youtubeUrl}
              onYoutubeUrl={changeYoutubeUrl}
              canAnalyzeYoutube={tauri && urlOk}
              compactLayout={compactLayout}
              canDownloadMp3={tauri && urlOk}
              mp3Busy={mp3Busy}
              mp3QualityLabel={t(MP3_QUALITY_LABELS[mp3Quality])}
              onBrowse={() => void onBrowse()}
              onFilePath={(path, name) => void runLocalAnalysis(path, name)}
              onAnalyzeYoutube={url => {
                if (url !== undefined) setYoutubeUrl(url);
                void runYoutubeAnalysis(url);
              }}
              onDownloadMp3={() => void saveMp3("download")}
              onCancel={() => {
                abortRef.current?.abort();
                if (status.kind !== "loading" || !status.recoveringAudio) cancelLyrics();
                player.clear();
              }}
              time={currentTime}
              playing={playing}
              duration={duration}
              readTime={() => player.audibleTime()}
              watchClock={(fn) => player.onFrame(fn)}
              onAudible={setCurrentTime}
              onSeek={(time) => { cancelPreview(); player.seek(time); }}
              onRate={(rate) => { player.playbackRate = rate; }}
              onLoop={(region) => player.setLoop(region)}
              onToggle={() => {
                cancelPreview();
                void player.toggle().catch((e) => setStatus((prev) => prev.kind === "ready"
                  ? { ...prev, playbackError: e instanceof Error ? e.message : String(e) }
                  : prev));
              }}
              volume={volume}
              onVolume={setVolume}
              onReloadSource={() => {
                if (status.kind !== "ready") return;
                const id = recordingYoutubeId(status.result.source);
                if (id) void runYoutubeAnalysis(youtubeWatchUrl(id), status.result);
              }}
              onReanalyze={() => {
                if (status.kind !== "ready") return;
                const current = status.result;
                const id = recordingYoutubeId(current.source);
                if (id) void runYoutubeAnalysis(youtubeWatchUrl(id), undefined, current);
                else if (!current.source.fromYoutube) void runLocalAnalysis(status.filePath, current.source.name, current);
              }}
              onJson={() => void onExportText("json")}
              onCsv={() => void onExportText("csv")}
              onChart={() => void onExportText("html")}
              onCorrectChord={(index, chord) => {
                if (status.kind !== "ready") return;
                const original = status.result;
                const result = {
                  ...original,
                  originalChords: original.originalChords ?? original.chords,
                  chords: original.chords.map((item, i) => i === index ? chord : item),
                };
                setStatus({ ...status, result });
                saveAnalysis(result, status.filePath);
              }}
              onMp3={() => void saveMp3("export")}
              onClear={clearSong}
            />
          )}

          {nav === "history" && (
            <HistoryPage
              language={language}
              history={history}
              busy={status.kind === "loading" || mp3Busy}
              onReopen={(h, autoplay) => void reopenHistory(h, autoplay)}
              onRemove={askRemoveHistory}
              onRemoveSelected={askRemoveSelectedHistory}
              onDownload={tauri ? (entries) => void saveMp3("download", entries) : undefined}
              onClearHistory={askClearHistory}
            />
          )}

          {nav === "settings" && (
            <SettingsPage
              shortcuts={shortcuts}
              onShortcuts={setShortcuts}
              language={language}
              tauri={tauri}
              theme={theme}
              onTheme={setTheme}
              mp3Quality={mp3Quality}
              onMp3Quality={setMp3Quality}
              askSaveLocation={askSaveLocation}
              onAskSaveLocation={setAskSaveLocation}
              cacheBytes={storage.cacheBytes}
              historyBytes={historyBytes}
              engineReady={storage.engineReady}
              cacheBusy={cacheBusy || status.kind === "loading" || mp3Busy}
              onClearCache={() => void clearCache()}
              cacheNotice={cacheNotice}
              cacheError={cacheError}
              onClearHistory={askClearHistory}
              version={version}
              mp3Folder={mp3Folder}
              chordFolder={chordFolder}
              onMp3Folder={setMp3Folder}
              onChordFolder={setChordFolder}
              edgeGlow={edgeGlow}
              onEdgeGlow={setEdgeGlow}
              compactLayout={compactLayout}
              onCompactLayout={setCompactLayout}
              updates={updates}
            />
          )}


          {nav === "about" && <AboutPage language={language} theme={theme} version={version} tauri={tauri} />}
        </div>
      </main></div>

      {updates.notification && !mp3Notice && !exportNotice && (
        <aside className="mp3-notice" dir={proseDirection}>
          <Icon name="download" size={22} />
          <div className="mp3-notice-copy" role="status">
            <strong>{t("Update available")}</strong><bdi>Sion Keys {updates.notification.version}</bdi>
          </div>
          <button type="button" onClick={() => { updates.dismissNotification(); setNav("settings"); }}>{labels[navLabels.settings]}</button>
          <button type="button" aria-label={t("Close")} onClick={updates.dismissNotification}><Icon name="close" size={17} /></button>
        </aside>
      )}

      {mp3Notice && (
        <aside className={`mp3-notice ${mp3Notice.kind}`} aria-label={t("MP3 save notification")}>
          <Icon name={mp3Notice.kind === "saved" ? "check" : mp3Notice.kind === "failed" ? "close" : "download"} size={22} />
          <div className="mp3-notice-copy" role="status" dir={proseDirection}>
            <strong>{t(({ working: "Saving MP3", saved: "MP3 saved", failed: "Couldn’t save MP3", cancelled: "Save cancelled" })[mp3Notice.kind])}</strong>
            <span title={mp3Notice.detail}>{mp3Notice.kind === "saved" ? <bdi dir="ltr">{mp3Notice.detail}</bdi> : localizeMessage(language, mp3Notice.detail, mp3Notice.phase)}</span>
            {mp3Notice.kind === "failed" && <DiagnosticDetails language={language} message={mp3Notice.detail} />}
            {mp3Notice.kind === "working" && <progress max={100} value={mp3Notice.pct ?? 0} aria-label={t("MP3 save progress")} />}
          </div>
          {mp3Notice.kind === "working"
            ? <button type="button" onClick={() => mp3Job.current?.abort()}>{t("Cancel")}</button>
            : <button type="button" aria-label={t("Dismiss MP3 notification")} onClick={() => setMp3Notice(null)}>×</button>}
        </aside>
      )}

      {exportNotice && <aside className={`mp3-notice ${exportNotice.saved ? "saved" : "failed"}`}>
        <Icon name={exportNotice.saved ? "check" : "close"} size={22} />
        <div className="mp3-notice-copy" role="status" dir={proseDirection}>
          <strong>{t(exportNotice.saved ? "Chord sheet saved" : "Could not save chord sheet")}</strong>
          {exportNotice.saved ? <span><bdi dir="ltr">{exportNotice.detail}</bdi></span> : <DiagnosticDetails language={language} message={exportNotice.detail} />}
        </div>
        <button type="button" aria-label={t("Close")} onClick={() => setExportNotice(null)}><Icon name="close" size={17} /></button>
      </aside>}

      {confirmDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-[var(--c-surface-2)] border border-[var(--c-border)] rounded-2xl p-6 max-w-md w-full shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="overwrite-title" aria-describedby="overwrite-description" dir={proseDirection}>
            <h3 id="overwrite-title" className="text-xl font-bold mb-4">{t("Replace existing file?")}</h3>
            <p id="overwrite-description" className="text-[var(--c-text)] opacity-90 mb-6 break-all">
              {t("The file already exists. Do you want to replace it?")}
              <br />
              <br />
              <bdi dir="ltr" className="text-xs font-mono opacity-60">{confirmDialog.path}</bdi>
            </p>
            <div className="flex justify-end gap-3">
              <button className="btn btn-ghost" onClick={confirmDialog.onCancel}>
                {t("Cancel")}
              </button>
              <button className="btn btn-primary" onClick={confirmDialog.onConfirm}>
                {t("Replace")}
              </button>
            </div>
          </div>
        </div>
      )}
      {actionDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-[var(--c-surface-2)] border border-[var(--c-border)] rounded-2xl p-6 max-w-md w-full shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="action-dialog-title" dir={proseDirection}>
            <h3 id="action-dialog-title" className="text-xl font-bold mb-4">{actionDialog.title}</h3>
            <p className="text-[var(--c-text)] opacity-90 mb-6">
              {actionDialog.body}
              {actionDialog.detail && <><br /><br /><bdi dir="ltr" className="text-xs font-mono opacity-60">{actionDialog.detail}</bdi></>}
            </p>
            <div className="flex justify-end gap-3">
              <button className="btn btn-ghost" onClick={() => setActionDialog(null)}>{t("Cancel")}</button>
              <button className="btn btn-danger" onClick={actionDialog.onConfirm}>{actionDialog.confirmLabel}</button>
            </div>
          </div>
        </div>
      )}
      <PresenceGlow enabled={edgeGlow} />
    </div>
  );
}

