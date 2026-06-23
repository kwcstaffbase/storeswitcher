// ============================================================================
// Store / Corporate View Switcher — production build
//
// Binds to the platform's existing "Switch View" control (header quicklink),
// switches the user between two Staffbase groups (which gate two content
// pages), and redirects to the matching page.
//
// Trigger: a delegated capture-phase click listener matches the native
// "Switch View" control by aria-label, link text, or a /toggle href, so it
// survives Staffbase's SPA re-rendering the header.
//
// IMPORTANT: group IDs and page paths are PER-INSTANCE — set them below.
// Access is gated by each group's accessors; ensure both groups list each
// other as accessors so members of either can switch both ways.
// ============================================================================

(function () {
  "use strict";

  // --- Configuration --------------------------------------------------------
  const CONFIG = {
    CORP_VIEW: "68a5066cf142ff0ede176299",
    STORE_VIEW: "684afb75ad355915e366ba44",
    CORPORATE_VIEW_PATH: "/content/page/6875bc7f51f81f3cdf86d510",
    STORE_VIEW_PATH: "/content/page/6875bcb47ddfa778d9563bf6",

    BASE_URL: window.location.origin,
    USER_ID_ENDPOINTS: ["/api/users/me"],

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

  // --- Locate the native "Switch View" control from a click target ----------
  function findSwitchControl(start) {
    if (!start || !start.closest) return null;

    // CSS-matchable signals: aria-label or a /toggle href.
    const bySelector = start.closest(
      '[aria-label*="switch view" i], a[href="/toggle"], a[href*="toggle"]',
    );
    if (bySelector) return bySelector;

    // Text-based fallback: climb a few ancestors looking for a clickable
    // element whose label reads "Switch View".
    let el = start;
    for (let i = 0; i < 6 && el; i++, el = el.parentElement) {
      const clickable =
        el.tagName === "A" ||
        el.tagName === "BUTTON" ||
        el.getAttribute?.("role") === "button";
      if (clickable && (el.textContent || "").trim().toLowerCase() === "switch view") {
        return el;
      }
    }
    return null;
  }

  // --- Delegated click handler ----------------------------------------------
  async function onToggleClick(event) {
    const control = findSwitchControl(event.target);
    if (!control) return;

    // Intercept before the platform's own navigation runs.
    event.preventDefault();
    event.stopPropagation();

    if (switching) return;
    switching = true;

    // Light, non-destructive loading state (don't touch innerHTML — preserves icons).
    const prevOpacity = control.style.opacity;
    const prevPE = control.style.pointerEvents;
    control.style.opacity = "0.6";
    control.style.pointerEvents = "none";

    try {
      await switchView(); // redirects on success
    } catch (err) {
      console.error("View switch failed:", err);
      switching = false;
      control.style.opacity = prevOpacity;
      control.style.pointerEvents = prevPE;
    }
  }

  // --- Init -----------------------------------------------------------------
  function init() {
    if (initialized) return;
    initialized = true;
    // Capture phase + delegation: catches the native control even after re-render.
    document.addEventListener("click", onToggleClick, true);
    console.log("Store switcher initialized (bound to native Switch View control).");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
