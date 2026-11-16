export type ThemeId = "blue" | "orange" | "purple" | "white";


export type NavId = "analyze" | "history" | "settings" | "about";

/** MP3 export quality presets (FFmpeg libmp3lame). */
export type Mp3Quality = "high" | "192" | "128";

export interface KeyResult {
  label: string;
  tonic: string;
  mode: string;
  score: number | null;
  scoreKind: "profile_correlation";
  alternative: {
    label: string;
    tonic: string;
    mode: string;
    score: number | null;
    scoreKind: string;
    relation?: string;
  } | null;
  uncertain: boolean;
  margin: number | null;
}

export interface ChordSegment {
  start: number;
  end: number;
  label: string;
  display: string;
  score: number | null;
  scoreKind: "template_similarity" | "energy_gate" | string;
  kind: "chord" | "no_chord" | "uncertain" | string;
}

export interface AnalysisResult {
  ok: true;
  engineVersion: string;
  source: {
    path: string;
    name: string;
    durationSec: number;
    sampleRate: number;
    url?: string;
    youtubeId?: string;
    libraryRecording?: string;
    cachedSourcePath?: string;
    fromYoutube?: boolean;
  };
  cache?: {
    dir?: string;
    sourcePath?: string;
  };
  key: KeyResult;
  chords: ChordSegment[];
  rawChords: ChordSegment[];
  originalChords?: ChordSegment[];
  waveform: number[];
  meta: {
    elapsedSec: number;
    hopLength: number;
    decoder?: string;
    tempoBpm?: number;
    timeSignature?: string;
    meterConfidence?: "strong" | "moderate";
    meterBeats?: [time: number, downbeat: boolean][];
    meterPulseBpm?: number;
    meterChanges?: { startSec: number; timeSignature: string }[];
    timings?: Record<string, number>;
    vocabulary: string[];
    scoreKinds: Record<string, string>;
    notes: string[];
    wallSec?: number;
  };
}

export interface AnalysisError {
  ok: false;
  error: string;
  errorCode?: string;
  detail?: string;
}

export type EngineEvent =
  | { type: "progress"; phase: string; pct: number; message?: string }
  | ({ type: "result" } & AnalysisResult)
  | ({ type: "error" } & AnalysisError)
  | { type: "selftest"; ok: boolean; checks: Record<string, unknown> };

export type AppStatus =
  | { kind: "idle" }
  | { kind: "loading"; phase: string; pct: number; message?: string; held?: AnalysisResult; recoveringAudio?: boolean }
  | {
      kind: "ready";
      result: AnalysisResult;
      filePath: string;
      objectUrl: string;
      playbackError?: string;
      /** Cached YouTube/source path for Export MP3 (not a permanent user MP3). */
      cachedSourcePath?: string | null;
      cacheDir?: string | null;
    }
  | { kind: "error"; message: string; code?: string };

export interface HistoryEntry {
  id: string;
  name: string;
  path: string;
  keyLabel: string;
  durationSec: number;
  analyzedAt: string;
  url?: string;
  result?: AnalysisResult;
}
