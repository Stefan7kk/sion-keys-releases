export const windowSizes = [[1440, 900], [1320, 800], [1280, 700]] as const;
const storageKey = "hearthkeys-window-size";

export function savedWindowSize() {
  const saved = localStorage.getItem(storageKey);
  return windowSizes.findIndex(([w, h]) => saved === `${w}x${h}`) < 0 ? 0
    : windowSizes.findIndex(([w, h]) => saved === `${w}x${h}`);
}

export async function applyWindowSize(index: number) {
  const size = windowSizes[index];
  if (!size) return;
  const { getCurrentWindow, LogicalSize } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  await win.setFullscreen(false);
  await win.setSize(new LogicalSize(size[0], size[1]));
  await win.center();
  localStorage.setItem(storageKey, `${size[0]}x${size[1]}`);
}
