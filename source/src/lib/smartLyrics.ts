import { useCallback, useRef, useState } from "react";
import { youtubeVideoId, youtubeMetadata } from "./engine";
import type { AnalysisResult } from "./types";
import { hasLyricSectionLabels, LYRICS_ONLY_SHEET } from "./singingLyrics";
import { recordingMismatch, type LyricsLookup, type SongLyrics } from "./lyrics";
import { isLanguage, type Language, type LyricsLanguage } from "./languages";
import { readSharedLyrics } from "./sharedLibrary";

const lyricsLanguageKey = "hearthkeys-lyrics-language";
export function savedLyricsLanguage(): LyricsLanguage {
  const value = localStorage.getItem(lyricsLanguageKey);
  return isLanguage(value) ? value : "auto";
}
export function saveLyricsLanguage(language: LyricsLanguage) {
  localStorage.setItem(lyricsLanguageKey, language);
}
export type LyricsMetadata = { title: string; artist: string; duration: number; language: LyricsLanguage; path?: string; youtubeId?: string; channel?: string };
export type LyricsCandidate = SongLyrics & {
  id: string; title: string; artist: string; language: string; duration: number; sourceFile?: string;
  artistRole?: string; sourceUrl: string; version: string; rights: string; canExport: boolean; available: boolean; copyright?: string; linkOnly?: boolean; songwriter?: string; songNumber?: string; sourceReferences?: { provider: string; url: string; copyright?: string }[];
};
export type ImportedLyrics = { title: string; language: string; plain: string; lines: SongLyrics["lines"]; chart?: SongLyrics["chart"] };
export type LyricsResponse = { metadata: LyricsMetadata; candidates: LyricsCandidate[]; selected: string | null; preferred?: string | null; state?: string; imported?: number; staged?: ImportedLyrics; retryAfterSeconds?: number };
export type LyricsActionName = "search" | "choose" | "report" | "import" | "auto";
export type SmartLookup = LyricsLookup & { song: string; metadata: LyricsMetadata; candidates: LyricsCandidate[]; selected: string | null; state?: string; shared?: boolean };
export type ReportReason = "wrong-song" | "wrong-artist" | "wrong-language" | "wrong-version" | "incomplete" | "duplicate" | "rights";
// A future remote transport must be opt-in. Today this interface only writes locally.
export interface LyricsReportSink { report(song: string, candidate: string, reason: ReportReason, metadata: LyricsMetadata): Promise<unknown> }
export const localLyricsReports: LyricsReportSink = { report: (song, candidate, reason, metadata) => lyricsOperation({ action: "report", song, candidate, reason, metadata }) };

let queue: Promise<unknown> = Promise.resolve();
export function lyricsOperation<T>(request: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  // One lyrics operation at a time across components. Never use the audio engine's
  // cancellation channel. Queued obsolete work is skipped before spawning a process.
  const work = queue.catch(() => undefined).then(async () => {
    signal?.throwIfAborted();
    const { invoke } = await import("@tauri-apps/api/core");
    const value = await invoke<T>("lyrics_operation", { request });
    signal?.throwIfAborted();
    return value;
  });
  queue = work;
  return work;
}

async function searchLyrics(request: Record<string, unknown>, signal: AbortSignal): Promise<LyricsResponse> {
  const result = await lyricsOperation<LyricsResponse>(request, signal);
  const seconds = result.retryAfterSeconds;
  if (result.state !== "rate-limited" || seconds === undefined || seconds <= 0 || seconds > 8) return result;
  // Retry once after our short local cooldown. Leave a provider's longer
  // Retry-After in force, and never retry a recording that has been replaced.
  await new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, Math.ceil(seconds * 1000) + 150);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return lyricsOperation<LyricsResponse>(request, signal);
}

export function lyricsIdentity(source: Pick<AnalysisResult["source"], "path" | "youtubeId" | "url">) {
  const id = source.youtubeId || youtubeVideoId(source.url || "");
  return id ? "youtube:" + id : "local:" + source.path.replaceAll("\\", "/").toLowerCase();
}

