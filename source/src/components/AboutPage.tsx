import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { languageDirection, type Language } from "../lib/languages";
import type { ThemeId } from "../lib/types";
import { translate } from "../lib/i18n";
import { Icon } from "./Icon";
import { RibbonWave } from "./Artwork";
import storyArt from "../assets/hearth-path-about.png";
import mitLicense from "../../LICENSE?raw";
import { SionMark } from "./SionMark";
import { SionWordmark } from "./SionWordmark";
import { DiagnosticDetails } from "./DiagnosticDetails";
import { ShareAppDialog } from "./ShareAppDialog";

const SUPPORT_URL = "https://ko-fi.com/stefandimov1008";
const FEATURES = [["music", "Key & Chord Detection"], ["layers", "Chord Sheets & Diagrams"], ["bars", "Song Timeline"], ["video", "Audio & YouTube Support"]];
const RESOURCES = [["book", "Documentation", "User guide, features, and tips"], ["help", "Help & Support", "FAQs and common solutions"], ["refresh", "Release Notes", "What's new in this version"]];
const REVOLUT_URL = "https://revolut.me/sdimov99";
const publication: { reviews: Record<string, string | undefined> } = {
  reviews: { Reddit: undefined, GitHub: undefined, Facebook: undefined },
};

export function AboutPage({ language, theme, version, tauri }: { language: Language; theme: ThemeId; version: string; tauri: boolean }) {
  const t = (key: string) => translate(language, key);
  const englishStory = language === "en";
  const storyWithBrand = (key: string) => {
    const [before, after] = t(key).split("{brand}");
    return <>{before}<strong>Sion Keys</strong>{after}</>;
  };
  const dir = languageDirection(language);
  const [panel, setPanel] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; url?: string } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = wrapRef.current;
    const host = el?.parentElement;
    if (!el || !host) return;
    const fitContent = () => {
      // Measure the unscaled layout at its actual width on every update.
      // scrollHeight is in layout pixels, even when CSS zoom is applied.
      el.style.zoom = "1";
      const hostStyle = getComputedStyle(host);
      const contentTop = el.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop;
      const available = host.clientHeight - contentTop - parseFloat(hostStyle.paddingBottom) - 8;
      const height = el.getBoundingClientRect().height;
      if (height > 0 && available > 0) {
        el.style.zoom = String(Math.min(1, Math.max(.8, available / height)));
      }
    };
    host.scrollTop = 0;
    fitContent();
    const observer = new ResizeObserver(fitContent);
    observer.observe(host);
    document.fonts.addEventListener("loadingdone", fitContent);
    return () => {
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", fitContent);
    };
  }, [language, error]);
  useEffect(() => { if (panel) dialog.current?.showModal(); }, [panel]);
  const platform = /Windows/i.test(navigator.userAgent) ? (/Win64|x64/i.test(navigator.userAgent) ? t("Windows (64-bit)") : t("Windows")) : t("Desktop");

  const showPanel = (title: string) => {
    setError(null);
    setPanel(title);
  };

  const openExternal = async (url: string) => {
    setError(null);
    try {
      if (tauri) {
        const { open } = await import("@tauri-apps/plugin-shell");
        await open(url);
      } else {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    } catch (reason) {
      setError({ message: String(reason), url });
    }
  };

  const feedback = <>
    {error && <>
      {error.url && <p className="ab-notice" role="alert">{t("Could not open the browser. Copy this link into your browser:")} <bdi dir="ltr">{error.url}</bdi></p>}
      <DiagnosticDetails language={language} message={error.message} />
    </>}
  </>;
  const destinations = (targets: Record<string, string | undefined>, showUnavailable = true) => <div className="ab-destinations">
    {Object.entries(targets).map(([name, url]) => <button type="button" className="ab-resource" key={name}
      disabled={!url} onClick={() => { if (url) void openExternal(url); }}>
      <Icon name="globe" size={20} />
      <span><strong>{name}</strong>{!url && showUnavailable && <small>{t("Unavailable")}</small>}</span>
      {url && <Icon name="external" size={16} />}
    </button>)}
  </div>;

  return (
    <>
      <div className="about-wrap" lang={language} dir={dir} ref={wrapRef}>
        <section className="card ab-identity">
          <div className="ab-id-left">
            <div className="ab-id-row">
              <SionMark className="ab-logo" />
              <div>
                <h2 className="ab-wordmark"><SionWordmark /></h2>
                <p className="ab-subtitle">{t("Chord & Key Analyzer")}</p>
              </div>
            </div>
            <p className="ab-tagline">{t("Find the chords. Play the songs you love.")}</p>
          </div>
          <div className="ab-features">
            <p className="ab-desc">{t("Sion Keys analyzes songs from audio files or YouTube links, detects the key and chords, and helps you explore the music with a timeline, chord sheet, and chord diagrams.")}</p>
            <div className="ab-feature-grid">
              {FEATURES.map(([icon, title]) => <div className="ab-feature" key={title}><span><Icon name={icon} size={29} /></span><strong>{t(title)}</strong></div>)}
            </div>
          </div>
          <RibbonWave className="ab-hero-wave" />
        </section>

        <div className="ab-card-grid">
          <section className="card ab-card ab-information">
            <header className="ab-card-head"><Icon name="layers" size={31} /><h2>{t("App Information")}</h2></header>
            <dl className="ab-info-list">
              <div><dt>{t("Version")}</dt><dd><bdi className="ab-version" dir="ltr">v{version || "0.1.0"}</bdi></dd></div>
              <div><dt>{t("License")}</dt><dd><button type="button" className="ab-text-action" onClick={() => showPanel("License")}>{"MIT"}<Icon name="info" size={15} /></button></dd></div>
              <div><dt>{t("Built with")}</dt><dd><bdi>{"Tauri 2 · React · Python · FFmpeg"}</bdi></dd></div>
              <div><dt>{t("Platform")}</dt><dd><Icon name="monitor" size={17} /><bdi>{platform}</bdi></dd></div>
            </dl>
          </section>

          <section className="card ab-card ab-story">
            <header className="ab-card-head"><Icon name="user" size={31} /><h2>{t("The Story Behind Sion Keys")}</h2></header>
            <p>{t("Created by Stefan Dimov, Sion Keys was born from a love for music, piano, and worship. The goal is to make chord and key analysis simple, practical, and accessible for everyone — whether you're learning, playing, or teaching music.")}</p>
            <blockquote className="ab-quote"><p>{t("“Keep thy heart with all diligence; for out of it are the issues of life.”")}</p><footer>{t("Proverbs 4:23, KJV")}</footer></blockquote>
            <button type="button" className="ab-text-action ab-story-btn" onClick={() => showPanel("The Story Behind Sion Keys")}>{t("Read the full story")}<Icon name="chevron" size={14} /></button>
            <img className="ab-story-art" src={storyArt} alt="" draggable={false} />
          </section>

          <section className="card ab-card ab-resources">
            <header className="ab-card-head"><Icon name="book" size={32} /><div><h2>{t("Resources")}</h2><p>{t("Get help, learn more, or stay up to date.")}</p></div></header>
            <div className="ab-resource-list">
              {RESOURCES.map(([icon, title, caption]) => <button type="button" className="ab-resource" key={title} onClick={() => showPanel(title)}><Icon name={icon} size={26} /><span><strong>{t(title)}</strong><small>{t(caption)}</small></span><Icon name="chevron" size={19} /></button>)}
            </div>
          </section>

          <section className="card ab-card ab-support">
            <header className="ab-card-head"><Icon name="heart" size={33} /><div><h2>{t("Support Sion Keys")}</h2><p>{t("If you find Sion Keys useful, consider supporting its development. Your support helps improve the app, add new features, and keep it free for everyone.")}</p></div></header>
            <button type="button" className="btn btn-primary ab-support-main" onClick={() => void openExternal(SUPPORT_URL)}>
              <Icon name="coffee" size={25} />{t("Support Sion Keys on Ko-fi")}<Icon name="external" size={18} />
            </button>
            <div className="ab-support-divider"><span>{t("Other ways to support")}</span></div>
            <div className="ab-support-actions">
              <button type="button" className="btn btn-ghost" onClick={() => void openExternal(REVOLUT_URL)}><Icon name="gift" size={21} />{t("Donate via Revolut")}</button>
              <button type="button" className="btn btn-ghost" onClick={() => showPanel("Share the App")}><Icon name="share" size={21} />{t("Share the App")}</button>
              <button type="button" className="btn btn-ghost" onClick={() => showPanel("Leave a Review")}><Icon name="star" size={21} />{t("Leave a Review")}</button>
            </div>
            {!panel && feedback}
          </section>
        </div>

      </div>

      {panel === "Share the App" && <ShareAppDialog language={language} theme={theme} tauri={tauri} onClose={() => setPanel(null)} />}
      {panel && panel !== "Share the App" && <dialog className="ab-dialog" ref={dialog} onClose={() => { setPanel(null); setError(null); }} aria-labelledby="ab-dialog-title" lang={language} dir={dir}>
        <header><h2 id="ab-dialog-title">{t(panel)}</h2><button type="button" className="btn btn-ghost" onClick={() => dialog.current?.close()} aria-label={t("Close")}><Icon name="close" size={20} /></button></header>
        <div className="ab-dialog-body">
          {panel === "Documentation" && <>
            <h3>{t("Analyze a song")}</h3><p>{t("Drop an audio file or click the drop area to browse. To use YouTube, search by title or paste a video link, then click Analyze.")}</p>
            <h3>{t("Explore the results")}</h3><p>{t("The Key card shows the estimated key. Play or seek through the timeline to follow chord changes. Detected Chords lists the results and Chord Diagrams shows suggested voicings.")}</p>
            <h3>{t("Practice tools")}</h3><p>{t("Loop a passage, change playback speed, or use capo shapes, a metronome, and chord numbers. Transpose shifts the displayed key and chords while the audio plays in its original key.")}</p>
            <h3>{t("Lyrics sheet")}</h3><p>{t("Find lyrics or edit the sheet yourself. Detected chords can follow the lyrics when line timing is available. In Compact layout, switch to Chord Diagrams for all detected chords on piano, guitar, or bass.")}</p>
            <h3>{t("Export")}</h3><p>{t("Use Export for CSV chord sheets, printable HTML charts, or JSON data. Set default folders in Settings. MP3 files are saved only when you explicitly choose Download or Export.")}</p>
          </>}
          {panel === "Help & Support" && <>
            <h3>{t("Why can a chord be wrong?")}</h3><p>{t("Dense mixes can make notes and chord changes harder to detect. Key Match measures how closely the audio fits the estimated key profile. The time signature can remain uncertain.")}</p>
            <h3>{t("What does Generate produce?")}</h3><p>{t("When available, Generate uses the local speech model to transcribe the performance. Review the generated words and timing before using them.")}</p>
            <h3>{t("Why is a saved song silent?")}</h3><p>{t("History saves the analysis. Keep local audio in its original folder. For a saved YouTube analysis, use Re-analyze to retrieve the audio again.")}</p>
            <h3>{t("Where are my exports?")}</h3><p>{t("Check your default export folders in Settings. If Ask where to save each time is enabled, check the destination you chose in the save dialog.")}</p>
          </>}
          {panel === "Release Notes" && <><h3><bdi dir="ltr">v{version || "0.1.0"}</bdi></h3><ul>
            <li>{t("Analyze includes Key, Detected Chords, and Key Match with transpose.")}</li>
            <li>{t("Compact layout offers a full, expandable Chord Diagrams view with piano, guitar, and bass.")}</li>
            <li>{t("Appearance includes four themes and three window sizes, with fullscreen in the title bar.")}</li>
            <li>{t("History supports search, filters, and batch MP3 export.")}</li>
          </ul></>}
          {panel === "License" && <><pre className="ab-license-text" dir="ltr" tabIndex={0}>{mitLicense}</pre><p>{t("Audio decoding and conversion use bundled LGPL FFmpeg.")}</p></>}
          {panel === "Leave a Review" && <>
            {destinations(publication.reviews)}
            {feedback}
          </>}
          {panel === "The Story Behind Sion Keys" && <div className="ab-story-full">
            {englishStory ? <>
              <p>{t("My name is Stefan Dimov. I began following Jesus after a personal encounter with Him in 2020.")}</p>
              <p>{t("Music has always had a special place in my heart. I love playing the piano and my Korg Pa arranger, but the greatest joy music brings me is the opportunity to worship Jesus and give glory to God.")}</p>
            </> : <p>{t("My name is Stefan Dimov. I've followed Jesus since a personal encounter with Him in 2020. Music has always been close to my heart, especially playing the piano and my Korg Pa arranger. But more than anything, I love using music to worship Jesus and give glory to God.")}</p>}
            <blockquote className="hearth-verse">
              <p>{t("“I am the way, the truth, and the life: no man cometh unto the Father, but by me.”")}</p>
              <footer><button type="button" className="ab-text-action" onClick={() => void openExternal("https://www.bible.com/bible/1/JHN.14.6.KJV")}>{t("John 14:6, KJV")}<Icon name="external" size={13} /></button></footer>
            </blockquote>
            <h3>{t("Why Sion Keys?")}</h3>
            {englishStory ? <>
              <p>{storyWithBrand("The name {brand} is inspired by Mount Sion, mentioned in Hebrews 12:22, where Scripture speaks of the city of the living God and the heavenly Jerusalem.")}</p>
              <p>{t("I chose this name because my faith and my love for worship are at the heart of this project. For me, Sion Keys is more than a music application. It is an opportunity to share something useful with others through the gift of music.")}</p>
            </> : <p>{t("The name comes from Mount Sion in Hebrews 12:22, where Scripture speaks of the city of the living God, the heavenly Jerusalem. I chose it to reflect the faith and worship that inspired this app.")}</p>}
            <p><button type="button" className="ab-text-action" onClick={() => void openExternal("https://www.bible.com/bible/1/HEB.12.22.KJV")}>{t("Hebrews 12:22, KJV")}<Icon name="external" size={15} /></button></p>
            <h3>{t("How Sion Keys Began")}</h3>
            {englishStory ? <>
              <p>{t("I learned to play music by ear, and I know how frustrating it can be to hear a beautiful song, want to play it, but struggle to find the right chords.")}</p>
              <p>{t("As I was learning, chord-recognition tools helped me understand songs that I couldn't figure out on my own. That experience gave me an idea: what if there were a simpler, more accessible way for people to discover chords, understand musical keys, and learn the songs they love?")}</p>
              <p>{storyWithBrand("That idea eventually became {brand}.")}</p>
              <p>{t("My goal was to create a free chord and key analyzer that musicians could use to explore songs, practice, and grow in confidence—whether they're complete beginners, experienced players, or members of a worship team.")}</p>
              <h3>{t("My Hope for Sion Keys")}</h3>
              <p>{t("I hope Sion Keys makes learning music a little easier and more enjoyable. I want it to help people spend less time struggling to find chords and more time playing, learning, creating, and sharing music with others.")}</p>
              <p>{t("If this application helps even one person learn a song they love, grow as a musician, or find greater joy in worship, then creating it has been worthwhile.")}</p>
              <p>{t("Above all, I am grateful to God for the opportunity to build something that may encourage and help others.")}</p>
            </> : <>
              <p>{t("I learned to play music by ear, and I know how frustrating it can be when you hear a beautiful song but can't figure out its chords.")}</p>
              <p>{t("While I was learning, chord recognition tools helped me understand songs I struggled to play. That experience inspired me to create something that could help others in the same way.")}</p>
              <p>{t("My hope is that Sion Keys helps musicians, worship teams, beginners, and anyone who loves music spend less time searching for chords and more time playing, learning, and enjoying the songs they love.")}</p>
              <p>{t("Above all, I'm grateful to God for the opportunity to create something that may be useful to others.")}</p>
            </>}
            <hr />
            <blockquote className="hearth-verse">
              <p lang="en" dir="ltr">{translate("en", "“Christ died for our sins ... and that he was buried, and that he rose again the third day according to the scriptures.”")}</p>
              <footer><button type="button" className="ab-text-action" onClick={() => void openExternal("https://www.bible.com/bible/1/1CO.15.3-4.KJV")}>{t("1 Corinthians 15:3–4, KJV")}<Icon name="external" size={13} /></button></footer>
            </blockquote>
            <blockquote className="hearth-verse">
              <p lang="en" dir="ltr">{translate("en", "“I am the resurrection, and the life: he that believeth in me, though he were dead, yet shall he live.”")}</p>
              <footer><button type="button" className="ab-text-action" onClick={() => void openExternal("https://www.bible.com/bible/1/JHN.11.25.KJV")}>{t("John 11:25, KJV")}<Icon name="external" size={13} /></button></footer>
            </blockquote>
            {feedback}
          </div>}
        </div>
      </dialog>}
    </>
  );
}
