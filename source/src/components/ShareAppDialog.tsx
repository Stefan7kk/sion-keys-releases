import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { translate } from "../lib/i18n";
import { languageDirection, type Language } from "../lib/languages";
import type { ThemeId } from "../lib/types";
import {
  APP_SHARE_COPY, APP_SHARE_TITLE, APP_SHARE_UNAVAILABLE, SHARE_PLATFORMS,
  appShareTargets, publicShareBase, shareDesign, type SharePlatform,
} from "../lib/appShare";
import lightArt from "../assets/sion-keys-share-light.png";
import darkArt from "../assets/sion-keys-share-dark.png";
import { Icon } from "./Icon";
import { RibbonWave } from "./Artwork";
import { SionMark } from "./SionMark";
import { SionWordmark } from "./SionWordmark";
import "./shareAppDialog.css";

const publicPage = publicShareBase(import.meta.env.VITE_SION_SHARE_URL);
const artwork = {
  light: { src: lightArt, width: 1118, height: 431 },
  dark: { src: darkArt, width: 1084, height: 370 },
};

function SocialIcon({ platform }: { platform: SharePlatform }) {
  return <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
    {platform === "Instagram" && <g fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2.7" y="2.7" width="18.6" height="18.6" rx="5" /><circle cx="12" cy="12" r="4.25" />
      <circle cx="17.5" cy="6.7" r="1" fill="currentColor" stroke="none" />
    </g>}
    {platform === "TikTok" && <path fill="currentColor" d="M14 2h3a5.3 5.3 0 0 0 5 5v3.1a8.5 8.5 0 0 1-5-1.6v7a6.4 6.4 0 1 1-6.4-6.4c.5 0 .9 0 1.4.1v3.25a3.2 3.2 0 1 0 2 3z" />}
    {platform === "Facebook" && <path fill="currentColor" d="M12 1a11 11 0 0 0-1.7 21.9v-7.8H7.6V12h2.7V9.6c0-2.8 1.7-4.4 4.2-4.4 1.2 0 2.5.2 2.5.2v2.7h-1.4c-1.4 0-1.8.9-1.8 1.8V12h3.1l-.5 3.1h-2.6v7.8A11 11 0 0 0 12 1z" />}
    {platform === "WhatsApp" && <>
      <path d="M3.1 17.1a10 10 0 1 1 4 3.8l-5 1.3z" stroke="currentColor" strokeWidth="1.8" fill="none" />
      <path d="M8 6.9c-.55 0-1.45.53-1.45 2.05 0 3.2 4.43 7.54 7.68 7.54 1.17 0 2.37-.66 2.5-1.86.03-.33-.19-.45-.5-.61l-2.1-1.02c-.31-.16-.53-.13-.75.15l-.68.89c-1.61-.53-3.33-2.13-3.77-3.46l.65-.8c.18-.22.21-.38.1-.65l-.88-1.88c-.15-.34-.38-.35-.8-.35z" fill="currentColor" />
    </>}
    {platform === "X" && <path fill="currentColor" d="M17.3 2h3.1l-6.8 7.8 8 12.2h-6.3l-4.9-7.4L4 22H.9l7.9-9L1.1 2h6.5l4.5 6.8zM16.4 20h1.7L6.6 3.9H4.8z" />}
    {platform === "Telegram" && <path fill="currentColor" d="M22 2 2.2 9.7c-.9.36-.92.86-.16 1.13l5.06 1.58L18.7 5.1c.55-.34.98-.16.57.18L9.8 13.9l-.38 5.15c.55 0 .8-.22 1.1-.51l2.44-2.36 5.04 3.73c.94.47 1.59.2 1.82-.91L23.3 3c.25-1-.38-1.44-1.3-1z" />}
  </svg>;
}

