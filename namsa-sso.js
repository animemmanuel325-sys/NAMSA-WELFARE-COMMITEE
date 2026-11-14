/* =====================================================================
   namsa-sso.js : put this file in EVERY committee website (same folder as index.html).
   1) EDIT THE THREE VALUES BELOW (only here, once per committee).
   2) On every page, load supabase-js and this file, then call NamsaSSO.init():

        <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
        <script src="namsa-sso.js"></script>
        <script>
          NamsaSSO.init();
          const me = await NamsaSSO.requireStudent();     // { id, label, name }
          // after every save:  if (error && NamsaSSO.identityError(error)) return;
        </script>

   Use  NamsaSSO.client()  for all database calls.  NEVER add a box where students type an ID.
   If a form must show an ID box, call  NamsaSSO.assertSameId(typedValue).
   ===================================================================== */
const NAMSA_CONFIG = {
  supabaseUrl: "https://czuelcaucmzgaosgufyq.supabase.co",
  anonKey: "sb_publishable_wTtiQl8Sd1dIcBMuNnFZbw_EGPaSRja",
  mainOrigin: "https://namsapu359-ux.github.io",            // the main portal website (no path)
  homeUrl: "../index.html"                                       // the committee's home page, written from the auth folder
};

const NamsaSSO = (() => {
  let cfg, sb, current = null, watching = false;
  const MISMATCH = "You are using a different student ID from the one you signed in with. " +
    "Please use the same student ID throughout, because it is used to identify you. " +
    "You have been signed out of this committee. Sign in again from the NAMSA-PU portal.";
  const fail = (m) => { throw new Error(m); };
  const norm = (v) => String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

  function init(extra) {
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

  // Replaces the page with a clear message, and tells the portal so it can close this committee.
  function block(msg) {
    try { if (window.parent !== window) window.parent.postMessage({ type: "namsa-identity-mismatch", message: msg }, cfg.mainOrigin); } catch (e) {}
    document.body.innerHTML = "";
    const box = document.createElement("div");
    box.style.cssText = "font-family:system-ui,sans-serif;max-width:460px;margin:12vh auto;padding:26px;background:#fff;border-radius:14px;box-shadow:0 8px 24px rgba(0,0,0,.14);text-align:center;color:#0a1f2c";
    const h = document.createElement("h2"); h.textContent = "Identity check";
    const p = document.createElement("p"); p.textContent = msg; p.style.cssText = "line-height:1.5;margin:12px 0 18px";
    const a = document.createElement("a"); a.textContent = "Back to the NAMSA-PU portal"; a.href = cfg.mainUrl; a.target = "_top";
    a.style.cssText = "display:inline-block;background:#047857;color:#fff;padding:10px 20px;border-radius:999px;font-weight:700;text-decoration:none";
    box.append(h, p, a); document.body.append(box);
  }
  async function signOutAndBlock(msg) { try { await sb.auth.signOut(); } catch (e) {} current = null; block(msg); }

  // Ask the portal (the page that contains this committee) which student is signed in there.
  // Resolves to the ID, or null when this page is not inside the portal or the portal does not answer.
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
      if (e.data.type === "namsa-identity" && current && norm(e.data.id) !== norm(current.id)) signOutAndBlock(MISMATCH);
    });
    setInterval(async () => {                         // re-check every 30 seconds while the page stays open
      if (!current) return;
      const id = await askPortal();
      if (id === null) signOutAndBlock("You are no longer signed in at the NAMSA-PU portal. Please sign in again from the portal.");
      else if (norm(id) !== norm(current.id)) signOutAndBlock(MISMATCH);
    }, 30000);
  }

  // Used by auth/callback.html. The one-time code is removed from the address bar immediately.
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
      res = await fetch(cfg.exchangeUrl, {
        method: "POST", signal: ctl.signal,
        headers: { "Content-Type": "application/json", apikey: cfg.anonKey },
        body: JSON.stringify({ code }),
      });
    } catch (e) {
      fail("Could not reach this committee's sign-in function (" + cfg.exchangeUrl + "). Check that namsa-sso-exchange is deployed, and that the three values at the top of namsa-sso.js are filled in.");
    } finally { clearTimeout(timer); }
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.token_hash) fail(j.error || j.message || "Sign-in failed (" + res.status + "). Open this committee again from the portal.");

    step("Creating your session…");
    let { error } = await sb.auth.verifyOtp({ token_hash: j.token_hash, type: "magiclink" });
    if (error) ({ error } = await sb.auth.verifyOtp({ token_hash: j.token_hash, type: "email" }));
    if (error) fail("Sign-in failed. Open this committee again from the portal.");
    return j.student; // { id, label, name }
  }

  // Call on every protected page. Returns { id, label, name }, or signs the student out with a message.
  async function requireStudent() {
    const { data, error } = await sb.auth.getUser();     // asks the server, never trusts local storage
    const m = data && data.user && data.user.app_metadata;
    const ok = !error && m && m.student_id && (m.sso_valid_until || 0) * 1000 > Date.now();
    if (!ok) { const msg = "Please open this committee from the NAMSA-PU portal."; block(msg); fail(msg); }
    const me = { id: m.student_id, label: m.student_label || m.student_id, name: (data.user.user_metadata || {}).name || "" };

    const portalId = await askPortal();                   // must match the student signed in at the portal
    if (portalId === null) {
      if (cfg.requirePortal) { const msg = "Please open this committee from the NAMSA-PU portal."; await signOutAndBlock(msg); fail(msg); }
    } else if (norm(portalId) !== norm(me.id)) {
      await signOutAndBlock(MISMATCH); fail(MISMATCH);
    }
    current = me; startWatch();
    return me;
  }

  // After every database save:  if (error && NamsaSSO.identityError(error)) return;
  function identityError(error) {
    if (error && /ID_MISMATCH/.test(error.message || "")) { signOutAndBlock(MISMATCH); return true; }
    return false;
  }
  // For a form that still shows a student ID box: signs out if it is not the signed-in ID.
  function assertSameId(typed) {
    if (!current || norm(typed) !== norm(current.id)) { signOutAndBlock(MISMATCH); fail(MISMATCH); }
    return true;
  }

  const client = () => sb;                 // use this client for all database calls
  const signOut = () => sb.auth.signOut();
  const mainUrl = () => cfg.mainUrl;
  const homeUrl = () => new URL(cfg.homeUrl || "../index.html", location.href).href;   // where to go after sign-in
  return { init, handleCallback, requireStudent, identityError, assertSameId, client, signOut, mainUrl, homeUrl };
})();
