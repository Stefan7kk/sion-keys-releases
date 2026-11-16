import { youtubeWatchUrl } from "./engine";
import type { AnalysisResult } from "./types";

const endpoint = "https://sion-keys-services.sion-keys.workers.dev";
const analysisRevision = "analysis-v1";
export type LyricContribution = "generated" | "edited" | "imported";
export type SharedLyrics = { text: string; origin: LyricContribution | "reference" };
export type LyricsVerification = { method: "recording-v1"; checkedLines: number; checkedWords: number; totalWords: number };

function libraryUrl(videoId: string, kind: "analysis" | "lyrics", revision: string) {
  return `${endpoint}/api/library/${encodeURIComponent(videoId)}/${kind}/${encodeURIComponent(revision)}`;
}

export async function localRecordingKey(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return "f-" + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function readSharedAnalysis(recording: string, signal: AbortSignal): Promise<AnalysisResult | null> {
  const response = await fetch(libraryUrl(recording, "analysis", analysisRevision), {
    signal: AbortSignal.any([signal, AbortSignal.timeout(2500)]),
  });
  if (!response.ok) return null;
  const analysis = await response.json() as AnalysisResult;
  if (analysis.engineVersion !== "0.1.0" || !analysis.ok || !Array.isArray(analysis.chords) ||
      !Array.isArray(analysis.waveform) || !Number.isFinite(analysis.source?.durationSec)) return null;
  const identity = recording.length === 11
    ? { fromYoutube: true, youtubeId: recording, url: youtubeWatchUrl(recording) }
    : { libraryRecording: recording };
  return { ...analysis, source: { ...analysis.source, path: "", ...identity } };
}

async function submit(url: string, data: object) {
  const response = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
    signal: AbortSignal.timeout(6000),
  });
  if (response.status === 409) return false;
  if (response.status !== 202) throw new Error("Shared library is unavailable.");
  return true;
}

export function contributeAnalysis(videoId: string, result: AnalysisResult) {
  const { engineVersion, source, key, chords, rawChords, waveform, meta } = result;
  return submit(libraryUrl(videoId, "analysis", analysisRevision), {
    engineVersion, source: { name: videoId.length === 11 ? source.name : "Local recording",
      durationSec: source.durationSec, sampleRate: source.sampleRate },
    key, chords: result.originalChords ?? chords, rawChords, waveform, meta: {
      hopLength: meta.hopLength, elapsedSec: meta.elapsedSec, tempoBpm: meta.tempoBpm, timeSignature: meta.timeSignature,
      meterConfidence: meta.meterConfidence, meterBeats: meta.meterBeats, meterPulseBpm: meta.meterPulseBpm,
      vocabulary: meta.vocabulary,
    },
  });
}

export async function readSharedLyrics(recording: string, language: string, signal: AbortSignal): Promise<SharedLyrics | null> {
  const response = await fetch(libraryUrl(recording, "lyrics", language), { signal: AbortSignal.any([signal, AbortSignal.timeout(3500)]) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Shared library is unavailable.");
  const item = await response.json() as SharedLyrics;
  return typeof item?.text === "string" && item.text.trim() ? item : null;
}

export async function contributeLyrics(recording: string, language: string, lines: string[], origin: LyricContribution, proof: LyricsVerification) {
  const words = lines.join(" ").normalize("NFC").toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
  const digestBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(words.join(" ")));
  const digest = Array.from(new Uint8Array(digestBytes), byte => byte.toString(16).padStart(2, "0")).join("");
  const response = await fetch(libraryUrl(recording, "lyrics", language), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ digest, origin, proof }),
    signal: AbortSignal.timeout(6000),
  });
  if (response.status === 422) return false;
  if (!response.ok) throw new Error("Shared library is unavailable.");
  return true;
}
