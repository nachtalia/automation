// ==UserScript==
// @name         Grubhub Sheet → OpSpot Claims Auto-Fill
// @namespace    https://local.claims-ops
// @version      1.0.9
// @description  Read a selected Google Sheet row (Grubhub adjustments) and fill OpSpot Claims.
// @author       Claims Ops
// @match        https://docs.google.com/spreadsheets/*
// @match        *://docs.google.com/spreadsheets/*
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
// @inject-into  content
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
 *   Sheet:  https://docs.google.com/spreadsheets/d/1fLAWWmj_ZBIUQ-AJirNrY_yw6r03JwnsPvPb1Qcae1o/...
 *   OpSpot: https://opspot.workhorselive.com/sysTable.php?sys_module_id=10000&sys_data_entity_id=10000#
 *
 * Workflow
 *   1. Click a cell in the data row (or select the whole row) → Ctrl+C
 *   2. Click "Extract sheet row → OpSpot"
 *   3. OpSpot → Add New → "Fill from Grubhub"
 *
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
    console.error("[Grubhub Claims] Shared claims-presets/core failed to load (re-run node build-static.js and re-paste this userscript).");
    return;
  }
  const core = root.ClaimsCore.create("grubhub");
  const {
    normalizeSpace, normalizeKey, parseMoney, extractTime, parseClaimDate,
    isOpSpotPage, isGoogleSheetsPage,
    canonicalizeReason, normalizeCustomerName,
    buildDisputeFieldValues, enrichPayload, mapReasonForDispute,
    resolveOutcomeMatch, computeFootageStatus,
    savePayload, loadPayload, toast, showPreview, ensureStyles, injectButton, ensureButtonBar,
    applyPayloadToClaims, setupOpSpotSaveHooks, resetFillGuards,
    clearHits, hits, platform, version,
  } = core;

  const normalizeLocationName =
    typeof core.normalizeLocationName === "function"
      ? core.normalizeLocationName
      : (name) => normalizeSpace(name);

  const uiPrefix = platform.uiPrefix || "gcf";
  const btnId = `${uiPrefix}-btn`;
  const workhorse = core.workhorse;

  const KNOWN_BRANDS = [
    /^joe\s*&\s*the\s*juice\b/i,
    /^joe\s*and\s*the\s*juice\b/i,
    /^shake\s*shack\b/i,
    /^jollibee\b/i,
    /^popeyes\b/i,
    /^five\s*guys\b/i,
  ];

  /** Default column order (Joe & the Juice Refund Errors sheet) */
  const DEFAULT_HEADERS = [
    "Date",
    "Time",
    "Restaurant",
    "Fulfillment Type",
    "ID",
    "Type",
    "Description",
    "Restaurant Total",
    "Subtotal",
    "Restaurant Total",
    "Subtotal",
  ];

  const ALT_HEADERS_NO_TIME = [
    "Date",
    "Restaurant",
    "Fulfillment Type",
    "ID",
    "Type",
    "Description",
    "Subtotal",
    "Tax",
    "Restaurant Total",
  ];

  function splitRestaurant(line) {
    const text = normalizeSpace(line);
    if (!text) return { customer: "", location: "" };
    const dashed = text.split(/\s*[–—−-]\s*/).map(normalizeSpace).filter(Boolean);
    if (dashed.length >= 2) {
      return { customer: dashed[0], location: dashed.slice(1).join(" - ") };
    }
    for (const re of KNOWN_BRANDS) {
      const m = text.match(re);
      if (!m) continue;
      const customer = normalizeSpace(m[0]);
      const location = normalizeSpace(text.slice(m[0].length));
      if (customer && location) return { customer, location };
    }
    return { customer: text, location: "" };
  }

  function headerKey(h) {
    return normalizeKey(h).replace(/[^a-z0-9]+/g, " ").trim();
  }

  function findCol(headers, aliases) {
    const wanted = (aliases || []).map(headerKey);
    for (let i = 0; i < headers.length; i++) {
      const hk = headerKey(headers[i]);
      if (wanted.some((w) => hk === w || hk.includes(w) || w.includes(hk))) return i;
    }
    return -1;
  }

  function parseSheetTime(raw) {
    const text = normalizeSpace(raw);
    if (!text) return "";
    const fromCore = extractTime(text);
    if (fromCore) return fromCore;
    const m = text.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (!m) return "";
    let h = Number(m[1]);
    const min = m[2];
    const ap = (m[3] || "").toUpperCase();
    if (ap === "PM" && h < 12) h += 12;
    if (ap === "AM" && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:${min}`;
  }

  function parseSheetDate(raw) {
    const text = normalizeSpace(raw);
    if (!text) return parseClaimDate("");
    // M/D/YYYY or MM/DD/YYYY
    const us = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (us) {
      const mm = us[1].padStart(2, "0");
      const dd = us[2].padStart(2, "0");
      const yyyy = us[3];
      return parseClaimDate(`${dd}-${mm}-${yyyy}`) || parseClaimDate(`${yyyy}-${mm}-${dd}`);
    }
    return parseClaimDate(text);
  }

  function absMoney(raw) {
    const n = parseMoney(raw);
    if (n == null) return null;
    return Math.abs(n);
  }

  function mapDescriptionToReason(description) {
    const text = normalizeSpace(description);
    const canonical = canonicalizeReason(text) || "";
    if (canonical) return canonical;
    const key = normalizeKey(text);
    // Sheet codes like MISSING_ITEM / INCORRECT_ITEM
    if (/missing[_]?item|missing/.test(key)) return "missing items";
    if (/incorrect[_]?item|incorrect/.test(key)) return "incorrect item";
    if (/prepared/.test(key)) return "prepared incorrectly";
    if (/food\s*safety/.test(key)) return "food safety complaint";
    return key;
  }

  function parseTsvMatrix(text) {
    return String(text || "")
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .map((line) => line.split("\t").map((c) => normalizeSpace(c)))
      .filter((row) => row.some((c) => c));
  }

  function looksLikeHeaderRow(row) {
    const joined = row.map(headerKey).join(" ");
    return (
      (/date/.test(joined) || /restaurant/.test(joined)) &&
      (/restaurant/.test(joined) || /reason/.test(joined) || /description/.test(joined) || /\bid\b/.test(joined) || /order id/.test(joined))
    );
  }

  function rowToObject(headers, cells) {
    const out = {};
    const totals = [];
    const subtotals = [];
    for (let i = 0; i < Math.max(headers.length, cells.length); i++) {
      const h = headers[i] || DEFAULT_HEADERS[i] || `col${i}`;
      const v = cells[i] || "";
      const hk = headerKey(h);
      if (/restaurant\s*total/.test(hk)) totals.push(v);
      else if (/^subtotal$/.test(hk)) subtotals.push(v);
      else if (!(hk in out) || !out[hk]) out[hk] = v;
    }
    if (totals.length) out["restaurant total"] = totals[totals.length - 1] || totals[0];
    if (subtotals.length) out.subtotal = subtotals[subtotals.length - 1] || subtotals[0];
    out.__headers = headers.slice();
    out.__cells = cells.slice();
    out.__totals = totals;
    out.__subtotals = subtotals;
    return out;
  }

  function pickField(obj, aliases) {
    const entries = Object.entries(obj).filter(([k, v]) => v && !String(k).startsWith("__"));
    // Exact header match first
    for (const a of aliases || []) {
      const want = headerKey(a);
      for (const [k, v] of entries) {
        if (k === want) return v;
      }
    }
    // Avoid matching "Restaurant Total" when looking for "Restaurant"
    for (const a of aliases || []) {
      const want = headerKey(a);
      for (const [k, v] of entries) {
        if (/total|subtotal|tax/.test(k)) continue;
        if (k === want || (want.length >= 4 && k.startsWith(want))) return v;
      }
    }
    return "";
  }

  function mapFulfillmentToPlatform(raw) {
    const text = normalizeSpace(raw);
    const rules = platform.platformFromFulfillment || [{ test: "grubhub", value: "Grubhub" }];
    for (const rule of rules) {
      try {
        if (rule && rule.test && new RegExp(rule.test, "i").test(text)) return rule.value;
      } catch {
        /* ignore */
      }
    }
    if (/grubhub/i.test(text)) return "Grubhub";
    return platform.platform || "Grubhub";
  }

  function guessHeadersForDataRow(cells) {
    const n = cells.length;
    if (n >= 8 && n <= 11) {
      const maybeRestaurant = cells[2] || cells[1] || "";
      if (/joe|juice|shake|jollibee|popeyes/i.test(maybeRestaurant) || /\s-\s/.test(maybeRestaurant)) {
        if (/\d{1,2}:\d{2}/.test(cells[1] || "") || /AM|PM/i.test(cells[1] || "")) {
          return DEFAULT_HEADERS.slice(0, n);
        }
        return ALT_HEADERS_NO_TIME.slice(0, n);
      }
    }
    return DEFAULT_HEADERS.slice(0, Math.max(n, DEFAULT_HEADERS.length));
  }

  const CONDITIONS_KEY = "grubhub_user_conditions_v1";
  const FIELD_MAP_KEY = "grubhub_user_field_map_v1";
  const condBtnId = `${uiPrefix}-cond-btn`;
  const condPanelId = `${uiPrefix}-cond-panel`;
  let userConditionsCache = null;
  let userFieldMapCache = null;
  let mapPanelTab = "fields";
  let condPanelPos = { top: 72, left: 18 };

  const MAPPABLE_FIELDS = [
    { key: "claimDate", label: "Claim Date", defaults: ["Date"], kind: "date" },
    { key: "orderTime", label: "Order Time", defaults: ["Time"], kind: "time" },
    { key: "restaurant", label: "Restaurant → Customer + Location", defaults: ["Restaurant", "Full Restaurant Name", "Restaurant Name"], kind: "split" },
    { key: "customer", label: "Customer (column override)", defaults: [], kind: "text" },
    { key: "location", label: "Location (column override)", defaults: [], kind: "text" },
    { key: "orderNumber", label: "Order Number", defaults: ["ID", "Order ID", "Order Number"], kind: "text" },
    { key: "fulfillment", label: "Platform (Fulfillment Type)", defaults: ["Fulfillment Type", "Fulfillment"], kind: "platform" },
    { key: "description", label: "Reason / Description", defaults: ["Description", "Reason", "Adjustment Reason"], kind: "reason" },
    { key: "orderValue", label: "Order Value", defaults: ["Subtotal"], kind: "money" },
    { key: "disputeAmount", label: "Dispute Amount", defaults: ["Restaurant Total"], kind: "money" },
    { key: "otherReason", label: "Other reason", defaults: [], kind: "text" },
  ];

  function persistGm(key, value) {
    try {
      if (typeof GM_setValue === "function") GM_setValue(key, value);
    } catch (err) {
      console.warn("[Grubhub Claims] GM_setValue failed", err);
    }
    try {
      if (typeof GM !== "undefined" && GM.setValue) {
        Promise.resolve(GM.setValue(key, value)).catch((err) => console.warn("[Grubhub Claims] GM.setValue failed", err));
      }
    } catch (err) {
      console.warn("[Grubhub Claims] GM.setValue failed", err);
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

  function defaultUserFieldMap() {
    return { columns: {}, headers: [] };
  }

  function loadUserFieldMap() {
    if (userFieldMapCache) return userFieldMapCache;
    let data = readGm(FIELD_MAP_KEY);
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        data = null;
      }
    }
    userFieldMapCache = {
      columns: data && data.columns && typeof data.columns === "object" ? data.columns : {},
      headers: Array.isArray(data && data.headers) ? data.headers.map((h) => normalizeSpace(h)).filter(Boolean) : [],
    };
    return userFieldMapCache;
  }

  function saveUserFieldMap(data) {
    userFieldMapCache = {
      columns: data && data.columns && typeof data.columns === "object" ? { ...data.columns } : {},
      headers: Array.isArray(data && data.headers) ? data.headers.map((h) => normalizeSpace(h)).filter(Boolean) : [],
    };
    persistGm(FIELD_MAP_KEY, userFieldMapCache);
  }

  function rememberSheetHeaders(headers) {
    const list = (headers || []).map((h) => normalizeSpace(h)).filter(Boolean);
    if (list.length < 2) return;
    const current = loadUserFieldMap();
    current.headers = list;
    saveUserFieldMap(current);
  }

  function mappedColumn(fieldKey) {
    return normalizeSpace((loadUserFieldMap().columns || {})[fieldKey] || "");
  }

  function valueByHeaderName(obj, name) {
    const want = headerKey(name);
    if (!want || !obj) return "";
    const headers = obj.__headers || [];
    const cells = obj.__cells || [];
    let found = "";
    for (let i = 0; i < Math.max(headers.length, cells.length); i++) {
      if (headerKey(headers[i]) !== want) continue;
      if (normalizeSpace(cells[i])) found = cells[i];
    }
    if (found) return found;
    const keyed = obj[want];
    return keyed && typeof keyed !== "object" ? keyed : "";
  }

  function cellFor(obj, fieldKey, defaults) {
    const chosen = mappedColumn(fieldKey);
    // A saved map must win. Falling back to the default column is why a remap looked like it did nothing.
    if (chosen) return valueByHeaderName(obj, chosen);
    return pickField(obj, defaults || []);
  }

  function effectiveDisputeThreshold() {
    const user = loadUserConditions().disputeThresholdGbp;
    if (user != null && !Number.isNaN(Number(user))) return Number(user);
    return workhorse.disputeThresholdGbp || 2;
  }

  function effectiveVideoSubmitted() {
    return loadUserConditions().videoSubmitted || workhorse.videoSubmitted || "No";
  }

  function defaultTweakFor(key) {
    const o = workhorse.outcomeOptions || {};
    const f = workhorse.footageStatusOptions || {};
    const map = {
      underDisputeThreshold: { outcome: o.notDisputed, footage: f.irrelevant, reasonForDispute: [] },
      missingFoodSafety: { outcome: o.awaitingReview, footage: f.irrelevant, reasonForDispute: [] },
      preparedIncorrect: { outcome: o.pending, footage: f.irrelevant, reasonForDispute: [] },
    };
    return map[key] || { outcome: "", footage: "", reasonForDispute: [] };
  }

  function effectiveTweak(key) {
    const saved = (loadUserConditions().conditionTweaks || {})[key] || {};
    const defaults = defaultTweakFor(key);
    let reasons = saved.reasonForDispute;
    if (!Array.isArray(reasons)) reasons = reasons ? [normalizeSpace(reasons)] : defaults.reasonForDispute || [];
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
      "Prepared incorrectly",
      "Food safety complaint",
      workhorse.reasonForDisputeOtherOption || "Other",
    ];
    return [...new Set(fromMap.concat(extras).map((v) => normalizeSpace(v)).filter(Boolean))];
  }

  function reasonForDisputeCheckboxHtml(name, selected) {
    const selectedKeys = new Set(
      (Array.isArray(selected) ? selected : selected ? [selected] : [])
        .map((v) => normalizeKey(v))
        .filter(Boolean)
    );
    const boxes = workhorseDisputeReasonOptions().map(
      (v) => `<label class="${uiPrefix}-cond-check">
          <input type="checkbox" data-tweak-dispute-reason="${escapeAttr(name)}" value="${escapeAttr(v)}" ${selectedKeys.has(normalizeKey(v)) ? "checked" : ""} />
          <span>${escapeAttr(v)}</span>
        </label>`
    );
    return `<div class="${uiPrefix}-cond-check-group">${boxes.join("")}</div>`;
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
    const keys = [rawKey, normalizeKey(refundReason), canonical, normalizeKey(canonical)].filter(Boolean);
    const seen = new Set();
    for (const key of keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      if (userMap[key]) return userMap[key];
    }
    return mapReasonForDispute(canonical) || mapReasonForDispute(rawKey) || "";
  }

  function pickReasonForDisputeFromChecks(selected, mappedReason, refundReason, refundReasonRaw) {
    const list = (Array.isArray(selected) ? selected : selected ? [selected] : [])
      .map((r) => normalizeSpace(r))
      .filter(Boolean);
    if (!list.length) return "";
    if (mappedReason && list.some((r) => normalizeKey(r) === normalizeKey(mappedReason))) return mappedReason;
    const raw = normalizeKey(refundReasonRaw || refundReason);
    const canonical = canonicalizeReason(refundReasonRaw || refundReason) || "";
    const find = (re) => list.find((r) => re.test(normalizeKey(r)));
    if (/food\s*safety/.test(raw) || /food safety/.test(canonical)) {
      const hit = find(/food\s*safety/) || find(/^other$/);
      if (hit) return hit;
    }
    if (/missing/.test(raw) || /missing/.test(canonical)) {
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

  function applyUserConditions(payload) {
    const out = Object.assign({}, payload);
    out.customer = resolveCustomerName(out.customer);
    out.location = resolveLocationName(out.location);
    out.videoSubmitted = effectiveVideoSubmitted();
    const userPlatform = loadUserConditions().platformLabel;
    if (userPlatform) out.platform = userPlatform;
    out.reasonForDispute = resolveReasonForDispute(out.refundReason, out.refundReasonRaw) || out.reasonForDispute;
    const amount = parseMoney(out.disputeAmount);
    const ctx = withConditionContext({
      disputeAmount: amount,
      alreadyDisputed: !!out.alreadyDisputed,
      refundReason: out.refundReason,
      refundReasonRaw: out.refundReasonRaw,
      reasonForDispute: out.reasonForDispute,
      customer: out.customer,
      location: out.location,
    });
    const outcomeMatch =
      typeof resolveOutcomeMatch === "function"
        ? resolveOutcomeMatch(ctx)
        : { outcome: "", reasonForDispute: [] };
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

  function renderAliasList(kind, aliases) {
    if (!aliases.length) return `<div class="${uiPrefix}-cond-meta">None yet.</div>`;
    return aliases
      .map(
        (rule, index) => `<div class="${uiPrefix}-cond-item">
        <span style="flex:1"><code>${escapeAttr(rule.match)}</code> → <strong>${escapeAttr(rule.value)}</strong></span>
        <button type="button" data-cond-del="${kind}" data-cond-index="${index}">Remove</button>
      </div>`
      )
      .join("");
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
    const under = effectiveTweak("underDisputeThreshold");
    const missing = effectiveTweak("missingFoodSafety");
    const prepared = effectiveTweak("preparedIncorrect");
    const reasons = mergedReasonMapForEditor();
    const customerPresets = platform.customerAliases || [];
    const reasonRows = reasons
      .map(
        (r) => `<div class="${uiPrefix}-cond-tweak-row">
        <code style="flex:0 0 38%">${escapeAttr(r.from)}</code>
        <span>→</span>
        <input data-reason-edit="${escapeAttr(r.from)}" value="${escapeAttr(r.to)}" style="flex:1" />
      </div>`
      )
      .join("");
    const customerRows = customerPresets
      .map(
        (a, i) => `<div class="${uiPrefix}-cond-tweak-row">
        <input data-preset-customer-match="${i}" value="${escapeAttr(a.match || "")}" style="flex:1" />
        <span>→</span>
        <input data-preset-customer-value="${i}" value="${escapeAttr(a.value || "")}" style="flex:1" />
      </div>`
      )
      .join("");
    return `
      <li class="${uiPrefix}-cond-card">
        <div><strong>Restaurant Total ≤ £…</strong> → Outcome / Footage</div>
        <div class="${uiPrefix}-cond-grid">
          <label>£</label>
          <input data-threshold-gbp type="number" min="0" step="0.01" value="${escapeAttr(String(threshold))}" />
          ${outcomeSelectHtml("underDisputeThreshold", under.outcome)}
          ${footageSelectHtml("underDisputeThreshold", under.footage)}
        </div>
      </li>
      <li class="${uiPrefix}-cond-card">
        <div><strong>Missing item / food safety</strong> → Outcome / Footage / Reason</div>
        <div class="${uiPrefix}-cond-grid">
          ${outcomeSelectHtml("missingFoodSafety", missing.outcome)}
          ${footageSelectHtml("missingFoodSafety", missing.footage)}
        </div>
        <div class="${uiPrefix}-cond-meta">None checked = use the reason map.</div>
        ${reasonForDisputeCheckboxHtml("missingFoodSafety", missing.reasonForDispute)}
      </li>
      <li class="${uiPrefix}-cond-card">
        <div><strong>Prepared incorrectly / Incorrect item</strong> → Outcome / Footage / Reason</div>
        <div class="${uiPrefix}-cond-grid">
          ${outcomeSelectHtml("preparedIncorrect", prepared.outcome)}
          ${footageSelectHtml("preparedIncorrect", prepared.footage)}
        </div>
        <div class="${uiPrefix}-cond-meta">None checked = use the reason map.</div>
        ${reasonForDisputeCheckboxHtml("preparedIncorrect", prepared.reasonForDispute)}
      </li>
      <li class="${uiPrefix}-cond-card">
        <div><strong>Video Submitted</strong> always</div>
        <div class="${uiPrefix}-cond-grid">
          <select data-video-submitted>
            <option value="No" ${effectiveVideoSubmitted() === "No" ? "selected" : ""}>No</option>
            <option value="Yes" ${effectiveVideoSubmitted() === "Yes" ? "selected" : ""}>Yes</option>
          </select>
        </div>
      </li>
      <li class="${uiPrefix}-cond-card">
        <div><strong>Platform override</strong> (blank = use Fulfillment Type)</div>
        <div class="${uiPrefix}-cond-grid">
          <input data-platform-label value="${escapeAttr(loadUserConditions().platformLabel || "")}" placeholder="${escapeAttr(platform.platform || "Grubhub")}" />
        </div>
      </li>
      <li class="${uiPrefix}-cond-card">
        <div><strong>Reason map</strong> (sheet description → Reason for Dispute)</div>
        <div class="${uiPrefix}-cond-list">${reasonRows || `<div class="${uiPrefix}-cond-meta">No reason rows</div>`}</div>
      </li>
      <li class="${uiPrefix}-cond-card">
        <div><strong>Customer presets</strong> (saved into your aliases on Save)</div>
        <div class="${uiPrefix}-cond-list">${customerRows || `<div class="${uiPrefix}-cond-meta">No customer presets</div>`}</div>
      </li>
      <li class="${uiPrefix}-cond-card" style="border-style:dashed">
        <button type="button" class="${uiPrefix}-cond-add" data-cond-save-builtins style="width:100%">Save condition tweaks</button>
      </li>
    `;
  }

  function ensureCondStyles() {
    const styleId = `${uiPrefix}-cond-style-v2`;
    if (document.getElementById(styleId)) return;
    document.getElementById(`${uiPrefix}-cond-style`)?.remove();
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      #${condBtnId} {
        background: #9a3412 !important; color: #ffedd5 !important; border: 0 !important;
        cursor: pointer !important; border-radius: 999px !important; padding: 12px 22px !important;
        box-shadow: 0 10px 30px rgba(0,0,0,.35) !important;
        font: 700 15px/1.2 Segoe UI, system-ui, sans-serif !important;
      }
      #${condPanelId} {
        position: fixed !important; inset: auto !important; margin: 0 !important;
        z-index: 2147483647 !important; display: block !important; visibility: visible !important;
        width: min(500px, 94vw) !important; max-height: 78vh !important; overflow: auto !important;
        background: #1c1917 !important; color: #ffedd5 !important; border-radius: 12px !important;
        padding: 0 14px 14px !important; box-shadow: 0 16px 48px rgba(0,0,0,.55) !important;
        font: 13px/1.4 Segoe UI, system-ui, sans-serif !important;
      }
      #${condPanelId} * { box-sizing: border-box; }
      #${condPanelId} .${uiPrefix}-cond-drag {
        display: flex; align-items: center; gap: 8px; margin: 0 -14px 10px; padding: 12px 14px 8px;
        cursor: grab; user-select: none; border-bottom: 1px solid #44403c; position: sticky; top: 0;
        background: #1c1917; z-index: 2;
      }
      #${condPanelId} .${uiPrefix}-cond-drag:active { cursor: grabbing; }
      #${condPanelId} .${uiPrefix}-cond-drag h3 { margin: 0; font-size: 15px; color: #fff; flex: 1; }
      #${condPanelId} .${uiPrefix}-cond-tabs { display: flex; gap: 6px; margin-bottom: 10px; }
      #${condPanelId} .${uiPrefix}-cond-tabs button {
        flex: 1; border: 0; border-radius: 8px; padding: 8px; cursor: pointer;
        background: #292524; color: #fdba74; font-weight: 700;
      }
      #${condPanelId} .${uiPrefix}-cond-tabs button.active { background: #ff8000; color: #1c1917; }
      #${condPanelId} p { margin: 0 0 10px; color: #fdba74; font-size: 12px; }
      #${condPanelId} code { color: #fed7aa; }
      #${condPanelId} .${uiPrefix}-cond-section { margin-top: 12px; padding-top: 8px; border-top: 1px solid #44403c; }
      #${condPanelId} h4 { margin: 0 0 8px; font-size: 13px; color: #fff; }
      #${condPanelId} .${uiPrefix}-cond-form { display: grid; grid-template-columns: 1fr 1fr auto; gap: 6px; margin-bottom: 8px; }
      #${condPanelId} input, #${condPanelId} select {
        border: 1px solid #78716c; border-radius: 6px; padding: 6px 8px;
        background: #0c0a09; color: #fff; font-size: 12px; width: 100%;
      }
      #${condPanelId} .${uiPrefix}-cond-add, #${condPanelId} .${uiPrefix}-cond-actions button {
        border: 0; border-radius: 8px; padding: 8px 10px; cursor: pointer; font-weight: 700;
      }
      #${condPanelId} .${uiPrefix}-cond-add { background: #ff8000; color: #1c1917; }
      #${condPanelId} .${uiPrefix}-cond-actions { display: flex; gap: 8px; margin-top: 12px; }
      #${condPanelId} .${uiPrefix}-cond-actions button { flex: 1; background: #44403c; color: #fff; }
      #${condPanelId} .${uiPrefix}-cond-item {
        display: flex; gap: 8px; align-items: center; padding: 4px 0; font-size: 12px;
      }
      #${condPanelId} .${uiPrefix}-cond-item button,
      #${condPanelId} .${uiPrefix}-map-clear {
        border: 0; border-radius: 6px; padding: 4px 8px; cursor: pointer; background: #7f1d1d; color: #fff; font-size: 11px;
      }
      #${condPanelId} .${uiPrefix}-cond-meta { color: #fdba74; font-size: 11px; margin-top: 4px; }
      #${condPanelId} .${uiPrefix}-cond-builtin { margin: 0; padding: 0; list-style: none; }
      #${condPanelId} .${uiPrefix}-cond-card {
        margin: 8px 0; padding: 8px; border-radius: 8px; background: #292524; border: 1px solid #44403c;
      }
      #${condPanelId} .${uiPrefix}-cond-grid {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 6px; margin-top: 6px;
      }
      #${condPanelId} .${uiPrefix}-cond-list { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
      #${condPanelId} .${uiPrefix}-cond-tweak-row { display: flex; gap: 6px; align-items: center; }
      #${condPanelId} .${uiPrefix}-cond-tweak-row input { flex: 1; }
      #${condPanelId} .${uiPrefix}-cond-check { display: flex; align-items: center; gap: 8px; margin-top: 4px; cursor: pointer; }
      #${condPanelId} .${uiPrefix}-cond-check input { width: 14px; height: 14px; accent-color: #ff8000; }
      #${condPanelId} .${uiPrefix}-map-row {
        display: grid; grid-template-columns: 1fr; gap: 4px;
        padding: 8px 0; border-top: 1px solid #44403c;
      }
      #${condPanelId} .${uiPrefix}-map-row-top { display: flex; gap: 8px; align-items: center; }
      #${condPanelId} .${uiPrefix}-map-controls { display: grid; grid-template-columns: 1fr auto; gap: 6px; }
    `;
    (document.documentElement || document.head).appendChild(style);
  }

  function pinPanel(panel) {
    if (!panel) return;
    panel.style.setProperty("position", "fixed", "important");
    panel.style.setProperty("inset", "auto", "important");
    panel.style.setProperty("margin", "0", "important");
    panel.style.setProperty("left", `${condPanelPos.left}px`, "important");
    panel.style.setProperty("top", `${condPanelPos.top}px`, "important");
    panel.style.setProperty("right", "auto", "important");
    panel.style.setProperty("bottom", "auto", "important");
    panel.style.setProperty("transform", "none", "important");
    panel.style.setProperty("z-index", "2147483647", "important");
    panel.style.setProperty("display", "block", "important");
    panel.style.setProperty("visibility", "visible", "important");
    panel.style.setProperty("opacity", "1", "important");
  }

  function clampCondPanel(left, top, panel) {
    const width = panel.offsetWidth || 500;
    const maxLeft = Math.max(8, window.innerWidth - width - 8);
    const maxTop = Math.max(8, window.innerHeight - 72);
    return {
      left: Math.min(maxLeft, Math.max(8, left)),
      top: Math.min(maxTop, Math.max(8, top)),
    };
  }

  function applyCondPanelPos(panel) {
    const pos = clampCondPanel(condPanelPos.left, condPanelPos.top, panel);
    condPanelPos = pos;
    pinPanel(panel);
  }

  function enableCondDrag(panel) {
    if (!panel || panel.dataset.dragBound === "1") return;
    panel.dataset.dragBound = "1";
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;
    const onMove = (event) => {
      if (!dragging) return;
      condPanelPos = clampCondPanel(
        originLeft + (event.clientX - startX),
        originTop + (event.clientY - startY),
        panel
      );
      pinPanel(panel);
      event.preventDefault();
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
    };
    const onDown = (event) => {
      const handle = event.target.closest(`.${uiPrefix}-cond-drag`);
      if (!handle || event.target.closest("button")) return;
      if (event.button != null && event.button !== 0) return;
      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      originLeft = panel.offsetLeft || condPanelPos.left;
      originTop = panel.offsetTop || condPanelPos.top;
      event.preventDefault();
      document.addEventListener("pointermove", onMove, true);
      document.addEventListener("pointerup", onUp, true);
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("mouseup", onUp, true);
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
    };
    panel.addEventListener("pointerdown", onDown, true);
    panel.addEventListener("mousedown", onDown, true);
  }

  const KNOWN_SHEET_COLUMNS = [
    "Date",
    "Time",
    "Restaurant",
    "Fulfillment Type",
    "ID",
    "Type",
    "Description",
    "Restaurant Total",
    "Subtotal",
    "Tax",
  ];

  function columnChoices(current) {
    const saved = loadUserFieldMap().headers || [];
    const values = [];
    const seen = new Set();
    for (const h of [...saved, ...KNOWN_SHEET_COLUMNS]) {
      const key = headerKey(h);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      values.push(normalizeSpace(h));
    }
    if (current && !seen.has(headerKey(current))) values.unshift(current);
    return values;
  }

  function renderFieldMapBody() {
    const map = loadUserFieldMap();
    const rows = MAPPABLE_FIELDS.map((field) => {
      const current = normalizeSpace((map.columns || {})[field.key] || "");
      const options = columnChoices(current)
        .map((h) => `<option value="${escapeAttr(h)}" ${headerKey(h) === headerKey(current) ? "selected" : ""}>${escapeAttr(h)}</option>`)
        .join("");
      const fallback = field.defaults.length ? `Default: ${field.defaults[0]}` : "Blank = leave automatic";
      return `<div class="${uiPrefix}-map-row">
        <div class="${uiPrefix}-map-row-top">
          <strong style="flex:1">${escapeAttr(field.label)}</strong>
          ${current ? `<button type="button" class="${uiPrefix}-map-clear" data-map-clear="${escapeAttr(field.key)}">Clear</button>` : ""}
        </div>
        <div class="${uiPrefix}-map-controls">
          <input data-map-column="${escapeAttr(field.key)}" list="${uiPrefix}-col-list" value="${escapeAttr(current)}" placeholder="${escapeAttr(field.defaults[0] || "Column header")}" />
          <select data-map-select="${escapeAttr(field.key)}">
            <option value="">${options ? "Pick column" : "Load columns"}</option>
            ${options}
          </select>
        </div>
        <div class="${uiPrefix}-cond-meta">${escapeAttr(current ? `Mapped to “${current}”` : fallback)}</div>
      </div>`;
    }).join("");
    const datalist = `<datalist id="${uiPrefix}-col-list">${(map.headers || [])
      .map((h) => `<option value="${escapeAttr(h)}"></option>`)
      .join("")}</datalist>`;
    return `
      <p>Pick a sheet column for each field. Changing a dropdown applies it to the stored row immediately. Drag the title bar to move this panel.</p>
      ${datalist}
      <div class="${uiPrefix}-cond-actions" style="margin-top:0">
        <button type="button" class="${uiPrefix}-cond-add" data-map-action="load-columns">Load columns from clipboard</button>
      </div>
      ${rows}
      <div class="${uiPrefix}-cond-actions">
        <button type="button" class="${uiPrefix}-cond-add" data-map-action="save">Apply column maps</button>
        <button type="button" data-map-action="clear">Clear maps</button>
      </div>
    `;
  }

  function renderConditionsPanel() {
    ensureCondStyles();
    let panel = document.getElementById(condPanelId);
    if (!panel || !panel.isConnected) {
      panel = document.createElement("div");
      panel.id = condPanelId;
      panel.setAttribute("popover", "manual");
      (document.documentElement || document.body).appendChild(panel);
      enableCondDrag(panel);
    }
    pinPanel(panel);
    const conditions = loadUserConditions();
    const fieldsBody = renderFieldMapBody();
    const conditionsBody = `
      <p>Sheet text → Workhorse. Regex is allowed in the “from” box. Re-extract a row after saving. Drag the title bar to move.</p>
      <div class="${uiPrefix}-cond-section">
        <h4>Customer aliases</h4>
        ${renderAliasList("customerAliases", conditions.customerAliases)}
        <div class="${uiPrefix}-cond-form">
          <input data-cond-from="customerAliases" placeholder="Sheet customer" />
          <input data-cond-to="customerAliases" placeholder="Workhorse customer" />
          <button type="button" class="${uiPrefix}-cond-add" data-cond-add="customerAliases">Add</button>
        </div>
      </div>
      <div class="${uiPrefix}-cond-section">
        <h4>Location aliases</h4>
        ${renderAliasList("locationAliases", conditions.locationAliases)}
        <div class="${uiPrefix}-cond-form">
          <input data-cond-from="locationAliases" placeholder="Sheet location" />
          <input data-cond-to="locationAliases" placeholder="Workhorse location" />
          <button type="button" class="${uiPrefix}-cond-add" data-cond-add="locationAliases">Add</button>
        </div>
      </div>
      <div class="${uiPrefix}-cond-section">
        <h4>Extra reason overrides</h4>
        ${Object.keys(conditions.reasonMap || {}).length
          ? Object.entries(conditions.reasonMap).map(([from, to]) => `<div class="${uiPrefix}-cond-item">
              <span style="flex:1"><code>${escapeAttr(from)}</code> → <strong>${escapeAttr(to)}</strong></span>
              <button type="button" data-cond-del-reason="${escapeAttr(from)}">Remove</button>
            </div>`).join("")
          : `<div class="${uiPrefix}-cond-meta">Use the reason map below, or add a one-off override.</div>`}
        <div class="${uiPrefix}-cond-form">
          <input data-reason-from placeholder="Sheet reason" />
          <input data-reason-to placeholder="Workhorse reason" />
          <button type="button" class="${uiPrefix}-cond-add" data-cond-add-reason>Add</button>
        </div>
      </div>
      <div class="${uiPrefix}-cond-section">
        <h4>Built-in conditions</h4>
        <ul class="${uiPrefix}-cond-builtin">${renderBuiltInConditions()}</ul>
      </div>
      <div class="${uiPrefix}-cond-actions">
        <button type="button" data-cond-action="clear">Clear my conditions</button>
        <button type="button" data-cond-action="close">Close</button>
      </div>
    `;
    panel.innerHTML = `
      <div class="${uiPrefix}-cond-drag" title="Drag to move">
        <span style="color:#a8a29e;letter-spacing:2px">⋮⋮</span>
        <h3>Grubhub map &amp; conditions</h3>
        <button type="button" data-cond-action="close" style="background:#44403c;color:#fff;border:0;border-radius:8px;padding:6px 10px;cursor:pointer;font-weight:700">Close</button>
      </div>
      <div class="${uiPrefix}-cond-tabs">
        <button type="button" data-map-tab="fields" class="${mapPanelTab === "fields" ? "active" : ""}">Field maps</button>
        <button type="button" data-map-tab="conditions" class="${mapPanelTab === "conditions" ? "active" : ""}">Conditions</button>
      </div>
      ${mapPanelTab === "conditions" ? conditionsBody : fieldsBody}
    `;
    applyCondPanelPos(panel);
    showCondPanel(panel);

    panel.querySelectorAll("[data-map-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        mapPanelTab = btn.getAttribute("data-map-tab") || "fields";
        renderConditionsPanel();
      });
    });
    bindFieldMapActions(panel);
    panel.querySelectorAll('[data-cond-action="close"]').forEach((btn) => {
      btn.addEventListener("click", () => hideCondPanel(panel));
    });
    panel.querySelector('[data-cond-action="clear"]')?.addEventListener("click", () => {
      saveUserConditions(defaultUserConditions());
      toast("Cleared your Grubhub conditions.", "success", 3500);
      renderConditionsPanel();
    });
    panel.querySelectorAll("[data-cond-add]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const kind = btn.getAttribute("data-cond-add");
        const from = panel.querySelector(`[data-cond-from="${kind}"]`)?.value;
        const to = panel.querySelector(`[data-cond-to="${kind}"]`)?.value;
        if (!normalizeSpace(from) || !normalizeSpace(to)) {
          toast("Enter both sheet and Workhorse values.", "error");
          return;
        }
        const next = loadUserConditions();
        next[kind] = [...(next[kind] || []), { match: normalizeSpace(from), value: normalizeSpace(to) }];
        saveUserConditions(next);
        toast("Added alias.", "success", 2500);
        renderConditionsPanel();
      });
    });
    panel.querySelector("[data-cond-add-reason]")?.addEventListener("click", () => {
      const from = panel.querySelector("[data-reason-from]")?.value;
      const to = panel.querySelector("[data-reason-to]")?.value;
      if (!normalizeSpace(from) || !normalizeSpace(to)) {
        toast("Enter both sheet and Workhorse reasons.", "error");
        return;
      }
      const next = loadUserConditions();
      next.reasonMap = { ...(next.reasonMap || {}), [normalizeKey(from)]: normalizeSpace(to) };
      saveUserConditions(next);
      toast("Added reason override.", "success", 2500);
      renderConditionsPanel();
    });
    panel.querySelectorAll("[data-cond-del]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const kind = btn.getAttribute("data-cond-del");
        const index = Number(btn.getAttribute("data-cond-index"));
        const next = loadUserConditions();
        next[kind] = (next[kind] || []).filter((_, i) => i !== index);
        saveUserConditions(next);
        renderConditionsPanel();
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
        renderConditionsPanel();
      });
    });
    panel.querySelector("[data-cond-save-builtins]")?.addEventListener("click", () => {
      const next = loadUserConditions();
      const thresholdRaw = panel.querySelector("[data-threshold-gbp]")?.value;
      const thresholdNum = thresholdRaw === "" || thresholdRaw == null ? null : Number(thresholdRaw);
      if (thresholdNum != null && (Number.isNaN(thresholdNum) || thresholdNum < 0)) {
        toast("Enter a valid £ threshold (0 or more).", "error");
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
      const groups = new Set(
        [...panel.querySelectorAll("[data-tweak-dispute-reason]")].map((el) => el.getAttribute("data-tweak-dispute-reason"))
      );
      groups.forEach((key) => {
        if (!key) return;
        const checked = [...panel.querySelectorAll(`[data-tweak-dispute-reason="${key}"]`)]
          .filter((el) => el.checked)
          .map((el) => normalizeSpace(el.value))
          .filter(Boolean);
        tweaks[key] = Object.assign({}, tweaks[key] || {}, { reasonForDispute: checked });
      });
      const reasonMap = { ...(next.reasonMap || {}) };
      panel.querySelectorAll("[data-reason-edit]").forEach((el) => {
        const from = el.getAttribute("data-reason-edit");
        const to = normalizeSpace(el.value);
        if (!from) return;
        const presetTo = (platform.reasonMap || {})[from] || "";
        if (!to || (presetTo && normalizeKey(presetTo) === normalizeKey(to))) delete reasonMap[from];
        else reasonMap[from] = to;
      });
      const customerAliases = [...(next.customerAliases || [])];
      panel.querySelectorAll("[data-preset-customer-match]").forEach((el) => {
        const i = el.getAttribute("data-preset-customer-match");
        const match = normalizeSpace(el.value);
        const value = normalizeSpace(panel.querySelector(`[data-preset-customer-value="${i}"]`)?.value || "");
        if (!match || !value) return;
        const existing = customerAliases.findIndex((a) => normalizeKey(a.match) === normalizeKey(match));
        const row = { match, value };
        if (existing >= 0) customerAliases[existing] = row;
        else customerAliases.push(row);
      });
      next.disputeThresholdGbp = thresholdNum;
      next.conditionTweaks = tweaks;
      next.reasonMap = reasonMap;
      next.customerAliases = customerAliases;
      next.videoSubmitted = panel.querySelector("[data-video-submitted]")?.value || "No";
      next.platformLabel = normalizeSpace(panel.querySelector("[data-platform-label]")?.value) || null;
      saveUserConditions(next);
      toast("Saved Grubhub conditions. Re-extract the row to apply.", "success", 5000);
      renderConditionsPanel();
    });
  }

  function collectedFieldMap(panel) {
    const columns = { ...(loadUserFieldMap().columns || {}) };
    panel.querySelectorAll("[data-map-column]").forEach((el) => {
      const key = el.getAttribute("data-map-column");
      const select = panel.querySelector(`[data-map-select="${key}"]`);
      const value = normalizeSpace((select && select.value) || el.value);
      if (!key) return;
      if (value) columns[key] = value;
      else delete columns[key];
    });
    return columns;
  }

  function payloadFromStoredRow(payload) {
    if (!payload || !Array.isArray(payload.sheetCells) || !payload.sheetCells.length) return null;
    const headers =
      Array.isArray(payload.sheetHeaders) && payload.sheetHeaders.length
        ? payload.sheetHeaders
        : guessHeadersForDataRow(payload.sheetCells);
    const next = buildPayloadFromRowObject(rowToObject(headers, payload.sheetCells));
    next.sheetHeaders = headers.slice();
    next.sheetCells = payload.sheetCells.slice();
    return next;
  }

  async function refreshPayloadWithMaps(payload) {
    const rebuilt = payloadFromStoredRow(payload);
    if (!rebuilt) return payload;
    savePayload(rebuilt);
    return rebuilt;
  }

  async function applyMapsNow(panel) {
    const current = loadUserFieldMap();
    if (panel) current.columns = collectedFieldMap(panel);
    saveUserFieldMap(current);
    let payload = null;
    try {
      payload = await loadPayload();
    } catch (err) {
      console.warn("[Grubhub Claims] loadPayload failed", err);
    }
    if (!payload || !payload.sheetCells) {
      const text = await readClipboardText();
      if (normalizeSpace(text) && !String(text).trim().startsWith("{") && !String(text).startsWith(platform.clipPrefix || "GCF1:")) {
        try {
          payload = parseClipboardToPayload(text);
        } catch (err) {
          console.warn("[Grubhub Claims] clipboard remap failed", err);
        }
      }
    }
    const rebuilt = payloadFromStoredRow(payload) || payload;
    if (rebuilt && rebuilt.orderNumber && rebuilt.sheetCells) {
      savePayload(rebuilt);
      const summary = `Order value ${rebuilt.orderValue || "blank"} · dispute ${rebuilt.disputeAmount || "blank"}`;
      if (isOpSpotPage()) {
        await applyPayloadToClaims(rebuilt, { force: true });
        toast(`Maps applied. ${summary}.`, "success", 5000);
      } else {
        showPreview(rebuilt);
        toast(`Maps saved. ${summary}. Click Fill from Grubhub.`, "success", 5000);
      }
    } else {
      toast("Maps saved. Copy the data row and click Extract once, then Fill uses these columns.", "info", 6000);
    }
    if (document.getElementById(condPanelId)) renderConditionsPanel();
  }

  function bindFieldMapActions(panel) {
    panel.querySelectorAll("[data-map-select]").forEach((sel) => {
      const key = sel.getAttribute("data-map-select");
      const input = panel.querySelector(`[data-map-column="${key}"]`);
      if (input && input.value) sel.value = input.value;
      sel.addEventListener("change", () => {
        if (input) input.value = sel.value;
        applyMapsNow(panel);
      });
    });
    panel.querySelectorAll("[data-map-column]").forEach((input) => {
      input.addEventListener("change", () => applyMapsNow(panel));
    });
    panel.querySelectorAll("[data-map-clear]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.getAttribute("data-map-clear");
        const current = loadUserFieldMap();
        delete current.columns[key];
        saveUserFieldMap(current);
        applyMapsNow(null);
      });
    });
    panel.querySelector('[data-map-action="save"]')?.addEventListener("click", () => applyMapsNow(panel));
    panel.querySelector('[data-map-action="clear"]')?.addEventListener("click", () => {
      const current = loadUserFieldMap();
      current.columns = {};
      saveUserFieldMap(current);
      applyMapsNow(null);
    });
    panel.querySelector('[data-map-action="load-columns"]')?.addEventListener("click", async () => {
      const text = await readClipboardText();
      const matrix = parseTsvMatrix(text);
      if (!matrix.length || !looksLikeHeaderRow(matrix[0])) {
        toast("Copy the header row first (Date, Time, Restaurant…), then Load columns.", "error", 6000);
        return;
      }
      rememberSheetHeaders(matrix[0]);
      toast(`Loaded ${matrix[0].filter(Boolean).length} columns. Pick them in the dropdowns, then Save.`, "success", 5000);
      renderConditionsPanel();
    });
  }

  function showCondPanel(panel) {
    if (!panel.isConnected) (document.documentElement || document.body).appendChild(panel);
    document.documentElement.appendChild(panel);
    pinPanel(panel);
    if (typeof panel.showPopover === "function") {
      try {
        if (!panel.matches(":popover-open")) panel.showPopover();
      } catch (err) {
        console.warn("[Grubhub Claims] showPopover failed", err);
      }
    }
    pinPanel(panel);
    panel.hidden = false;
  }

  function hideCondPanel(panel) {
    if (!panel) return;
    try {
      if (typeof panel.hidePopover === "function") panel.hidePopover();
    } catch {
      /* ignore */
    }
    panel.remove();
  }

  function toggleConditionsPanel() {
    try {
      ensureCondStyles();
      const existing = document.getElementById(condPanelId);
      if (existing && existing.isConnected) {
        hideCondPanel(existing);
        return;
      }
      renderConditionsPanel();
    } catch (err) {
      console.error("[Grubhub Claims] conditions panel failed", err);
      toast(`Could not open map panel: ${err.message || err}`, "error", 8000);
    }
  }

  function buildPayloadFromRowObject(obj) {
    const cols = platform.sheetColumns || {};
    const dateRaw = cellFor(obj, "claimDate", cols.date || ["Date"]);
    const timeRaw = cellFor(obj, "orderTime", cols.time || ["Time"]);
    const restaurant =
      cellFor(obj, "restaurant", cols.restaurant || ["Restaurant", "Full Restaurant Name", "Restaurant Name"]) ||
      obj[headerKey("Restaurant")] ||
      "";
    const orderId = cellFor(obj, "orderNumber", cols.orderId || ["ID", "Order ID", "Order Number"]);
    let description = cellFor(obj, "description", cols.description || ["Description", "Reason", "Adjustment Reason"]);
    if (!mappedColumn("description") && (!description || /^adjustment\s+of\b/i.test(description) || description === orderId)) {
      const reasonHit = Object.values(obj).find(
        (v) =>
          typeof v === "string" &&
          /missing[_]?item|incorrect[_]?item|prepared\s*incorrectly|food\s*safety/i.test(v)
      );
      if (reasonHit) description = reasonHit;
    }
    const fulfillment = cellFor(obj, "fulfillment", cols.fulfillment || ["Fulfillment Type", "Fulfillment"]);
    const platformLabel = mapFulfillmentToPlatform(fulfillment);

    const totals = obj.__totals || [];
    const subtotals = obj.__subtotals || [];
    let disputeAmount = absMoney(cellFor(obj, "disputeAmount", cols.restaurantTotal || ["Restaurant Total"]));
    let orderValue = absMoney(cellFor(obj, "orderValue", cols.subtotal || ["Subtotal"]));
    if (!mappedColumn("disputeAmount")) {
      for (const t of totals) {
        const n = absMoney(t);
        if (n != null && n > 0) disputeAmount = n;
      }
    }
    if (!mappedColumn("orderValue")) {
      for (const s of subtotals) {
        const n = absMoney(s);
        if (n != null && n > 0) orderValue = n;
      }
    }
    if (!mappedColumn("orderValue") && orderValue == null) orderValue = disputeAmount;
    if (!mappedColumn("disputeAmount") && disputeAmount == null) disputeAmount = orderValue;

    const { customer: rawCustomer, location: rawLocation } = splitRestaurant(restaurant);
    const customerOverride = cellFor(obj, "customer", []);
    const locationOverride = cellFor(obj, "location", []);
    const customer = resolveCustomerName(customerOverride || rawCustomer) || customerOverride || rawCustomer;
    const storeLocation = resolveLocationName(locationOverride || rawLocation) || locationOverride || rawLocation;
    const claimDate = parseSheetDate(dateRaw);
    const orderTime = parseSheetTime(timeRaw);
    const refundReason = mapDescriptionToReason(description);
    let reasonForDispute =
      mapReasonForDispute(refundReason) ||
      (platform.reasonMap && (platform.reasonMap[normalizeKey(refundReason)] || platform.reasonMap[refundReason])) ||
      "";

    const items = [];
    const disputeFields = buildDisputeFieldValues(items, refundReason, customer, storeLocation);
    const otherOverride = cellFor(obj, "otherReason", []);
    disputeFields.otherReason = otherOverride || [description, restaurant].filter(Boolean).join("\n");

    let payload = {
      extractedAt: new Date().toISOString(),
      sourceUrl: location.href,
      claimDate: claimDate.raw || dateRaw,
      claimDateISO: claimDate.iso,
      claimDateDMY: claimDate.dmy,
      claimDateDash: claimDate.dash,
      orderTime,
      customer,
      location: storeLocation,
      platform: platformLabel,
      orderNumber: orderId,
      orderValue: orderValue == null ? "" : Number(orderValue).toFixed(2),
      disputeAmount: disputeAmount == null ? "" : Number(disputeAmount).toFixed(2),
      refundReason,
      refundReasonRaw: description,
      alreadyDisputed: false,
      outcome: "",
      videoSubmitted: workhorse.videoSubmitted || "No",
      reasonForDispute: reasonForDispute || "",
      footageStatus: "",
      wrongFoodItem: disputeFields.wrongFoodItem,
      preparedIncorrectlyWhy: disputeFields.preparedIncorrectlyWhy,
      reason: disputeFields.reason || "",
      otherReason: disputeFields.otherReason,
      items,
      errors: [],
      source: "grubhub-sheet",
    };

    payload = enrichPayload(payload);
    payload.platform = platformLabel;
    payload = applyUserConditions(payload);
    if (!payload.reasonForDispute) {
      payload.reasonForDispute =
        mapReasonForDispute(refundReason) ||
        (/incorrect/i.test(description) ? "Incorrect Item" : /missing/i.test(description) ? "Missing Item" : "");
    }

    const errors = [];
    if (!payload.orderNumber) errors.push("ID");
    if (!payload.customer) errors.push("Restaurant → Customer");
    if (!payload.location) errors.push("Restaurant → Location");
    if (!payload.disputeAmount) errors.push("Restaurant Total");
    if (!payload.reasonForDispute) errors.push("Description → Reason for Dispute");
    payload.errors = errors;
    if (Array.isArray(obj.__headers)) payload.sheetHeaders = obj.__headers.slice();
    if (Array.isArray(obj.__cells)) payload.sheetCells = obj.__cells.slice();
    return payload;
  }

  function parseClipboardToPayload(text) {
    const matrix = parseTsvMatrix(text);
    if (!matrix.length) throw new Error("Clipboard is empty. Select the sheet row and press Ctrl+C, then Extract.");

    let headers = DEFAULT_HEADERS.slice();
    let dataRow = matrix[0];

    if (matrix.length >= 2 && looksLikeHeaderRow(matrix[0])) {
      headers = matrix[0];
      dataRow = matrix[1];
    } else if (looksLikeHeaderRow(matrix[0]) && matrix.length === 1) {
      throw new Error("Clipboard looks like a header row only. Copy a data row (click the row number, Ctrl+C).");
    } else if (matrix[0].length < 5) {
      throw new Error("Copy the full row: click the row number on the left, then Ctrl+C, then Extract.");
    } else {
      headers = guessHeadersForDataRow(dataRow);
    }

    const obj = rowToObject(headers, dataRow);
    rememberSheetHeaders(headers);
    return buildPayloadFromRowObject(obj);
  }

  async function readClipboardText() {
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        return await navigator.clipboard.readText();
      }
    } catch (err) {
      console.warn("[Grubhub Claims] clipboard.readText blocked", err);
    }
    try {
      if (typeof GM_getClipboard === "function") return GM_getClipboard() || "";
    } catch {
      /* ignore */
    }
    return "";
  }

  function openPasteDialog() {
    return new Promise((resolve) => {
      const existing = document.getElementById(`${uiPrefix}-paste-modal`);
      if (existing) existing.remove();

      const modal = document.createElement("div");
      modal.id = `${uiPrefix}-paste-modal`;

      const backdrop = document.createElement("div");
      backdrop.className = `${uiPrefix}-paste-backdrop`;

      const card = document.createElement("div");
      card.className = `${uiPrefix}-paste-card`;

      const h3 = document.createElement("h3");
      h3.textContent = "Paste Grubhub sheet row";

      const p = document.createElement("p");
      p.textContent = "Click the row number in Sheets → Ctrl+C → click here → Ctrl+V.";

      const input = document.createElement("textarea");
      input.id = `${uiPrefix}-paste-input`;
      input.rows = 4;
      input.placeholder = "Paste the tab-separated row here…";

      const actions = document.createElement("div");
      actions.className = `${uiPrefix}-paste-actions`;

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.textContent = "Cancel";

      const okBtn = document.createElement("button");
      okBtn.type = "button";
      okBtn.className = "primary";
      okBtn.textContent = "Extract";

      actions.appendChild(cancelBtn);
      actions.appendChild(okBtn);
      card.appendChild(h3);
      card.appendChild(p);
      card.appendChild(input);
      card.appendChild(actions);
      modal.appendChild(backdrop);
      modal.appendChild(card);

      const style = document.createElement("style");
      style.textContent = `
        #${uiPrefix}-paste-modal { position: fixed; inset: 0; z-index: 2147483647; }
        #${uiPrefix}-paste-modal .${uiPrefix}-paste-backdrop { position:absolute; inset:0; background:rgba(0,0,0,.45); }
        #${uiPrefix}-paste-modal .${uiPrefix}-paste-card {
          position:absolute; top:18%; left:50%; transform:translateX(-50%); width:min(560px,92vw);
          background:#1c1917; color:#ffedd5; border-radius:12px; padding:16px;
          box-shadow:0 16px 40px rgba(0,0,0,.4); font:13px/1.4 Segoe UI,system-ui,sans-serif;
        }
        #${uiPrefix}-paste-modal h3 { margin:0 0 8px; font-size:16px; color:#fff; }
        #${uiPrefix}-paste-modal p { margin:0 0 10px; color:#fdba74; }
        #${uiPrefix}-paste-modal textarea {
          width:100%; box-sizing:border-box; border-radius:8px; border:1px solid #78716c;
          background:#0c0a09; color:#fff; padding:10px; font:12px/1.4 Consolas,monospace;
        }
        #${uiPrefix}-paste-modal .${uiPrefix}-paste-actions { display:flex; gap:8px; justify-content:flex-end; margin-top:12px; }
        #${uiPrefix}-paste-modal button { border:0; border-radius:8px; padding:8px 14px; cursor:pointer; font-weight:700; }
        #${uiPrefix}-paste-modal button.primary { background:#ff8000; color:#1c1917; }
        #${uiPrefix}-paste-modal button:not(.primary) { background:#44403c; color:#fff; }
      `;
      document.documentElement.appendChild(style);
      document.body.appendChild(modal);
      setTimeout(() => input.focus(), 50);
      const finish = (value) => {
        modal.remove();
        style.remove();
        resolve(value || "");
      };
      cancelBtn.onclick = () => finish("");
      okBtn.onclick = () => finish(input.value);
      backdrop.onclick = () => finish("");
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) finish(input.value);
      });
    });
  }

  async function payloadFromClipboardText(text) {
    const raw = String(text || "");
    const prefix = platform.clipPrefix || "GCF1:";
    if (prefix && raw.startsWith(prefix)) {
      try {
        const parsed = JSON.parse(raw.slice(prefix.length));
        if (parsed && parsed.orderNumber) return parsed;
      } catch {
        /* fall through to TSV */
      }
    }
    const trimmed = raw.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && parsed.orderNumber) return parsed;
      } catch {
        /* fall through to TSV */
      }
    }
    return parseClipboardToPayload(raw);
  }

  async function applyExtractedText(text) {
    const payload = await payloadFromClipboardText(text);
    clearHits();
    savePayload(payload);
    showPreview(payload);
    let stored = null;
    try {
      stored = await loadPayload();
    } catch (err) {
      console.warn("[Grubhub Claims] storage verify failed", err);
    }
    const synced = stored && stored.orderNumber === payload.orderNumber;
    if (payload.errors.length) {
      toast(`Extracted with missing: ${payload.errors.join(", ")}. Open OpSpot → Fill from Grubhub.`, "error", 9000);
    } else if (!synced) {
      toast(`Extracted ${payload.orderNumber || "row"} (${payload.customer}). Storage may not have synced — click Fill from Grubhub (it can read the copied row).`, "error", 9000);
    } else {
      toast(`Extracted ${payload.orderNumber || "row"} (${payload.customer}). Open OpSpot → Add New → Fill from Grubhub.`, "success", 9000);
    }
    console.log("[Grubhub Claims] payload", payload, { synced });
  }

  async function onExtractClick() {
    const btn = document.getElementById(btnId);
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Reading row…";
    }
    try {
      let text = await readClipboardText();
      if (!normalizeSpace(text)) {
        toast("Clipboard empty or blocked — paste the row in the box.", "info", 5000);
        text = await openPasteDialog();
      }
      if (!normalizeSpace(text)) {
        throw new Error("No row data. Click row number → Ctrl+C, then Extract (or paste into the box).");
      }
      await applyExtractedText(text);
    } catch (err) {
      console.error("[Grubhub Claims] extract failed", err);
      toast(`Grubhub extract failed: ${err.message || err}`, "error", 9000);
      // Offer paste UI on failure too
      try {
        const pasted = await openPasteDialog();
        if (normalizeSpace(pasted)) await applyExtractedText(pasted);
      } catch (err2) {
        console.error("[Grubhub Claims] paste fallback failed", err2);
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = platform.buttonExtract || "Extract sheet row → OpSpot";
      }
    }
  }

  async function onFillClick() {
    let payload = null;
    try {
      payload = await loadPayload();
    } catch (err) {
      console.warn("[Grubhub Claims] loadPayload failed", err);
    }
    if (!payload || !payload.orderNumber) {
      const text = await readClipboardText();
      if (normalizeSpace(text)) {
        try {
          payload = await payloadFromClipboardText(text);
          if (payload && payload.orderNumber) savePayload(payload);
        } catch (err) {
          console.warn("[Grubhub Claims] clipboard fallback failed", err);
        }
      }
    }
    if (!payload || !payload.orderNumber) {
      toast("No stored row — paste the sheet row here.", "info", 5000);
      const pasted = await openPasteDialog();
      if (normalizeSpace(pasted)) {
        try {
          payload = await payloadFromClipboardText(pasted);
          if (payload && payload.orderNumber) savePayload(payload);
        } catch (err) {
          console.warn("[Grubhub Claims] paste fallback failed", err);
        }
      }
    }
    if (!payload || !payload.orderNumber) {
      toast("No Grubhub row stored. On the sheet: copy the row, click Extract, then Fill from Grubhub.", "error", 8000);
      return;
    }
    payload = (await refreshPayloadWithMaps(payload)) || payload;
    await applyPayloadToClaims(payload, { force: true });
  }

  function mountSheet() {
    ensureStyles();
    ensureCondStyles();
    ensureButtonBar();
    injectButton(btnId, platform.buttonExtract || "Extract sheet row → OpSpot", onExtractClick);
    injectButton(condBtnId, "Map & conditions", toggleConditionsPanel);
    if (!document.getElementById(`${uiPrefix}-tip`)) {
      const tip = document.createElement("div");
      tip.id = `${uiPrefix}-tip`;
      tip.style.cssText = "position:fixed;top:56px;left:50%;transform:translateX(-50%);z-index:2147483646;background:#1c1917;color:#ffedd5;padding:8px 14px;border-radius:8px;font:12px/1.4 Segoe UI,sans-serif;max-width:560px;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,.35)";
      tip.textContent = "Grubhub script loaded. Click row number → Ctrl+C → Extract sheet row → OpSpot";
      document.body.appendChild(tip);
      setTimeout(() => tip.remove(), 15000);
    }
    console.log("[Grubhub Claims] sheet UI mounted", location.href);
    try {
      if (typeof GM_registerMenuCommand === "function") {
        GM_registerMenuCommand("Extract Grubhub sheet row", onExtractClick);
        GM_registerMenuCommand("Grubhub map & conditions", toggleConditionsPanel);
      }
    } catch {
      /* ignore */
    }
  }

  async function mountOpSpot() {
    ensureStyles();
    ensureCondStyles();
    ensureButtonBar();
    injectButton(btnId, platform.buttonFill || "Fill from Grubhub", onFillClick);
    injectButton(condBtnId, "Map & conditions", toggleConditionsPanel);
    setupOpSpotSaveHooks(async () => {
      const p = await loadPayload();
      if (p && p.orderNumber) applyPayloadToClaims(p, { force: true, fast: true });
    });
    resetFillGuards();
    const existing = await loadPayload();
    if (existing && existing.orderNumber) {
      showPreview(existing);
    }
    console.log("[Grubhub Claims] OpSpot UI mounted");
    try {
      if (typeof GM_registerMenuCommand === "function") {
        GM_registerMenuCommand("Fill OpSpot from Grubhub", onFillClick);
        GM_registerMenuCommand("Grubhub map & conditions", toggleConditionsPanel);
      }
    } catch {
      /* ignore */
    }
  }

  function mount() {
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", mount, { once: true });
      return;
    }
    if (isOpSpotPage()) {
      mountOpSpot();
      return;
    }
    if (isGoogleSheetsPage()) {
      mountSheet();
    }
  }

  if (typeof GM_addValueChangeListener === "function") {
    GM_addValueChangeListener(platform.storageKey, (_n, _o, value, remote) => {
      if (!remote || !isOpSpotPage() || !value) return;
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
      showPreview(payload);
      toast(`Received ${payload.orderNumber}. Click Fill from Grubhub.`, "success", 6000);
    });
  }

  console.log("[Grubhub Claims] script starting", {
    host: location.host,
    path: location.pathname,
    hasGmSet: typeof GM_setValue === "function",
    hasGmGet: typeof GM_getValue === "function",
  });
  mount();
  window.addEventListener("load", mount);
  // Sheets SPA can remount the DOM — keep the button present
  setInterval(() => {
    if (!isGoogleSheetsPage() || isOpSpotPage()) return;
    if (!document.getElementById(btnId) || !document.getElementById(condBtnId)) mountSheet();
  }, 3000);
})();
