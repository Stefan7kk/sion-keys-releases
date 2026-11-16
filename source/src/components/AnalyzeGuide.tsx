import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { translate } from "../lib/i18n";
import { languageDirection, type Language } from "../lib/languages";
import { shortcutActions, shortcutKeyLabel, type ShortcutAction, type Shortcuts } from "../lib/shortcuts";
import { Icon } from "./Icon";

type Topic = {
  id: string; target: string; label: string; detail: string; keys?: ShortcutAction[];
};

const topics: Topic[] = [
  { id: "nav", target: ".sidebar nav", label: "Navigation", detail: "Open Analyze, History, Settings, or About." },
  { id: "language", target: ".page-heading .language-trigger", label: "Interface language", detail: "Choose your interface language." },
  { id: "file", target: ".cd-drop", label: "Audio file", detail: "Drop an audio file or click to browse" },
  { id: "youtube", target: ".cd-urlbox, [data-guide-change-song]", label: "YouTube Search", detail: "Search YouTube or paste a link", keys: ["youtube"] },
  { id: "song", target: ".cd-song", label: "Song controls", detail: "Re-analyze, change the song, or export your results." },
  { id: "summary", target: ".cd-summary-strip, .cd-player-summary", label: "Analysis summary", detail: "See the song’s musical details and transpose the displayed chords." },
  { id: "practice", target: ".cd-practice", label: "Practice Tools", detail: "Loop a section or adjust speed, capo, metronome, and chord display.", keys: ["loop"] },
  { id: "chord-mode", target: "[data-guide-chord-mode]", label: "Chord display mode", detail: "Clean Progression combines repeated chords and shows inversions in root position." },
  { id: "player", target: ".cd-wave-row", label: "Player", detail: "Play the song, seek with the waveform, or adjust volume.", keys: ["playback", "restart"] },
  { id: "timeline", target: ".cd-chord-track", label: "Chord timeline", detail: "See chord changes in time and select a chord to jump to it.", keys: ["previous", "next"] },
  { id: "lyrics", target: ".cd-sheet-panel", label: "Lyrics Sheet", detail: "Read, edit, or sync lyrics and follow the chords as you play." },
  { id: "diagrams", target: ".cd-diagram-panel, .cd-compact-diagram-panel", label: "Chord Diagrams", detail: "See how to play the chords on piano, guitar, or bass." },
  { id: "details", target: ".cd-song-summary", label: "Song Information", detail: "See the key, tempo, time signature, and duration." },
  { id: "verse", target: ".cd-daily-verse", label: "Bible Verse of the Day", detail: "Read today’s verse, see its source, or open the full chapter." },
];
const targetSelector = topics.map(topic => topic.target).join(",");

type Location = { id: string; x: number; y: number; width: number; height: number };

function locate() {
  return topics.flatMap(({ id, target }): Location[] => {
    // If Change Song is open, prefer the actual YouTube field.
    const node = id === "youtube" ? document.querySelector(".cd-urlbox") ?? document.querySelector(target) : document.querySelector(target);
    if (!node) return [];
    const rect = node.getBoundingClientRect();
    const boundary = node.closest(".page-content")?.getBoundingClientRect();
    const x = Math.max(boundary?.left ?? 0, rect.left);
    const y = Math.max(boundary?.top ?? 0, rect.top);
    const width = Math.min(window.innerWidth - 1, boundary?.right ?? Infinity, rect.right) - x;
    const height = Math.min(window.innerHeight - 1, boundary?.bottom ?? Infinity, rect.bottom) - y;
    return width > 26 && height > 12 ? [{ id, x, y, width, height }] : [];
  });
}

