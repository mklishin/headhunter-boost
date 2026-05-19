// ==UserScript==
// @name         HeadHunter Boost
// @name:ru      HeadHunter Boost
// @namespace    https://github.com/mklishin/headhunter-boost
// @version      6.1
// @description  Автоматическая отправка откликов на hh.ru — шаблоны писем, пропуск сложных вакансий, человекоподобное поведение
// @description:ru  Автоматическая отправка откликов на hh.ru — шаблоны писем, пропуск сложных вакансий, человекоподобное поведение
// @description:en  Auto-apply to jobs on hh.ru — cover letter templates, smart skipping, human-like interaction
// @author       mklishin
// @license      MIT
// @homepageURL  https://github.com/mklishin/headhunter-boost
// @supportURL   https://github.com/mklishin/headhunter-boost/issues
// @downloadURL  https://raw.githubusercontent.com/mklishin/headhunter-boost/main/headhunter-boost.user.js
// @updateURL    https://raw.githubusercontent.com/mklishin/headhunter-boost/main/headhunter-boost.user.js
// @match        *://*.hh.ru/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-end
// @noframes
// ==/UserScript==

// ─── DESIGN NOTES ────────────────────────────────────────────────────────────
//
//  GM_openInTab is intentionally absent.
//    Background tabs also match *://*.hh.ru/* and run this script. Their
//    GM_setValue calls race with the main tab and corrupt isRunning → false,
//    breaking auto-resume. Complex jobs are logged and skipped instead.
//
//  Complexity detection: post-click URL poll only.
//    Pre-click heuristics (keywords, data-qa checks) caused false positives on
//    simple jobs and were removed. The only signal is: did location.href change?
//
//  SPA back-navigation:
//    hh.ru is a React SPA. Complex job navigation typically uses pushState.
//    history.back() returns to the search page with JS context intact — no
//    full reload needed. window.location.href is a hard fallback only.
//
//  Vacancy ID extraction:
//    data-vacancy-id does not exist on hh.ru cards (confirmed May 2025).
//    IDs come from [data-qa="serp-item__title"] href, and from the redirect
//    URL's vacancyId query param (always present, DOM-structure-independent).
//
// ─────────────────────────────────────────────────────────────────────────────

