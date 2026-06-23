// ============================================================================
// Store / Corporate View Switcher — production build (self-injected button)
//
// Injects its own "Switch View" button, switches the user between two Staffbase
// groups (which gate two content pages), and redirects to the matching page.
//
// IMPORTANT: group IDs and page paths are PER-INSTANCE. The values below are
// production (thepantry) placeholders — replace them with the IDs for whichever
// instance this runs on. BASE_URL is derived from the current origin so the same
// file works in any environment without editing the domain.
// ============================================================================

(function () {
  "use strict";

  // --- Configuration --------------------------------------------------------
  const CONFIG = {
    CORP_VIEW: "68a5066cf142ff0ede176299",       // <- set per instance
    STORE_VIEW: "684afb75ad355915e366ba44",      // <- set per instance
    CORPORATE_VIEW_PATH: "/content/page/6875bc7f51f81f3cdf86d510", // <- set per instance
    STORE_VIEW_PATH: "/content/page/6875bcb47ddfa778d9563bf6",     // <- set per instance

    BASE_URL: window.location.origin,
    USER_ID_ENDPOINTS: ["/api/users/me"],

    BUTTON_ID: "custom-view-switcher-btn",
    BUTTON_LABEL: "Switch View",

    REQUEST_TIMEOUT_MS: 8000,
    REQUEST_RETRIES: 2,
    POLL_TIMEOUT_MS: 6000,
    POLL_INTERVAL_MS: 400,
  };

  let initialized = false;
  let switching = false;
  let cachedCsrf = null;

  // --- Low-level fetch with timeout + retry on transient failures -----------
  async function fetchWithRetry(url, options = {}, retries = CONFIG.REQUEST_RETRIES) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timer);
        if (response.status >= 500 && attempt < retries) {
          await delay(300 * (attempt + 1));
          continue;
        }
        return response;
      } catch (err) {
        clearTimeout(timer);
        if (attempt < retries) {
          await delay(300 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // --- CSRF -----------------------------------------------------------------
  async function getCSRFToken(forceRefresh = false) {
    if (cachedCsrf && !forceRefresh) return cachedCsrf;
    const response = await fetchWithRetry("/auth/discover/", {
      method: "GET",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
    });
    const data = await response.json();
    cachedCsrf = data.csrfToken;
    return cachedCsrf;
  }

  // --- User ID resolution ---------------------------------------------------
  async function resolveUserId() {
    for (const endpoint of CONFIG.USER_ID_ENDPOINTS) {
      try {
        const response = await fetchWithRetry(endpoint, { method: "GET" });
        if (!response.ok) continue;
        const data = await response.json();
        const id = data.id || data.userId || data._id || (data.user && data.user.id);
        if (id) return String(id);
      } catch (_) {
        // try next candidate
      }
    }
    return null;
  }

  // --- Group membership -----------------------------------------------------
  async function isInGroup(groupId, userId) {
    try {
      const response = await fetchWithRetry(
        `/api/groups/${groupId}/users/${userId}`,
        { method: "GET" },
      );
      return response.ok;
    } catch (err) {
      console.error("Membership check failed:", err);
      return false;
    }
  }

  async function writeMembership(method, groupId, userId) {
    const attempt = (token) =>
      fetchWithRetry(`/api/groups/${groupId}/users/${userId}`, {
        method,
        headers: { "X-CSRF-Token": token },
      });

    let token = await getCSRFToken();
    let response = await attempt(token);
    if (response.status === 403) {
      token = await getCSRFToken(true);
      response = await attempt(token);
    }
    return response.ok;
  }

  const addToGroup = (groupId, userId) => writeMembership("POST", groupId, userId);
  const removeFromGroup = (groupId, userId) => writeMembership("DELETE", groupId, userId);

  async function pollMembership(groupId, userId, expected) {
    const deadline = Date.now() + CONFIG.POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if ((await isInGroup(groupId, userId)) === expected) return true;
      await delay(CONFIG.POLL_INTERVAL_MS);
    }
    return false;
  }

  // --- Core switch ----------------------------------------------------------
  async function switchView() {
    const userId = await resolveUserId();
    if (!userId) throw new Error("Could not resolve user ID");

    const inCorp = await isInGroup(CONFIG.CORP_VIEW, userId);
    const inStore = await isInGroup(CONFIG.STORE_VIEW, userId);

    let source, target, targetPath;
    if (inCorp) {
      source = CONFIG.CORP_VIEW;
      target = CONFIG.STORE_VIEW;
      targetPath = CONFIG.STORE_VIEW_PATH;
    } else if (inStore) {
      source = CONFIG.STORE_VIEW;
      target = CONFIG.CORP_VIEW;
      targetPath = CONFIG.CORPORATE_VIEW_PATH;
    } else {
      source = null;
      target = CONFIG.CORP_VIEW;
      targetPath = CONFIG.CORPORATE_VIEW_PATH;
    }

    // Add to target FIRST so a failure leaves the user untouched, not orphaned.
    if (!(await addToGroup(target, userId))) {
      throw new Error("Failed to add user to target group");
    }
    if (!(await pollMembership(target, userId, true))) {
      throw new Error("Target membership did not propagate in time");
    }
    if (source && !(await removeFromGroup(source, userId))) {
      console.warn("Failed to remove from source group; user is in both groups.");
    }

    window.location.href = CONFIG.BASE_URL + targetPath;
  }

  // --- Injected button ------------------------------------------------------
  function createButton() {
    const btn = document.createElement("button");
    btn.id = CONFIG.BUTTON_ID;
    btn.type = "button";
    btn.textContent = CONFIG.BUTTON_LABEL;
    Object.assign(btn.style, {
      position: "fixed",
      bottom: "24px",
      right: "24px",
      zIndex: "2147483647",
      padding: "12px 20px",
      borderRadius: "24px",
      border: "none",
      background: "#0067b9",
      color: "#fff",
      font: "600 14px/1 system-ui, sans-serif",
      cursor: "pointer",
      boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
    });
    btn.addEventListener("click", onSwitchClick);
    return btn;
  }

  function setButtonState(btn, { disabled, text }) {
    btn.disabled = disabled;
    btn.style.opacity = disabled ? "0.6" : "1";
    btn.style.cursor = disabled ? "default" : "pointer";
    if (text !== undefined) btn.textContent = text;
  }

  async function onSwitchClick(event) {
    const btn = event.currentTarget;
    if (switching) return;
    switching = true;
    setButtonState(btn, { disabled: true, text: "Switching views..." });

    try {
      await switchView(); // redirects on success
    } catch (err) {
      console.error("View switch failed:", err);
      switching = false;
      setButtonState(btn, { disabled: false, text: "Couldn't switch — try again" });
      setTimeout(() => setButtonState(btn, { disabled: false, text: CONFIG.BUTTON_LABEL }), 4000);
    }
  }

  function ensureButton() {
    if (document.getElementById(CONFIG.BUTTON_ID)) return;
    document.body.appendChild(createButton());
  }

  // --- Init -----------------------------------------------------------------
  function init() {
    if (initialized) return;
    initialized = true;
    ensureButton();
    // Re-add the button if Staffbase's SPA navigation ever removes it.
    const observer = new MutationObserver(() => ensureButton());
    observer.observe(document.body, { childList: true });
    console.log("Store switcher initialized (injected button). Origin:", CONFIG.BASE_URL);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
