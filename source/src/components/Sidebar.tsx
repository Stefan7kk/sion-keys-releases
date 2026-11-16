import { languages, navLabels, type Language } from "../lib/languages";
import { translate } from "../lib/i18n";
import type { NavId, ThemeId } from '../lib/types';
import { Icon } from './Icon';
import blueArtwork from "../assets/sidebar-blue.png";
import purpleArtwork from "../assets/sidebar-purple.png";
import orangeArtwork from "../assets/sidebar-orange.png";
import iceArtwork from "../assets/sidebar-ice.png";

const artwork: Record<ThemeId, string> = {
  blue: blueArtwork,
  purple: purpleArtwork,
  orange: orangeArtwork,
  white: iceArtwork,
};

const NAV: [NavId, string, string][] = [['analyze', 'home', 'Analyze'], ['history', 'clock', 'History'], ['settings', 'settings', 'Settings'], ['about', 'info', 'About']];

export function Sidebar(p: { language: Language; theme: ThemeId; nav: NavId; version: string; onNav: (n: NavId) => void }) {
  return (
    <aside className="sidebar">
      <nav aria-label={translate(p.language, "Main navigation")}>{NAV.map(([n, icon]) =>
        <button key={n} type="button" className={p.nav === n ? 'selected' : ''} aria-current={p.nav === n ? 'page' : undefined} title={languages[p.language][navLabels[n]]} onClick={() => p.onNav(n)}><Icon name={icon} size={22} /><bdi>{languages[p.language][navLabels[n]]}</bdi></button>
      )}</nav>
      <div className="sidebar-theme-art" aria-hidden="true">
        <img src={artwork[p.theme]} alt="" width={432} height={880} draggable={false} />
      </div>
      <footer className="sidebar-footer">
        <div><bdi dir="ltr">v{p.version}</bdi><span aria-hidden="true">·</span><span>{translate(p.language, "License")} <bdi>{"MIT"}</bdi></span></div>
        <bdi dir="ltr">{"© 2026 Stefan Dimov"}</bdi>
      </footer>
    </aside>
  );
}