export function AnalyzeGuide({ language, shortcuts, layout }: { language: Language; shortcuts: Shortcuts; layout: string }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const portal = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const [mode, setMode] = useState<"hover" | "pinned" | null>(null);
  const [selected, setSelected] = useState("");
  const [locations, setLocations] = useState<Location[]>([]);
  const open = mode !== null;
  const t = (key: string) => translate(language, key);
  const visible = topics.filter(topic => locations.some(location => location.id === topic.id));
  const active = visible.find(topic => topic.id === selected)
    ?? visible.find(topic => topic.id === "timeline" || topic.id === "file") ?? visible[0];
  useEffect(() => {
    if (mode === "pinned") portal.current?.querySelector<HTMLButtonElement>(".analyze-guide-close")?.focus();
  }, [mode]);

  useEffect(() => {
    if (!open) return;
    let frame = 0;
    const update = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const next = locate();
        setLocations(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
      });
    };
    const root = document.querySelector('main[data-page="analyze"]');
    const dimensions = new ResizeObserver(update);
    if (root) dimensions.observe(root);
    const contents = new MutationObserver(records => {
      if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(node =>
        node instanceof Element && (node.matches(targetSelector) || node.querySelector(targetSelector))))) update();
    });
    const dashboard = root?.querySelector(".cd");
    if (dashboard) contents.observe(dashboard, { childList: true, subtree: true });
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, { capture: true, passive: true });
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !portal.current?.contains(target)) setMode(null);
    };
    const showHoveredSection = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || !(event.target instanceof Element)) return;
      const section = event.target.closest(targetSelector);
      const topic = section && topics.find(item => section.matches(item.target));
      if (topic) setSelected(topic.id);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setMode(null);
      if (portal.current?.contains(document.activeElement)) trigger.current?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("pointerover", showHoveredSection);
    document.addEventListener("keydown", escape);
    update();
    return () => {
      window.cancelAnimationFrame(frame);
      dimensions.disconnect();
      contents.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("pointerover", showHoveredSection);
      document.removeEventListener("keydown", escape);
    };
  }, [open, layout, language]);

  return <span className="analyze-guide">
    <button ref={trigger} type="button" className="analyze-guide-trigger"
      aria-label={t("Screen guide")} aria-expanded={open} aria-controls={panelId}
      onPointerEnter={event => {
        if (event.pointerType === "mouse") setMode(value => value ?? "hover");
      }}
      onClick={() => setMode(value => value === "pinned" ? null : "pinned")}>
      <Icon name="info" size={18} />
    </button>
    {open && createPortal(<div className="analyze-guide-layer" ref={portal} data-analyze-guide-layer>
      {locations.map((location, index) => {
        const topic = visible[index];
        return <div key={location.id} className="analyze-guide-region" data-active={location.id === active?.id}
          style={{ left: location.x, top: location.y, width: location.width, height: location.height }}>
          <button type="button" className="analyze-guide-pin" tabIndex={-1} aria-label={topic && t(topic.label)}
            onPointerEnter={() => setSelected(location.id)} onClick={() => setSelected(location.id)}>{index + 1}</button>
        </div>;
      })}
      <section className="analyze-guide-panel" id={panelId} dir={languageDirection(language)} aria-label={t("Screen guide")}>
        <header>
          <h2>{t("Screen guide")}</h2>
          <button type="button" className="analyze-guide-close" aria-label={t("Close")}
            onClick={() => { trigger.current?.focus(); setMode(null); }}><Icon name="close" size={17} /></button>
        </header>
        <div className="analyze-guide-topics">
          {visible.map((topic, index) => <button key={topic.id} type="button" aria-pressed={active?.id === topic.id}
            onFocus={() => setSelected(topic.id)} onPointerEnter={() => setSelected(topic.id)}
            onClick={() => setSelected(topic.id)}>
            <span aria-hidden="true">{index + 1}</span>{t(topic.label)}
          </button>)}
        </div>
        {active && <div className="analyze-guide-detail" data-topic={active.id} aria-live="polite">
          <strong>{t(active.label)}</strong>
          <p>{t(active.detail)}</p>
          {active.keys && <ul aria-label={t("Keyboard shortcuts")}>
            {active.keys.map(action => <li key={action}>
              <kbd>{shortcutKeyLabel(shortcuts[action], t("Space"))}</kbd>{t(shortcutActions[action])}
            </li>)}
          </ul>}
        </div>}
      </section>
    </div>, document.body)}
  </span>;
}
