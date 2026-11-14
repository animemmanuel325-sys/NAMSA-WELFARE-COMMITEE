/* =====================================================================
   namsa-sso.js : put this file in EVERY committee website (same folder as index.html).
   ONE-LINE INSTALL: add this line inside <head> of every committee page that shows or collects
   student information (change the path if the page is in a sub-folder, e.g. ../namsa-sso.js):

        <script src="namsa-sso.js"></script>

   That is all. The page then:
     1. stays hidden until the student is verified (they must have come from the NAMSA-PU portal),
     2. fills any "Student ID / Index number" box with the ID they signed in with,
     3. if the student types or submits a DIFFERENT student ID, signs them out of the committee,
        tells them to use the same ID, and sends them back to the portal.
   For the strongest protection, ALSO save data with  NamsaSSO.client()  into tables protected with
   namsa_protect_table(): then even someone bypassing this page is rejected by the database.
   To switch the automatic part off on a page, put  <script>window.NAMSA_MANUAL=true</script>  before this line.
   ===================================================================== */
const NAMSA_CONFIG = {
  supabaseUrl: "https://czuelcaucmzgaosgufyq.supabase.co",
  anonKey: "sb_publishable_wTtiQl8Sd1dIcBMuNnFZbw_EGPaSRja",
  mainOrigin: "https://namsapu359-ux.github.io",            // the main portal website (no path)
  homeUrl: "../index.html"                                       // the committee's home page, written from the auth folder
};

