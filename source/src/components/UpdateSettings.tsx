import { useCallback, useEffect, useRef, useState } from "react";
import { isTauriRuntime } from "../lib/engine";
import { translate } from "../lib/i18n";
import type { Language } from "../lib/languages";
import { Icon } from "./Icon";

type Release = { version: string; notes: string | null };
type Progress = { phase: "downloading"; received: number; total: number | null } | { phase: "installing" };

const notificationKey = "sion-keys-notified-update";

export function useAppUpdates(enabled: boolean) {
  const [release, setRelease] = useState<Release | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [notification, setNotification] = useState<Release | null>(null);
  const working = useRef(false);
  const lastNotice = useRef("");
  const check = useCallback(async (automatic = false) => {
    if (working.current) return;
    if (!automatic) {
      setNotification(null);
      setNotice("");
    }
    setProgress(null);
    if (!isTauriRuntime()) {
      if (!automatic) setNotice("Updates are not configured for this build.");
      return;
    }
    working.current = true;
    setBusy(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const found = await invoke<Release | null>("check_hearthkeys_update");
      setRelease(found);
      if (found) {
        let previous = lastNotice.current;
        try { previous ||= localStorage.getItem(notificationKey) ?? ""; } catch {}
        if (previous !== found.version) {
          lastNotice.current = found.version;
          try { localStorage.setItem(notificationKey, found.version); } catch {}
          if (automatic) setNotification(found);
        }
      }
      if (!automatic && !found) setNotice("Sion Keys is up to date.");
    } catch (error) {
      if (!automatic) setNotice(typeof error === "string" ? error : "Could not check for updates.");
    } finally { working.current = false; setBusy(false); }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    const startup = window.setTimeout(() => void check(true), 2200);
    return () => window.clearTimeout(startup);
  }, [enabled, check]);
  const install = async (version: string) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setRelease(null);
    setNotice("");
    setProgress({ phase: "downloading", received: 0, total: null });
    try {
      const { invoke, Channel } = await import("@tauri-apps/api/core");
      const onProgress = new Channel<Progress>(setProgress);
      await invoke("install_hearthkeys_update", { version, onProgress });
      setRelease(null);
      setNotice("Update installed. Restart Sion Keys.");
    } catch (error) {
      setNotice(typeof error === "string" ? error : "Could not install the signed update.");
    } finally { working.current = false; setBusy(false); setProgress(null); }
  };
  return { release, busy, progress, notice, notification, check, install, dismissNotification: () => setNotification(null) };
}

export function UpdateSettings({ language, updates }: { language: Language; updates: ReturnType<typeof useAppUpdates> }) {
  const t = (key: string) => translate(language, key);
  const { release, busy, progress, notice, check, install } = updates;
  return <div className="st-updates">
    <button type="button" className="st-bible-link st-update-trigger" disabled={busy} aria-busy={busy} onClick={() => void check()}>
      <span className="st-update-icon"><Icon name="download" size={20} /></span>
      <span>
        <strong>{t("Check for Updates")}</strong>
        <small role="status">{t(busy && !progress ? "Checking for updates…" : notice || (release ? "Update available" : "Sion Keys updates"))}</small>
      </span>
    </button>
    {release && !busy && <div className="st-release">
      <strong><bdi>Sion Keys {release.version}</bdi></strong>
      {release.notes && <p tabIndex={0} dir="auto">{release.notes}</p>}
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void install(release.version)}>{t("Download and install update")}</button>
    </div>}
    {progress && <div role="status">
      {t(progress.phase === "installing" ? "Installing update…" : "Downloading update…")}
      {progress.phase === "downloading" && <progress aria-label={t("Downloading update…")} max={progress.total || undefined}
        value={progress.total ? Math.min(progress.received, progress.total) : undefined} />}
    </div>}
  </div>;
}