export function candidateLyrics(candidate: LyricsCandidate | undefined, metadata: LyricsMetadata, explicitlySelected = false): SongLyrics | null {
  if (!candidate?.available) return null;
  const match = evidence(candidate, metadata);
  // A version choice selects the words. It does not verify the recording clock.
  const timed = match.sameTitle && match.sameVariant && !match.wrongArtist &&
    !match.wrongLanguage && !match.wrongScript && !recordingMismatch(candidate, metadata) &&
    match.delta <= 3 && candidate.lines.some(line => line.text.trim() &&
      Number.isFinite(line.at) && line.at >= 0 && line.at < metadata.duration);
  const localLrc = explicitlySelected && candidate.rights === "user-authorized-local-import"
    && /\.lrc$/i.test(candidate.sourceFile ?? "") && candidate.lines.length > 0
    && candidate.lines.every((line, index, lines) => Number.isFinite(line.at) && line.at >= 0
      && line.at < metadata.duration && (!index || line.at > lines[index - 1].at));
  return { provider: candidate.provider, canExport: candidate.canExport, lines: timed || localLrc ? candidate.lines : [],
    plain: candidate.plain || candidate.lines.map(line => line.text).join("\n"), chart: candidate.chart };
}

export const lyricKey = (value: string) => value.normalize("NFC").toLowerCase().replaceAll("i\u0307", "i")
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// Versions are the same song when the sung words match. Section labels, repeat
// marks, provider metadata and chord formatting do not create a new lyric variant.
export function lyricTextKey(candidate: Pick<SongLyrics, "plain" | "lines" | "chart">): string {
  const text = candidate.plain || candidate.lines.map(line => line.text).join("\n")
    || (candidate.chart ?? []).map(row => row.text).join("\n");
  const repeat = /\(\s*(?:x\s*\d+|\d+\s*x|repeat[^)]*)\s*\)/gi;
  const heading = /^(?:verse|chorus|bridge|intro|outro|pre[- ]?chorus|refrain|tag|coda|instrumental|interlude|repeat)\b[\s\d:.\-]*$/i;
  const words: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(repeat, "").trim();
    if (!line || /^\[[^\]]+\]$/.test(line) || heading.test(line)) continue;
    const key = lyricKey(line);
    if (key && words.at(-1) !== key) words.push(key);
  }
  return words.join(" ");
}

const variant = (value: string) => /\b(instrumental|remix|acoustic|cover|live)\b/i.exec(value)?.[1].toLowerCase() || "unspecified";
const titleKey = (value: string) => lyricKey(value
  .replace(/\s*[(\[][^)\]]*(?:feat\.?|featuring|ft\.|official|lyrics?|video|live|cover|acoustic|remix)[^)\]]*[)\]]/gi, "")
  .replace(/\s*[(\[]\s*(?:feat(?:uring)?\.?|ft\.?)\s+[^)\]]+$/i, "")
  .replace(/\s*\|\s*(?:official|lyrics?|music video)\b.*$/i, "")
  .replace(/\s+-\s+(?:live|cover|acoustic|remix|official|lyrics?)\b.*$/i, ""));

export function youtubeLyricsMetadata(metadata: LyricsMetadata): LyricsMetadata {
  if (!metadata.youtubeId) return metadata;
  const [title, credit] = metadata.title.split(/\s+\|\s+/, 2);
  // Only treat a video-title credit as the artist when the uploader agrees.
  if (credit && lyricKey(credit) === lyricKey(metadata.channel || "")) {
    return { ...metadata, title: title.trim(), artist: metadata.artist || credit.trim() };
  }
  return metadata;
}

const latinScript = /\p{Script=Latin}/u;
const cyrillicScript = /\p{Script=Cyrillic}/u;
const arabicScript = /\p{Script=Arabic}/u;
const lyricScripts: Record<Language, RegExp> = {
  en: latinScript, bg: cyrillicScript, he: /\p{Script=Hebrew}/u, tr: latinScript,
  es: latinScript, fr: latinScript, de: latinScript, pt: latinScript, it: latinScript,
  ru: cyrillicScript, zh: /\p{Script=Han}/u, ja: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
  ko: /\p{Script=Hangul}/u, ar: arabicScript, hi: /\p{Script=Devanagari}/u, bn: /\p{Script=Bengali}/u,
  id: latinScript, ur: arabicScript, vi: latinScript, th: /\p{Script=Thai}/u,
  pl: latinScript, uk: cyrillicScript, ro: latinScript,
};

