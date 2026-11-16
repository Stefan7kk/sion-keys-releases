import type { Language } from "./languages";

export type TranslationParams = Record<string, string | number>;
const modules = import.meta.glob<Record<string, string>>("./locales/*.json", { eager: true, import: "default" });
const catalogs = Object.fromEntries(Object.entries(modules).map(([path, catalog]) => [path.split("/").pop()!.replace(".json", ""), catalog]));

export function translate(language: Language, key: string, params: TranslationParams = {}): string {
  const text = catalogs[language]?.[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (token, name: string) => Object.hasOwn(params, name) ? String(params[name]) : token);
}

export function localizedKey(language: Language, label: string): string {
  if (label === "Uncertain") return translate(language, "Uncertain");
  const match = /^(.+?)\s+(major|minor)$/i.exec(label);
  if (!match) return label;
  return translate(language, match[2].toLowerCase() === "major" ? "{tonic} major" : "{tonic} minor", { tonic: match[1] });
}

export function localizedKind(language: Language, kind: string): string {
  const labels: Record<string, string> = { chord: "Chord", no_chord: "No chord", uncertain: "Uncertain" };
  return translate(language, labels[kind] ?? kind);
}

export function localizedScoreKind(language: Language, kind: string): string {
  const labels: Record<string, string> = {
    profile_correlation: "Profile correlation", template_similarity: "Template similarity",
    energy_gate: "Energy threshold", manual: "Manual edit", model_label: "Model label",
    crema_onnx_label: "CREMA label",
    chordformer: "ChordFormer label", none: "No score",
  };
  return translate(language, labels[kind] ?? kind);
}

const phaseLabels: Record<string, string> = {
  starting: "Starting…", init: "Preparing analysis", import: "Preparing analysis",
  decode: "Decoding audio", features: "Reading harmony and preparing chord model",
  chroma: "Analyzing harmony", key: "Detecting key", chords: "Detecting chords",
  finalize: "Finalizing chord timeline", cache: "Restoring full-quality chord analysis",
  download: "Downloading audio", convert: "Converting to MP3", done: "Complete",
};

export const operationalMessages = [
  "Starting…", "Preparing analysis", "Analyzing harmony", "Detecting key", "Detecting chords", "Complete",
  "Preparing analysis (first run compiles audio features)", "Reading harmony and preparing chord model",
  "Chord model · {count} of 5 passes complete", "Finalizing chord timeline", "Restoring full-quality chord analysis",
  "Decoding audio", "Downloading audio", "Download finished", "Starting download", "Converting to MP3", "MP3 saved",
  "Loading temporary audio for analysis…", "Opening saved analysis…", "Preparing audio…", "The MP3 save was cancelled.",
  "Saved analysis. Click Analyze to load the YouTube audio again.",
  "Original audio is missing. Browse for the file to analyze it again.",
  "Enter a single-video YouTube URL before Analyze.", "The audio decoder cannot play this file.",
  "Audio load cancelled", "Analysis cancelled", "Engine error", "The analysis engine returned an invalid response.",
  "Desktop shell required. Run with: npm run tauri:dev (browser-only Vite cannot spawn the engine).",
  "Not in Tauri", "Details: {message}", "{phase} · {message}",
  "Revtag copied.", "Select the Revtag above to copy it.", "Temporary YouTube cache cleared.",
  "Could not clear the temporary cache.",
];

export function localizeMessage(language: Language, message: string, phase?: string): string {
  if (catalogs[language]?.[message] != null) return translate(language, message);
  const plain = message.replace(/^(?:Error|AbortError|NotSupportedError):\s*/, "");
  if (catalogs[language]?.[plain] != null) return translate(language, plain);
  const passes = /^Chord model · (\d+) of 5 passes complete$/.exec(message);
  if (passes) return translate(language, "Chord model · {count} of 5 passes complete", { count: passes[1] });
  if (phaseLabels[message]) return translate(language, phaseLabels[message]);
  if (language === "en") return message;
  if (phase && phaseLabels[phase]) return translate(language, "{phase} · {message}", {
    phase: translate(language, phaseLabels[phase]), message,
  });
  // Unknown decoder/OS diagnostics remain verbatim instead of inventing their meaning.
  return translate(language, "Details: {message}", { message });
}

export const analysisNotes = [
  "Key score is KK profile correlation, not P(correct).",
  "Chords are decoded by ChordFormer. The model supplies labels without confidence scores; rawChords shows the template detector for comparison.",
  "Local ChordFormer was unavailable or bypassed. Chords use the template detector.",
  "Chord score is template similarity, not probability.",
  "Long uncertain holds can split where sustained candidate evidence is stronger. Those candidates remain uncertain.",
  "Short uncertain flicker is smoothed in the display; rawChords retains the original observations.",
  "Near-tie frames (two templates within 0.05 similarity) are decided by a key prior and a bass-structure prior (root position > first inversion > second inversion); the stored score is always the raw template similarity of the chosen label.",
  "Seventh chords must win clearly over the plain triad reading of the same frame.",
  "rawChords are independent of the display decoder; displayed scores are still raw template similarity.",
  "Tempo uses detected beat spacing. Time signature is 3/4 or 4/4 only when the beat accents establish it; otherwise it stays uncertain. Compound meter and notation remain unclassified. Structure and fingerings are not estimated.",
];

export function localizedNote(language: Language, note: string): string {
  return localizeMessage(language, note);
}
