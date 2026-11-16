import { useEffect, useState } from "react";
import { applyWindowSize, savedWindowSize } from "../lib/windowSize";
import { Icon } from "./Icon";
import { languageDirection, type Language } from "../lib/languages";
import { translate } from "../lib/i18n";
import { SionMark } from "./SionMark";
import { SionWordmark } from "./SionWordmark";

async function win(action: "minimize" | "close") {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow()[action]();
}

export function TitleBar({ tauri, language, onHome }: { tauri: boolean; language: Language; onHome: () => void }) {
  const t = (key: string) => translate(language, key);
  const homeLabel = language === "en" ? "Verse of the Day" : t("Bible Verse of the Day");
  const [fullscreen, setFullscreen] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!tauri) return;
    void applyWindowSize(savedWindowSize()).catch(reason => setError(String(reason)));
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      const stop = await win.onResized(() => {
        void win.isFullscreen().then(value => { if (!disposed) setFullscreen(value); });
      });
      if (disposed) stop();
      else unlisten = stop;
    }).catch(reason => setError(String(reason)));
    return () => { disposed = true; unlisten?.(); };
  }, [tauri]);
  async function toggleFullscreen() {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      const next = !(await win.isFullscreen());
      await win.setFullscreen(next);
      setFullscreen(next);
      setError("");
    } catch (reason) { setError(String(reason)); }
  }
  useEffect(() => {
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape" && fullscreen) void toggleFullscreen();
    }
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [fullscreen]);
  return (
    <header className="app-title" data-tauri-drag-region>
      <button type="button" className="title-home" title={homeLabel} aria-label={`Sion Keys · ${homeLabel}`} onClick={onHome}>
        <SionMark className="app-title-icon" />
        <SionWordmark className="title-brand" decorative />
      </button>
      <span className="title-divider" data-tauri-drag-region />
      <span className="title-subtitle" dir={languageDirection(language)} data-tauri-drag-region>{t("Chord & Key Analyzer")}</span>
      {tauri && (
        <div className="win-controls">
          {error && <span role="alert" title={error}>!</span>}
          <button type="button" aria-label={t("Minimize")} title={t("Minimize")} onClick={() => void win("minimize")}><Icon name="minus" size={20} /></button>
          <button type="button" aria-label={t("Full screen")} title={t("Full screen")} aria-pressed={fullscreen} onClick={() => void toggleFullscreen()}><Icon name="expand" size={18} /></button>
          <button type="button" aria-label={t("Close")} title={t("Close")} className="close" onClick={() => void win("close")}><Icon name="close" size={20} /></button>
        </div>
      )}
    </header>
  );
}
