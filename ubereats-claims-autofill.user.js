// ==UserScript==
// @name         Uber Eats Order → OpSpot Claims Auto-Fill
// @namespace    https://local.claims-ops
// @version      2.4.13
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
      noCamera: "No Camera",
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
      versionLabel: "2.4.13",
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
        "item reported wrong": "Incorrect Item",
        "reported wrong": "Incorrect Item",
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
        { test: "item\\s+reported\\s+wrong|reported\\s+wrong|wrong order|wrong item|incorrect", canonical: "incorrect item" },
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
        { type: "reasonIn", reasons: ["missing items", "food safety complaint"], footageKey: "irrelevant" },
        { type: "reasonIn", reasons: ["prepared incorrectly", "incorrect item"], footageKey: "irrelevant" },
      ],

      sheet: { enabled: false },

      /** Labels the Uber extractor prefers for dispute amount / order value */
      extractHints: {
        disputeAmountLabels: ["Chargeback Amount", "Marketplace Fee", "Refund", "Adjustment"],
        orderValueLabels: ["Sales (incl. VAT)", "Sales (incl. GST)", "Sales", "Subtotal"],
      },

      otherReasonIncludesCustomerLocation: false,
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
      versionLabel: "1.0.11",
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
      /** Do not fill OpSpot “Other reason” for Grubhub sheet rows */
      skipFillKeys: ["otherReason"],
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
      const fillList = (Array.isArray(workhorse.fills) && workhorse.fills.length ? workhorse.fills : defaultFills).filter(
        (item) => !(Array.isArray(platform.skipFillKeys) && platform.skipFillKeys.includes(item.key))
      );

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
    canonicalizeReason, normalizeCustomerName, mapReasonForDispute,
    resolveOutcomeMatch, computeFootageStatus,
    buildDisputeFieldValues, enrichPayload,
    savePayload, loadPayload, toast, showPreview, ensureStyles, injectButton, ensureButtonBar,
    applyPayloadToClaims, setupOpSpotSaveHooks, resetFillGuards, copyTextToClipboard,
    clearHits, highlightHits, hits, platform, version,
  } = core;

  const normalizeLocationName =
    typeof core.normalizeLocationName === "function"
      ? core.normalizeLocationName
      : (name) => normalizeSpace(name);

  const uiPrefix = platform.uiPrefix || "ucf";
  const btnId = `${uiPrefix}-btn`;
  const sheetBtnId = `${uiPrefix}-sheet-btn`;
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
    if (!/\d/.test(text)) return false;
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

  function stripTrailingAddress(text) {
    const value = normalizeSpace(text);
    const trailing = value.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
    if (trailing && looksLikeAddress(trailing[2])) return normalizeSpace(trailing[1]);
    return value;
  }

  function splitBrandDash(text) {
    const head = stripTrailingAddress(text);
    const parts = head.split(/\s+[–—−-]\s+/).map((part) => stripTrailingAddress(part)).filter(Boolean);
    if (parts.length < 2) return null;
    return { customer: parts[0], location: parts.slice(1).join(" - ") };
  }

  function parseBrandLocation(text) {
    const line = normalizeSpace(text);

    // Burger King (East Tamaki) (68 East Tamaki Road, Papatoetoe, Auckland)
    const dual = line.match(/^(.+?\([^)]+\))\s*\((.+)\)\s*$/);
    if (dual && looksLikeAddress(dual[2])) {
      return { customer: normalizeSpace(dual[1]), location: normalizeSpace(dual[2]) };
    }

    // KFC - Consett (Hermiston Retail Park, ...) → customer KFC, location Consett
    const dashed = splitBrandDash(line);
    if (dashed) return dashed;

    // Legacy: Brand (Store area) when the paren is not a street address
    const paren = line.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    if (paren) {
      const inside = normalizeSpace(paren[2]);
      if (looksLikeAddress(inside)) {
        return { customer: normalizeSpace(paren[1]), location: inside };
      }
      return { customer: line, location: "" };
    }

    return { customer: line, location: "" };
  }

  function extractBrandAndLocation() {
    const extractionRoot = getExtractionRoot();
    const dateRe = /[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}|\d{1,2},?\s+[A-Za-z]{3,9},?\s+\d{4}/;

    const tryPair = (customerText, locationText, el) => {
      const dashed = splitBrandDash(customerText);
      if (dashed) {
        hits.push({
          label: "Customer / Location",
          el: el || null,
          valueEl: el || null,
          value: `${dashed.customer} | ${dashed.location}`,
        });
        return dashed;
      }
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

  function isSectionHeader(line) {
    const text = normalizeSpace(line);
    if (!text) return true;
    if (ITEM_COMPONENT_RE.test(text)) return true;
    if (/^choose your\b/i.test(text)) return true;
    if (/^(hot wings|tender|tenders|fries|drinks?|sides?|burgers?)$/i.test(text)) return true;
    return false;
  }

  function isMoneyLabel(text) {
    return /sales|incl\.?\s*vat|incl\.?\s*gst|chargeback|net payout|marketplace/i.test(text);
  }

  function isStoreHeaderLine(line) {
    const text = normalizeSpace(line);
    if (!text) return false;
    if (looksLikeAddress(text)) return true;
    if (/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i.test(text)) return true;
    if (/.+\s-\s.+\s-\s/.test(text)) return true;
    return false;
  }

  function isSkippableItemLine(line) {
    const text = normalizeSpace(line);
    if (!text) return true;
    if (isSectionHeader(text) || isStoreHeaderLine(text) || looksLikeIssueBanner(text)) return true;
    if (/^\d+$/.test(text)) return true;
    if (/\b\d{1,2}:\d{2}\b/.test(text)) return true;
    if (/^(order|courier|net payout|sales|marketplace|chargeback)\b/i.test(text)) return true;
    return false;
  }

  function findOpenOrderPanel() {
    const nodes = document.querySelectorAll("[role='dialog'], aside, section, div");
    let seed = null;
    let seedLen = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (!visible(el)) continue;
      const text = el.innerText || "";
      if (text.length < 120 || text.length >= seedLen) continue;
      if (!/sales\s*\(\s*incl/i.test(text)) continue;
      if (!/chargeback amount|net payout/i.test(text)) continue;
      if (!/item reported missing|customization reported missing|order placed/i.test(text)) continue;
      if (/showing\s+\d+\s+results/i.test(text)) continue;
      seed = el;
      seedLen = text.length;
    }
    if (!seed) return null;

    let node = seed;
    let best = seed;
    for (let depth = 0; depth < 10 && node; depth++) {
      if (node === document.body || node === document.documentElement) break;
      const text = node.innerText || "";
      if (/showing\s+\d+\s+results/i.test(text)) break;
      best = node;
      const hasOrder = /\bOrder\s+#?\s*[A-Z0-9]{4,6}\b/i.test(text);
      const hasDate = /[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}/.test(text);
      const hasPlaced = /order placed/i.test(text);
      if (hasOrder && hasDate && hasPlaced) break;
      node = node.parentElement;
    }
    return best;
  }

  function getExtractionRoot() {
    return findOpenOrderPanel() || getActiveOrderRoot() || document.body;
  }

  function isCompactPostcode(token) {
    return /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/i.test(String(token || ""));
  }

  function firstOrderCode(text) {
    const tokens = String(text || "").match(/\b[A-Z0-9]{4,6}\b/g) || [];
    for (let i = 0; i < tokens.length; i++) {
      if (isCompactPostcode(tokens[i])) continue;
      const code = normalizeOrderCodeToken(tokens[i]);
      if (code && !isCompactPostcode(code)) return code;
    }
    return "";
  }

  function orderCodeFromOpenLink() {
    const path = location.pathname || "";
    const uuid = (path.match(/\/orders\/([a-f0-9-]{8,})/i) || [])[1];
    if (!uuid) return "";
    const nodes = document.querySelectorAll("a, tr, li, [role='row'], [role='link']");
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const href = el.getAttribute("href") || "";
      const snippet = (el.outerHTML || "").slice(0, 1800);
      if (!href.includes(uuid) && !snippet.includes(uuid)) continue;
      let node = el;
      for (let depth = 0; depth < 7 && node; depth++) {
        const text = node.innerText || node.textContent || "";
        if (text.length > 900) break;
        const code = firstOrderCode(text);
        if (code) return code;
        node = node.parentElement;
      }
    }
    return "";
  }

  function orderCodeNearPanelTop(root) {
    if (!root || !root.querySelectorAll) return "";
    const top = root.getBoundingClientRect().top;
    const nodes = root.querySelectorAll("h1, h2, h3, span, div, p, strong, button");
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (!visible(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.top > top + 160) continue;
      const own = ownText(el);
      if (!own || own.length > 8) continue;
      if (isCompactPostcode(own.replace(/\s+/g, ""))) continue;
      const code = normalizeOrderCodeToken(own);
      if (code) return code;
    }
    return "";
  }

  function orderCodeInPanel(root) {
    const text = (root && root.innerText) || "";
    const lines = text.split(/\n+/).map(normalizeSpace).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const same = lines[i].match(/^Order\s+#?\s*([A-Z0-9]{4,6})\b/i);
      if (same) {
        const code = normalizeOrderCodeToken(same[1]);
        if (code) return code;
      }
      if (/^Order\s*#?$/i.test(lines[i])) {
        for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
          if (/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i.test(lines[j])) continue;
          const code = normalizeOrderCodeToken(lines[j]);
          if (code) return code;
        }
      }
    }
    const re = /\bOrder\s+#?\s*([A-Z0-9]{4,6})\b/gi;
    let match;
    while ((match = re.exec(text))) {
      const code = normalizeOrderCodeToken(match[1]);
      if (code) return code;
    }
    return "";
  }

  function orderCodeFromHeading(root) {
    if (!root || !root.querySelectorAll) return "";
    const nodes = root.querySelectorAll("h1, h2, h3, span, div, p, strong");
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const own = ownText(el);
      if (!/^Order\s*#?$/i.test(own)) continue;
      let sib = el.nextElementSibling;
      for (let n = 0; n < 4 && sib; n++) {
        const text = ownText(sib) || normalizeSpace((sib.innerText || "").split("\n")[0]);
        if (!/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i.test(text)) {
          const code = normalizeOrderCodeToken(text);
          if (code) return code;
        }
        sib = sib.nextElementSibling;
      }
      const parentText = normalizeSpace((el.parentElement && el.parentElement.innerText) || "");
      const inline = parentText.match(/\bOrder\s+#?\s*([A-Z0-9]{4,6})\b/i);
      if (inline) {
        const code = normalizeOrderCodeToken(inline[1]);
        if (code) return code;
      }
    }
    return "";
  }

  function orderCodeFromSelectedRow(customer) {
    const hint = normalizeSpace(customer).toLowerCase();
    const rows = document.querySelectorAll("tr, [role='row'], a[href*='/orders/']");
    const found = [];
    for (let i = 0; i < rows.length; i++) {
      const el = rows[i];
      if (!visible(el)) continue;
      const text = normalizeSpace(el.innerText || "");
      if (!text || text.length > 220) continue;
      if (hint && hint.length >= 3 && !text.toLowerCase().includes(hint.slice(0, Math.min(hint.length, 12)))) continue;
      const tokens = text.match(/\b[A-Z0-9]{4,6}\b/g) || [];
      let code = "";
      for (let t = 0; t < tokens.length; t++) {
        const parsed = normalizeOrderCodeToken(tokens[t]);
        if (parsed) {
          code = parsed;
          break;
        }
      }
      if (!code) continue;
      const selected = el.getAttribute("aria-selected") === "true" || !!el.getAttribute("aria-current") || /selected|active/i.test(String(el.className || ""));
      found.push({ code, selected });
    }
    const picked = found.find((row) => row.selected);
    if (picked) return picked.code;
    if (found.length === 1) return found[0].code;
    return "";
  }

  function extractOrderNumber() {
    const root = getExtractionRoot();
    const fromPanel = orderCodeFromOpenLink() || orderCodeNearPanelTop(root) || orderCodeFromHeading(root) || orderCodeInPanel(root);
    const fromTitle = normalizeOrderCodeToken(((document.title || "").match(/\bOrder\s+#?\s*([A-Z0-9]{4,6})\b/i) || [])[1]);
    const { customer: rawCustomer } = extractBrandAndLocation();
    const fromList = orderCodeFromSelectedRow(isMoneyLabel(rawCustomer) ? "" : rawCustomer);
    const code = fromPanel || fromTitle || fromList;
    if (code) {
      hits.push({ label: "Order Number", el: root, valueEl: root, value: code });
      return code;
    }
    return "";
  }

  function extractClaimDateRaw() {
    const source = (getExtractionRoot().innerText || "");
    const monthDate = source.match(
      /([A-Za-z]{3,9})\s+\d{1,2},?\s+\d{4}|\d{1,2},?\s+[A-Za-z]{3,9},?\s+\d{4}/
    );
    if (monthDate) return monthDate[0];
    const lines = pageLines();
    return lines.find((line) => /[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}/.test(line)) || "";
  }

  function extractOrderPlacedTime() {
    const lines = pageLines();
    for (let i = 0; i < lines.length; i++) {
      if (!/order placed/i.test(lines[i])) continue;
      const time = extractTime(lines[i]) || extractTime(lines[i - 1] || "") || extractTime(lines[i + 1] || "");
      if (time) {
        hits.push({ label: "Order Time", el: null, valueEl: null, value: time });
        return time;
      }
    }
    return "";
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
        if (key !== wanted && !key.startsWith(`${wanted} `) && !key.startsWith(`${wanted}(`)) continue;
        const onLabelLine = key === wanted ? null : parseMoney(lines[i]);
        const amount = onLabelLine != null ? onLabelLine : (parseMoney(lines[i + 1]) ?? parseMoney(lines[i]));
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

  function cleanIssueLine(line) {
    return normalizeSpace(line).replace(/^[^a-z0-9]+/i, "");
  }

  function subtitleIssue(line) {
    const text = cleanIssueLine(line);
    if (/^item\s+reported\s+missing$/i.test(text)) return "item reported missing";
    if (/^item\s+reported\s+wrong$/i.test(text)) return "item reported wrong";
    if (/^customization\s+reported\s+missing$/i.test(text)) return "customization reported missing";
    if (/^customization\s+reported\s+wrong$/i.test(text)) return "customization reported wrong";
    return "";
  }

  function looksLikeIssueBanner(line) {
    return /items?\s+reported\s+missing|deducted from net payout|customer reported|dispute access|authorized users/i.test(line);
  }

  function isIssueMarkerLine(line) {
    return (
      !!subtitleIssue(line) ||
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

  function findIssueItemNameBefore(lines, fromIndex) {
    for (let i = fromIndex - 1; i >= Math.max(0, fromIndex - 12); i--) {
      const line = lines[i];
      if (isIssueMarkerLine(line)) continue;
      if (looksLikeIssueBanner(line) || isSkippableItemLine(line)) {
        if (looksLikeIssueBanner(line) || isStoreHeaderLine(line)) break;
        continue;
      }

      const pricedName = parsePricedItemName(line);
      if (pricedName && !isSkippableItemLine(pricedName)) return pricedName;

      if (/(?:NZ\$|\$|£|€)\s*\d/.test(line) && i > 0) {
        const prev = normalizeSpace(lines[i - 1]);
        if (isValidItemName(prev) && !isSkippableItemLine(prev)) return prev;
      }

      const name = normalizeSpace(line);
      if (/^\d+(\.\d+)?\s*(ml|l|g|kg|oz|pcs?|pc)$/i.test(name)) continue;
      if (!isValidItemName(name) || isSkippableItemLine(name)) continue;
      if (name.length <= 80) return name;
    }
    return "";
  }

  function pushIssueItem(issueItems, name, issue) {
    const cleanName = normalizeSpace(name);
    if (!cleanName || !isValidItemName(cleanName) || isSkippableItemLine(cleanName)) return;
    issueItems.push({
      name: cleanName,
      issue,
      reason: canonicalizeReason(issue),
    });
  }

  function extractSubtitledItemsFromDom() {
    const root = getExtractionRoot();
    const nodes = root.querySelectorAll("span, div, p, li");
    const issueItems = [];
    for (let n = 0; n < nodes.length; n++) {
      const el = nodes[n];
      if (!visible(el)) continue;
      const full = normalizeSpace(el.innerText || el.textContent || "");
      if (!full || full.length > 60) continue;
      const issue = subtitleIssue(ownText(el) || full);
      if (!issue) continue;
      let name = "";
      let node = el;
      for (let depth = 0; depth < 5 && node && !name; depth++) {
        let prev = node.previousElementSibling;
        let hops = 0;
        while (prev && hops < 4 && !name) {
          const lines = normalizeSpace(prev.innerText || "").split(/\n+/).map(normalizeSpace).filter(Boolean);
          name = findIssueItemNameBefore(lines.concat(["Item reported missing"]), lines.length);
          prev = prev.previousElementSibling;
          hops++;
        }
        node = node.parentElement;
      }
      if (name) pushIssueItem(issueItems, name, issue);
    }
    return uniqueBy(issueItems, (item) => normalizeKey(item.name));
  }

  function scanIssueItems(lines, reasonFromPage) {
    const issueItems = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const issue = subtitleIssue(line);
      if (issue) {
        const name = findIssueItemNameBefore(lines, i);
        if (name) pushIssueItem(issueItems, name, issue);
        continue;
      }
      if (ISSUE_ITEM_MISSING_RE.test(line)) {
        const name = findIssueItemNameBefore(lines, i);
        if (name) pushIssueItem(issueItems, name, "item reported missing");
        continue;
      }
      if (issue === "customization reported missing" || ISSUE_CUSTOMIZATION_MISSING_RE.test(line)) {
        const name = findIssueItemNameBefore(lines, i);
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
    const fromDom = extractSubtitledItemsFromDom();
    if (fromDom.length) return fromDom;
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
    const named = (items || []).filter((item) => item && item.name && isValidItemName(item.name));
    const subtitled = named.filter((item) => item.issue);
    const pool = subtitled.length ? subtitled : named;
    const wanted = canonicalizeReason(refundReason);
    const matched = pool.filter((item) => canonicalizeReason(item.reason) === wanted);
    if (matched.length) return matched;
    return pool;
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

  const FIELD_MAP_KEY = "ubereats_user_field_map_v1";
  const CONDITIONS_KEY = "ubereats_user_conditions_v1";
  const mapBtnId = `${uiPrefix}-map-btn`;
  const mapPanelId = `${uiPrefix}-map-panel`;
  let userFieldMapCache = null;
  let userConditionsCache = null;
  let mapPanelTab = "fields";
  let mapPanelPos = { top: 72, left: 18 };
  let mapPickKey = null;
  let mapPickHandler = null;

  const MAPPABLE_FIELDS = [
    { key: "orderNumber", label: "Order Number" },
    { key: "customer", label: "Customer" },
    { key: "location", label: "Location" },
    { key: "claimDate", label: "Claim Date" },
    { key: "orderTime", label: "Order Time" },
    { key: "orderValue", label: "Order Value" },
    { key: "disputeAmount", label: "Dispute Amount" },
    { key: "refundReason", label: "Refund Reason → Reason for Dispute" },
    { key: "otherReason", label: "Other reason" },
  ];

  function persistGm(key, value) {
    try {
      if (typeof GM_setValue === "function") GM_setValue(key, value);
    } catch (err) {
      console.warn("[Uber Claims] GM_setValue failed", err);
    }
    try {
      if (typeof GM !== "undefined" && GM.setValue) {
        Promise.resolve(GM.setValue(key, value)).catch((err) => console.warn("[Uber Claims] GM.setValue failed", err));
      }
    } catch (err) {
      console.warn("[Uber Claims] GM.setValue failed", err);
    }
    try {
      if (typeof GM_setValue === "function") GM_setValue(`${key}__json`, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  }

  function readGm(key) {
    let value = null;
    try {
      if (typeof GM_getValue === "function") value = GM_getValue(key, null);
    } catch {
      value = null;
    }
    if (value && typeof value.then === "function") value = null;
    if (value != null && value !== "") return value;
    try {
      if (typeof GM_getValue === "function") value = GM_getValue(`${key}__json`, null);
    } catch {
      value = null;
    }
    if (typeof value === "string" && value.trim().startsWith("{")) {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }
    return value != null && value !== "" ? value : null;
  }

  function loadUserFieldMap() {
    if (userFieldMapCache) return userFieldMapCache;
    let map = readGm(FIELD_MAP_KEY);
    if (typeof map === "string") {
      try {
        map = JSON.parse(map);
      } catch {
        map = null;
      }
    }
    userFieldMapCache = map && typeof map === "object" && !Array.isArray(map) ? map : {};
    return userFieldMapCache;
  }

  function saveUserFieldMap(map) {
    userFieldMapCache = map && typeof map === "object" ? { ...map } : {};
    persistGm(FIELD_MAP_KEY, userFieldMapCache);
  }

  function defaultUserConditions() {
    return {
      locationAliases: [],
      customerAliases: [],
      reasonMap: {},
      disputeThresholdGbp: null,
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
      if (Array.isArray(reasons)) reasons = reasons.map((r) => normalizeSpace(r)).filter(Boolean);
      else if (typeof reasons === "string" && reasons) reasons = [normalizeSpace(reasons)];
      else reasons = [];
      out[key] = {
        outcome: normalizeSpace(val.outcome || ""),
        footage: normalizeSpace(val.footage || ""),
        reasonForDispute: reasons,
      };
    }
    return out;
  }

  function coerceConditions(data) {
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        data = null;
      }
    }
    const thresholdRaw = data && data.disputeThresholdGbp;
    const thresholdNum = thresholdRaw == null || thresholdRaw === "" ? null : Number(thresholdRaw);
    return {
      ...defaultUserConditions(),
      ...(data && typeof data === "object" ? data : {}),
      locationAliases: Array.isArray(data && data.locationAliases) ? data.locationAliases : [],
      customerAliases: Array.isArray(data && data.customerAliases) ? data.customerAliases : [],
      reasonMap: data && data.reasonMap && typeof data.reasonMap === "object" ? data.reasonMap : {},
      disputeThresholdGbp: thresholdNum != null && !Number.isNaN(thresholdNum) ? thresholdNum : null,
      videoSubmitted: data && data.videoSubmitted ? normalizeSpace(data.videoSubmitted) : null,
      platformLabel: data && data.platformLabel ? normalizeSpace(data.platformLabel) : null,
      conditionTweaks: normalizeConditionTweaks(data && data.conditionTweaks),
    };
  }

  function loadUserConditions() {
    if (userConditionsCache) return userConditionsCache;
    userConditionsCache = coerceConditions(readGm(CONDITIONS_KEY));
    return userConditionsCache;
  }

  function saveUserConditions(data) {
    userConditionsCache = coerceConditions(data);
    persistGm(CONDITIONS_KEY, userConditionsCache);
  }

  function effectiveDisputeThreshold() {
    const user = loadUserConditions().disputeThresholdGbp;
    if (user != null && !Number.isNaN(Number(user))) return Number(user);
    return workhorse.disputeThresholdGbp || 2;
  }

  function defaultTweakFor(key) {
    const o = workhorse.outcomeOptions || {};
    const f = workhorse.footageStatusOptions || {};
    const map = {
      underDisputeThreshold: { outcome: o.notDisputed, footage: f.irrelevant, reasonForDispute: [] },
      alreadyDisputed: { outcome: o.reviewed, footage: f.disputedByThirdParty, reasonForDispute: [] },
      missingFoodSafety: { outcome: o.awaitingReview, footage: f.irrelevant, reasonForDispute: [] },
      preparedIncorrect: { outcome: o.pending, footage: f.irrelevant, reasonForDispute: [] },
    };
    return map[key] || { outcome: "", footage: "", reasonForDispute: [] };
  }

  function effectiveTweak(key) {
    const saved = (loadUserConditions().conditionTweaks || {})[key] || {};
    const defaults = defaultTweakFor(key);
    const reasons = Array.isArray(saved.reasonForDispute) ? saved.reasonForDispute : defaults.reasonForDispute || [];
    return {
      outcome: saved.outcome || defaults.outcome || "",
      footage: saved.footage || defaults.footage || "",
      reasonForDispute: reasons.filter(Boolean),
    };
  }

  function withConditionContext(ctx) {
    return Object.assign({}, ctx || {}, {
      disputeThreshold: effectiveDisputeThreshold(),
      conditionTweaks: loadUserConditions().conditionTweaks || {},
    });
  }

  function escapeAttr(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;");
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
    const seen = new Set();
    for (const key of [rawKey, normalizeKey(refundReason), canonical, normalizeKey(canonical)].filter(Boolean)) {
      if (seen.has(key)) continue;
      seen.add(key);
      if (userMap[key]) return userMap[key];
    }
    return mapReasonForDispute(canonical) || mapReasonForDispute(rawKey) || "";
  }

  function pickReasonForDisputeFromChecks(selected, mappedReason, refundReason, refundReasonRaw) {
    const list = (Array.isArray(selected) ? selected : []).map((r) => normalizeSpace(r)).filter(Boolean);
    if (!list.length) return "";
    if (mappedReason && list.some((r) => normalizeKey(r) === normalizeKey(mappedReason))) return mappedReason;
    const raw = `${normalizeKey(refundReasonRaw || "")} ${canonicalizeReason(refundReasonRaw || refundReason) || ""}`;
    const find = (re) => list.find((r) => re.test(normalizeKey(r)));
    if (/food\s*safety/.test(raw)) return find(/food\s*safety/) || find(/^other$/) || list[0];
    if (/missing/.test(raw)) return find(/missing/) || list[0];
    if (/prepared/.test(raw)) return find(/prepared/) || list[0];
    if (/incorrect|wrong/.test(raw)) return find(/incorrect/) || list[0];
    return list[0];
  }

  function applyFieldMaps(base) {
    const map = loadUserFieldMap();
    const out = Object.assign({}, base);
    for (const field of MAPPABLE_FIELDS) {
      const mapping = map[field.key];
      if (!mapping) continue;
      let raw = "";
      if (mapping.type === "afterLabel" && mapping.label) {
        const vals = valuesAfterLabel(mapping.label);
        raw = (mapping.sampleValue && vals.find((v) => normalizeKey(v) === normalizeKey(mapping.sampleValue))) || vals[0] || mapping.sampleValue || "";
      } else if (mapping.type === "orderNumber") {
        raw = extractOrderNumber() || mapping.sampleValue || "";
      } else {
        raw = mapping.sampleValue || "";
      }
      raw = normalizeSpace(raw);
      if (!raw) continue;
      if (field.key === "orderNumber") {
        const code = normalizeOrderCodeToken(raw) || raw;
        if (code) out.orderNumber = code;
      } else if (field.key === "customer") out.customer = raw;
      else if (field.key === "location") out.location = raw;
      else if (field.key === "claimDate") {
        const claimDate = parseClaimDate(raw);
        out.claimDate = claimDate.raw || raw;
        out.claimDateISO = claimDate.iso;
        out.claimDateDMY = claimDate.dmy;
        out.claimDateDash = claimDate.dash;
      } else if (field.key === "orderTime") out.orderTime = extractTime(raw) || raw;
      else if (field.key === "orderValue" || field.key === "disputeAmount") {
        const n = parseMoney(raw);
        if (n != null) out[field.key] = Math.abs(n).toFixed(2);
      } else if (field.key === "refundReason") {
        out.refundReasonRaw = raw;
        out.refundReason = canonicalizeReason(raw) || raw;
      } else if (field.key === "otherReason") out.otherReason = raw;
    }
    return out;
  }

  function applyConditions(payload) {
    const out = Object.assign({}, payload);
    out.customer = resolveCustomerName(out.customer);
    out.location = resolveLocationName(out.location);
    if (loadUserConditions().videoSubmitted) out.videoSubmitted = loadUserConditions().videoSubmitted;
    if (loadUserConditions().platformLabel) out.platform = loadUserConditions().platformLabel;
    out.reasonForDispute = resolveReasonForDispute(out.refundReason, out.refundReasonRaw) || out.reasonForDispute;
    const ctx = withConditionContext({
      disputeAmount: parseMoney(out.disputeAmount),
      alreadyDisputed: !!out.alreadyDisputed,
      refundReason: out.refundReason,
      refundReasonRaw: out.refundReasonRaw,
      reasonForDispute: out.reasonForDispute,
      customer: out.customer,
      location: out.location,
    });
    const outcomeMatch = typeof resolveOutcomeMatch === "function" ? resolveOutcomeMatch(ctx) : { outcome: "", reasonForDispute: [] };
    if (outcomeMatch.outcome) out.outcome = outcomeMatch.outcome;
    const picked = pickReasonForDisputeFromChecks(
      outcomeMatch.reasonForDispute,
      out.reasonForDispute,
      out.refundReason,
      out.refundReasonRaw
    );
    if (picked) out.reasonForDispute = picked;
    if (typeof computeFootageStatus === "function") {
      const footage = computeFootageStatus(ctx);
      if (footage) out.footageStatus = footage;
    }
    return out;
  }

  function applyUserOverlay(payload) {
    const mapped = isUberEatsPage() ? applyFieldMaps(payload) : payload;
    return applyConditions(mapped);
  }

  function outcomeSelectHtml(name, selected) {
    return `<select data-tweak-outcome="${escapeAttr(name)}">${Object.values(workhorse.outcomeOptions || {})
      .map((v) => `<option value="${escapeAttr(v)}" ${v === selected ? "selected" : ""}>${escapeAttr(v)}</option>`)
      .join("")}</select>`;
  }

  function footageSelectHtml(name, selected) {
    return `<select data-tweak-footage="${escapeAttr(name)}">${Object.values(workhorse.footageStatusOptions || {})
      .map((v) => `<option value="${escapeAttr(v)}" ${v === selected ? "selected" : ""}>${escapeAttr(v)}</option>`)
      .join("")}</select>`;
  }

  function reasonChecksHtml(name, selected) {
    const selectedKeys = new Set((selected || []).map((v) => normalizeKey(v)));
    const opts = [...new Set(
      Object.values(platform.reasonMap || {}).concat([
        "Missing Item",
        "Incorrect Item",
        "Prepared incorrectly",
        "Food safety complaint",
        workhorse.reasonForDisputeOtherOption || "Other",
      ])
    )];
    return opts.map((v) => `<label class="${uiPrefix}-cond-check"><input type="checkbox" data-tweak-dispute-reason="${escapeAttr(name)}" value="${escapeAttr(v)}" ${selectedKeys.has(normalizeKey(v)) ? "checked" : ""} /> ${escapeAttr(v)}</label>`).join("");
  }

  function renderAliasList(kind, aliases) {
    if (!aliases.length) return `<div class="${uiPrefix}-cond-meta">None yet.</div>`;
    return aliases.map((rule, index) => `<div class="${uiPrefix}-cond-item"><span style="flex:1"><code>${escapeAttr(rule.match)}</code> → <strong>${escapeAttr(rule.value)}</strong></span><button type="button" data-cond-del="${kind}" data-cond-index="${index}">Remove</button></div>`).join("");
  }

  function ensureMapStyles() {
    const styleId = `${uiPrefix}-map-style`;
    if (document.getElementById(styleId)) return;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      #${mapBtnId} {
        background: #047857 !important; color: #ecfdf5 !important; border: 0 !important; cursor: pointer !important;
        border-radius: 999px !important; padding: 12px 22px !important;
        box-shadow: 0 10px 30px rgba(0,0,0,.35) !important;
        font: 700 15px/1.2 Segoe UI, system-ui, sans-serif !important;
      }
      #${mapPanelId} {
        position: fixed !important; inset: auto !important; margin: 0 !important;
        z-index: 2147483647 !important; display: block !important;
        width: min(480px, 94vw) !important; height: auto !important; max-height: 78vh !important; overflow: auto !important;
        background: #052e16 !important; color: #ecfdf5 !important; border: 0 !important; border-radius: 12px !important;
        padding: 0 14px 14px !important; box-shadow: 0 16px 48px rgba(0,0,0,.45) !important;
        font: 13px/1.4 Segoe UI, system-ui, sans-serif !important;
        pointer-events: auto !important;
      }
      #${mapPanelId}::backdrop { background: transparent !important; pointer-events: none !important; }
      #${mapPanelId} * { box-sizing: border-box; }
      #${mapPanelId} input, #${mapPanelId} select, #${mapPanelId} textarea {
        pointer-events: auto !important; user-select: text !important; -webkit-user-select: text !important;
        min-width: 0 !important;
      }
      #${mapPanelId} .${uiPrefix}-map-drag {
        display: flex; align-items: center; gap: 8px; margin: 0 -14px 10px; padding: 12px 14px 8px;
        cursor: grab; user-select: none; position: sticky; top: 0; background: #052e16; z-index: 2;
        border-bottom: 1px solid #14532d;
      }
      #${mapPanelId} .${uiPrefix}-map-drag h3 { margin: 0; flex: 1; font-size: 15px; color: #fff; }
      #${mapPanelId} .${uiPrefix}-map-tabs { display: flex; gap: 6px; margin-bottom: 10px; }
      #${mapPanelId} .${uiPrefix}-map-tabs button {
        flex: 1; border: 0; border-radius: 8px; padding: 8px; cursor: pointer; font-weight: 700;
        background: #14532d; color: #bbf7d0;
      }
      #${mapPanelId} .${uiPrefix}-map-tabs button.active { background: #06c167; color: #052e16; }
      #${mapPanelId} p, #${mapPanelId} .${uiPrefix}-cond-meta { color: #86efac; font-size: 12px; }
      #${mapPanelId} .${uiPrefix}-map-row { padding: 8px 0; border-top: 1px solid #14532d; }
      #${mapPanelId} .${uiPrefix}-map-row-top, #${mapPanelId} .${uiPrefix}-cond-item, #${mapPanelId} .${uiPrefix}-cond-row {
        display: flex; gap: 8px; align-items: center;
      }
      #${mapPanelId} button.${uiPrefix}-add, #${mapPanelId} .${uiPrefix}-map-row button {
        border: 0; border-radius: 8px; padding: 6px 10px; cursor: pointer; font-weight: 700;
        background: #06c167; color: #052e16;
      }
      #${mapPanelId} .${uiPrefix}-map-row button.armed { background: #fbbf24; color: #111; }
      #${mapPanelId} input, #${mapPanelId} select {
        width: 100%; border: 1px solid #166534; border-radius: 6px; padding: 6px 8px;
        background: #022c22; color: #fff; font-size: 12px;
      }
      #${mapPanelId} .${uiPrefix}-cond-form { display: grid; grid-template-columns: 1fr 1fr auto; gap: 6px; margin: 6px 0; }
      #${mapPanelId} .${uiPrefix}-cond-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 6px; margin-top: 6px; }
      #${mapPanelId} .${uiPrefix}-cond-card { margin: 8px 0; padding: 8px; border-radius: 8px; background: #064e3b; }
      #${mapPanelId} .${uiPrefix}-cond-actions { display: flex; gap: 8px; margin-top: 12px; }
      #${mapPanelId} .${uiPrefix}-cond-actions button { flex: 1; border: 0; border-radius: 8px; padding: 8px; cursor: pointer; font-weight: 700; background: #14532d; color: #fff; }
      #${mapPanelId} .${uiPrefix}-cond-item button { border: 0; border-radius: 6px; padding: 4px 8px; cursor: pointer; background: #7f1d1d; color: #fff; }
      #${mapPanelId} .${uiPrefix}-cond-check { display: flex; gap: 6px; align-items: center; margin-top: 4px; }
      #${mapPanelId} .${uiPrefix}-close {
        background: #14532d; color: #fff; border: 0; border-radius: 8px; padding: 6px 10px; cursor: pointer; font-weight: 700;
      }
      body.${uiPrefix}-map-picking, body.${uiPrefix}-map-picking * { cursor: crosshair !important; }
    `;
    document.documentElement.appendChild(style);
  }

  function pinMapPanel(panel) {
    panel.style.setProperty("position", "fixed", "important");
    panel.style.setProperty("inset", "auto", "important");
    panel.style.setProperty("margin", "0", "important");
    panel.style.setProperty("right", "auto", "important");
    panel.style.setProperty("bottom", "auto", "important");
    panel.style.setProperty("transform", "none", "important");
    panel.style.setProperty("border", "0", "important");
    panel.style.setProperty("width", "min(480px, 94vw)", "important");
    panel.style.setProperty("height", "auto", "important");
    panel.style.setProperty("left", `${mapPanelPos.left}px`, "important");
    panel.style.setProperty("top", `${mapPanelPos.top}px`, "important");
    panel.style.setProperty("z-index", "2147483647", "important");
    panel.style.setProperty("pointer-events", "auto", "important");
    panel.style.setProperty("display", "block", "important");
  }

  function showMapPanel(panel) {
    if (!panel.isConnected) document.documentElement.appendChild(panel);
    panel.setAttribute("popover", "manual");
    pinMapPanel(panel);
    if (typeof panel.showPopover === "function") {
      try {
        if (!panel.matches(":popover-open")) panel.showPopover();
      } catch (err) {
        console.warn("[Uber Claims] showPopover failed", err);
      }
    }
    pinMapPanel(panel);
  }

  function keepPanelTyping(panel) {
    if (!panel || panel.dataset.typingBound === "1") return;
    panel.dataset.typingBound = "1";
    const stop = (event) => {
      if (event.target.closest("input, textarea, select")) event.stopPropagation();
    };
    ["keydown", "keypress", "keyup", "beforeinput", "input", "paste", "focusin"].forEach((type) => {
      panel.addEventListener(type, stop, true);
    });
  }

  function enableMapDrag(panel) {
    if (!panel || panel.dataset.dragBound === "1") return;
    panel.dataset.dragBound = "1";
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;
    const onMove = (event) => {
      if (!dragging) return;
      const width = panel.offsetWidth || 480;
      mapPanelPos = {
        left: Math.min(Math.max(8, originLeft + event.clientX - startX), Math.max(8, window.innerWidth - width - 8)),
        top: Math.min(Math.max(8, originTop + event.clientY - startY), Math.max(8, window.innerHeight - 72)),
      };
      pinMapPanel(panel);
    };
    const onUp = () => {
      dragging = false;
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
    };
    panel.addEventListener("pointerdown", (event) => {
      if (!event.target.closest(`.${uiPrefix}-map-drag`) || event.target.closest("button")) return;
      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      originLeft = panel.offsetLeft || mapPanelPos.left;
      originTop = panel.offsetTop || mapPanelPos.top;
      event.preventDefault();
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
    }, true);
  }

  function mappingSummary(mapping) {
    if (!mapping) return "Default (auto)";
    if (mapping.type === "afterLabel") return `After “${mapping.label}” → ${mapping.sampleValue || ""}`;
    if (mapping.type === "orderNumber") return `Order code (${mapping.sampleValue || ""})`;
    return `Clicked text: ${mapping.sampleValue || "?"}`;
  }

  function stopMapPick() {
    if (mapPickHandler) {
      document.removeEventListener("click", mapPickHandler, true);
      mapPickHandler = null;
    }
    mapPickKey = null;
    document.body && document.body.classList.remove(`${uiPrefix}-map-picking`);
  }

  function inferMappingFromElement(el, fieldKey) {
    if (!el || el.closest(`#${mapPanelId}, #${uiPrefix}-btn-bar`)) return null;
    let node = el.nodeType === 3 ? el.parentElement : el;
    while (node && node !== document.body && normalizeSpace(node.innerText || "").length > 140) node = node.parentElement;
    if (!node || node === document.body) return null;
    const value = normalizeSpace((ownText(node) || node.innerText || "").split("\n")[0]);
    if (!value || value.length > 120) return null;
    let label = "";
    const prev = node.previousElementSibling;
    if (prev) {
      const prevText = normalizeSpace((ownText(prev) || prev.innerText || "").split("\n")[0]);
      if (prevText && prevText.length < 48 && normalizeKey(prevText) !== normalizeKey(value)) label = prevText;
    }
    if (!label) {
      const lines = pageLines();
      const idx = lines.findIndex((line) => line === value);
      if (idx > 0 && lines[idx - 1].length < 48) label = lines[idx - 1];
    }
    if (fieldKey === "orderNumber") return { type: "orderNumber", sampleValue: value };
    if (fieldKey === "disputeAmount" && !label) label = "Chargeback Amount";
    if (fieldKey === "orderValue" && !label) label = "Sales (incl. VAT)";
    if (label && normalizeKey(label) !== normalizeKey(value)) return { type: "afterLabel", label, sampleValue: value };
    return { type: "literal", sampleValue: value };
  }

  function startMapPick(fieldKey) {
    if (!isUberEatsPage()) {
      toast("Open the Uber Eats order, then click the value on that page.", "info", 5000);
      return;
    }
    stopMapPick();
    mapPickKey = fieldKey;
    document.body.classList.add(`${uiPrefix}-map-picking`);
    const label = (MAPPABLE_FIELDS.find((f) => f.key === fieldKey) || {}).label || fieldKey;
    toast(`Click the Uber Eats value for “${label}”.`, "info", 6000);
    renderMapPanel();
    mapPickHandler = (event) => {
      if (event.target.closest(`#${mapPanelId}, #${uiPrefix}-btn-bar`)) return;
      event.preventDefault();
      event.stopPropagation();
      const mapping = inferMappingFromElement(event.target, fieldKey);
      stopMapPick();
      if (!mapping) {
        toast("Could not read that click. Try the value text itself.", "error");
        renderMapPanel();
        return;
      }
      const map = Object.assign({}, loadUserFieldMap(), { [fieldKey]: mapping });
      saveUserFieldMap(map);
      toast(`Mapped ${label}. Extract again to use it.`, "success", 4000);
      renderMapPanel();
    };
    document.addEventListener("click", mapPickHandler, true);
  }

  function renderMapPanel() {
    ensureMapStyles();
    let panel = document.getElementById(mapPanelId);
    if (!panel || !panel.isConnected) {
      panel = document.createElement("div");
      panel.id = mapPanelId;
      panel.setAttribute("popover", "manual");
      document.documentElement.appendChild(panel);
      enableMapDrag(panel);
      keepPanelTyping(panel);
    }
    showMapPanel(panel);
    const map = loadUserFieldMap();
    const conditions = loadUserConditions();
    const fieldRows = MAPPABLE_FIELDS.map((field) => {
      const mapping = map[field.key];
      const armed = mapPickKey === field.key;
      return `<div class="${uiPrefix}-map-row">
        <div class="${uiPrefix}-map-row-top"><strong style="flex:1">${escapeAttr(field.label)}</strong>
          <button type="button" data-map-key="${field.key}" class="${armed ? "armed" : ""}">${armed ? "Click page…" : "Select on page"}</button>
          ${mapping ? `<button type="button" data-map-clear="${field.key}" style="background:#7f1d1d;color:#fff">Clear</button>` : ""}
        </div>
        <div class="${uiPrefix}-cond-meta">${escapeAttr(mappingSummary(mapping))}</div>
      </div>`;
    }).join("");
    const under = effectiveTweak("underDisputeThreshold");
    const contested = effectiveTweak("alreadyDisputed");
    const missing = effectiveTweak("missingFoodSafety");
    const prepared = effectiveTweak("preparedIncorrect");
    const presetReasons = Object.keys(platform.reasonMap || {});
    const reasonKeys = [...new Set(presetReasons.concat(Object.keys(conditions.reasonMap || {})))];
    const reasonRows = reasonKeys.map((from) => {
      const to = (conditions.reasonMap || {})[from] || (platform.reasonMap || {})[from] || "";
      return `<div class="${uiPrefix}-cond-row"><code style="flex:0 0 42%">${escapeAttr(from)}</code><input data-reason-edit="${escapeAttr(from)}" value="${escapeAttr(to)}" /></div>`;
    }).join("");
    const fieldsBody = `
      <p>Pick a field, then click the matching text on the Uber Eats order. Drag the title bar to move this panel.</p>
      ${fieldRows}
      <div class="${uiPrefix}-cond-actions"><button type="button" data-map-action="clear-all">Clear maps</button></div>`;
    const conditionsBody = `
      <p>Uber Eats text → Workhorse. Re-extract after saving. Footage includes <strong>No Camera</strong>.</p>
      <h4>Customer aliases</h4>
      ${renderAliasList("customerAliases", conditions.customerAliases)}
      <div class="${uiPrefix}-cond-form">
        <input data-cond-from="customerAliases" placeholder="Uber customer" />
        <input data-cond-to="customerAliases" placeholder="Workhorse customer" />
        <button type="button" class="${uiPrefix}-add" data-cond-add="customerAliases">Add</button>
      </div>
      <h4>Location aliases</h4>
      ${renderAliasList("locationAliases", conditions.locationAliases)}
      <div class="${uiPrefix}-cond-form">
        <input data-cond-from="locationAliases" placeholder="Uber location" />
        <input data-cond-to="locationAliases" placeholder="Workhorse location" />
        <button type="button" class="${uiPrefix}-add" data-cond-add="locationAliases">Add</button>
      </div>
      <div class="${uiPrefix}-cond-card"><strong>Chargeback ≤ £…</strong>
        <div class="${uiPrefix}-cond-grid"><input data-threshold-gbp type="number" min="0" step="0.01" value="${escapeAttr(String(effectiveDisputeThreshold()))}" />${outcomeSelectHtml("underDisputeThreshold", under.outcome)}${footageSelectHtml("underDisputeThreshold", under.footage)}</div>
      </div>
      <div class="${uiPrefix}-cond-card"><strong>Already disputed</strong>
        <div class="${uiPrefix}-cond-grid">${outcomeSelectHtml("alreadyDisputed", contested.outcome)}${footageSelectHtml("alreadyDisputed", contested.footage)}</div>
      </div>
      <div class="${uiPrefix}-cond-card"><strong>Missing / food safety</strong>
        <div class="${uiPrefix}-cond-grid">${outcomeSelectHtml("missingFoodSafety", missing.outcome)}${footageSelectHtml("missingFoodSafety", missing.footage)}</div>
        ${reasonChecksHtml("missingFoodSafety", missing.reasonForDispute)}
      </div>
      <div class="${uiPrefix}-cond-card"><strong>Prepared incorrectly / Incorrect item</strong>
        <div class="${uiPrefix}-cond-grid">${outcomeSelectHtml("preparedIncorrect", prepared.outcome)}${footageSelectHtml("preparedIncorrect", prepared.footage)}</div>
        ${reasonChecksHtml("preparedIncorrect", prepared.reasonForDispute)}
      </div>
      <div class="${uiPrefix}-cond-card"><strong>Video Submitted</strong>
        <div class="${uiPrefix}-cond-grid"><select data-video-submitted><option value="No" ${(conditions.videoSubmitted || "No") === "No" ? "selected" : ""}>No</option><option value="Yes" ${conditions.videoSubmitted === "Yes" ? "selected" : ""}>Yes</option></select></div>
      </div>
      <div class="${uiPrefix}-cond-card"><strong>Platform override</strong>
        <div class="${uiPrefix}-cond-grid"><input data-platform-label value="${escapeAttr(conditions.platformLabel || "")}" placeholder="Uber Eats" /></div>
      </div>
      <div class="${uiPrefix}-cond-card"><strong>Reason map</strong><div style="display:flex;flex-direction:column;gap:6px;margin-top:6px">${reasonRows}</div></div>
      <div class="${uiPrefix}-cond-actions">
        <button type="button" class="${uiPrefix}-add" data-cond-save style="background:#06c167;color:#052e16">Save conditions</button>
        <button type="button" data-cond-clear>Clear my conditions</button>
      </div>`;
    panel.innerHTML = `
      <div class="${uiPrefix}-map-drag" title="Drag to move"><span style="letter-spacing:2px;color:#86efac">⋮⋮</span><h3>Uber Eats map &amp; conditions</h3><button type="button" class="${uiPrefix}-close" data-map-close>Close</button></div>
      <div class="${uiPrefix}-map-tabs">
        <button type="button" data-map-tab="fields" class="${mapPanelTab === "fields" ? "active" : ""}">Field maps</button>
        <button type="button" data-map-tab="conditions" class="${mapPanelTab === "conditions" ? "active" : ""}">Conditions</button>
      </div>
      ${mapPanelTab === "conditions" ? conditionsBody : fieldsBody}`;
    pinMapPanel(panel);
    panel.querySelectorAll("[data-map-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        mapPanelTab = btn.getAttribute("data-map-tab") || "fields";
        renderMapPanel();
      });
    });
    panel.querySelector("[data-map-close]")?.addEventListener("click", () => {
      stopMapPick();
      try { panel.hidePopover(); } catch { /* ignore */ }
      panel.remove();
    });
    panel.querySelectorAll("[data-map-key]").forEach((btn) => {
      btn.addEventListener("click", () => startMapPick(btn.getAttribute("data-map-key")));
    });
    panel.querySelectorAll("[data-map-clear]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const next = Object.assign({}, loadUserFieldMap());
        delete next[btn.getAttribute("data-map-clear")];
        saveUserFieldMap(next);
        renderMapPanel();
      });
    });
    panel.querySelector('[data-map-action="clear-all"]')?.addEventListener("click", () => {
      saveUserFieldMap({});
      toast("Cleared field maps.", "success", 3000);
      renderMapPanel();
    });
    panel.querySelectorAll("[data-cond-add]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const kind = btn.getAttribute("data-cond-add");
        const from = panel.querySelector(`[data-cond-from="${kind}"]`)?.value;
        const to = panel.querySelector(`[data-cond-to="${kind}"]`)?.value;
        if (!normalizeSpace(from) || !normalizeSpace(to)) {
          toast("Enter both Uber Eats and Workhorse values.", "error");
          return;
        }
        const next = loadUserConditions();
        next[kind] = [...(next[kind] || []), { match: normalizeSpace(from), value: normalizeSpace(to) }];
        saveUserConditions(next);
        renderMapPanel();
      });
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
    panel.querySelector("[data-cond-clear]")?.addEventListener("click", () => {
      saveUserConditions(defaultUserConditions());
      toast("Cleared your Uber Eats conditions.", "success", 3000);
      renderMapPanel();
    });
    panel.querySelector("[data-cond-save]")?.addEventListener("click", () => {
      const next = loadUserConditions();
      const thresholdRaw = panel.querySelector("[data-threshold-gbp]")?.value;
      const thresholdNum = thresholdRaw === "" || thresholdRaw == null ? null : Number(thresholdRaw);
      if (thresholdNum != null && (Number.isNaN(thresholdNum) || thresholdNum < 0)) {
        toast("Enter a valid £ threshold.", "error");
        return;
      }
      const tweaks = Object.assign({}, next.conditionTweaks || {});
      panel.querySelectorAll("[data-tweak-outcome]").forEach((el) => {
        const key = el.getAttribute("data-tweak-outcome");
        tweaks[key] = Object.assign({}, tweaks[key] || {}, { outcome: el.value });
      });
      panel.querySelectorAll("[data-tweak-footage]").forEach((el) => {
        const key = el.getAttribute("data-tweak-footage");
        tweaks[key] = Object.assign({}, tweaks[key] || {}, { footage: el.value });
      });
      const groups = new Set([...panel.querySelectorAll("[data-tweak-dispute-reason]")].map((el) => el.getAttribute("data-tweak-dispute-reason")));
      groups.forEach((key) => {
        if (!key) return;
        const checked = [...panel.querySelectorAll(`[data-tweak-dispute-reason="${key}"]`)].filter((el) => el.checked).map((el) => normalizeSpace(el.value)).filter(Boolean);
        tweaks[key] = Object.assign({}, tweaks[key] || {}, { reasonForDispute: checked });
      });
      const reasonMap = Object.assign({}, next.reasonMap || {});
      panel.querySelectorAll("[data-reason-edit]").forEach((el) => {
        const from = el.getAttribute("data-reason-edit");
        const to = normalizeSpace(el.value);
        const presetTo = (platform.reasonMap || {})[from] || "";
        if (!from) return;
        if (!to || (presetTo && normalizeKey(presetTo) === normalizeKey(to))) delete reasonMap[from];
        else reasonMap[from] = to;
      });
      next.disputeThresholdGbp = thresholdNum;
      next.conditionTweaks = tweaks;
      next.reasonMap = reasonMap;
      next.videoSubmitted = panel.querySelector("[data-video-submitted]")?.value || "No";
      next.platformLabel = normalizeSpace(panel.querySelector("[data-platform-label]")?.value) || null;
      saveUserConditions(next);
      toast("Saved Uber Eats conditions. Extract the order again.", "success", 5000);
      renderMapPanel();
    });
  }

  function toggleMapPanel() {
    try {
      ensureMapStyles();
      const existing = document.getElementById(mapPanelId);
      if (existing && existing.isConnected) {
        stopMapPick();
        try { existing.hidePopover(); } catch { /* ignore */ }
        existing.remove();
        return;
      }
      renderMapPanel();
    } catch (err) {
      console.error("[Uber Claims] map panel failed", err);
      toast(`Could not open map panel: ${err.message || err}`, "error", 8000);
    }
  }

  function extractRefundPayload() {
    clearHits();
    invalidatePageLines();
    const errors = [];

    const orderNumber = extractOrderNumber();
    if (!orderNumber) errors.push("Order Number");

    const { customer: rawCustomer, location: storeLocationRaw } = extractBrandAndLocation();
    const customer = isMoneyLabel(rawCustomer) ? "" : normalizeCustomerName(rawCustomer);
    const storeLocation = isMoneyLabel(storeLocationRaw) ? "" : normalizeLocationName(storeLocationRaw);
    if (!customer) errors.push("Customer");
    if (!storeLocation) errors.push("Location");

    const dateRaw = extractClaimDateRaw();
    const claimDate = parseClaimDate(dateRaw);
    if (!claimDate.iso) errors.push("Order date");

    let orderTime = extractOrderPlacedTime();
    if (!orderTime) errors.push("Order placed time");

    const orderValue =
      readLabeledMoney([
        "Sales (incl. VAT)",
        "Sales (incl VAT)",
        "Sales (incl. GST)",
        "Sales (incl GST)",
        "Subtotal",
        "Order total",
      ]);
    if (orderValue == null) errors.push("Sales total");

    const disputeAmount = extractDisputeAmount();

    const items = extractOrderItems();
    const subtitledItems = items.filter((item) => item && item.issue);
    let reasonRaw = extractRefundReasonRaw();
    if (subtitledItems.some((item) => /reported wrong/i.test(item.issue))) reasonRaw = "Item reported wrong";
    else if (subtitledItems.some((item) => /item reported missing/i.test(item.issue))) reasonRaw = "Item reported missing";
    else if (subtitledItems[0]) reasonRaw = subtitledItems[0].issue;
    const itemReason = (items.find((item) => item && item.reason) || {}).reason || "";
    const refundReason = canonicalizeReason(reasonRaw) || itemReason || "";

    const alreadyDisputed = detectAlreadyDisputed();
    highlightHits();

    const matchedItems = subtitledItems.length
      ? subtitledItems
      : itemsMatchingReason(items, refundReason);
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
      refundReasonRaw: reasonRaw,
      alreadyDisputed,
      videoSubmitted: workhorse.videoSubmitted || "No",
      wrongFoodItem: disputeFields.wrongFoodItem,
      preparedIncorrectlyWhy: disputeFields.preparedIncorrectlyWhy,
      reason: disputeFields.reason || "",
      otherReason: disputeFields.otherReason,
      items,
      errors,
    });

    return applyUserOverlay(payload);
  }

  function ensureUberUiStyles() {
    const id = `${uiPrefix}-bar-fix`;
    if (document.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = `
      #${uiPrefix}-btn-bar {
        border: 0 !important;
        background: transparent !important;
        padding: 0 !important;
        box-shadow: none !important;
        overflow: visible !important;
        color: inherit !important;
        width: max-content !important;
        height: auto !important;
        inset: auto !important;
        top: auto !important;
        right: auto !important;
        bottom: 18px !important;
        left: 50% !important;
        transform: translateX(-50%) !important;
        margin: 0 !important;
      }
      #${uiPrefix}-btn-bar::backdrop { background: transparent !important; }
      #${btnId}, #${mapBtnId}, #${sheetBtnId} {
        appearance: none !important;
        border: 0 !important;
        border-radius: 999px !important;
        padding: 10px 16px !important;
        margin: 0 !important;
        font: 700 14px/1.2 Segoe UI, system-ui, sans-serif !important;
        box-shadow: 0 8px 20px rgba(0,0,0,.28) !important;
        cursor: pointer !important;
      }
      #${btnId} { background: #06c167 !important; color: #052e16 !important; }
      #${mapBtnId} { background: #065f46 !important; color: #ecfdf5 !important; }
      #${sheetBtnId} { background: #0f766e !important; color: #ecfdf5 !important; }
      #${btnId}:hover, #${mapBtnId}:hover, #${sheetBtnId}:hover { background: #111827 !important; color: #fff !important; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function liftButtonBar() {
    ensureUberUiStyles();
    const bar = ensureButtonBar();
    if (!bar) return;
    if (!bar.isConnected) (document.documentElement || document.body).appendChild(bar);
    bar.setAttribute("popover", "manual");
    bar.style.setProperty("position", "fixed", "important");
    bar.style.setProperty("inset", "auto", "important");
    bar.style.setProperty("top", "auto", "important");
    bar.style.setProperty("right", "auto", "important");
    bar.style.setProperty("bottom", "18px", "important");
    bar.style.setProperty("left", "50%", "important");
    bar.style.setProperty("transform", "translateX(-50%)", "important");
    bar.style.setProperty("margin", "0", "important");
    bar.style.setProperty("border", "0", "important");
    bar.style.setProperty("background", "transparent", "important");
    bar.style.setProperty("padding", "0", "important");
    bar.style.setProperty("box-shadow", "none", "important");
    bar.style.setProperty("width", "max-content", "important");
    bar.style.setProperty("height", "auto", "important");
    bar.style.setProperty("overflow", "visible", "important");
    bar.style.setProperty("z-index", "2147483647", "important");
    bar.style.setProperty("display", "flex", "important");
    bar.style.setProperty("gap", "8px", "important");
    const modalOpen = !!document.querySelector("dialog[open], [role='dialog'], [aria-modal='true']");
    try {
      if (typeof bar.showPopover === "function") {
        const needsLift = modalOpen && bar.dataset.aboveModal !== "1";
        if (needsLift && bar.matches(":popover-open")) bar.hidePopover();
        if (!bar.matches(":popover-open")) bar.showPopover();
        if (modalOpen) bar.dataset.aboveModal = "1";
      }
    } catch (err) {
      console.warn("[Uber Claims] could not lift button bar", err);
    }
    if (!modalOpen) bar.dataset.aboveModal = "";
    bar.hidden = false;
  }

  function sheetRestaurant(customer) {
    const text = normalizeSpace(customer);
    const brand = text.split(/\s+[–—−-]\s+/)[0] || text;
    return brand.replace(/\s+adil\s+group$/i, "").trim() || brand;
  }

  function sheetFootage(status) {
    const key = normalizeKey(status);
    if (!key) return "";
    if (/irrelevant/.test(key)) return "Footage Irrelevant to this claim";
    if (/third party|3rd party/.test(key)) return "Disputed by 3rd Party";
    if (/no camera|camera offline/.test(key)) return "Camera Offline";
    if (/not at fault/.test(key)) return "Restau NOT AT FAULT";
    if (/at fault/.test(key)) return "Restau AT FAULT";
    if (/outside camera|packed outside/.test(key)) return "Food Packed Outside Camera Visibility";
    if (/won without/.test(key)) return "Won Without Footage";
    return normalizeSpace(status);
  }

  function sheetLogDate() {
    const now = new Date();
    return `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`;
  }

  function buildEisSheetRow(payload) {
    const video = /^yes$/i.test(normalizeSpace(payload.videoSubmitted)) ? "Yes" : "No";
    const disputed = payload.alreadyDisputed ? "TRUE" : "FALSE";
    const cells = [
      sheetLogDate(),
      "Own",
      sheetRestaurant(payload.customer),
      normalizeSpace(payload.location),
      normalizeSpace(payload.orderNumber),
      sheetFootage(payload.footageStatus),
      video,
      disputed,
      "",
    ];
    return cells.map((cell) => String(cell).replace(/[\t\r\n]+/g, " ").trim()).join("\t");
  }

  async function onCopySheetClick() {
    const payload = await loadPayload();
    if (!payload || !payload.orderNumber) {
      toast("Extract the order first, then copy the sheet row.", "error", 6000);
      return;
    }
    const row = buildEisSheetRow(payload);
    const copied = copyTextToClipboard(row);
    if (!copied) {
      toast("Could not copy. Select the row from the preview and copy it manually.", "error", 6000);
      return;
    }
    const parts = row.split("\t");
    toast(`Copied ${parts[4]} for the sheet. Click the next empty row and paste.`, "success", 7000);
  }

  function mount() {
    const body = document.body;
    if (!body) {
      document.addEventListener("DOMContentLoaded", mount, { once: true });
      return;
    }

    liftButtonBar();

    const existing = document.getElementById(btnId);
    const mapExisting = document.getElementById(mapBtnId);
    const sheetExisting = document.getElementById(sheetBtnId);

    if (isOpSpotPage()) {
      if (existing && existing.onclick && mapExisting && mapExisting.onclick) return;
      injectButton(btnId, platform.buttonFill || "Fill from Uber Eats", async () => {
        resetFillGuards();
        let payload = await loadPayload();
        if (!payload) {
          toast(`No stored order. Click ${platform.buttonExtract || "Extract Order → OpSpot"} on the Uber Eats tab first, then click here.`, "error", 7000);
          return;
        }
        payload = applyConditions(payload);
        savePayload(payload);
        await applyPayloadToClaims(payload, { force: true });
      });
      injectButton(mapBtnId, "Map & conditions", toggleMapPanel);
      return;
    }

    if (isUberEatsPage()) {
      if (existing && existing.onclick && mapExisting && mapExisting.onclick && sheetExisting && sheetExisting.onclick) return;
      injectButton(btnId, platform.buttonExtract || "Extract Order → OpSpot", onExtractClick);
      injectButton(mapBtnId, "Map & conditions", toggleMapPanel);
      injectButton(sheetBtnId, "Copy sheet row", onCopySheetClick);
    }
  }

  function boot() {
    ensureStyles();
    if (typeof GM_registerMenuCommand === "function") {
      if (typeof location !== "undefined" && /opspot/i.test(location.host)) {
        GM_registerMenuCommand(platform.buttonFill || "Fill from Uber Eats", async () => {
          resetFillGuards();
          let payload = await loadPayload();
          if (!payload) {
            toast("No stored order. Run Extract Order on the Uber Eats tab first.", "error", 7000);
            return;
          }
          payload = applyConditions(payload);
          savePayload(payload);
          await applyPayloadToClaims(payload, { force: true });
        });
        GM_registerMenuCommand("Map & conditions", toggleMapPanel);
      } else {
        GM_registerMenuCommand(platform.buttonExtract || "Extract Order → OpSpot", onExtractClick);
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
        const needSheet = isUberEatsPage() && !document.getElementById(sheetBtnId);
        if (!document.getElementById(btnId) || !document.getElementById(mapBtnId) || needSheet) remount();
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
    setInterval(() => {
      try {
        if (!document.body) return;
        if (!isUberEatsPage() && !isOpSpotPage()) return;
        mount();
      } catch (err) {
        console.warn("[Uber Claims] remount failed", err);
      }
    }, 1500);
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