(() => {
    'use strict';

    const VERSION = "6.1";
    const BRAND   = "HeadHunter Boost";

    // =========================================================================
    // DEFAULT COVER TEMPLATES
    // =========================================================================
    // Shown in Settings. User can edit, add (up to 5), or delete.
    // Persisted under GM key "userTemplates". Cleared only by deleting in Settings.
    // {JOB_TITLE} is replaced with the vacancy title at send time.

    const DEFAULT_TEMPLATES = [
        `Коллеги, здравствуйте!\n\nЯ заинтересован в должности «{JOB_TITLE}» и готов обсудить детали, есть релевантный опыт.\n\nС уважением`,
        `Добрый день, коллеги!\n\nМой опыт соответствует требованиям вакансии «{JOB_TITLE}».\n\nС уважением`,
        `Здравствуйте, коллеги! Есть релевантный опыт!\n\nГотов присоединиться к вашей команде на позицию «{JOB_TITLE}».\n\nС уважением`
    ];

    // Load persisted user templates; fall back to defaults on missing or corrupt data.
    let coverTemplates = (() => {
        try {
            const raw = GM_getValue("userTemplates", "");
            if (raw) {
                const arr = JSON.parse(raw);
                if (Array.isArray(arr) && arr.length > 0) return arr;
            }
        } catch { /* malformed JSON — use defaults */ }
        return [...DEFAULT_TEMPLATES];
    })();

    // =========================================================================
    // CONFIG  (user preferences — never cleared by "Clear session")
    // =========================================================================
    // GM keys: resumeId · templateId · tmplRandom · delayMs · userTemplates ·
    //          randEnabled · randMin · randMax · panelPos

    const config = {
        RESUME_ID:    GM_getValue("resumeId",    ""),
        TEMPLATE_ID:  GM_getValue("templateId",  0),
        // When true, each application picks a random template from coverTemplates.
        // Requires ≥ 2 templates; UI disables the toggle when only 1 exists.
        TMPL_RANDOM:  GM_getValue("tmplRandom",  false),
        // Fixed delay between applications. UI enforces minimum 1500 ms.
        // When randomization is on, this value is updated dynamically by
        // maybeRotateDelay() and reflects the current randomized delay.
        DELAY_MS:     GM_getValue("delayMs",     3000),
        // Randomized delay — enabled by the user in Settings.
        // When on, delay is sampled from a Gaussian distribution in
        // [RAND_MIN, RAND_MAX] and rotated every 4–7 sent responses.
        // randEnabled is a config key (never cleared by "Clear session").
        RAND_ENABLED: GM_getValue("randEnabled", false),
        RAND_MIN:     GM_getValue("randMin",     1500),   // ms; UI enforces ≥ 100
        RAND_MAX:     GM_getValue("randMax",     5000),   // ms; must be > RAND_MIN
    };

    // Clamp saved templateId in case templates were deleted since last run.
    if (config.TEMPLATE_ID >= coverTemplates.length) config.TEMPLATE_ID = 0;

    // =========================================================================
    // SESSION STATE  (cleared by "Clear session")
    // =========================================================================
    // GM keys: isRunning · successCount · complexCount · originalSearchUrl ·
    //          processedIds · complexJobs
    //
    // All state that must survive window.location.href (which destroys the JS
    // context) lives in GM storage. In-memory vars below are working copies.

    let isRunning         = GM_getValue("isRunning",         false);
    let successCount      = GM_getValue("successCount",      0);   // cover letters submitted
    let complexCount      = GM_getValue("complexCount",      0);   // complex jobs skipped
    let originalSearchUrl = GM_getValue("originalSearchUrl", "");  // set once on START
    // processedIds: Set in memory (O(1) has()), JSON array in GM.
    // Union of: applied + complex-skipped + already-applied vacancies.
    let processedIds      = new Set(JSON.parse(GM_getValue("processedIds", "[]")));
    // complexJobs: [{id, title, url, time}, …] newest-first, capped at 200.
    // Shown in the popup when the user clicks the ⏩ Complex counter.
    let complexJobs = (() => {
        try { return JSON.parse(GM_getValue("complexJobs", "[]")); }
        catch { return []; }
    })();

    // Write all session keys in one block. GM_setValue is synchronous in
    // Tampermonkey so this is safe immediately before window.location.href.
    const persistState = () => {
        GM_setValue("isRunning",         isRunning);
        GM_setValue("successCount",      successCount);
        GM_setValue("complexCount",      complexCount);
        GM_setValue("originalSearchUrl", originalSearchUrl);
        GM_setValue("processedIds",      JSON.stringify([...processedIds]));
        // complexJobs is written separately by pushComplexJob() so we don't
        // serialise the full array on every routine persistState() call.
    };

    // Reset session state and in-memory log. Does NOT touch config or panel position.
    const clearSession = () => {
        isRunning         = false;
        successCount      = 0;
        complexCount      = 0;
        originalSearchUrl = "";
        processedIds      = new Set();
        complexJobs       = [];
        logLines          = [];        // cleared in-memory; no GM key for logs
        persistState();
        GM_setValue("complexJobs", "[]");
    };

    // =========================================================================
    // CONCURRENCY GUARD
    // =========================================================================
    // hh.ru is a React SPA. DOM mutations can re-trigger init() →
    // maybeAutoResume() → startProcessing() while a loop is already running.
    // This flag prevents a second concurrent loop from starting.
    let isProcessingActive = false;

    // =========================================================================
    // HELPERS
    // =========================================================================

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // =========================================================================
    // RANDOMIZED DELAY  (Box-Muller Gaussian)
    // =========================================================================
    // Samples a value in [min, max] using a Gaussian distribution centred at
    // the midpoint with σ ≈ (max-min)/6, then clamped to the range.
    // Gaussian makes the pattern less mechanical than uniform random: most
    // delays cluster near the midpoint, with occasional long/short outliers.
    //
    // Delay is re-rolled every 4–7 successful sends (randomised count so even
    // the rotation cadence is unpredictable). Each rotation is logged.

    let _responsesSinceRotation = 0;
    let _nextRotateAt           = _randInt(4, 7); // rotate after this many sends

    // Returns a random integer in [lo, hi] inclusive.
    function _randInt(lo, hi) { return lo + Math.floor(Math.random() * (hi - lo + 1)); }

    // Returns a random ms value in [lo, hi] for micro-timing jitter.
    // Uniform distribution is intentional here: sub-200ms pauses don't need
    // Gaussian clustering — any value in range is equally "human-like".
    const _jitterMs = (lo, hi) => _randInt(lo, hi);

    // =========================================================================
    // HUMAN-LIKE INTERACTION
    // =========================================================================
    // Replaces bare el.click() at the two interaction points (response button
    // and submit button). Randomly varies the input method so automated
    // sequences don't produce a uniform stream of programmatic click events.
    //
    // Probability distribution (chosen to look realistic, not 50/50):
    //
    //   55%  direct .click()
    //        Most common even for real users with a mouse.
    //
    //   35%  focus() → Enter keydown/keypress/keyup
    //        Common for keyboard users and form navigation.
    //        Full key-event triad avoids the "missing keypress" bot signal.
    //
    //   5%   previous-element Tab → focus target → Enter
    //        Simulates a user who is keyboard-navigating the page. Tab is fired
    //        on document.activeElement (whatever was last focused) so the browser
    //        sees a coherent Tab-out → Tab-in sequence, not a floating Enter.
    //
    //   5%   previous-element Shift+Tab → Tab forward → focus target → Enter
    //        Rarest. Models a user who overshot by one field and corrected.
    //
    // The helper is async because the Tab variant inserts a micro-jitter between
    // the Tab event and Enter to avoid identical event timestamps.
    //
    // IMPORTANT: The outcome (element activation) must be identical across all
    // paths — this function never changes *what* gets activated, only *how*.

    // Dispatches a synthetic key event triad on `el`.
    // All three phases (down/press/up) are required — omitting keypress is a
    // documented anti-bot detection heuristic used by some JS fingerprinters.
    const _key = (el, key, code, extra = {}) => {
        const opts = { key, code, bubbles: true, cancelable: true, ...extra };
        el.dispatchEvent(new KeyboardEvent("keydown",  opts));
        el.dispatchEvent(new KeyboardEvent("keypress", opts));
        el.dispatchEvent(new KeyboardEvent("keyup",    opts));
    };

    const humanInteract = async (el) => {
        const roll = Math.random();

        if (roll < 0.55) {
            // ── 55 % — direct click ──────────────────────────────────────────
            el.click();

        } else if (roll < 0.90) {
            // ── 35 % — focus + Enter ─────────────────────────────────────────
            // Real keyboard users focus a button first, then press Enter.
            el.focus();
            await sleep(_jitterMs(25, 75));
            _key(el, "Enter", "Enter");

        } else if (roll < 0.95) {
            // ── 5 % — Tab from prior focus → Enter ───────────────────────────
            // Fire Tab on whatever was last focused so the browser event log
            // shows a proper focus-transfer, not just an isolated Enter.
            const prev = document.activeElement;
            if (prev && prev !== document.body) {
                _key(prev, "Tab", "Tab");
            }
            await sleep(_jitterMs(35, 85));
            el.focus();
            await sleep(_jitterMs(20, 60));
            _key(el, "Enter", "Enter");

        } else {
            // ── 5 % — Shift+Tab backward then Tab forward → Enter ────────────
            // Mimics a user who overshot the target by one element and corrected.
            const prev = document.activeElement;
            if (prev && prev !== document.body) {
                _key(prev, "Tab", "Tab", { shiftKey: true }); // go back
                await sleep(_jitterMs(40, 90));
                _key(prev, "Tab", "Tab");                     // then forward
            }
            await sleep(_jitterMs(30, 70));
            el.focus();
            await sleep(_jitterMs(20, 55));
            _key(el, "Enter", "Enter");
        }
    };

    // Gaussian sample clamped to [0, 1] (Box-Muller transform).
    const _gaussianUnit = () => {
        let u, v;
        do { u = Math.random(); } while (u === 0);
        do { v = Math.random(); } while (v === 0);
        const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
        return Math.min(1, Math.max(0, 0.5 + z / 6)); // map N(0,1) → clamp to [0,1]
    };

    // Sample a delay from the Gaussian distribution in [RAND_MIN, RAND_MAX].
    const sampleDelay = () => {
        const t = _gaussianUnit();
        return Math.round(config.RAND_MIN + t * (config.RAND_MAX - config.RAND_MIN));
    };

    // Called after each successful send. If randomization is enabled and we've
    // hit the rotation threshold, pick a new delay and log the change.
    const maybeRotateDelay = () => {
        if (!config.RAND_ENABLED) return;
        _responsesSinceRotation++;
        if (_responsesSinceRotation < _nextRotateAt) return;

        _responsesSinceRotation = 0;
        _nextRotateAt = _randInt(4, 7);
        const newDelay = sampleDelay();
        log(`🎲 Delay rotated → ${newDelay} ms  (next rotation in ${_nextRotateAt} sends)`);
        config.DELAY_MS = newDelay;
        GM_setValue("delayMs", newDelay); // persist so resumed sessions keep it
    };

    // =========================================================================
    // DAILY LIMIT DETECTION
    // =========================================================================
    // hh.ru displays this exact text when the 200-reply daily cap is hit.
    // We scan document.body.innerText after each submit; on match we stop the
    // loop, beep, and show an alert popup.

    const DAILY_LIMIT_TEXT =
        "В течение 24 часов можно совершить не более 200 откликов";

    const isDailyLimitHit = () => document.body.innerText.includes(DAILY_LIMIT_TEXT);

    // Three-tone descending beep using the Web Audio API.
    // Plays entirely in-browser; no server round-trip. Wrapped in try/catch
    // because AudioContext requires user gesture in some browser policies.
    const playAlertTone = () => {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            [[0, 880], [0.45, 660], [0.9, 440]].forEach(([t, freq]) => {
                const osc  = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.type = "sine";
                osc.frequency.value = freq;
                gain.gain.setValueAtTime(0.35, ctx.currentTime + t);
                gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.38);
                osc.start(ctx.currentTime + t);
                osc.stop(ctx.currentTime + t + 0.4);
            });
        } catch { /* AudioContext blocked — silent fallback */ }
    };

    // Stop the loop and show the daily limit popup.
    const handleDailyLimit = () => {
        isRunning = false;
        persistState();
        stopTabIndicator();
        isProcessingActive = false;

        if (elCache.toggleBtn) {
            elCache.toggleBtn.textContent      = "▶️ START SENDING";
            elCache.toggleBtn.style.background = "#ee7f2d";
        }

        log("🚫 DAILY LIMIT REACHED — script stopped");
        log(`   Total sent this session: ${successCount}`);

        playAlertTone();

        // Modal popup with the exact hh.ru message + advice
        const overlay = document.createElement("div");
        overlay.style.cssText =
            "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:2147483648;" +
            "display:flex;align-items:center;justify-content:center;";

        const box = document.createElement("div");
        box.style.cssText =
            "background:white;border-radius:12px;padding:28px 32px;max-width:420px;" +
            "font-family:system-ui;box-shadow:0 12px 40px rgba(0,0,0,.35);text-align:center;";
        box.innerHTML = `
            <div style="font-size:36px;margin-bottom:12px;">⛔</div>
            <h2 style="margin:0 0 14px;font-size:17px;color:#333;">Лимит откликов исчерпан</h2>
            <p style="margin:0 0 20px;font-size:14px;color:#555;line-height:1.6;">
                В течение 24 часов можно совершить не более 200 откликов.<br>
                Вы исчерпали лимит откликов, попробуйте отправить отклик позднее.
            </p>
            <p style="margin:0 0 20px;font-size:13px;color:#888;">
                Скрипт остановлен. Отправлено за сессию: <b>${successCount}</b>
            </p>
            <button id="as-limit-ok"
                style="padding:11px 32px;background:#ee7f2d;color:white;border:none;
                border-radius:8px;cursor:pointer;font-size:15px;font-weight:bold;">
                Понятно
            </button>`;

        overlay.appendChild(box);
        document.body.appendChild(overlay);

        box.querySelector("#as-limit-ok").onclick = () => overlay.remove();
        overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
    };

    // =========================================================================
    // LOGGING
    // =========================================================================
    // Each entry: { unix: number, time: string, msg: string }
    // logLines is newest-first (unshift) so the panel renders newest at top.
    //
    // Live panel  : [HH:MM:SS] message only — concise for glancing.
    // Copied text : [HH:MM:SS] [unix:N] message — full for debugging/grepping.
    //
    // renderLog() is RAF-debounced: a burst of log() calls (4-6 per vacancy)
    // collapses into a single DOM innerHTML rebuild per animation frame.
    // renderLog() is also skipped entirely when the log panel is hidden.

    const MAX_LOG_LINES = 120;
    let logLines        = [];
    let renderPending   = false;

    const log = (msg) => {
        const now  = Date.now();
        const time = new Date(now).toLocaleTimeString();
        console.log(`[${BRAND} ${time}] ${msg}`);
        logLines.unshift({ unix: now, time, msg });
        if (logLines.length > MAX_LOG_LINES) logLines.pop();
        scheduleRender();
    };

    const scheduleRender = () => {
        if (renderPending) return;
        renderPending = true;
        requestAnimationFrame(() => { renderPending = false; renderLog(); });
    };

    const renderLog = () => {
        const el = elCache.log;
        // Skip rebuild when panel not created yet or log is collapsed.
        if (!el || el.style.display === "none") return;
        el.innerHTML = logLines
            .map(l => `<span style="color:#5b9bd5">[${l.time}]</span> ${escHtml(l.msg)}`)
            .join("<br>");
        el.scrollTop = 0; // keep newest entry at top
    };

    const escHtml = s =>
        s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    // Copy uses the full format (time + unix + msg) for easy grep / diff.
    // navigator.clipboard is always available in Tampermonkey context;
    // document.execCommand("copy") is deprecated and intentionally removed.
    const copyLog = () => {
        const text = logLines.map(l => `[${l.time}] [unix:${l.unix}] ${l.msg}`).join("\n");
        navigator.clipboard.writeText(text)
            .then(() => log("📋 Log copied to clipboard"))
            .catch(err => log(`⚠️ Copy failed: ${err.message}`));
    };

    // Single structured log entry for each sent application.
    // Logged as one msg so it occupies one line in the panel rather than 6.
    // The copy output will contain the full detail on a single line.
    const logApplication = (vacancyId, title, coverLetter) => {
        const preview = coverLetter.replace(/\n/g, " ").slice(0, 80);
        log(`📨 SENT  id:${vacancyId ?? "?"}  "${title}"  cover:"${preview}…"`);
    };

    // =========================================================================
    // CACHED DOM REFS
    // =========================================================================
    // Populated once in createPanel(). Avoids repeated getElementById in
    // hot paths (updateCounters, renderLog, toggleSending, maybeAutoResume).

    const elCache = {
        log:       null,
        toggleBtn: null,
        sentEl:    null,
        complexEl: null,
        totalEl:   null,
    };

    // Update all three counter spans in one call.
    const updateCounters = () => {
        if (elCache.sentEl)    elCache.sentEl.textContent    = successCount;
        if (elCache.complexEl) elCache.complexEl.textContent = complexCount;
        // "Seen" = total unique IDs processed (applied + complex + already-applied).
        if (elCache.totalEl)   elCache.totalEl.textContent   = processedIds.size;
    };

    // =========================================================================
    // TAB ACTIVITY INDICATOR
    // =========================================================================
    // Title flash + favicon orange dot so the user can identify the active tab.
    // Both pulse at 1.2 s for a unified rhythm. Stopped cleanly on pause/error.

    let titleTimer = null, faviconTimer = null;
    let origTitle  = document.title, origFaviconHref = null;

    const startTabIndicator = async () => {
        if (!titleTimer) {
            origTitle = document.title;
            let flip = true;
            titleTimer = setInterval(() => {
                document.title = flip ? `🔵 Running | ${origTitle}` : origTitle;
                flip = !flip;
            }, 1200);
        }
        if (faviconTimer) return; // already running

        let faviconEl = document.querySelector('link[rel~="icon"]');
        if (!faviconEl) {
            faviconEl = Object.assign(document.createElement("link"), { rel: "icon" });
            document.head.appendChild(faviconEl);
        }
        origFaviconHref = faviconEl.href || "";

        // Draw the original favicon + a small orange dot in the top-right corner.
        // Falls back to a grey base if the image can't be loaded (CORS).
        const dotHref = await new Promise(resolve => {
            const cv  = Object.assign(document.createElement("canvas"), { width: 32, height: 32 });
            const ctx = cv.getContext("2d");
            const dot = () => {
                ctx.fillStyle = "#ee7f2d"; ctx.strokeStyle = "#fff"; ctx.lineWidth = 2.5;
                ctx.beginPath(); ctx.arc(25, 7, 7, 0, Math.PI * 2);
                ctx.fill(); ctx.stroke();
                resolve(cv.toDataURL());
            };
            if (origFaviconHref && !origFaviconHref.startsWith("data:")) {
                const img = Object.assign(new Image(), { crossOrigin: "anonymous" });
                img.onload  = () => { ctx.drawImage(img, 0, 0, 32, 32); dot(); };
                img.onerror = () => { ctx.fillStyle = "#777"; ctx.fillRect(0, 0, 32, 32); dot(); };
                img.src = origFaviconHref;
            } else {
                ctx.fillStyle = "#777"; ctx.fillRect(0, 0, 32, 32); dot();
            }
        });

        let flip = true;
        faviconTimer = setInterval(() => {
            faviconEl.href = flip ? dotHref : origFaviconHref;
            flip = !flip;
        }, 1200);
    };

    const stopTabIndicator = () => {
        if (titleTimer) {
            clearInterval(titleTimer); titleTimer = null;
            document.title = origTitle;
        }
        if (faviconTimer) {
            clearInterval(faviconTimer); faviconTimer = null;
            const el = document.querySelector('link[rel~="icon"]');
            if (el && origFaviconHref !== null) el.href = origFaviconHref;
        }
    };

    // =========================================================================
    // VACANCY DATA EXTRACTION
    // =========================================================================
    // Selectors confirmed from live hh.ru HTML (May 2025):
    //   Card root : [data-qa="vacancy-serp__vacancy"]
    //   Title link: [data-qa="serp-item__title"]      href="/vacancy/<ID>?…"
    //   Title text: [data-qa="serp-item__title-text"] (span inside title link)
    //   NOTE: data-vacancy-id attribute does NOT exist on hh.ru search cards.

    // Returns the numeric vacancy ID string, or null if all strategies fail.
    // null means we cannot deduplicate this button — the redirect-URL fallback
    // (getVacancyIdFromUrl) is the safety net for the endless-loop prevention.
    const getVacancyIdFromBtn = (btn) => {
        // Strategy 1 (primary): confirmed card root + title anchor
        const card = btn.closest('[data-qa="vacancy-serp__vacancy"]');
        if (card) {
            const m  = card.querySelector('[data-qa="serp-item__title"]')
                          ?.href?.match(/\/vacancy\/(\d+)/);
            if (m) return m[1];
            // Broader fallback within the same confirmed card root
            const m2 = card.querySelector('a[href*="/vacancy/"]')
                           ?.href?.match(/\/vacancy\/(\d+)/);
            if (m2) return m2[1];
        }
        // Strategy 2: common structural wrappers (hh.ru A/B variants)
        for (const wrap of [btn.closest("article"), btn.closest("li")]) {
            const m = wrap?.querySelector('a[href*="/vacancy/"]')
                         ?.href?.match(/\/vacancy\/(\d+)/);
            if (m) return m[1];
        }
        // Strategy 3: button itself is an anchor
        const m3 = (btn.getAttribute("href") || btn.getAttribute("data-url") || "")
                   .match(/\/vacancy\/(\d+)/);
        return m3 ? m3[1] : null;
    };

    // MUST be called BEFORE btn.click().
    // After the modal opens, document.querySelector("h1") on the search page
    // returns the results count "Найдено N вакансий", not the vacancy title.
    const getJobTitleFromCard = (btn) => {
        const card = btn.closest('[data-qa="vacancy-serp__vacancy"]');
        if (!card) return null;
        return (
            card.querySelector('[data-qa="serp-item__title-text"]')?.innerText?.trim() ||
            card.querySelector('[data-qa="serp-item__title"]')?.innerText?.trim() ||
            null
        );
    };

    // Extracts vacancyId from the complex-job redirect URL query string.
    // URL format: https://hh.ru/applicant/vacancy_response?vacancyId=133135055&…
    // Always present in complex-job URLs; does not depend on DOM structure.
    const getVacancyIdFromUrl = (url) => {
        try { return new URL(url).searchParams.get("vacancyId"); }
        catch { return null; }
    };

    // Add IDs to processedIds. Null values are silently ignored.
    // Does NOT call persistState — callers batch-persist to reduce GM writes.
    const markProcessed = (...ids) => {
        let changed = false;
        for (const id of ids) {
            if (id && !processedIds.has(id)) { processedIds.add(id); changed = true; }
        }
        if (changed) updateCounters();
    };

    // =========================================================================
    // COMPLEX JOBS LIST
    // =========================================================================
    // Each entry: { id, title, url, time }
    // Stored in GM under "complexJobs"; shown in popup on ⏩ counter click.
    // Capped at 200 entries (oldest dropped). Deduplicated by ID.

    const pushComplexJob = (job) => {
        if (job.id && complexJobs.some(j => j.id === job.id)) return; // deduplicate
        complexJobs.unshift(job);
        if (complexJobs.length > 200) complexJobs.pop();
        GM_setValue("complexJobs", JSON.stringify(complexJobs));
    };

    const showComplexPopup = () => {
        const overlay = document.createElement("div");
        overlay.style.cssText =
            "position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:2147483648;" +
            "display:flex;align-items:center;justify-content:center;";

        const modal = document.createElement("div");
        modal.style.cssText =
            "background:white;border-radius:10px;width:520px;max-height:70vh;" +
            "font-family:system-ui;box-shadow:0 12px 40px rgba(0,0,0,.3);" +
            "display:flex;flex-direction:column;overflow:hidden;";

        // ── Header ──────────────────────────────────────────────────────────
        const headerEl = document.createElement("div");
        headerEl.style.cssText =
            "display:flex;justify-content:space-between;align-items:center;" +
            "padding:16px 20px;border-bottom:1px solid #eee;flex-shrink:0;";

        const titleSpan = document.createElement("span");
        titleSpan.style.cssText = "font-weight:bold;font-size:15px;";
        titleSpan.textContent   = `⏩ Skipped Jobs (${complexJobs.length})`;

        const btnGroup = document.createElement("div");
        btnGroup.style.cssText = "display:flex;gap:8px;";

        const mkBtn = (label, extra) => {
            const b = document.createElement("button");
            b.innerHTML  = label;
            b.style.cssText =
                "padding:5px 10px;border-radius:5px;cursor:pointer;font-size:12px;" +
                "border:1px solid #ccc;background:#f0f0f0;" + (extra || "");
            return b;
        };
        const copyBtn  = mkBtn("📋 Copy links");
        const clearBtn = mkBtn("🗑 Clear", "background:#fff0f0;color:#d9534f;border-color:#f5c6c6;");
        const closeBtn = mkBtn("✕ Close");
        btnGroup.append(copyBtn, clearBtn, closeBtn);
        headerEl.append(titleSpan, btnGroup);

        // ── Scrollable list body ─────────────────────────────────────────────
        const bodyEl = document.createElement("div");
        bodyEl.style.cssText = "overflow-y:auto;padding:12px 20px;flex:1;";

        const renderList = () => {
            bodyEl.innerHTML = "";
            if (complexJobs.length === 0) {
                bodyEl.innerHTML =
                    `<p style="color:#888;text-align:center;margin:30px 0;">
                        No skipped jobs recorded yet.
                    </p>`;
                return;
            }
            complexJobs.forEach((job, i) => {
                const row = document.createElement("div");
                row.style.cssText =
                    "display:flex;align-items:baseline;gap:8px;padding:7px 0;" +
                    (i < complexJobs.length - 1 ? "border-bottom:1px solid #f3f3f3;" : "");

                const num = Object.assign(document.createElement("span"), {
                    textContent: `${i + 1}.`
                });
                num.style.cssText = "color:#aaa;font-size:11px;flex-shrink:0;min-width:22px;";

                const link = Object.assign(document.createElement("a"), {
                    href:        job.url || "#",
                    target:      "_blank",
                    textContent: job.title || job.id || "Unknown",
                    title:       job.url || ""
                });
                link.style.cssText = "color:#ee7f2d;font-size:13px;text-decoration:none;flex:1;";

                const timeEl = Object.assign(document.createElement("span"), {
                    textContent: job.time ? new Date(job.time).toLocaleTimeString() : ""
                });
                timeEl.style.cssText = "color:#aaa;font-size:11px;flex-shrink:0;";

                row.append(num, link, timeEl);
                bodyEl.appendChild(row);
            });
        };
        renderList();

        modal.append(headerEl, bodyEl);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        const close = () => overlay.remove();
        closeBtn.onclick = close;
        overlay.addEventListener("click", e => { if (e.target === overlay) close(); });

        copyBtn.onclick = () => {
            const text = complexJobs.map(j => `${j.title || j.id}\t${j.url || ""}`).join("\n");
            navigator.clipboard.writeText(text)
                .then(() => log("📋 Complex job links copied"))
                .catch(err => log(`⚠️ Copy failed: ${err.message}`));
        };

        clearBtn.onclick = () => {
            complexJobs   = [];
            complexCount  = 0;
            GM_setValue("complexJobs", "[]");
            persistState();
            updateCounters();
            renderList();
            titleSpan.textContent = "⏩ Skipped Jobs (0)";
            log("🗑 Skipped jobs list cleared");
        };
    };

    // =========================================================================
    // NAVIGATION DETECTION
    // =========================================================================
    // Polls location.href every 80 ms (reduced from 150 ms) for up to waitMs.
    // Returns true if the URL changed (= complex job navigated the page away).
    // This is the ONLY complexity signal — zero pre-click heuristics.
    const didNavigate = (urlBefore, waitMs = 1500) =>
        new Promise(resolve => {
            const deadline = Date.now() + waitMs;
            const poll = () => {
                if (location.href !== urlBefore) return resolve(true);
                if (Date.now() > deadline)        return resolve(false);
                setTimeout(poll, 80); // tighter poll → detects modals faster
            };
            poll();
        });

    // Wait for the URL to leave the complex-job path after history.back().
    // Called after SPA back-navigation to know when it's safe to re-query buttons.
    const waitForBackNav = (waitMs = 2000) =>
        new Promise(resolve => {
            const deadline = Date.now() + waitMs;
            const poll = () => {
                if (!location.pathname.includes("/vacancy_response")) return resolve(true);
                if (Date.now() > deadline) return resolve(false);
                setTimeout(poll, 80);
            };
            setTimeout(poll, 80); // first check after one tick
        });

    // =========================================================================
    // CUSTOM CONFIRM DIALOG
    // =========================================================================
    // Named showConfirm (not confirm) to avoid shadowing window.confirm.
    // Uses a custom modal because window.confirm is suppressed in some
    // cross-origin iframe contexts on modern browsers.
    const showConfirm = (message) => new Promise(resolve => {
        const overlay = document.createElement("div");
        overlay.style.cssText =
            "position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:2147483648;" +
            "display:flex;align-items:center;justify-content:center;";

        const box = document.createElement("div");
        box.style.cssText =
            "background:white;border-radius:10px;padding:24px 28px;max-width:400px;" +
            "font-family:system-ui;box-shadow:0 12px 40px rgba(0,0,0,.3);";
        box.innerHTML = `
            <p style="margin:0 0 20px;font-size:14px;color:#333;
                white-space:pre-line;line-height:1.6;">${escHtml(message)}</p>
            <div style="display:flex;gap:10px;justify-content:flex-end;">
                <button id="conf-cancel"
                    style="padding:9px 18px;background:#f0f0f0;border:1px solid #ccc;
                    border-radius:6px;cursor:pointer;font-size:14px;">Cancel</button>
                <button id="conf-ok"
                    style="padding:9px 18px;background:#d9534f;color:white;border:none;
                    border-radius:6px;cursor:pointer;font-size:14px;font-weight:bold;">
                    Clear
                </button>
            </div>`;

        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const close = v => { overlay.remove(); resolve(v); };
        box.querySelector("#conf-ok").onclick     = () => close(true);
        box.querySelector("#conf-cancel").onclick = () => close(false);
        overlay.addEventListener("click", e => { if (e.target === overlay) close(false); });
    });

    // =========================================================================
    // PANEL DRAG & POSITION PERSISTENCE
    // =========================================================================
    // Drag by the title bar; ↘️ button snaps back to default bottom-right corner.
    // Position is saved in GM under "panelPos" and restored on each page load.
    // mousemove listener uses {passive:true} — we never call preventDefault
    // inside it, so marking it passive lets the browser compositor run freely.

    const setupDrag = (panel) => {
        const handle   = document.getElementById("as-drag-handle");
        const resetBtn = document.getElementById("as-reset-pos");
        if (!handle) return;

        // Restore saved position
        const saved = GM_getValue("panelPos", "");
        if (saved) {
            try {
                const { left, top } = JSON.parse(saved);
                panel.style.right = "auto"; panel.style.bottom = "auto";
                panel.style.left  = left;   panel.style.top    = top;
            } catch { /* malformed — keep default bottom-right */ }
        }

        let dragging = false, ox = 0, oy = 0;

        handle.addEventListener("mousedown", (e) => {
            // Don't start drag when clicking the ↘️ reset button
            if (e.target === resetBtn || resetBtn.contains(e.target)) return;
            dragging = true;
            const r = panel.getBoundingClientRect();
            ox = e.clientX - r.left;
            oy = e.clientY - r.top;
            handle.style.cursor = "grabbing";
            e.preventDefault(); // prevent text selection during drag
        });

        // {passive:true}: we never call preventDefault in mousemove,
        // so the browser can optimise scroll/paint independently.
        document.addEventListener("mousemove", (e) => {
            if (!dragging) return;
            const l = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  e.clientX - ox));
            const t = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, e.clientY - oy));
            panel.style.right = "auto"; panel.style.bottom = "auto";
            panel.style.left = `${l}px`; panel.style.top = `${t}px`;
        }, { passive: true });

        document.addEventListener("mouseup", () => {
            if (!dragging) return;
            dragging = false;
            handle.style.cursor = "grab";
            GM_setValue("panelPos", JSON.stringify({
                left: panel.style.left,
                top:  panel.style.top
            }));
        });

        resetBtn.addEventListener("click", () => {
            panel.style.left = "auto"; panel.style.top    = "auto";
            panel.style.right = "20px"; panel.style.bottom = "20px";
            GM_setValue("panelPos", "");
            log("📌 Panel position reset to bottom-right");
        });
    };

    // =========================================================================
    // CREATE PANEL
    // =========================================================================

    const createPanel = () => {
        if (document.getElementById("as-panel")) return;

        const panel = document.createElement("div");
        panel.id = "as-panel";
        panel.style.cssText =
            "position:fixed;bottom:20px;right:20px;background:#fff;" +
            "border:3px solid #ee7f2d;border-radius:12px;padding:16px;" +
            "box-shadow:0 8px 25px rgba(0,0,0,.25);z-index:2147483647;" +
            "min-width:360px;font-family:system-ui;";

        const logOpen = isRunning ? "block" : "none";
        const btnBg   = isRunning ? "#d9534f" : "#ee7f2d";
        const btnTxt  = isRunning ? "⏹️ STOP" : "▶️ START SENDING";

        panel.innerHTML = `
            <!-- Drag handle ─────────────────────────────────────────────── -->
            <div id="as-drag-handle"
                style="display:flex;align-items:center;justify-content:space-between;
                cursor:grab;user-select:none;margin-bottom:10px;padding-bottom:8px;
                border-bottom:1px solid #ececec;">
                <span style="font-size:15px;font-weight:bold;color:#333;">
                    ⠿ ${BRAND} v${VERSION}
                </span>
                <button id="as-reset-pos" title="Reset panel to bottom-right corner"
                    style="background:none;border:1px solid #ccc;border-radius:4px;
                    width:26px;height:26px;line-height:1;cursor:pointer;
                    font-size:14px;color:#888;padding:0;flex-shrink:0;">↘️</button>
            </div>

            <!-- Main action buttons ─────────────────────────────────────── -->
            <button id="as-toggle-btn"
                style="width:100%;padding:14px;background:${btnBg};color:#fff;border:none;
                border-radius:8px;font-size:15px;font-weight:bold;cursor:pointer;
                margin-bottom:10px;">${btnTxt}
            </button>

            <button id="as-settings-btn"
                style="width:100%;padding:10px;background:#f0f0f0;color:#333;
                border:1px solid #ccc;border-radius:8px;cursor:pointer;margin-bottom:8px;">
                ⚙️ Settings
            </button>

            <button id="as-clear-btn"
                style="width:100%;padding:8px;background:#fff0f0;color:#d9534f;
                border:1px solid #f5c6c6;border-radius:8px;cursor:pointer;
                margin-bottom:14px;font-size:13px;">
                🗑 Clear session &amp; logs
            </button>

            <!-- Counters ────────────────────────────────────────────────── -->
            <div style="margin-bottom:14px;font-size:13px;color:#444;
                display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;text-align:center;">
                <div style="background:#f0fff4;border:1px solid #c3e6cb;
                    border-radius:6px;padding:6px 4px;">
                    ✅ Sent<br><b id="as-sent">${successCount}</b>
                </div>
                <!-- Clickable: opens skipped jobs popup -->
                <div id="as-complex-cell"
                    style="background:#fff3cd;border:1px solid #ffc107;border-radius:6px;
                    padding:6px 4px;cursor:pointer;transition:background .15s;"
                    title="Click to view skipped jobs"
                    onmouseenter="this.style.background='#ffe69c'"
                    onmouseleave="this.style.background='#fff3cd'">
                    ⏩ Skipped
                    <span style="font-size:10px;color:#999;vertical-align:super;"
                        title="Jobs requiring a full form — skipped automatically.">?</span>
                    <br><b id="as-complex">${complexCount}</b>
                </div>
                <div style="background:#e8f4fd;border:1px solid #bee5eb;
                    border-radius:6px;padding:6px 4px;">
                    🔖 Seen<br><b id="as-total">${processedIds.size}</b>
                </div>
            </div>

            <!-- Live log ────────────────────────────────────────────────── -->
            <div>
                <div style="display:flex;align-items:center;
                    justify-content:space-between;margin-bottom:4px;">
                    <span id="as-log-header"
                        style="font-size:13px;color:#555;cursor:pointer;user-select:none;">
                        ▼ Live Log
                    </span>
                    <button id="as-copy-btn"
                        style="padding:3px 9px;font-size:12px;background:#f0f0f0;
                        border:1px solid #ccc;border-radius:4px;cursor:pointer;">
                        📋 Copy
                    </button>
                </div>
                <div id="as-log"
                    style="background:#1a1a2e;color:#e0e0e0;border:1px solid #333;
                    border-radius:6px;padding:10px;height:190px;overflow-y:auto;
                    font-size:11.5px;line-height:1.6;font-family:monospace;
                    display:${logOpen};">
                </div>
            </div>`;

        document.body.appendChild(panel);

        // Populate element cache immediately after panel is in the DOM.
        elCache.log       = document.getElementById("as-log");
        elCache.toggleBtn = document.getElementById("as-toggle-btn");
        elCache.sentEl    = document.getElementById("as-sent");
        elCache.complexEl = document.getElementById("as-complex");
        elCache.totalEl   = document.getElementById("as-total");

        // Wire event handlers
        document.getElementById("as-toggle-btn").onclick   = toggleSending;
        document.getElementById("as-settings-btn").onclick = showSettings;
        document.getElementById("as-copy-btn").onclick     = copyLog;
        document.getElementById("as-complex-cell").onclick = showComplexPopup;

        document.getElementById("as-log-header").onclick = () => {
            const d = elCache.log;
            const opening = d.style.display === "none";
            d.style.display = opening ? "block" : "none";
            if (opening) renderLog(); // render now — was skipped while hidden
        };

        document.getElementById("as-clear-btn").onclick = async () => {
            const yes = await showConfirm(
                "This will permanently reset:\n\n" +
                "• Sent application count\n" +
                "• Complex-skipped count & list\n" +
                "• Processed vacancy ID list\n" +
                "• All log entries\n\n" +
                "These are NOT reset:\n" +
                "• Resume ID, delay, cover letter templates\n" +
                "• Panel position\n\n" +
                "To reset templates: open Settings and delete them.\n\nContinue?"
            );
            if (!yes) return;

            const wasRunning = isRunning;
            if (wasRunning) isRunning = false; // stop loop before wiping state
            stopTabIndicator();
            clearSession();                    // resets all session vars + logLines
            updateCounters();
            scheduleRender();                  // repaint now-empty log

            if (wasRunning) {
                elCache.toggleBtn.textContent      = "▶️ START SENDING";
                elCache.toggleBtn.style.background = "#ee7f2d";
            }
            elCache.log.style.display = "block"; // open log so message is visible
            log("✅ Session cleared. Settings and panel position kept.");
        };

        setupDrag(panel);
        updateCounters();
        renderLog(); // replay any log lines emitted before the panel existed
    };

    // =========================================================================
    // TOGGLE SENDING
    // =========================================================================

    const toggleSending = () => {
        isRunning = !isRunning;

        if (isRunning) {
            // Capture the search URL only on a deliberate user START.
            // Auto-resume must NOT overwrite this — it would lose the return target.
            originalSearchUrl = location.href;
            persistState();

            elCache.toggleBtn.textContent      = "⏹️ STOP";
            elCache.toggleBtn.style.background = "#d9534f";
            elCache.log.style.display          = "block";

            log("🚀 STARTED");
            log(`   url:${originalSearchUrl}`);
            log(`   seen:${processedIds.size}  sent:${successCount}  complex:${complexCount}`);

            startTabIndicator();
            startProcessing();
        } else {
            persistState();
            elCache.toggleBtn.textContent      = "▶️ START SENDING";
            elCache.toggleBtn.style.background = "#ee7f2d";
            stopTabIndicator();
            log("⏹️ STOPPED by user");
        }
    };

    // =========================================================================
    // SETTINGS DIALOG
    // =========================================================================
    // Contains: Resume ID (with hint), delay, collapsible template editors.

    // Rebuild the template <details> list for the given working-copy array.
    const buildTemplateList = (container, editTpls, getIdx, setIdx) => {
        container.innerHTML = "";
        editTpls.forEach((tpl, i) => {
            const details = document.createElement("details");
            details.style.cssText =
                "margin-bottom:6px;border:1px solid #ddd;border-radius:6px;overflow:hidden;";

            const summary = document.createElement("summary");
            summary.style.cssText =
                "cursor:pointer;padding:8px 12px;font-size:13px;font-weight:bold;" +
                "user-select:none;display:flex;justify-content:space-between;" +
                "align-items:center;background:#fafafa;list-style:none;";

            const label = document.createElement("span");
            label.textContent = `Template ${i + 1}` + (i === getIdx() ? "  ✦ active" : "");
            label.style.color = i === getIdx() ? "#ee7f2d" : "#333";

            const delBtn = document.createElement("button");
            delBtn.textContent    = "🗑";
            delBtn.title          = "Delete this template";
            delBtn.disabled       = editTpls.length <= 1;
            delBtn.style.cssText  =
                "background:none;border:none;cursor:pointer;font-size:14px;" +
                "color:#d9534f;padding:0 2px;line-height:1;" +
                (editTpls.length <= 1 ? "opacity:.3;" : "");
            delBtn.addEventListener("click", (e) => {
                e.stopPropagation(); // prevent <details> toggle
                editTpls.splice(i, 1);
                if (getIdx() >= editTpls.length) setIdx(0);
                buildTemplateList(container, editTpls, getIdx, setIdx);
                const dlg = container.closest("#as-settings-dlg");
                const sel = dlg?.querySelector("#as-active-tmpl");
                if (sel) rebuildActiveSelector(sel, editTpls, getIdx, setIdx);
                // Re-evaluate whether random template toggle can be enabled
                const syncFn = dlg?._syncTmplRandState;
                if (syncFn) syncFn();
            });

            summary.append(label, delBtn);

            const body = document.createElement("div");
            body.style.cssText = "padding:10px;";

            const ta = Object.assign(document.createElement("textarea"), {
                value:       tpl,
                maxLength:   1500,
                rows:        4,
                placeholder: "Write your template here. Use {JOB_TITLE} for the vacancy name."
            });
            ta.style.cssText =
                "width:100%;padding:7px;border:1px solid #ccc;border-radius:4px;" +
                "box-sizing:border-box;font-size:12px;resize:vertical;font-family:inherit;";

            const counter = document.createElement("div");
            counter.style.cssText = "font-size:11px;color:#999;text-align:right;margin-top:3px;";
            counter.textContent   = `${tpl.length}/1500`;

            ta.addEventListener("input", () => {
                editTpls[i]         = ta.value;
                counter.textContent = `${ta.value.length}/1500`;
            });

            body.append(ta, counter);
            details.append(summary, body);
            container.appendChild(details);
        });
    };

    const rebuildActiveSelector = (sel, editTpls, getIdx, setIdx) => {
        sel.innerHTML = "";
        editTpls.forEach((_, i) => {
            const opt = Object.assign(document.createElement("option"), {
                value:    i,
                textContent: `Template ${i + 1}`,
                selected: i === getIdx()
            });
            sel.appendChild(opt);
        });
        // Use addEventListener instead of .onchange to avoid overwriting
        // any previously attached handler on a rebuilt select element.
        sel.addEventListener("change", () => {
            setIdx(parseInt(sel.value));
            // Refresh active labels in the list without a full rebuild
            const listEl = sel.closest("#as-settings-dlg")?.querySelector("#as-tmpl-list");
            if (!listEl) return;
            listEl.querySelectorAll("summary span:first-child").forEach((sp, i) => {
                sp.textContent = `Template ${i + 1}` + (i === getIdx() ? "  ✦ active" : "");
                sp.style.color = i === getIdx() ? "#ee7f2d" : "#333";
            });
        });
    };

    const showSettings = () => {
        const overlay = document.createElement("div");
        overlay.style.cssText =
            "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:2147483648;";

        const dialog = document.createElement("div");
        dialog.id = "as-settings-dlg";
        dialog.style.cssText =
            "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);" +
            "background:white;border-radius:12px;width:500px;max-height:85vh;" +
            "z-index:2147483649;display:flex;flex-direction:column;overflow:hidden;";

        // ── Header ──────────────────────────────────────────────────────────
        const hdr = document.createElement("div");
        hdr.style.cssText = "padding:20px 24px 12px;border-bottom:1px solid #eee;flex-shrink:0;";
        hdr.innerHTML = `<h2 style="margin:0;font-size:17px;">⚙️ Settings</h2>`;

        // ── Scrollable body ──────────────────────────────────────────────────
        const bodyEl = document.createElement("div");
        bodyEl.style.cssText = "padding:16px 24px;overflow-y:auto;flex:1;";
        bodyEl.innerHTML = `
            <label style="font-size:13px;font-weight:bold;">Resume ID</label>
            <div style="font-size:11px;color:#888;margin:3px 0 6px;">
                Copy the long ID from your resume URL on hh.ru:<br>
                <span style="font-family:monospace;color:#555;">
                    hh.ru/resume/<b>l033t74oj0cg84bde0839yd1f614270706634</b>
                </span>
            </div>
            <input id="as-resume-inp" value="${escHtml(config.RESUME_ID)}"
                placeholder="Paste your resume ID here"
                style="width:100%;padding:8px;margin-bottom:16px;border:1px solid #ccc;
                border-radius:6px;box-sizing:border-box;font-size:13px;">

            <label style="font-size:13px;font-weight:bold;">Delay between responses (ms)</label>
            <div style="font-size:11px;color:#888;margin:3px 0 6px;">
                Min 1500 ms recommended. Lower = faster but higher bot-detection risk.
                Disabled when randomization is on.
            </div>
            <input id="as-delay-inp" type="number" value="${config.DELAY_MS}"
                min="1500" max="15000"
                ${config.RAND_ENABLED ? "disabled" : ""}
                style="width:100%;padding:8px;margin-bottom:16px;border:1px solid #ccc;
                border-radius:6px;box-sizing:border-box;font-size:13px;
                ${config.RAND_ENABLED ? "opacity:0.45;" : ""}">

            <!-- Randomized delay ──────────────────────────────────────────── -->
            <div style="background:#f8f8f8;border:1px solid #e0e0e0;border-radius:8px;
                padding:14px;margin-bottom:20px;">
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer;
                    font-size:13px;font-weight:bold;margin-bottom:10px;">
                    <input type="checkbox" id="as-rand-chk"
                        ${config.RAND_ENABLED ? "checked" : ""}
                        style="width:15px;height:15px;cursor:pointer;">
                    🎲 Randomize delay (Gaussian distribution)
                </label>
                <div style="font-size:11px;color:#888;margin-bottom:10px;line-height:1.6;">
                    When enabled, the delay is sampled from a Gaussian (bell-curve) distribution
                    in [min, max] and re-rolled every 4–7 sent responses automatically.<br>
                    The fixed delay field above is disabled while this is on.
                </div>
                <div id="as-rand-fields" style="display:${config.RAND_ENABLED ? "flex" : "none"};
                    gap:12px;align-items:flex-end;">
                    <div style="flex:1;">
                        <label style="font-size:11px;color:#555;display:block;margin-bottom:3px;">
                            Min delay (ms, ≥ 100)
                        </label>
                        <input id="as-rand-min" type="number" value="${config.RAND_MIN}"
                            min="100" max="30000"
                            style="width:100%;padding:7px;border:1px solid #ccc;
                            border-radius:5px;box-sizing:border-box;font-size:13px;">
                    </div>
                    <div style="flex:1;">
                        <label style="font-size:11px;color:#555;display:block;margin-bottom:3px;">
                            Max delay (ms, > min)
                        </label>
                        <input id="as-rand-max" type="number" value="${config.RAND_MAX}"
                            min="200" max="60000"
                            style="width:100%;padding:7px;border:1px solid #ccc;
                            border-radius:5px;box-sizing:border-box;font-size:13px;">
                    </div>
                </div>
                <div id="as-rand-err" style="display:none;margin-top:6px;
                    font-size:11px;color:#d9534f;"></div>
            </div>

            <div style="display:flex;justify-content:space-between;
                align-items:center;margin-bottom:6px;">
                <label style="font-size:13px;font-weight:bold;">Cover Letter Templates</label>
                <div style="display:flex;align-items:center;gap:8px;">
                    <span id="as-active-label" style="font-size:12px;color:#555;
                        ${config.TMPL_RANDOM ? 'opacity:0.4;' : ''}">Active:</span>
                    <select id="as-active-tmpl"
                        ${config.TMPL_RANDOM ? "disabled" : ""}
                        style="padding:4px 6px;font-size:12px;border:1px solid #ccc;
                        border-radius:4px;
                        ${config.TMPL_RANDOM ? 'opacity:0.4;' : ''}"></select>
                    <button id="as-add-tmpl"
                        style="padding:4px 10px;background:#ee7f2d;color:white;border:none;
                        border-radius:4px;cursor:pointer;font-size:12px;font-weight:bold;">
                        + Add
                    </button>
                </div>
            </div>

            <!-- Random template toggle ──────────────────────────────────── -->
            <!-- Disabled (greyed out) when fewer than 2 templates exist.   -->
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
                <input type="checkbox" id="as-tmpl-rand-chk"
                    ${config.TMPL_RANDOM ? "checked" : ""}
                    style="width:14px;height:14px;cursor:pointer;flex-shrink:0;">
                <label for="as-tmpl-rand-chk"
                    style="font-size:12px;color:#444;cursor:pointer;user-select:none;">
                    🔀 Pick a random template for each application
                </label>
            </div>
            <div id="as-tmpl-rand-hint" style="font-size:11px;color:#d9534f;
                margin-bottom:8px;display:none;">
                Add at least 2 templates to enable random selection.
            </div>
            <div style="font-size:11px;color:#888;margin-bottom:10px;line-height:1.6;">
                Up to 5 templates · use <b>{JOB_TITLE}</b> as placeholder · max 1500 chars.<br>
                If hh.ru rejects the text, an empty cover is sent instead.<br>
                <span style="color:#c0392b;font-weight:bold;">
                    ⚠ Templates survive "Clear session" — delete them here to remove.
                </span>
            </div>
            <div id="as-tmpl-list"></div>`;

        // ── Footer ──────────────────────────────────────────────────────────
        const footer = document.createElement("div");
        footer.style.cssText =
            "padding:14px 24px;border-top:1px solid #eee;display:flex;gap:10px;flex-shrink:0;";
        footer.innerHTML = `
            <button id="as-save-set"
                style="flex:1;padding:12px;background:#ee7f2d;color:white;border:none;
                border-radius:6px;font-weight:bold;cursor:pointer;font-size:14px;">
                Save
            </button>
            <button id="as-cancel-set"
                style="flex:1;padding:12px;background:#f0f0f0;border:1px solid #ccc;
                border-radius:6px;cursor:pointer;font-size:14px;">
                Cancel
            </button>`;

        dialog.append(hdr, bodyEl, footer);
        document.body.append(overlay, dialog);

        // Working copies scoped to this dialog session.
        // We work on copies so Cancel truly discards all changes.
        const editTpls  = [...coverTemplates]; // shallow copy of strings
        let   editIdx   = config.TEMPLATE_ID;
        const getIdx    = () => editIdx;
        const setIdx    = v  => { editIdx = v; };

        const tmplList  = dialog.querySelector("#as-tmpl-list");
        const activeSel = dialog.querySelector("#as-active-tmpl");
        buildTemplateList(tmplList, editTpls, getIdx, setIdx);
        rebuildActiveSelector(activeSel, editTpls, getIdx, setIdx);

        // ── Random template toggle interactivity ────────────────────────────
        // Checkbox is disabled (and shows a hint) when fewer than 2 templates
        // exist. When checked it greys out the "Active:" selector because the
        // active index is irrelevant while random selection is on.
        const tmplRandChk  = dialog.querySelector("#as-tmpl-rand-chk");
        const tmplRandHint = dialog.querySelector("#as-tmpl-rand-hint");
        const activeLabel  = dialog.querySelector("#as-active-label");

        // Sync the random-template toggle state to current editTpls count.
        // Called whenever templates are added or deleted.
        const syncTmplRandState = () => {
            const canRandom = editTpls.length >= 2;
            tmplRandChk.disabled  = !canRandom;
            tmplRandChk.style.opacity = canRandom ? "1" : "0.4";
            tmplRandHint.style.display = canRandom ? "none" : "block";
            if (!canRandom) tmplRandChk.checked = false; // force off if only 1 template

            // Dim the "Active:" selector while random is enabled
            const isRandom = tmplRandChk.checked;
            activeSel.disabled         = isRandom;
            activeSel.style.opacity    = isRandom ? "0.4" : "1";
            activeLabel.style.opacity  = isRandom ? "0.4" : "1";
        };
        syncTmplRandState();

        tmplRandChk.addEventListener("change", syncTmplRandState);

        // ── Randomization checkbox interactivity ────────────────────────────
        // Toggling the checkbox shows/hides min+max fields and enables/disables
        // the fixed delay input. No save is triggered — user must click Save.
        const randChk    = dialog.querySelector("#as-rand-chk");
        const randFields = dialog.querySelector("#as-rand-fields");
        const delayInp   = dialog.querySelector("#as-delay-inp");
        const randErr    = dialog.querySelector("#as-rand-err");

        randChk.addEventListener("change", () => {
            const on = randChk.checked;
            randFields.style.display  = on ? "flex" : "none";
            delayInp.disabled         = on;
            delayInp.style.opacity    = on ? "0.45" : "1";
            randErr.style.display     = "none";
        });

        const refreshAddBtn = () => {
            const btn = dialog.querySelector("#as-add-tmpl");
            btn.disabled      = editTpls.length >= 5;
            btn.style.opacity = editTpls.length >= 5 ? "0.4" : "1";
        };
        // Attach sync function to dialog element so buildTemplateList's delete
        // callback can reach it without a closure dependency.
        dialog._syncTmplRandState = syncTmplRandState;

        refreshAddBtn();

        dialog.querySelector("#as-add-tmpl").addEventListener("click", () => {
            if (editTpls.length >= 5) return;
            editTpls.push(
                `Здравствуйте!\n\nЯ заинтересован в должности «{JOB_TITLE}».\n\nС уважением`
            );
            buildTemplateList(tmplList, editTpls, getIdx, setIdx);
            rebuildActiveSelector(activeSel, editTpls, getIdx, setIdx);
            refreshAddBtn();
            syncTmplRandState(); // re-evaluate: adding a 2nd template unlocks random
            // Auto-open the newly added entry
            const all = tmplList.querySelectorAll("details");
            if (all.length) all[all.length - 1].open = true;
        });

        dialog.querySelector("#as-save-set").onclick = () => {
            config.RESUME_ID  = dialog.querySelector("#as-resume-inp").value.trim();
            config.DELAY_MS   = Math.max(
                1500,
                parseInt(dialog.querySelector("#as-delay-inp").value) || 3000
            );

            // ── Validate randomization inputs before saving ─────────────────
            const randEnabled = dialog.querySelector("#as-rand-chk").checked;
            if (randEnabled) {
                const rMin = parseInt(dialog.querySelector("#as-rand-min").value) || 0;
                const rMax = parseInt(dialog.querySelector("#as-rand-max").value) || 0;
                const errEl = dialog.querySelector("#as-rand-err");

                if (rMin < 100) {
                    errEl.textContent  = "Min delay must be at least 100 ms.";
                    errEl.style.display = "block";
                    return; // block save
                }
                if (rMax <= rMin) {
                    errEl.textContent  = "Max delay must be greater than min delay.";
                    errEl.style.display = "block";
                    return;
                }

                config.RAND_ENABLED = true;
                config.RAND_MIN     = rMin;
                config.RAND_MAX     = rMax;
                // Set current delay to a fresh sample so it takes effect immediately
                config.DELAY_MS     = sampleDelay();
                // Reset rotation counter so first rotation happens at correct cadence
                _responsesSinceRotation = 0;
                _nextRotateAt           = _randInt(4, 7);
            } else {
                config.RAND_ENABLED = false;
            }

            // Strip empty templates; fall back to defaults if all deleted.
            const finalTpls    = editTpls.map(t => t.trim()).filter(Boolean);
            coverTemplates     = finalTpls.length ? finalTpls : [...DEFAULT_TEMPLATES];
            config.TEMPLATE_ID = Math.min(editIdx, coverTemplates.length - 1);

            // Random template selection — only valid when ≥ 2 templates exist.
            const tmplRandWanted = dialog.querySelector("#as-tmpl-rand-chk").checked;
            config.TMPL_RANDOM   = tmplRandWanted && coverTemplates.length >= 2;

            GM_setValue("resumeId",     config.RESUME_ID);
            GM_setValue("delayMs",      config.DELAY_MS);
            GM_setValue("templateId",   config.TEMPLATE_ID);
            GM_setValue("userTemplates",JSON.stringify(coverTemplates));
            GM_setValue("randEnabled",  config.RAND_ENABLED);
            GM_setValue("randMin",      config.RAND_MIN);
            GM_setValue("randMax",      config.RAND_MAX);
            GM_setValue("tmplRandom",   config.TMPL_RANDOM);

            overlay.remove(); dialog.remove();
            const randNote  = config.RAND_ENABLED
                ? `  rand:[${config.RAND_MIN}–${config.RAND_MAX}ms]` : "";
            const tmplNote  = config.TMPL_RANDOM ? "  tmpl:random" : `  tmpl:${config.TEMPLATE_ID + 1}`;
            log(`✅ Settings saved — delay:${config.DELAY_MS}ms${randNote}  templates:${coverTemplates.length}${tmplNote}`);
        };

        const closeDialog = () => { overlay.remove(); dialog.remove(); };
        dialog.querySelector("#as-cancel-set").onclick = closeDialog;
        overlay.addEventListener("click", e => { if (e.target === overlay) closeDialog(); });
    };

    // =========================================================================
    // MAIN PROCESSING LOOP
    // =========================================================================

    const startProcessing = async () => {
        if (isProcessingActive) {
            log("⚠️ Loop already active — duplicate call ignored");
            return;
        }
        isProcessingActive = true;
        log(`🔄 Loop started — ${location.pathname}`);

        try {
            while (isRunning) {

                // ── Collect and partition response buttons ─────────────────
                const allBtns = [...document.querySelectorAll(
                    '[data-qa="vacancy-serp__vacancy_response"],' +
                    '[data-qa*="vacancy_response"]'
                )];

                const toProcess = [];
                let   skipped   = 0;
                for (const btn of allBtns) {
                    const id = getVacancyIdFromBtn(btn);
                    // Only skip if we have a confirmed ID match — null IDs proceed.
                    if (id && processedIds.has(id)) { skipped++; continue; }
                    toProcess.push({ btn, vid: id });
                }

                log(`🔍 ${allBtns.length} buttons · ${toProcess.length} new · ${skipped} seen`);
                if (allBtns.length === 0) log("⏳ No buttons — page still loading?");

                let didComplexSkip = false;

                for (const { btn, vid } of toProcess) {
                    if (!isRunning) break;

                    // Capture job title BEFORE clicking.
                    // After the modal opens, document.querySelector("h1") returns
                    // "Найдено N вакансий" (the search header), not the vacancy title.
                    const jobTitle = getJobTitleFromCard(btn) || "позицию";

                    log(`👆 id:${vid ?? "?"} "${jobTitle}"`);

                    // Micro pre-scroll pause (20–70 ms): simulates the user's eye
                    // landing on the next card before reaching for the mouse.
                    // Short enough to be imperceptible as delay, human enough to
                    // break the fixed-cadence signature of a bot.
                    await sleep(_jitterMs(20, 70));

                    // scrollIntoView "instant" + short random settle (50–130 ms).
                    // "instant" skips the CSS scroll animation entirely — no waiting
                    // for a cosmetic effect the automated flow doesn't need.
                    btn.scrollIntoView({ behavior: "instant", block: "center" });
                    await sleep(_jitterMs(50, 130));

                    const urlBefore = location.href;
                    await humanInteract(btn);

                    // Poll for URL change (80 ms interval, up to 1500 ms).
                    // URL change = complex job that navigated the page away.
                    const navigated = await didNavigate(urlBefore, 1500);

                    if (navigated) {
                        // ── COMPLEX JOB ──────────────────────────────────────
                        // The redirect URL's vacancyId param is authoritative:
                        // it works even when getVacancyIdFromBtn returned null
                        // (DOM mismatch). Storing it prevents the endless-loop
                        // where the same button is clicked on every pass.
                        const complexUrl = location.href;
                        const urlVid     = getVacancyIdFromUrl(complexUrl);
                        const finalId    = urlVid ?? vid;

                        if (!finalId) {
                            log("⚠️ Complex — id unknown (DOM+URL mismatch). May recur.");
                            log("   → update getVacancyIdFromBtn() selectors if this repeats");
                        } else {
                            log(`🔀 Complex — id:${finalId} "${jobTitle}"`);
                        }

                        markProcessed(vid, urlVid); // null-safe
                        complexCount++;
                        pushComplexJob({
                            id:    finalId,
                            title: jobTitle,
                            // Prefer the canonical vacancy URL; fall back to redirect URL.
                            url:   finalId ? `https://hh.ru/vacancy/${finalId}` : complexUrl,
                            time:  Date.now()
                        });
                        persistState();   // covers processedIds + complexCount
                        updateCounters();

                        // ── SPA back-navigation (preferred path) ─────────────
                        // history.back() keeps the JS context alive when hh.ru
                        // used pushState. The loop continues without a page reload.
                        history.back();
                        const spaOk = await waitForBackNav(2000);

                        if (spaOk) {
                            log("♻️ SPA back OK — continuing");
                            // Random settle lets React re-render without a fixed cadence.
                            await sleep(_jitterMs(350, 600));
                            didComplexSkip = true;
                            break; // re-query fresh button list in outer while
                        } else {
                            // history.back() timed out — hh.ru used a hard navigation.
                            // Fall back: hard-navigate to original search URL.
                            // Context is destroyed; maybeAutoResume() takes over.
                            log("⚠️ SPA back timed out — hard nav to search URL");
                            window.location.href = originalSearchUrl;
                            return; // unreachable but documents intent
                        }
                    }

                    // ── SIMPLE MODAL (cover letter) ──────────────────────────
                    markProcessed(vid);

                    const textarea = document.querySelector("textarea");
                    if (textarea) {
                        // Pick template: random from all templates, or fixed active one.
                        // TMPL_RANDOM requires ≥ 2 templates (enforced in Settings UI).
                        const tmplIdx = (config.TMPL_RANDOM && coverTemplates.length > 1)
                            ? _randInt(0, coverTemplates.length - 1)
                            : Math.min(config.TEMPLATE_ID, coverTemplates.length - 1);
                        const coverLetter = (coverTemplates[tmplIdx] ?? coverTemplates[0])
                            .replace("{JOB_TITLE}", jobTitle);
                        log(`✏️ Template ${tmplIdx + 1}${config.TMPL_RANDOM ? " (random)" : ""}`);

                        textarea.value = coverLetter;
                        // React/Vue detect value via 'input' event, not bare assignment.
                        textarea.dispatchEvent(new Event("input", { bubbles: true }));
                        // Random wait (300–500ms) for React's validation pass.
                        await sleep(_jitterMs(300, 500));

                        // ── hh.ru validation fallback ─────────────────────────
                        // If the cover letter text is rejected (aria-invalid="true" or
                        // an error class applied to the field or its container), clear
                        // the value and submit without a cover rather than getting stuck.
                        const isInvalid =
                            textarea.getAttribute("aria-invalid") === "true" ||
                            !!textarea.closest('[class*="error"],[data-qa*="error"]') ||
                            !!textarea.parentElement?.querySelector('[class*="error"],[data-qa*="error"]');

                        if (isInvalid) {
                            log("⚠️ Cover letter rejected by hh.ru — sending without cover");
                            textarea.value = "";
                            textarea.dispatchEvent(new Event("input", { bubbles: true }));
                            await sleep(_jitterMs(100, 200)); // brief settle after clear
                        }

                        const submitBtn =
                            document.querySelector('[data-qa*="submit"]') ||
                            document.querySelector('button[type="submit"]') ||
                            [...document.querySelectorAll("button")]
                                .find(b => /Отправить|Откликнуться/i.test(b.textContent));

                        if (submitBtn) {
                            await humanInteract(submitBtn);
                            successCount++;
                            logApplication(vid, jobTitle, isInvalid ? "(no cover)" : coverLetter);

                            // Check for daily 200-reply limit BEFORE persisting
                            // or sleeping — the error message appears immediately
                            // in the DOM after the failed submit attempt.
                            // Random wait 300–500ms: snappy but gives hh.ru time to render.
                            await sleep(_jitterMs(300, 500));
                            if (isDailyLimitHit()) {
                                handleDailyLimit();
                                return; // exits startProcessing entirely
                            }

                            // Rotate randomized delay if due
                            maybeRotateDelay();

                            persistState();
                            updateCounters();
                        } else {
                            // Dump visible button labels to help debug a broken selector.
                            const labels = [...document.querySelectorAll("button")]
                                .map(b => `"${b.textContent.trim().slice(0, 25)}"`)
                                .filter(Boolean).join(", ");
                            log(`⚠️ Submit button not found. Visible: ${labels}`);
                            persistState();
                        }
                    } else {
                        // No textarea: vacancy was already applied to, or it uses
                        // a direct-apply flow with no cover letter step.
                        log("ℹ️ No textarea — already applied or no cover letter needed");
                        persistState();
                    }

                    log(`⏱ ${config.DELAY_MS}ms`);
                    await sleep(config.DELAY_MS);
                } // end for toProcess

                // After a successful SPA back-nav we skip the inter-pass pause
                // because we already waited inside the complex-job branch.
                if (didComplexSkip) continue;

                // Random inter-pass pause (500–900 ms) before re-querying buttons.
                // Handles lazy-loaded cards and breaks any fixed timing pattern.
                await sleep(_jitterMs(500, 900));
            } // end while

        } catch (err) {
            log(`❌ ERROR: ${err.message}`);
            log(`   ${err.stack?.split("\n")[1]?.trim() ?? "no stack"}`);
            log("🛑 Loop stopped — press START to retry");
            stopTabIndicator();
        } finally {
            // Always release the guard so a new loop can start after an error.
            isProcessingActive = false;
        }
    };

    // =========================================================================
    // AUTO-RESUME
    // =========================================================================
    // Called on every page load. If isRunning=true in GM storage a
    // window.location.href navigation just occurred and we must resume.
    //
    // Design: no branch that sets isRunning=false.  Previous versions had one
    // and it permanently stopped the script on any canonical URL redirect.
    // We are permissive: resume on any hh.ru page that is not the complex-job
    // form itself. Everything is logged so failures are visible.

    const maybeAutoResume = () => {
        log(`🗺 Resume check — isRunning:${isRunning}`);
        log(`   current : ${location.href.slice(0, 100)}`);

        if (!isRunning) { log("💤 Nothing to resume"); return; }

        if (location.pathname.includes("/vacancy_response")) {
            log("⏳ Still on complex page — waiting for navigation");
            return;
        }
        if (!location.hostname.includes("hh.ru")) {
            log("⚠️ Not on hh.ru — skipping resume");
            return;
        }

        log("♻️ Auto-resuming (hard-nav cycle)");

        if (elCache.toggleBtn) {
            elCache.toggleBtn.textContent      = "⏹️ STOP";
            elCache.toggleBtn.style.background = "#d9534f";
        }
        if (elCache.log) elCache.log.style.display = "block";

        startTabIndicator();
        startProcessing();
    };

    // Bfcache (back-forward cache) handler.
    // When history.back() lands on a bfcache copy of the search page,
    // DOMContentLoaded does not fire again but 'pageshow' does (event.persisted=true).
    window.addEventListener("pageshow", (e) => {
        if (e.persisted && isRunning && !isProcessingActive) {
            log("♻️ Bfcache restore — resuming");
            startTabIndicator();
            startProcessing();
        }
    });

    // =========================================================================
    // INIT
    // =========================================================================
    // Multiple retries handle hh.ru's deferred React hydration that can push
    // body population past document-end.

    const init = () => {
        if (document.getElementById("as-panel")) return;
        createPanel();
        // 800 ms: lets hh.ru's React SPA settle its URL before we read it.
        setTimeout(maybeAutoResume, 800);
    };

    setTimeout(init, 800);
    setTimeout(init, 2500);
    setTimeout(init, 5000);

    // One-shot MutationObserver — catches very early body population.
    // Disconnects as soon as the panel is in the DOM to avoid re-triggering
    // on every subsequent SPA DOM mutation.
    const obs = new MutationObserver(() => {
        if (document.getElementById("as-panel")) { obs.disconnect(); return; }
        init();
    });
    obs.observe(document.body, { childList: true, subtree: false });

    log(`${BRAND} v${VERSION} initialized — ${location.pathname}`);

})();
