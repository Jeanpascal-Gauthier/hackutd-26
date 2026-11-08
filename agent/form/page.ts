// The two pages the form server serves: the report page (judges' phones) and the QR page
// (the table card). Plain HTML, inline CSS and JS, no build step.
// Inline JS lives in template literals: no "${" and no backslashes in it (use [0-9], [+]).

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// "Prefer iMessage?" step, rendered only when the server can register numbers on Photon.
// POST imessage { phone } -> { ok, number, reused } | { ok:false, error }. Server text goes in via textContent.
const IMESSAGE_SECTION = `<details id="im">
  <summary>Prefer iMessage? (iPhone)</summary>
  <form id="imf" novalidate>
    <label for="imp">Your iPhone number</label>
    <div class="imrow">
      <input id="imp" name="phone" type="tel" autocomplete="tel" inputmode="tel" maxlength="32" placeholder="415-555-0123" required>
      <button id="imb" type="submit">Get number</button>
    </div>
    <p id="ims" class="imnote" role="status" aria-live="polite">We sign up this number so you can text FireSight.</p>
  </form>
  <div id="imr" hidden>
    <p>Text FireSight at <strong id="imn"></strong></p>
    <a id="iml" class="sms" href="#">Open Messages</a>
    <p class="imnote">Text from the number you entered. Replies come by iMessage.</p>
  </div>
</details>
<script>
(function () {
  var f = document.getElementById("imf"), p = document.getElementById("imp"), b = document.getElementById("imb"),
      s = document.getElementById("ims"), r = document.getElementById("imr"),
      n = document.getElementById("imn"), l = document.getElementById("iml");
  function status(text, err) { s.textContent = text; s.className = err ? "imnote error" : "imnote"; }
  function pretty(num) {
    var d = num.replace(/[^0-9]/g, "");
    return d.length === 11 && d.charAt(0) === "1" ? "+1 (" + d.slice(1, 4) + ") " + d.slice(4, 7) + "-" + d.slice(7) : num;
  }
  f.addEventListener("submit", function (e) {
    e.preventDefault();
    if (b.disabled) return;
    var phone = p.value.trim();
    if (!phone) { status("Enter the phone number you text from.", true); p.focus(); return; }
    b.disabled = true; r.hidden = true; status("Signing you up…", false);
    fetch("imessage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: phone }) })
      .then(function (res) { return res.json().catch(function () { return {}; }); })
      .then(function (j) {
        var num = j && j.ok && typeof j.number === "string" && /^[+][0-9]{6,15}$/.test(j.number) ? j.number : "";
        if (!num) { status((j && typeof j.error === "string" && j.error) || "Couldn't sign you up. Use the form above.", true); return; }
        status("You're signed up.", false);
        n.textContent = pretty(num);
        l.setAttribute("href", "sms:" + num);
        l.textContent = "Text " + pretty(num);
        r.hidden = false; l.focus();
      })
      .catch(function () { status("No connection. Please try again.", true); })
      .finally(function () { b.disabled = false; });
  });
})();
</script>
`;

