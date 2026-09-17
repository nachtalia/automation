/**
 * Claims presets — Workhorse field maps + Deliveroo / Uber Eats platform rules.
 * Edit this file to change OpSpot fill order, reason maps, outcome rules, or sheet tabs.
 * Loaded via Tampermonkey @require by both platform userscripts.
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
