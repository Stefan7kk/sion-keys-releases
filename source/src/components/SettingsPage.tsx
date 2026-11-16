import { useState } from "react";
import { WindowSizeSetting } from "./WindowSizeSetting";
import { SionMark } from "./SionMark";
import { SionWordmark } from "./SionWordmark";
import { languageDirection, languages, navLabels, type Language } from "../lib/languages";
import { localizeMessage, translate } from "../lib/i18n";
import type { Mp3Quality, ThemeId } from "../lib/types";
import { Icon } from "./Icon";
import { DiagnosticDetails } from "./DiagnosticDetails";
import { ThemeWave } from "./Artwork";
import { pickExportFolder } from "../lib/engine";
import { LyricsSettings } from "./LyricsControls";
import { ShortcutSettings } from "./ShortcutSettings";
import type { Shortcuts } from "../lib/shortcuts";
import { UpdateSettings, type useAppUpdates } from "./UpdateSettings";

export const MP3_QUALITY_LABELS: Record<Mp3Quality, string> = { high: "Best quality", "192": "Balanced · 192 kbps", "128": "Smaller file · 128 kbps" };

const STORAGE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"];
const BIBLE_LANGUAGES_URL = "https://www.bible.com/languages";

export function SettingsPage(p: {
  shortcuts: Shortcuts;
  onShortcuts: (value: Shortcuts) => void;
  language: Language;
  tauri: boolean;
  theme: ThemeId;
  onTheme: (t: ThemeId) => void;
  mp3Quality: Mp3Quality;
  onMp3Quality: (q: Mp3Quality) => void;
  askSaveLocation: boolean;
  onAskSaveLocation: (value: boolean) => void;
  cacheBytes: number | null;
  historyBytes: number;
  engineReady: boolean;
  cacheBusy: boolean;
  onClearCache: () => void;
  cacheNotice: string;
  cacheError: string;
  onClearHistory: () => void;
  version: string;
  mp3Folder: string;
  chordFolder: string;
  onMp3Folder: (folder: string) => void;
  onChordFolder: (folder: string) => void;
  edgeGlow: boolean;
  onEdgeGlow: (value: boolean) => void;
  compactLayout: boolean;
  onCompactLayout: (value: boolean) => void;
  updates: ReturnType<typeof useAppUpdates>;
}) {
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderError, setFolderError] = useState("");
  const chooseFolder = async (kind: "mp3" | "chord") => {
    setFolderBusy(true);
    setFolderError("");
    try {
      const folder = await pickExportFolder(kind === "mp3" ? p.mp3Folder : p.chordFolder, p.language);
      if (folder !== null) (kind === "mp3" ? p.onMp3Folder : p.onChordFolder)(folder);
    } catch (error) {
      setFolderError(String(error));
    } finally {
      setFolderBusy(false);
    }
  };
  const t = (key: string, params?: Record<string, string | number>) => translate(p.language, key, params);
  const dir = languageDirection(p.language);
  const fmt = (bytes: number) => {
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < STORAGE_UNITS.length - 1) {
      value /= 1024;
      unit++;
    }
    return `${value.toLocaleString(p.language, { maximumFractionDigits: 2 })} ${STORAGE_UNITS[unit]}`;
  };
  const used = p.cacheBytes === null ? null : p.cacheBytes + p.historyBytes;
  const platform = /Windows/i.test(navigator.userAgent)
    ? (/Win64|x64/i.test(navigator.userAgent) ? t("Windows (64-bit)") : t("Windows"))
    : t("Desktop");

  return (
    <div className="settings-grid" dir={dir}>
        <section className="card st-card st-appearance">
          <header className="st-head"><Icon name="palette" size={28} /><div><h2>{t("Appearance")}</h2><p>{t("Change the look and feel of Sion Keys.")}</p></div></header>
          <div className="st-appearance-controls">
          <div className="st-themes" role="group" aria-label={t("Theme")}>
            {([
              { id: "blue", label: t("Dark") },
              { id: "orange", label: t("Warm") },
              { id: "purple", label: t("Rich") },
              { id: "white", label: t("Ice") },
            ] as const).map(({ id, label }) => (
              <button key={id} type="button" className={`st-theme st-theme-${id} ${p.theme === id ? "on" : ""}`} aria-pressed={p.theme === id} onClick={() => p.onTheme(id)}>
                <div className="st-preview" aria-hidden="true">
                  <div className="st-preview-title"><SionMark /><i /><b>− ×</b></div>
                  <div className="st-preview-body">
                    <div className="st-preview-nav">{Array.from({ length: 5 }, (_, i) => <i key={i} />)}</div>
                    <div className="st-preview-main"><ThemeWave /><i /><i /></div>
                  </div>
                </div>
                <span>{label}</span>
                {p.theme === id && <i className="st-theme-check"><Icon name="check" size={18} /></i>}
              </button>
            ))}
          </div>
          <div className="st-look-options">
            <WindowSizeSetting language={p.language} desktop={p.tauri} />
            <label className="st-look-option">
              <input type="checkbox" checked={p.edgeGlow} onChange={e => p.onEdgeGlow(e.target.checked)} />
              <span>
                <strong>{t("Edge glow")}</strong>
                <small>{t("A soft colored light around the window, in this theme's colors.")}</small>
              </span>
            </label>
            <label className="st-look-option">
              <input type="checkbox" checked={p.compactLayout} onChange={e => p.onCompactLayout(e.target.checked)} />
              <span>
                <strong>{t("Compact layout")}</strong>
                <small>{t("A simpler Analyze page, with less on screen.")}</small>
              </span>
            </label>
          </div>
          <ShortcutSettings language={p.language} bindings={p.shortcuts} onChange={p.onShortcuts} />
          </div>
        </section>

        <section className="card st-card st-downloads">
          <header className="st-head"><Icon name="bars" size={36} /><div><h2>{t("Audio & Downloads")}</h2><p>{t("Control how audio is analyzed, played, and exported.")}</p></div></header>
          <div className="st-quality">
            <div>
              <label className="st-label" htmlFor="st-mp3-quality">{t("MP3 export quality")}</label>
              <select id="st-mp3-quality" className="st-select themed-select" value={p.mp3Quality} onChange={e => p.onMp3Quality(e.target.value as Mp3Quality)}>
                {Object.entries(MP3_QUALITY_LABELS).map(([quality, label]) => <option value={quality} key={quality}>{t(label)}</option>)}
              </select>
            </div>
            <p className="st-sub">{t("Best quality uses a variable bitrate to preserve more detail. Balanced and Smaller file save storage space. This setting only affects saved MP3 files, never chord analysis.")}</p>
          </div>
          {(["mp3", "chord"] as const).map(kind => {
            const folder = kind === "mp3" ? p.mp3Folder : p.chordFolder;
            const label = kind === "mp3" ? "Default MP3 export folder" : "Default chord sheet export folder";
            return <div className="st-export-folder" key={kind}>
              <label htmlFor={`export-folder-${kind}`}><Icon name={kind === "mp3" ? "folder" : "music"} size={22} />{t(label)}</label>
              <div className="st-folder-path"><Icon name="folder" size={17} />
                <input id={`export-folder-${kind}`} readOnly value={folder} placeholder={t("Use system default")} dir="ltr" title={folder} />
                {folder && <button type="button" className="st-folder-reset" aria-label={`${t("Reset")} · ${t(label)}`} title={t("Reset")}
                  disabled={folderBusy} onClick={() => { setFolderError(""); (kind === "mp3" ? p.onMp3Folder : p.onChordFolder)(""); }}><Icon name="close" size={15} /></button>}
              </div>
              <button type="button" className="btn btn-ghost st-browse" disabled={!p.tauri || folderBusy} onClick={() => void chooseFolder(kind)}><Icon name="folder" size={18} />{t("Browse…")}</button>
            </div>;
          })}
          <div className="st-ask-save">
            <label><input type="checkbox" checked={p.askSaveLocation} disabled={!p.tauri} onChange={e => p.onAskSaveLocation(e.target.checked)} />{t("Ask where to save each time")}</label>
            <span className="st-save-info" title={t("Save dialogs start here. You can choose a different location each time.")}><Icon name="info" size={18} /></span>
          </div>
          {folderError && <><p className="st-folder-error" role="alert">{t("Could not choose the export folder.")}</p><DiagnosticDetails language={p.language} message={folderError} /></>}
          <LyricsSettings language={p.language} mode="language" />
        </section>

        <section className="card st-card st-storage">
          <header className="st-head"><Icon name="database" size={36} /><div><h2>{t("Storage & Privacy")}</h2><p>{t("Manage cached data, analysis history, and storage usage.")}</p></div></header>
          <div className="st-storage-body">
            <div className="st-cell">
              <div className="st-label-row">
                <span className="st-label">{t("Stored data")}</span>
                <span className="st-info" title={t("Temporary analysis audio is cached while a song is open. Saved MP3 files and the engine are not counted.")}><Icon name="info" size={16} /></span>
                <span className="st-usage-total"><bdi>{used === null ? "—" : fmt(used)}</bdi></span>
              </div>
              <div className="st-meter" aria-hidden="true">
                {p.cacheBytes !== null && used !== null && used > 0 && <>
                  <span className="cache" style={{ width: `${(p.cacheBytes / used) * 100}%` }} />
                  <span className="hist" style={{ width: `${(p.historyBytes / used) * 100}%` }} />
                </>}
              </div>
              <div className="st-legend">
                <span><i className="cache" />{t("Analysis cache")}<bdi dir="ltr">{p.cacheBytes === null ? "—" : fmt(p.cacheBytes)}</bdi></span>
                <span><i className="hist" />{languages[p.language][navLabels.history]}<bdi dir="ltr">{fmt(p.historyBytes)}</bdi></span>
              </div>
            </div>
            <div className="st-storage-actions">
              <button type="button" className="btn btn-ghost" disabled={!p.tauri || p.cacheBusy} onClick={p.onClearCache}><Icon name="broom" size={20} />{t("Clear analysis cache")}</button>
              <button type="button" className="btn btn-ghost" onClick={p.onClearHistory}><Icon name="clock" size={20} />{t("Clear history")}</button>
            </div>
          </div>
          <LyricsSettings language={p.language} mode="cache" />
          {p.cacheNotice && <p role="status" className="st-sub">{localizeMessage(p.language, p.cacheNotice)}</p>}
          {p.cacheError && <DiagnosticDetails language={p.language} message={p.cacheError} />}
          <div className="st-privacy-box">
            <Icon name="shieldcheck" size={32} />
            <p><strong>{t("Privacy")}</strong> · {t("Audio stays on this device. The shared library receives chords, timing and a recording ID. Lyrics search sends the song title and artist to LRCLIB.")}</p>
          </div>
        </section>

        <section className="card st-card st-about">
          <header className="st-head"><Icon name="info" size={36} /><div><h2>{t("About Sion Keys")}</h2><p>{t("App version and platform details.")}</p></div>
            <span className={`st-engine-badge ${p.engineReady ? "ok" : ""}`}><Icon name={p.engineReady ? "checkcircle" : "info"} size={19} />{t("Engine")} · {t(p.engineReady ? "Ready" : "Unavailable")}</span>
          </header>
          <div className="st-version-head">
            <SionMark className="st-logo" />
            <div>
              <div className="st-brand-line">
                <SionWordmark />
                <bdi className="st-brand-version" dir="ltr">v{p.version || "0.1.0"}</bdi>
              </div>
              <p className="st-sub">{t("Chord & Key Analyzer")}</p>
            </div>
          </div>
          <div className="st-version-rows">
            <div><Icon name="grid" size={19} /><span>{t("Platform")}</span><bdi dir="ltr">{platform}</bdi></div>
            <div><Icon name="code" size={19} /><span>{t("Build")}</span><bdi dir="ltr">{p.version || "0.1.0"}</bdi></div>
          </div>
          <div className="st-about-actions">
            <UpdateSettings language={p.language} updates={p.updates} />
            <a className="st-bible-link" href={BIBLE_LANGUAGES_URL} target="_blank" rel="noopener noreferrer">
              <svg className="st-bible-icon" viewBox="0 0 44 44" aria-hidden="true">
                <rect width="44" height="44" rx="11" fill="#b82925" />
                <path d="M7 8q0-4 4-4h26v29H12q-5 0-5 4z" fill="#a42120" />
                <path d="M10 33h28v6H10a3 3 0 0 1 0-6Z" fill="#fff1d8" />
                <path d="M13 34v8l3-2 3 2v-8" fill="#dd6250" />
                <text x="22" y="15" textAnchor="middle" fill="#fff9ed" fontFamily="Georgia, serif" fontSize="8.5" fontWeight="700">HOLY</text>
                <text x="22" y="25" textAnchor="middle" fill="#fff9ed" fontFamily="Georgia, serif" fontSize="10" fontWeight="700">BIBLE</text>
              </svg>
              <span>
                <strong>{t("Read the Bible on Bible.com")}</strong>
                <small>{t("Explore Scripture in your language")}</small>
              </span>
              <Icon name="external" size={17} />
            </a>
          </div>
        </section>
    </div>
  );
}
