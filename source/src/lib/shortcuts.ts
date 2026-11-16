import type { ChordSegment } from "./types";

export const shortcutActions = {
  previous: "Previous chord",
  next: "Next chord",
  playback: "Play / Pause",
  youtube: "YouTube Search",
  restart: "Restart song",
  loop: "A-B Loop",
} as const;
export type ShortcutAction = keyof typeof shortcutActions;
export type Shortcuts = Record<ShortcutAction, string>;
export const shortcutIds = Object.keys(shortcutActions) as ShortcutAction[];
export const defaultShortcuts: Shortcuts = {
  previous: "ArrowLeft", next: "ArrowRight", playback: " ", youtube: "y", restart: "r", loop: "l",
};
export const shortcutStorageKey = "sion-keys-shortcuts";

const arrows = { ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓" } as const;
export function normalizedShortcut(key: string) {
  if (key === " " || Object.hasOwn(arrows, key)) return key;
  const character = key.normalize("NFC").replace(/^i\u0307$/u, "i");
  if (!/^[\p{L}\p{N}\p{P}\p{S}]$/u.test(character)) return null;
  return character.toLowerCase().replace(/^i\u0307$/u, "i");
}

export function readShortcuts(raw: string | null): Shortcuts {
  if (!raw) return { ...defaultShortcuts };
  try {
    const value: Partial<Shortcuts> | null = JSON.parse(raw);
    const bindings = { ...defaultShortcuts };
    for (const action of shortcutIds) {
      const saved = value?.[action];
      const normalized = typeof saved === "string" ? normalizedShortcut(saved) : null;
      if (normalized) bindings[action] = normalized;
    }
    return new Set(Object.values(bindings)).size === shortcutIds.length ? bindings : { ...defaultShortcuts };
  } catch {
    return { ...defaultShortcuts };
  }
}

export function actionForKey(bindings: Shortcuts, key: string) {
  const normalized = normalizedShortcut(key);
  return normalized ? shortcutIds.find(action => bindings[action] === normalized) : undefined;
}

export function capturedShortcut(event: KeyboardEvent) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing || event.keyCode === 229
    || (event.shiftKey && !/^[\p{P}\p{S}]$/u.test(event.key))) return null;
  return normalizedShortcut(event.key);
}

export function shortcutKeyLabel(key: string, spaceLabel: string) {
  if (key === " ") return spaceLabel;
  if (Object.hasOwn(arrows, key)) return arrows[key as keyof typeof arrows];
  const upper = key.toUpperCase();
  return [...upper].length === 1 ? upper : key;
}

export function acceptsShortcut(event: KeyboardEvent) {
  if (event.defaultPrevented || event.repeat || !capturedShortcut(event)) return false;
  const target = event.target instanceof Element ? event.target : null;
  return !target?.closest("input,textarea,select,[contenteditable],[role='textbox'],[role='combobox']")
    && (event.key !== " " || !target?.closest("button,a[href],summary,[role='button'],[role='checkbox'],[role='switch'],[role='menuitem']"));
}

export function chordShortcutStart(chords: readonly ChordSegment[], time: number, direction: "previous" | "next") {
  let previous: number | undefined;
  for (const chord of chords) {
    if ((chord.kind !== "chord" && chord.kind !== "uncertain") || /^n\.?c\.?$/i.test(chord.display)) continue;
    if (direction === "next") {
      if (chord.start > time + .025) return chord.start;
    } else {
      if (chord.start >= time - .025 || chord.end > time) break;
      previous = chord.start;
    }
  }
  return previous;
}
