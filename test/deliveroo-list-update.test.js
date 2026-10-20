"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  disputeResolution,
  sameBranch,
  rowMatchesDeliveroo,
  validateClaimBranch,
  validateClaimBranchAndTime,
  claimNeedsEdit,
  planClaimUpdate,
  pickClaimRow,
  findDeliverooForClaim,
  orderKey,
  classifyDisputeStatus,
  preferDisputeStatus,
  choiceMatches,
} = require("../deliveroo-list-update.js");

describe("disputeResolution (Won / Lost)", () => {
  it("maps approved → Won + Won without footage by default", () => {
    assert.deepEqual(disputeResolution("approved", ""), {
      outcome: "Won",
      footageStatus: "Won without footage",
    });
    assert.deepEqual(disputeResolution("approved", "Irrelevant"), {
      outcome: "Won",
      footageStatus: "Won without footage",
    });
  });

  it("maps approved → Won only when already disputed correctly", () => {
    assert.deepEqual(disputeResolution("approved", "Disputed correctly"), {
      outcome: "Won",
    });
  });

  it("maps approved → Won only when video confirms not at fault", () => {
    assert.deepEqual(
      disputeResolution("approved", "Video evidence confirms restaurant is not at fault"),
      { outcome: "Won" }
    );
  });

  it("maps rejected → Lost", () => {
    assert.deepEqual(disputeResolution("rejected", ""), { outcome: "Lost" });
    assert.deepEqual(disputeResolution("rejected", "Disputed correctly"), { outcome: "Lost" });
  });

  it("maps rejected + not at fault (not disputed correctly) → special footage", () => {
    assert.deepEqual(
      disputeResolution("rejected", "Video evidence confirms restaurant is not at fault"),
      {
        outcome: "Lost",
        footageStatus: "Correct claim rejected by the aggregator",
      }
    );
  });

  it("ignores awaiting / unknown status", () => {
    assert.equal(disputeResolution("awaiting", ""), null);
    assert.equal(disputeResolution("", "Disputed correctly"), null);
    assert.equal(disputeResolution("pending", ""), null);
  });
});

describe("classifyDisputeStatus", () => {
  it("detects approved / rejected / awaiting", () => {
    assert.equal(classifyDisputeStatus("Approved"), "approved");
    assert.equal(classifyDisputeStatus("Status: Rejected"), "rejected");
    assert.equal(classifyDisputeStatus("Awaiting review"), "awaiting");
  });

  it("prefers rejected/approved over older awaiting text in the same card", () => {
    assert.equal(classifyDisputeStatus("Awaiting review · Rejected"), "rejected");
    assert.equal(classifyDisputeStatus("Was awaiting review now Approved"), "approved");
  });

  it("does not treat not approved as approved", () => {
    assert.equal(classifyDisputeStatus("Not approved"), "");
  });

  it("preferDisputeStatus upgrades awaiting to approved/rejected", () => {
    assert.equal(preferDisputeStatus("awaiting", "approved"), "approved");
    assert.equal(preferDisputeStatus("approved", "awaiting"), "approved");
    assert.equal(preferDisputeStatus("", "rejected"), "rejected");
  });
});

describe("sameBranch / validateClaimBranch (validate only, never rewrite)", () => {
  it("allows empty Workhorse location so won/lost is not blocked", () => {
    assert.equal(sameBranch("", "Victoria"), true);
    assert.equal(sameBranch(null, "Victoria"), true);
    assert.deepEqual(validateClaimBranch("", "Victoria"), { branchMismatch: false });
    assert.deepEqual(validateClaimBranch("Select…", "Victoria"), { branchMismatch: false });
    assert.deepEqual(validateClaimBranch("Please select", "Canary Wharf"), { branchMismatch: false });
  });

  it("matches exact and soft (contains) names", () => {
    assert.equal(sameBranch("Victoria", "Victoria"), true);
    assert.equal(sameBranch("Shake Shack Canary Wharf", "Canary Wharf"), true);
    assert.equal(sameBranch("Canary Wharf", "Shake Shack Canary Wharf"), true);
  });

  it("flags a clear conflicting branch", () => {
    assert.equal(sameBranch("Victoria", "Brighton"), false);
    assert.deepEqual(validateClaimBranch("Victoria", "Brighton"), { branchMismatch: true });
  });

  it("uses location resolver aliases when provided", () => {
    const resolve = (name) => (/victoria/i.test(name) ? "Victoria" : name);
    assert.equal(sameBranch("Victoria Station", "SS Victoria", resolve), true);
  });
});

