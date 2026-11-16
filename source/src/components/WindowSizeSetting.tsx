import { useState } from "react";
import { applyWindowSize, savedWindowSize, windowSizes } from "../lib/windowSize";
import { translate } from "../lib/i18n";
import type { Language } from "../lib/languages";

export function WindowSizeSetting({ language, desktop }: { language: Language; desktop: boolean }) {
  const [selected, setSelected] = useState(savedWindowSize);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function change(index: number) {
    setBusy(true);
    setError("");
    try {
      await applyWindowSize(index);
      setSelected(index);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  return <div className="st-window-size">
    <label htmlFor="window-size">{translate(language, "Window size")}</label>
    <select id="window-size" className="themed-select" value={selected} disabled={!desktop || busy} onChange={e => void change(Number(e.target.value))}>
      {windowSizes.map(([w, h], i) => <option key={w} value={i}>{w} × {h}</option>)}
    </select>
    {error && <small role="alert">{error}</small>}
  </div>;
}