function evidence(candidate: LyricsCandidate, metadata: LyricsMetadata) {
  const title = titleKey(candidate.title), requested = titleKey(metadata.title);
  const artist = lyricKey(candidate.artist).replace(/^various artists$/, ""), requestedArtist = lyricKey(metadata.artist);
  const combined = Boolean(artist && (requested === `${artist} ${title}` || requested === `${title} ${artist}`));
  const localLyrics = candidate.rights === "user-authorized-local-import";
  // The published chart uses the longer first-line title for this composition.
  const titleAlias = [title, requested].includes("open the eyes of my heart") &&
    [title, requested].includes("open the eyes of my heart lord");
  const sameTitle = Boolean(title && (title === requested || titleAlias || combined ||
    (artist && [`${artist} ${requested}`, `${requested} ${artist}`].includes(title)) || (requestedArtist &&
    [`${requestedArtist} ${title}`, `${title} ${requestedArtist}`].includes(requested))));
  const sameArtist = Boolean(artist && (artist === requestedArtist || combined ||
    (!requestedArtist && artist === lyricKey(metadata.channel || ""))));
  const wrongArtist = Boolean(artist && requestedArtist && !sameArtist && candidate.artistRole !== "writer");
  const knownDuration = candidate.duration > 0 && metadata.duration > 0;
  const delta = knownDuration ? Math.abs(candidate.duration - metadata.duration) : Infinity;
  const sameVariant = variant(metadata.title) === candidate.version;
  const languageTag = (candidate.language || "unknown").toLowerCase().split(/[-_]/)[0];
  const language = languageTag === "iw" || languageTag === "heb" ? "he" : languageTag;
  const knownLanguage = isLanguage(language);
  const wrongLanguage = metadata.language !== "auto" && knownLanguage && language !== metadata.language;
  const text = candidate.plain || candidate.lines.map(line => line.text).join("\n");
  const expectedScript = metadata.language === "auto"
    ? (cyrillicScript.test(requested) ? cyrillicScript : lyricScripts.he.test(requested) ? lyricScripts.he : null)
    : lyricScripts[metadata.language];
  // Provider metadata identifies a language. For untagged lyrics, script checks
  // rule out incompatible alphabets without guessing among shared scripts.
  const wrongScript = Boolean(text && expectedScript && !expectedScript.test(text) && (!knownLanguage || metadata.language === "auto"));
  const plausible = candidate.available && !candidate.linkOnly && Boolean(text.trim()) && sameTitle && !wrongLanguage && !wrongScript &&
    ![variant(metadata.title), candidate.version].some(value => value === "instrumental" || value === "remix") &&
    (sameArtist || (!wrongArtist && (localLyrics || delta <= Math.max(25, metadata.duration * .10)))) &&
    (!knownDuration || sameArtist || delta <= Math.max(45, metadata.duration * .18));
  const score = (sameTitle ? 100 : 0) + (sameArtist ? 24 : wrongArtist ? -35 : artist ? 0 : -8) +
    (sameVariant ? 10 : -15) + (wrongLanguage || wrongScript ? -70 : language === metadata.language ? 12 : 0) +
    (knownDuration ? 28 - Math.min(85, delta * 1.15) : -8);
  return { plausible, score, sameTitle, sameVariant, sameArtist, wrongArtist, wrongLanguage, wrongScript, delta, localLyrics };
}

export function alternateRecording(candidate: LyricsCandidate, metadata: LyricsMetadata) {
  const match = evidence(candidate, metadata);
  return !match.sameTitle || !match.sameVariant || match.wrongArtist || (!match.localLyrics && match.delta > 3);
}

function connectionTier(candidate: LyricsCandidate, metadata: LyricsMetadata) {
  if (LYRICS_ONLY_SHEET) return 0;
  if (candidateLyrics(candidate, metadata)?.lines.length) return 2;
  return candidate.chart?.some(row => row.chords.length) ? 1 : 0;
}

function sectionBonus(candidate: LyricsCandidate) {
  const text = candidate.plain || candidate.lines.map(line => line.text).join("\n");
  return LYRICS_ONLY_SHEET && hasLyricSectionLabels(text) ? 8 : 0;
}

