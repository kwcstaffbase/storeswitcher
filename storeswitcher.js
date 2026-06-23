// ============================================================================
// Store / Corporate View Switcher — production build
//
// Switches a user between two Staffbase groups (which gate two content pages)
// and redirects to the matching page.
//
// IMPORTANT: the group IDs and page URLs below are PER-INSTANCE. The values
// here are placeholders — set them to match whichever instance this runs on
// (test vs. prod). BASE_URL is derived from the current origin automatically,
// so the same file works in any environment without editing the domain.
// ============================================================================

(function () {
  "use strict";

  // --- Configuration --------------------------------------------------------
  const CONFIG = {
    // Group IDs for the instance this script is deployed on. The defaults are
    // the production (thepantry) IDs — replace for the test instance.
    CORP_VIEW: "68a5066cf142ff0ede176299",
    STORE_VIEW: "684afb75ad355915e366ba44",

    // Use RELATIVE paths so redirects stay on the current instance.
    // Replace the page IDs with the ones for this instance.
    CORPORATE_VIEW_PATH: "/content/page/6875bc7f51f81f3cdf86d510",
    STORE_VIEW_PATH: "/content/page/6875bcb47ddfa778d9563bf6",

    // Same-origin as the page. Do NOT hardcode a domain — that breaks the
    // moment the script runs on a different instance (test vs. prod).
    BASE_URL: window.location.origin,

    // CONFIRM THIS. First candidate returning a usable id wins; DOM scrape last.
    USER_ID_ENDPOINTS: ["/api/users/me", "/api/me"],

    REQUEST_TIMEOUT_MS: 8000,
    REQUEST_RETRIES: 2,
    POLL_TIMEOUT_MS: 6000,
    POLL_INTERVAL_MS: 400,
  };

  const TOGGLE_SELECTORS = [
    'a[href="/toggle"]',
    'a[aria-label="Switch View"]',
    'a[href*="toggle"]',
    'section[class*="StyledDesktopQuicklinks"] a',
  ];

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

  // --- User ID resolution: API first, DOM scrape as fallback ----------------
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
    const fromDom = getUserIdFromElement(document.body);
    if (fromDom) return fromDom;
    return getUserIdFromElement(document.querySelector('[class*="user-"]'));
  }

  function getUserIdFromElement(element) {
    if (!element) return null;
    const userClass = Array.from(element.classList).find((c) => c.startsWith("user-"));
    return userClass ? userClass.split("user-")[1] : null;
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
    // Same-origin relative path; X-CSRF-Token is the only header we control
    // (Origin/Referer are forbidden headers — the browser sets them itself).
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

  // --- UI state -------------------------------------------------------------
  function lockUI(link) {
    link.dataset.switching = "true";
    link.dataset.originalText = link.textContent;
    link.style.pointerEvents = "none";
    link.style.opacity = "0.6";
    link.textContent = "Switching views...";
  }

  function restoreUI(link, message) {
    delete link.dataset.switching;
    link.style.pointerEvents = "auto";
    link.style.opacity = "1";
    link.textContent = message || link.dataset.originalText || link.textContent;
    if (message) {
      setTimeout(() => {
        link.textContent = link.dataset.originalText || link.textContent;
      }, 4000);
    }
  }

  // --- Delegated click handler ----------------------------------------------
  async function onToggleClick(event) {
    const link = event.target.closest(TOGGLE_SELECTORS.join(","));
    if (!link) return;

    event.preventDefault();
    if (switching) return;
    switching = true;
    lockUI(link);

    try {
      await switchView();
    } catch (err) {
      console.error("View switch failed:", err);
      switching = false;
      restoreUI(link, "Couldn't switch — try again");
    }
  }

  // --- Init -----------------------------------------------------------------
  function init() {
    if (initialized) return;
    initialized = true;
    document.addEventListener("click", onToggleClick, true);
    console.log("Store switcher initialized (delegated). Origin:", CONFIG.BASE_URL);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
