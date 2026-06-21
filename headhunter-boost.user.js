// ==UserScript==
// @name         HeadHunter Boost
// @name:ru      HeadHunter Boost
// @namespace    https://github.com/mklishin/headhunter-boost
// @version      6.4
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

(() => {
    'use strict';

    // ── ANTI-DETECTION ────────────────────────────────────────────────────────
    // Safe approach: no EventTarget.prototype patching (that breaks React's
    // synthetic event system and prevents the page from initialising).
    // Instead use three non-destructive techniques:
    //   1. Capture-phase stoppers for tab-visibility events (fire before site handlers)
    //   2. visibilityState spoof so hh.ru always thinks the tab is active
    //   3. CSS to force text selection / re-enable copy everywhere
    (() => {
        // 1. Capture-phase stoppers — intercept BEFORE hh.ru handlers fire.
        //    Using the native addEventListener (no prototype patch).
        const TAB_EVENTS = ['visibilitychange', 'webkitvisibilitychange'];
        for (const ev of TAB_EVENTS) {
            window.addEventListener(ev, e => e.stopImmediatePropagation(), true);
        }
        // Allow copy/paste/contextmenu through — just stop hh.ru from blocking them
        const UNBLOCK = ['copy', 'cut', 'paste', 'contextmenu', 'selectstart'];
        for (const ev of UNBLOCK) {
            document.addEventListener(ev, e => {
                if (!e.isTrusted) return;
                e.stopImmediatePropagation();
                // Re-dispatch as a trusted-looking event so browser default still fires
            }, true);
        }

        // 2. Spoof visibilityState so hh.ru always sees the tab as active
        try {
            Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
            Object.defineProperty(document, 'hidden',          { get: () => false });
        } catch (_) { /* some browsers protect these */ }

        // 3. CSS: force text selection and re-enable copy everywhere
        const s = document.createElement('style');
        s.textContent = `*{-webkit-user-select:text!important;user-select:text!important}`;
        (document.head || document.documentElement).appendChild(s);
    })();
    // ─────────────────────────────────────────────────────────────────────────

    const VERSION = "6.4";
    const BRAND   = "HeadHunter Boost";

    // Shared regex for extracting numeric vacancy IDs from hh.ru URLs.
    // Hoisted here (top of script) so it is defined before any function that
    // references it gets called — avoids re-creating a RegExp literal on
    // every match() call across getVacancyIdFromBtn / applyVisitedStyles.
    const VACANCY_ID_RE = /\/vacancy\/(\d+)/;

    // Reads a GM key, JSON.parse's it, falls back to `fb` on any error
    // (missing key, corrupt JSON, wrong type). Used everywhere a persisted
    // array/object is loaded at startup — avoids repeating the same
    // try/catch three times.
    const gmJSON = (key, fb) => {
        try { const v = JSON.parse(GM_getValue(key, JSON.stringify(fb))); return v ?? fb; }
        catch (_) { return fb; }
    };

    // Writes multiple GM keys from a plain object, e.g. gmSetMany({a: 1, b: 2}).
    // Each write is individually guarded so one failure doesn't block the rest;
    // failures are logged via `log()` once the panel exists, console.error always.
    const gmSetMany = (obj) => {
        for (const [key, val] of Object.entries(obj)) {
            try { GM_setValue(key, val); }
            catch (e) {
                console.error(`[${BRAND}] GM_setValue("${key}") failed:`, e);
                if (typeof log === "function") log(`❌ GM_setValue("${key}") failed: ${e.message}`);
            }
        }
    };

    // Creates and appends a full-screen, flex-centered dim backdrop — the
    // shared shell used by showLimitModal, showConfirm, and showComplexPopup.
    // Caller appends their own content box into the returned element.
    // onOutsideClick (optional) fires when the backdrop itself is clicked.
    const _overlay = (onOutsideClick) => {
        const ov = document.createElement("div");
        ov.style.cssText =
            "position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:2147483648;" +
            "display:flex;align-items:center;justify-content:center;";
        document.body.appendChild(ov);
        if (onOutsideClick) ov.addEventListener("click", e => { if (e.target === ov) onOutsideClick(); });
        return ov;
    };

    // Shown in Settings. User can edit, add (up to 5), or delete.
    // Persisted under GM key "userTemplates". Cleared only by deleting in Settings.
    // {JOB_TITLE} is replaced with the vacancy title at send time.

    const DEFAULT_TEMPLATES = [
        `Коллеги, здравствуйте!\n\nЯ заинтересован в должности «{JOB_TITLE}» и готов обсудить детали, есть релевантный опыт.\n\nС уважением`,
        `Добрый день, коллеги!\n\nМой опыт соответствует требованиям вакансии «{JOB_TITLE}».\n\nС уважением`,
        `Здравствуйте, коллеги! Есть релевантный опыт!\n\nГотов присоединиться к вашей команде на позицию «{JOB_TITLE}».\n\nС уважением`
    ];

    // Load persisted user templates; fall back to defaults on missing/corrupt/empty.
    let coverTemplates = (() => {
        const arr = gmJSON("userTemplates", []);
        return (Array.isArray(arr) && arr.length) ? arr : [...DEFAULT_TEMPLATES];
    })();

    // GM keys: resumeId · templateId · tmplRandom · delayMs · userTemplates ·
    //          randEnabled · randMin · randMax · panelPos

    const config = {
        // ── Multi-resume support ─────────────────────────────────────────────
        // Up to 5 resumes stored as [{id, label}, ...].
        // label is either user-typed or auto-fetched from hh.ru (requires login).
        // Never cleared by "Clear session" — user preferences.
        //
        // Migration: if the old single "resumeId" key exists and "resumes" is
        // empty, we promote the old value so existing users don't lose their ID.
        RESUMES: (() => {
            const arr = gmJSON("resumes", []);
            if (Array.isArray(arr) && arr.length) return arr;
            // Migration from old single-ID storage
            const legacy = GM_getValue("resumeId", "");
            return legacy ? [{ id: legacy, label: "" }] : [];
        })(),
        ACTIVE_RESUME_IDX: GM_getValue("activeResumeIdx", 0),

        // Keep RESUME_ID as a computed getter so the rest of the code that
        // reads config.RESUME_ID keeps working without changes.
        get RESUME_ID() {
            const r = this.RESUMES[this.ACTIVE_RESUME_IDX];
            return r ? r.id : "";
        },

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
        RAND_MIN:     GM_getValue("randMin",     1500),
        RAND_MAX:     GM_getValue("randMax",     5000),
        DARK_THEME:   GM_getValue("darkTheme",   false),
    };

    // Clamp saved templateId in case templates were deleted since last run.
    if (config.TEMPLATE_ID >= coverTemplates.length) config.TEMPLATE_ID = 0;

    // GM keys: isRunning · successCount · complexCount · originalSearchUrl ·
    //          processedIds · complexJobs
    //
    // All state that must survive window.location.href (which destroys the JS
    // context) lives in GM storage. In-memory vars below are working copies.

    let isRunning         = GM_getValue("isRunning",         false);
    let successCount      = GM_getValue("successCount",      0);
    let complexCount      = GM_getValue("complexCount",      0);
    let originalSearchUrl = GM_getValue("originalSearchUrl", "");
    // processedIds: union of applied + skipped + already-applied. Used to
    // avoid re-clicking. NOT used for badge display (too broad).
    let processedIds = new Set(gmJSON("processedIds", []));
    // appliedIds: ONLY vacancies where submitBtn.click() actually fired.
    // Used for the "✓ Отклик" badge — accurate, no false positives.
    let appliedIds   = new Set(gmJSON("appliedIds", []));
    let complexJobs  = gmJSON("complexJobs", []);

    // dbg(): console-only verbose trace. Never shown in the panel log.
    // Use for per-step timing, interaction method, DOM probe results — anything
    // useful when you open DevTools but would clutter the live log for users.
    const dbg = (...args) => console.debug(`[${BRAND}]`, ...args);

    // ── Guarded persistState ─────────────────────────────────────────────────
    // Each GM_setValue is wrapped separately so a partial failure is visible.
    // In practice Tampermonkey's GM_setValue never throws, but a corrupted
    // storage quota or sandbox issue would otherwise silently drop state.
    const persistState = () => gmSetMany({
        isRunning,
        successCount,
        complexCount,
        originalSearchUrl,
        processedIds: JSON.stringify([...processedIds]),
        appliedIds:   JSON.stringify([...appliedIds]),
    });

    const clearSession = () => {
        isRunning = false; successCount = 0; complexCount = 0;
        originalSearchUrl = ""; processedIds = new Set(); appliedIds = new Set();
        complexJobs = []; logLines = [];
        _invalidateSkippedCache();
        persistState();
        gmSetMany({ complexJobs: "[]" });
    };

    // hh.ru is a React SPA. DOM mutations can re-trigger init() →
    // maybeAutoResume() → startProcessing() while a loop is already running.
    // This flag prevents a second concurrent loop from starting.
    let isProcessingActive = false;

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // Samples a value in [min, max] using a Gaussian distribution centred at
    // the midpoint with σ ≈ (max-min)/6, then clamped to the range.
    // Gaussian makes the pattern less mechanical than uniform random: most
    // delays cluster near the midpoint, with occasional long/short outliers.
    //
    // Delay is re-rolled every 4–7 successful sends (randomised count so even
    // the rotation cadence is unpredictable). Each rotation is logged.

    let _responsesSinceRotation = 0;
    let _nextRotateAt           = _randInt(4, 7); // rotate after this many sends

    function _randInt(lo, hi) { return lo + Math.floor(Math.random() * (hi - lo + 1)); }


    // Replaces bare el.click() at both interaction points (response button,
    // submit button): 60% direct click, 40% focus()+Enter with a full
    // keydown/keypress/keyup triad (missing keypress is a known bot signal).
    // Falls back to a plain click on any DOM error.

    // Dispatches the full keydown/keypress/keyup triad.
    const _key = (el, key, code, extra = {}) => {
        const opts = { key, code, bubbles: true, cancelable: true, ...extra };
        el.dispatchEvent(new KeyboardEvent("keydown",  opts));
        el.dispatchEvent(new KeyboardEvent("keypress", opts));
        el.dispatchEvent(new KeyboardEvent("keyup",    opts));
    };

    const humanInteract = async (el) => {
        try {
            if (Math.random() < 0.60) {
                dbg("interact: click()");
                el.click();
            } else {
                dbg("interact: focus+Enter");
                el.focus();
                await sleep(_randInt(25, 75));
                _key(el, "Enter", "Enter");
            }
        } catch (e) {
            log(`⚠️ humanInteract error: ${e.message} — fallback click()`);
            try { el.click(); } catch (_) { /* element gone */ }
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
        gmSetMany({ delayMs: newDelay }); // persist so resumed sessions keep it
    };

    // hh.ru displays this exact text when the 200-reply daily cap is hit.
    // We scan document.body.textContent after each submit; on match we stop the
    // loop, beep, and show an alert popup.

    const DAILY_LIMIT_TEXT =
        "В течение 24 часов можно совершить не более 200 откликов";

    const isDailyLimitHit = () => document.body.textContent.includes(DAILY_LIMIT_TEXT);

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
        } catch (_) { /* AudioContext blocked — silent fallback */ }
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
        const overlay = _overlay(() => overlay.remove());

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
        box.querySelector("#as-limit-ok").onclick = () => overlay.remove();
    };

    // Newest-first list. Live panel shows [HH:MM:SS] msg; copy adds [unix:N].
    // renderLog() is RAF-debounced and only appends new entries (not a full
    // rebuild) — see _lastRenderedCount below. Skipped while panel is hidden.

    const MAX_LOG_LINES = 120;
    let logLines           = [];
    let _renderPending     = false;
    let _lastRenderedCount = 0; // how many logLines entries are already in the DOM

    const log = (msg) => {
        const u = Date.now(), t = new Date(u).toLocaleTimeString();
        console.log(`[${BRAND}] ${msg}`);
        logLines.unshift({ t, u, m: msg });
        if (logLines.length > MAX_LOG_LINES) logLines.pop();
        if (!_renderPending) {
            _renderPending = true;
            requestAnimationFrame(() => { _renderPending = false; renderLog(); });
        }
    };

    const renderLog = () => {
        const el = elCache.log;
        if (!el || el.style.display === "none") return;

        const newCount = logLines.length - _lastRenderedCount;

        // Full rebuild: first render, after clearSession (newCount < 0), or empty div
        if (newCount < 0 || el.childElementCount === 0) {
            el.innerHTML = "";
            _lastRenderedCount = 0;
        }

        const toRender = logLines.length - _lastRenderedCount;
        if (toRender <= 0) return;

        // Prepend only the new entries as individual <div> nodes.
        // logLines[0] is newest — prepend in that order so newest lands at top.
        // Cost: O(toRender) not O(120) — typically 1-6 nodes per vacancy.
        const frag = document.createDocumentFragment();
        for (let i = 0; i < toRender; i++) {
            const l = logLines[i];
            const d = document.createElement("div");
            d.innerHTML = `<span style="color:#5b9bd5">[${l.t}]</span> ${escHtml(l.m)}`;
            frag.appendChild(d);
        }
        el.prepend(frag);
        _lastRenderedCount = logLines.length;

        // Trim oldest entries from the bottom to stay within MAX_LOG_LINES
        while (el.childElementCount > MAX_LOG_LINES) el.lastElementChild.remove();

        el.scrollTop = 0; // keep newest entry at top
    };

    const escHtml = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const copyLog = () =>
        navigator.clipboard.writeText(
            logLines.map(l => `[${l.t}] [unix:${l.u}] ${l.m}`).join("\n")
        ).then(() => log("📋 Log copied")).catch(() => log("⚠️ Copy failed"));

    const logApplication = (id, title, cover) =>
        log(`📨 ОТКЛИК  id:${id ?? "?"}  "${title}"  — ${
            cover === "(no cover)"
                ? "🚫 без письма"
                : `✉️ с письмом: "${cover.replace(/\n/g, " ").slice(0, 60)}…"`
        }`);

    // hot paths (updateCounters, renderLog, toggleSending, maybeAutoResume).

    const elCache = {
        log:       null,
        toggleBtn: null,
        sentEl:    null,
        complexEl: null,
        totalEl:   null,
    };

    const updateCounters = () => {
        if (elCache.sentEl)    elCache.sentEl.textContent    = successCount;
        if (elCache.complexEl) elCache.complexEl.textContent = complexCount;
        if (elCache.totalEl)   elCache.totalEl.textContent   = processedIds.size;
        // Keep the mini-status label current when the panel is collapsed
        if (elCache._refreshMini) elCache._refreshMini();
    };

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

    // Marks processed vacancy cards: green="applied", grey="skipped", faint="seen"
    // (touched but no submit fired). Re-applied on each vacancy and via the
    // MutationObserver below for lazy-loaded cards.

    const _injectVisitedCSS = () => {
        if (document.getElementById("as-visited-css")) return;
        const s = document.createElement("style");
        s.id = "as-visited-css";
        s.textContent = `
            .as-visited-badge {
                position: absolute;
                top: 8px; right: 10px;
                font-size: 10px; font-weight: 700;
                padding: 2px 7px; border-radius: 20px;
                font-family: system-ui, sans-serif;
                pointer-events: none; z-index: 9999;
                white-space: nowrap; line-height: 1.6;
            }
            .as-visited-badge.applied {
                background: #27ae60; color: #fff;
            }
            .as-visited-badge.skipped {
                background: #868e96; color: #fff;
            }
        `;
        document.head.appendChild(s);
    };

    let _visitedPending = false;
    const applyVisitedStyles = (root = document) => {
        if (_visitedPending || processedIds.size === 0) return;
        _visitedPending = true;
        requestAnimationFrame(() => {
            _visitedPending = false;
            const skipped = _getSkippedSet();

            // Try both known card selectors — hh.ru changes markup periodically.
            // root defaults to document but the MutationObserver passes its own
            // container so we don't re-scan the entire page on every micro-mutation.
            const cards = root.querySelectorAll(
                '[data-qa="vacancy-serp__vacancy"], [class*="serp-item"][class*="vacancy"]'
            );

            cards.forEach(card => {
                const link = card.querySelector('[data-qa="serp-item__title"]') ||
                             card.querySelector('a[href*="/vacancy/"]');
                const m = link?.href?.match(VACANCY_ID_RE);
                if (!m) return;

                const vid = m[1];

                // Gate first: most cards on any given page are untouched, so
                // this single Set lookup rejects them before we do any further
                // membership checks below.
                if (!processedIds.has(vid)) return;

                const isApp  = appliedIds.has(vid);
                const isSkip = skipped.has(vid);

                // Three visual states:
                //   applied — submitBtn actually clicked       → green outline + badge
                //   skipped — complex job, navigated away      → grey outline + badge
                //   seen    — processed but no submit fired    → faint tint, no badge
                const status = isApp ? "applied" : isSkip ? "skipped" : "seen";
                if (card.dataset.hhb === status) return;
                card.dataset.hhb = status;

                const bg     = isApp  ? "rgba(39,174,96,0.13)"
                             : isSkip ? "rgba(108,117,125,0.11)"
                             :          "rgba(0,0,0,0.04)";
                const border = isApp  ? "2px solid rgba(39,174,96,0.65)"
                             : isSkip ? "2px solid rgba(108,117,125,0.45)"
                             :          "none";

                // Build the full inline declaration once, append in a single write.
                // Four separate setProperty() calls each trigger their own style
                // mutation; cssText += does it in one operation per element.
                const decl = `background-color:${bg}!important;` +
                             (border !== "none" ? `outline:${border}!important;` : "") +
                             `outline-offset:-2px!important;position:relative!important;`;
                const paint = el => { el.style.cssText += decl; };
                paint(card);
                card.querySelectorAll(":scope > div, :scope > div > div").forEach(paint);

                // Badge — only for applied/skipped, not for "seen".
                // Positioned bottom-left to avoid hh.ru's ♡ button (top-right).
                card.querySelector(".as-visited-badge")?.remove();
                if (isApp || isSkip) {
                    const badge       = document.createElement("div");
                    badge.className   = `as-visited-badge ${status}`;
                    badge.textContent = isApp ? "✓ Отклик" : "⏩ Пропущено";
                    badge.style.cssText = "position:absolute;bottom:10px;left:10px;" +
                                          "z-index:9999;pointer-events:none;";
                    const host = card.querySelector('[class*="vacancy-card"], :scope > div') || card;
                    host.style.setProperty("position", "relative", "important");
                    host.appendChild(badge);
                }
            });
        });
    };

    // Throttled MutationObserver — subtree:true catches lazy-loaded cards anywhere
    // in the list; throttle prevents RAF-storm on hh.ru's frequent micro-mutations
    let _visitedObserver = null;
    let _visitedThrottle = null;
    const setupVisitedObserver = () => {
        if (_visitedObserver) return;
        const target =
            document.querySelector('[data-qa="vacancy-serp-list"]') ||
            document.querySelector('[class*="serp"]') ||
            document.body;
        _visitedObserver = new MutationObserver(() => {
            if (_visitedThrottle) return;
            _visitedThrottle = setTimeout(() => {
                _visitedThrottle = null;
                // Scope to `target` — avoids re-querying the entire document
                // when new cards only ever appear inside this container.
                applyVisitedStyles(target);
            }, 400);
        });
        _visitedObserver.observe(target, { childList: true, subtree: true });
    };

    // Selectors confirmed from live hh.ru HTML (May 2025):
    //   Card root : [data-qa="vacancy-serp__vacancy"]
    //   Title link: [data-qa="serp-item__title"]      href="/vacancy/<ID>?…"
    //   Title text: [data-qa="serp-item__title-text"] (span inside title link)
    //   NOTE: data-vacancy-id attribute does NOT exist on hh.ru search cards.

    // (VACANCY_ID_RE hoisted to top-of-script — see near BRAND/VERSION)

    // Returns the numeric vacancy ID string, or null if all strategies fail.
    // null means we cannot deduplicate this button — the redirect-URL fallback
    // (getVacancyIdFromUrl) is the safety net for the endless-loop prevention.
    const getVacancyIdFromBtn = (btn) => {
        const card = btn.closest('[data-qa="vacancy-serp__vacancy"]');
        if (card) {
            const m  = card.querySelector('[data-qa="serp-item__title"]')
                          ?.href?.match(VACANCY_ID_RE);
            if (m) return m[1];
            const m2 = card.querySelector('a[href*="/vacancy/"]')
                           ?.href?.match(VACANCY_ID_RE);
            if (m2) return m2[1];
        }
        for (const wrap of [btn.closest("article"), btn.closest("li")]) {
            const m = wrap?.querySelector('a[href*="/vacancy/"]')
                         ?.href?.match(VACANCY_ID_RE);
            if (m) return m[1];
        }
        const m3 = (btn.getAttribute("href") || btn.getAttribute("data-url") || "")
                   .match(VACANCY_ID_RE);
        if (m3) return m3[1];

        // All strategies failed — log enough context to update selectors
        log(`⚠️ getVacancyIdFromBtn: ID not found`);
        log(`   data-qa="${btn.getAttribute("data-qa")}" ` +
            `href="${btn.getAttribute("href")?.slice(0, 60) ?? "none"}"`);
        log(`   card found: ${!!card}  ` +
            `title-link: ${!!card?.querySelector('[data-qa="serp-item__title"]')}`);
        return null;
    };

    const getJobTitleFromCard = (btn) => {
        const card = btn.closest('[data-qa="vacancy-serp__vacancy"]');
        if (!card) {
            log(`⚠️ getJobTitleFromCard: no card root found — selector may have changed`);
            return null;
        }
        const title =
            card.querySelector('[data-qa="serp-item__title-text"]')?.innerText?.trim() ||
            card.querySelector('[data-qa="serp-item__title"]')?.innerText?.trim() ||
            null;
        if (!title) {
            log(`⚠️ getJobTitleFromCard: title selectors returned nothing`);
            log(`   selectors present: title-text=${
                !!card.querySelector('[data-qa="serp-item__title-text"]')
            } title=${!!card.querySelector('[data-qa="serp-item__title"]')}`);
        }
        return title;
    };

    const getVacancyIdFromUrl = (url) => {
        try {
            const id = new URL(url).searchParams.get("vacancyId");
            if (!id) dbg(`getVacancyIdFromUrl: no vacancyId param in "${url.slice(0,80)}"`);
            return id;
        } catch (e) {
            log(`⚠️ getVacancyIdFromUrl parse error: ${e.message} (url: "${url?.slice(0,60)}")`);
            return null;
        }
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

    // Cached Set of skipped vacancy IDs — rebuilt only when complexJobs changes,
    // not on every applyVisitedStyles() call (which can be very frequent).
    let _skippedCache = null;
    const _getSkippedSet = () => {
        if (!_skippedCache)
            _skippedCache = new Set(complexJobs.map(j => j.id).filter(Boolean));
        return _skippedCache;
    };
    const _invalidateSkippedCache = () => { _skippedCache = null; };

    const pushComplexJob = (job) => {
        if (job.id && complexJobs.some(j => j.id === job.id)) return;
        complexJobs.unshift(job);
        if (complexJobs.length > 200) complexJobs.pop();
        _invalidateSkippedCache();
        gmSetMany({ complexJobs: JSON.stringify(complexJobs) });
    };

    const showComplexPopup = () => {
        const close = () => overlay.remove();
        const overlay = _overlay(close);

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

        closeBtn.onclick = close;

        copyBtn.onclick = () => {
            const text = complexJobs.map(j => `${j.title || j.id}\t${j.url || ""}`).join("\n");
            navigator.clipboard.writeText(text)
                .then(() => log("📋 Complex job links copied"))
                .catch(err => log(`⚠️ Copy failed: ${err.message}`));
        };

        clearBtn.onclick = () => {
            complexJobs   = [];
            complexCount  = 0;
            _invalidateSkippedCache();
            gmSetMany({ complexJobs: "[]" });
            persistState();
            updateCounters();
            renderList();
            titleSpan.textContent = "⏩ Skipped Jobs (0)";
            log("🗑 Skipped jobs list cleared");
        };
    };

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
                if (Date.now() > deadline) {
                    log(`⚠️ waitForBackNav: timed out after ${waitMs}ms — still on "${location.pathname}"`);
                    return resolve(false);
                }
                setTimeout(poll, 80);
            };
            setTimeout(poll, 80);
        });

    // Named showConfirm (not confirm) to avoid shadowing window.confirm.
    // Uses a custom modal because window.confirm is suppressed in some
    // cross-origin iframe contexts on modern browsers.
    const showConfirm = (message) => new Promise(resolve => {
        const close = v => { overlay.remove(); resolve(v); };
        const overlay = _overlay(() => close(false));

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
        box.querySelector("#conf-ok").onclick     = () => close(true);
        box.querySelector("#conf-cancel").onclick = () => close(false);
    });

    // Drag by the title bar; ↘️ button snaps back to default bottom-right corner.
    // Position is saved in GM under "panelPos" and restored on each page load.
    // mousemove listener uses {passive:true} — we never call preventDefault
    // inside it, so marking it passive lets the browser compositor run freely.

    // ── Theme ────────────────────────────────────────────────────────────────
    // Injected once on init; toggled by adding/removing class "as-dark" on
    // #as-panel. Using a class + a single <style> tag means zero overhead
    // during the processing loop — no listeners, no timers, no observers.
    // Inline styles on panel children are overridden via !important where
    // needed (the only correct way to beat inline specificity from CSS).

    const _injectThemeCSS = () => {
        if (document.getElementById("as-theme-css")) return;
        const s = document.createElement("style");
        s.id = "as-theme-css";
        s.textContent = `
            #as-panel.as-dark{background:#1e1e2e!important;border-color:#585b70!important}
            #as-panel.as-dark #as-drag-handle{border-bottom-color:#313244!important}
            #as-panel.as-dark #as-brand-span{color:#ffffff!important;font-weight:900!important}
            #as-panel.as-dark #as-reset-pos{border-color:#45475a!important;color:#a6adc8!important;background:none!important}
            #as-panel.as-dark #as-collapse-btn{border-color:#45475a!important}
            #as-panel.as-dark #as-settings-btn{background:#313244!important;color:#cdd6f4!important;border-color:#45475a!important}
            #as-panel.as-dark #as-clear-btn{background:#2d1016!important;color:#f38ba8!important;border-color:#5a2030!important}
            #as-panel.as-dark .as-cc{background:#181825!important;border-color:#313244!important;color:#cdd6f4!important}
            #as-panel.as-dark .as-cc b{color:#cdd6f4!important}
            #as-panel.as-dark #as-complex-cell{background:#2a2000!important;border-color:#5c4a00!important}
            #as-panel.as-dark #as-complex-cell:hover{background:#3a3000!important}
            #as-panel.as-dark #as-log-header{color:#a6adc8!important}
            #as-panel.as-dark #as-copy-btn{background:#313244!important;color:#cdd6f4!important;border-color:#45475a!important}
            #as-panel.as-dark #as-mini-status{color:#cdd6f4!important}
            #as-complex-cell:hover{background:#ffe69c!important}
            #as-settings-btn:hover{background:#e0e0e0!important}
            #as-clear-btn:hover{background:#ffe0e0!important}

            /* ── Settings dialog ── */
            #as-settings-dlg.as-dark{background:#1e1e2e!important;color:#cdd6f4!important}
            /* header and footer borders */
            #as-settings-dlg.as-dark>div{border-color:#313244!important;background:#1e1e2e!important}
            /* h2, labels, bold text that carry no inline color */
            #as-settings-dlg.as-dark h2,
            #as-settings-dlg.as-dark label,
            #as-settings-dlg.as-dark b{color:#cdd6f4!important}
            /* inline-colored hint/subtext — mapped by original hex value */
            #as-settings-dlg.as-dark [style*="color:#333"]{color:#cdd6f4!important}
            #as-settings-dlg.as-dark [style*="color:#444"]{color:#bac2de!important}
            #as-settings-dlg.as-dark [style*="color:#555"]{color:#a6adc8!important}
            #as-settings-dlg.as-dark [style*="color:#888"]{color:#7f849c!important}
            #as-settings-dlg.as-dark [style*="color:#999"]{color:#6c7086!important}
            #as-settings-dlg.as-dark [style*="color:#aaa"]{color:#6c7086!important}
            /* keep error/warning colours legible on dark */
            #as-settings-dlg.as-dark [style*="color:#d9534f"]{color:#f38ba8!important}
            #as-settings-dlg.as-dark [style*="color:#c0392b"]{color:#f38ba8!important}
            /* inputs, selects, textareas */
            #as-settings-dlg.as-dark input,
            #as-settings-dlg.as-dark select,
            #as-settings-dlg.as-dark textarea{background:#313244!important;color:#cdd6f4!important;border-color:#45475a!important}
            /* all buttons except orange Save and theme toggle */
            #as-settings-dlg.as-dark button:not(#as-save-set):not(#as-theme-btn){background:#313244!important;color:#cdd6f4!important;border-color:#45475a!important}
            /* template <details> summary rows */
            #as-settings-dlg.as-dark summary{background:#252535!important;color:#cdd6f4!important;border-color:#45475a!important}
            /* template label spans inside summary — set explicitly so rebuildActiveSelector color changes don't cause low-contrast on dark */
            #as-settings-dlg.as-dark summary span{color:#cdd6f4!important}
            /* resume rows */
            #as-settings-dlg.as-dark [data-resume-row]{background:#252535!important;border-color:#45475a!important;color:#cdd6f4!important}
            /* rand delay section container */
            #as-settings-dlg.as-dark [style*="background:#f8f8f8"]{background:#252535!important;border-color:#45475a!important}
            /* template row background */
            #as-settings-dlg.as-dark [style*="background:#f9f9f9"],
            #as-settings-dlg.as-dark [style*="background:#fafafa"]{background:#252535!important}
        `;
        document.head.appendChild(s);
    };

    // Applies or removes dark theme. Called once on panel creation (restore
    // saved preference) and on toggle button click (immediate visual feedback).
    const applyTheme = (dark) => {
        document.getElementById("as-panel")?.classList.toggle("as-dark", dark);
        document.getElementById("as-settings-dlg")?.classList.toggle("as-dark", dark);
        config.DARK_THEME = dark;
        gmSetMany({ darkTheme: dark });
        dbg(`theme → ${dark ? "dark" : "light"}`);
    };

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
            } catch (_) { /* malformed — keep default bottom-right */ }
        }

        let dragging = false, ox = 0, oy = 0;

        handle.addEventListener("mousedown", (e) => {
            // Don't start drag when clicking either window-control button
            const collapseBtn = document.getElementById("as-collapse-btn");
            if (e.target === resetBtn   || resetBtn.contains(e.target))   return;
            if (collapseBtn && (e.target === collapseBtn || collapseBtn.contains(e.target))) return;
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
            gmSetMany({ panelPos: JSON.stringify({ left: panel.style.left, top: panel.style.top }) });
        });

        resetBtn.addEventListener("click", () => {
            panel.style.left = "auto"; panel.style.top    = "auto";
            panel.style.right = "20px"; panel.style.bottom = "20px";
            gmSetMany({ panelPos: "" });
            log("📌 Panel position reset to bottom-right");
        });
    };

    // Wires the (−) collapse button: hides #as-panel-body, shows the mini
    // status counter in the title bar, and shrinks panel width. State
    // persisted in GM storage so it survives reloads.

    const setupWindowControls = (panel) => {
        const collapseBtn = document.getElementById("as-collapse-btn");
        const panelBody   = document.getElementById("as-panel-body");
        const miniStatus  = document.getElementById("as-mini-status");
        const dragHandle  = document.getElementById("as-drag-handle");
        if (!collapseBtn || !panelBody) return;

        let collapsed = GM_getValue("panelCollapsed", false);

        // applyCollapsed centralises every DOM mutation needed for a state change.
        // Called once on init (no animation) and on every button click.
        const applyCollapsed = (c) => {
            collapsed = c;
            if (c) {
                // ── Minimised ─────────────────────────────────────────────
                panelBody.style.display             = "none";
                collapseBtn.textContent             = "+";
                collapseBtn.title                   = "Restore panel";
                collapseBtn.style.background        = "#34c759"; // green = "restore"
                collapseBtn.style.borderColor       = "#2aa648";
                collapseBtn.style.color             = "#0a4020";
                if (miniStatus) miniStatus.style.display = "inline";
                if (dragHandle) {
                    dragHandle.style.borderBottom   = "none";
                    dragHandle.style.marginBottom   = "0";
                    dragHandle.style.paddingBottom  = "0";
                }
                panel.style.minWidth                = "auto";
                panel.style.padding                 = "10px 16px";
            } else {
                // ── Expanded ──────────────────────────────────────────────
                panelBody.style.display             = "block";
                collapseBtn.textContent             = "−";
                collapseBtn.title                   = "Minimize panel";
                collapseBtn.style.background        = "#ffd60a"; // yellow = "minimise"
                collapseBtn.style.borderColor       = "#e6bc00";
                collapseBtn.style.color             = "#7a5f00";
                if (miniStatus) miniStatus.style.display = "none";
                if (dragHandle) {
                    dragHandle.style.borderBottom   = "1px solid #ececec";
                    dragHandle.style.marginBottom   = "10px";
                    dragHandle.style.paddingBottom  = "8px";
                }
                panel.style.minWidth                = "360px";
                panel.style.padding                 = "16px";
            }
            gmSetMany({ panelCollapsed: collapsed });
        };

        // Expose a refresh helper for updateCounters so the mini label stays current
        elCache._refreshMini = () => {
            if (miniStatus && collapsed) {
                miniStatus.textContent = ` · ${successCount}✅`;
            }
        };

        // Restore persisted state on page load (no GM write needed, already saved)
        applyCollapsed(collapsed);
        elCache._refreshMini();

        collapseBtn.addEventListener("click", (e) => {
            e.stopPropagation(); // prevent the drag mousedown from also firing
            applyCollapsed(!collapsed);
            elCache._refreshMini();
        });
    };

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
            <!-- Title bar ───────────────────────────────────────────────── -->
            <!-- Drag target. Contains status dot, brand name, window buttons. -->
            <div id="as-drag-handle"
                style="display:flex;align-items:center;justify-content:space-between;
                cursor:grab;user-select:none;padding-bottom:8px;margin-bottom:10px;
                border-bottom:1px solid #ececec;">

                <!-- Left: status dot + brand -->
                <div style="display:flex;align-items:center;gap:7px;min-width:0;">
                    <!-- Running indicator: green = running, grey = idle.
                         Visible in both expanded and collapsed states.  -->
                    <span id="as-status-dot"
                        style="width:9px;height:9px;border-radius:50%;flex-shrink:0;
                        background:${isRunning ? "#27ae60" : "#bbb"};
                        box-shadow:${isRunning ? "0 0 0 2px rgba(39,174,96,.25)" : "none"};
                        transition:background .3s,box-shadow .3s;">
                    </span>
                    <span id="as-brand-span" style="font-size:15px;font-weight:bold;color:#333;white-space:nowrap;">
                        ⠿ ${BRAND} v${VERSION}
                    </span>
                    <!-- Mini sent counter: only visible when panel is collapsed -->
                    <span id="as-mini-status"
                        style="display:none;font-size:12px;color:#666;white-space:nowrap;">
                        · ${successCount}✅
                    </span>
                </div>

                <!-- Right: window management buttons -->
                <div style="display:flex;align-items:center;gap:3px;flex-shrink:0;margin-left:8px;">
                    <!-- Minimize/restore ─────────────────────────────────── -->
                    <button id="as-collapse-btn"
                        title="Minimize panel"
                        style="background:#ffd60a;border:1px solid #e6bc00;border-radius:50%;
                        width:14px;height:14px;cursor:pointer;font-size:9px;color:#7a5f00;
                        padding:0;line-height:14px;display:flex;align-items:center;
                        justify-content:center;font-weight:bold;flex-shrink:0;">
                        −
                    </button>
                    <!-- Snap to corner ───────────────────────────────────── -->
                    <button id="as-reset-pos"
                        title="Snap panel to bottom-right corner"
                        style="background:#34c759;border:1px solid #2aa648;border-radius:50%;
                        width:14px;height:14px;cursor:pointer;font-size:8px;color:#0a4020;
                        padding:0;line-height:14px;display:flex;align-items:center;
                        justify-content:center;font-weight:bold;flex-shrink:0;">
                        ↘
                    </button>
                </div>
            </div>

            <!-- Panel body ───────────────────────────────────────────────── -->
            <!-- Hidden when minimized. All content below the title bar lives here. -->
            <div id="as-panel-body">

                <!-- Action buttons ───────────────────────────────────────── -->
                <button id="as-toggle-btn"
                    style="width:100%;padding:14px;background:${btnBg};color:#fff;border:none;
                    border-radius:8px;font-size:15px;font-weight:bold;cursor:pointer;
                    margin-bottom:8px;">${btnTxt}
                </button>

                <div style="display:flex;gap:6px;margin-bottom:14px;">
                    <button id="as-settings-btn"
                        style="flex:1;padding:9px;background:#f0f0f0;color:#333;
                        border:1px solid #ccc;border-radius:8px;cursor:pointer;font-size:13px;">
                        ⚙️ Settings
                    </button>
                    <button id="as-clear-btn"
                        style="flex:1;padding:9px;background:#fff0f0;color:#d9534f;
                        border:1px solid #f5c6c6;border-radius:8px;cursor:pointer;font-size:13px;">
                        🗑 Clear
                    </button>
                </div>

                <!-- Counters ────────────────────────────────────────────── -->
                <div style="margin-bottom:14px;font-size:13px;color:#444;
                    display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;text-align:center;">
                    <div class="as-cc" style="background:#f0fff4;border:1px solid #c3e6cb;
                        border-radius:6px;padding:6px 4px;">
                        ✅ Sent<br><b id="as-sent">${successCount}</b>
                    </div>
                    <div id="as-complex-cell" class="as-cc"
                        style="background:#fff3cd;border:1px solid #ffc107;border-radius:6px;
                        padding:6px 4px;cursor:pointer;transition:background .15s;"
                        title="Click to view skipped jobs">
                        ⏩ Skipped
                        <span style="font-size:10px;color:#999;vertical-align:super;"
                            title="Jobs requiring a full form — skipped automatically.">?</span>
                        <br><b id="as-complex">${complexCount}</b>
                    </div>
                    <div class="as-cc" style="background:#e8f4fd;border:1px solid #bee5eb;
                        border-radius:6px;padding:6px 4px;">
                        🔖 Seen<br><b id="as-total">${processedIds.size}</b>
                    </div>
                </div>

                <!-- Live log ────────────────────────────────────────────── -->
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
                </div>

            </div><!-- /#as-panel-body -->`;

        document.body.appendChild(panel);

        // Populate element cache immediately after panel is in the DOM.
        elCache.log         = document.getElementById("as-log");
        elCache.toggleBtn   = document.getElementById("as-toggle-btn");
        elCache.sentEl      = document.getElementById("as-sent");
        elCache.complexEl   = document.getElementById("as-complex");
        elCache.totalEl     = document.getElementById("as-total");
        elCache.statusDot   = document.getElementById("as-status-dot");
        elCache.miniStatus  = document.getElementById("as-mini-status");
        elCache.panelBody   = document.getElementById("as-panel-body");

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
                "• Skipped count & list\n" +
                "• Processed vacancy ID list\n" +
                "• All log entries\n\n" +
                "These are NOT reset:\n" +
                "• Resumes (IDs + labels)\n" +
                "• Delay, cover letter templates\n" +
                "• Panel position\n\n" +
                "To remove resumes or templates: open Settings.\n\nContinue?"
            );
            if (!yes) return;

            const wasRunning = isRunning;
            if (wasRunning) isRunning = false; // stop loop before wiping state
            stopTabIndicator();
            clearSession();                    // resets all session vars + logLines
            updateCounters();
        if (!_renderPending) {
            _renderPending = true;
            requestAnimationFrame(() => { _renderPending = false; renderLog(); });
        }

            if (wasRunning) {
                elCache.toggleBtn.textContent      = "▶️ START SENDING";
                elCache.toggleBtn.style.background = "#ee7f2d";
            }
            elCache.log.style.display = "block"; // open log so message is visible
            log("✅ Session cleared. Settings and panel position kept.");
        };

        setupDrag(panel);
        setupWindowControls(panel);
        // Restore theme preference — runs once on page load, zero ongoing cost.
        applyTheme(config.DARK_THEME);
        updateCounters();
        renderLog(); // replay any log lines emitted before the panel existed
    };

    const toggleSending = () => {
        isRunning = !isRunning;

        if (isRunning) {
            // Auto-expand so the user can see the log and stop button
            const collapseBtn = document.getElementById("as-collapse-btn");
            if (collapseBtn && collapseBtn.textContent.trim() === "+") {
                collapseBtn.click(); // restore via the same handler (persists state too)
            }

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

    // Fetches the resume's <title> from hh.ru (same-origin, credentials:include
    // — user is already logged in) and takes the text before the first " — ".
    // Returns "" on any failure; caller keeps the user-typed label in that case.
    const fetchResumeTitle = async (id) => {
        if (!id) return "";
        try {
            const res = await fetch(`https://hh.ru/resume/${id}`, {
                credentials: "include",
                cache:       "no-store",
            });
            if (!res.ok) {
                log(`⚠️ fetchResumeTitle: HTTP ${res.status} for id "${id.slice(0,12)}…"`);
                if (res.status === 403) log("   → not logged in to hh.ru");
                if (res.status === 404) log("   → resume not found or private");
                return "";
            }
            const html = await res.text();
            const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
            if (!m) {
                log("⚠️ fetchResumeTitle: no <title> found — hh.ru markup may have changed");
                return "";
            }
            const raw   = m[1].replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").trim();
            const label = raw.split(/\s+—\s+/)[0]?.trim() || raw.slice(0, 60);
            log(`✅ fetchResumeTitle: "${label}"`);
            return label;
        } catch (err) {
            log(`❌ fetchResumeTitle: ${err.message}`);
            return "";
        }
    };

    // Renders editResumes[] as rows: radio | ID input | label | 🗑.
    // Label is not auto-fetched here (only on Save, to keep dialog snappy).
    // Delete disabled at 1 resume; Add disabled at 5.
    const buildResumeList = (container, editResumes, getActive, setActive) => {
        container.innerHTML = "";

        if (editResumes.length === 0) {
            container.innerHTML =
                '<div style="font-size:12px;color:#aaa;padding:8px 0;">No resumes added yet. Click + Add.</div>';
            return;
        }

        editResumes.forEach((r, i) => {
            const row = document.createElement("div");
            row.style.cssText =
                "display:flex;align-items:center;gap:8px;padding:7px 10px;" +
                "border:1px solid #e0e0e0;border-radius:6px;margin-bottom:6px;" +
                "background:" + (i === getActive() ? "#fffaf5" : "#fff") + ";";

            // ── Radio ──────────────────────────────────────────────────────
            const radio = Object.assign(document.createElement("input"), {
                type:    "radio",
                name:    "as-resume-radio",
                checked: i === getActive(),
            });
            radio.style.cssText = "flex-shrink:0;width:15px;height:15px;cursor:pointer;accent-color:#ee7f2d;";
            radio.addEventListener("change", () => {
                setActive(i);
                // Refresh row backgrounds
                container.querySelectorAll("div[data-resume-row]").forEach((rw, j) => {
                    rw.style.background = j === getActive() ? "#fffaf5" : "#fff";
                });
            });

            // ── Fields container ───────────────────────────────────────────
            const fields = document.createElement("div");
            fields.style.cssText = "flex:1;display:flex;flex-direction:column;gap:4px;min-width:0;";

            const idInp = Object.assign(document.createElement("input"), {
                value:       r.id,
                placeholder: "Resume ID (from hh.ru/resume/…)",
                maxLength:   80,
            });
            idInp.style.cssText =
                "width:100%;padding:5px 7px;border:1px solid #ccc;border-radius:4px;" +
                "font-size:12px;font-family:monospace;box-sizing:border-box;";
            idInp.addEventListener("input", () => { r.id = idInp.value.trim(); });

            const labelInp = Object.assign(document.createElement("input"), {
                value:       r.label,
                placeholder: "Label (auto-filled on Save)",
                maxLength:   80,
            });
            labelInp.style.cssText =
                "width:100%;padding:5px 7px;border:1px solid #ddd;border-radius:4px;" +
                "font-size:11px;color:#666;box-sizing:border-box;background:#fafafa;";
            labelInp.addEventListener("input", () => { r.label = labelInp.value; });
            // Store ref on row so Save can update it after fetch
            row._labelInp = labelInp;

            fields.append(idInp, labelInp);

            // ── Delete ─────────────────────────────────────────────────────
            const delBtn = document.createElement("button");
            delBtn.textContent  = "🗑";
            delBtn.title        = "Remove this resume";
            delBtn.disabled     = editResumes.length <= 1;
            delBtn.style.cssText =
                "background:none;border:none;cursor:pointer;font-size:15px;" +
                "color:#d9534f;padding:0;flex-shrink:0;line-height:1;" +
                (editResumes.length <= 1 ? "opacity:.3;" : "");
            delBtn.addEventListener("click", () => {
                editResumes.splice(i, 1);
                if (getActive() >= editResumes.length) setActive(Math.max(0, editResumes.length - 1));
                buildResumeList(container, editResumes, getActive, setActive);
                // Refresh add-button state
                const dlg = container.closest("#as-settings-dlg");
                const addBtn = dlg?.querySelector("#as-add-resume");
                if (addBtn) {
                    addBtn.disabled      = editResumes.length >= 5;
                    addBtn.style.opacity = editResumes.length >= 5 ? "0.4" : "1";
                }
            });

            row.setAttribute("data-resume-row", i);
            row.append(radio, fields, delBtn);
            container.appendChild(row);
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
        if (config.DARK_THEME) dialog.classList.add("as-dark");

        // ── Header ──────────────────────────────────────────────────────────
        const hdr = document.createElement("div");
        hdr.style.cssText = "padding:20px 24px 12px;border-bottom:1px solid #eee;flex-shrink:0;";
        hdr.innerHTML = `<h2 style="margin:0;font-size:17px;">⚙️ Settings</h2>`;

        // ── Scrollable body ──────────────────────────────────────────────────
        const bodyEl = document.createElement("div");
        bodyEl.style.cssText = "padding:16px 24px;overflow-y:auto;flex:1;";
        bodyEl.innerHTML = `
            <!-- ── Resumes ──────────────────────────────────────────────────── -->
            <div style="display:flex;justify-content:space-between;align-items:center;
                margin-bottom:4px;">
                <label style="font-size:13px;font-weight:bold;">Resumes</label>
                <button id="as-add-resume"
                    style="padding:3px 10px;background:#ee7f2d;color:white;border:none;
                    border-radius:4px;cursor:pointer;font-size:12px;font-weight:bold;">
                    + Add
                </button>
            </div>
            <div style="font-size:11px;color:#888;margin-bottom:8px;line-height:1.5;">
                Up to 5 resumes. Select the active one with the radio button.<br>
                ID = the long code in your resume URL:
                <span style="font-family:monospace;color:#555;">
                    hh.ru/resume/<b>ab12cd34ef56…</b>
                </span><br>
                Label is fetched automatically from hh.ru when you save (requires login).
                <span style="color:#c0392b;font-weight:bold;">
                    ⚠ Resumes survive "Clear session".
                </span>
            </div>
            <div id="as-resume-list" style="margin-bottom:16px;"></div>

            <div id="as-delay-section" style="display:${config.RAND_ENABLED ? "none" : "block"}">
                <label style="font-size:13px;font-weight:bold;">Delay between responses (ms)</label>
                <div style="font-size:11px;color:#888;margin:3px 0 6px;">
                    Min 1500 ms recommended. Lower = faster but higher bot-detection risk.
                </div>
                <input id="as-delay-inp" type="number" value="${config.DELAY_MS}"
                    min="1500" max="15000"
                    style="width:100%;padding:8px;margin-bottom:16px;border:1px solid #ccc;
                    border-radius:6px;box-sizing:border-box;font-size:13px;">
            </div>

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
            <button id="as-theme-btn"
                style="padding:12px 14px;background:#f0f0f0;border:1px solid #ccc;
                border-radius:6px;cursor:pointer;font-size:14px;white-space:nowrap;"
                title="Toggle dark / light theme">
                ${config.DARK_THEME ? "☀️" : "🌙"}
            </button>
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

        // Theme toggle — takes effect immediately, independent of Save/Cancel.
        dialog.querySelector("#as-theme-btn").onclick = function() {
            const dark = !config.DARK_THEME;
            applyTheme(dark);
            this.textContent = dark ? "☀️" : "🌙";
        };

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

        // ── Resume list ──────────────────────────────────────────────────────
        // Working copy: shallow-copy objects so Cancel truly discards changes.
        const editResumes = config.RESUMES.map(r => ({ ...r }));
        let   editActiveIdx = Math.min(config.ACTIVE_RESUME_IDX, Math.max(0, editResumes.length - 1));
        const getActive = () => editActiveIdx;
        const setActive = v  => { editActiveIdx = v; };

        const resumeListEl = dialog.querySelector("#as-resume-list");
        buildResumeList(resumeListEl, editResumes, getActive, setActive);

        const addResumeBtn = dialog.querySelector("#as-add-resume");
        const refreshAddResumeBtn = () => {
            addResumeBtn.disabled      = editResumes.length >= 5;
            addResumeBtn.style.opacity = editResumes.length >= 5 ? "0.4" : "1";
        };
        refreshAddResumeBtn();

        addResumeBtn.addEventListener("click", () => {
            if (editResumes.length >= 5) return;
            editResumes.push({ id: "", label: "" });
            buildResumeList(resumeListEl, editResumes, getActive, setActive);
            refreshAddResumeBtn();
            // Focus the new ID input so the user can paste immediately
            const inputs = resumeListEl.querySelectorAll("input[placeholder*='Resume ID']");
            inputs[inputs.length - 1]?.focus();
        });

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
        const randChk      = dialog.querySelector("#as-rand-chk");
        const randFields   = dialog.querySelector("#as-rand-fields");
        const delaySection = dialog.querySelector("#as-delay-section");
        const randErr      = dialog.querySelector("#as-rand-err");

        randChk.addEventListener("change", () => {
            const on = randChk.checked;
            delaySection.style.display = on ? "none" : "block";
            randFields.style.display   = on ? "flex"  : "none";
            if (randErr) randErr.style.display = "none";
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

        dialog.querySelector("#as-save-set").onclick = async () => {
            const saveBtn = dialog.querySelector("#as-save-set");

            // ── Validate resumes ────────────────────────────────────────────
            const validResumes = editResumes.filter(r => r.id.trim());
            if (validResumes.length === 0) {
                let errEl = dialog.querySelector("#as-resume-err");
                if (!errEl) {
                    errEl = document.createElement("div");
                    errEl.id = "as-resume-err";
                    errEl.style.cssText =
                        "font-size:11px;color:#d9534f;margin-bottom:8px;" +
                        "padding:6px 8px;background:#fff0f0;border-radius:4px;";
                    resumeListEl.after(errEl);
                }
                errEl.textContent = "⚠ Add at least one resume ID before saving.";
                resumeListEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
                return;
            }

            const finalActiveIdx = Math.min(editActiveIdx, validResumes.length - 1);

            // Disable save button — re-enabled in finally block
            saveBtn.disabled    = true;
            saveBtn.textContent = "Saving…";
            saveBtn.style.opacity = "0.7";

            try {
                // ── Auto-fetch missing labels (best-effort, parallel) ───────
                await Promise.all(
                    validResumes.map(async (r, i) => {
                        if (r.label.trim()) return; // already labelled
                        const fetched = await fetchResumeTitle(r.id.trim());
                        if (fetched) {
                            r.label = fetched;
                            const rows = resumeListEl.querySelectorAll("div[data-resume-row]");
                            const rowEl = rows[i];
                            if (rowEl?._labelInp) rowEl._labelInp.value = fetched;
                        }
                    })
                );

                // Fixed delay — read even if the section is hidden (rand may be off next time)
                config.DELAY_MS = Math.max(
                    1500,
                    parseInt(dialog.querySelector("#as-delay-inp")?.value) || 3000
                );

                // ── Randomized delay ─────────────────────────────────────────
                const randEnabled = dialog.querySelector("#as-rand-chk").checked;
                const randErr     = dialog.querySelector("#as-rand-err");

                if (randEnabled) {
                    const rMin = parseInt(dialog.querySelector("#as-rand-min").value) || 0;
                    const rMax = parseInt(dialog.querySelector("#as-rand-max").value) || 0;
                    if (rMin < 100) {
                        randErr.textContent   = "Min delay must be at least 100 ms.";
                        randErr.style.display = "block";
                        return; // finally block re-enables button
                    }
                    if (rMax <= rMin) {
                        randErr.textContent   = "Max delay must be greater than min delay.";
                        randErr.style.display = "block";
                        return;
                    }
                    config.RAND_ENABLED = true;
                    config.RAND_MIN     = rMin;
                    config.RAND_MAX     = rMax;
                    config.DELAY_MS     = sampleDelay();
                    _responsesSinceRotation = 0;
                    _nextRotateAt           = _randInt(4, 7);
                } else {
                    config.RAND_ENABLED = false;
                }

                // ── Templates ────────────────────────────────────────────────
                const finalTpls = editTpls.map(t => t.trim()).filter(Boolean);
                coverTemplates  = finalTpls.length ? finalTpls : [...DEFAULT_TEMPLATES];
                config.TEMPLATE_ID = Math.min(editIdx, coverTemplates.length - 1);

                const tmplRandWanted = dialog.querySelector("#as-tmpl-rand-chk").checked;
                config.TMPL_RANDOM   = tmplRandWanted && coverTemplates.length >= 2;

                // ── Persist all to GM storage ────────────────────────────────
                config.RESUMES           = validResumes;
                config.ACTIVE_RESUME_IDX = finalActiveIdx;

                gmSetMany({
                    resumes:        JSON.stringify(validResumes),
                    activeResumeIdx: finalActiveIdx,
                    delayMs:         config.DELAY_MS,
                    templateId:      config.TEMPLATE_ID,
                    userTemplates:   JSON.stringify(coverTemplates),
                    randEnabled:     config.RAND_ENABLED,
                    randMin:         config.RAND_MIN,
                    randMax:         config.RAND_MAX,
                    tmplRandom:      config.TMPL_RANDOM,
                });

                // ── Success feedback ─────────────────────────────────────────
                saveBtn.textContent   = "✅ Saved!";
                saveBtn.style.background = "#27ae60";
                saveBtn.style.opacity    = "1";
                saveBtn.disabled         = false;

                // Build human-readable save summary for the log
                const activeResume = validResumes[finalActiveIdx];
                const resumeLabel  = activeResume.label || activeResume.id.slice(0, 14) + "…";
                const delayStr     = config.RAND_ENABLED
                    ? `random [${config.RAND_MIN}–${config.RAND_MAX}ms]`
                    : `${config.DELAY_MS}ms fixed`;
                const tmplStr      = config.TMPL_RANDOM
                    ? `random from ${coverTemplates.length}`
                    : `template #${config.TEMPLATE_ID + 1} of ${coverTemplates.length}`;

                log(`✅ Settings saved:`);
                log(`   resumes : ${validResumes.length} stored · active: "${resumeLabel}"`);
                log(`   delay   : ${delayStr}`);
                log(`   cover   : ${tmplStr}`);
                if (validResumes.length > 1) {
                    validResumes.forEach((r, i) => {
                        log(`   resume[${i}]: ${r.label || r.id.slice(0, 20)} ${i === finalActiveIdx ? "← active" : ""}`);
                    });
                }

                // Close dialog after a short moment so the user sees "✅ Saved!"
                setTimeout(() => { overlay.remove(); dialog.remove(); }, 900);

            } catch (err) {
                // Any unexpected error (network, DOM exception, etc.) lands here.
                // Log it, show it on the button, never leave the button stuck.
                console.error("[HH Boost] Settings save error:", err);
                log(`❌ Settings save failed: ${err.message}`);
                saveBtn.textContent      = "⚠ Error — retry";
                saveBtn.style.background = "#d9534f";
                saveBtn.style.opacity    = "1";
                saveBtn.disabled         = false;
            }
        };

        const closeDialog = () => { overlay.remove(); dialog.remove(); };
        dialog.querySelector("#as-cancel-set").onclick = closeDialog;
        overlay.addEventListener("click", e => { if (e.target === overlay) closeDialog(); });
    };

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
                    await sleep(_randInt(20, 70));

                    // scrollIntoView "instant" + short random settle (50–130 ms).
                    // "instant" skips the CSS scroll animation entirely — no waiting
                    // for a cosmetic effect the automated flow doesn't need.
                    btn.scrollIntoView({ behavior: "instant", block: "center" });
                    await sleep(_randInt(50, 130));

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

                        markProcessed(vid, urlVid);
                        applyVisitedStyles(); // immediately dim this card // null-safe
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
                            await sleep(_randInt(350, 600));
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
                    applyVisitedStyles(); // immediately green-tint this card

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
                        await sleep(_randInt(300, 500));

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
                            await sleep(_randInt(100, 200)); // brief settle after clear
                        }

                        const submitBtn =
                            document.querySelector('[data-qa*="submit"]') ||
                            document.querySelector('button[type="submit"]') ||
                            [...document.querySelectorAll("button")]
                                .find(b => /Отправить|Откликнуться/i.test(b.textContent));

                        if (submitBtn) {
                            await humanInteract(submitBtn);
                            successCount++;
                            if (vid) appliedIds.add(vid); // accurate badge tracking
                            logApplication(vid, jobTitle, isInvalid ? "(no cover)" : coverLetter);

                            // Check for daily 200-reply limit BEFORE persisting
                            // or sleeping — the error message appears immediately
                            // in the DOM after the failed submit attempt.
                            // Random wait 300–500ms: snappy but gives hh.ru time to render.
                            await sleep(_randInt(300, 500));
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
                await sleep(_randInt(500, 900));
            } // end while

        } catch (err) {
            log(`❌ LOOP ERROR: ${err.message}`);
            // Log up to 4 stack lines so the exact call site is visible in the panel
            (err.stack || "").split("\n").slice(1, 5).forEach(line => {
                const trimmed = line.trim();
                if (trimmed) log(`   ${trimmed}`);
            });
            log("🛑 Loop stopped — check log above, then press START to retry");
            stopTabIndicator();
        } finally {
            // Always release the guard so a new loop can start after an error.
            isProcessingActive = false;
        }
    };

    // Called on every page load. If isRunning=true in GM storage a
    // window.location.href navigation just occurred and we must resume.
    //
    // Design: no branch that sets isRunning=false.  Previous versions had one
    // and it permanently stopped the script on any canonical URL redirect.
    // We are permissive: resume on any hh.ru page that is not the complex-job
    // form itself. Everything is logged so failures are visible.

    const maybeAutoResume = () => {
        if (!isRunning) return;
        if (location.pathname.includes("/vacancy_response")) {
            log("⏳ On complex page — waiting for back-nav");
            return;
        }
        if (!location.hostname.includes("hh.ru")) return;

        log("♻️ Auto-resuming");
        if (elCache.toggleBtn) {
            elCache.toggleBtn.textContent      = "⏹️ STOP";
            elCache.toggleBtn.style.background = "#d9534f";
        }
        if (elCache.log) elCache.log.style.display = "block";
        startTabIndicator();
        startProcessing();
    };

    window.addEventListener("pageshow", (e) => {
        if (e.persisted && isRunning && !isProcessingActive) {
            log("♻️ Bfcache restore — resuming");
            startTabIndicator();
            startProcessing();
        }
    });

    // Multiple retries handle hh.ru's deferred React hydration that can push
    // body population past document-end.

    const init = () => {
        if (document.getElementById("as-panel")) return;
        const step = (name, fn) => {
            try { fn(); }
            catch (e) {
                // Always write to console — elCache.log may not exist yet
                console.error(`[${BRAND}] Init failed [${name}]:`, e);
                log(`❌ Init [${name}]: ${e.message}`);
            }
        };
        step("injectThemeCSS",   _injectThemeCSS);
        step("createPanel",      createPanel);
        step("injectVisitedCSS", _injectVisitedCSS);
        setTimeout(() => {
            step("applyVisitedStyles",   applyVisitedStyles);
            step("setupVisitedObserver", setupVisitedObserver);
        }, 1200);
        setTimeout(maybeAutoResume, 800);
    };

    setTimeout(init, 800);
    setTimeout(init, 2500);
    setTimeout(init, 5000);

    // Watch for panel removal — hh.ru's React will tear down body on SPA
    // navigation. Never disconnect: if the panel is removed after all timeouts
    // have run, this observer is the only thing that brings it back.
    const obs = new MutationObserver(() => {
        if (!document.getElementById("as-panel")) init();
    });
    obs.observe(document.body, { childList: true, subtree: false });

})();
