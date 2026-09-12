// ==UserScript==
// @name         Uber Eats Order → OpSpot Claims Auto-Fill
// @namespace    https://local.claims-ops
// @version      2.3.8
// @description  Read Uber Eats Manager orders/issues and fill OpSpot Claims (preset-driven Workhorse fills).
// @author       Claims Ops
// @match        https://merchants.ubereats.com/*
// @match        *://merchants.ubereats.com/*
// @match        https://opspot.workhorselive.com/*
// @match        https://opspot.workhorselive.com/sysTable.php*
// @match        *://opspot.workhorselive.com/*
// @match        *://*.workhorselive.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM.setValue
// @grant        GM.getValue
// @grant        GM_addValueChangeListener
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @run-at       document-end
// ==/UserScript==

/* ==== BEGIN INLINED SHARED (from claims-presets.js + claims-core.js) ==== */
/**
 * Claims presets — Workhorse field maps + Deliveroo / Uber Eats platform rules.
 * Edit this file to change OpSpot fill order, reason maps, outcome rules, or sheet tabs.
 * Inlined into platform userscripts by build-static.js.
 */
(function (root) {
  "use strict";

  const workhorse = {
    claimsFormUrl: "https://opspot.workhorselive.com/sysTable.php?sys_module_id=10000&sys_data_entity_id=10000",
    videoSubmitted: "No",
    disputeThresholdGbp: 2, // Partner refund ≤ this (£) → Outcome: Not disputed
    fastFill: true,
    modalCacheMs: 800,
    debug: false,
    preparedIncorrectlyOthersOption: "Others",
    reasonForDisputeOtherOption: "Other",
    foodSafetyComplaintLabel: "Food safety complaint",

    labels: {
      claimDate: "Claim Date",
      orderTime: "Order Time",
      customer: "Customer",
      location: "Location",
      platform: "Platform",
      orderNumber: "Order Number",
      orderValue: "Order Value",
      disputeAmount: "Dispute Amount",
      outcome: "Outcome",
      videoSubmitted: "Video Submitted",
      reasonForDispute: "Reason for Dispute",
      reason: "Reason",
      footageStatus: "Footage Status",
      otherReason: "Other reason",
      wrongFoodItem: "Wrong, Missing or Incorrect Food Item",
      preparedIncorrectlyWhy: "Why was the Item Prepared Incorrectly?",
    },

    /** Ordered OpSpot fills. `from` = payload key. `when` gates optional fields. */
    fills: [
      { key: "claimDate", labelKey: "claimDate", from: "claimDateDash", extras: "claimDate" },
      { key: "orderTime", labelKey: "orderTime", from: "orderTime" },
      { key: "customer", labelKey: "customer", from: "customer" },
      { key: "location", labelKey: "location", from: "location" },
      { key: "platform", labelKey: "platform", from: "platform" },
      { key: "orderNumber", labelKey: "orderNumber", from: "orderNumber" },
      { key: "orderValue", labelKey: "orderValue", from: "orderValue" },
      { key: "disputeAmount", labelKey: "disputeAmount", from: "disputeAmount" },
      { key: "outcome", labelKey: "outcome", from: "outcome" },
      { key: "videoSubmitted", labelKey: "videoSubmitted", from: "videoSubmitted" },
      { key: "reasonForDispute", labelKey: "reasonForDispute", from: "reasonForDispute" },
      { key: "footageStatus", labelKey: "footageStatus", from: "footageStatus" },
      { key: "preparedIncorrectlyWhy", labelKey: "preparedIncorrectlyWhy", from: "preparedIncorrectlyWhy", when: "hasPreparedIncorrectlyWhy" },
      { key: "wrongFoodItem", labelKey: "wrongFoodItem", from: "wrongFoodItem", when: "hasWrongFoodItem" },
      { key: "reason", labelKey: "reason", from: "reason", when: "hasReason" },
      { key: "otherReason", labelKey: "otherReason", from: "otherReason" },
    ],

    outcomeOptions: {
      notDisputed: "Not disputed",
      reviewed: "Reviewed",
      awaitingReview: "Awaiting review",
      pending: "Pending",
      disputedByThirdParty: "Disputed by 3rd party",
    },
    footageStatusOptions: {
      disputedByThirdParty: "Disputed by 3rd party",
      irrelevant: "Footage status irrelevant for this claim",
    },

    fieldCaptions: [
      "claim date", "order time", "customer", "location", "platform", "order number",
      "order value", "dispute amount", "outcome", "video submitted", "reason for dispute",
      "footage status", "other reason", "wrong, missing or incorrect food item",
      "why was the item prepared incorrectly", "agent", "won revenue", "lost revenue",
    ],
  };

  const sharedCustomerAliases = [
    { match: "popeyes.*louisiana|louisiana.*popeyes", value: "Popeyes France" },
  ];

  const platforms = {
    deliveroo: {
      id: "deliveroo",
      platform: "Deliveroo",
      hostHint: "partner-hub.deliveroo.com",
      storageKey: "deliveroo_claim_payload_v1",
      sheetStorageKey: "deliveroo_sheet_row_v1",
      clipPrefix: "DCF1:",
      uiPrefix: "dcf",
      hitColor: "#00ccbc",
      buttonExtract: "Auto-Fill & Dispute",
      buttonFill: "Fill from Deliveroo",
      buttonSheetCopy: "Copy for Google Sheet",
      buttonSheetPaste: "Paste Deliveroo → Sheet Tab",
      versionLabel: "2.2.0",
      fiveGuysNotDisputedMaxEur: 5,
      customerAliases: sharedCustomerAliases,
      /** Deliveroo branch text → Workhorse Location dropdown value */
      locationAliases: [
        // { match: "victoria station", value: "Victoria" },
        // { match: "brighton marina", value: "Brighton" },
      ],

      reasonMap: {
        missing: "Missing Item",
        "missing item": "Missing Item",
        "missing items": "Missing Item",
        incomplete: "Missing Item",
        "incomplete item": "Missing Item",
        "incomplete items": "Missing Item",
        "prepared incorrectly": "Prepared incorrectly",
        incorrect: "Incorrect Item",
        "incorrect item": "Incorrect Item",
        "incorrect items": "Incorrect Item",
        "food safety complaint": "Other",
      },

      /** First matching rule wins. Patterns are string regex sources. */
      canonicalizeRules: [
        { test: "^missing$|missing item", canonical: "missing items" },
        { test: "^incomplete$|incomplete item", canonical: "missing items" },
        { test: "prepared incorrectly", canonical: "prepared incorrectly" },
        { test: "food safety", canonical: "food safety complaint" },
        { test: "incorrect", canonical: "incorrect item" },
      ],

      outcomeRules: [
        { type: "fiveGuysUnderMax", outcomeKey: "notDisputed" },
        { type: "alreadyDisputed", outcomeKey: "reviewed" },
        { type: "underDisputeThreshold", outcomeKey: "notDisputed" },
        { type: "reasonIn", reasons: ["missing items", "food safety complaint"], outcomeKey: "awaitingReview" },
        { type: "reasonIn", reasons: ["prepared incorrectly", "incorrect item"], outcomeKey: "pending" },
      ],

      footageRules: [
        { type: "fiveGuysUnderMax", footageKey: "irrelevant" },
        { type: "alreadyDisputed", footageKey: "disputedByThirdParty" },
        { type: "underDisputeThreshold", footageKey: "irrelevant" },
        {
          type: "reasonIn",
          reasons: ["missing items", "prepared incorrectly", "incorrect item", "food safety complaint"],
          footageKey: "irrelevant",
        },
      ],

      sheet: {
        enabled: true,
        columns: [
          "Date",
          "Location",
          "# Order Number",
          "Refund Reason",
          "With Video?",
          "Footage Status",
          "Comments",
        ],
        branchSheetTabs: [
          { match: "shake\\s*shack", tab: "Shake Shack" },
          { match: "jollibee", tab: "Jollibee UK" },
          { match: "popeyes", tab: "Popeyes" },
        ],
        defaultSheetTab: "",
        /** Map Workhorse Reason for Dispute → sheet “Refund Reason” wording */
        refundReasonOverrides: [
          { test: "^missing\\s*items?$", value: "Missing Items" },
          { test: "^incorrect\\s*items?$", value: "Incorrect Item" },
          { test: "^incomplete\\s*items?$", value: "Incorrect Item" },
          { test: "prepared incorrectly", value: "Prepared incorrectly" },
          { test: "food safety", value: "Food safety complaint" },
        ],
      },

      otherReasonIncludesCustomerLocation: false,
    },

    ubereats: {
      id: "ubereats",
      platform: "Uber Eats",
      hostHint: "merchants.ubereats.com",
      storageKey: "ubereats_claim_payload_v1",
      sheetStorageKey: "",
      clipPrefix: "UCF1:",
      uiPrefix: "ucf",
      hitColor: "#06c167",
      buttonExtract: "Extract Order → OpSpot",
      buttonFill: "Fill from Uber Eats",
      buttonSheetCopy: "",
      buttonSheetPaste: "",
      versionLabel: "2.2.0",
      fiveGuysNotDisputedMaxEur: null,
      customerAliases: sharedCustomerAliases,
      locationAliases: [],

      reasonMap: {
        missing: "Missing Item",
        "missing item": "Missing Item",
        "missing items": "Missing Item",
        "prepared incorrectly": "Prepared incorrectly",
        incorrect: "Incorrect Item",
        "incorrect item": "Incorrect Item",
        "incorrect items": "Incorrect Item",
        "food safety complaint": "Other",
        "wrong order": "Incorrect Item",
        "wrong item": "Incorrect Item",
        "poor food quality": "Prepared incorrectly",
        "food quality": "Prepared incorrectly",
        "customization missing": "Missing Item",
        "customization reported missing": "Missing Item",
        "item reported missing": "Missing Item",
        "reported missing": "Missing Item",
      },

      canonicalizeRules: [
        { test: "customization\\s*(reported\\s*)?missing|item\\s*reported\\s*missing|reported\\s*missing|^missing$|missing item", canonical: "missing items" },
        { test: "prepared incorrectly|poor food quality|food quality", canonical: "prepared incorrectly" },
        { test: "food safety", canonical: "food safety complaint" },
        { test: "wrong order|wrong item|incorrect", canonical: "incorrect item" },
      ],

      outcomeRules: [
        { type: "alreadyDisputed", outcomeKey: "reviewed" },
        { type: "underDisputeThreshold", outcomeKey: "notDisputed" },
        { type: "reasonIn", reasons: ["missing items", "food safety complaint"], outcomeKey: "awaitingReview" },
        { type: "reasonIn", reasons: ["prepared incorrectly", "incorrect item"], outcomeKey: "pending" },
      ],

      footageRules: [
        { type: "alreadyDisputed", footageKey: "disputedByThirdParty" },
        { type: "underDisputeThreshold", footageKey: "irrelevant" },
        {
          type: "reasonIn",
          reasons: ["missing items", "prepared incorrectly", "incorrect item", "food safety complaint"],
          footageKey: "irrelevant",
        },
      ],

      sheet: { enabled: false },

      /** Labels the Uber extractor prefers for dispute amount / order value */
      extractHints: {
        disputeAmountLabels: ["Chargeback Amount", "Marketplace Fee", "Refund", "Adjustment"],
        orderValueLabels: ["Sales (incl. GST)", "Sales", "Subtotal", "Net payout"],
      },

      otherReasonIncludesCustomerLocation: true,
    },

    grubhub: {
      id: "grubhub",
      platform: "Grubhub",
      hostHint: "docs.google.com/spreadsheets",
      storageKey: "grubhub_claim_payload_v1",
      sheetStorageKey: "",
      clipPrefix: "GCF1:",
      uiPrefix: "gcf",
      hitColor: "#ff8000",
      buttonExtract: "Extract sheet row → OpSpot",
      buttonFill: "Fill from Grubhub",
      buttonSheetCopy: "",
      buttonSheetPaste: "",
      versionLabel: "1.0.7",
      fiveGuysNotDisputedMaxEur: null,
      customerAliases: [
        { match: "joe\\s*&\\s*the\\s*juice|joe\\s*and\\s*the\\s*juice", value: "Joe & the Juice UK" },
      ],
      locationAliases: [],

      /** Google Sheet column headers (row 1) → payload fields */
      sheetColumns: {
        date: ["Date"],
        time: ["Time"],
        /** Split on " - " → Customer + Location */
        restaurant: ["Restaurant", "Full Restaurant Name", "Restaurant Name"],
        /** e.g. "Grubhub Delivery" → Platform Grubhub */
        fulfillment: ["Fulfillment Type", "Fulfillment"],
        /** Sheet "ID" column = OpSpot Order Number */
        orderId: ["ID", "Order ID", "Order Number"],
        type: ["Type"],
        /** Sheet "Description" = reason → Reason for Dispute */
        description: ["Description", "Reason", "Adjustment Reason"],
        restaurantTotal: ["Restaurant Total"],
        subtotal: ["Subtotal"],
        tax: ["Tax"],
      },
      /** Normalize fulfillment text → Workhorse Platform dropdown */
      platformFromFulfillment: [
        { test: "grubhub", value: "Grubhub" },
        { test: "uber", value: "Uber Eats" },
        { test: "deliveroo", value: "Deliveroo" },
      ],
      preferAbsoluteTotals: true,

      reasonMap: {
        missing: "Missing Item",
        "missing item": "Missing Item",
        "missing items": "Missing Item",
        missing_item: "Missing Item",
        incorrect: "Incorrect Item",
        "incorrect item": "Incorrect Item",
        "incorrect items": "Incorrect Item",
        incorrect_item: "Incorrect Item",
        "prepared incorrectly": "Prepared incorrectly",
        "food safety complaint": "Other",
        "food safety": "Other",
      },

      canonicalizeRules: [
        { test: "missing[_\\s-]*item|missing_item|refund due to a missing", canonical: "missing items" },
        { test: "incorrect[_\\s-]*item|incorrect_item", canonical: "incorrect item" },
        { test: "prepared incorrectly", canonical: "prepared incorrectly" },
        { test: "food\\s*safety", canonical: "food safety complaint" },
      ],

      outcomeRules: [
        { type: "underDisputeThreshold", outcomeKey: "notDisputed" },
        { type: "reasonIn", reasons: ["missing items", "food safety complaint"], outcomeKey: "awaitingReview" },
        { type: "reasonIn", reasons: ["prepared incorrectly", "incorrect item"], outcomeKey: "pending" },
      ],

      footageRules: [
        { type: "underDisputeThreshold", footageKey: "irrelevant" },
        { type: "reasonIn", reasons: ["missing items", "food safety complaint"], footageKey: "irrelevant" },
        { type: "reasonIn", reasons: ["prepared incorrectly", "incorrect item"], footageKey: "irrelevant" },
      ],

      sheet: { enabled: false },
      otherReasonIncludesCustomerLocation: false,
    },
  };

  root.ClaimsPresets = {
    workhorse,
    platforms,
    getPlatform(id) {
      return platforms[id] || null;
    },
  };
  if (typeof globalThis !== "undefined" && root !== globalThis) {
    try {
      globalThis.ClaimsPresets = root.ClaimsPresets;
    } catch {
      /* ignore */
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this);

/**
 * ClaimsCore — shared OpSpot fill / rules / transfer helpers for Deliveroo, Uber Eats & Grubhub.
 * Inlined into platform userscripts by build-static.js (after claims-presets).
 *
 *   const core = ClaimsCore.create("deliveroo"); // or "ubereats" | "grubhub"
 */
(function (root) {
  "use strict";

  const HEADER_WORDS = /^(quantity|qty|price|item|items|name|category|total|refund reason|refund details)$/i;

  // Capture GM APIs in the userscript sandbox. Do not look them up later via
  // unsafeWindow — Google Sheets can run page-world code where GM_* is missing,
  // which made Extract look successful (in-memory preview) while OpSpot saw nothing.
  const gmSetValue = typeof GM_setValue === "function" ? GM_setValue : null;
  const gmGetValue = typeof GM_getValue === "function" ? GM_getValue : null;
  const gmSetValueAsync =
    typeof GM !== "undefined" && GM && typeof GM.setValue === "function" ? GM.setValue.bind(GM) : null;
  const gmGetValueAsync =
    typeof GM !== "undefined" && GM && typeof GM.getValue === "function" ? GM.getValue.bind(GM) : null;
  const gmSetClipboard = typeof GM_setClipboard === "function" ? GM_setClipboard : null;

  function ClaimsCoreCreate(platformId) {
    const presets = root.ClaimsPresets || (typeof globalThis !== "undefined" && globalThis.ClaimsPresets);
    if (!presets || !presets.getPlatform) {
      throw new Error("ClaimsCore: ClaimsPresets is missing. Load claims-presets.js before claims-core.js.");
    }

    const workhorse = presets.workhorse;
    const platform = presets.getPlatform(platformId);
    if (!platform) {
      throw new Error(`ClaimsCore: unknown platformId "${platformId}". Expected "deliveroo", "ubereats", or "grubhub".`);
    }
    if (!workhorse) {
      throw new Error("ClaimsCore: ClaimsPresets.workhorse is missing.");
    }

    const uiPrefix = platform.uiPrefix || "claims";
    const hitColor = platform.hitColor || "#00ccbc";
    const hitClass = `${uiPrefix}-hit`;
    const FIELD_CAPTIONS = workhorse.fieldCaptions || [];

    const customerAliases = (platform.customerAliases || []).map((rule) => ({
      match: rule.match instanceof RegExp ? rule.match : new RegExp(String(rule.match), "i"),
      value: rule.value,
    }));

    const locationAliases = (platform.locationAliases || []).map((rule) => ({
      match: rule.match instanceof RegExp ? rule.match : new RegExp(String(rule.match), "i"),
      value: rule.value,
    }));

    /* ---- per-create() instance state ---- */
    let claimsFillInFlight = false;
    let lastFilledOrder = "";
    let saveInProgress = false;
    let pendingAutoFillAfterSave = false;
    let fastFillMode = false;
    let cachedModal = null;
    let cachedModalAt = 0;
    let stylesInjected = false;
    let saveHooksInstalled = false;
    const hits = [];

    /* ---------------------------------------------------------------------- */
    /* Utils                                                                  */
    /* ---------------------------------------------------------------------- */

    function wait(ms) {
      return new Promise((r) => setTimeout(r, ms));
    }

    async function waitUntil(testFn, timeoutMs = 3000, stepMs = 50) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const value = testFn();
        if (value) return value;
        await wait(stepMs);
      }
      return null;
    }

    function debounce(fn, ms) {
      let t;
      return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
      };
    }

    function normalizeSpace(value) {
      return String(value || "")
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    function normalizeKey(value) {
      return normalizeSpace(value)
        .toLowerCase()
        .replace(/\s*\*+\s*$/g, "")
        .replace(/\*+$/g, "")
        .trim();
    }

    function compactKey(value) {
      return normalizeKey(value).replace(/[^a-z0-9]/g, "");
    }

    function visible(el) {
      if (!el || el.nodeType !== 1) return false;
      if (el.hidden) return false;
      return el.offsetWidth > 0 || el.offsetHeight > 0;
    }

    function ownText(el) {
      let out = "";
      for (let n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === Node.TEXT_NODE) out += n.nodeValue;
      }
      return normalizeSpace(out);
    }

    function parseMoney(value) {
      const cleaned = String(value || "").replace(/[^\d.,-]/g, "").replace(/,/g, "");
      if (!cleaned) return null;
      const num = Number.parseFloat(cleaned);
      return Number.isFinite(num) ? num : null;
    }

    function extractTime(text) {
      const m = String(text || "").match(/\b([01]?\d|2[0-3]):([0-5]\d)/);
      return m ? `${m[1].padStart(2, "0")}:${m[2]}` : "";
    }

    function parseClaimDate(raw) {
      const text = normalizeSpace(raw);
      const months = {
        jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
        jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
      };
      const pack = (day, monthName, year) => {
        const month = months[String(monthName || "").slice(0, 3).toLowerCase()];
        if (!month) return { raw: text, iso: "", dmy: "", dash: "" };
        const d = String(day).padStart(2, "0");
        return {
          raw: `${Number.parseInt(day, 10)} ${String(monthName).slice(0, 3)} ${year}`,
          iso: `${year}-${month}-${d}`,
          dmy: `${d}/${month}/${year}`,
          dash: `${d}-${month}-${year}`,
        };
      };
      let named = text.match(/(\d{1,2})\s+([A-Za-z]{3,9}),?\s+(\d{4})/);
      if (named) return pack(named[1], named[2], named[3]);
      named = text.match(/([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/);
      if (named) return pack(named[2], named[1], named[3]);
      named = text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
      if (named) {
        const day = named[1].padStart(2, "0");
        const month = named[2].padStart(2, "0");
        const year = named[3];
        return { raw: text, iso: `${year}-${month}-${day}`, dmy: `${day}/${month}/${year}`, dash: `${day}-${month}-${year}` };
      }
      return { raw: text, iso: "", dmy: "", dash: "" };
    }

    const pageJQuery = () =>
      (typeof unsafeWindow !== "undefined" && (unsafeWindow.jQuery || unsafeWindow.$)) ||
      (typeof window !== "undefined" && (window.jQuery || window.$)) ||
      null;

    function safeClick(el) {
      if (!el) return;
      try {
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      } catch {
        /* Tampermonkey sandbox cannot always build MouseEvent */
      }
      try {
        el.click();
      } catch {
        /* ignore */
      }
    }

    function isOpSpotPage() {
      return typeof location !== "undefined" && /opspot\.workhorselive\.com/i.test(location.host);
    }

    function isGoogleSheetsPage() {
      return (
        typeof location !== "undefined" &&
        /docs\.google\.com/i.test(location.host) &&
        /\/spreadsheets\//i.test(location.pathname)
      );
    }

    function log(...args) {
      if (workhorse.debug) console.log(`[ClaimsCore:${platform.id}]`, ...args);
    }

    function addStyle(css) {
      if (typeof GM_addStyle === "function") {
        GM_addStyle(css);
        return;
      }
      const el = document.createElement("style");
      el.textContent = css;
      (document.head || document.documentElement).appendChild(el);
    }

    function hexToRgba(hex, alpha) {
      const raw = String(hex || "").replace("#", "");
      const full = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw;
      const m = full.match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
      if (!m) return `rgba(0, 204, 188, ${alpha})`;
      return `rgba(${Number.parseInt(m[1], 16)}, ${Number.parseInt(m[2], 16)}, ${Number.parseInt(m[3], 16)}, ${alpha})`;
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }

    function compiledRegex(cache, source, flags) {
      if (!source) return null;
      if (source instanceof RegExp) return source;
      const key = `${flags || ""}::${source}`;
      if (!cache[key]) cache[key] = new RegExp(source, flags || "i");
      return cache[key];
    }

    const ruleRegexCache = Object.create(null);

    /* ---------------------------------------------------------------------- */
    /* Rules                                                                  */
    /* ---------------------------------------------------------------------- */

    function canonicalizeReason(reason) {
      const key = normalizeKey(reason);
      if (!key || HEADER_WORDS.test(key)) return "";
      for (const rule of platform.canonicalizeRules || []) {
        if (!rule || !rule.test) continue;
        const re = compiledRegex(ruleRegexCache, rule.test, "i");
        if (re && re.test(key)) return rule.canonical;
      }
      return key;
    }

    function mapReasonForDispute(canonical) {
      const key = normalizeKey(canonical);
      if (!key) return "";
      const map = platform.reasonMap || {};
      return map[key] || map[canonicalizeReason(key)] || "";
    }

    function normalizeCustomerName(name) {
      const text = normalizeSpace(name);
      if (!text) return "";
      for (const rule of customerAliases) {
        if (rule.match.test(text)) return rule.value;
      }
      return text;
    }

    function normalizeLocationName(name) {
      const text = normalizeSpace(name);
      if (!text) return "";
      for (const rule of locationAliases) {
        if (rule.match.test(text)) return rule.value;
      }
      return text;
    }

    function disputeAmountNum(ctx) {
      if (typeof ctx.disputeAmount === "number") return ctx.disputeAmount;
      return parseMoney(ctx.disputeAmount);
    }

    function isFiveGuys(customer, storeLocation) {
      return /five\s*guys/i.test([customer, storeLocation].filter(Boolean).join(" "));
    }

    function reasonKeyForOutcomeRules(ctx) {
      const dispute = normalizeKey(ctx && ctx.reasonForDispute);
      if (/incorrect/.test(dispute)) return "incorrect item";
      if (/prepared/.test(dispute)) return "prepared incorrectly";
      if (/missing/.test(dispute)) return "missing items";
      if (/food\s*safety|other/.test(dispute) && /food\s*safety/.test(normalizeKey(ctx.refundReasonRaw || ""))) {
        return "food safety complaint";
      }
      if (/food\s*safety/.test(dispute)) return "food safety complaint";

      const raw = normalizeKey((ctx && ctx.refundReasonRaw) || "");
      // Incomplete mapped to Incorrect Item should use the incorrect-item outcome path
      if (/incomplete/.test(raw)) {
        if (/incorrect/.test(dispute) || !dispute) return "incorrect item";
      }
      return canonicalizeReason((ctx && (ctx.refundReasonRaw || ctx.refundReason)) || "") ||
        canonicalizeReason(ctx && ctx.refundReason);
    }

    function matchRule(rule, ctx) {
      const amount = disputeAmountNum(ctx);
      const reason = reasonKeyForOutcomeRules(ctx);
      switch (rule.type) {
        case "fiveGuysUnderMax": {
          const max =
            ctx.fiveGuysMax != null && !Number.isNaN(Number(ctx.fiveGuysMax))
              ? Number(ctx.fiveGuysMax)
              : platform.fiveGuysNotDisputedMaxEur;
          if (max == null) return false;
          return (
            isFiveGuys(ctx.customer, ctx.location) &&
            amount != null &&
            amount < max
          );
        }
        case "alreadyDisputed":
          return !!ctx.alreadyDisputed;
        case "underDisputeThreshold": {
          const threshold =
            ctx.disputeThreshold != null && !Number.isNaN(Number(ctx.disputeThreshold))
              ? Number(ctx.disputeThreshold)
              : workhorse.disputeThresholdGbp || 2;
          return amount != null && amount <= threshold;
        }
        case "reasonIn":
          return Array.isArray(rule.reasons) && rule.reasons.includes(reason);
        default:
          return false;
      }
    }

    function conditionRuleKey(rule) {
      if (!rule || !rule.type) return "";
      if (rule.type === "reasonIn") {
        const reasons = (rule.reasons || []).slice().sort().join("|");
        if (/food safety/.test(reasons) && /missing items/.test(reasons)) return "missingFoodSafety";
        if (/prepared incorrectly/.test(reasons) || /incorrect item/.test(reasons)) return "preparedIncorrect";
        return `reasonIn:${reasons}`;
      }
      return rule.type;
    }

    function resolveOutcomeMatch(ctx) {
      const opts = workhorse.outcomeOptions || {};
      const tweaks = (ctx && ctx.conditionTweaks) || {};
      for (const rule of platform.outcomeRules || []) {
        if (!matchRule(rule, ctx)) continue;
        const key = conditionRuleKey(rule);
        const tweak = tweaks[key] || {};
        return {
          key,
          outcome: tweak.outcome || opts[rule.outcomeKey] || "",
          reasonForDispute: Array.isArray(tweak.reasonForDispute)
            ? tweak.reasonForDispute
            : tweak.reasonForDispute
              ? [tweak.reasonForDispute]
              : [],
        };
      }
      return { key: "", outcome: "", reasonForDispute: [] };
    }

    function computeOutcome(ctx) {
      return resolveOutcomeMatch(ctx).outcome;
    }

    function computeFootageStatus(ctx) {
      const opts = workhorse.footageStatusOptions || {};
      const tweaks = (ctx && ctx.conditionTweaks) || {};
      for (const rule of platform.footageRules || []) {
        if (!matchRule(rule, ctx)) continue;
        const key = conditionRuleKey(rule);
        if (tweaks[key] && tweaks[key].footage) return tweaks[key].footage;
        return opts[rule.footageKey] || "";
      }
      return "";
    }

    function itemNamesFrom(items) {
      return [...new Set((items || []).map((item) => item && item.name).filter(Boolean))];
    }

    function buildDisputeFieldValues(items, refundReason, customer, storeLocation) {
      const reason = canonicalizeReason(refundReason);
      const itemNames = itemNamesFrom(items);
      let result;

      if (reason === "prepared incorrectly") {
        result = {
          wrongFoodItem: "",
          preparedIncorrectlyWhy: workhorse.preparedIncorrectlyOthersOption || "Others",
          reason: "",
          otherReason: itemNames.join("\n"),
        };
      } else if (reason === "food safety complaint") {
        result = {
          wrongFoodItem: "",
          preparedIncorrectlyWhy: "",
          reason: workhorse.foodSafetyComplaintLabel || "Food safety complaint",
          otherReason: itemNames.join("\n"),
        };
      } else {
        result = {
          wrongFoodItem: itemNames[0] || "",
          preparedIncorrectlyWhy: "",
          reason: "",
          otherReason: itemNames.join("\n"),
        };
      }

      if (platform.otherReasonIncludesCustomerLocation) {
        const prefix = [customer, storeLocation].filter(Boolean).join("\n");
        if (prefix) {
          result.otherReason = result.otherReason ? `${prefix}\n${result.otherReason}` : prefix;
        }
      }
      return result;
    }

    function enrichPayload(partial) {
      const p = Object.assign({}, partial || {});
      const amount = disputeAmountNum(p);
      const canonical = canonicalizeReason(p.refundReason || "");
      if (canonical) p.refundReason = canonical;

      p.platform = p.platform || platform.platform;
      p.videoSubmitted = p.videoSubmitted != null && p.videoSubmitted !== ""
        ? p.videoSubmitted
        : workhorse.videoSubmitted || "No";

      if (!p.reasonForDispute) {
        p.reasonForDispute = mapReasonForDispute(canonical || p.refundReason);
      }

      const ruleCtx = {
        disputeAmount: amount,
        alreadyDisputed: p.alreadyDisputed,
        refundReason: p.refundReason,
        refundReasonRaw: p.refundReasonRaw,
        reasonForDispute: p.reasonForDispute,
        customer: p.customer,
        location: p.location,
      };

      if (!p.outcome) p.outcome = computeOutcome(ruleCtx);
      if (!p.footageStatus) p.footageStatus = computeFootageStatus(ruleCtx);

      return p;
    }

    /* ---------------------------------------------------------------------- */
    /* Hits / cache                                                           */
    /* ---------------------------------------------------------------------- */

    function highlightHits() {
      for (const hit of hits) {
        if (hit.el) hit.el.classList.add(hitClass);
        if (hit.valueEl) hit.valueEl.classList.add(hitClass);
      }
    }

    function clearHits() {
      for (const hit of hits) {
        if (hit.el) hit.el.classList.remove(hitClass);
        if (hit.valueEl) hit.valueEl.classList.remove(hitClass);
      }
      hits.length = 0;
    }

    function invalidateModalCache() {
      cachedModal = null;
      cachedModalAt = 0;
    }

    function resetFillGuards() {
      lastFilledOrder = "";
      claimsFillInFlight = false;
      const btn = document.getElementById(`${uiPrefix}-btn`);
      if (btn) {
        btn.disabled = false;
        btn.textContent = platform.buttonFill || "Fill Claims";
      }
    }

    function findVisibleLabel(root, label) {
      const wanted = normalizeKey(label);
      let best = null;
      let bestLen = Infinity;
      const nodes = root.querySelectorAll("label, dt, th, td, strong, b, p, span, h1, h2, h3, h4, legend, li");
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        if (!visible(el)) continue;
        const text = ownText(el) || (el.children.length === 0 ? normalizeSpace(el.textContent) : "");
        if (!text || text.length > 48) continue;
        const key = normalizeKey(text);
        if (key !== wanted && key !== `${wanted}*`) continue;
        if (text.length <= bestLen && el.tagName !== "TH") {
          best = el;
          bestLen = text.length;
        }
      }
      return best;
    }

    /* ---------------------------------------------------------------------- */
    /* OpSpot modal discovery                                                 */
    /* ---------------------------------------------------------------------- */

    function getClaimsModal(force = false) {
      const now = Date.now();
      const cacheMs = workhorse.modalCacheMs != null ? workhorse.modalCacheMs : 800;
      if (
        !force &&
        cachedModal &&
        now - cachedModalAt < cacheMs &&
        document.contains(cachedModal) &&
        visible(cachedModal)
      ) {
        return cachedModal;
      }

      const candidates = document.querySelectorAll(
        ".modal.show, .modal.in, [role='dialog'], .ew-modal, #ewModalDialog"
      );
      let best = null;
      let bestArea = Infinity;

      const consider = (el) => {
        if (!el || !visible(el) || !el.querySelector("input, select, textarea")) return;
        const text = el.innerText || "";
        if (!/video submitted/i.test(text) || !/other reason/i.test(text)) return;
        if (!/save and add new/i.test(text)) return;
        const area = el.offsetWidth * el.offsetHeight;
        if (area > 8000 && area < bestArea) {
          best = el;
          bestArea = area;
        }
      };

      for (let i = 0; i < candidates.length; i++) consider(candidates[i]);

      if (!best) {
        const forms = document.getElementsByTagName("form");
        for (let i = 0; i < forms.length; i++) consider(forms[i]);
      }

      if (!best) {
        const buttons = document.querySelectorAll("button, input, a");
        for (let i = 0; i < buttons.length; i++) {
          const el = buttons[i];
          if (!visible(el) || !/save and add new/i.test(normalizeSpace(el.textContent || el.value || ""))) continue;
          let node = el.parentElement;
          while (node) {
            const text = node.innerText || "";
            if (/video submitted/i.test(text) && /claim date/i.test(text) && node.querySelector("input, select, textarea")) {
              best = node;
              break;
            }
            node = node.parentElement;
          }
          if (best) break;
        }
      }

      cachedModal = best;
      cachedModalAt = now;
      return best;
    }

    function closeOpenDropdowns() {
      try {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      } catch {
        /* ignore */
      }
      const $ = pageJQuery();
      if ($) {
        try {
          $(".select2-hidden-accessible").each(function () {
            try {
              $(this).select2("close");
            } catch {
              /* ignore */
            }
          });
        } catch {
          /* ignore */
        }
      }
      const search = document.querySelector(".select2-search__field");
      if (search && search.blur) search.blur();
    }

    function findClaimsCancelButton(modal) {
      if (!modal) return null;
      return [...modal.querySelectorAll("button, input, a")].find((el) => {
        if (!visible(el)) return false;
        const text = normalizeSpace(el.textContent || el.value || "");
        return /^cancel$/i.test(text);
      });
    }

    function findPageAddNewButton() {
      return [...document.querySelectorAll("a, button, input[type='button'], input[type='submit']")].find((el) => {
        if (!visible(el)) return false;
        const text = normalizeSpace(el.textContent || el.value || el.getAttribute("title") || "");
        if (/save/i.test(text)) return false;
        return /\badd new\b/i.test(text);
      });
    }

    async function reopenClaimsModal() {
      closeOpenDropdowns();
      invalidateModalCache();
      const modal = getClaimsModal(true);
      const cancel = findClaimsCancelButton(modal);
      if (cancel) safeClick(cancel);
      else {
        const dismiss = document.querySelector(".modal.show .close, .modal.in .close, [data-dismiss='modal']");
        if (dismiss) safeClick(dismiss);
      }

      await waitUntil(() => !getClaimsModal(true), 2500, 40);

      const addBtn = findPageAddNewButton();
      if (addBtn) safeClick(addBtn);

      invalidateModalCache();
      return waitUntil(() => getClaimsModal(true), 3500, 40);
    }

    function getModalOrderNumber(modal) {
      if (!modal) return "";
      const L = workhorse.labels || {};
      const found =
        controlAfterLabel(modal, L.orderNumber || "Order Number") || controlByFieldName(modal, "Order Number");
      const control = found && (found.control || controlForField(found.labelEl, found.row));
      return control ? normalizeSpace(control.value) : "";
    }

    function isClaimsFormEmpty(modal) {
      if (!modal) return false;
      const orderNo = getModalOrderNumber(modal);
      if (orderNo) return false;
      const L = workhorse.labels || {};
      const dateFound = controlAfterLabel(modal, L.claimDate || "Claim Date");
      const dateControl = dateFound && (dateFound.control || controlForField(dateFound.labelEl, dateFound.row));
      if (dateControl && normalizeSpace(dateControl.value)) return false;
      return true;
    }

    function isSaveButton(el) {
      if (!el || !visible(el)) return false;
      const text = normalizeSpace(el.textContent || el.value || el.getAttribute("title") || "");
      return /^save$/i.test(text) || /save\s+and\s+add\s+new/i.test(text);
    }

    async function waitForFreshClaimsForm(savedOrderNumber, hooks) {
      pendingAutoFillAfterSave = true;

      const isFreshModal = (modal) => {
        if (!modal) return false;
        if (isClaimsFormEmpty(modal)) return true;
        const current = getModalOrderNumber(modal);
        return current && savedOrderNumber && current !== savedOrderNumber;
      };

      const finishFresh = async () => {
        saveInProgress = false;
        pendingAutoFillAfterSave = false;
        resetFillGuards();
        const payload = await loadPayload();
        if (payload && payload.orderNumber && payload.orderNumber !== savedOrderNumber) {
          await applyPayloadToClaims(payload, { force: true, fast: true });
          toast(`Ready — filled order ${payload.orderNumber}.`, "success", 3000);
        } else {
          toast("Ready for next order.", "success", 2500);
          if (payload && payload.orderNumber === savedOrderNumber) {
            const msg =
              (hooks && hooks.onNeedNextExtractMessage) ||
              "Run extract on the next refund first.";
            toast(msg, "info", 5000);
          }
        }
      };

      await wait(80);

      if (isFreshModal(getClaimsModal())) {
        await finishFresh();
        return;
      }

      toast("Opening next claim…", "info", 1500);
      await reopenClaimsModal();

      if (isFreshModal(getClaimsModal())) {
        await finishFresh();
        return;
      }

      await reopenClaimsModal();
      if (isFreshModal(getClaimsModal())) {
        await finishFresh();
        return;
      }

      saveInProgress = false;
      pendingAutoFillAfterSave = false;
      resetFillGuards();
      toast("Could not reset form. Click Cancel, then Add New.", "error", 6000);
    }

    function setupOpSpotSaveHooks(options = {}) {
      if (!isOpSpotPage() || saveHooksInstalled) return;
      saveHooksInstalled = true;
      const hooks = options || {};
      document.addEventListener(
        "click",
        (event) => {
          const el = event.target.closest("button, input[type='button'], input[type='submit'], a");
          if (!el || !isSaveButton(el)) return;

          closeOpenDropdowns();
          invalidateModalCache();
          const modal = getClaimsModal(true);
          const savedOrderNumber = getModalOrderNumber(modal);
          const saveAndAddNew = /save\s+and\s+add\s+new/i.test(
            normalizeSpace(el.textContent || el.value || "")
          );

          resetFillGuards();
          saveInProgress = true;

          if (saveAndAddNew) {
            setTimeout(() => waitForFreshClaimsForm(savedOrderNumber, hooks), 300);
          } else {
            setTimeout(() => {
              saveInProgress = false;
            }, 3000);
          }
        },
        true
      );
    }

    /* ---------------------------------------------------------------------- */
    /* Form field resolution / fill                                           */
    /* ---------------------------------------------------------------------- */

    function labelNearControl(control) {
      if (control.labels && control.labels[0]) return normalizeKey(control.labels[0].innerText);
      const aria = control.getAttribute("aria-label");
      if (aria) return normalizeKey(aria);

      const td = control.closest("td");
      if (td && td.previousElementSibling) {
        const prev = normalizeKey(td.previousElementSibling.innerText);
        if (prev && prev.length < 60) return prev;
      }

      const wrap = control.closest("tr, .form-group, .mb-3, .ew-row, li") || control.parentElement;
      if (wrap) {
        const lab = [...wrap.querySelectorAll("label, .control-label, .col-form-label, td, span, div")].find((el) => {
          if (el.contains(control)) return false;
          const t = normalizeKey(el.innerText);
          return t && t.length < 50 && t.length > 2;
        });
        if (lab) return normalizeKey(lab.innerText);
      }

      return normalizeKey((control.name || control.id || "").replace(/^x_/i, "").replace(/[_-]+/g, " "));
    }

    function collectFormFields(modal) {
      const fields = [];
      const controls = [...modal.querySelectorAll("input, select, textarea")].filter((el) => {
        if (el.type === "hidden" || el.type === "submit" || el.type === "button") return false;
        if (el.disabled) return false;
        return true;
      });
      for (const control of controls) {
        const label = labelNearControl(control);
        if (!label) continue;
        fields.push({
          label,
          row: control.closest("tr, .form-group, .mb-3, .ew-row, div") || control.parentElement,
          control,
          labelEl: (control.labels && control.labels[0]) || null,
        });
      }
      return fields;
    }

    function matchFormField(fields, names) {
      const wanted = names.map(normalizeKey);
      return (
        fields.find((f) => wanted.some((w) => f.label === w)) ||
        fields.find((f) => wanted.some((w) => f.label.startsWith(`${w} `) || f.label.startsWith(`${w}*`))) ||
        fields.find((f) => wanted.some((w) => f.label.includes(w) && w.length > 8))
      );
    }

    function captionText(el) {
      const own = ownText(el).replace(/\s*\*+\s*$/g, "");
      if (own && own.length < 80) return normalizeKey(own);
      const first = normalizeKey((el.innerText || "").split("\n")[0] || "");
      if (first && first.length < 80) return first;
      return "";
    }

    function captionMatches(el, label) {
      const wanted = compactKey(label);
      if (!wanted) return false;
      return compactKey(captionText(el)) === wanted;
    }

    function fieldCaptionCount(el) {
      const text = normalizeKey(el.innerText || "");
      let count = 0;
      for (let i = 0; i < FIELD_CAPTIONS.length; i++) {
        if (text.includes(FIELD_CAPTIONS[i])) count += 1;
      }
      return count;
    }

    function isFillableControl(el) {
      if (!el || el.disabled) return false;
      if (el.type === "hidden" || el.type === "submit" || el.type === "button" || el.type === "file" || el.type === "reset") return false;
      if (el.tagName === "SELECT") return true;
      if (el.classList && el.classList.contains("select2-hidden-accessible")) return true;
      return visible(el);
    }

    function controlCell(el) {
      return (
        (el && el.closest(".ew-cell, .ew-ctrl, .form-group, .mb-3, .col-sm-10, .col-sm-8, td, li")) ||
        (el && el.parentElement)
      );
    }

    function controlNearCaption(modal, cap) {
      const inner = [...cap.querySelectorAll("input, select, textarea")].find(isFillableControl);
      if (inner) return inner;

      if (cap.getAttribute && cap.getAttribute("for")) {
        try {
          const byId = document.getElementById(cap.getAttribute("for"));
          if (byId && modal.contains(byId) && isFillableControl(byId)) return byId;
        } catch {
          /* ignore */
        }
      }
      if (cap.control && isFillableControl(cap.control)) return cap.control;

      let sib = cap.nextElementSibling;
      while (sib) {
        if (sib.matches && sib.matches("input, select, textarea") && isFillableControl(sib)) return sib;
        const nested = sib.querySelector && [...sib.querySelectorAll("input, select, textarea")].find(isFillableControl);
        if (nested) return nested;
        sib = sib.nextElementSibling;
      }

      const td = cap.closest("td, th");
      if (td && td.nextElementSibling) {
        const inNext = [...td.nextElementSibling.querySelectorAll("input, select, textarea")].find(isFillableControl);
        if (inNext) return inNext;
      }

      const group = cap.closest(".form-group, .mb-3, .ew-cell, .ew-ctrl, li") || cap.parentElement;
      if (group && fieldCaptionCount(group) <= 1) {
        const inGroup = [...group.querySelectorAll("input, select, textarea")].find(isFillableControl);
        if (inGroup) return inGroup;
      }

      const lr = cap.getBoundingClientRect();
      let best = null;
      let bestScore = Infinity;
      for (const el of modal.querySelectorAll("input, select, textarea")) {
        if (!isFillableControl(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && el.tagName !== "SELECT") continue;
        const midY = (lr.top + lr.bottom) / 2;
        const sameRow = r.top < midY + 16 && r.bottom > midY - 16;
        const below = r.top >= lr.top - 2 && r.top <= lr.bottom + 56;
        const toRight = r.left >= lr.left - 4;
        if (!(sameRow || below) || !toRight) continue;
        if (sameRow && r.right < lr.left) continue;
        const dx = Math.max(0, r.left - lr.right);
        const dy = Math.max(0, r.top - lr.bottom);
        const score = sameRow ? dx : dy + 40;
        if (score < bestScore) {
          best = el;
          bestScore = score;
        }
      }
      return bestScore < 280 ? best : null;
    }

    function controlByFieldName(modal, label) {
      const wanted = compactKey(label);
      if (wanted.length < 5) return null;
      const aliases = {
        ordernumber: ["ordernumber", "orderno", "orderid", "ordernum", "ordernumber"],
        ordervalue: ["ordervalue", "ordertotal", "orderval", "ordervalue"],
        disputeamount: ["disputeamount", "refundvalue", "refundamount", "disputeamt"],
        footagestatus: ["footagestatus", "footage"],
        wrongmissingorincorrectfooditem: ["fooditem", "wrongmissing", "incorrectfood", "missingitem", "wrongfood"],
        whywastheitempreparedincorrectly: ["preparedincorrectly", "whywas", "preparedwhy", "itemprepared"],
      };
      const keys = aliases[wanted] || [wanted];
      const preferText = /ordernumber|ordervalue|disputeamount/i.test(wanted);
      const controls = [...modal.querySelectorAll("input, select, textarea")].filter((el) => {
        if (!isFillableControl(el)) return false;
        if (!modal.contains(el)) return false;
        const raw = `${el.name || ""} ${el.id || ""} ${el.getAttribute("data-field") || ""} ${el.getAttribute("data-name") || ""}`;
        const key = compactKey(raw);
        return keys.some((alias) => key.includes(alias));
      });
      if (!controls.length) return null;
      if (preferText) {
        return controls.find((el) => el.tagName === "INPUT" || el.tagName === "TEXTAREA") || controls[0];
      }
      return controls[0];
    }

    function controlAfterLabel(modal, label) {
      const wanted = normalizeKey(label);
      const nodes = [...modal.querySelectorAll("label, .ew-label, .col-form-label, td, th, span, div, p, strong, b, legend, li")];
      const matches = nodes.filter((el) => {
        if (el.closest("thead")) return false;
        if (!visible(el) && el.tagName !== "LABEL") return false;
        if (!captionMatches(el, label)) return false;
        return fieldCaptionCount(el) <= 1;
      });
      matches.sort((a, b) => {
        const tagScore = (el) => (el.tagName === "LABEL" || el.classList.contains("ew-label") ? 0 : 1);
        const area = (el) => {
          const r = el.getBoundingClientRect();
          return Math.max(1, r.width * r.height);
        };
        return tagScore(a) - tagScore(b) || area(a) - area(b);
      });

      for (const labelEl of matches) {
        const control = controlNearCaption(modal, labelEl);
        if (!control) continue;
        return {
          label: wanted,
          labelEl,
          row: controlCell(control) || labelEl,
          control,
        };
      }

      const named = controlByFieldName(modal, label);
      if (named) {
        return {
          label: wanted,
          labelEl: null,
          row: controlCell(named),
          control: named,
        };
      }
      return null;
    }

    function fieldRow(modal, label) {
      const labelEl = findVisibleLabel(modal, label) || findVisibleLabel(modal, `${label}*`);
      if (!labelEl) return null;

      const candidates = [
        labelEl.closest("tr"),
        labelEl.closest(".form-group, .mb-3, .ew-row, .ew-cell"),
        labelEl.parentElement,
        labelEl.closest(".row"),
      ].filter(Boolean);

      for (const row of candidates) {
        const tooWide = (row.innerText.match(/Claim Date|Customer|Location|Platform|Outcome|Footage Status/gi) || []).length > 3;
        if (tooWide) continue;
        if (row.querySelector("select, input, textarea, .select2-container, .select2")) {
          return { labelEl, row };
        }
      }
      return { labelEl, row: labelEl.parentElement };
    }

    function controlForField(labelEl, row, preferInput = false) {
      const forId = labelEl && labelEl.getAttribute && labelEl.getAttribute("for");
      if (forId) {
        try {
          const byId = document.getElementById(forId);
          if (byId) return byId;
        } catch {
          /* ignore */
        }
      }
      if (labelEl && labelEl.control) return labelEl.control;

      const roots = [labelEl && labelEl.nextElementSibling, row, labelEl && labelEl.parentElement].filter(Boolean);
      const pick = (root) => {
        if (preferInput) {
          const input = [...root.querySelectorAll("input:not([type='hidden'])")].find(visible);
          if (input) return input;
          const area = root.querySelector("textarea");
          if (area) return area;
        }
        const select = root.querySelector("select");
        if (select && !preferInput) return select;
        const area = root.querySelector("textarea");
        if (area) return area;
        const input = [...root.querySelectorAll("input:not([type='hidden'])")].find(visible);
        if (input) return input;
        if (preferInput && select) return select;
        return null;
      };
      for (const root of roots) {
        const found = pick(root);
        if (found) return found;
      }
      return null;
    }

    function dispatch(el) {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
    }

    function setInputValue(el, value, opts = {}) {
      const text = String(value);
      const fast = opts.skipFocus || fastFillMode || workhorse.fastFill;
      if (!fast) el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(el, text);
      else el.value = text;
      try {
        el.setAttribute("value", text);
      } catch {
        /* ignore */
      }
      dispatch(el);
      const $ = pageJQuery();
      if ($) {
        try {
          $(el).val(text).trigger("input").trigger("change").trigger("blur");
        } catch {
          /* ignore */
        }
      }
      if (el.value !== text) {
        if (fast) {
          el.value = text;
          dispatch(el);
        } else {
          try {
            el.select();
            document.execCommand("insertText", false, text);
          } catch {
            el.value = text;
            dispatch(el);
          }
        }
      }
    }

    function bestOption(select, value) {
      const wanted = normalizeKey(value).replace(/[®™©]/g, "");
      const compact = compactKey(value).replace(/[®™©]/g, "");
      let best = null;
      let score = 0;
      for (const opt of select.options) {
        const t = normalizeKey(opt.textContent).replace(/[®™©]/g, "");
        const v = normalizeKey(opt.value).replace(/[®™©]/g, "");
        const tc = compactKey(opt.textContent).replace(/[®™©]/g, "");
        let s = 0;
        if (!t || /^(select|-|please select)$/i.test(t)) continue;
        if (t === wanted || v === wanted || tc === compact) s = 100;
        else if (t.startsWith(wanted) || wanted.startsWith(t)) s = 80;
        else if (t.includes(wanted) || wanted.includes(t)) s = 55;
        else if (wanted.split(/\s+/).every((w) => w.length > 3 && t.includes(w))) s = 50;
        else if (/irrelevant/.test(wanted) && /irrelevant/.test(t)) s = 90;
        else if (/(3rd|third)\s*party/.test(wanted) && /(3rd|third)\s*party/.test(t)) s = 90;
        if (s > score) {
          best = opt;
          score = s;
        }
      }
      return score >= 45 ? best : null;
    }

    function clickMatchingMenuItem(value) {
      const wanted = normalizeKey(value).replace(/[®™©]/g, "");
      const options = [...document.querySelectorAll(
        ".select2-results__option, .dropdown-item, [role='option'], .select2-result-label, li"
      )].filter((el) => visible(el) && normalizeSpace(el.textContent).length < 120);

      const match = options.find((el) => {
        const t = normalizeKey(el.textContent).replace(/[®™©]/g, "");
        if (t === wanted) return true;
        if (t.includes(wanted) || wanted.includes(t)) return true;
        return false;
      });
      if (!match) return false;
      safeClick(match);
      return true;
    }

    async function fillSelect(select, value, row) {
      const fast = fastFillMode || workhorse.fastFill;
      const pause = fast ? 35 : 80;
      const nativeSelect = select && select.tagName === "SELECT" ? select : (row && row.querySelector("select"));
      const option = nativeSelect ? bestOption(nativeSelect, value) : null;
      const $ = pageJQuery();
      const root = controlCell(nativeSelect || select) || row;

      if (nativeSelect && option) {
        nativeSelect.value = option.value;
        nativeSelect.dispatchEvent(new Event("input", { bubbles: true }));
        nativeSelect.dispatchEvent(new Event("change", { bubbles: true }));
        if ($) {
          try {
            $(nativeSelect).val(String(option.value)).trigger("change").trigger("select2:select");
          } catch {
            /* ignore */
          }
        }
        const rendered = root && root.querySelector(".select2-selection__rendered");
        if (rendered && option.textContent) rendered.textContent = normalizeSpace(option.textContent);
        if (nativeSelect.value === option.value) return true;
      }

      const box =
        (root && root.querySelector(".select2-selection, .select2-container, .dropdown-toggle")) ||
        (nativeSelect && nativeSelect.parentElement && nativeSelect.parentElement.querySelector(".select2-selection, .select2-container")) ||
        nativeSelect ||
        select;
      if (box) {
        safeClick(box);
        await wait(pause);
      }

      const clean = String(value).replace(/[®™©]/g, "").trim();
      const searchTerms = [clean, value].filter(Boolean);
      if (/irrelevant/i.test(String(value))) searchTerms.unshift("irrelevant");
      if (/(3rd|third)\s*party/i.test(String(value))) searchTerms.unshift("3rd party");
      const firstWord = clean.split(/\s+/)[0];
      if (firstWord && firstWord.length > 3 && !searchTerms.includes(firstWord)) searchTerms.push(firstWord);

      const search = document.querySelector(".select2-search__field, .dropdown-menu input, input[type='search']");
      for (const term of searchTerms) {
        if (search) {
          search.focus();
          setInputValue(search, term, { skipFocus: false });
          search.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter" }));
          await wait(pause);
        }
        if (await clickMatchingMenuItem(term)) return true;
      }

      if (search) {
        search.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
        await wait(pause);
      }

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return Boolean(nativeSelect && option && nativeSelect.value === option.value);
    }

    function fillYesNo(row, value) {
      const wanted = normalizeKey(value);
      const radio = [...row.querySelectorAll("input[type='radio']")].find((el) => {
        const lab = el.closest("label") || (el.id && row.querySelector(`label[for='${el.id}']`));
        return normalizeKey((lab && lab.textContent) || el.value) === wanted;
      });
      if (radio) {
        radio.click();
        radio.checked = true;
        dispatch(radio);
        return true;
      }
      const btn = [...row.querySelectorAll("button, label, span, a, div")].find((el) => {
        return visible(el) && normalizeKey(el.textContent) === wanted && normalizeSpace(el.textContent).length <= 4;
      });
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    }

    function resolveFormField(modal, label, fields) {
      const preferText = /order number|order value|dispute amount/i.test(label);

      if (preferText) {
        const named = controlByFieldName(modal, label);
        if (named && (named.tagName === "INPUT" || named.tagName === "TEXTAREA")) {
          return {
            label: normalizeKey(label),
            labelEl: null,
            row: controlCell(named),
            control: named,
          };
        }
        const byLabel = controlAfterLabel(modal, label);
        if (byLabel && byLabel.control && byLabel.control.tagName !== "SELECT") return byLabel;
        if (byLabel && byLabel.control && byLabel.control.tagName === "SELECT" && named) {
          return {
            label: normalizeKey(label),
            labelEl: byLabel.labelEl,
            row: controlCell(named),
            control: named,
          };
        }
      }

      let found = matchFormField(fields, [label, `${label}*`]);
      if (found && preferText && found.control && found.control.tagName === "SELECT") {
        found = null;
      }
      if (found) return found;

      found = controlAfterLabel(modal, label);
      if (found && preferText && found.control && found.control.tagName === "SELECT") {
        const named = controlByFieldName(modal, label);
        if (named) {
          return {
            label: normalizeKey(label),
            labelEl: found.labelEl,
            row: controlCell(named),
            control: named,
          };
        }
      }
      if (found) return found;

      const rowInfo = fieldRow(modal, label);
      if (rowInfo) {
        const control = controlForField(rowInfo.labelEl, rowInfo.row, preferText);
        if (control) {
          return {
            label: normalizeKey(label),
            labelEl: rowInfo.labelEl,
            row: rowInfo.row,
            control,
          };
        }
        return rowInfo;
      }

      const named = controlByFieldName(modal, label);
      if (named) {
        return {
          label: normalizeKey(label),
          labelEl: null,
          row: controlCell(named),
          control: named,
        };
      }
      return null;
    }

    async function fillLabeledField(modal, label, value, extras = {}, fieldIndex = null) {
      if (value == null || value === "") return { ok: false, reason: "empty" };
      const fields = fieldIndex || collectFormFields(modal);
      const found = resolveFormField(modal, label, fields);
      if (!found) return { ok: false, reason: "label not on screen" };

      const row = found.row;
      const labelEl = found.labelEl;
      if (labelEl) labelEl.classList.add(hitClass);

      if (/video submitted/i.test(label)) return { ok: fillYesNo(row, value), method: "yes-no" };

      let control = found.control || controlForField(labelEl, row, /order number|order value|dispute amount/i.test(label));
      if (/order number|order value|dispute amount/i.test(label)) {
        const named = controlByFieldName(modal, label);
        if (named && (named.tagName === "INPUT" || named.tagName === "TEXTAREA")) control = named;
        else if (control && control.tagName === "SELECT") control = named || control;
      }
      if (!control) {
        const box = row && row.querySelector(".select2-selection, .select2-container");
        if (box) {
          const ok = await fillSelect(row.querySelector("select") || box, value, row);
          return { ok, method: "select2-only" };
        }
        return { ok: false, reason: "no control next to label" };
      }
      control.classList.add(hitClass);

      if (control.tagName === "SELECT") return { ok: await fillSelect(control, value, controlCell(control) || row), method: "select" };
      if (control.type === "date") {
        setInputValue(control, extras.iso || value);
        return { ok: true, method: "date" };
      }
      if (control.type === "time") {
        setInputValue(control, extractTime(value));
        return { ok: true, method: "time" };
      }
      if (control.type === "radio") return { ok: fillYesNo(row, value), method: "radio" };

      const written = extras.dmy && /date/i.test(label) ? extras.dmy : value;
      setInputValue(control, written, { skipFocus: false });
      const $ = pageJQuery();
      if ($ && $(control).data("datepicker")) {
        try {
          $(control).datepicker("update", written);
        } catch {
          /* ignore */
        }
      }
      const stuck = String(control.value || "").replace(/,/g, "") === String(written).replace(/,/g, "") ||
        String(control.value || "").includes(String(written));
      return { ok: stuck || Boolean(control.value), method: "input", reason: stuck ? "" : "value did not stick" };
    }

    async function ensureClaimsModal() {
      const cached = getClaimsModal();
      if (cached) return cached;

      if (saveInProgress || pendingAutoFillAfterSave) {
        return waitUntil(() => getClaimsModal(true), 8000, 40);
      }

      const addBtn = findPageAddNewButton();
      if (addBtn) {
        addBtn.click();
        toast("Opening Add New…", "info", 2000);
      }

      return waitUntil(() => getClaimsModal(true), 10000, 80);
    }

    async function fillClaimsForm(payload, options = {}) {
      const modal = await ensureClaimsModal();
      if (!modal) {
        throw new Error(`Click the green Add New button, then click ${platform.buttonFill || "Fill"}.`);
      }

      const L = workhorse.labels || {};
      const results = {};
      let fieldIndex = collectFormFields(modal);
      const fast = options.fast || fastFillMode || workhorse.fastFill;

      const defaultFills = [
        { key: "claimDate", labelKey: "claimDate", from: "claimDateDash", extras: "claimDate" },
        { key: "orderTime", labelKey: "orderTime", from: "orderTime" },
        { key: "customer", labelKey: "customer", from: "customer" },
        { key: "location", labelKey: "location", from: "location" },
        { key: "platform", labelKey: "platform", from: "platform" },
        { key: "orderNumber", labelKey: "orderNumber", from: "orderNumber" },
        { key: "orderValue", labelKey: "orderValue", from: "orderValue" },
        { key: "disputeAmount", labelKey: "disputeAmount", from: "disputeAmount" },
        { key: "outcome", labelKey: "outcome", from: "outcome" },
        { key: "videoSubmitted", labelKey: "videoSubmitted", from: "videoSubmitted" },
        { key: "reasonForDispute", labelKey: "reasonForDispute", from: "reasonForDispute" },
        { key: "footageStatus", labelKey: "footageStatus", from: "footageStatus" },
        { key: "preparedIncorrectlyWhy", labelKey: "preparedIncorrectlyWhy", from: "preparedIncorrectlyWhy", when: "hasPreparedIncorrectlyWhy" },
        { key: "wrongFoodItem", labelKey: "wrongFoodItem", from: "wrongFoodItem", when: "hasWrongFoodItem" },
        { key: "reason", labelKey: "reason", from: "reason", when: "hasReason" },
        { key: "otherReason", labelKey: "otherReason", from: "otherReason" },
      ];
      const fillList = Array.isArray(workhorse.fills) && workhorse.fills.length ? workhorse.fills : defaultFills;

      const defaultLabels = {
        claimDate: "Claim Date",
        orderTime: "Order Time",
        customer: "Customer",
        location: "Location",
        platform: "Platform",
        orderNumber: "Order Number",
        orderValue: "Order Value",
        disputeAmount: "Dispute Amount",
        outcome: "Outcome",
        videoSubmitted: "Video Submitted",
        reasonForDispute: "Reason for Dispute",
        reason: "Reason",
        footageStatus: "Footage Status",
        otherReason: "Other reason",
        wrongFoodItem: "Wrong, Missing or Incorrect Food Item",
        preparedIncorrectlyWhy: "Why was the Item Prepared Incorrectly?",
      };

      const gates = {
        hasPreparedIncorrectlyWhy: !!payload.preparedIncorrectlyWhy,
        hasWrongFoodItem: !payload.preparedIncorrectlyWhy && !!payload.wrongFoodItem,
        hasReason: !!payload.reason,
      };

      for (const fill of fillList) {
        if (fill.when && !gates[fill.when]) continue;

        const label = L[fill.labelKey] || defaultLabels[fill.labelKey] || fill.labelKey;
        let value = payload[fill.from];
        let extras = {};

        if (fill.extras === "claimDate") {
          extras = {
            iso: payload.claimDateISO,
            dmy: payload.claimDateDash || payload.claimDateDMY,
          };
          value = payload.claimDateDash || payload.claimDateDMY;
        }

        if (value == null || value === "") {
          results[label] = { ok: false, reason: "empty" };
          continue;
        }

        try {
          if (fill.key === "reason" || label === (L.reason || defaultLabels.reason)) {
            await waitUntil(() => {
              fieldIndex = collectFormFields(modal);
              return matchFormField(fieldIndex, [L.reason || "Reason", `${L.reason || "Reason"}*`]);
            }, fast ? 700 : 2500, fast ? 25 : 50);
          }
          results[label] = await fillLabeledField(modal, label, value, extras, fieldIndex);
        } catch (err) {
          log("Field fill error", label, err);
          results[label] = { ok: false, reason: String(err && err.message ? err.message : err) };
        }

        if (
          (fill.key === "reasonForDispute" || /reason for dispute/i.test(label)) &&
          (payload.preparedIncorrectlyWhy || payload.reason || /other/i.test(String(payload.reasonForDispute || "")))
        ) {
          if (!fast) await wait(150);
          else fieldIndex = collectFormFields(modal);
        }

        if ((!results[label] || !results[label].ok) && /reason for dispute/i.test(label) && /other/i.test(String(value || ""))) {
          for (const alt of ["Other", "Others", "other", "others"]) {
            if (alt === value) continue;
            results[label] = await fillLabeledField(modal, label, alt, {}, fieldIndex);
            if (results[label].ok) break;
          }
        }
        if ((!results[label] || !results[label].ok) && /prepared incorrectly/i.test(label)) {
          for (const alt of ["Others", "Other", "others", "other"]) {
            if (alt === value) continue;
            results[label] = await fillLabeledField(modal, label, alt, {}, fieldIndex);
            if (results[label].ok) break;
          }
        }
        if ((!results[label] || !results[label].ok) && /wrong, missing/i.test(label)) {
          const tries = [
            ...((payload.items || []).map((item) => item && item.name)),
            String(payload.otherReason || "").split("\n")[0],
            payload.otherReason,
          ].filter((v, i, arr) => v && arr.indexOf(v) === i);
          for (const alt of tries) {
            if (alt === value) continue;
            results[label] = await fillLabeledField(modal, label, alt, {}, fieldIndex);
            if (results[label].ok) break;
          }
        }
      }

      log("Fill results", results);
      return results;
    }

    /* ---------------------------------------------------------------------- */
    /* Transfer / UI / Sheet                                                  */
    /* ---------------------------------------------------------------------- */

    function ensureStyles() {
      if (stylesInjected) return;
      stylesInjected = true;
      const rgba = hexToRgba(hitColor, 0.12);
      addStyle(`
      .${hitClass} { outline: 2px solid ${hitColor} !important; outline-offset: 2px; background: ${rgba} !important; }
      #${uiPrefix}-btn-bar {
        position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
        z-index: 2147483647; display: flex; gap: 8px; align-items: center;
      }
      #${uiPrefix}-btn, #${uiPrefix}-sheet-btn {
        background: ${hitColor}; color: #06221f; border: 0; cursor: pointer;
        border-radius: 999px; padding: 12px 22px;
        box-shadow: 0 10px 30px rgba(0,0,0,.35);
        font: 700 15px/1.2 Segoe UI, system-ui, sans-serif;
      }
      #${uiPrefix}-sheet-btn { background: #0f766e; color: #ecfdf5; }
      #${uiPrefix}-btn:hover, #${uiPrefix}-sheet-btn:hover { background: #111827; color: #fff; }
      #${uiPrefix}-btn:disabled, #${uiPrefix}-sheet-btn:disabled { opacity: .65; cursor: wait; }
      #${uiPrefix}-toast, #${uiPrefix}-preview {
        position: fixed; top: 64px; right: 18px; z-index: 2147483646;
        max-width: 380px; border-radius: 12px; padding: 12px 14px;
        box-shadow: 0 10px 30px rgba(0,0,0,.28);
        font: 13px/1.45 Segoe UI, system-ui, sans-serif;
      }
      #${uiPrefix}-toast { background: #111827; color: #f9fafb; }
      #${uiPrefix}-toast.error { background: #7f1d1d; }
      #${uiPrefix}-toast.success { background: #065f46; }
      #${uiPrefix}-preview { background: #fff; color: #111827; width: 380px; max-height: 70vh; overflow: auto; }
      #${uiPrefix}-preview h3 { margin: 0 0 8px; font-size: 14px; }
      #${uiPrefix}-preview table { width: 100%; border-collapse: collapse; }
      #${uiPrefix}-preview td { padding: 4px 0; vertical-align: top; }
      #${uiPrefix}-preview td:first-child { color: #6b7280; width: 44%; padding-right: 8px; }
      #${uiPrefix}-preview .missing { color: #b91c1c; }
    `);
    }

    function toast(message, kind = "info", ms = 4500) {
      const id = `${uiPrefix}-toast`;
      const existing = document.getElementById(id);
      if (existing) existing.remove();
      const el = document.createElement("div");
      el.id = id;
      el.className = kind;
      el.textContent = message;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), ms);
    }

    function showPreview(payload) {
      const id = `${uiPrefix}-preview`;
      const existing = document.getElementById(id);
      if (existing) existing.remove();
      const el = document.createElement("div");
      el.id = id;
      const title = document.createElement("h3");
      title.textContent = "Read from screen";
      el.appendChild(title);
      const table = document.createElement("table");
      const rows = [
        ["Claim Date", payload.claimDate],
        ["Order Time", payload.orderTime],
        ["Customer", payload.customer],
        ["Location", payload.location],
        ["Platform", payload.platform],
        ["Order Number", payload.orderNumber],
        ["Order Value", payload.orderValue],
        ["Dispute Amount", payload.disputeAmount],
        ["Outcome", payload.outcome],
        ["Video Submitted", payload.videoSubmitted],
        ["Reason for Dispute", payload.reasonForDispute],
        ["Reason", payload.reason],
        ["Footage Status", payload.footageStatus],
        ["Why was the Item Prepared Incorrectly?", payload.preparedIncorrectlyWhy],
        ["Wrong, Missing or Incorrect Food Item", payload.wrongFoodItem],
        ["Other reason", payload.otherReason],
        ["Contested / Disputed", payload.alreadyDisputed ? "Yes" : "No"],
      ];
      for (const [k, v] of rows) {
        const tr = document.createElement("tr");
        const tdK = document.createElement("td");
        tdK.textContent = k;
        const tdV = document.createElement("td");
        tdV.textContent = v || "NOT FOUND";
        if (!v) tdV.className = "missing";
        tr.appendChild(tdK);
        tr.appendChild(tdV);
        table.appendChild(tr);
      }
      el.appendChild(table);
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 12000);
    }

    function ensureButtonBar() {
      ensureStyles();
      const id = `${uiPrefix}-btn-bar`;
      let bar = document.getElementById(id);
      if (!bar) {
        bar = document.createElement("div");
        bar.id = id;
        (document.body || document.documentElement).appendChild(bar);
      }
      return bar;
    }

    function injectButton(id, text, onClick) {
      const bar = ensureButtonBar();
      let btn = document.getElementById(id);
      if (!btn) {
        btn = document.createElement("button");
        btn.id = id;
        btn.type = "button";
        bar.appendChild(btn);
      }
      if (btn.textContent !== text) btn.textContent = text;
      btn.onclick = onClick;
      return btn;
    }

    function coercePayload(raw) {
      if (raw == null || raw === "") return null;
      let value = raw;
      if (typeof value === "string") {
        const prefix = platform.clipPrefix || "";
        let text = value;
        if (prefix && text.startsWith(prefix)) text = text.slice(prefix.length);
        const trimmed = text.trim();
        if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
        try {
          value = JSON.parse(trimmed);
        } catch {
          return null;
        }
      }
      if (!value || typeof value !== "object") return null;
      if (value.payload && value.payload.orderNumber) return value.payload;
      if (value.orderNumber) return value;
      return null;
    }

    async function readStoredValue(key) {
      let value = null;
      try {
        if (gmGetValue) value = gmGetValue(key, null);
      } catch (err) {
        log("GM_getValue failed", err);
      }
      if (value && typeof value.then === "function") {
        try {
          value = await value;
        } catch (err) {
          log("GM_getValue promise failed", err);
          value = null;
        }
      }
      if (value != null && value !== "") return value;
      try {
        if (gmGetValueAsync) value = await gmGetValueAsync(key, null);
      } catch (err) {
        log("GM.getValue failed", err);
      }
      return value != null && value !== "" ? value : null;
    }

    function savePayload(payload) {
      const key = platform.storageKey;
      const prefix = platform.clipPrefix || "";
      let plain = payload;
      try {
        plain = JSON.parse(JSON.stringify(payload));
      } catch (err) {
        log("payload serialize failed", err);
      }
      let json = "";
      try {
        json = JSON.stringify(plain);
      } catch (err) {
        log("payload stringify failed", err);
      }
      const write = (storeKey, value) => {
        try {
          if (gmSetValue) gmSetValue(storeKey, value);
        } catch (err) {
          log("GM_setValue failed", err);
        }
        try {
          if (gmSetValueAsync) {
            Promise.resolve(gmSetValueAsync(storeKey, value)).catch((err) => log("GM.setValue failed", err));
          }
        } catch (err) {
          log("GM.setValue failed", err);
        }
      };
      write(key, plain);
      if (json) write(`${key}__json`, json);
      if (json) {
        try {
          if (gmSetClipboard) gmSetClipboard(prefix + json);
        } catch (err) {
          log("clipboard failed", err);
        }
      }
    }

    async function loadPayload() {
      const key = platform.storageKey;
      const prefix = platform.clipPrefix || "";
      const fromStore =
        coercePayload(await readStoredValue(key)) ||
        coercePayload(await readStoredValue(`${key}__json`));
      if (fromStore) return fromStore;
      try {
        const text = await navigator.clipboard.readText();
        if (!text) return null;
        if (prefix && text.startsWith(prefix)) return coercePayload(text.slice(prefix.length));
        return coercePayload(text);
      } catch (err) {
        log("clipboard read failed", err);
      }
      return null;
    }

    function resolveSheetTab(payload) {
      const sheet = platform.sheet || {};
      const haystack = [payload.customer, payload.location, payload.brand]
        .filter(Boolean)
        .join(" ");
      for (const rule of sheet.branchSheetTabs || []) {
        const re = compiledRegex(ruleRegexCache, rule.match, "i");
        if (re && re.test(haystack)) return rule.tab;
      }
      return sheet.defaultSheetTab || "";
    }

    function toDayMonthYear(payload) {
      if (payload.claimDateDash && /^\d{2}-\d{2}-\d{4}$/.test(payload.claimDateDash)) {
        return payload.claimDateDash;
      }
      const parsed = parseClaimDate(payload.claimDateDash || payload.claimDateDMY || payload.claimDate || "");
      return parsed.dash || "";
    }

    function sheetCell(value) {
      const text = String(value == null ? "" : value).replace(/\r\n/g, " ").replace(/\t/g, " ").trim();
      if (/["\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
      return text;
    }

    function sheetRefundReason(payload) {
      // Prefer resolved Workhorse reason (includes user incomplete → Incorrect Item maps)
      const mapped = normalizeSpace(
        payload.reasonForDispute ||
          mapReasonForDispute(canonicalizeReason(payload.refundReasonRaw || payload.refundReason || "")) ||
          mapReasonForDispute(normalizeKey(payload.refundReasonRaw || payload.refundReason || "")) ||
          ""
      );

      const overrides = (platform.sheet && platform.sheet.refundReasonOverrides) || [];
      for (const rule of overrides) {
        const re = compiledRegex(ruleRegexCache, rule.test, "i");
        // Only rewrite from the resolved Workhorse reason — never re-apply raw
        // Deliveroo "incomplete" → Missing Items after the user mapped it to Incorrect Item.
        if (re && mapped && re.test(mapped)) return rule.value;
      }

      if (mapped) return mapped;

      const raw = normalizeSpace(payload.refundReasonRaw || payload.refundReason || "");
      if (/incomplete/i.test(raw)) return "Incorrect Item";
      return raw;
    }

    function buildGoogleSheetRow(payload) {
      const sheet = platform.sheet || {};
      if (!sheet.enabled || !sheet.columns) return "";
      const date = toDayMonthYear(payload);
      const row = {
        Date: date ? `'${date}` : "",
        Location: payload.location || "",
        "# Order Number": payload.orderNumber || "",
        "Refund Reason": sheetRefundReason(payload),
        "With Video?": payload.videoSubmitted || workhorse.videoSubmitted || "No",
        "Footage Status": payload.footageStatus || "",
        Comments: "",
      };
      return sheet.columns.map((header) => sheetCell(row[header])).join("\t");
    }

    function buildSheetTransfer(payload) {
      return {
        extractedAt: new Date().toISOString(),
        tab: resolveSheetTab(payload),
        row: buildGoogleSheetRow(payload),
        orderNumber: payload.orderNumber || "",
        customer: payload.customer || "",
        location: payload.location || "",
        payload,
      };
    }

    function saveSheetTransfer(transfer) {
      const key = platform.sheetStorageKey;
      if (!key) return;
      let plain = transfer;
      try {
        plain = JSON.parse(JSON.stringify(transfer));
      } catch (err) {
        log("sheet serialize failed", err);
      }
      try {
        if (gmSetValue) gmSetValue(key, plain);
      } catch (err) {
        log("sheet GM_setValue failed", err);
      }
      try {
        if (gmSetValueAsync) {
          Promise.resolve(gmSetValueAsync(key, plain)).catch((err) => log("sheet GM.setValue failed", err));
        }
      } catch (err) {
        log("sheet GM.setValue failed", err);
      }
    }

    async function loadSheetTransfer() {
      const key = platform.sheetStorageKey;
      if (!key) return null;
      const transfer = await readStoredValue(key);
      return transfer && transfer.row ? transfer : null;
    }

    function findGoogleSheetTabButton(tabName) {
      if (!tabName) return null;
      const wanted = normalizeKey(tabName);
      const nodes = [
        ...document.querySelectorAll(".docs-sheet-tab, .docs-sheet-tab-name, [role='tab'], .docs-sheet-container .docs-sheet-tab-caption"),
      ];
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        const text = normalizeSpace(el.textContent || el.getAttribute("aria-label") || "");
        if (!text) continue;
        const key = normalizeKey(text);
        if (key === wanted || key.includes(wanted) || wanted.includes(key)) {
          return el.closest(".docs-sheet-tab") || el;
        }
      }
      return null;
    }

    async function activateGoogleSheetTab(tabName) {
      if (!tabName) return { ok: false, reason: "No branch tab matched" };
      const tabBtn = await waitUntil(() => findGoogleSheetTabButton(tabName), 4000, 100);
      if (!tabBtn) return { ok: false, reason: `Tab "${tabName}" not found` };
      safeClick(tabBtn);
      await wait(120);
      return { ok: true, reason: "" };
    }

    function focusSheetPasteCell() {
      const canvas = document.querySelector(".grid-container, .waffle, .docs-texteventtarget-iframe, .cell-input");
      if (canvas) safeClick(canvas);
      const editable = document.querySelector(".cell-input, [contenteditable='true'], .grid-container");
      if (editable && editable.focus) editable.focus();
    }

    function copyTextToClipboard(text) {
      try {
        if (gmSetClipboard) {
          gmSetClipboard(text);
          return true;
        }
      } catch (err) {
        log("GM_setClipboard failed", err);
      }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text);
          return true;
        }
      } catch (err) {
        log("navigator clipboard failed", err);
      }
      return false;
    }

    async function applyPayloadToClaims(payload, options = {}) {
      if (!payload || !payload.orderNumber) {
        toast(`No order payload to fill. Click ${platform.buttonExtract || "Extract"} first.`, "error", 7000);
        return;
      }
      if (claimsFillInFlight) {
        toast("Fill already in progress…", "info", 2500);
        return;
      }
      if (!options.force && lastFilledOrder === payload.orderNumber) {
        toast(`Order ${payload.orderNumber} was already filled. Click Fill again to retry.`, "info", 4000);
        lastFilledOrder = "";
      }
      claimsFillInFlight = true;
      const btn = document.getElementById(`${uiPrefix}-btn`);
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Filling Claims…";
      }
      fastFillMode = options.fast !== false && workhorse.fastFill !== false;
      try {
        const modalReady = await waitUntil(() => getClaimsModal(true), 5000, 30);
        if (!modalReady) {
          throw new Error(`Claims form not found. Click Add New, then ${platform.buttonFill || "Fill"}.`);
        }
        const results = await fillClaimsForm(payload, { ...options, fast: true });
        lastFilledOrder = payload.orderNumber;
        showPreview(payload);
        const entries = Object.entries(results || {});
        if (!entries.length) {
          toast("Fill ran but no fields were processed. Re-paste the latest userscript (run node build-static.js if you edit shared files).", "error", 9000);
          return;
        }
        const failed = entries
          .filter(([, r]) => !r.ok && r.reason !== "empty")
          .map(([k, r]) => (r.reason ? `${k} (${r.reason})` : k));
        const okCount = entries.filter(([, r]) => r.ok).length;
        if (!okCount) {
          toast(`Could not fill any fields: ${failed.slice(0, 6).join(", ") || "unknown"}`, "error", 9000);
        } else if (failed.length) {
          toast(`Filled ${okCount} fields. Still missing: ${failed.slice(0, 5).join(", ")}`, "error", 8000);
        } else {
          toast(`Filled claim ${payload.orderNumber} (${okCount} fields).`, "success");
        }
      } catch (err) {
        toast(`Fill failed: ${err.message || err}`, "error", 8000);
      } finally {
        fastFillMode = false;
        claimsFillInFlight = false;
        if (btn) {
          btn.disabled = false;
          btn.textContent = platform.buttonFill || "Fill Claims";
        }
      }
    }

    /* ---------------------------------------------------------------------- */
    /* Public API                                                             */
    /* ---------------------------------------------------------------------- */

    const api = {
      version: platform.versionLabel,
      hitClass,
      hits,

      get platform() {
        return platform;
      },
      get workhorse() {
        return workhorse;
      },
      get config() {
        return {
          platform,
          workhorse,
          storageKey: platform.storageKey,
          sheetStorageKey: platform.sheetStorageKey,
          clipPrefix: platform.clipPrefix,
          uiPrefix,
          hitColor,
          hitClass,
        };
      },

      /* Utils */
      normalizeSpace,
      normalizeKey,
      compactKey,
      visible,
      ownText,
      wait,
      waitUntil,
      debounce,
      parseMoney,
      extractTime,
      parseClaimDate,
      pageJQuery,
      safeClick,
      isOpSpotPage,
      isGoogleSheetsPage,

      /* Rules */
      canonicalizeReason,
      mapReasonForDispute,
      normalizeCustomerName,
      normalizeLocationName,
      conditionRuleKey,
      resolveOutcomeMatch,
      computeOutcome,
      computeFootageStatus,
      buildDisputeFieldValues,
      enrichPayload,

      /* OpSpot fill */
      getClaimsModal,
      ensureClaimsModal,
      collectFormFields,
      matchFormField,
      resolveFormField,
      controlAfterLabel,
      controlByFieldName,
      controlNearCaption,
      controlForField,
      fieldRow,
      fillLabeledField,
      fillSelect,
      fillYesNo,
      setInputValue,
      bestOption,
      clickMatchingMenuItem,
      fillClaimsForm,
      findVisibleLabel,

      /* Transfer / UI / Sheet */
      savePayload,
      loadPayload,
      toast,
      showPreview,
      ensureStyles,
      injectButton,
      ensureButtonBar,
      applyPayloadToClaims,
      setupOpSpotSaveHooks,
      sheetCell,
      sheetRefundReason,
      buildGoogleSheetRow,
      buildSheetTransfer,
      saveSheetTransfer,
      loadSheetTransfer,
      activateGoogleSheetTab,
      focusSheetPasteCell,
      copyTextToClipboard,
      resolveSheetTab,

      /* State helpers */
      clearHits,
      highlightHits,
      invalidateModalCache,
      resetFillGuards,
    };

    return api;
  }

  const ClaimsCore = {
    create: ClaimsCoreCreate,
  };

  root.ClaimsCore = ClaimsCore;
  if (typeof globalThis !== "undefined" && root !== globalThis) {
    try {
      globalThis.ClaimsCore = ClaimsCore;
    } catch {
      /* ignore */
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this);
/* ==== END INLINED SHARED ==== */

/**
 * Pages
 *   Uber Eats: https://merchants.ubereats.com/manager/orders/...
 *   OpSpot:    https://opspot.workhorselive.com/sysTable.php?sys_module_id=10000&sys_data_entity_id=10000#
 *
 * You must be logged in on both. The login screens have no order data.
 * Self-contained: presets + core are inlined below (run `node build-static.js` after editing shared files).
 */

(function () {
  "use strict";

  const root =
    (typeof globalThis !== "undefined" && globalThis.ClaimsCore && globalThis) ||
    (typeof window !== "undefined" && window.ClaimsCore && window) ||
    (typeof unsafeWindow !== "undefined" && unsafeWindow.ClaimsCore && unsafeWindow) ||
    (typeof globalThis !== "undefined" ? globalThis : window);
  if (!root.ClaimsCore || !root.ClaimsPresets) {
    console.error("[Uber Claims] Shared claims-presets/core failed to load (re-run node build-static.js and re-paste this userscript).");
    return;
  }
  const core = root.ClaimsCore.create("ubereats");
  const {
    normalizeSpace, normalizeKey, visible, ownText, debounce,
    parseMoney, parseClaimDate,
    isOpSpotPage,
    canonicalizeReason, normalizeCustomerName,
    buildDisputeFieldValues, enrichPayload,
    savePayload, loadPayload, toast, showPreview, ensureStyles, injectButton, ensureButtonBar,
    applyPayloadToClaims, setupOpSpotSaveHooks, resetFillGuards,
    clearHits, highlightHits, hits, platform, version,
  } = core;

  const normalizeLocationName =
    typeof core.normalizeLocationName === "function"
      ? core.normalizeLocationName
      : (name) => normalizeSpace(name);

  const uiPrefix = platform.uiPrefix || "ucf";
  const btnId = `${uiPrefix}-btn`;
  const workhorse = core.workhorse;

  let pageLinesCache = null;

  const HEADER_WORDS = /^(quantity|qty|price|item|items|name|category|total|refund reason|refund details)$/i;
  const UI_NOISE = /^(refund details|refund reason|partner refund value|order total|date ordered|order submitted|order timeline|dispute this refund|prepared incorrectly|missing|missing item|missing items|incorrect|incorrect item|incorrect items|food safety complaint|category|quantity|qty|price|item|items|name|total|deliveroo|uber eats|partner hub|marketplace fee|net payout|sales \(incl\. gst\)|chargeback amount|customization reported missing|item reported missing|\d+\s+customization(?:s)?\s+missing)$/i;
  const REASON_ROW_RE = /^(missing|missing item|missing items|prepared incorrectly|incorrect item|incorrect items|incorrect|food safety complaint)$/i;
  const CONTESTED_BODY_RE = /refund\s+contested|appeal submitted|dispute\s+submitted|dispute\s+sent\b|refund\s+appeal/i;

  const ISSUE_ITEM_MISSING_RE = /^item\s+reported\s+missing$/i;
  const ISSUE_CUSTOMIZATION_MISSING_RE = /^customization\s+reported\s+missing$/i;
  const ISSUE_N_CUSTOMIZATIONS_RE = /^\d+\s+customization(?:s)?\s+missing$/i;
  const ITEM_COMPONENT_RE = /^(burger|regular sides|regular drinks|toppings|side|drink|choose your)/i;
  const INVALID_ORDER_CODES = new Set([
    "DETAILS", "ORDER", "SALES", "TOTAL", "PAYOUT", "CUSTOM", "ITEMS", "REFUND",
    "DISPUTE", "CHARGE", "AMOUNT", "DELIVERY", "BURGER", "STATUS", "REVIEW",
    "SUBMIT", "CANCEL", "CLOSED", "ACTIVE", "SEARCH", "FILTER", "REPORT",
  ]);
  const MONTH_ABBR = /(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)$/i;

  /** Uber Manager often shows 12h clock; core extractTime is 24h-only. */
  function extractTime(text) {
    const ampm = String(text || "").match(/\b(\d{1,2}):(\d{2})\s*(AM|PM)\b/i);
    if (ampm) {
      let h = Number.parseInt(ampm[1], 10);
      const m = ampm[2];
      if (/pm/i.test(ampm[3]) && h < 12) h += 12;
      if (/am/i.test(ampm[3]) && h === 12) h = 0;
      return `${String(h).padStart(2, "0")}:${m}`;
    }
    const m = String(text || "").match(/\b([01]?\d|2[0-3]):([0-5]\d)/);
    return m ? `${m[1].padStart(2, "0")}:${m[2]}` : "";
  }

  function isValidItemName(name) {
    const text = normalizeSpace(name);
    if (!text || text.length < 2 || text.length > 80) return false;
    const key = normalizeKey(text);
    if (HEADER_WORDS.test(key) || UI_NOISE.test(key)) return false;
    if (/^£/.test(text) || /^\d+(\.\d{2})?$/.test(text)) return false;
    if (/^order\s*#/i.test(text)) return false;
    if (/^(mon|tue|wed|thu|fri|sat|sun)\b/i.test(text)) return false;
    return true;
  }

  function invalidatePageLines() {
    pageLinesCache = null;
  }

  function pageLinesAll() {
    return ((document.body && document.body.innerText) || "")
      .split(/\n+/)
      .map(normalizeSpace)
      .filter(Boolean);
  }

  function pageLines() {
    if (pageLinesCache) return pageLinesCache;
    const extractionRoot = getExtractionRoot();
    pageLinesCache = ((extractionRoot && extractionRoot.innerText) || "")
      .split(/\n+/)
      .map(normalizeSpace)
      .filter(Boolean);
    return pageLinesCache;
  }

  function valuesAfterLabel(label) {
    const lines = pageLines();
    const wanted = normalizeKey(label);
    const values = [];
    for (let i = 0; i < lines.length - 1; i++) {
      if (normalizeKey(lines[i]) === wanted) values.push(lines[i + 1]);
    }
    return values.filter((v) => v && !HEADER_WORDS.test(v));
  }

  function uniqueBy(items, keyFn) {
    const seen = new Set();
    return items.filter((item) => {
      const key = keyFn(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function isUberEatsPage() {
    return /merchants\.ubereats\.com/i.test(location.host);
  }

  function isUberOrderPage() {
    if (!isUberEatsPage()) return false;
    return /\/manager\/orders\//i.test(location.pathname);
  }

  function normalizeOrderCodeToken(token) {
    let code = String(token || "").toUpperCase().replace(/[,.]$/, "");
    if (MONTH_ABBR.test(code)) code = code.replace(MONTH_ABBR, "");
    if (isLikelyOrderCode(code)) return code;
    const compact = code.match(/^([A-Z]{1,3}\d{2,5}|\d[A-Z0-9]{2,5})/);
    if (compact && isLikelyOrderCode(compact[1])) return compact[1].toUpperCase();
    return "";
  }

  function isLikelyOrderCode(code) {
    const text = String(code || "").toUpperCase();
    if (!/^[A-Z0-9]{4,6}$/.test(text)) return false;
    if (!/[A-Z]/.test(text) || !/\d/.test(text)) return false;
    if (/^(19|20)\d{2}$/.test(text)) return false;
    if (MONTH_ABBR.test(text)) return false;
    if (INVALID_ORDER_CODES.has(text)) return false;
    return true;
  }

  function findOrderNumberInText(text) {
    const normalized = normalizeSpace(text);
    if (!normalized) return "";
    const withLabel = normalized.match(/\border\s+#?\s*([A-Z0-9]{4,8})\b/i);
    if (withLabel) {
      const code = normalizeOrderCodeToken(withLabel[1]);
      if (code) return code;
    }
    const tokens = normalized.match(/\b[A-Z0-9]{4,6}\b/gi) || [];
    for (let i = 0; i < tokens.length; i++) {
      const code = normalizeOrderCodeToken(tokens[i]);
      if (code) return code;
    }
    return "";
  }

  function looksLikeAddress(text) {
    const value = normalizeSpace(text);
    if (!value || value.length < 8) return false;
    if (/,/.test(value)) return true;
    return /\b(road|street|st\.?|ave\.?|avenue|drive|dr\.?|rd\.?|lane|way|boulevard|blvd\.?|place|plaza|highway|hwy)\b/i.test(value);
  }

  function stripOuterParens(text) {
    const value = normalizeSpace(text);
    const m = value.match(/^\((.+)\)$/);
    return m ? normalizeSpace(m[1]) : value;
  }

  function parseBrandLocation(text) {
    const line = normalizeSpace(text);

    // Burger King (East Tamaki) (68 East Tamaki Road, Papatoetoe, Auckland)
    const dual = line.match(/^(.+?\([^)]+\))\s*\((.+)\)\s*$/);
    if (dual && looksLikeAddress(dual[2])) {
      return { customer: normalizeSpace(dual[1]), location: normalizeSpace(dual[2]) };
    }

    // Legacy: Brand (Store area) when the paren is not a street address
    const paren = line.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    if (paren) {
      const inside = normalizeSpace(paren[2]);
      if (looksLikeAddress(inside)) {
        return { customer: normalizeSpace(paren[1]), location: inside };
      }
      return { customer: line, location: "" };
    }

    if (line.includes(" - ")) {
      const parts = line.split(" - ").map(normalizeSpace);
      return { customer: parts[0] || "", location: parts.slice(1).join(" - ") || "" };
    }
    return { customer: line, location: "" };
  }

  function extractBrandAndLocation() {
    const extractionRoot = getExtractionRoot();
    const dateRe = /[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}|\d{1,2},?\s+[A-Za-z]{3,9},?\s+\d{4}/;

    const tryPair = (customerText, locationText, el) => {
      const customer = normalizeSpace(customerText);
      let storeLocation = stripOuterParens(locationText);
      if (!customer || customer.length > 90) return null;
      if (/order placed|delivery details|order details|sales \(incl/i.test(customer)) return null;
      if (!storeLocation || !looksLikeAddress(storeLocation)) return null;
      hits.push({
        label: "Customer / Location",
        el: el || null,
        valueEl: el || null,
        value: `${customer} | ${storeLocation}`,
      });
      return { customer, location: storeLocation };
    };

    // DOM: find the date under the order heading, then customer below it and address beside it
    const nodes = extractionRoot.querySelectorAll("h1, h2, h3, h4, p, span, div, strong");
    for (let i = 0; i < nodes.length; i++) {
      const dateEl = nodes[i];
      if (!visible(dateEl)) continue;
      const dateText = ownText(dateEl) || normalizeSpace(dateEl.textContent);
      if (!dateText || dateText.length > 40 || !dateRe.test(dateText)) continue;

      const parent = dateEl.parentElement;
      const siblings = parent ? [...parent.children] : [];
      const dateIdx = siblings.indexOf(dateEl);
      const after = dateIdx >= 0 ? siblings.slice(dateIdx + 1, dateIdx + 6) : [];

      for (let s = 0; s < after.length; s++) {
        const block = after[s];
        if (!visible(block)) continue;
        const blockText = normalizeSpace(block.innerText || block.textContent);
        const dual = parseBrandLocation(blockText);
        if (dual.customer && dual.location) {
          hits.push({ label: "Customer / Location", el: block, valueEl: block, value: blockText });
          return dual;
        }

        const kids = [...block.querySelectorAll("span, div, p, strong, a")].filter(visible);
        for (let a = 0; a < kids.length; a++) {
          for (let b = a + 1; b < Math.min(kids.length, a + 4); b++) {
            const left = ownText(kids[a]) || normalizeSpace(kids[a].textContent);
            const right = ownText(kids[b]) || normalizeSpace(kids[b].textContent);
            const paired = tryPair(left, right, block);
            if (paired) return paired;
          }
        }

        const next = after[s + 1];
        if (next && visible(next)) {
          const left = ownText(block) || normalizeSpace(block.textContent);
          const right = ownText(next) || normalizeSpace(next.textContent);
          const paired = tryPair(left, right, block);
          if (paired) return paired;
        }
      }
    }

    // Lines: date, then customer, then address (or both on one line)
    const lines = pageLines();
    for (let i = 0; i < lines.length - 1; i++) {
      if (!dateRe.test(lines[i]) || lines[i].length > 40) continue;

      const combined = parseBrandLocation(lines[i + 1]);
      if (combined.customer && combined.location) return combined;

      const paired = tryPair(lines[i + 1], lines[i + 2] || "");
      if (paired) return paired;
    }

    // Fallback: Brand (Store area) only when no street address is present
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (!visible(el)) continue;
      const text = ownText(el) || normalizeSpace(el.textContent);
      if (!text || text.length > 90) continue;
      if (!/\(.+\)/.test(text)) continue;
      if (/order placed|delivery details|order details|sales \(incl/i.test(text)) continue;
      if (looksLikeAddress(text)) continue;
      const paren = text.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
      if (paren && !looksLikeAddress(paren[2])) {
        hits.push({ label: "Customer / Location", el, valueEl: el, value: text });
        return { customer: text, location: normalizeSpace(paren[2]) };
      }
    }

    return { customer: "", location: "" };
  }

  function parseOrderHeadingText(text) {
    const normalized = normalizeSpace(text);
    if (normalized.length > 32) return "";
    const exact = normalized.match(/^Order\s+#?\s*([A-Z0-9]{4,6})$/i);
    if (exact) return normalizeOrderCodeToken(exact[1]);
    const prefix = normalized.match(/^Order\s+#?\s*(\S+)/i);
    if (prefix) return normalizeOrderCodeToken(prefix[1]);
    return "";
  }

  function panelFromHeadingEl(headingEl) {
    let node = headingEl;
    let best = headingEl;
    for (let depth = 0; depth < 14 && node; depth++) {
      if (node === document.body || node === document.documentElement) break;
      const block = normalizeSpace(node.innerText || "");
      if (/order placed by customer/i.test(block) && /order details|delivery details|sales \(incl/i.test(block)) {
        best = node;
      }
      node = node.parentElement;
    }
    return best;
  }

  function findActiveOrderHeading() {
    const nodes = document.querySelectorAll("h1, h2, h3, h4, p, span, div, strong, button");
    let best = null;
    let bestScore = -1;

    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (!visible(el)) continue;

      let code = parseOrderHeadingText(normalizeSpace(el.textContent));
      if (!code) {
        const own = ownText(el);
        if (own) code = normalizeOrderCodeToken(own);
        if (code) {
          const prev = el.previousElementSibling;
          const parentText = el.parentElement ? normalizeSpace(el.parentElement.textContent) : "";
          const nearOrderLabel =
            (prev && /^order$/i.test(normalizeSpace(prev.textContent))) ||
            /^order\s+#?\s*$/i.test(parentText.replace(own, "").trim());
          if (!nearOrderLabel) code = "";
        }
      }
      if (!code) continue;

      const headingText = normalizeSpace(el.textContent);
      const rect = el.getBoundingClientRect();
      let score = rect.left + rect.top + Math.max(0, 120 - headingText.length);
      let panel = el;
      let node = el.parentElement;
      for (let depth = 0; depth < 14 && node; depth++) {
        const block = node.innerText || "";
        if (/order placed by customer/i.test(block)) score += 200;
        if (/order details|delivery details/i.test(block)) score += 80;
        if (/item reported missing|customization reported missing/i.test(block)) score += 40;
        if (/sales \(incl|chargeback amount/i.test(block)) score += 30;
        if (/order placed by customer/i.test(block) && /order details|sales \(incl/i.test(block)) {
          panel = node;
        }
        node = node.parentElement;
      }

      if (score > bestScore) {
        bestScore = score;
        best = { code, el, panel: panelFromHeadingEl(el) || panel };
      }
    }
    return best;
  }

  function getActiveOrderRoot() {
    const heading = findActiveOrderHeading();
    if (heading && heading.panel) {
      let best = heading.panel;
      const text = normalizeSpace(best.innerText || "").toLowerCase();
      if (!/sales \(incl/i.test(text) && !/chargeback amount/i.test(text)) {
        let node = best.parentElement;
        for (let depth = 0; depth < 6 && node; depth++) {
          if (node === document.body || node === document.documentElement) break;
          const parentText = normalizeSpace(node.innerText || "").toLowerCase();
          if (/sales \(incl/i.test(parentText) || /chargeback amount/i.test(parentText)) {
            best = node;
            break;
          }
          node = node.parentElement;
        }
      }
      return best;
    }

    const markers = [
      "order placed by customer",
      "order details",
      "delivery details",
      "sales (incl. gst)",
      "chargeback amount",
    ];
    const candidates = [];

    const addCandidate = (el) => {
      if (!el || el === document.body || el === document.documentElement) return;
      if (!visible(el)) return;
      candidates.push(el);
    };

    const nodes = document.querySelectorAll("h1, h2, h3, h4, p, span, div, section, aside, [role='dialog']");
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (!visible(el)) continue;
      const text = normalizeSpace(el.textContent).toLowerCase();
      if (!markers.some((marker) => text.includes(marker))) continue;
      let node = el;
      let bestNode = el;
      for (let depth = 0; depth < 12 && node; depth++) {
        const block = normalizeSpace(node.innerText || "").toLowerCase();
        if (block.includes("order placed") && (block.includes("sales") || block.includes("order details"))) {
          bestNode = node;
        }
        node = node.parentElement;
      }
      addCandidate(bestNode);
    }

    let best = null;
    let bestScore = -1;
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      const rect = el.getBoundingClientRect();
      const area = rect.width * rect.height;
      const text = normalizeSpace(el.innerText || "").toLowerCase();
      const orderCodes = text.match(/\border\s+#?\s*[a-z0-9]{4,8}\b/gi) || [];
      if (orderCodes.length > 2) continue;

      let score = 0;
      if (/order placed by customer/i.test(text)) score += 50;
      if (/order details/i.test(text)) score += 30;
      if (/sales \(incl/i.test(text)) score += 20;
      if (/chargeback amount/i.test(text)) score += 15;
      if (/\border\s+#?\s*[a-z0-9]{4,8}\b/i.test(text)) score += 40;
      if (area > 10000 && area < window.innerWidth * window.innerHeight * 0.95) score += 10;
      if (rect.left > window.innerWidth * 0.25) score += 15;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }

    if (best) {
      const text = normalizeSpace(best.innerText || "").toLowerCase();
      if (!/sales \(incl/i.test(text) && !/chargeback amount/i.test(text)) {
        let node = best.parentElement;
        for (let depth = 0; depth < 6 && node; depth++) {
          if (node === document.body || node === document.documentElement) break;
          const parentText = normalizeSpace(node.innerText || "").toLowerCase();
          if (/sales \(incl/i.test(parentText) || /chargeback amount/i.test(parentText)) {
            best = node;
            break;
          }
          node = node.parentElement;
        }
      }
    }
    return best;
  }

  function getExtractionRoot() {
    const heading = findActiveOrderHeading();
    if (heading && heading.panel) return heading.panel;
    return getActiveOrderRoot() || document.body;
  }

  function extractOrderNumber() {
    const heading = findActiveOrderHeading();
    if (heading && heading.code) {
      hits.push({ label: "Order Number", el: heading.el, valueEl: heading.el, value: heading.code });
      return heading.code;
    }

    const orderRoot = getActiveOrderRoot();
    if (orderRoot) {
      const nodes = orderRoot.querySelectorAll("h1, h2, h3, h4, p, span, div, strong, button");
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        if (!visible(el)) continue;
        const code = parseOrderHeadingText(normalizeSpace(el.textContent));
        if (code) {
          hits.push({ label: "Order Number", el, valueEl: el, value: code });
          return code;
        }
      }
      const fromPanel = findOrderNumberInText(orderRoot.innerText || "");
      if (fromPanel) return fromPanel;
    }

    const uuid = location.pathname.match(/\/orders\/([a-f0-9-]+)/i);
    if (uuid) {
      const tail = uuid[1].replace(/-/g, "").slice(-5).toUpperCase();
      if (isLikelyOrderCode(tail)) return tail;
    }
    return findOrderNumberInText((document.body && document.body.innerText) || "");
  }

  function extractClaimDateRaw() {
    const monthDate = (document.body.innerText || "").match(
      /([A-Za-z]{3,9})\s+\d{1,2},?\s+\d{4}|\d{1,2},?\s+[A-Za-z]{3,9},?\s+\d{4}/
    );
    if (monthDate) return monthDate[0];
    const lines = pageLines();
    return lines.find((line) => /[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}/.test(line)) || "";
  }

  function extractOrderPlacedTime() {
    const lines = pageLines();
    for (let i = 0; i < lines.length; i++) {
      if (!/order placed by customer/i.test(lines[i])) continue;
      const time = extractTime(lines[i]) || extractTime(lines[i - 1] || "") || extractTime(lines[i + 1] || "");
      if (time) {
        hits.push({ label: "Order Time", el: null, valueEl: null, value: time });
        return time;
      }
    }
    return extractTime(document.body.innerText);
  }

  function readLabeledMoneyFromLines(lines, labels) {
    const lineKey = (line) =>
      normalizeKey(line)
        .replace(/\s*dispute\s*$/i, "")
        .replace(/\s+/g, " ")
        .trim();

    for (const label of labels) {
      const wanted = normalizeKey(label);
      for (let i = 0; i < lines.length - 1; i++) {
        const key = lineKey(lines[i]);
        if (key !== wanted && !key.startsWith(wanted)) continue;
        const amount = parseMoney(lines[i + 1]) ?? parseMoney(lines[i]);
        if (amount != null) return amount;
      }
      const inline = lines.find((line) => {
        const key = lineKey(line);
        return key === wanted || key.startsWith(wanted) || normalizeKey(line).includes(wanted);
      });
      if (inline) {
        const amount = parseMoney(inline);
        if (amount != null) return amount;
      }
    }
    return null;
  }

  function readLabeledMoney(labels) {
    const fromPanel = readLabeledMoneyFromLines(pageLines(), labels);
    if (fromPanel != null) return fromPanel;
    return readLabeledMoneyFromLines(pageLinesAll(), labels);
  }

  function extractDisputeAmount() {
    const scanLines = (lines) => {
      for (let i = 0; i < lines.length; i++) {
        if (!/chargeback\s*amount/i.test(lines[i])) continue;
        const amount = parseMoney(lines[i + 1]) ?? parseMoney(lines[i]);
        if (amount != null) return Math.abs(amount);
      }
      for (const line of lines) {
        if (!/chargeback\s*amount|refund|adjustment|issue payout/i.test(line)) continue;
        const amount = parseMoney(line);
        if (amount != null) return Math.abs(amount);
      }
      return null;
    };

    const fromPanel = scanLines(pageLines());
    if (fromPanel != null) return fromPanel;
    const fromBody = scanLines(pageLinesAll());
    if (fromBody != null) return fromBody;

    const chargeback = readLabeledMoney([
      "Chargeback Amount (incl. GST) Dispute",
      "Chargeback Amount (incl. GST)Dispute",
      "Chargeback Amount (incl. GST)",
      "Chargeback Amount (incl GST)",
      "Chargeback Amount",
      "Chargeback amount",
    ]);
    if (chargeback != null) return Math.abs(chargeback);

    const refund = readLabeledMoney([
      "Refund amount",
      "Customer refund",
      "Refund total",
      "Adjustment amount",
      "Issue refund",
      "Refund issued",
    ]);
    if (refund != null) return Math.abs(refund);
    return null;
  }

  function isIssueMarkerLine(line) {
    return (
      ISSUE_ITEM_MISSING_RE.test(line) ||
      ISSUE_CUSTOMIZATION_MISSING_RE.test(line) ||
      ISSUE_N_CUSTOMIZATIONS_RE.test(line)
    );
  }

  function isComponentLine(line) {
    const text = normalizeSpace(line);
    if (!text) return true;
    if (ITEM_COMPONENT_RE.test(text)) return true;
    if (/^\d+\s+\S/.test(text) && !/(?:NZ\$|\$|£|€)\s*\d/.test(text)) return true;
    return false;
  }

  function parsePricedItemName(line) {
    const priceMatch = line.match(/^(.+?)\s+(?:NZ\$|\$|£|€)\s*(\d+(?:\.\d{2})?)$/);
    if (!priceMatch) return "";
    const name = normalizeSpace(priceMatch[1]);
    return isValidItemName(name) ? name : "";
  }

  function findIssueItemNameBefore(lines, fromIndex, kind) {
    for (let i = fromIndex - 1; i >= Math.max(0, fromIndex - 20); i--) {
      const line = lines[i];
      if (isIssueMarkerLine(line)) break;
      if (isComponentLine(line)) continue;

      const pricedName = parsePricedItemName(line);
      if (pricedName) {
        if (kind === "item") return pricedName;
        if (kind === "customization" && /value meal|meal|combo|regular/i.test(pricedName)) return pricedName;
      }

      if (/(?:NZ\$|\$|£|€)\s*\d/.test(line) && i > 0) {
        const prev = normalizeSpace(lines[i - 1]);
        if (isValidItemName(prev)) {
          if (kind === "item") return prev;
          if (kind === "customization" && /value meal|meal|combo|regular/i.test(prev)) return prev;
        }
      }

      const name = normalizeSpace(line);
      if (!isValidItemName(name)) continue;

      if (kind === "customization") {
        if (/value meal|meal|combo|regular/i.test(name)) return name;
        const next = lines[i + 1] || "";
        if (!/(?:NZ\$|\$|£|€)\s*\d/.test(next) && !ISSUE_CUSTOMIZATION_MISSING_RE.test(next)) return name;
        continue;
      }

      const hasPriceNearby = [lines[i + 1], lines[i + 2]].some((near) => near && /(?:NZ\$|\$|£|€)\s*\d/.test(near));
      if (hasPriceNearby || pricedName) return name;
    }
    return "";
  }

  function scanIssueItems(lines, reasonFromPage) {
    const issueItems = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (ISSUE_ITEM_MISSING_RE.test(line)) {
        const name = findIssueItemNameBefore(lines, i, "item");
        if (name) {
          issueItems.push({
            name,
            issue: "item reported missing",
            reason: canonicalizeReason("item reported missing"),
          });
        }
        continue;
      }
      if (ISSUE_CUSTOMIZATION_MISSING_RE.test(line)) {
        const name = findIssueItemNameBefore(lines, i, "customization");
        if (name) {
          issueItems.push({
            name,
            issue: "customization reported missing",
            reason: canonicalizeReason("customization reported missing"),
          });
        }
      }
    }
    return uniqueBy(issueItems, (item) => normalizeKey(item.name)).map((item) => ({
      ...item,
      reason: item.reason || (reasonFromPage ? canonicalizeReason(reasonFromPage) : ""),
    }));
  }

  function extractIssueItems() {
    const reasonFromPage = extractRefundReasonRaw();
    const fromPanel = scanIssueItems(pageLines(), reasonFromPage);
    if (fromPanel.length) return fromPanel;
    return scanIssueItems(pageLinesAll(), reasonFromPage);
  }

  function extractOrderItems() {
    const issueItems = extractIssueItems();
    if (issueItems.length) return issueItems;

    const lines = pageLines();
    const reasonFromPage = extractRefundReasonRaw();
    const items = [];

    for (let i = 0; i < lines.length; i++) {
      const priceMatch = lines[i].match(/^(.+?)\s+(?:NZ\$|\$|£|€)\s*(\d+(?:\.\d{2})?)$/);
      if (!priceMatch) continue;
      const name = normalizeSpace(priceMatch[1]);
      if (!isValidItemName(name)) continue;
      if (/^(sales|marketplace fee|net payout|subtotal|total|tax|gst)/i.test(name)) continue;
      items.push({
        name,
        reason: reasonFromPage ? canonicalizeReason(reasonFromPage) : "",
      });
    }

    return uniqueBy(items, (item) => normalizeKey(item.name));
  }

  function extractRefundReasonRaw() {
    const lines = pageLines();
    const body = getExtractionRoot().innerText || "";
    if (/item\s+reported\s+missing/i.test(body)) return "Item reported missing";
    if (/customization(?:s)?\s+(?:reported\s+)?missing/i.test(body)) {
      return "Customization reported missing";
    }
    const issuePatterns = [
      /^item\s+reported\s+missing$/i,
      /customization(?:s)?\s+(?:reported\s+)?missing/i,
      /^\d+\s+customization/i,
      /^missing item/i,
      /^missing items/i,
      /^wrong order/i,
      /^wrong item/i,
      /^poor food quality/i,
      /^food quality/i,
      /^food safety/i,
      /^incorrect item/i,
      /^prepared incorrectly/i,
    ];
    for (const line of lines) {
      if (issuePatterns.some((re) => re.test(line))) return line;
    }
    for (let i = 0; i < lines.length; i++) {
      if (/issue type|refund reason|customer feedback|complaint reason/i.test(lines[i]) && lines[i + 1]) {
        return lines[i + 1];
      }
    }
    return "";
  }

  function itemsMatchingReason(items, refundReason) {
    const wanted = canonicalizeReason(refundReason);
    const matched = (items || []).filter(
      (item) => item && item.name && isValidItemName(item.name) && canonicalizeReason(item.reason) === wanted
    );
    if (matched.length) return matched;
    return (items || []).filter((item) => item && item.name && isValidItemName(item.name));
  }

  function detectAlreadyDisputed() {
    const bodyText = (document.body && document.body.innerText) || "";
    if (CONTESTED_BODY_RE.test(bodyText)) return true;

    const nodes = document.querySelectorAll("span, div, p, li, strong, button");
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (!visible(el)) continue;
      const text = normalizeSpace(el.textContent);
      if (!text || text.length > 60) continue;
      if (/dispute this refund/i.test(text)) continue;
      if (/^disputed$/i.test(text) || /^refund\s+contested$/i.test(text) || /dispute\s+sent/i.test(text) || /appeal submitted/i.test(text)) return true;
    }
    return false;
  }

  function extractRefundPayload() {
    clearHits();
    invalidatePageLines();
    const errors = [];

    const orderNumber = extractOrderNumber();
    if (!orderNumber) errors.push("Order Number");

    const { customer: rawCustomer, location: storeLocationRaw } = extractBrandAndLocation();
    const customer = normalizeCustomerName(rawCustomer);
    const storeLocation = normalizeLocationName(storeLocationRaw);
    if (!customer) errors.push("Customer");
    if (!storeLocation) errors.push("Location");

    const dateRaw = extractClaimDateRaw();
    const claimDate = parseClaimDate(dateRaw);
    if (!claimDate.iso) errors.push("Order date");

    let orderTime = extractOrderPlacedTime();
    if (!orderTime) errors.push("Order placed time");

    const orderValue =
      readLabeledMoney(["Sales (incl. GST)", "Sales (incl GST)", "Subtotal", "Order total"]) ||
      readLabeledMoney(["Net payout"]);
    if (orderValue == null) errors.push("Sales total");

    const disputeAmount = extractDisputeAmount();

    const items = extractOrderItems();
    const reasonRaw = extractRefundReasonRaw();
    const itemReason = (items.find((item) => item && item.reason) || {}).reason || "";
    const refundReason = canonicalizeReason(reasonRaw) || itemReason || "";

    const alreadyDisputed = detectAlreadyDisputed();
    highlightHits();

    const matchedItems = itemsMatchingReason(items, refundReason);
    const disputeFields = buildDisputeFieldValues(matchedItems, refundReason, customer, storeLocation);

    const payload = enrichPayload({
      extractedAt: new Date().toISOString(),
      sourceUrl: window.location.href,
      claimDate: claimDate.raw,
      claimDateISO: claimDate.iso,
      claimDateDMY: claimDate.dmy,
      claimDateDash: claimDate.dash,
      orderTime,
      customer,
      location: storeLocation,
      platform: platform.platform,
      orderNumber,
      orderValue: orderValue == null ? "" : orderValue.toFixed(2),
      disputeAmount: disputeAmount == null ? "" : disputeAmount.toFixed(2),
      refundReason,
      alreadyDisputed,
      videoSubmitted: workhorse.videoSubmitted || "No",
      wrongFoodItem: disputeFields.wrongFoodItem,
      preparedIncorrectlyWhy: disputeFields.preparedIncorrectlyWhy,
      reason: disputeFields.reason || "",
      otherReason: disputeFields.otherReason,
      items,
      errors,
    });

    return payload;
  }

  function mount() {
    const body = document.body;
    if (!body) {
      document.addEventListener("DOMContentLoaded", mount, { once: true });
      return;
    }

    ensureButtonBar();

    const existing = document.getElementById(btnId);
    if (existing && existing.onclick) return;

    if (isOpSpotPage()) {
      injectButton(btnId, platform.buttonFill || "Fill from Uber Eats", async () => {
        resetFillGuards();
        const payload = await loadPayload();
        if (!payload) {
          toast(`No stored order. Click ${platform.buttonExtract || "Extract Order → OpSpot"} on the Uber Eats tab first, then click here.`, "error", 7000);
          return;
        }
        await applyPayloadToClaims(payload, { force: true });
      });
      return;
    }

    if (isUberEatsPage()) {
      injectButton(btnId, platform.buttonExtract || "Extract Order → OpSpot", onExtractClick);
    }
  }

  function boot() {
    ensureStyles();
    if (typeof GM_registerMenuCommand === "function") {
      if (typeof location !== "undefined" && /opspot/i.test(location.host)) {
        GM_registerMenuCommand(platform.buttonFill || "Fill from Uber Eats", async () => {
          resetFillGuards();
          const payload = await loadPayload();
          if (!payload) {
            toast("No stored order. Run Extract Order on the Uber Eats tab first.", "error", 7000);
            return;
          }
          await applyPayloadToClaims(payload, { force: true });
        });
      } else {
        GM_registerMenuCommand(platform.buttonExtract || "Extract Order → OpSpot", onExtractClick);
      }
    }
    const remount = debounce(mount, 400);
    let observerQueued = false;
    const wrap = (fn) =>
      function patched() {
        const ret = fn.apply(this, arguments);
        remount();
        return ret;
      };
    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
    window.addEventListener("popstate", remount);
    window.addEventListener("load", mount);
    new MutationObserver(() => {
      if (observerQueued) return;
      observerQueued = true;
      requestAnimationFrame(() => {
        observerQueued = false;
        if (!document.getElementById(btnId)) remount();
      });
    }).observe(document.documentElement, { childList: true, subtree: true });
    if (typeof GM_addValueChangeListener === "function") {
      GM_addValueChangeListener(platform.storageKey, (_n, _o, value, remote) => {
        if (remote && isOpSpotPage() && value) {
          let payload = value;
          if (typeof payload === "string") {
            try {
              payload = JSON.parse(payload);
            } catch {
              return;
            }
          }
          if (!payload || !payload.orderNumber) return;
          resetFillGuards();
          applyPayloadToClaims(payload, { force: true });
        }
      });
    }
    setupOpSpotSaveHooks({
      onNeedNextExtractMessage: "Run Extract Order on the Uber Eats order tab first.",
    });
    mount();
  }

  async function onExtractClick() {
    const btn = document.getElementById(btnId);
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Reading screen…";
    }
    try {
      const payload = extractRefundPayload();
      showPreview(payload);
      savePayload(payload);
      if (payload.errors.length) toast(`UI miss: ${payload.errors.join(", ")}`, "error", 7000);
      else toast(`v${version || "2.0.0"} stored order #${payload.orderNumber}. Click ${platform.buttonFill || "Fill from Uber Eats"} on OpSpot.`, "success", 7000);
    } catch (err) {
      toast(`Extraction failed: ${err.message || err}`, "error");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = platform.buttonExtract || "Extract Order → OpSpot";
      }
    }
  }

  boot();
})();