const NamsaSSO = (() => {
  let cfg = null, sb = null, current = null, watching = false;
  const MISMATCH = "You used a different student ID from the one you signed in with. " +
    "Please use the same student ID throughout, because it is used to identify you. " +
    "You have been signed out of this committee. Sign in again from the NAMSA-PU portal.";
  const fail = (m) => { throw new Error(m); };
  const norm = (v) => String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

  function init(extra) {
    if (sb && !extra) return sb;
    cfg = Object.assign({ requirePortal: true }, NAMSA_CONFIG, extra || {});
    try { cfg.mainOrigin = new URL(cfg.mainOrigin).origin; }            // tolerates a trailing slash or path
    catch (e) { throw new Error("mainOrigin in namsa-sso.js must be a full address such as https://your-site.github.io"); }
    cfg.mainUrl = cfg.mainUrl || cfg.mainOrigin + "/";
    cfg.exchangeUrl = cfg.exchangeUrl || cfg.supabaseUrl.replace(/\/$/, "") + "/functions/v1/namsa-sso-exchange";
    sb = supabase.createClient(cfg.supabaseUrl, cfg.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
    return sb;
  }

  // Replaces the page with a clear message and tells the portal, which closes this committee and shows it.
  function block(msg, mismatch) {
    const hide = document.getElementById("namsa-hide"); if (hide) hide.remove();
    try {
      if (window.parent !== window && cfg) {
        window.parent.postMessage({ type: mismatch ? "namsa-identity-mismatch" : "namsa-blocked", message: msg }, cfg.mainOrigin);
      }
    } catch (e) {}
    document.body.innerHTML = "";
    const box = document.createElement("div"); box.id = "namsa-block";
    box.style.cssText = "font-family:system-ui,sans-serif;max-width:460px;margin:12vh auto;padding:26px;background:#fff;border-radius:14px;box-shadow:0 8px 24px rgba(0,0,0,.14);text-align:center;color:#0a1f2c";
    const h = document.createElement("h2"); h.textContent = mismatch ? "Different student ID" : "Identity check";
    const p = document.createElement("p"); p.textContent = msg; p.style.cssText = "line-height:1.5;margin:12px 0 18px";
    const a = document.createElement("a"); a.textContent = "Back to the NAMSA-PU portal"; a.href = (cfg && cfg.mainUrl) || "/"; a.target = "_top";
    a.style.cssText = "display:inline-block;background:#047857;color:#fff;padding:10px 20px;border-radius:999px;font-weight:700;text-decoration:none";
    box.append(h, p, a); document.body.append(box);
  }
  async function signOutAndBlock(msg, mismatch) {
    try { if (sb) await sb.auth.signOut(); } catch (e) {}
    current = null; block(msg, mismatch);
  }

  // Ask the portal (the page that contains this committee) which student is signed in there.
  function askPortal() {
    return new Promise((resolve) => {
      if (window.parent === window) return resolve(null);
      const t = setTimeout(() => { removeEventListener("message", h); resolve(null); }, 2500);
      function h(e) {
        if (e.origin !== cfg.mainOrigin || e.source !== window.parent || !e.data || e.data.type !== "namsa-identity") return;
        clearTimeout(t); removeEventListener("message", h); resolve(e.data.id || null);
      }
      addEventListener("message", h);
      window.parent.postMessage({ type: "namsa-whoami" }, cfg.mainOrigin);
    });
  }

  function startWatch() {
    if (watching) return; watching = true;
    addEventListener("message", (e) => {
      if (e.origin !== cfg.mainOrigin || e.source !== window.parent || !e.data) return;
      if (e.data.type === "namsa-logout") signOutAndBlock("You signed out of the NAMSA-PU portal, so you have been signed out of this committee too.");
      if (e.data.type === "namsa-identity" && current && norm(e.data.id) !== norm(current.id)) signOutAndBlock(MISMATCH, true);
    });
    setInterval(async () => {                         // re-check every 30 seconds while the page stays open
      if (!current) return;
      const id = await askPortal();
      if (id === null) signOutAndBlock("You are no longer signed in at the NAMSA-PU portal. Please sign in again from the portal.");
      else if (norm(id) !== norm(current.id)) signOutAndBlock(MISMATCH, true);
    }, 30000);
  }

  // Used by auth/callback.html (older installs). The one-time code is removed from the address bar immediately.
  async function handleCallback(onStep) {
    const step = (m) => { try { if (onStep) onStep(m); } catch (e) {} };
    step("Checking the sign-in…");
    const u = new URL(location.href);
    const code = u.searchParams.get("code");
    history.replaceState(null, "", u.pathname);
    let fromPortal = false;
    try { fromPortal = !!document.referrer && new URL(document.referrer).origin === cfg.mainOrigin; } catch (e) {}
    if (!fromPortal && location.ancestorOrigins) fromPortal = [...location.ancestorOrigins].includes(cfg.mainOrigin);
    if (!fromPortal || !code) fail("Please open this committee from the NAMSA-PU portal.");
    step("Asking the committee server…");
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 15000);
    let res;
    try {
      res = await fetch(cfg.exchangeUrl, { method: "POST", signal: ctl.signal,
        headers: { "Content-Type": "application/json", apikey: cfg.anonKey }, body: JSON.stringify({ code }) });
    } catch (e) { fail("Could not reach this committee's sign-in function. Check that namsa-sso-exchange is deployed."); }
    finally { clearTimeout(timer); }
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.token_hash) fail(j.error || j.message || "Sign-in failed (" + res.status + "). Open this committee again from the portal.");
    step("Creating your session…");
    let { error } = await sb.auth.verifyOtp({ token_hash: j.token_hash, type: "magiclink" });
    if (error) ({ error } = await sb.auth.verifyOtp({ token_hash: j.token_hash, type: "email" }));
    if (error) fail("Sign-in failed. Open this committee again from the portal.");
    return j.student;
  }

  // Verifies the student. Blocks the page with a message if they are not signed in, did not come from the
  // portal, or are not the same student as the portal. Returns { id, label, name }.
  async function requireStudent() {
    init();
    const { data, error } = await sb.auth.getUser();     // asks the server, never trusts local storage
    const m = data && data.user && data.user.app_metadata;
    const ok = !error && m && m.student_id && (m.sso_valid_until || 0) * 1000 > Date.now();
    if (!ok) { const msg = "Please open this committee from the NAMSA-PU portal."; block(msg); fail(msg); }
    const me = { id: m.student_id, label: m.student_label || m.student_id, name: (data.user.user_metadata || {}).name || "" };

    const portalId = await askPortal();                   // must match the student signed in at the portal
    if (portalId === null) {
      if (cfg.requirePortal) { const msg = "Please open this committee from the NAMSA-PU portal."; await signOutAndBlock(msg); fail(msg); }
    } else if (norm(portalId) !== norm(me.id)) {
      await signOutAndBlock(MISMATCH, true); fail(MISMATCH);
    }
    current = me; startWatch();
    return me;
  }

  // ---------- student ID boxes on the committee's own forms ----------
  const ID_RE = /(index|student[\s_-]*id|matric|reg(istration)?[\s_-]*(no|number)|\bsid\b)/i;
  function labelOf(el) {
    let t = (el.getAttribute("aria-label") || "") + " " + (el.placeholder || "");
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) t += " " + l.textContent; }
    const p = el.closest && el.closest("label"); if (p) t += " " + p.textContent;
    return t;
  }
  function isIdField(el) {
    if (!el || !el.tagName || !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return false;
    const type = (el.type || "").toLowerCase();
    if (["hidden", "password", "submit", "button", "checkbox", "radio", "file", "email"].includes(type)) return false;
    return ID_RE.test(el.name || "") || ID_RE.test(el.id || "") || ID_RE.test(labelOf(el));
  }
  function prepare(el) {
    if (el.dataset.namsaGuard) return; el.dataset.namsaGuard = "1";
    if (!el.value && current) { el.value = current.label; el.dispatchEvent(new Event("input", { bubbles: true })); }
    const check = () => { const v = norm(el.value); if (v && current && v !== norm(current.id)) signOutAndBlock(MISMATCH, true); };
    el.addEventListener("change", check); el.addEventListener("blur", check);
  }
  function guardForms() {
    if (!current) return;
    const scan = (root) => {
      if (isIdField(root)) prepare(root);
      if (root.querySelectorAll) root.querySelectorAll("input,textarea,select").forEach((el) => { if (isIdField(el)) prepare(el); });
    };
    scan(document.body);
    new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => { if (n.nodeType === 1) scan(n); })))
      .observe(document.body, { childList: true, subtree: true });
    // a submit that carries a different ID is stopped and the student is sent back
    document.addEventListener("submit", (e) => {
      const bad = [...e.target.querySelectorAll("input,textarea,select")]
        .some((el) => isIdField(el) && norm(el.value) && norm(el.value) !== norm(current.id));
      if (bad) { e.preventDefault(); e.stopImmediatePropagation(); signOutAndBlock(MISMATCH, true); }
    }, true);
  }

  // After every database save:  if (error && NamsaSSO.identityError(error)) return;
  function identityError(error) {
    if (error && /ID_MISMATCH/.test(error.message || "")) { signOutAndBlock(MISMATCH, true); return true; }
    return false;
  }
  // For code that reads an ID some other way: signs out if it is not the signed-in ID.
  function assertSameId(typed) {
    if (!current || norm(typed) !== norm(current.id)) { signOutAndBlock(MISMATCH, true); fail(MISMATCH); }
    return true;
  }

  const client = () => sb;                 // use this client for all database calls
  const signOut = () => sb.auth.signOut();
  const mainUrl = () => cfg.mainUrl;
  const homeUrl = () => new URL(cfg.homeUrl || "../index.html", location.href).href;
  const showBlock = (m) => block(m || "Please open this committee from the NAMSA-PU portal.");
  return { init, handleCallback, requireStudent, guardForms, identityError, assertSameId, client, signOut, mainUrl, homeUrl, showBlock };
})();