/** The report page; `imessage` adds the iMessage sign-up step below the chat. */
export function reportPage({ imessage = false }: { imessage?: boolean } = {}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#14181c">
<title>FireSight Report</title>
<style>
  :root { --bg:#14181c; --panel:#1d2329; --line:#2e363e; --text:#eef2f5; --muted:#9aa6b2; --fire:#ff6a3d; --me:#2b4a63; --them:#262d34; --ok:#5fd0a5; }
  * { box-sizing: border-box; }
  html, body { margin:0; height:100%; background:var(--bg); color:var(--text); font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  body { display:flex; flex-direction:column; max-width:640px; margin:0 auto; padding:0 16px env(safe-area-inset-bottom); }
  header { padding:20px 0 12px; border-bottom:1px solid var(--line); }
  h1 { margin:0; font-size:22px; display:flex; align-items:center; gap:10px; }
  h1 .dot { width:12px; height:12px; border-radius:50%; background:var(--fire); box-shadow:0 0 12px var(--fire); }
  header p { margin:6px 0 0; color:var(--muted); font-size:15px; }
  #log { flex:1; overflow-y:auto; padding:16px 0; display:flex; flex-direction:column; gap:10px; }
  .msg { max-width:85%; padding:10px 14px; border-radius:16px; white-space:pre-wrap; overflow-wrap:anywhere; }
  .me { align-self:flex-end; background:var(--me); border-bottom-right-radius:4px; }
  .them { align-self:flex-start; background:var(--them); border:1px solid var(--line); border-bottom-left-radius:4px; }
  .them.pending { color:var(--muted); font-style:italic; }
  .them.error { border-color:var(--fire); }
  .hint { color:var(--muted); font-size:14px; text-align:center; margin:auto 0; padding:24px 8px; }
  form { display:flex; gap:8px; padding:12px 0 16px; border-top:1px solid var(--line); background:var(--bg); position:sticky; bottom:0; }
  textarea { flex:1; resize:none; min-height:48px; max-height:140px; padding:12px; border-radius:12px; border:1px solid var(--line); background:var(--panel); color:var(--text); font:inherit; }
  textarea:focus-visible, button:focus-visible { outline:2px solid var(--fire); outline-offset:2px; }
  button { min-width:76px; border:0; border-radius:12px; background:var(--fire); color:#1a0d08; font:600 16px system-ui,sans-serif; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  footer { color:var(--muted); font-size:12px; text-align:center; padding-bottom:12px; }
  #im { border-top:1px solid var(--line); padding:4px 0 10px; }
  #im summary { min-height:44px; display:flex; align-items:center; color:var(--muted); font-size:15px; cursor:pointer; }
  #im[open] summary { color:var(--text); }
  #imf { display:block; position:static; padding:0; border:0; }
  #imf label { display:block; margin:0 0 6px; color:var(--muted); font-size:14px; }
  .imrow { display:flex; gap:8px; }
  #imp { flex:1; min-width:0; height:48px; padding:0 12px; border-radius:12px; border:1px solid var(--line); background:var(--panel); color:var(--text); font:inherit; font-size:16px; }
  #imb { min-width:104px; height:48px; background:var(--them); color:var(--text); border:1px solid var(--line); }
  .imnote { margin:8px 0 0; color:var(--muted); font-size:13px; }
  .imnote.error { color:var(--fire); }
  #imr p:first-child { margin:12px 0 8px; font-size:16px; }
  .sms { display:flex; align-items:center; justify-content:center; min-height:56px; padding:12px; border-radius:14px; background:var(--ok); color:#06261a; font:700 18px system-ui,sans-serif; text-decoration:none; overflow-wrap:anywhere; }
  #im summary:focus-visible, #imp:focus-visible, .sms:focus-visible { outline:2px solid var(--fire); outline-offset:2px; }
</style>
</head>
<body>
<header>
  <h1><span class="dot" aria-hidden="true"></span>FireSight</h1>
  <p>Report fire or smoke in the demo building. Say which floor you're on and where you see it.</p>
</header>
<main id="log" aria-live="polite">
  <p class="hint" id="hint">Example: "There's smoke coming from the break room on the 7th floor."</p>
</main>
<form id="f">
  <label for="t" style="position:absolute;left:-9999px">Your message</label>
  <textarea id="t" rows="2" maxlength="500" placeholder="What do you see, and where?" required></textarea>
  <button id="b" type="submit">Send</button>
</form>
${imessage ? IMESSAGE_SECTION : ""}<footer>Hackathon demo. In a real emergency, call 911.</footer>
<script>
(function () {
  var caller;
  try { caller = localStorage.getItem("fs-caller"); } catch (e) {}
  if (!caller) {
    caller = "web-" + Math.random().toString(36).slice(2, 8);
    try { localStorage.setItem("fs-caller", caller); } catch (e) {}
  }
  var log = document.getElementById("log"), f = document.getElementById("f"),
      t = document.getElementById("t"), b = document.getElementById("b");
  function add(text, cls) {
    var h = document.getElementById("hint"); if (h) h.remove();
    var d = document.createElement("div"); d.className = "msg " + cls; d.textContent = text;
    log.appendChild(d); d.scrollIntoView({ block: "end", behavior: "smooth" }); return d;
  }
  t.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); f.requestSubmit(); }
  });
  f.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = t.value.trim(); if (!text || b.disabled) return;
    add(text, "me"); t.value = ""; b.disabled = true;
    var pending = add("Locating your report…", "them pending");
    fetch("report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: text, caller: caller }) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, j: j }; }); })
      .then(function (x) {
        pending.classList.remove("pending");
        if (x.j && x.j.reply) pending.textContent = x.j.reply;
        else { pending.classList.add("error"); pending.textContent = (x.j && x.j.error) || "Something went wrong. Please try again."; }
      })
      .catch(function () { pending.classList.remove("pending"); pending.classList.add("error"); pending.textContent = "No connection. Please try again."; })
      .finally(function () { b.disabled = false; t.focus(); });
  });
})();
</script>
</body>
</html>
`;
}

/** The report page without the iMessage step. */
export const REPORT_PAGE = reportPage();

export function qrPage(url: string, svg: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FireSight QR</title>
<style>
  html, body { margin:0; background:#fff; color:#111; font:18px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  main { max-width:520px; margin:0 auto; padding:32px 16px; text-align:center; }
  h1 { margin:0 0 4px; font-size:30px; }
  p { margin:0 0 20px; color:#444; }
  .qr { width:min(80vw, 380px); margin:0 auto; }
  .qr svg { width:100%; height:auto; display:block; }
  code { display:block; margin-top:16px; font-size:15px; word-break:break-all; color:#333; }
</style>
</head>
<body>
<main>
  <h1>Report a fire</h1>
  <p>Scan to text the FireSight demo building from your phone.</p>
  <div class="qr" role="img" aria-label="QR code for ${esc(url)}">${svg}</div>
  <code>${esc(url)}</code>
</main>
</body>
</html>
`;
}