describe("rowMatchesDeliveroo", () => {
  const info = { branch: "Victoria", time: "14:30", disputeStatus: "approved" };

  it("accepts matching branch", () => {
    assert.equal(
      rowMatchesDeliveroo(info, {
        branch: "Victoria",
        branchKnown: true,
        time: "14:30",
        outcomeKnown: true,
        footageKnown: true,
      }),
      true
    );
  });

  it("accepts duplicate order on a different branch when time matches", () => {
    assert.equal(
      rowMatchesDeliveroo(info, {
        branch: "Brighton",
        branchKnown: true,
        time: "14:30",
        outcomeKnown: true,
        footageKnown: true,
      }),
      true
    );
  });

  it("rejects different branch when time also differs", () => {
    assert.equal(
      rowMatchesDeliveroo(info, {
        branch: "Brighton",
        branchKnown: true,
        time: "09:00",
        outcomeKnown: true,
        footageKnown: true,
      }),
      false
    );
  });

  it("allows Won/Lost when form time matches even if location wording differs", () => {
    assert.deepEqual(
      validateClaimBranchAndTime("Brighton Marina", "Victoria", "14:30", "14:30"),
      { branchMismatch: false }
    );
    assert.deepEqual(
      validateClaimBranchAndTime("Brighton Marina", "Victoria", "09:00", "14:30"),
      { branchMismatch: true }
    );
  });

  it("accepts empty list location (column present but blank)", () => {
    assert.equal(
      rowMatchesDeliveroo(info, {
        branch: "",
        branchKnown: true,
        time: "14:30",
        outcomeKnown: true,
        footageKnown: true,
      }),
      true
    );
  });
});

describe("claimNeedsEdit", () => {
  it("never reports branchDiff (Location is not rewritten)", () => {
    const need = claimNeedsEdit(
      { time: "10:00", branch: "Victoria", disputeStatus: "approved" },
      {
        time: "10:00",
        branch: "Brighton",
        branchKnown: true,
        dateKnown: true,
        outcome: "",
        outcomeKnown: true,
        footage: "",
        footageKnown: true,
      }
    );
    assert.equal(need.branchDiff, false);
  });

  it("detects outcome update for approved when Outcome is empty", () => {
    const need = claimNeedsEdit(
      { time: "10:00", disputeStatus: "approved" },
      {
        time: "10:00",
        dateKnown: true,
        outcome: "",
        outcomeKnown: true,
        footage: "Irrelevant",
        footageKnown: true,
      }
    );
    assert.equal(need.statusDiff, true);
    assert.equal(need.timeDiff, false);
  });

  it("detects outcome update for rejected → Lost", () => {
    const need = claimNeedsEdit(
      { time: "10:00", disputeStatus: "rejected" },
      {
        time: "10:00",
        dateKnown: true,
        outcome: "Pending",
        outcomeKnown: true,
        footage: "Disputed correctly",
        footageKnown: true,
      }
    );
    assert.equal(need.statusDiff, true);
  });

  it("no statusDiff when already Won for approved", () => {
    const need = claimNeedsEdit(
      { time: "10:00", disputeStatus: "approved" },
      {
        time: "10:00",
        dateKnown: true,
        outcome: "Won",
        outcomeKnown: true,
        footage: "Disputed correctly",
        footageKnown: true,
      }
    );
    assert.equal(need.statusDiff, false);
  });

  it("detects time-only edit without outcome", () => {
    const need = claimNeedsEdit(
      { time: "11:00", disputeStatus: "awaiting" },
      {
        time: "10:00",
        dateKnown: true,
        outcome: "",
        outcomeKnown: true,
        footage: "",
        footageKnown: true,
      }
    );
    assert.equal(need.timeDiff, true);
    assert.equal(need.statusDiff, false);
  });
});

describe("planClaimUpdate", () => {
  const baseCurrent = {
    time: "14:30",
    date: "15-03-2026",
    dateKnown: true,
    branch: "Victoria",
    branchKnown: true,
    outcome: "",
    outcomeKnown: true,
    footage: "Irrelevant",
    footageKnown: true,
  };

  it("plans Won update and never plans a branch write", () => {
    const plan = planClaimUpdate(
      {
        time: "14:30",
        dateRaw: "15 Mar 2026",
        branch: "Victoria",
        disputeStatus: "approved",
      },
      baseCurrent
    );
    assert.equal(plan.action, "edit");
    assert.equal(plan.updateOutcome, true);
    assert.equal(plan.updateBranch, false);
    assert.equal(plan.patch.outcome, "Won");
    assert.equal(plan.patch.footageStatus, "Won without footage");
  });

  it("plans Lost update for rejected", () => {
    const plan = planClaimUpdate(
      { time: "14:30", branch: "Victoria", disputeStatus: "rejected" },
      { ...baseCurrent, footage: "Disputed correctly" }
    );
    assert.equal(plan.action, "edit");
    assert.equal(plan.updateOutcome, true);
    assert.equal(plan.updateBranch, false);
    assert.deepEqual(plan.patch, { outcome: "Lost" });
  });

  it("does not skip when time matches even if branch wording differs", () => {
    const plan = planClaimUpdate(
      { time: "14:30", branch: "Brighton", disputeStatus: "approved" },
      baseCurrent
    );
    assert.equal(plan.action, "edit");
    assert.equal(plan.updateOutcome, true);
    assert.equal(plan.updateBranch, false);
  });

  it("skips when branch conflicts and time also differs", () => {
    const plan = planClaimUpdate(
      { time: "09:00", branch: "Brighton", disputeStatus: "approved" },
      baseCurrent
    );
    assert.equal(plan.action, "skip");
    assert.equal(plan.reason, "branch-mismatch");
    assert.equal(plan.updateOutcome, false);
    assert.equal(plan.updateBranch, false);
  });

  it("still plans Won when Workhorse location is empty", () => {
    const plan = planClaimUpdate(
      { time: "14:30", branch: "Victoria", disputeStatus: "approved" },
      { ...baseCurrent, branch: "" }
    );
    assert.equal(plan.action, "edit");
    assert.equal(plan.updateOutcome, true);
    assert.equal(plan.updateBranch, false);
  });

  it("returns none when already correct", () => {
    const plan = planClaimUpdate(
      { time: "14:30", branch: "Victoria", disputeStatus: "approved" },
      {
        ...baseCurrent,
        outcome: "Won",
        footage: "Disputed correctly",
      }
    );
    assert.equal(plan.action, "none");
    assert.equal(plan.updateBranch, false);
  });
});

