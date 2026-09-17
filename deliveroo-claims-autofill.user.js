// ==UserScript==
// @name         Deliveroo Refund → OpSpot Claims Auto-Fill
// @namespace    https://local.claims-ops
// @version      2.4.0
// @description  Read Deliveroo refunds, map fields/conditions (incl. location aliases) to Workhorse, fill OpSpot, copy Sheets.
// @author       Claims Ops
// @match        https://partner-hub.deliveroo.com/*
// @match        https://partner-hub.deliveroo.com/orders/refunds/*
// @match        *://partner-hub.deliveroo.com/*
// @match        *://*.partner-hub.deliveroo.com/*
// @match        *://restaurant-hub.deliveroo.com/*
// @match        *://*.deliveroo.com/*
// @match        *://*.deliveroo.co.uk/*
// @match        https://opspot.workhorselive.com/*
// @match        https://opspot.workhorselive.com/sysTable.php*
// @match        *://opspot.workhorselive.com/*
// @match        *://*.workhorselive.com/*
// @match        https://docs.google.com/spreadsheets/*
// @match        *://docs.google.com/spreadsheets/*
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
          "Restaurant",
          "Location",
          "# Order Number",
          "Refund Reason",
          "With Video?",
          "Footage Status",
          "Work Type",
          "Comments",
        ],
        /** Default for the sheet “Work Type” dropdown */
        workType: "Deliveroo",
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
      versionLabel: "1.0.9",
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
        Restaurant: payload.customer || "",
        Location: payload.location || "",
        "# Order Number": payload.orderNumber || "",
        "Order Number": payload.orderNumber || "",
        "#": "",
        "Refund Reason": sheetRefundReason(payload),
        "With Video?": "",
        "Footage Status": payload.footageStatus || "",
        "Work Type": sheet.workType || platform.platform || "",
        Comments: "",
      };
      return sheet.columns.map((header) => sheetCell(row[header] != null ? row[header] : "")).join("\t");
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
 *   Deliveroo: https://partner-hub.deliveroo.com/orders/refunds/...
 *   OpSpot:    https://opspot.workhorselive.com/sysTable.php?sys_module_id=10000&sys_data_entity_id=10000#
 *   Sheets:    https://docs.google.com/spreadsheets/d/... (Refund_Dispute_Log_2)
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
    console.error("[Deliveroo Claims] Shared claims-presets/core failed to load (re-run node build-static.js and re-paste this userscript).");
    return;
  }
  const core = root.ClaimsCore.create("deliveroo");
  const {
    normalizeSpace, normalizeKey, compactKey, visible, ownText, wait, waitUntil, debounce,
    parseMoney, extractTime, parseClaimDate, safeClick, findVisibleLabel,
    isOpSpotPage, isGoogleSheetsPage,
    canonicalizeReason, normalizeCustomerName, computeOutcome, computeFootageStatus, resolveOutcomeMatch,
    buildDisputeFieldValues, mapReasonForDispute,
    savePayload, loadPayload, toast, showPreview, ensureStyles, injectButton, ensureButtonBar,
    applyPayloadToClaims, setupOpSpotSaveHooks, resetFillGuards,
    buildSheetTransfer, saveSheetTransfer, loadSheetTransfer, activateGoogleSheetTab,
    focusSheetPasteCell, copyTextToClipboard,
    clearHits, highlightHits, hits, hitClass, platform, version,
  } = core;

  const normalizeLocationName =
    typeof core.normalizeLocationName === "function"
      ? core.normalizeLocationName
      : function fallbackNormalizeLocationName(name) {
          const text = normalizeSpace(name);
          if (!text) return "";
          const aliases = (platform && platform.locationAliases) || [];
          for (const rule of aliases) {
            if (!rule || !rule.match || !rule.value) continue;
            try {
              const re = rule.match instanceof RegExp ? rule.match : new RegExp(String(rule.match), "i");
              if (re.test(text)) return normalizeSpace(rule.value);
            } catch {
              if (normalizeKey(text) === normalizeKey(rule.match)) return normalizeSpace(rule.value);
            }
          }
          return text;
        };

  const uiPrefix = platform.uiPrefix || "dcf";
  const btnId = `${uiPrefix}-btn`;
  const sheetBtnId = `${uiPrefix}-sheet-btn`;
  const mapBtnId = `${uiPrefix}-map-btn`;
  const mapPanelId = `${uiPrefix}-map-panel`;
  const FIELD_MAP_KEY = "deliveroo_user_field_map_v1";
  const CONDITIONS_KEY = "deliveroo_user_conditions_v1";
  const workhorse = core.workhorse;

  /** Workhorse fields you can point at Deliveroo page text */
  const MAPPABLE_FIELDS = [
    { key: "orderNumber", label: "Order Number", kind: "orderNumber" },
    { key: "customer", label: "Customer", kind: "text" },
    { key: "location", label: "Location", kind: "text" },
    { key: "claimDate", label: "Claim Date", kind: "date" },
    { key: "orderTime", label: "Order Time", kind: "time" },
    { key: "orderValue", label: "Order Value", kind: "money" },
    { key: "disputeAmount", label: "Dispute Amount", kind: "money" },
    { key: "refundReason", label: "Refund Reason → Reason for Dispute", kind: "reason" },
    { key: "otherReason", label: "Other reason (item text)", kind: "text" },
  ];

  let pageLinesCache = null;
  let mapPickKey = null;
  let mapPickHandler = null;
  let userFieldMapCache = null;
  let userConditionsCache = null;
  let mapPanelPos = { top: 64, left: 18 };
  let mapPanelTab = "fields";

  const HEADER_WORDS = /^(quantity|qty|price|item|items|name|category|total|refund reason|refund details)$/i;
  const UI_NOISE = /^(refund details|refund reason|partner refund value|order total|date ordered|order submitted|order timeline|dispute this refund|prepared incorrectly|missing|missing item|missing items|incomplete|incomplete item|incomplete items|incorrect|incorrect item|incorrect items|food safety complaint|category|quantity|qty|price|item|items|name|total|deliveroo|partner hub)$/i;
  const REASON_ROW_RE = /^(missing|missing item|missing items|incomplete|incomplete item|incomplete items|prepared incorrectly|incorrect item|incorrect items|incorrect|food safety complaint)$/i;
  const CONTESTED_BODY_RE = /refund\s+contested|refund\s+dispute\s+was\s+successfully\s+submitted|dispute\s+sent\b|partner refund value[\s\S]{0,80}\bdisputed\b/i;
  const MENU_CATEGORIES = /^(drinks?|burgers?|sandwiches?|sides?|desserts?|fries|wings|box meals?|milkshakes?|saucin['’]? wings|world famous sandwiches|starters?|mains?|kids?|combos?|meals?|snacks?|sauces?)$/i;

  function isMoneyText(text) {
    const value = normalizeSpace(text);
    if (!value) return false;
    if (/^(?:NZ\$|A\$|US\$|€|£|\$)\s*\d/.test(value)) return true;
    if (/^\d+[.,]\d{2}$/.test(value)) return true;
    if (/^-?\s*(?:NZ\$|A\$|US\$|€|£|\$)\s*\d/.test(value)) return true;
    return false;
  }

  function firstItemNameLine(text) {
    const line = normalizeSpace(String(text || "").split(/\n/)[0]);
    return line.replace(/\s+(?:NZ\$|A\$|US\$|€|£|\$)\s*\d.*$/, "").trim();
  }

  function itemNamesFrom(items) {
    return [...new Set((items || []).map((item) => item && item.name).filter(Boolean))];
  }

  function isCategoryName(name) {
    return MENU_CATEGORIES.test(normalizeKey(firstItemNameLine(name)));
  }

  function isValidItemName(name) {
    const text = firstItemNameLine(name);
    if (!text || text.length < 2 || text.length > 80) return false;
    const key = normalizeKey(text);
    if (HEADER_WORDS.test(key) || UI_NOISE.test(key)) return false;
    if (isMoneyText(text)) return false;
    if (isCategoryName(text)) return false;
    if (/^order\s*#/i.test(text)) return false;
    if (/^(mon|tue|wed|thu|fri|sat|sun)\b/i.test(text)) return false;
    return true;
  }

  function invalidatePageLines() {
    pageLinesCache = null;
  }

  function pageLines() {
    if (pageLinesCache) return pageLinesCache;
    const hideSelectors = [
      `#${mapPanelId}`,
      `#${uiPrefix}-btn-bar`,
      `#${uiPrefix}-preview`,
      `#${uiPrefix}-toast`,
      `#${uiPrefix}-btn`,
      `#${uiPrefix}-sheet-btn`,
      `#${mapBtnId}`,
    ];
    const hidden = [];
    for (const sel of hideSelectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      hidden.push({ el, display: el.style.display });
      el.style.display = "none";
    }
    try {
      pageLinesCache = ((document.body && document.body.innerText) || "")
        .split(/\n+/)
        .map(normalizeSpace)
        .filter(Boolean);
    } finally {
      for (const row of hidden) row.el.style.display = row.display;
    }
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

  function isDeliverooHub() {
    return /partner-hub\.deliveroo\.com|restaurant-hub\.deliveroo\.com|deliveroo\.(com|co\.uk)/i.test(location.host);
  }

  function isRefundDetailsPage() {
    if (isOpSpotPage()) return false;
    if (!isDeliverooHub()) return false;
    if (/\/orders\/refunds\//i.test(location.pathname)) return true;
    const text = document.body ? document.body.innerText : "";
    return /date ordered/i.test(text) && /partner refund value/i.test(text);
  }

  function findOrderHeading(orderNumber) {
    const selectors = ["h1", "h2", "h3", "h4", "strong", "p", "span"];
    let best = null;
    let bestLen = Infinity;
    for (let s = 0; s < selectors.length; s++) {
      const nodes = document.getElementsByTagName(selectors[s]);
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        if (!visible(el)) continue;
        const text = ownText(el) || normalizeSpace(el.textContent);
        if (text.length < 8 || text.length > 36) continue;
        if (!/^order\s*#\s*\d+$/i.test(text)) continue;
        if (orderNumber && !text.includes(orderNumber)) continue;
        if (text.length < bestLen) {
          best = el;
          bestLen = text.length;
        }
      }
      if (best && s < 4) return best;
    }
    return best;
  }

  function extractOrderNumber() {
    const heading = findOrderHeading();
    const text = heading ? heading.textContent : (pageLines()[0] ? pageLines().join("\n") : document.body.innerText);
    const match = String(text).match(/order\s*#\s*(\d+)/i);
    if (heading) hits.push({ label: "Order Number", el: heading, valueEl: heading, value: match && match[1] });
    return match ? match[1] : "";
  }

  const KNOWN_BRAND_PREFIXES = [
    /^shake\s*shack\b/i,
    /^jollibee\b/i,
    /^popeyes\b/i,
    /^five\s*guys\b/i,
  ];

  function splitBrandLocation(line) {
    const text = normalizeSpace(line);
    if (!text) return { customer: "", location: "" };

    // Preferred: "Shake Shack - Manchester Ardwick"
    const dashed = text.split(/\s*[–—−-]\s*/).map(normalizeSpace).filter(Boolean);
    if (dashed.length >= 2) {
      return {
        customer: dashed[0] || "",
        location: dashed.slice(1).join(" - ") || "",
      };
    }

    // No dash: "Shake Shack Manchester Ardwick"
    for (const re of KNOWN_BRAND_PREFIXES) {
      const m = text.match(re);
      if (!m) continue;
      const customer = normalizeSpace(m[0]);
      const location = normalizeSpace(text.slice(m[0].length));
      if (customer && location) return { customer, location };
    }

    return { customer: "", location: "" };
  }

  function looksLikeBrandLocation(text) {
    const t = normalizeSpace(text);
    if (!t || t.length > 100 || /order\s*#/i.test(t)) return false;
    if (/\s+[–—−-]\s+/.test(t)) return true;
    return KNOWN_BRAND_PREFIXES.some((re) => {
      const m = t.match(re);
      if (!m) return false;
      const rest = normalizeSpace(t.slice(m[0].length));
      return rest.length >= 2 && !HEADER_WORDS.test(rest) && !REASON_ROW_RE.test(rest);
    });
  }

  function extractBrandAndLocation(orderNumber) {
    const heading = findOrderHeading(orderNumber);

    const tryLine = (el) => {
      if (!el || !visible(el)) return null;
      const text = ownText(el) || (el.childElementCount === 0 ? normalizeSpace(el.textContent) : "");
      if (!text || text.length > 80 || /order\s*#/i.test(text)) return null;
      if (!looksLikeBrandLocation(text)) return null;
      const parsed = splitBrandLocation(text);
      if (!parsed.customer || !parsed.location) return null;
      hits.push({ label: "Customer / Location", el, valueEl: el, value: text });
      return parsed;
    };

    if (heading) {
      const nearby = [];
      let sib = heading.nextElementSibling;
      while (sib && nearby.length < 8) {
        nearby.push(sib);
        sib = sib.nextElementSibling;
      }
      if (heading.parentElement) {
        let uncle = heading.parentElement.nextElementSibling;
        let n = 0;
        while (uncle && n < 5) {
          nearby.push(uncle);
          uncle = uncle.nextElementSibling;
          n += 1;
        }
      }

      for (const block of nearby) {
        const direct = tryLine(block);
        if (direct) return direct;
        for (const kid of block.querySelectorAll("h1, h2, h3, h4, p, span, div, strong")) {
          const parsed = tryLine(kid);
          if (parsed) return parsed;
        }
      }
    }

    const lines = pageLines();
    const idx = lines.findIndex(
      (line) => orderNumber && /^order\s*#\s*\d+$/i.test(line) && line.includes(orderNumber)
    );
    if (idx >= 0 && lines[idx + 1] && looksLikeBrandLocation(lines[idx + 1])) {
      return splitBrandLocation(lines[idx + 1]);
    }
    return { customer: "", location: "" };
  }

  function extractOrderSubmittedTime() {
    const stage = findVisibleLabel(document.body, "Order submitted");
    if (!stage) return "";
    hits.push({ label: "Order submitted", el: stage, valueEl: null, value: "" });

    const prev = stage.previousElementSibling;
    if (prev && extractTime(prev.innerText)) {
      const time = extractTime(prev.innerText);
      hits.push({ label: "Order Time", el: prev, valueEl: prev, value: time });
      return time;
    }

    const row = stage.closest("li, tr, article, section, div") || stage.parentElement;
    const time = extractTime(row && row.innerText);
    if (time) hits.push({ label: "Order Time", el: row, valueEl: row, value: time });
    return time;
  }

  function extractRefundedItems() {
    const items = [];

    const pushItem = (name, reasonText, el, reasonEl) => {
      const itemName = firstItemNameLine(name);
      const reasonRaw = normalizeSpace(reasonText);
      const reason = canonicalizeReason(reasonText);
      if (!reason || !isValidItemName(itemName)) return;
      items.push({ name: itemName, reason, reasonRaw });
      hits.push({ label: "Refunded item", el: el || null, valueEl: reasonEl || null, value: itemName });
    };

    for (const table of document.querySelectorAll("table")) {
      if (table.closest(`#${mapPanelId}, #${uiPrefix}-btn-bar, #${uiPrefix}-preview`)) continue;
      const rows = table.rows;
      if (!rows || !rows.length) continue;
      const headerCells = rows[0].cells;
      if (!headerCells || !headerCells.length) continue;
      const headers = [];
      for (let i = 0; i < headerCells.length; i++) headers.push(normalizeKey(headerCells[i].innerText));
      const reasonIdx = headers.findIndex((h) => /refund reason/.test(h));
      if (reasonIdx < 0) continue;
      const nameIdx = headers.findIndex((h) => /item\s*name|product|description|^item$|^name$/.test(h));

      for (let r = 1; r < rows.length; r++) {
        const cells = rows[r].cells;
        if (!cells || !cells.length) continue;
        const reasonText = normalizeSpace((cells[reasonIdx] && cells[reasonIdx].innerText) || "");
        if (!REASON_ROW_RE.test(reasonText)) continue;
        let itemName = nameIdx >= 0 ? (cells[nameIdx] && cells[nameIdx].innerText) || "" : "";
        if (!isValidItemName(itemName)) {
          for (let c = 0; c < cells.length; c++) {
            if (c === reasonIdx) continue;
            const candidate = firstItemNameLine((cells[c] && cells[c].innerText) || "");
            if (isValidItemName(candidate) && !isCategoryName(candidate)) {
              itemName = candidate;
              break;
            }
          }
        }
        pushItem(itemName, reasonText, rows[r], cells[reasonIdx]);
      }
      if (items.length) return uniqueBy(items, (item) => `${normalizeKey(item.name)}|${item.reason}`);
    }

    const reasonNodes = document.querySelectorAll("td, th, span, div, p, li, strong");
    for (let i = 0; i < reasonNodes.length; i++) {
      const el = reasonNodes[i];
      if (!visible(el)) continue;
      const reasonText = ownText(el) || (el.children.length === 0 ? normalizeSpace(el.textContent) : "");
      if (!REASON_ROW_RE.test(reasonText)) continue;
      const row = el.closest("tr, [role='row'], li, article") || el.parentElement;
      if (!row) continue;
      const chunks = [...row.querySelectorAll("td, th, span, div, p, strong")]
        .map((node) => firstItemNameLine(ownText(node) || node.textContent))
        .filter((text) => text && isValidItemName(text) && !REASON_ROW_RE.test(text) && !isCategoryName(text));
      const bestName = chunks.sort((a, b) => b.length - a.length)[0];
      if (bestName) pushItem(bestName, reasonText, row, el);
    }
    if (items.length) return uniqueBy(items, (item) => `${normalizeKey(item.name)}|${item.reason}`);

    const lines = pageLines();
    for (let i = 0; i < lines.length; i++) {
      if (!REASON_ROW_RE.test(lines[i])) continue;
      if (/^(missing items|incomplete items)$/i.test(lines[i]) && /^refund reason$/i.test(lines[i - 1] || "")) continue;

      let name = "";
      for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
        const candidate = firstItemNameLine(lines[j]);
        if (isMoneyText(candidate) || /^\d+$/.test(candidate)) continue;
        if (/^(quantity|qty|price|refund reason|refund details|item|item name|category)$/i.test(candidate)) continue;
        if (isCategoryName(candidate)) continue;
        if (REASON_ROW_RE.test(candidate)) continue;
        if (isValidItemName(candidate)) {
          name = candidate;
          break;
        }
      }
      if (name) pushItem(name, lines[i]);
    }

    return uniqueBy(items, (item) => `${normalizeKey(item.name)}|${item.reason}`);
  }

  function itemsMatchingReason(items, refundReason) {
    const withReason = (items || []).filter((item) => item && item.name && isValidItemName(item.name) && item.reason);
    const wanted = canonicalizeReason(refundReason);
    const matched = withReason.filter((item) => canonicalizeReason(item.reason) === wanted);
    if (matched.length) return matched;
    return withReason;
  }

  function detectAlreadyDisputed(lines) {
    const bodyText = Array.isArray(lines) ? lines.join("\n") : ((document.body && document.body.innerText) || "");
    return CONTESTED_BODY_RE.test(bodyText);
  }

  /* -------------------------------------------------------------------------- */
  /* Click-to-map: pick Deliveroo page text → Workhorse field                   */
  /* -------------------------------------------------------------------------- */

  function loadUserFieldMap() {
    if (userFieldMapCache) return userFieldMapCache;
    let map = {};
    try {
      map = (typeof GM_getValue === "function" && GM_getValue(FIELD_MAP_KEY, null)) || {};
    } catch {
      map = {};
    }
    if (!map || typeof map !== "object") map = {};
    userFieldMapCache = map;
    return map;
  }

  function saveUserFieldMap(map) {
    userFieldMapCache = map || {};
    try {
      if (typeof GM_setValue === "function") GM_setValue(FIELD_MAP_KEY, userFieldMapCache);
    } catch (err) {
      toast(`Could not save field map: ${err.message || err}`, "error");
    }
    try {
      if (typeof GM !== "undefined" && GM.setValue) GM.setValue(FIELD_MAP_KEY, userFieldMapCache);
    } catch {
      /* ignore */
    }
  }

  function clearUserFieldMap() {
    saveUserFieldMap({});
    toast("Cleared all custom field maps. Defaults will be used.", "success", 4000);
    renderMapPanel();
  }

  function defaultUserConditions() {
    return {
      locationAliases: [],
      customerAliases: [],
      reasonMap: {},
      disputeThresholdGbp: null,
      fiveGuysMaxEur: null,
      videoSubmitted: null,
      platformLabel: null,
      conditionTweaks: {},
    };
  }

  function normalizeConditionTweaks(raw) {
    const out = {};
    if (!raw || typeof raw !== "object") return out;
    for (const [key, val] of Object.entries(raw)) {
      if (!val || typeof val !== "object") continue;
      let reasons = val.reasonForDispute;
      if (Array.isArray(reasons)) {
        reasons = reasons.map((r) => normalizeSpace(r)).filter(Boolean);
      } else if (typeof reasons === "string" && reasons) {
        reasons = [normalizeSpace(reasons)];
      } else {
        reasons = [];
      }
      out[key] = {
        outcome: normalizeSpace(val.outcome || ""),
        footage: normalizeSpace(val.footage || ""),
        reasonForDispute: reasons,
      };
    }
    return out;
  }

  function loadUserConditions() {
    if (userConditionsCache) return userConditionsCache;
    let data = null;
    try {
      data = typeof GM_getValue === "function" ? GM_getValue(CONDITIONS_KEY, null) : null;
    } catch {
      data = null;
    }
    const thresholdRaw = data && data.disputeThresholdGbp;
    const thresholdNum = thresholdRaw == null || thresholdRaw === "" ? null : Number(thresholdRaw);
    const fiveRaw = data && data.fiveGuysMaxEur;
    const fiveNum = fiveRaw == null || fiveRaw === "" ? null : Number(fiveRaw);
    userConditionsCache = {
      ...defaultUserConditions(),
      ...(data && typeof data === "object" ? data : {}),
      locationAliases: Array.isArray(data && data.locationAliases) ? data.locationAliases : [],
      customerAliases: Array.isArray(data && data.customerAliases) ? data.customerAliases : [],
      reasonMap: data && data.reasonMap && typeof data.reasonMap === "object" ? data.reasonMap : {},
      disputeThresholdGbp: thresholdNum != null && !Number.isNaN(thresholdNum) ? thresholdNum : null,
      fiveGuysMaxEur: fiveNum != null && !Number.isNaN(fiveNum) ? fiveNum : null,
      videoSubmitted: data && data.videoSubmitted ? normalizeSpace(data.videoSubmitted) : null,
      platformLabel: data && data.platformLabel ? normalizeSpace(data.platformLabel) : null,
      conditionTweaks: normalizeConditionTweaks(data && data.conditionTweaks),
    };
    return userConditionsCache;
  }

  function saveUserConditions(data) {
    const thresholdRaw = data && data.disputeThresholdGbp;
    const thresholdNum = thresholdRaw == null || thresholdRaw === "" ? null : Number(thresholdRaw);
    const fiveRaw = data && data.fiveGuysMaxEur;
    const fiveNum = fiveRaw == null || fiveRaw === "" ? null : Number(fiveRaw);
    userConditionsCache = {
      ...defaultUserConditions(),
      ...(data || {}),
      locationAliases: Array.isArray(data && data.locationAliases) ? data.locationAliases : [],
      customerAliases: Array.isArray(data && data.customerAliases) ? data.customerAliases : [],
      reasonMap: data && data.reasonMap && typeof data.reasonMap === "object" ? data.reasonMap : {},
      disputeThresholdGbp: thresholdNum != null && !Number.isNaN(thresholdNum) ? thresholdNum : null,
      fiveGuysMaxEur: fiveNum != null && !Number.isNaN(fiveNum) ? fiveNum : null,
      videoSubmitted: data && data.videoSubmitted ? normalizeSpace(data.videoSubmitted) : null,
      platformLabel: data && data.platformLabel ? normalizeSpace(data.platformLabel) : null,
      conditionTweaks: normalizeConditionTweaks(data && data.conditionTweaks),
    };
    try {
      if (typeof GM_setValue === "function") GM_setValue(CONDITIONS_KEY, userConditionsCache);
    } catch (err) {
      toast(`Could not save conditions: ${err.message || err}`, "error");
    }
    try {
      if (typeof GM !== "undefined" && GM.setValue) GM.setValue(CONDITIONS_KEY, userConditionsCache);
    } catch {
      /* ignore */
    }
  }

  function effectiveDisputeThreshold() {
    const user = loadUserConditions().disputeThresholdGbp;
    if (user != null && !Number.isNaN(Number(user))) return Number(user);
    return workhorse.disputeThresholdGbp || 2;
  }

  function effectiveFiveGuysMax() {
    const user = loadUserConditions().fiveGuysMaxEur;
    if (user != null && !Number.isNaN(Number(user))) return Number(user);
    return platform.fiveGuysNotDisputedMaxEur;
  }

  function effectiveVideoSubmitted() {
    return loadUserConditions().videoSubmitted || workhorse.videoSubmitted || "No";
  }

  function effectivePlatformLabel() {
    return loadUserConditions().platformLabel || platform.platform || "Deliveroo";
  }

  function defaultTweakFor(key) {
    const o = workhorse.outcomeOptions || {};
    const f = workhorse.footageStatusOptions || {};
    const map = {
      underDisputeThreshold: { outcome: o.notDisputed, footage: f.irrelevant, reasonForDispute: [] },
      alreadyDisputed: { outcome: o.reviewed, footage: f.disputedByThirdParty, reasonForDispute: [] },
      fiveGuysUnderMax: { outcome: o.notDisputed, footage: f.irrelevant, reasonForDispute: [] },
      missingFoodSafety: { outcome: o.awaitingReview, footage: f.irrelevant, reasonForDispute: [] },
      preparedIncorrect: { outcome: o.pending, footage: f.irrelevant, reasonForDispute: [] },
    };
    return map[key] || { outcome: "", footage: "", reasonForDispute: [] };
  }

  function effectiveTweak(key) {
    const saved = (loadUserConditions().conditionTweaks || {})[key] || {};
    const defaults = defaultTweakFor(key);
    let reasons = saved.reasonForDispute;
    if (!Array.isArray(reasons)) {
      reasons = reasons ? [normalizeSpace(reasons)] : defaults.reasonForDispute || [];
    }
    return {
      outcome: saved.outcome || defaults.outcome || "",
      footage: saved.footage || defaults.footage || "",
      reasonForDispute: reasons.filter(Boolean),
    };
  }

  function withConditionContext(ctx) {
    return Object.assign({}, ctx || {}, {
      disputeThreshold: effectiveDisputeThreshold(),
      fiveGuysMax: effectiveFiveGuysMax(),
      conditionTweaks: loadUserConditions().conditionTweaks || {},
    });
  }

  function outcomeSelectHtml(name, selected) {
    const opts = Object.values(workhorse.outcomeOptions || {});
    return `<select data-tweak-outcome="${escapeAttr(name)}" title="Outcome">${opts
      .map((v) => `<option value="${escapeAttr(v)}" ${v === selected ? "selected" : ""}>${escapeAttr(v)}</option>`)
      .join("")}</select>`;
  }

  function footageSelectHtml(name, selected) {
    const opts = Object.values(workhorse.footageStatusOptions || {});
    return `<select data-tweak-footage="${escapeAttr(name)}" title="Footage Status">${opts
      .map((v) => `<option value="${escapeAttr(v)}" ${v === selected ? "selected" : ""}>${escapeAttr(v)}</option>`)
      .join("")}</select>`;
  }

  function workhorseDisputeReasonOptions() {
    const fromMap = Object.values(platform.reasonMap || {});
    const extras = [
      "Missing Item",
      "Incorrect Item",
      "Incomplete",
      "Prepared incorrectly",
      "Food safety complaint",
      workhorse.reasonForDisputeOtherOption || "Other",
    ];
    return [...new Set(fromMap.concat(extras).map((v) => normalizeSpace(v)).filter(Boolean))];
  }

  function reasonForDisputeCheckboxHtml(name, selected) {
    const opts = workhorseDisputeReasonOptions();
    const selectedList = (Array.isArray(selected) ? selected : selected ? [selected] : [])
      .map((v) => normalizeSpace(v))
      .filter(Boolean);
    const selectedKeys = new Set(selectedList.map((v) => normalizeKey(v)));
    const boxes = opts.map(
      (v) => `<label class="dcf-cond-check">
          <input type="checkbox" data-tweak-dispute-reason="${escapeAttr(name)}" value="${escapeAttr(v)}" ${selectedKeys.has(normalizeKey(v)) ? "checked" : ""} />
          <span>${escapeAttr(v)}</span>
        </label>`
    );
    return `<div class="dcf-cond-check-group" data-dispute-reason-group="${escapeAttr(name)}">${boxes.join("")}</div>`;
  }

  function matchAliasList(text, aliases) {
    const value = normalizeSpace(text);
    if (!value || !Array.isArray(aliases)) return "";
    for (const rule of aliases) {
      if (!rule || !rule.match || !rule.value) continue;
      try {
        if (new RegExp(String(rule.match), "i").test(value)) return normalizeSpace(rule.value);
      } catch {
        if (normalizeKey(value) === normalizeKey(rule.match)) return normalizeSpace(rule.value);
      }
      if (normalizeKey(value) === normalizeKey(rule.match)) return normalizeSpace(rule.value);
    }
    return "";
  }

  function resolveCustomerName(name) {
    const preset = normalizeCustomerName(name);
    return matchAliasList(preset, loadUserConditions().customerAliases) ||
      matchAliasList(name, loadUserConditions().customerAliases) ||
      preset;
  }

  function resolveLocationName(name) {
    const preset = normalizeLocationName(name);
    return matchAliasList(preset, loadUserConditions().locationAliases) ||
      matchAliasList(name, loadUserConditions().locationAliases) ||
      preset;
  }

  function resolveReasonForDispute(refundReason, refundReasonRaw) {
    const userMap = loadUserConditions().reasonMap || {};
    const rawKey = normalizeKey(refundReasonRaw || refundReason);
    const canonical = canonicalizeReason(refundReasonRaw || refundReason) || normalizeKey(refundReason);

    // Incomplete must use incomplete* overrides — never fall through to missing items.
    if (/incomplete/.test(rawKey)) {
      for (const key of [rawKey, "incomplete item", "incomplete items", "incomplete"]) {
        if (userMap[key]) return userMap[key];
      }
    }

    // Food safety: prefer explicit override before other maps
    if (/food\s*safety/.test(rawKey)) {
      for (const key of [rawKey, "food safety complaint", "foodsafetycomplaint"]) {
        if (userMap[key]) return userMap[key];
      }
    }

    const keys = [rawKey, normalizeKey(refundReason), canonical, normalizeKey(canonical)].filter(Boolean);
    const seen = new Set();
    for (const key of keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      // When raw was incomplete, skip missing* user-map hits
      if (/incomplete/.test(rawKey) && /^missing/.test(key)) continue;
      if (userMap[key]) return userMap[key];
    }

    if (/incomplete/.test(rawKey)) {
      // Preset default for incomplete is Missing Item — honor user intent via Incorrect Item
      // only when no user map; still use preset incomplete keys if present
      const preset = platform.reasonMap || {};
      for (const key of [rawKey, "incomplete item", "incomplete items", "incomplete"]) {
        if (preset[key]) return preset[key];
      }
    }

    return mapReasonForDispute(canonical);
  }

  function pickReasonForDisputeFromChecks(selected, mappedReason, refundReason, refundReasonRaw) {
    const list = (Array.isArray(selected) ? selected : selected ? [selected] : [])
      .map((r) => normalizeSpace(r))
      .filter(Boolean);
    if (!list.length) return "";

    const raw = normalizeKey(refundReasonRaw || refundReason);
    const canonical = canonicalizeReason(refundReasonRaw || refundReason) || "";
    const find = (re) => list.find((r) => re.test(normalizeKey(r)));

    // Incomplete orders: never coerce to Missing Item via multi-select
    if (/incomplete/.test(raw)) {
      if (mappedReason && !/^missing(\s*item)?s?$/i.test(mappedReason)) return mappedReason;
      const hit = find(/incomplete/) || find(/incorrect/);
      if (hit) return hit;
      return mappedReason || "";
    }

    if (mappedReason && list.some((r) => normalizeKey(r) === normalizeKey(mappedReason))) {
      return mappedReason;
    }

    if (/food\s*safety|foodsafetycomplaint/.test(raw)) {
      const hit = find(/food\s*safety|foodsafetycomplaint/) || find(/^other$/);
      if (hit) return hit;
    }
    if (/missing/.test(raw) || (/^missing/.test(canonical) && !/incomplete/.test(raw))) {
      const hit = find(/missing/);
      if (hit) return hit;
    }
    if (/prepared/.test(raw) || /prepared/.test(canonical)) {
      const hit = find(/prepared/);
      if (hit) return hit;
    }
    if (/incorrect/.test(raw) || /incorrect/.test(canonical)) {
      const hit = find(/incorrect/);
      if (hit) return hit;
    }
    return list[0];
  }

  function describeBuiltInConditions() {
    /* kept for compatibility — UI uses renderBuiltInConditions */
    return [];
  }

  function mergedReasonMapForEditor() {
    const preset = platform.reasonMap || {};
    const user = loadUserConditions().reasonMap || {};
    const keys = [...new Set([...Object.keys(preset), ...Object.keys(user)])];
    return keys.map((from) => ({
      from,
      to: user[from] || preset[from] || "",
      isUser: Object.prototype.hasOwnProperty.call(user, from),
    }));
  }

  function renderBuiltInConditions() {
    const threshold = effectiveDisputeThreshold();
    const five = effectiveFiveGuysMax();
    const under = effectiveTweak("underDisputeThreshold");
    const contested = effectiveTweak("alreadyDisputed");
    const fiveTweak = effectiveTweak("fiveGuysUnderMax");
    const missing = effectiveTweak("missingFoodSafety");
    const prepared = effectiveTweak("preparedIncorrect");
    const reasons = mergedReasonMapForEditor();
    const customerPresets = platform.customerAliases || [];

    const reasonRows = reasons
      .map(
        (r) => `<div class="dcf-cond-tweak-row">
        <code style="flex:0 0 38%">${escapeAttr(r.from)}</code>
        <span>→</span>
        <input data-reason-edit="${escapeAttr(r.from)}" value="${escapeAttr(r.to)}" style="flex:1" />
      </div>`
      )
      .join("");

    const customerRows = customerPresets
      .map(
        (a, i) => `<div class="dcf-cond-tweak-row">
        <input data-preset-customer-match="${i}" value="${escapeAttr(a.match || "")}" style="flex:1" />
        <span>→</span>
        <input data-preset-customer-value="${i}" value="${escapeAttr(a.value || "")}" style="flex:1" />
      </div>`
      )
      .join("");

    return `
      <li class="dcf-cond-builtin-editable">
        <div><strong>Partner refund ≤ £…</strong> → Outcome / Footage</div>
        <div class="dcf-cond-form dcf-cond-tweak-grid">
          <label>£</label>
          <input data-threshold-gbp type="number" min="0" step="0.01" value="${escapeAttr(String(threshold))}" />
          ${outcomeSelectHtml("underDisputeThreshold", under.outcome)}
          ${footageSelectHtml("underDisputeThreshold", under.footage)}
        </div>
      </li>
      <li class="dcf-cond-builtin-editable">
        <div><strong>Already contested / disputed</strong> → Outcome / Footage</div>
        <div class="dcf-cond-form dcf-cond-tweak-grid">
          ${outcomeSelectHtml("alreadyDisputed", contested.outcome)}
          ${footageSelectHtml("alreadyDisputed", contested.footage)}
        </div>
      </li>
      <li class="dcf-cond-builtin-editable">
        <div><strong>Five Guys and dispute &lt; €…</strong> → Outcome / Footage</div>
        <div class="dcf-cond-form dcf-cond-tweak-grid">
          <label>€</label>
          <input data-fiveguys-max type="number" min="0" step="0.01" value="${escapeAttr(five == null ? "" : String(five))}" placeholder="off" />
          ${outcomeSelectHtml("fiveGuysUnderMax", fiveTweak.outcome)}
          ${footageSelectHtml("fiveGuysUnderMax", fiveTweak.footage)}
        </div>
      </li>
      <li class="dcf-cond-builtin-editable">
        <div><strong>Missing / Incomplete / food safety</strong> → Outcome / Reason for Dispute</div>
        <div class="dcf-cond-form dcf-cond-tweak-grid">
          ${outcomeSelectHtml("missingFoodSafety", missing.outcome)}
        </div>
        <div class="dcf-map-meta" style="margin-top:6px">Reason for Dispute (multi-select). None checked = use reason map. If several match, the best one for this order is used.</div>
        ${reasonForDisputeCheckboxHtml("missingFoodSafety", missing.reasonForDispute)}
      </li>
      <li class="dcf-cond-builtin-editable">
        <div><strong>Prepared incorrectly / Incorrect item</strong> (also Incomplete → Incorrect Item) → Outcome / Reason for Dispute</div>
        <div class="dcf-cond-form dcf-cond-tweak-grid">
          ${outcomeSelectHtml("preparedIncorrect", prepared.outcome)}
        </div>
        <div class="dcf-map-meta" style="margin-top:6px">Reason for Dispute (multi-select). None checked = use reason map.</div>
        ${reasonForDisputeCheckboxHtml("preparedIncorrect", prepared.reasonForDispute)}
      </li>
      <li class="dcf-cond-builtin-editable">
        <div><strong>Video Submitted</strong> always</div>
        <div class="dcf-cond-form dcf-cond-tweak-grid">
          <select data-video-submitted>
            <option value="No" ${effectiveVideoSubmitted() === "No" ? "selected" : ""}>No</option>
            <option value="Yes" ${effectiveVideoSubmitted() === "Yes" ? "selected" : ""}>Yes</option>
          </select>
        </div>
      </li>
      <li class="dcf-cond-builtin-editable">
        <div><strong>Platform</strong> always</div>
        <div class="dcf-cond-form dcf-cond-tweak-grid">
          <input data-platform-label value="${escapeAttr(effectivePlatformLabel())}" />
        </div>
      </li>
      <li class="dcf-cond-builtin-editable">
        <div><strong>Reason map</strong> (Deliveroo → Workhorse Reason for Dispute)</div>
        <div class="dcf-cond-tweak-list">${reasonRows || `<div class="dcf-map-meta">No reason rows</div>`}</div>
      </li>
      <li class="dcf-cond-builtin-editable">
        <div><strong>Customer presets</strong> (saved into your customer aliases on Save)</div>
        <div class="dcf-cond-tweak-list">${customerRows || `<div class="dcf-map-meta">No customer presets</div>`}</div>
      </li>
      <li class="dcf-cond-builtin-editable" style="border-style:dashed">
        <button type="button" class="dcf-cond-add" data-cond-save-builtins style="width:100%">Save built-in condition tweaks</button>
      </li>
    `;
  }

  function ensureMapStyles() {
    const styleId = `${uiPrefix}-map-style-v6`;
    if (document.getElementById(styleId)) return;
    document.getElementById(`${uiPrefix}-map-style`)?.remove();
    document.getElementById(`${uiPrefix}-map-style-v3`)?.remove();
    document.getElementById(`${uiPrefix}-map-style-v4`)?.remove();
    document.getElementById(`${uiPrefix}-map-style-v5`)?.remove();
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      #${mapBtnId} {
        background: #134e4a; color: #ecfdf5; border: 0; cursor: pointer;
        border-radius: 999px; padding: 12px 22px;
        box-shadow: 0 10px 30px rgba(0,0,0,.35);
        font: 700 15px/1.2 Segoe UI, system-ui, sans-serif;
      }
      #${mapBtnId}:hover { background: #111827; color: #fff; }
      #${mapPanelId} {
        position: fixed; top: 64px; left: 18px; z-index: 2147483646;
        width: 460px; max-height: 75vh; overflow: auto;
        background: #0f172a; color: #f8fafc; border-radius: 12px;
        padding: 0 14px 14px; box-shadow: 0 12px 40px rgba(0,0,0,.4);
        font: 13px/1.4 Segoe UI, system-ui, sans-serif;
      }
      #${mapPanelId} .dcf-map-drag {
        display: flex; align-items: center; gap: 8px;
        margin: 0 -14px 10px; padding: 12px 14px 8px;
        cursor: grab; user-select: none;
        border-bottom: 1px solid #1e293b;
        background: #0f172a;
        position: sticky; top: 0; z-index: 1;
      }
      #${mapPanelId} .dcf-map-drag:active { cursor: grabbing; }
      #${mapPanelId} .dcf-map-drag-grip {
        color: #64748b; letter-spacing: 2px; font-size: 14px; line-height: 1;
      }
      #${mapPanelId} .dcf-map-drag h3 { margin: 0; font-size: 15px; flex: 1; }
      #${mapPanelId} .dcf-map-tabs { display: flex; gap: 6px; margin-bottom: 10px; }
      #${mapPanelId} .dcf-map-tabs button {
        flex: 1; border: 0; border-radius: 8px; padding: 8px; cursor: pointer;
        background: #1e293b; color: #cbd5e1; font-weight: 600;
      }
      #${mapPanelId} .dcf-map-tabs button.active { background: #00ccbc; color: #06221f; }
      #${mapPanelId} p { margin: 0 0 10px; color: #94a3b8; font-size: 12px; }
      #${mapPanelId} .dcf-map-row {
        display: flex; flex-direction: column; gap: 4px;
        padding: 8px 0; border-top: 1px solid #1e293b;
      }
      #${mapPanelId} .dcf-map-row-top { display: flex; gap: 8px; align-items: center; }
      #${mapPanelId} .dcf-map-row button, #${mapPanelId} .dcf-cond-add {
        border: 0; border-radius: 8px; padding: 6px 10px; cursor: pointer;
        background: #00ccbc; color: #06221f; font-weight: 700; font-size: 12px;
      }
      #${mapPanelId} .dcf-map-row button.armed { background: #fbbf24; color: #111; }
      #${mapPanelId} .dcf-map-meta { color: #94a3b8; font-size: 11px; word-break: break-word; }
      #${mapPanelId} .dcf-map-actions { display: flex; gap: 8px; margin-top: 12px; }
      #${mapPanelId} .dcf-map-actions button {
        flex: 1; border: 0; border-radius: 8px; padding: 8px; cursor: pointer;
        background: #334155; color: #fff; font-weight: 600;
      }
      #${mapPanelId} .dcf-cond-section { margin-top: 12px; padding-top: 8px; border-top: 1px solid #1e293b; }
      #${mapPanelId} .dcf-cond-section h4 { margin: 0 0 8px; font-size: 13px; color: #e2e8f0; }
      #${mapPanelId} .dcf-cond-form { display: grid; grid-template-columns: 1fr 1fr auto; gap: 6px; margin-bottom: 8px; }
      #${mapPanelId} .dcf-cond-form input {
        border: 1px solid #334155; border-radius: 6px; padding: 6px 8px;
        background: #1e293b; color: #f8fafc; font-size: 12px;
      }
      #${mapPanelId} .dcf-cond-item {
        display: flex; gap: 8px; align-items: center; padding: 4px 0;
        font-size: 12px; color: #cbd5e1;
      }
      #${mapPanelId} .dcf-cond-item button {
        border: 0; border-radius: 6px; padding: 4px 8px; cursor: pointer;
        background: #7f1d1d; color: #fff; font-size: 11px;
      }
      #${mapPanelId} .dcf-cond-builtin {
        margin: 0; padding-left: 16px; color: #94a3b8; font-size: 11px;
      }
      #${mapPanelId} .dcf-cond-builtin li { margin: 3px 0; }
      #${mapPanelId} .dcf-cond-builtin-editable {
        list-style: none; margin: 6px 0 6px -16px; padding: 8px; border-radius: 8px;
        background: #1e293b; border: 1px solid #334155; color: #cbd5e1; font-size: 12px;
      }
      #${mapPanelId} .dcf-cond-builtin-editable .dcf-cond-form label { align-self: center; }
      #${mapPanelId} .dcf-cond-tweak-grid {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 6px; margin-top: 6px;
      }
      #${mapPanelId} .dcf-cond-tweak-grid select,
      #${mapPanelId} .dcf-cond-tweak-grid input,
      #${mapPanelId} .dcf-cond-tweak-list input {
        width: 100%; border: 0; border-radius: 6px; padding: 6px 8px;
        background: #0f172a; color: #f8fafc; font-size: 12px;
      }
      #${mapPanelId} .dcf-cond-tweak-list { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
      #${mapPanelId} .dcf-cond-tweak-row { display: flex; gap: 6px; align-items: center; }
      #${mapPanelId} .dcf-cond-check-group {
        display: flex; flex-direction: column; gap: 4px; margin-top: 6px;
      }
      #${mapPanelId} .dcf-cond-check {
        display: flex; align-items: center; gap: 8px; cursor: pointer;
        color: #e2e8f0; font-size: 12px; user-select: none;
      }
      #${mapPanelId} .dcf-cond-check input {
        width: 14px; height: 14px; accent-color: #00ccbc; flex: 0 0 auto;
      }
      body.dcf-map-picking, body.dcf-map-picking * { cursor: crosshair !important; }
      .dcf-map-flash { outline: 3px solid #fbbf24 !important; outline-offset: 2px; }
    `;
    document.documentElement.appendChild(style);
  }

  function stopMapPick() {
    if (mapPickHandler) {
      document.removeEventListener("click", mapPickHandler, true);
      mapPickHandler = null;
    }
    mapPickKey = null;
    document.body && document.body.classList.remove("dcf-map-picking");
  }

  function inferMappingFromElement(el, fieldKey = "") {
    if (!el || el.closest(`#${mapPanelId}, #${uiPrefix}-btn-bar`)) return null;
    let node = el;
    if (node.nodeType === 3) node = node.parentElement;
    while (node && node !== document.body && normalizeSpace(node.innerText || "").length > 120) {
      node = node.parentElement;
    }
    if (!node || node === document.body) return null;

    let value = normalizeSpace((ownText(node) || node.innerText || "").split("\n")[0]);
    if (!value || value.length > 100) {
      value = normalizeSpace((node.innerText || "").split("\n")[0]);
    }
    if (!value || value.length > 120) return null;

    node.classList.add("dcf-map-flash");
    setTimeout(() => node.classList.remove("dcf-map-flash"), 1200);

    if (/^order\s*#\s*\d+$/i.test(value) || fieldKey === "orderNumber") {
      if (/order\s*#\s*\d+/i.test(value) || /^\d{3,}$/.test(value)) {
        return { type: "orderNumber", sampleValue: value };
      }
    }

    const allowBrandLine = fieldKey === "customer" || fieldKey === "location";
    if (allowBrandLine && looksLikeBrandLocation(value)) {
      return { type: "brandLocationLine", sampleValue: value };
    }

    const lines = pageLines();
    let label = "";
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === value || lines[i].includes(value)) {
        if (i > 0) label = lines[i - 1];
        break;
      }
    }

    const prev = node.previousElementSibling;
    if (prev) {
      const prevText = normalizeSpace((ownText(prev) || prev.innerText || "").split("\n")[0]);
      if (prevText && prevText.length < 48 && prevText !== value) label = prevText;
    }

    // Known Deliveroo labels — prefer these over nearby item names (e.g. BBQ Sauce)
    const knownLabels = [
      "Date ordered", "Order total", "Partner refund value", "Refund reason",
      "Order submitted", "Refund details",
    ];
    for (const known of knownLabels) {
      if (normalizeKey(label) === normalizeKey(known) || normalizeKey(value) === normalizeKey(known)) {
        label = known;
        break;
      }
    }
    if (fieldKey === "disputeAmount" && !label) label = "Partner refund value";
    if (fieldKey === "orderValue" && !label) label = "Order total";
    if (fieldKey === "claimDate" && !label) label = "Date ordered";
    if (fieldKey === "refundReason" && REASON_ROW_RE.test(value)) {
      return { type: "afterLabel", label: "Refund reason", sampleValue: value };
    }
    if (fieldKey === "otherReason") {
      return { type: "literal", sampleValue: firstItemNameLine(value) || value };
    }

    if (label && !HEADER_WORDS.test(label) && label.length < 60 && normalizeKey(label) !== normalizeKey(value)) {
      return { type: "afterLabel", label, sampleValue: value };
    }

    if (/^(date ordered|order total|partner refund value|refund reason)$/i.test(value)) {
      return { type: "afterLabel", label: value, sampleValue: "", clickedLabel: true };
    }

    return { type: "literal", sampleValue: value };
  }

  function pickBestLabeledValue(label, sampleValue, asMoney) {
    const vals = valuesAfterLabel(label).filter(Boolean);
    if (!vals.length) return sampleValue || "";
    if (sampleValue) {
      const sampleKey = normalizeKey(sampleValue);
      const sampleNum = asMoney ? parseMoney(sampleValue) : null;
      const exact = vals.find((v) => normalizeKey(v) === sampleKey || v.includes(String(sampleValue).slice(0, 12)));
      if (exact) return exact;
      if (asMoney && sampleNum != null) {
        const byNum = vals.find((v) => parseMoney(v) === sampleNum);
        if (byNum) return byNum;
      }
    }
    if (asMoney) {
      const nonZero = vals.filter((v) => {
        const n = parseMoney(v);
        return n != null && Math.abs(n) > 0;
      });
      if (nonZero.length) return nonZero[nonZero.length - 1];
    }
    return vals[vals.length - 1];
  }

  function readMappedRaw(mapping, fieldKey = "") {
    if (!mapping || !mapping.type) return "";
    if (mapping.type === "literal") return mapping.sampleValue || "";
    if (mapping.type === "orderNumber") {
      const n = extractOrderNumber();
      return n ? `Order #${n}` : mapping.sampleValue || "";
    }
    if (mapping.type === "brandLocationLine") {
      // Never resolve brand line for item/reason fields — use what was clicked
      if (fieldKey === "otherReason" || fieldKey === "refundReason") {
        return mapping.sampleValue || "";
      }
      const orderNumber = extractOrderNumber();
      const brand = extractBrandAndLocation(orderNumber);
      if (brand.customer && brand.location) return `${brand.customer} - ${brand.location}`;
      const lines = pageLines();
      const hit = lines.find((line) => looksLikeBrandLocation(line));
      return hit || mapping.sampleValue || "";
    }
    if (mapping.type === "afterLabel" && mapping.label) {
      const asMoney = fieldKey === "orderValue" || fieldKey === "disputeAmount";
      if (mapping.clickedLabel) {
        return pickBestLabeledValue(mapping.label, mapping.sampleValue, asMoney);
      }
      return pickBestLabeledValue(mapping.label, mapping.sampleValue, asMoney);
    }
    return mapping.sampleValue || "";
  }

  function applyUserMapsToExtraction(base) {
    const map = loadUserFieldMap();
    const out = { ...base };
    const fieldMeta = Object.fromEntries(MAPPABLE_FIELDS.map((f) => [f.key, f]));

    for (const [key, mapping] of Object.entries(map)) {
      const meta = fieldMeta[key];
      if (!meta || !mapping) continue;
      // Repair bad maps saved earlier (item names stored as brandLocationLine)
      const fixedMapping =
        (key === "otherReason" || key === "refundReason") && mapping.type === "brandLocationLine"
          ? { type: "literal", sampleValue: mapping.sampleValue }
          : mapping;
      const raw = readMappedRaw(fixedMapping, key);
      if (!raw && key !== "disputeAmount") continue;

      if (key === "orderNumber") {
        const m = String(raw).match(/(\d{3,})/);
        if (m) out.orderNumber = m[1];
      } else if (key === "customer") {
        if (fixedMapping.type === "brandLocationLine") {
          const parsed = splitBrandLocation(raw);
          if (parsed.customer) out.customer = resolveCustomerName(parsed.customer);
          if (parsed.location && !map.location) out.location = resolveLocationName(parsed.location);
        } else {
          out.customer = resolveCustomerName(raw);
        }
      } else if (key === "location") {
        if (fixedMapping.type === "brandLocationLine") {
          const parsed = splitBrandLocation(raw);
          if (parsed.location) out.location = resolveLocationName(parsed.location);
          if (parsed.customer && !map.customer) out.customer = resolveCustomerName(parsed.customer);
        } else {
          out.location = resolveLocationName(raw);
        }
      } else if (key === "claimDate") {
        const claimDate = parseClaimDate(raw);
        out.claimDate = claimDate.raw || raw;
        out.claimDateISO = claimDate.iso;
        out.claimDateDMY = claimDate.dmy;
        out.claimDateDash = claimDate.dash;
        if (!map.orderTime) {
          const t = extractTime(raw);
          if (t) out.orderTime = t;
        }
      } else if (key === "orderTime") {
        out.orderTime = extractTime(raw) || raw;
      } else if (key === "orderValue") {
        const n = parseMoney(raw) ?? parseMoney(fixedMapping.sampleValue);
        if (n != null) out.orderValue = n.toFixed(2);
      } else if (key === "disputeAmount") {
        let n = parseMoney(raw);
        if (n == null || n === 0) n = parseMoney(fixedMapping.sampleValue);
        // If map still yields 0, fall back to auto Partner refund value (non-zero)
        if (n == null || n === 0) {
          const auto = pickBestLabeledValue("Partner refund value", fixedMapping.sampleValue, true);
          n = parseMoney(auto);
        }
        if (n != null) out.disputeAmount = n.toFixed(2);
      } else if (key === "refundReason") {
        const reasonText = REASON_ROW_RE.test(raw) ? raw : fixedMapping.sampleValue || raw;
        out.refundReasonRaw = normalizeSpace(reasonText);
        out.refundReason = canonicalizeReason(reasonText) || reasonText;
        out.reasonForDispute = resolveReasonForDispute(out.refundReason, out.refundReasonRaw);
      } else if (key === "otherReason") {
        const item = firstItemNameLine(raw) || raw;
        // Ignore accidental brand/location
        if (looksLikeBrandLocation(item) && /shake|jollibee|popeyes|five\s*guys/i.test(item)) {
          continue;
        }
        // Ignore menu categories (e.g. clicking "Fries" / "Sauces" instead of the item)
        if (isCategoryName(item)) continue;
        const refundedNames = itemNamesFrom(out.items || []);
        // If auto-extract already found refunded item(s), don't replace with an unrelated click
        if (
          refundedNames.length &&
          !refundedNames.some((n) => normalizeKey(n) === normalizeKey(item) || normalizeKey(item).includes(normalizeKey(n)))
        ) {
          continue;
        }
        out.otherReason = item;
        if (!out.wrongFoodItem) out.wrongFoodItem = String(item).split("\n")[0];
      }
    }

    // Keep Other reason aligned with refunded items when a stale map left garbage
    const refundedNames = itemNamesFrom(out.items || []);
    if (refundedNames.length) {
      const otherFirst = firstItemNameLine(out.otherReason);
      const otherIsBad =
        !otherFirst ||
        isCategoryName(otherFirst) ||
        (out.wrongFoodItem &&
          normalizeKey(otherFirst) !== normalizeKey(out.wrongFoodItem) &&
          !refundedNames.some((n) => normalizeKey(n) === normalizeKey(otherFirst)));
      if (otherIsBad) {
        out.otherReason = out.wrongFoodItem || refundedNames.join("\n");
      }
    }

    out.customer = resolveCustomerName(out.customer);
    out.location = resolveLocationName(out.location);
    out.reasonForDispute = resolveReasonForDispute(out.refundReason, out.refundReasonRaw);
    const amount = parseMoney(out.disputeAmount);
    const ruleCtx = {
      disputeAmount: amount,
      alreadyDisputed: out.alreadyDisputed,
      refundReason: out.refundReason,
      refundReasonRaw: out.refundReasonRaw,
      reasonForDispute: out.reasonForDispute,
      customer: out.customer,
      location: out.location,
    };
    const ctx = withConditionContext(ruleCtx);
    const outcomeMatch =
      typeof resolveOutcomeMatch === "function"
        ? resolveOutcomeMatch(ctx)
        : { outcome: computeOutcome(ctx), reasonForDispute: [] };
    out.outcome = outcomeMatch.outcome || computeOutcome(ctx);
    const pickedReason = pickReasonForDisputeFromChecks(
      outcomeMatch.reasonForDispute,
      out.reasonForDispute,
      out.refundReason,
      out.refundReasonRaw
    );
    if (pickedReason) out.reasonForDispute = pickedReason;
    out.footageStatus = computeFootageStatus(ctx);
    return out;
  }

  function startMapPick(fieldKey) {
    stopMapPick();
    mapPickKey = fieldKey;
    document.body.classList.add("dcf-map-picking");
    toast(`Click the Deliveroo value for "${MAPPABLE_FIELDS.find((f) => f.key === fieldKey)?.label || fieldKey}"`, "info", 6000);
    renderMapPanel();

    mapPickHandler = (event) => {
      if (event.target.closest(`#${mapPanelId}, #${uiPrefix}-btn-bar`)) return;
      event.preventDefault();
      event.stopPropagation();
      const mapping = inferMappingFromElement(event.target, fieldKey);
      stopMapPick();
      if (!mapping) {
        toast("Could not read that click. Try a clearer label or value.", "error");
        renderMapPanel();
        return;
      }
      const map = { ...loadUserFieldMap(), [fieldKey]: mapping };
      saveUserFieldMap(map);
      const desc = mapping.type === "afterLabel"
        ? `label "${mapping.label}" → ${mapping.sampleValue}`
        : `${mapping.type}: ${mapping.sampleValue}`;
      toast(`Mapped ${fieldKey}: ${desc}`, "success", 5000);
      renderMapPanel();
    };
    document.addEventListener("click", mapPickHandler, true);
  }

  function mappingSummary(mapping) {
    if (!mapping) return "Default (auto)";
    if (mapping.type === "literal") return `Clicked text: ${mapping.sampleValue || "?"}`;
    if (mapping.type === "afterLabel") {
      return mapping.clickedLabel
        ? `After label “${mapping.label}”`
        : `“${mapping.label}” → ${mapping.sampleValue || "?"}`;
    }
    if (mapping.type === "orderNumber") return `Order # from heading (${mapping.sampleValue || ""})`;
    if (mapping.type === "brandLocationLine") return `Brand – location line (${mapping.sampleValue || ""})`;
    return mapping.type;
  }

  function clampMapPanelPosition(left, top, panel) {
    const width = panel.offsetWidth || 360;
    const height = Math.min(panel.offsetHeight || 200, window.innerHeight);
    const maxLeft = Math.max(8, window.innerWidth - width - 8);
    const maxTop = Math.max(8, window.innerHeight - Math.min(height, 120) - 8);
    return {
      left: Math.min(maxLeft, Math.max(8, left)),
      top: Math.min(maxTop, Math.max(8, top)),
    };
  }

  function applyMapPanelPosition(panel) {
    if (!panel) return;
    const pos = clampMapPanelPosition(mapPanelPos.left, mapPanelPos.top, panel);
    mapPanelPos = pos;
    panel.style.left = `${pos.left}px`;
    panel.style.top = `${pos.top}px`;
  }

  function enableMapPanelDrag(panel) {
    if (!panel || panel.dataset.dragBound === "1") return;
    panel.dataset.dragBound = "1";
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;

    const onMove = (event) => {
      if (!dragging) return;
      const next = clampMapPanelPosition(
        originLeft + (event.clientX - startX),
        originTop + (event.clientY - startY),
        panel
      );
      mapPanelPos = next;
      panel.style.left = `${next.left}px`;
      panel.style.top = `${next.top}px`;
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerup", onUp, true);
    };

    panel.addEventListener("pointerdown", (event) => {
      const handle = event.target.closest(".dcf-map-drag");
      if (!handle || event.target.closest("button")) return;
      if (event.button != null && event.button !== 0) return;
      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      originLeft = panel.offsetLeft;
      originTop = panel.offsetTop;
      event.preventDefault();
      document.addEventListener("pointermove", onMove, true);
      document.addEventListener("pointerup", onUp, true);
    });
  }

  function escapeAttr(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;");
  }

  function renderAliasList(kind, aliases) {
    if (!aliases.length) return `<div class="dcf-map-meta">None yet — add Deliveroo text → Workhorse value below.</div>`;
    return aliases
      .map(
        (rule, index) => `<div class="dcf-cond-item">
        <span style="flex:1"><code>${escapeAttr(rule.match)}</code> → <strong>${escapeAttr(rule.value)}</strong></span>
        <button type="button" data-cond-del="${kind}" data-cond-index="${index}">Remove</button>
      </div>`
      )
      .join("");
  }

  function renderReasonOverrides(reasonMap) {
    const entries = Object.entries(reasonMap || {});
    if (!entries.length) return `<div class="dcf-map-meta">None yet — map a Deliveroo refund reason to a Workhorse Reason for Dispute.</div>`;
    return entries
      .map(
        ([from, to]) => `<div class="dcf-cond-item">
        <span style="flex:1"><code>${escapeAttr(from)}</code> → <strong>${escapeAttr(to)}</strong></span>
        <button type="button" data-cond-del-reason="${escapeAttr(from)}">Remove</button>
      </div>`
      )
      .join("");
  }

  function renderMapPanel() {
    ensureMapStyles();
    let panel = document.getElementById(mapPanelId);
    if (!panel) {
      panel = document.createElement("div");
      panel.id = mapPanelId;
      document.body.appendChild(panel);
      enableMapPanelDrag(panel);
    }
    applyMapPanelPosition(panel);

    const map = loadUserFieldMap();
    const conditions = loadUserConditions();
    const fieldRows = MAPPABLE_FIELDS.map((field) => {
      const mapping = map[field.key];
      const armed = mapPickKey === field.key;
      return `<div class="dcf-map-row">
        <div class="dcf-map-row-top">
          <strong style="flex:1">${field.label}</strong>
          <button type="button" data-map-key="${field.key}" class="${armed ? "armed" : ""}">${armed ? "Click page…" : "Select on page"}</button>
        </div>
        <div class="dcf-map-meta">${mappingSummary(mapping)}</div>
      </div>`;
    }).join("");

    const builtin = renderBuiltInConditions();

    const fieldsBody = `
      <p>Pick a field, then click the matching text on the refund page. Saved in this browser.</p>
      ${fieldRows}
      <div class="dcf-map-actions">
        <button type="button" data-map-action="clear">Clear maps</button>
        <button type="button" data-map-action="close">Close</button>
      </div>
    `;

    const conditionsBody = `
      <p>When Deliveroo names differ from Workhorse, add aliases. Regex allowed in the “from” box (e.g. <code>victoria.*</code>).</p>

      <div class="dcf-cond-section">
        <h4>Location aliases (Deliveroo → Workhorse)</h4>
        ${renderAliasList("locationAliases", conditions.locationAliases)}
        <div class="dcf-cond-form">
          <input data-cond-from="locationAliases" placeholder="Deliveroo location" />
          <input data-cond-to="locationAliases" placeholder="Workhorse location" />
          <button type="button" class="dcf-cond-add" data-cond-add="locationAliases">Add</button>
        </div>
      </div>

      <div class="dcf-cond-section">
        <h4>Customer aliases</h4>
        ${renderAliasList("customerAliases", conditions.customerAliases)}
        <div class="dcf-cond-form">
          <input data-cond-from="customerAliases" placeholder="Deliveroo customer" />
          <input data-cond-to="customerAliases" placeholder="Workhorse customer" />
          <button type="button" class="dcf-cond-add" data-cond-add="customerAliases">Add</button>
        </div>
      </div>

      <div class="dcf-cond-section">
        <h4>Reason overrides</h4>
        ${renderReasonOverrides(conditions.reasonMap)}
        <div class="dcf-cond-form">
          <input data-reason-from placeholder="Deliveroo reason" />
          <input data-reason-to placeholder="Workhorse reason" />
          <button type="button" class="dcf-cond-add" data-cond-add-reason>Add</button>
        </div>
      </div>

      <div class="dcf-cond-section">
        <h4>Built-in conditions</h4>
        <div class="dcf-map-meta" style="margin-bottom:8px">Tweak outcomes, footage, thresholds, reasons, and defaults. Click <strong>Save built-in condition tweaks</strong> at the bottom.</div>
        <ul class="dcf-cond-builtin">${builtin}</ul>
      </div>

      <div class="dcf-map-actions">
        <button type="button" data-map-action="clear-conditions">Clear my conditions</button>
        <button type="button" data-map-action="close">Close</button>
      </div>
    `;

    panel.innerHTML = `
      <div class="dcf-map-drag" title="Drag to move">
        <span class="dcf-map-drag-grip" aria-hidden="true">⋮⋮</span>
        <h3>Map &amp; conditions</h3>
      </div>
      <div class="dcf-map-tabs">
        <button type="button" data-map-tab="fields" class="${mapPanelTab === "fields" ? "active" : ""}">Field maps</button>
        <button type="button" data-map-tab="conditions" class="${mapPanelTab === "conditions" ? "active" : ""}">Conditions</button>
      </div>
      ${mapPanelTab === "conditions" ? conditionsBody : fieldsBody}
    `;

    panel.querySelectorAll("[data-map-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        mapPanelTab = btn.getAttribute("data-map-tab") || "fields";
        renderMapPanel();
      });
    });
    panel.querySelectorAll("[data-map-key]").forEach((btn) => {
      btn.addEventListener("click", () => startMapPick(btn.getAttribute("data-map-key")));
    });
    panel.querySelector('[data-map-action="clear"]')?.addEventListener("click", clearUserFieldMap);
    panel.querySelector('[data-map-action="clear-conditions"]')?.addEventListener("click", () => {
      saveUserConditions(defaultUserConditions());
      toast("Cleared your custom conditions.", "success", 3500);
      renderMapPanel();
    });
    panel.querySelector("[data-cond-save-builtins]")?.addEventListener("click", () => {
      const next = loadUserConditions();
      const thresholdRaw = panel.querySelector("[data-threshold-gbp]")?.value;
      const thresholdNum = thresholdRaw === "" || thresholdRaw == null ? null : Number(thresholdRaw);
      if (thresholdNum != null && (Number.isNaN(thresholdNum) || thresholdNum < 0)) {
        toast("Enter a valid £ threshold (0 or more).", "error");
        return;
      }
      const fiveRaw = panel.querySelector("[data-fiveguys-max]")?.value;
      const fiveNum = fiveRaw === "" || fiveRaw == null ? null : Number(fiveRaw);
      if (fiveNum != null && (Number.isNaN(fiveNum) || fiveNum < 0)) {
        toast("Enter a valid Five Guys € max (0 or more), or leave blank.", "error");
        return;
      }

      const tweaks = { ...(next.conditionTweaks || {}) };
      panel.querySelectorAll("[data-tweak-outcome]").forEach((el) => {
        const key = el.getAttribute("data-tweak-outcome");
        tweaks[key] = Object.assign({}, tweaks[key] || {}, { outcome: el.value });
      });
      panel.querySelectorAll("[data-tweak-footage]").forEach((el) => {
        const key = el.getAttribute("data-tweak-footage");
        tweaks[key] = Object.assign({}, tweaks[key] || {}, { footage: el.value });
      });
      const disputeGroups = new Set(
        [...panel.querySelectorAll("[data-tweak-dispute-reason]")].map((el) => el.getAttribute("data-tweak-dispute-reason"))
      );
      disputeGroups.forEach((key) => {
        if (!key) return;
        const checked = [...panel.querySelectorAll(`[data-tweak-dispute-reason="${key}"]`)]
          .filter((el) => el.checked)
          .map((el) => normalizeSpace(el.value))
          .filter(Boolean);
        tweaks[key] = Object.assign({}, tweaks[key] || {}, {
          reasonForDispute: checked,
        });
      });

      const reasonMap = { ...(next.reasonMap || {}) };
      panel.querySelectorAll("[data-reason-edit]").forEach((el) => {
        const from = el.getAttribute("data-reason-edit");
        const to = normalizeSpace(el.value);
        if (from && to) reasonMap[from] = to;
      });

      const customerAliases = [...(next.customerAliases || [])];
      panel.querySelectorAll("[data-preset-customer-match]").forEach((el) => {
        const i = Number(el.getAttribute("data-preset-customer-match"));
        const match = normalizeSpace(el.value);
        const value = normalizeSpace(panel.querySelector(`[data-preset-customer-value="${i}"]`)?.value || "");
        if (!match || !value) return;
        const existing = customerAliases.findIndex((a) => normalizeKey(a.match) === normalizeKey(match));
        const row = { match, value };
        if (existing >= 0) customerAliases[existing] = row;
        else customerAliases.push(row);
      });

      next.disputeThresholdGbp = thresholdNum;
      next.fiveGuysMaxEur = fiveNum;
      next.conditionTweaks = tweaks;
      next.reasonMap = reasonMap;
      next.customerAliases = customerAliases;
      next.videoSubmitted = panel.querySelector("[data-video-submitted]")?.value || "No";
      next.platformLabel = normalizeSpace(panel.querySelector("[data-platform-label]")?.value) || platform.platform;
      saveUserConditions(next);
      toast("Saved built-in condition tweaks.", "success", 4000);
      renderMapPanel();
    });
    panel.querySelector('[data-map-action="close"]')?.addEventListener("click", () => {
      stopMapPick();
      panel.remove();
    });

    panel.querySelectorAll("[data-cond-add]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const kind = btn.getAttribute("data-cond-add");
        const from = panel.querySelector(`[data-cond-from="${kind}"]`)?.value;
        const to = panel.querySelector(`[data-cond-to="${kind}"]`)?.value;
        if (!normalizeSpace(from) || !normalizeSpace(to)) {
          toast("Enter both Deliveroo and Workhorse values.", "error");
          return;
        }
        const next = loadUserConditions();
        next[kind] = [...(next[kind] || []), { match: normalizeSpace(from), value: normalizeSpace(to) }];
        saveUserConditions(next);
        toast(`Added ${kind === "locationAliases" ? "location" : "customer"} alias.`, "success", 3000);
        renderMapPanel();
      });
    });

    panel.querySelector("[data-cond-add-reason]")?.addEventListener("click", () => {
      const from = panel.querySelector("[data-reason-from]")?.value;
      const to = panel.querySelector("[data-reason-to]")?.value;
      if (!normalizeSpace(from) || !normalizeSpace(to)) {
        toast("Enter both Deliveroo and Workhorse reasons.", "error");
        return;
      }
      const next = loadUserConditions();
      next.reasonMap = { ...(next.reasonMap || {}), [normalizeKey(from)]: normalizeSpace(to) };
      saveUserConditions(next);
      toast("Added reason override.", "success", 3000);
      renderMapPanel();
    });

    panel.querySelectorAll("[data-cond-del]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const kind = btn.getAttribute("data-cond-del");
        const index = Number(btn.getAttribute("data-cond-index"));
        const next = loadUserConditions();
        next[kind] = (next[kind] || []).filter((_, i) => i !== index);
        saveUserConditions(next);
        renderMapPanel();
      });
    });

    panel.querySelectorAll("[data-cond-del-reason]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.getAttribute("data-cond-del-reason");
        const next = loadUserConditions();
        const reasonMap = { ...(next.reasonMap || {}) };
        delete reasonMap[key];
        next.reasonMap = reasonMap;
        saveUserConditions(next);
        renderMapPanel();
      });
    });
  }

  function toggleMapPanel() {
    ensureMapStyles();
    const existing = document.getElementById(mapPanelId);
    if (existing) {
      stopMapPick();
      existing.remove();
      return;
    }
    renderMapPanel();
  }

  function extractRefundPayload() {
    clearHits();
    invalidatePageLines();
    const errors = [];
    const lines = pageLines();

    let orderNumber = extractOrderNumber();
    let { customer: rawCustomer, location: storeLocation } = extractBrandAndLocation(orderNumber);
    let customer = resolveCustomerName(rawCustomer);
    storeLocation = resolveLocationName(storeLocation);

    let dateRaw = valuesAfterLabel("Date ordered")[0] || "";
    let claimDate = parseClaimDate(dateRaw);

    let orderTime = extractTime(dateRaw);
    if (!orderTime) orderTime = extractOrderSubmittedTime();

    let orderValue = parseMoney(pickBestLabeledValue("Order total", "", true) || valuesAfterLabel("Order total")[0] || "");
    let disputeAmount = parseMoney(pickBestLabeledValue("Partner refund value", "", true) || "");

    const items = extractRefundedItems();
    const reasonValues = valuesAfterLabel("Refund reason").filter(
      (v) => REASON_ROW_RE.test(v) || /incomplete|missing|incorrect|prepared|food\s*safety/i.test(v)
    );
    const reasonFromLabel = [...reasonValues].reverse().find((v) => canonicalizeReason(v)) || "";
    const itemWithReason = items.find((item) => item && (item.reasonRaw || item.reason)) || {};
    const reasonFromItem = itemWithReason.reasonRaw || "";
    // Prefer item-row wording when label text was canonicalized away or polluted
    let refundReasonRaw = normalizeSpace(reasonFromItem || reasonFromLabel);
    if (reasonFromItem && /incomplete/i.test(reasonFromItem) && !/incomplete/i.test(reasonFromLabel || "")) {
      refundReasonRaw = normalizeSpace(reasonFromItem);
    }
    if (reasonFromLabel && /incomplete/i.test(reasonFromLabel)) {
      refundReasonRaw = normalizeSpace(reasonFromLabel);
    }
    let refundReason = canonicalizeReason(refundReasonRaw) || canonicalizeReason(itemWithReason.reason) || "";
    if (!refundReason) {
      const fromPage = lines.find((line) => REASON_ROW_RE.test(line) && canonicalizeReason(line));
      refundReasonRaw = normalizeSpace(fromPage || "");
      refundReason = canonicalizeReason(refundReasonRaw) || "";
    }

    const alreadyDisputed = detectAlreadyDisputed(lines);
    highlightHits();

    const matchedItems = itemsMatchingReason(items, refundReason);
    const disputeFields = buildDisputeFieldValues(matchedItems, refundReason, customer, storeLocation);

    let payload = {
      extractedAt: new Date().toISOString(),
      sourceUrl: window.location.href,
      claimDate: claimDate.raw,
      claimDateISO: claimDate.iso,
      claimDateDMY: claimDate.dmy,
      claimDateDash: claimDate.dash,
      orderTime,
      customer,
      location: storeLocation,
      platform: effectivePlatformLabel(),
      orderNumber,
      orderValue: orderValue == null ? "" : orderValue.toFixed(2),
      disputeAmount: disputeAmount == null ? "" : disputeAmount.toFixed(2),
      refundReason,
      refundReasonRaw,
      alreadyDisputed,
      outcome: "",
      videoSubmitted: effectiveVideoSubmitted(),
      reasonForDispute: resolveReasonForDispute(refundReason, refundReasonRaw),
      footageStatus: "",
      wrongFoodItem: disputeFields.wrongFoodItem,
      preparedIncorrectlyWhy: disputeFields.preparedIncorrectlyWhy,
      reason: disputeFields.reason || "",
      otherReason: disputeFields.otherReason,
      items,
      errors,
      fieldMapApplied: Object.keys(loadUserFieldMap()).length > 0,
    };

    payload = applyUserMapsToExtraction(payload);

    if (!payload.orderNumber) errors.push("Order Number");
    if (!payload.customer) errors.push("Customer");
    if (!payload.location) errors.push("Location");
    if (!payload.claimDateISO) errors.push("Date ordered");
    if (!payload.orderTime) errors.push("Order submitted");
    if (!payload.orderValue) errors.push("Order total");
    if (!payload.disputeAmount) errors.push("Partner refund value");
    if (!payload.refundReason) errors.push("Refund reason");
    payload.errors = errors;

    return payload;
  }

  function mount() {
    const body = document.body;
    if (!body) {
      document.addEventListener("DOMContentLoaded", mount, { once: true });
      return;
    }

    ensureButtonBar();

    if (isGoogleSheetsPage()) {
      const existing = document.getElementById(sheetBtnId);
      if (existing && existing.onclick) return;
      injectButton(sheetBtnId, platform.buttonSheetPaste || "Paste Deliveroo → Sheet Tab", onPasteSheetClick);
      return;
    }

    const existing = document.getElementById(btnId);
    const sheetExisting = document.getElementById(sheetBtnId);
    const mapExisting = document.getElementById(mapBtnId);
    if (
      existing &&
      existing.onclick &&
      (!isDeliverooHub() ||
        ((sheetExisting && sheetExisting.onclick) && mapExisting && mapExisting.onclick))
    ) {
      return;
    }

    if (isOpSpotPage()) {
      injectButton(btnId, platform.buttonFill || "Fill from Deliveroo", async () => {
        resetFillGuards();
        const payload = await loadPayload();
        if (!payload) {
          toast(`No stored order. Click ${platform.buttonExtract || "Auto-Fill & Dispute"} on the refund tab first, then click here.`, "error", 7000);
          return;
        }
        await applyPayloadToClaims(payload, { force: true });
      });
      return;
    }

    if (isDeliverooHub()) {
      ensureMapStyles();
      injectButton(btnId, platform.buttonExtract || "Auto-Fill & Dispute", onExtractClick);
      if (platform.buttonSheetCopy) {
        injectButton(sheetBtnId, platform.buttonSheetCopy, onCopySheetClick);
      }
      injectButton(mapBtnId, "Map & conditions", toggleMapPanel);
    }
  }

  function boot() {
    ensureStyles();
    if (typeof GM_registerMenuCommand === "function") {
      if (isGoogleSheetsPage()) {
        GM_registerMenuCommand(platform.buttonSheetPaste || "Paste Deliveroo → Sheet Tab", onPasteSheetClick);
      } else if (typeof location !== "undefined" && /opspot/i.test(location.host)) {
        GM_registerMenuCommand(platform.buttonFill || "Fill from Deliveroo", async () => {
          resetFillGuards();
          const payload = await loadPayload();
          if (!payload) {
            toast("No stored order. Run Auto-Fill on the refund tab first.", "error", 7000);
            return;
          }
          await applyPayloadToClaims(payload, { force: true });
        });
      } else {
        GM_registerMenuCommand(platform.buttonExtract || "Auto-Fill & Dispute", onExtractClick);
        if (platform.buttonSheetCopy) {
          GM_registerMenuCommand(platform.buttonSheetCopy, onCopySheetClick);
        }
        GM_registerMenuCommand("Map & conditions", toggleMapPanel);
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
        if (isGoogleSheetsPage()) {
          if (!document.getElementById(sheetBtnId)) remount();
        } else if (!document.getElementById(btnId) || (isDeliverooHub() && (!document.getElementById(mapBtnId) || (platform.buttonSheetCopy && !document.getElementById(sheetBtnId))))) {
          remount();
        }
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
      if (platform.sheetStorageKey) {
        GM_addValueChangeListener(platform.sheetStorageKey, (_n, _o, value, remote) => {
          if (remote && isGoogleSheetsPage() && value && value.row) {
            toast(`Ready for tab "${value.tab || "?"}": click ${platform.buttonSheetPaste || "Paste"}`, "info", 7000);
          }
        });
      }
    }
    setupOpSpotSaveHooks();
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
      else {
        const mapped = payload.fieldMapApplied ? " (custom maps)" : "";
        toast(`v2.2.2 stored order #${payload.orderNumber}${mapped}. Click ${platform.buttonFill || "Fill from Deliveroo"} on OpSpot.`, "success", 7000);
      }
    } catch (err) {
      toast(`Extraction failed: ${err.message || err}`, "error");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = platform.buttonExtract || "Auto-Fill & Dispute";
      }
    }
  }

  async function onCopySheetClick() {
    const btn = document.getElementById(sheetBtnId);
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Copying…";
    }
    try {
      const payload = extractRefundPayload();
      showPreview(payload);
      savePayload(payload);
      const transfer = buildSheetTransfer(payload);
      saveSheetTransfer(transfer);
      const ok = copyTextToClipboard(transfer.row);
      if (!ok) throw new Error("Clipboard blocked");
      const tabLabel = transfer.tab || "matching tab";
      if (payload.errors.length) {
        toast(`Copied for "${tabLabel}" with missing fields: ${payload.errors.join(", ")}. Open the sheet and click Paste.`, "error", 9000);
      } else {
        toast(`Copied #${payload.orderNumber} → tab "${tabLabel}". Open Google Sheet and click ${platform.buttonSheetPaste || "Paste"}.`, "success", 9000);
      }
    } catch (err) {
      toast(`Sheet copy failed: ${err.message || err}`, "error");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = platform.buttonSheetCopy || "Copy for Google Sheet";
      }
    }
  }

  async function onPasteSheetClick() {
    const btn = document.getElementById(sheetBtnId);
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Switching tab…";
    }
    try {
      const transfer = await loadSheetTransfer();
      if (!transfer || !transfer.row) {
        toast(`No copied Deliveroo row. Click ${platform.buttonSheetCopy || "Copy for Google Sheet"} on the refund page first.`, "error", 8000);
        return;
      }

      copyTextToClipboard(transfer.row);

      if (transfer.tab) {
        const switched = await activateGoogleSheetTab(transfer.tab);
        if (!switched.ok) {
          toast(`${switched.reason}. Row is on clipboard — select the "${transfer.tab}" tab and paste.`, "error", 9000);
          return;
        }
      }

      focusSheetPasteCell();
      toast(
        `On "${transfer.tab || "current"}" tab for #${transfer.orderNumber || "?"}. Click the next empty row and press Ctrl+V.`,
        "success",
        9000
      );
    } catch (err) {
      toast(`Sheet paste failed: ${err.message || err}`, "error");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = platform.buttonSheetPaste || "Paste Deliveroo → Sheet Tab";
      }
    }
  }

  boot();
})();