export function autoSelectLyrics(candidates: LyricsCandidate[], metadata: LyricsMetadata): string | null {
  const matches = candidates.map(candidate => {
    const match = evidence(candidate, metadata);
    const tier = connectionTier(candidate, metadata);
    return { candidate, ...match, tier, sectionBonus: sectionBonus(candidate) };
  }).filter(match => match.plausible).sort((a, b) =>
    b.tier - a.tier || (b.score + b.sectionBonus) - (a.score + a.sectionBonus));
  const seen = new Set<string>();
  const unique = matches.filter(match => {
    const key = lyricTextKey(match.candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const [first, second] = unique;
  if (!first) return null;
  if (second && first.tier === second.tier && !first.sameArtist && lyricKey(first.candidate.artist) !== lyricKey(second.candidate.artist) &&
      Math.abs(first.score - second.score) < 5) return null;
  return first.candidate.id;
}

const PIN_PREFIX = "pin:";
export const explicitLyricsPin = (mode?: string | null) => mode?.startsWith(PIN_PREFIX) ? mode.slice(PIN_PREFIX.length) : null;

// Explicit choices survive changes to automatic ranking.
export function resolveLyricsVersion(candidates: LyricsCandidate[], metadata: LyricsMetadata,
  preferred?: string | null, mode?: string | null) {
  const best = autoSelectLyrics(candidates, metadata);
  const saved = candidates.find(candidate => candidate.id === preferred && candidate.available);
  if (mode === "auto") return best;
  const pinned = explicitLyricsPin(mode);
  if (pinned) return candidates.find(candidate => candidate.id === pinned && candidate.available && !candidate.linkOnly)?.id ?? best;
  if (!saved || LYRICS_ONLY_SHEET) return best;
  const recommended = candidates.find(candidate => candidate.id === best);
  return recommended && connectionTier(recommended, metadata) > connectionTier(saved, metadata)
    ? recommended.id : saved.id;
}

const modeKey = (song: string) => "hearthkeys-lyrics-choice:" + song;

export function lyricVersions(candidates: LyricsCandidate[], metadata: LyricsMetadata, selected: string | null) {
  const best = autoSelectLyrics(candidates, metadata);
  const sorted = candidates.map(candidate => ({ candidate, score: evidence(candidate, metadata).score + sectionBonus(candidate), tier: connectionTier(candidate, metadata) }))
    .sort((a, b) => Number(b.candidate.id === selected) - Number(a.candidate.id === selected) ||
      Number(b.candidate.id === best) - Number(a.candidate.id === best) ||
      Number(b.candidate.available) - Number(a.candidate.available) || b.tier - a.tier || b.score - a.score);
  const groups: { item: LyricsCandidate; ids: string[]; key: string }[] = [];
  for (const { candidate } of sorted) {
    const key = candidate.available ? lyricTextKey(candidate) : "";
    const group = key && groups.find(g => g.key === key);
    if (!group) {
      groups.push({ item: candidate, ids: [candidate.id], key });
      continue;
    }
    group.ids.push(candidate.id);
    if (connectionTier(candidate, metadata) > connectionTier(group.item, metadata)) group.item = candidate;
    const refs = [...(group.item.sourceReferences ?? []),
      { provider: candidate.provider, url: candidate.sourceUrl, copyright: candidate.copyright },
      ...(candidate.sourceReferences ?? [])];
    group.item = { ...group.item, sourceReferences: refs.filter((ref, i) =>
      (ref.provider !== group.item.provider || ref.url !== group.item.sourceUrl) &&
      refs.findIndex(r => r.provider === ref.provider && r.url === ref.url) === i) };
  }
  return { best, groups };
}

// In the alternatives dialog the words, rather than the recording, source,
// chart key or formatting, determine whether a version adds anything new.
export function distinctLyricAlternatives(candidates: LyricsCandidate[], metadata: LyricsMetadata, selected: string | null) {
  const current = candidates.find(candidate => candidate.id === selected);
  const seen = new Set([current ? lyricTextKey(current) : ""]);
  const ordered = candidates.filter(candidate => {
    const match = evidence(candidate, metadata);
    return candidate.available && !candidate.linkOnly && candidate.id !== selected && match.sameTitle &&
      !match.wrongLanguage && !match.wrongScript && !["instrumental", "remix"].includes(candidate.version);
  }).sort((a, b) => connectionTier(b, metadata) - connectionTier(a, metadata) ||
    evidence(b, metadata).score - evidence(a, metadata).score);
  return ordered.filter(item => {
    const key = lyricTextKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 6);
}

export function useSmartLyrics() {
  const [lookup, setLookup] = useState<SmartLookup | null>(null);
  const current = useRef<{ song: string; metadata: LyricsMetadata; controller: AbortController; source?: AnalysisResult["source"]; response?: LyricsResponse; mode?: string | null; shared?: SongLyrics; sharedKey?: string } | null>(null);
  const publish = useCallback(() => {
    const job = current.current;
    if (!job || job.controller.signal.aborted) return;
    const response = job.response;
    if (job.source) job.metadata = { ...job.metadata, duration: job.source.durationSec };
    const pending = !response || response.state === "loading" ||
      (job.song.startsWith("youtube:") && !job.source && job.metadata.duration <= 0);
    const selected = pending ? null : resolveLyricsVersion(response.candidates, job.metadata, response.preferred, job.mode);
    if (response) response.selected = selected;
    const candidate = response?.candidates.find(item => item.id === selected);
    const shared = !explicitLyricsPin(job.mode) ? job.shared : undefined;
    setLookup({ song: job.song, source: job.source, metadata: job.metadata, candidates: response?.candidates ?? [],
      selected: shared ? null : selected, shared: !!shared,
      lyrics: shared ?? candidateLyrics(candidate, job.metadata, Boolean(selected && explicitLyricsPin(job.mode) === selected)),
      pending: pending && !shared, state: response?.state,
      unavailable: response?.state === "unavailable" });
    return selected;
  }, []);
  const cancel = useCallback(() => { current.current?.controller.abort(); current.current = null; setLookup(null); }, []);
  const start = useCallback((source: { path?: string; name?: string; url?: string; youtubeId?: string; durationSec?: number }, signal?: AbortSignal) => {
    current.current?.controller.abort();
    const controller = new AbortController();
    signal?.addEventListener("abort", () => controller.abort(), { once: true });
    if (signal?.aborted) controller.abort();
    const id = source.youtubeId || youtubeVideoId(source.url || "");
    const selected = id ? youtubeMetadata.get(id) : null;
    const language = savedLyricsLanguage();
    const metadata: LyricsMetadata = { title: selected?.title || source.name || "", artist: "", channel: selected?.channel || undefined, youtubeId: id || undefined, duration: selected?.duration || source.durationSec || 0, language };
    const song = lyricsIdentity({ path: source.path || "", url: source.url, youtubeId: id || undefined });
    const job = { song, metadata, controller, mode: localStorage.getItem(modeKey(song)) } as NonNullable<typeof current.current>;
    current.current = job;
    publish();
    void (async () => {
      try {
        job.metadata = youtubeLyricsMetadata({ ...metadata, ...await lyricsOperation<LyricsMetadata>({ action: "metadata", metadata: { ...metadata, ...(!id ? { path: source.path } : { youtubeId: id }) } }, controller.signal) });
        const cached = await lyricsOperation<LyricsResponse>({ action: "cache", song, metadata: job.metadata }, controller.signal);
        job.response = cached;
        if (current.current !== job) return;
        const cachedPreferred = cached.candidates.find(candidate => candidate.id === cached.preferred);
        const recommended = resolveLyricsVersion(cached.candidates, job.metadata, cached.preferred, job.mode);
        const pinned = explicitLyricsPin(job.mode);
        const hasPinned = !!cachedPreferred?.available && pinned === cachedPreferred.id;
        const canKeepTimedImport = !!cachedPreferred?.available && !pinned && recommended === cached.preferred
          && job.mode !== "auto" && connectionTier(cachedPreferred, job.metadata) === 2;
        job.response.state = hasPinned || canKeepTimedImport ? "ready" : "loading";
        if (hasPinned || canKeepTimedImport) {
          publish();
          return;
        }
        const refresh = job.mode === "auto" || (!pinned && !!cachedPreferred && alternateRecording(cachedPreferred, job.metadata));
        const result = await searchLyrics({ action: "search", song, metadata: job.metadata, refresh }, controller.signal);
        if (current.current !== job) return;
        job.response = result;
        publish();
      } catch {
        if (current.current !== job || controller.signal.aborted) return;
        job.response = { ...job.response, metadata: job.metadata, candidates: job.response?.candidates ?? [], selected: job.response?.selected ?? null, state: "unavailable" };
        publish();
      }
    })();
  }, [publish]);
  const updateShared = useCallback((job: NonNullable<typeof current.current>) => {
    const source = job.source;
    if (!source) return;
    const recording = source.youtubeId || youtubeVideoId(source.url || "") || source.libraryRecording;
    const language = job.metadata.language;
    const key = recording && recording + ":" + language;
    if (!recording || job.sharedKey === key) return;
    job.sharedKey = key;
    void readSharedLyrics(recording, language, job.controller.signal).then(result => {
      if (!result || current.current !== job || job.controller.signal.aborted || job.sharedKey !== key) return;
      job.shared = { provider: "Shared library", canExport: false, plain: result.text, lines: [] };
      publish();
    }).catch(() => { if (job.sharedKey === key) job.sharedKey = undefined; });
  }, [publish]);
  const attach = useCallback((source: AnalysisResult["source"]) => {
    const job = current.current;
    if (!job || job.song !== lyricsIdentity(source)) return;
    job.source = source;
    job.metadata = { ...job.metadata, duration: source.durationSec };
    if (!job.metadata.title) job.metadata.title = source.name;
    publish();
    updateShared(job);
  }, [publish, updateShared]);
  const action = useCallback(async (name: LyricsActionName, data: Record<string, unknown> = {}) => {
    const job = current.current;
    if (!job) return;
    if (name === "auto") {
      job.mode = "auto";
      localStorage.setItem(modeKey(job.song), job.mode);
      return publish();
    }
    const language = data.language;
    if (name === "search" && (language === "auto" || isLanguage(language)) && language !== job.metadata.language) {
      job.metadata = { ...job.metadata, language };
      job.shared = undefined;
      job.sharedKey = undefined;
      publish();
    }
    if (name === "search") updateShared(job);
    const previous = job.response;
    const searchMetadata = typeof data.query === "string"
      ? { ...job.metadata, title: data.query.trim().slice(0, 240) }
      : name === "import" && (language === "auto" || isLanguage(language)) ? { ...job.metadata, language }
      : job.metadata;
    const request = { action: name, song: job.song, metadata: searchMetadata, refresh: name === "search", ...data };
    const result = name === "search" ? await searchLyrics(request, job.controller.signal)
      : await lyricsOperation<LyricsResponse>(request, job.controller.signal);
    if (current.current !== job) return;
    if (result.staged) return result.staged;
    if (name === "choose") {
      const isRequested = (item: LyricsCandidate) => item.id === data.candidate && item.available && !item.linkOnly;
      const available = previous?.candidates.some(isRequested) ? previous
        : await searchLyrics({ action: "search", song: job.song, metadata: job.metadata }, job.controller.signal);
      const selected = available?.candidates.find(isRequested);
      if (current.current !== job) return;
      if (!available || !selected) throw new Error("Lyrics service unavailable");
      job.mode = PIN_PREFIX + selected.id;
      localStorage.setItem(modeKey(job.song), job.mode);
      job.response = { ...available, selected: selected.id, preferred: selected.id };
    } else if (name === "report") {
      const rejected = Array.isArray(data.aliases) ? data.aliases as string[] : [];
      for (const alias of rejected) {
        await lyricsOperation({ action: "report", song: job.song, metadata: job.metadata,
          candidate: alias, reason: data.reason }, job.controller.signal);
      }
      const ids = new Set([data.candidate, ...rejected]);
      job.response = { ...previous!, candidates: previous?.candidates.filter(item => !ids.has(item.id)) ?? [],
        preferred: ids.has(previous?.preferred) ? null : previous?.preferred, selected: null };
    } else {
      if (name === "import" && result.imported === 1 && result.preferred) {
        job.mode = PIN_PREFIX + result.preferred;
        localStorage.setItem(modeKey(job.song), job.mode);
      }
      job.response = { ...result, candidates: result.candidates.map(item => {
        const existing = previous?.candidates.find(c => c.id === item.id);
        return !item.available && existing?.available
          ? { ...item, plain: existing.plain, lines: existing.lines, available: true } : item;
      }) };
    }
    if (current.current !== job) return;
    const selected = publish();
    if (name !== "import" || result.imported === 1) return selected;
  }, [publish, updateShared]);
  return { lookup, start, attach, cancel, action };
}