// ---------- AUTOMATIC PROTECTION (runs when this file is added to a page) ----------
(function () {
  if (window.NAMSA_MANUAL) return;
  const hide = document.createElement("style");           // the page stays hidden until the student is verified
  hide.id = "namsa-hide"; hide.textContent = "html{visibility:hidden!important}";
  document.documentElement.appendChild(hide);
  const reveal = () => { const h = document.getElementById("namsa-hide"); if (h) h.remove(); };
  const watchdog = setTimeout(() => {
    if (document.getElementById("namsa-hide")) NamsaSSO.showBlock("We could not verify your identity. Please open this committee again from the NAMSA-PU portal.");
  }, 12000);
  const domReady = new Promise((r) => document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", r) : r());
  const loadLibrary = () => new Promise((res, rej) => {
    if (typeof supabase !== "undefined") return res();
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js";
    s.onload = res; s.onerror = () => rej(new Error("Could not load the sign-in library. Check your internet connection."));
    document.head.appendChild(s);
  });
  (async () => {
    try {
      await loadLibrary(); await domReady;
      NamsaSSO.init();
      const me = await NamsaSSO.requireStudent();
      NamsaSSO.guardForms();
      window.NAMSA_STUDENT = me;
      clearTimeout(watchdog); reveal();
      document.dispatchEvent(new CustomEvent("namsa-ready", { detail: me }));
    } catch (e) {
      clearTimeout(watchdog);
      if (!document.getElementById("namsa-block")) NamsaSSO.showBlock(e && e.message);
      reveal();
    }
  })();
})();
