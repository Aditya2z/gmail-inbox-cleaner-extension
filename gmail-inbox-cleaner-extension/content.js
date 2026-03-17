// ─────────────────────────────────────────────────────────────
// content.js  –  Gmail Mark All As Read  (Manifest V3)
// Uses exact selectors confirmed from the live Gmail DOM.
// ─────────────────────────────────────────────────────────────

// Double-injection guard
if (window.__gmrLoaded) {
  console.log("[GmailMarkRead] Already loaded.");
} else {
  window.__gmrLoaded = true;
  window.__gmrStop   = false;   // flipped to true when user clicks Stop
  initMarkRead();
}

function initMarkRead() {
  "use strict";

  const DELAY = {
    STEP:  1000,   // between actions
    NAV:   2800,   // after clicking Older — wait for rows to change
    POLL:   300,   // poll interval
    MAX_POLLS: 20, // 20 × 300ms = 6 s max per wait
  };

  // ── Helpers ─────────────────────────────────────────────────

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function log(...a) { console.log("[GmailMarkRead]", ...a); }

  function post(type, text) {
    try { chrome.runtime.sendMessage({ source: "gmail-mark-read", type, text }); }
    catch { /* popup closed */ }
    log(`[${type}]`, text);
  }

  /** Returns true if the user has clicked Stop. */
  function stopped() {
    if (window.__gmrStop) { log("Stop flag detected."); return true; }
    return false;
  }

  function safeClick(el) {
    if (!el) return;
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent("mouseup",   { bubbles: true, cancelable: true }));
    el.click();
  }

  /** Poll fn() until truthy, up to MAX_POLLS times. */
  async function poll(fn) {
    for (let i = 0; i < DELAY.MAX_POLLS; i++) {
      const v = fn();
      if (v) return v;
      await sleep(DELAY.POLL);
    }
    return null;
  }

  // ── SELECT ALL ───────────────────────────────────────────────
  // The checkbox is:  <div class="T-Jo-auh" role="presentation">
  // The actual click target is the ::after pseudo-element on that div —
  // clicking the div itself is sufficient for the ::after to register.

  async function selectAll() {
    // Wait for the checkbox container to appear
    const cb = await poll(() => document.querySelector('div.T-Jo-auh[role="presentation"]'));

    if (!cb) {
      log("Select-All div not found.");
      return false;
    }

    log("Found Select-All div:", cb.className);
    safeClick(cb);
    await sleep(DELAY.STEP);

    // Verify that at least one row is now selected
    const anySelected = document.querySelector('tr.zA[aria-checked="true"], tr.zA.x7, tr.zA.PE');
    log("Any row selected after click:", !!anySelected);
    return true; // proceed regardless — Gmail may not update aria-checked immediately
  }

  // ── MARK AS READ ─────────────────────────────────────────────
  // Exact confirmed button from live DOM:
  //   <div data-tooltip="Mark as read" aria-label="Mark as read" act="1" ...>
  // NOTE: act="1" in the toolbar (not act="568" which is in the dropdown).

  async function markAsRead() {
    // Wait for the button to appear (it only shows after rows are selected)
    const btn = await poll(() => {
      // Match by data-tooltip (most reliable)
      const el = document.querySelector('[data-tooltip="Mark as read"]');
      if (el && el.offsetParent !== null) return el;

      // Fallback: aria-label
      const el2 = document.querySelector('[aria-label="Mark as read"]');
      if (el2 && el2.offsetParent !== null) return el2;

      // Fallback: act="1" inside the main toolbar (not in a dropdown)
      const candidates = [...document.querySelectorAll('div[role="button"][act="1"]')];
      return candidates.find(e => e.offsetParent !== null) || null;
    });

    if (!btn) {
      log("Mark-as-Read button not found or not visible.");
      return false;
    }

    log("Found Mark-as-Read button:", btn.getAttribute("data-tooltip") || btn.className);
    safeClick(btn);
    await sleep(DELAY.STEP);
    return true;
  }

  // ── PAGE NAVIGATION ──────────────────────────────────────────

  function rowSnapshot() {
    return [...document.querySelectorAll("tr.zA")]
      .map(r => r.id || r.querySelector("span")?.textContent?.slice(0, 30) || "")
      .join("|");
  }

  async function goOlder() {
    const OLDER = [
      'div[data-tooltip="Older"]',
      'div[aria-label="Older"]',
      'div.T-I[act="19"]',
      'div[act="19"]',
    ];

    let btn = null;
    for (const s of OLDER) {
      const el = document.querySelector(s);
      if (el) { btn = el; log("Older btn:", s); break; }
    }

    // Broad scan fallback
    if (!btn) {
      btn = [...document.querySelectorAll("div.T-I, button")].find(el => {
        const t = (el.getAttribute("data-tooltip") || el.getAttribute("aria-label") || "").toLowerCase();
        return t === "older";
      }) || null;
    }

    if (!btn) { log("Older button not found."); return false; }

    const disabled =
      btn.getAttribute("aria-disabled") === "true" ||
      btn.classList.contains("T-I-JO")            ||
      btn.hasAttribute("disabled");

    if (disabled) { log("Older button disabled."); return false; }

    const before = rowSnapshot();
    safeClick(btn);
    log("Clicked Older — waiting for rows to change…");

    const deadline = Date.now() + DELAY.NAV;
    while (Date.now() < deadline) {
      await sleep(DELAY.POLL);
      if (rowSnapshot() !== before) {
        log("Page changed ✓");
        await sleep(500);
        return true;
      }
    }

    log("Rows did not change after clicking Older.");
    return false;
  }

  // ── MAIN LOOP ────────────────────────────────────────────────

  async function run() {
    log("═══ Starting ═══");
    post("PROGRESS", "Starting…");
    await sleep(800);

    let page = 1;
    let totalMarked = 0;
    let missStreak = 0;       // consecutive pages where Mark-as-Read btn was absent
    const MAX_MISSES = 3;     // stop after 3 pages in a row with no button

    while (true) {

      // ── Stop check ─────────────────────────────────────────
      if (stopped()) {
        post("STOPPED", "Stopped by user.");
        return;
      }

      log(`\n── Page ${page} ──`);
      post("PROGRESS", `Page ${page}: selecting emails…`);

      // Wait for email rows to appear
      await poll(() => document.querySelector("tr.zA"));
      await sleep(400);

      // ── Step 1: Select All ──────────────────────────────────
      const selected = await selectAll();

      if (stopped()) { post("STOPPED", "Stopped by user."); return; }

      if (!selected) {
        post("ERROR", `Page ${page}: could not click Select-All. Check console.`);
        return;
      }

      // ── Step 2: Mark as Read ────────────────────────────────
      post("PROGRESS", `Page ${page}: looking for Mark as Read button…`);
      const marked = await markAsRead();

      if (stopped()) { post("STOPPED", "Stopped by user."); return; }

      if (!marked) {
        missStreak++;
        log(`Mark-as-Read button not found on page ${page}. Miss streak: ${missStreak}`);
        post("PROGRESS", `Page ${page}: button not found (${missStreak}/${MAX_MISSES} misses) — next page…`);

        if (missStreak >= MAX_MISSES) {
          log("Reached 3 consecutive misses — stopping.");
          post("DONE", `Finished. ${totalMarked} email(s) marked across ${page} page(s).`);
          return;
        }

        // Button not found — move to next page anyway
        const advanced = await goOlder();
        if (!advanced) {
          post("DONE", `Last page reached. ${totalMarked} email(s) marked.`);
          return;
        }
        page++;
        continue;
      }

      // Button was found and clicked — reset miss streak
      missStreak = 0;
      totalMarked += document.querySelectorAll("tr.zA").length; // approximate
      post("PROGRESS", `Page ${page} done — ~${totalMarked} marked so far.`);

      // ── Step 3: Move to next page ───────────────────────────
      if (stopped()) { post("STOPPED", "Stopped by user."); return; }

      post("PROGRESS", `Moving to page ${page + 1}…`);
      const advanced = await goOlder();

      if (!advanced) {
        post("DONE", `Last page reached. ~${totalMarked} email(s) marked across ${page} page(s).`);
        return;
      }

      page++;
    }
  }

  // ── Message listener ─────────────────────────────────────────

  let running = false;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.source !== "gmail-mark-read-popup") return;

    if (msg.type === "START") {
      if (running) { post("WARN", "Already running."); sendResponse({ ok: false }); return; }
      window.__gmrStop = false;
      running = true;
      sendResponse({ ok: true });
      run().finally(() => { running = false; });
    }

    if (msg.type === "STOP") {
      window.__gmrStop = true;
      sendResponse({ ok: true });
    }
  });

  log("Content script ready.");
}
