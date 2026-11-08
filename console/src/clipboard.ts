/** Clipboard also works on plain-HTTP LAN demos through the selection fallback. */
export async function writeClipboard(text: string) {
  if (navigator.clipboard) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* Try a selection. */ }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  const focused = document.activeElement;
  document.body.append(area);
  try {
    area.select();
    if (!document.execCommand("copy")) throw new Error("copy failed");
  } finally {
    area.remove();
    if (focused instanceof HTMLElement) focused.focus();
  }
}
