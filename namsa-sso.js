/* =====================================================================
   namsa-sso.js : add to EVERY committee website (static HTML / GitHub Pages).
   Needs supabase-js loaded first:
     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
     <script src="namsa-sso.js"></script>
   Then, once per page:
     NamsaSSO.init({
       supabaseUrl: "https://THIS-COMMITTEES-PROJECT.supabase.co",
       anonKey:     "THIS-COMMITTEES-PUBLISHABLE-KEY",        // public key only. Never the service key.
       mainOrigin:  "https://your-main-namsa-site.example",   // the main portal website
       mainUrl:     "https://your-main-namsa-site.example/"   // where to send people who are not signed in
     });
   - auth/callback.html calls  NamsaSSO.handleCallback()   (see the example file)
   - every other page calls    const me = await NamsaSSO.requireStudent();
   - after every database save: if (error && NamsaSSO.identityError(error)) return;
   - if a form still shows a student ID box:  NamsaSSO.assertSameId(typedValue);

   IDENTITY RULES (enforced twice):
   1. In the DATABASE (committee-setup.sql): a save carrying a different student ID is rejected (ID_MISMATCH).
   2. In THIS SCRIPT: if the portal is now signed in as a different student, or signed out, or this page is not
      open inside the portal, the student is signed out of the committee and told to use the same student ID.
   ===================================================================== */
const NamsaSSO = (() => {
  let cfg, sb, current = null, watching = false;
  const MISMATCH = "You are using a different student ID from the one you signed in with. " +
    "Please use the same student ID throughout, because it is used to identify you. " +
    "You have been signed out of this committee. Sign in again from the NAMSA-PU portal.";
  const fail = (m) => { throw new Error(m); };
  const norm = (v) => String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

  function init(c) {
    cfg = Object.assign({ exchangeUrl: c.supabaseUrl + "/functions/v1/namsa-sso-exchange", requirePortal: true }, c);
    sb = supabase.createClient(cfg.supabaseUrl, cfg.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
    return sb;
  }

  // Replaces the page with a clear message (and tells the portal so it can close this committee).
  function block(msg) {
    try { if (window.parent !== window) window.parent.postMessage({ type: "namsa-identity-mismatch", message: msg }, cfg.mainOrigin); } catch (e) {}
    document.body.innerHTML = "";
    const box = document.createElement("div");
    box.style.cssText = "font-family:system-ui,sans-serif;max-width:460px;margin:12vh auto;padding:26px;background:#fff;border-radius:14px;box-shadow:0 8px 24px rgba(0,0,0,.14);text-align:center;color:#0a1f2c";
    const h = document.createElement("h2"); h.textContent = "Identity check";
    const p = document.createElement("p"); p.textContent = msg; p.style.cssText = "line-height:1.5;margin:12px 0 18px";
    const a = document.createElement("a"); a.textContent = "Back to the NAMSA-PU portal"; a.href = cfg.mainUrl || "/"; a.target = "_top";
    a.style.cssText = "display:inline-block;background:#047857;color:#fff;padding:10px 20px;border-radius:999px;font-weight:700;text-decoration:none";
    box.append(h, p, a); document.body.append(box);
  }
  async function signOutAndBlock(msg) { try { await sb.auth.signOut(); } catch (e) {} current = null; block(msg); }

  // Ask the portal (the page that contains this committee) which student is signed in there.
  // Resolves to the ID, or null when the page is not inside the portal / the portal does not answer.
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
    setInterval(async () => {                       // re-check every 30 seconds while the page stays open
      if (!current) return;
      const id = await askPortal();
      if (id === null || norm(id) !== norm(current.id)) signOutAndBlock(id === null ? "You are no longer signed in at the NAMSA-PU portal. Please sign in again from the portal." : MISMATCH);
    }, 30000);
  }

  // The one-time code is removed from the address bar immediately.
  async function handleCallback() {
    const u = new URL(location.href);
    const code = u.searchParams.get("code");
    history.replaceState(null, "", u.pathname);
    const fromPortal =
      (document.referrer && new URL(document.referrer).origin === cfg.mainOrigin) ||
      (location.ancestorOrigins && [...location.ancestorOrigins].includes(cfg.mainOrigin));
    if (cfg.mainOrigin && !fromPortal) fail("Please open this committee from the NAMSA-PU portal.");
    if (!code) fail("Please open this committee from the NAMSA-PU portal.");

    const res = await fetch(cfg.exchangeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: cfg.anonKey },
      body: JSON.stringify({ code }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.token_hash) fail(j.error || "Sign-in failed. Open this committee again from the portal.");

    let { error } = await sb.auth.verifyOtp({ token_hash: j.token_hash, type: "magiclink" });
    if (error) ({ error } = await sb.auth.verifyOtp({ token_hash: j.token_hash, type: "email" }));
    if (error) fail("Sign-in failed. Open this committee again from the portal.");
    return j.student; // { id, label, name }
  }

  // Call on every protected page. Returns { id, label, name } or signs the student out with a message.
  async function requireStudent() {
    const { data, error } = await sb.auth.getUser();   // asks the server, does not trust local storage
    const m = data && data.user && data.user.app_metadata;
    const ok = !error && m && m.student_id && (m.sso_valid_until || 0) * 1000 > Date.now();
    if (!ok) {
      if (cfg.mainUrl) location.replace(cfg.mainUrl);
      fail("Please open this committee from the NAMSA-PU portal.");
    }
    const me = { id: m.student_id, label: m.student_label || m.student_id, name: (data.user.user_metadata || {}).name || "" };

    const portalId = await askPortal();                  // must match the student signed in at the portal
    if (portalId === null) {
      if (cfg.requirePortal) { const msg = "Please open this committee from the NAMSA-PU portal."; await signOutAndBlock(msg); fail(msg); }
    } else if (norm(portalId) !== norm(me.id)) {
      await signOutAndBlock(MISMATCH); fail(MISMATCH);
    }
    current = me; startWatch();
    return me;
  }

  // Use after every database save:  if (error && NamsaSSO.identityError(error)) return;
  function identityError(error) {
    if (error && /ID_MISMATCH/.test(error.message || "")) { signOutAndBlock(MISMATCH); return true; }
    return false;
  }
  // For any form that still shows a student ID box: stops and signs out if it is not the signed-in ID.
  function assertSameId(typed) {
    if (!current || norm(typed) !== norm(current.id)) { signOutAndBlock(MISMATCH); fail(MISMATCH); }
    return true;
  }

  const client = () => sb;               // use this client for all database calls
  const signOut = () => sb.auth.signOut();
  return { init, handleCallback, requireStudent, identityError, assertSameId, client, signOut };
})();