export function ShareAppDialog({ language, theme, tauri, onClose }: {
  language: Language; theme: ThemeId; tauri: boolean; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const focus = useRef<HTMLTextAreaElement>(null);
  const platformButton = useRef<HTMLButtonElement | null>(null);
  const [preparing, setPreparing] = useState<SharePlatform | null>(null);
  const [caption, setCaption] = useState("");
  const [notice, setNotice] = useState("");
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const t = (key: string) => translate(language, key);
  const design = shareDesign(theme);
  const art = artwork[design];
  const publicUrl = publicPage?.href;
  const title = t(APP_SHARE_TITLE);
  const description = t(APP_SHARE_COPY);
  const { caption: suggestion, targets } = appShareTargets(language, design, title, description, publicPage);
  const manualMedia = preparing === "Instagram" || preparing === "TikTok";

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);
  useLayoutEffect(() => {
    if (preparing) focus.current?.focus();
    else platformButton.current?.focus();
  }, [preparing]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 2600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  async function copy(text: string) {
    if (!text) return;
    setNotice("");
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Copied");
    } catch {
      setNotice("Could not copy. Select the text and copy it manually.");
    }
  }

  async function open(url: string) {
    setFailedUrl(null);
    try {
      if (tauri) await (await import("@tauri-apps/plugin-shell")).open(url);
      else window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      setFailedUrl(url);
    }
  }

  function choose(platform: SharePlatform, button: HTMLButtonElement) {
    const url = targets[platform];
    if (!url) return;
    if (platform === "Instagram" || platform === "TikTok" || platform === "Facebook") {
      platformButton.current = button;
      setCaption(platform === "Facebook" ? `${title}\n\n${description}` : suggestion);
      setNotice("");
      setFailedUrl(null);
      setPreparing(platform);
    } else void open(url);
  }

  function back() {
    setPreparing(null);
    setNotice("");
    setFailedUrl(null);
  }

  return <dialog className="share-app" data-design={design} ref={dialog} onClose={onClose} onCancel={event => {
    if (preparing) { event.preventDefault(); back(); }
  }} onKeyDown={event => {
    if (preparing && event.key === "Escape") {
      event.preventDefault();
      back();
    }
  }} aria-labelledby="share-app-title" lang={language} dir={languageDirection(language)}>
    <div className="share-app-layout">
      <header className="share-app-header">
        <div className="share-app-brand"><SionMark /><SionWordmark /></div>
        <div className="share-app-heading"><Icon name="share" size={31} /><h2 id="share-app-title">{t("Share the App")}</h2></div>
        <button type="button" className="share-app-close" onClick={() => dialog.current?.close()} aria-label={t("Close")} autoFocus><Icon name="close" size={22} /></button>
      </header>

      <div className="share-app-art"><img {...art} alt={t("Sion Keys promotional artwork")} draggable={false} /></div>

      <div className="share-app-main" hidden={preparing !== null}>
        <div className="share-app-invitation">
          <h3>{design === "dark" ? t("Love Sion Keys?") : title}</h3>
          <p>{description}</p>
        </div>
        <div className="share-app-platforms">
          {SHARE_PLATFORMS.map(platform => <button type="button" key={platform} data-platform={platform}
            disabled={!targets[platform]} onClick={event => choose(platform, event.currentTarget)}>
            <SocialIcon platform={platform} /><bdi>{platform}</bdi>
          </button>)}
        </div>
        <div className="share-app-link">
          <button type="button" className="share-app-primary" disabled={!publicUrl} onClick={() => void copy(publicUrl ?? "")}><Icon name="link" size={21} />{t("Copy page link")}</button>
          {publicUrl ? <bdi dir="ltr">{publicUrl}</bdi> : <span>{t(APP_SHARE_UNAVAILABLE)}</span>}
        </div>
      </div>

      {preparing && <section className="share-app-prepare" aria-label={preparing}>
        <div className="share-app-prepare-title"><SocialIcon platform={preparing} /><strong>{preparing}</strong></div>
        <p>{t(preparing === "Instagram"
          ? "Save the artwork and copy the caption, then choose Create in Instagram."
          : preparing === "TikTok"
            ? "Copy the caption and open TikTok. To post this photo, use the TikTok mobile app if the website only accepts video."
            : "Facebook shares the link and its preview. Copy this caption if you want to paste it into your post.")}</p>
        <label htmlFor="share-app-caption">{t("Suggested caption")}</label>
        <textarea id="share-app-caption" ref={focus} dir="auto" value={caption} onChange={event => setCaption(event.target.value)} rows={3} />
        <div className="share-app-prepare-actions">
          <button type="button" className="btn btn-ghost" onClick={back}>{t("Back to sharing")}</button>
          <button type="button" className="btn btn-ghost" onClick={() => void copy(caption)} disabled={!caption.trim()}><Icon name="copy" size={16} />{t("Copy caption")}</button>
          {manualMedia && <a className="btn btn-ghost" href={art.src} download={`Sion-Keys-${design}.png`}><Icon name="download" size={16} />{t("Save artwork")}</a>}
          <button type="button" className="share-app-primary" onClick={() => { const url = targets[preparing]; if (url) void open(url); }}>
            {t("Open {platform}").replace("{platform}", preparing)}<Icon name="external" size={16} />
          </button>
        </div>
      </section>}
      <p className="share-app-feedback" role="status">{notice && t(notice)}</p>
      {failedUrl && <p className="share-app-error" role="alert">{t("Could not open the browser. Copy this link into your browser:")} <bdi dir="ltr">{failedUrl}</bdi></p>}
      <RibbonWave className="share-app-wave" />
    </div>
  </dialog>;
}
