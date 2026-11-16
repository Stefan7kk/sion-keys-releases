import { useId, useRef, useState } from "react";
import { translate } from "../lib/i18n";
import type { Language } from "../lib/languages";
import { actionForKey, capturedShortcut, defaultShortcuts, shortcutActions, shortcutIds, shortcutKeyLabel, type ShortcutAction, type Shortcuts } from "../lib/shortcuts";
import { Icon } from "./Icon";

export function ShortcutSettings({ language, bindings, onChange }: {
  language: Language;
  bindings: Shortcuts;
  onChange: (bindings: Shortcuts) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const help = useId();
  const [recording, setRecording] = useState<ShortcutAction | null>(null);
  const [notice, setNotice] = useState("");
  const t = (key: string, params?: Record<string, string>) => translate(language, key, params);
  return <>
    <button type="button" className="btn btn-ghost st-shortcuts-trigger" onClick={() => dialog.current?.showModal()}>
      <Icon name="keyboard" size={18} />{t("Keyboard shortcuts")}
    </button>
    <dialog className="st-shortcuts-dialog" ref={dialog} aria-labelledby={title} aria-describedby={help}
      onClose={() => { setRecording(null); setNotice(""); }}>
      <header>
        <h2 id={title}>{t("Keyboard shortcuts")}</h2>
        <button type="button" className="btn btn-ghost" aria-label={t("Close")} onClick={() => dialog.current?.close()}><Icon name="close" size={18} /></button>
      </header>
      <p id={help}>{t("Select a shortcut, then press a letter, number, symbol, arrow key, or Space. Press Esc to cancel.")}</p>
      <dl>
        {shortcutIds.map(action => {
          const label = t(shortcutActions[action]);
          return <div key={action}>
            <dt>{label}</dt>
            <dd>
              <button type="button" className="btn btn-ghost st-shortcut-key" aria-pressed={recording === action}
                aria-label={t("Change shortcut for {action}", { action: label })}
                onBlur={() => { if (recording === action) setRecording(null); }}
                onClick={() => { setRecording(action); setNotice(""); }}
                onKeyDown={event => {
                  if (recording !== action || event.key === "Tab" || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  event.stopPropagation();
                  if (event.repeat) return;
                  if (event.key === "Escape") {
                    setRecording(null);
                    setNotice("");
                    return;
                  }
                  const key = capturedShortcut(event.nativeEvent);
                  if (!key) return;
                  const conflict = actionForKey(bindings, key);
                  if (conflict && conflict !== action) {
                    setNotice(t("That key is already assigned to {action}.", { action: t(shortcutActions[conflict]) }));
                    return;
                  }
                  onChange({ ...bindings, [action]: key });
                  setRecording(null);
                  setNotice("");
                }}>
                {recording === action ? t("Press a key…") : <kbd>{shortcutKeyLabel(bindings[action], t("Space"))}</kbd>}
              </button>
            </dd>
          </div>;
        })}
      </dl>
      <footer>
        <p role="status">{notice}</p>
        <button type="button" className="btn btn-ghost" onClick={() => {
          onChange({ ...defaultShortcuts });
          setRecording(null);
          setNotice("");
        }}>{t("Reset shortcuts")}</button>
      </footer>
    </dialog>
  </>;
}
