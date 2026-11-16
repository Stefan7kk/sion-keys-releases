import { translate } from "../lib/i18n";
import type { Language } from "../lib/languages";

export function DiagnosticDetails({ language, message }: { language: Language; message: string }) {
  return <details className="diag-details">
    <summary>{translate(language, "Error details")}</summary>
    <pre dir="ltr" className="whitespace-pre-wrap break-all">{message}</pre>
    <button type="button" onClick={() => void navigator.clipboard.writeText(message).catch(() => {})}>{translate(language, "Copy error")}</button>
  </details>;
}