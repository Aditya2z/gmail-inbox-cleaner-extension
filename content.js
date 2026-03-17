// ─────────────────────────────────────────────────────────────
// content.js  –  Gmail Mark All As Read  (Manifest V3)
// ─────────────────────────────────────────────────────────────
// FIXES:
//  • Guard against double-injection (CONFIG already declared)
//  • Auto-detect unread rows — don't rely on a single class name
//  • Auto-detect Select-All checkbox by role + position
//  • Auto-detect "Mark as read" without needing the More menu
//  • Smarter page-change detection
// ─────────────────────────────────────────────────────────────

// ── Double-injection guard ────────────────────────────────────
// If content.js was already loaded, skip re-initialisation.
if (window.__gmailMarkReadLoaded) {
  console.log("[GmailMarkRead] Already loaded — skipping re-init.");
} else {
  window.__gmailMarkReadLoaded = true;
  initGmailMarkRead();
}

function initGmailMarkRead() {
  "use strict";

  // ── CONFIG ──────────────────────────────────────────────────
  const CFG = {
    STEP_DELAY:     1100,
    NAV_DEADLINE:   5000,  // ms to wait for page rows to change
    DOM_SETTLE:     1000,
    POLL_INTERVAL:   350,
    MAX_POLL:         12,  // × POLL_INTERVAL = ~4 s max wait
  };

  // ── UTILS ───────────────────────────────────────────────────

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function log(...a) { console.log("[GmailMarkRead]", ...a); }

  function sendStatus(type, text, pct = null) {
    try { chrome.runtime.sendMessage({ source: "gmail-mark-read", type, text, pct }); }
    catch { /* popup closed */ }
    log(`[${type}]`, text);
  }

  function safeClick(el) {
    if (!el) return;
    ["mousedown", "mouseup", "click"].forEach((ev) =>
      el.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }))
    );
  }

  async function poll(fn, maxTries = CFG.MAX_POLL, interval = CFG.POLL_INTERVAL) {
    for (let i = 0; i < maxTries; i++) {
      const result = fn();
      if (result) return result;
      await sleep(interval);
    }
    return null;
  }

  // ── UNREAD DETECTION ─────────────────────────────────────────
  // Gmail uses several patterns depending on version/experiment:
  //   tr.zA.zE          — classic
  //   tr.zA[class*="yO"] — some variants mark bold differently
  //   rows where the subject span has font-weight bold/700
  //   rows where aria-label contains "Unread"
  // We try all of them and union the results.

  function getUnreadRows() {
    const seen = new Set();
    const add = (els) => els.forEach((e) => seen.add(e));

    // Method 1 – class-based (classic)
    add(document.querySelectorAll("tr.zA.zE"));

    // Method 2 – font-weight on subject span (works across most Gmail versions)
    document.querySelectorAll("tr.zA").forEach((row) => {
      if (seen.has(row)) return;
      // Check if the subject/sender text is bold (unread indicator)
      const spans = row.querySelectorAll("span");
      for (const s of spans) {
        const fw = window.getComputedStyle(s).fontWeight;
        if (fw === "700" || fw === "bold") {
          seen.add(row);
          break;
        }
      }
    });

    // Method 3 – aria-label contains "Unread" on the row or a child
    document.querySelectorAll('tr.zA[aria-label*="Unread"], tr.zA td[aria-label*="Unread"]')
      .forEach((el) => {
        const row = el.closest("tr.zA") || el;
        seen.add(row);
      });

    return [...seen];
  }

  function hasUnreadEmails() {
    const n = getUnreadRows().length;
    log(`Unread rows detected: ${n}`);
    return n > 0;
  }

  // ── SELECT ALL CHECKBOX ──────────────────────────────────────
  // Gmail's select-all is a <div role="checkbox"> in the toolbar.
  // The exact class varies, so we find it by role + position.

  async function findSelectAllCheckbox() {
    return poll(() => {
      // Try known class first
      const byClass = document.querySelector('div.T-Jo-auh[role="checkbox"]');
      if (byClass) return byClass;

      // Fallback: any role=checkbox in the toolbar area (above the email list)
      const allCheckboxes = [...document.querySelectorAll('div[role="checkbox"]')];
      // The select-all checkbox is typically the first one in the toolbar
      // and lives inside a div with class "G-tF" or similar toolbar wrapper
      for (const cb of allCheckboxes) {
        const rect = cb.getBoundingClientRect();
        // It should be in the upper portion of the page (toolbar area)
        if (rect.top > 0 && rect.top < 300 && rect.width > 0) {
          return cb;
        }
      }
      return null;
    });
  }

  async function selectAllOnPage() {
    const checkbox = await findSelectAllCheckbox();
    if (!checkbox) {
      log("Select-All checkbox not found via any method.");
      return false;
    }
    log("Found Select-All checkbox:", checkbox.className);

    // Uncheck first if already checked
    if (checkbox.getAttribute("aria-checked") === "true") {
      safeClick(checkbox);
      await sleep(400);
    }

    safeClick(checkbox);
    await sleep(CFG.STEP_DELAY);

    const checked = checkbox.getAttribute("aria-checked");
    log(`Checkbox aria-checked after click: "${checked}"`);
    return checked === "true";
  }

  // ── MARK AS READ ─────────────────────────────────────────────
  // Priority order:
  //  1. Keyboard shortcut (most reliable — Shift+I marks selected as read)
  //  2. Direct toolbar button
  //  3. "More" menu item

  async function markSelectedAsRead() {
    // ── Method 1: Keyboard shortcut Shift+I ──────────────────
    // Gmail's keyboard shortcut for "Mark as read" is Shift+I
    // This works on selected conversations without needing any toolbar click.
    const focusedList = document.querySelector('[role="main"] tr.zA');
    if (focusedList) {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "I", shiftKey: true, bubbles: true, cancelable: true })
      );
      log("Sent Shift+I keyboard shortcut for Mark as Read.");
      await sleep(CFG.STEP_DELAY);

      // Check if it worked (unread count should drop)
      const before = getUnreadRows().length;
      await sleep(600);
      const after = getUnreadRows().length;
      if (after < before || after === 0) {
        log("Keyboard shortcut worked.");
        return true;
      }
      log("Keyboard shortcut did not seem to reduce unread count — trying toolbar.");
    }

    // ── Method 2: Direct toolbar button ──────────────────────
    const directSelectors = [
      'div[data-tooltip="Mark as read"]',
      'div[aria-label="Mark as read"]',
      'div[data-tooltip*="read"]',
      'div[act="568"]',
    ];
    for (const sel of directSelectors) {
      const btn = document.querySelector(sel);
      if (btn && btn.offsetParent !== null) {
        log(`Clicking direct button: ${sel}`);
        safeClick(btn);
        await sleep(CFG.STEP_DELAY);
        return true;
      }
    }

    // ── Method 3: "More" dropdown ─────────────────────────────
    const moreSelectors = [
      'div[data-tooltip="More"]',
      'div[aria-label="More"]',
      'div[act="3"]',
    ];
    let moreBtn = null;
    for (const sel of moreSelectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) { moreBtn = el; break; }
    }

    // Broader fallback: button whose tooltip/label is literally "More"
    if (!moreBtn) {
      moreBtn = [...document.querySelectorAll("div.T-I")].find((d) => {
        const t = (d.getAttribute("data-tooltip") || d.getAttribute("aria-label") || "").trim();
        return t === "More";
      }) || null;
    }

    if (!moreBtn) {
      log("Could not find 'More' button.");
      return false;
    }

    safeClick(moreBtn);
    log("Opened 'More' dropdown.");
    await sleep(CFG.STEP_DELAY);

    // Find "Mark as read" in the menu
    const item = [...document.querySelectorAll('[role="menuitem"], li[role="menuitem"]')]
      .find((el) => {
        const txt = el.textContent.trim().toLowerCase();
        const act = el.getAttribute("act") || "";
        return txt.includes("mark as read") || act === "568" || act === "551";
      });

    if (!item) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      log("'Mark as read' item not found in dropdown.");
      return false;
    }

    safeClick(item);
    log("Clicked 'Mark as read' from dropdown.");
    await sleep(CFG.STEP_DELAY);
    return true;
  }

  // ── PAGE NAVIGATION ──────────────────────────────────────────

  function getRowSnapshot() {
    return [...document.querySelectorAll("tr.zA")]
      .map((r) => r.getAttribute("id") || r.querySelector("span")?.textContent?.slice(0, 30) || "")
      .join("|");
  }

  async function goToNextPage() {
    const olderSelectors = [
      'div[data-tooltip="Older"]',
      'div[aria-label="Older"]',
      'button[aria-label="Older"]',
      'div.T-I[act="19"]',
      'div[act="19"]',
    ];

    let btn = null;
    for (const sel of olderSelectors) {
      const el = document.querySelector(sel);
      if (el) { btn = el; log(`Older button found: ${sel}`); break; }
    }

    if (!btn) {
      btn = [...document.querySelectorAll("div.T-I, button")].find((el) => {
        const t = (el.getAttribute("data-tooltip") || el.getAttribute("aria-label") || "").toLowerCase();
        return t === "older";
      }) || null;
      if (btn) log("Older button found via full DOM scan.");
    }

    if (!btn) { log("No Older button found."); return false; }

    const disabled =
      btn.getAttribute("aria-disabled") === "true" ||
      btn.hasAttribute("disabled") ||
      btn.classList.contains("T-I-JO");
    if (disabled) { log("Older button is disabled."); return false; }

    const before = getRowSnapshot();
    safeClick(btn);
    log("Clicked Older — waiting for row content to change…");

    const deadline = Date.now() + CFG.NAV_DEADLINE;
    while (Date.now() < deadline) {
      await sleep(CFG.POLL_INTERVAL);
      if (getRowSnapshot() !== before) {
        log("Row content changed — page navigated successfully.");
        await sleep(600);
        return true;
      }
    }

    log("Rows did not change after clicking Older.");
    return false;
  }

  // ── WAIT FOR MARK TO TAKE EFFECT ────────────────────────────

  async function waitForUnreadToDrop(prevCount) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await sleep(CFG.POLL_INTERVAL);
      const n = getUnreadRows().length;
      if (n < prevCount || n === 0) {
        log(`Unread dropped: ${prevCount} → ${n}`);
        return;
      }
    }
    log("Unread count did not drop within timeout — continuing.");
  }

  // ── MAIN LOOP ────────────────────────────────────────────────

  async function runMarkAllAsRead() {
    log("═══ Starting Mark All As Read ═══");
    sendStatus("PROGRESS", "Starting… scanning inbox.");
    await sleep(CFG.DOM_SETTLE);

    let page = 1;
    let totalMarked = 0;
    let emptyStreak = 0;

    while (true) {
      log(`\n── Page ${page} ──`);
      sendStatus("PROGRESS", `Page ${page}: scanning for unread emails…`);

      // Wait for rows to appear
      await poll(() => document.querySelector("tr.zA"), 10, 400);
      await sleep(400);

      const unread = getUnreadRows();

      // ── No unread on this page ────────────────────────────
      if (unread.length === 0) {
        emptyStreak++;
        log(`Page ${page} has no unread. Empty streak: ${emptyStreak}`);

        if (emptyStreak >= 2) {
          log("Two consecutive empty pages — inbox fully processed.");
          break;
        }

        sendStatus("PROGRESS", `Page ${page} is clean — moving to next…`);
        const ok = await goToNextPage();
        if (!ok) { log("Cannot advance — done."); break; }
        page++;
        continue;
      }

      emptyStreak = 0;
      const countBefore = unread.length;
      log(`${countBefore} unread on page ${page}.`);

      // ── Select all ────────────────────────────────────────
      sendStatus("PROGRESS", `Page ${page}: selecting all…`);
      const selected = await selectAllOnPage();
      if (!selected) {
        sendStatus("ERROR", `Page ${page}: could not select emails. Check console (F12).`);
        return;
      }

      // ── Mark as read ──────────────────────────────────────
      sendStatus("PROGRESS", `Page ${page}: marking as read…`);
      let marked = await markSelectedAsRead();

      if (!marked) {
        log("Retry: re-selecting then marking…");
        await sleep(CFG.STEP_DELAY);
        await selectAllOnPage();
        marked = await markSelectedAsRead();
        if (!marked) {
          sendStatus("ERROR", `Page ${page}: "Mark as read" not found. Check console (F12).`);
          return;
        }
      }

      await waitForUnreadToDrop(countBefore);
      totalMarked += countBefore;
      sendStatus("PROGRESS", `Page ${page} done — ~${totalMarked} marked total.`);

      // If Gmail still shows unread on this page, loop again
      await sleep(400);
      if (hasUnreadEmails()) {
        log("Still unread on this page — repeating.");
        continue;
      }

      // Move to next page
      sendStatus("PROGRESS", `Page ${page} clear — moving to next page…`);
      const advanced = await goToNextPage();
      if (!advanced) { log("No next page."); break; }
      page++;
    }

    await sleep(CFG.DOM_SETTLE);
    const remaining = getUnreadRows().length;

    if (remaining === 0) {
      sendStatus("DONE", `All done! Processed ${page} page(s) — inbox is clear.`);
    } else {
      sendStatus("WARN", `Done with ${page} page(s). ${remaining} unread remain — run again.`);
    }

    log("═══ Complete ═══");
  }

  // ── MESSAGE LISTENER ─────────────────────────────────────────

  let isRunning = false;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.source !== "gmail-mark-read-popup") return;

    if (msg.type === "START") {
      if (isRunning) {
        sendStatus("WARN", "Already running — please wait.");
        sendResponse({ ok: false });
        return;
      }
      isRunning = true;
      sendResponse({ ok: true });
      runMarkAllAsRead().finally(() => { isRunning = false; });
    }
  });

  log("Content script initialised.");

} // end initGmailMarkRead