describe("pickClaimRow", () => {
  it("among same-time duplicates, prefers matching branch", () => {
    const rows = [
      { time: "14:30", branch: "Brighton", branchKnown: true },
      { time: "14:30", branch: "Victoria", branchKnown: true },
    ];
    const picked = pickClaimRow(rows, { branch: "Victoria", time: "14:30" });
    assert.equal(picked.branch, "Victoria");
  });

  it("prefers matching time within the same branch", () => {
    const rows = [
      { time: "10:00", branch: "Victoria", branchKnown: true },
      { time: "14:30", branch: "Victoria", branchKnown: true },
    ];
    const picked = pickClaimRow(rows, { branch: "Victoria", time: "14:30" });
    assert.equal(picked.time, "14:30");
  });

  it("picks the time-matched row even when branch wording differs", () => {
    const rows = [{ time: "14:30", branch: "Brighton", branchKnown: true }];
    const picked = pickClaimRow(rows, { branch: "Victoria", time: "14:30" });
    assert.equal(picked.time, "14:30");
  });

  it("returns null when no time match and only other-branch rows exist", () => {
    const rows = [{ time: "09:00", branch: "Brighton", branchKnown: true }];
    assert.equal(pickClaimRow(rows, { branch: "Victoria", time: "14:30" }), null);
  });
});

describe("findDeliverooForClaim (Workhorse-first)", () => {
  const deliverooRows = [
    { orderNumber: "1234", time: "10:00", branch: "Brighton", disputeStatus: "approved" },
    { orderNumber: "1234", time: "14:30", branch: "Victoria", disputeStatus: "rejected" },
    { orderNumber: "5678", time: "11:00", branch: "Victoria", disputeStatus: "awaiting" },
  ];

  it("matches Workhorse claim to Deliveroo by order # + time", () => {
    const hit = findDeliverooForClaim(deliverooRows, {
      orderNumber: "1234",
      time: "14:30",
      branch: "Victoria",
    });
    assert.equal(hit.disputeStatus, "rejected");
    assert.equal(hit.branch, "Victoria");
  });

  it("matches by branch when times differ / missing on claim", () => {
    const hit = findDeliverooForClaim(deliverooRows, {
      orderNumber: "1234",
      time: "",
      branch: "Brighton",
    });
    assert.equal(hit.time, "10:00");
    assert.equal(hit.disputeStatus, "approved");
  });

  it("returns null when order is not in the Deliveroo batch", () => {
    assert.equal(
      findDeliverooForClaim(deliverooRows, { orderNumber: "9999", time: "10:00", branch: "Victoria" }),
      null
    );
  });

  it("returns null for ambiguous duplicate order # without time/branch", () => {
    assert.equal(
      findDeliverooForClaim(deliverooRows, { orderNumber: "1234", time: "", branch: "" }),
      null
    );
  });

  it("unique order # matches even without time/branch", () => {
    const hit = findDeliverooForClaim(deliverooRows, {
      orderNumber: "5678",
      time: "",
      branch: "",
    });
    assert.equal(hit.orderNumber, "5678");
  });
});

describe("orderKey / choiceMatches", () => {
  it("normalizes leading zeros so form and list keys match", () => {
    assert.equal(orderKey("01234"), orderKey("1234"));
    assert.equal(orderKey("Order 00456"), "456");
  });

  it("matches outcome labels case-insensitively", () => {
    assert.equal(choiceMatches("Won", "won"), true);
    assert.equal(choiceMatches("Lost", "Pending"), false);
  });
});
