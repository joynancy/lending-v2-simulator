import React, { useState, useMemo, useCallback } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
} from "recharts";

/* ------------------------------------------------------------------ */
/*  XRPL Lending V2 — Collateral Management Simulator                  */
/*  Implements the rules in the Collateral Management PRD:             */
/*  ILTV draw gate, LLTV liquidation gate, revolving draws,            */
/*  all-or-nothing vs arrears-only depth, liquidation buffer,          */
/*  surplus retention, FLC waterfall.                                  */
/* ------------------------------------------------------------------ */

const fmt = (n, d = 2) =>
  n === null || n === undefined || !isFinite(n)
    ? "—"
    : n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtInt = (n) =>
  n === null || !isFinite(n) ? "—" : Math.round(n).toLocaleString("en-US");
const pct = (n, d = 1) => (isFinite(n) ? `${(n * 100).toFixed(d)}%` : "—");

const DEFAULT_CONFIG = {
  iltv: 0.5,
  lltv: 0.75,
  buffer: 0.05,
  cap: 8_000_000,
  rate: 0.0,
  tenorDays: 90,
  gracePeriodDays: 5,
};

const START = {
  price: 3.0,
  pledged: 0,
  loans: [],
  history: [{ step: 0, price: 3.0, ltv: 0, label: "start" }],
  log: [],
  step: 0,
  missedPayment: null, // { amount, state: 'grace' | 'overdue' }
  closed: false,
  defaulted: null,
};

export default function CollateralSimulator() {
  const [cfg, setCfg] = useState(DEFAULT_CONFIG);
  const [s, setS] = useState(START);
  const [drawAmt, setDrawAmt] = useState(1_000_000);
  const [pledgeAmt, setPledgeAmt] = useState(1_000_000);
  const [releaseAmt, setReleaseAmt] = useState(100_000);
  const [paymentAmt, setPaymentAmt] = useState(24_000);
  const [flc, setFlc] = useState(150_000);
  const [notice, setNotice] = useState(null);

  /* ---------------- derived position ---------------- */
  const pos = useMemo(() => {
    const collateralValue = s.pledged * s.price;
    const debt = s.loans
      .filter((l) => l.status === "active")
      .reduce((a, l) => a + l.principal + l.interest - l.paid, 0);
    const ltv = collateralValue > 0 ? debt / collateralValue : debt > 0 ? Infinity : 0;
    const liqPrice = s.pledged > 0 && debt > 0 ? debt / (cfg.lltv * s.pledged) : null;
    const interestFactor = 1 + cfg.rate * (cfg.tenorDays / 365);
    const headroomValue = cfg.iltv * collateralValue - debt;
    const maxPrincipal = Math.max(0, Math.min(headroomValue / interestFactor, cfg.cap - debt));
    const bufferToLiq = liqPrice && s.price > 0 ? 1 - liqPrice / s.price : null;
    const eligible =
      !s.closed && (ltv >= cfg.lltv || s.missedPayment?.state === "overdue") && debt > 0;
    const eligibleReason =
      ltv >= cfg.lltv
        ? "LLTV breach"
        : s.missedPayment?.state === "overdue"
        ? "Overdue payment"
        : null;
    return {
      collateralValue,
      debt,
      ltv,
      liqPrice,
      interestFactor,
      maxPrincipal,
      bufferToLiq,
      eligible,
      eligibleReason,
    };
  }, [s, cfg]);

  const zone = pos.debt === 0 ? "idle" : pos.ltv >= cfg.lltv ? "danger" : pos.ltv >= cfg.iltv ? "warn" : "safe";

  /* ---------------- helpers ---------------- */
  const push = useCallback((next, entry) => {
    setS((prev) => {
      const merged = { ...prev, ...next };
      const collateralValue = merged.pledged * merged.price;
      const debt = merged.loans
        .filter((l) => l.status === "active")
        .reduce((a, l) => a + l.principal + l.interest - l.paid, 0);
      const ltv = collateralValue > 0 ? debt / collateralValue : 0;
      const step = prev.step + 1;
      return {
        ...merged,
        step,
        history: [...prev.history, { step, price: merged.price, ltv, label: entry.type }],
        log: [{ ...entry, step, ltv, price: merged.price }, ...prev.log],
      };
    });
  }, []);

  const reject = (reason) => setNotice({ kind: "reject", text: reason });
  const inform = (text) => setNotice({ kind: "ok", text });

  /* ---------------- transactions ---------------- */
  const depositCollateral = () => {
    if (s.closed) return reject("Position is closed. Reset to run a new scenario.");
    if (pledgeAmt <= 0) return reject("Enter a collateral quantity above zero.");
    push(
      { pledged: s.pledged + pledgeAmt },
      {
        type: "DepositCollateral",
        detail: `${fmtInt(pledgeAmt)} XRP pledged at $${fmt(s.price)} → registered value $${fmtInt(
          pledgeAmt * s.price
        )}`,
        tone: "ok",
      }
    );
    inform(`Collateral registered. Borrowing capacity is now bounded by ILTV ${pct(cfg.iltv, 0)}.`);
  };

  const draw = () => {
    if (s.closed) return reject("Position is closed. Reset to run a new scenario.");
    if (pos.eligible) return reject("Position is liquidation-eligible. No new draws permitted.");
    const interest = drawAmt * cfg.rate * (cfg.tenorDays / 365);
    const loanValue = drawAmt + interest;
    const newLtv = (pos.debt + loanValue) / pos.collateralValue;
    if (!isFinite(newLtv)) return reject("No collateral pledged. Deposit collateral first.");
    if (newLtv > cfg.iltv)
      return reject(
        `Draw rejected. (${fmtInt(pos.debt)} + ${fmtInt(loanValue)}) ÷ ${fmtInt(
          pos.collateralValue
        )} = ${pct(newLtv)} exceeds ILTV ${pct(cfg.iltv, 0)}. Maximum principal available: ${fmtInt(
          pos.maxPrincipal
        )} RLUSD.`
      );
    if (pos.debt + loanValue > cfg.cap)
      return reject(
        `Draw rejected by the protocol drawdown cap. Outstanding would reach ${fmtInt(
          pos.debt + loanValue
        )} against a cap of ${fmtInt(cfg.cap)} RLUSD.`
      );
    const loan = {
      id: s.loans.length + 1,
      principal: drawAmt,
      interest,
      paid: 0,
      status: "active",
    };
    push(
      { loans: [...s.loans, loan] },
      {
        type: "Draw",
        detail: `Loan #${loan.id}: ${fmtInt(drawAmt)} RLUSD${
          interest > 0 ? ` + ${fmtInt(interest)} interest` : ""
        } → LTV ${pct(newLtv)} ≤ ILTV ${pct(cfg.iltv, 0)} ✓`,
        tone: "ok",
      }
    );
    inform("Funds disbursed atomically against locked collateral (DvP).");
  };

  const repayAll = () => {
    if (pos.debt <= 0) return reject("Nothing outstanding to repay.");
    push(
      {
        loans: s.loans.map((l) => (l.status === "active" ? { ...l, status: "repaid", paid: l.principal + l.interest } : l)),
        missedPayment: null,
      },
      {
        type: "Repay",
        detail: `Full repayment of ${fmtInt(pos.debt)} RLUSD. Debt cleared; collateral unlocked for release.`,
        tone: "ok",
      }
    );
    inform("Early repayment is permitted at any time; the prepayment penalty is configurable to zero.");
  };

  const releaseCollateral = () => {
    if (releaseAmt <= 0 || releaseAmt > s.pledged) return reject("Enter a quantity you have pledged.");
    const remaining = s.pledged - releaseAmt;
    const newLtv = remaining > 0 ? pos.debt / (remaining * s.price) : pos.debt > 0 ? Infinity : 0;
    if (pos.debt > 0 && newLtv >= cfg.iltv)
      return reject(
        `Release rejected. Remaining collateral would leave LTV at ${pct(
          newLtv
        )}, at or above ILTV ${pct(cfg.iltv, 0)}.`
      );
    push(
      { pledged: remaining, closed: pos.debt === 0 && remaining === 0 ? true : s.closed },
      {
        type: "ReleaseCollateral",
        detail: `${fmtInt(releaseAmt)} XRP returned to borrower. Remaining pledge ${fmtInt(
          remaining
        )} XRP, LTV ${pos.debt > 0 ? pct(newLtv) : "0.0%"}`,
        tone: "ok",
      }
    );
  };

  const setPrice = (p) => {
    if (s.closed) return;
    setS((prev) => {
      const collateralValue = prev.pledged * p;
      const debt = prev.loans
        .filter((l) => l.status === "active")
        .reduce((a, l) => a + l.principal + l.interest - l.paid, 0);
      const ltv = collateralValue > 0 ? debt / collateralValue : 0;
      const step = prev.step + 1;
      const crossed = ltv >= cfg.lltv && debt > 0;
      return {
        ...prev,
        price: p,
        step,
        history: [...prev.history, { step, price: p, ltv, label: "price" }],
        log: crossed
          ? [
              {
                type: "LLTV breach",
                detail: `Oracle price $${fmt(p)} → collateral value $${fmtInt(
                  collateralValue
                )}, LTV ${pct(ltv)} ≥ LLTV ${pct(cfg.lltv, 0)}. Position is immediately liquidation-eligible, no cure window.`,
                tone: "danger",
                step,
                ltv,
                price: p,
              },
              ...prev.log,
            ]
          : prev.log,
      };
    });
  };

  const missPayment = () => {
    if (pos.debt <= 0) return reject("No active loan to miss a payment on.");
    push(
      { missedPayment: { amount: paymentAmt, state: "grace" } },
      {
        type: "Payment missed",
        detail: `Scheduled payment of ${fmtInt(paymentAmt)} RLUSD unpaid. Grace period of ${
          cfg.gracePeriodDays
        } days starts; collateral stays locked and untouchable.`,
        tone: "warn",
      }
    );
  };

  const expireGrace = () => {
    if (s.missedPayment?.state !== "grace") return;
    push(
      { missedPayment: { ...s.missedPayment, state: "overdue" } },
      {
        type: "Grace expired",
        detail:
          "Payment overdue. The position is liquidation-eligible on the payment trigger, independent of LTV.",
        tone: "danger",
      }
    );
  };

  const cureByPayment = () => {
    if (!s.missedPayment) return;
    const amt = s.missedPayment.amount;
    const loans = [...s.loans];
    let left = amt;
    for (const l of loans) {
      if (l.status !== "active" || left <= 0) continue;
      const due = l.principal + l.interest - l.paid;
      const applied = Math.min(due, left);
      l.paid += applied;
      left -= applied;
      if (l.paid >= l.principal + l.interest - 0.001) l.status = "repaid";
    }
    push(
      { loans, missedPayment: null },
      {
        type: "Cured",
        detail: `Borrower paid the ${fmtInt(amt)} RLUSD arrears within the grace period. Loan continues on schedule.`,
        tone: "ok",
      }
    );
  };

  const topUp = () => {
    const target = cfg.iltv;
    const needed = Math.max(0, pos.debt / (target * s.price) - s.pledged);
    if (needed <= 0) return reject("Position is already inside ILTV. No top-up required.");
    push(
      { pledged: s.pledged + needed },
      {
        type: "Cure (top-up)",
        detail: `${fmtInt(needed)} XRP added to restore LTV to ILTV ${pct(cfg.iltv, 0)}.`,
        tone: "ok",
      }
    );
  };

  const liquidate = () => {
    if (!pos.eligible) return reject("Position is not liquidation-eligible.");
    const arrearsOnly = pos.eligibleReason === "Overdue payment" && pos.ltv < cfg.lltv;
    const owed = arrearsOnly ? s.missedPayment.amount : pos.debt;
    const releaseValue = owed * (1 + cfg.buffer);
    const xrpNeeded = releaseValue / s.price;

    // Shortfall: collateral cannot cover the amount owed plus buffer
    if (xrpNeeded >= s.pledged) {
      const recovered = s.pledged * s.price;
      const residual = owed - recovered;
      const flcAbsorbed = Math.min(flc, residual);
      const lenderLoss = Math.max(0, residual - flc);
      push(
        {
          pledged: 0,
          loans: s.loans.map((l) => (l.status === "active" ? { ...l, status: "defaulted" } : l)),
          closed: true,
          defaulted: { residual, flcAbsorbed, lenderLoss },
          missedPayment: null,
        },
        {
          type: "Shortfall → default",
          detail: `Collateral value $${fmtInt(recovered)} is below the ${fmtInt(
            owed
          )} owed. All collateral goes to the liquidator; residual ${fmtInt(
            residual
          )} is unsecured → impairment → remediation window → default. First Loss Capital absorbs ${fmtInt(
            flcAbsorbed
          )}${lenderLoss > 0 ? `; ${fmtInt(lenderLoss)} reaches lender capital` : "; lender capital untouched"}.`,
          tone: "danger",
        }
      );
      return;
    }

    if (arrearsOnly) {
      const loans = [...s.loans];
      let left = owed;
      for (const l of loans) {
        if (l.status !== "active" || left <= 0) continue;
        const due = l.principal + l.interest - l.paid;
        const applied = Math.min(due, left);
        l.paid += applied;
        left -= applied;
        if (l.paid >= l.principal + l.interest - 0.001) l.status = "repaid";
      }
      push(
        { pledged: s.pledged - xrpNeeded, loans, missedPayment: null },
        {
          type: "Liquidation — arrears only",
          detail: `Broker repaid ${fmtInt(owed)} RLUSD and received ${fmtInt(
            owed
          )} × (1 + ${pct(cfg.buffer, 0)}) = $${fmtInt(releaseValue)} of collateral = ${fmtInt(
            xrpNeeded
          )} XRP at $${fmt(s.price)}. The loan continues; the position is otherwise untouched.`,
          tone: "warn",
        }
      );
      return;
    }

    const surplus = s.pledged - xrpNeeded;
    push(
      {
        pledged: surplus,
        loans: s.loans.map((l) => (l.status === "active" ? { ...l, status: "liquidated" } : l)),
        closed: true,
        missedPayment: null,
      },
      {
        type: "Liquidation — all or nothing",
        detail: `Broker repaid the full ${fmtInt(owed)} outstanding and received ${fmtInt(
          owed
        )} × (1 + ${pct(cfg.buffer, 0)}) = $${fmtInt(releaseValue)} of collateral = ${fmtInt(
          xrpNeeded
        )} XRP at $${fmt(s.price)}. Surplus ${fmtInt(surplus)} XRP (≈ $${fmtInt(
          surplus * s.price
        )}) never left the pledge and returns to the borrower. Debt: zero.`,
        tone: "danger",
      }
    );
  };

  /* ---------------- scenarios ---------------- */
  const loadAppendixA = () => {
    const c = { ...DEFAULT_CONFIG, iltv: 0.5, lltv: 0.75, buffer: 0.05, cap: 8_000_000, rate: 0 };
    setCfg(c);
    const loans = [
      { id: 1, principal: 1_000_000, interest: 0, paid: 0, status: "active" },
      { id: 2, principal: 200_000, interest: 0, paid: 0, status: "active" },
    ];
    setS({
      ...START,
      price: 3.0,
      pledged: 1_000_000,
      loans,
      step: 3,
      history: [
        { step: 0, price: 3.0, ltv: 0, label: "start" },
        { step: 1, price: 3.0, ltv: 0, label: "pledge" },
        { step: 2, price: 3.0, ltv: 1_000_000 / 3_000_000, label: "draw" },
        { step: 3, price: 3.0, ltv: 1_200_000 / 3_000_000, label: "draw" },
      ],
      log: [
        {
          step: 3,
          type: "Draw",
          detail: "Loan #2: 200,000 RLUSD → (1,000,000 + 200,000) ÷ 3,000,000 = 40.0% ≤ ILTV 50% ✓",
          tone: "ok",
          ltv: 0.4,
          price: 3,
        },
        {
          step: 2,
          type: "Draw",
          detail: "Loan #1: 1,000,000 RLUSD → (0 + 1,000,000) ÷ 3,000,000 = 33.3% ≤ ILTV 50% ✓",
          tone: "ok",
          ltv: 1 / 3,
          price: 3,
        },
        {
          step: 1,
          type: "DepositCollateral",
          detail: "1,000,000 XRP pledged at $3.00 → registered value $3,000,000",
          tone: "ok",
          ltv: 0,
          price: 3,
        },
      ],
    });
    setDrawAmt(400_000);
    setReleaseAmt(100_000);
    setPaymentAmt(24_000);
    inform(
      "Appendix A loaded: 1,000,000 XRP pledged, 1.2M RLUSD outstanding, LTV 40%. Rate is set to zero so the figures match the worked example exactly. Try the 400,000 draw (it should be rejected), then drop the price to $1.55."
    );
  };

  const reset = () => {
    setCfg(DEFAULT_CONFIG);
    setS(START);
    setNotice(null);
  };

  const chartData = s.history.map((h) => ({ ...h, ltvPct: h.ltv * 100 }));

  /* ---------------- render ---------------- */
  return (
    <div className="sim">
      <style>{`
        .sim {
          --paper:#EBEEF1; --surface:#FFFFFF; --ink:#14202E; --muted:#5F6E7E;
          --rule:#D4DAE1; --safe:#1F6F5C; --warn:#B07A1E; --danger:#A8322B;
          --soft:#F4F6F8;
          background:var(--paper); color:var(--ink); min-height:100%;
          font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          font-variant-numeric: tabular-nums; padding:20px;
        }
        .sim * { box-sizing:border-box; }
        .masthead { display:flex; justify-content:space-between; align-items:flex-end; gap:16px;
          border-bottom:2px solid var(--ink); padding-bottom:12px; margin-bottom:18px; flex-wrap:wrap; }
        .masthead h1 { font-size:24px; font-weight:600; letter-spacing:-0.02em; margin:0; }
        .masthead p { margin:4px 0 0; color:var(--muted); font-size:13px; max-width:62ch; line-height:1.5; }
        .btnrow { display:flex; gap:8px; flex-wrap:wrap; }
        button { font:inherit; font-size:13px; border:1px solid var(--ink); background:var(--surface);
          color:var(--ink); padding:7px 12px; border-radius:2px; cursor:pointer; }
        button:hover { background:var(--ink); color:var(--surface); }
        button:disabled { opacity:.35; cursor:not-allowed; }
        button:focus-visible { outline:2px solid var(--safe); outline-offset:2px; }
        button.primary { background:var(--ink); color:var(--surface); }
        button.primary:hover { background:#000; }
        button.danger { border-color:var(--danger); color:var(--danger); }
        button.danger:hover { background:var(--danger); color:#fff; }
        .grid { display:grid; grid-template-columns: 250px minmax(0,1fr) 270px; gap:16px; align-items:start; }
        @media (max-width: 1000px){ .grid { grid-template-columns:1fr; } }
        .panel { background:var(--surface); border:1px solid var(--rule); border-radius:3px; padding:14px; }
        .panel h2 { font-size:12px; font-weight:600; margin:0 0 2px; letter-spacing:0; }
        .panel .sub { font-size:11px; color:var(--muted); margin:0 0 12px; line-height:1.45; }
        .field { margin-bottom:11px; }
        .field label { display:flex; justify-content:space-between; font-size:12px; color:var(--muted); margin-bottom:3px; }
        .field label b { color:var(--ink); font-weight:600; }
        input[type=range] { width:100%; accent-color:var(--ink); }
        input[type=number] { width:100%; font:inherit; font-size:13px; padding:5px 7px;
          border:1px solid var(--rule); border-radius:2px; background:var(--soft); color:var(--ink); }
        .stat { display:flex; justify-content:space-between; align-items:baseline;
          padding:7px 0; border-bottom:1px dotted var(--rule); font-size:13px; }
        .stat:last-child { border-bottom:none; }
        .stat span { color:var(--muted); font-size:12px; }
        .stat b { font-weight:600; font-size:14px; }
        .ltvwrap { margin:4px 0 14px; }
        .ltvhead { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:8px; }
        .ltvnum { font-size:40px; font-weight:600; letter-spacing:-0.03em; line-height:1; }
        .track { position:relative; height:28px; background:var(--soft); border:1px solid var(--rule); border-radius:2px; overflow:hidden; }
        .fill { position:absolute; left:0; top:0; bottom:0; }
        .mark { position:absolute; top:-5px; bottom:-5px; width:2px; background:var(--ink); }
        .marklabels { position:relative; height:16px; font-size:10px; color:var(--muted); margin-top:3px; }
        .marklabels span { position:absolute; transform:translateX(-50%); white-space:nowrap; }
        .zone { display:inline-block; font-size:11px; padding:2px 7px; border-radius:2px; border:1px solid currentColor; }
        .notice { font-size:12px; padding:9px 11px; border-radius:2px; margin-bottom:12px; line-height:1.5; }
        .notice.reject { background:#FBF0EF; border:1px solid var(--danger); color:var(--danger); }
        .notice.ok { background:#EFF5F3; border:1px solid var(--safe); color:var(--safe); }
        .ledger { margin-top:16px; }
        .entry { display:grid; grid-template-columns:34px 170px minmax(0,1fr) 62px; gap:10px;
          padding:9px 0; border-bottom:1px solid var(--rule); font-size:12.5px; align-items:baseline; }
        .entry:last-child { border-bottom:none; }
        .entry .st { color:var(--muted); font-size:11px; }
        .entry .ty { font-weight:600; }
        .entry .de { color:#36465A; line-height:1.5; }
        .entry .lv { text-align:right; font-weight:600; }
        .tone-ok .ty { color:var(--safe); }
        .tone-warn .ty { color:var(--warn); }
        .tone-danger .ty { color:var(--danger); }
        .formula { background:var(--soft); border-left:2px solid var(--ink); padding:9px 11px;
          font-size:12px; line-height:1.65; margin-top:10px; color:#36465A; }
        .formula b { color:var(--ink); }
        .empty { color:var(--muted); font-size:12.5px; padding:14px 0; }
        .actions { display:grid; gap:7px; }
        .hr { height:1px; background:var(--rule); margin:13px 0; }
        .chips { display:flex; gap:6px; flex-wrap:wrap; margin-top:6px; }
        .chips button { font-size:11.5px; padding:5px 9px; }
      `}</style>

      <div className="masthead">
        <div>
          <h1>XRPL Lending V2 — Collateral Management</h1>
          <p>
            An executable version of the MVP rules: ILTV gates every draw, LLTV gates liquidation,
            and depth depends on which trigger fires. Pledge collateral, draw against it, move the
            oracle price, and watch the protocol decide what is permitted.
          </p>
        </div>
        <div className="btnrow">
          <button onClick={loadAppendixA}>Load Appendix A example</button>
          <button onClick={reset}>Reset</button>
        </div>
      </div>

      {notice && (
        <div className={`notice ${notice.kind}`}>{notice.text}</div>
      )}

      <div className="grid">
        {/* ---------------- configuration rail ---------------- */}
        <div className="panel">
          <h2>Protocol configuration</h2>
          <p className="sub">
            Set by the Loan Broker, fixed at co-sign with the Vault Owner. Editable here for
            demonstration only.
          </p>

          <div className="field">
            <label>
              Initial LTV (draw gate) <b>{pct(cfg.iltv, 0)}</b>
            </label>
            <input
              type="range"
              min="0.1"
              max="0.9"
              step="0.05"
              value={cfg.iltv}
              onChange={(e) => setCfg({ ...cfg, iltv: Math.min(+e.target.value, cfg.lltv - 0.05) })}
            />
          </div>
          <div className="field">
            <label>
              Liquidation LTV <b>{pct(cfg.lltv, 0)}</b>
            </label>
            <input
              type="range"
              min="0.15"
              max="0.95"
              step="0.05"
              value={cfg.lltv}
              onChange={(e) => setCfg({ ...cfg, lltv: Math.max(+e.target.value, cfg.iltv + 0.05) })}
            />
          </div>
          <div className="field">
            <label>
              Liquidation buffer <b>{pct(cfg.buffer, 0)}</b>
            </label>
            <input
              type="range"
              min="0"
              max="0.2"
              step="0.01"
              value={cfg.buffer}
              onChange={(e) => setCfg({ ...cfg, buffer: +e.target.value })}
            />
          </div>
          <div className="field">
            <label>
              Loan rate <b>{pct(cfg.rate, 1)}</b>
            </label>
            <input
              type="range"
              min="0"
              max="0.2"
              step="0.005"
              value={cfg.rate}
              onChange={(e) => setCfg({ ...cfg, rate: +e.target.value })}
            />
          </div>
          <div className="field">
            <label>
              Tenor <b>{cfg.tenorDays} days</b>
            </label>
            <input
              type="range"
              min="30"
              max="365"
              step="15"
              value={cfg.tenorDays}
              onChange={(e) => setCfg({ ...cfg, tenorDays: +e.target.value })}
            />
          </div>
          <div className="field">
            <label>Protocol drawdown cap (RLUSD)</label>
            <input
              type="number"
              value={cfg.cap}
              onChange={(e) => setCfg({ ...cfg, cap: +e.target.value })}
            />
          </div>
          <div className="field">
            <label>First Loss Capital (RLUSD)</label>
            <input type="number" value={flc} onChange={(e) => setFlc(+e.target.value)} />
          </div>

          <div className="formula">
            Loan value is <b>principal + all unpaid interest</b>, fixed at origination. At{" "}
            {pct(cfg.rate, 1)} over {cfg.tenorDays} days, every 1.00 drawn carries{" "}
            <b>{fmt(pos.interestFactor, 4)}</b> of loan value, so the usable borrowing capacity is
            discounted accordingly.
          </div>
        </div>

        {/* ---------------- position + chart ---------------- */}
        <div>
          <div className="panel">
            <div className="ltvwrap">
              <div className="ltvhead">
                <div>
                  <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>
                    Aggregate loan to value
                  </div>
                  <div
                    className="ltvnum"
                    style={{
                      color:
                        zone === "danger"
                          ? "var(--danger)"
                          : zone === "warn"
                          ? "var(--warn)"
                          : "var(--ink)",
                    }}
                  >
                    {pos.debt > 0 ? pct(pos.ltv) : "—"}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div
                    className="zone"
                    style={{
                      color:
                        zone === "danger"
                          ? "var(--danger)"
                          : zone === "warn"
                          ? "var(--warn)"
                          : zone === "safe"
                          ? "var(--safe)"
                          : "var(--muted)",
                    }}
                  >
                    {s.closed
                      ? "Position closed"
                      : zone === "danger"
                      ? "Liquidation eligible"
                      : zone === "warn"
                      ? "Above ILTV — no new draws"
                      : zone === "safe"
                      ? "Within limits"
                      : "No position"}
                  </div>
                  {s.missedPayment && (
                    <div
                      className="zone"
                      style={{
                        marginTop: 6,
                        color: s.missedPayment.state === "grace" ? "var(--warn)" : "var(--danger)",
                      }}
                    >
                      {s.missedPayment.state === "grace"
                        ? `In grace — ${fmtInt(s.missedPayment.amount)} arrears`
                        : `Overdue — ${fmtInt(s.missedPayment.amount)} arrears`}
                    </div>
                  )}
                </div>
              </div>

              <div className="track">
                <div
                  className="fill"
                  style={{
                    width: `${Math.min(100, (isFinite(pos.ltv) ? pos.ltv : 1) * 100)}%`,
                    background:
                      zone === "danger"
                        ? "var(--danger)"
                        : zone === "warn"
                        ? "var(--warn)"
                        : "var(--safe)",
                    opacity: 0.85,
                  }}
                />
                <div className="mark" style={{ left: `${cfg.iltv * 100}%` }} />
                <div className="mark" style={{ left: `${cfg.lltv * 100}%` }} />
              </div>
              <div className="marklabels">
                <span style={{ left: `${cfg.iltv * 100}%` }}>ILTV {pct(cfg.iltv, 0)}</span>
                <span style={{ left: `${cfg.lltv * 100}%` }}>LLTV {pct(cfg.lltv, 0)}</span>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 22px" }}>
              <div>
                <div className="stat">
                  <span>Oracle price</span>
                  <b>${fmt(s.price)}</b>
                </div>
                <div className="stat">
                  <span>Collateral pledged</span>
                  <b>{fmtInt(s.pledged)} XRP</b>
                </div>
                <div className="stat">
                  <span>Collateral value</span>
                  <b>${fmtInt(pos.collateralValue)}</b>
                </div>
              </div>
              <div>
                <div className="stat">
                  <span>Outstanding loan value</span>
                  <b>${fmtInt(pos.debt)}</b>
                </div>
                <div className="stat">
                  <span>Liquidation price</span>
                  <b style={{ color: "var(--danger)" }}>
                    {pos.liqPrice ? `$${fmt(pos.liqPrice)}` : "—"}
                  </b>
                </div>
                <div className="stat">
                  <span>Price cushion to LLTV</span>
                  <b>{pos.bufferToLiq !== null ? pct(pos.bufferToLiq) : "—"}</b>
                </div>
              </div>
            </div>

            {pos.debt > 0 && pos.liqPrice && (
              <div className="formula">
                Liquidation price = debt ÷ (LLTV × collateral quantity) ={" "}
                <b>{fmtInt(pos.debt)}</b> ÷ ({pct(cfg.lltv, 0)} × {fmtInt(s.pledged)}) ={" "}
                <b>${fmt(pos.liqPrice)}</b>. Collateral must fall{" "}
                <b>{pct(pos.bufferToLiq)}</b> from here before anyone, the broker included, can
                touch it.
              </div>
            )}
          </div>

          <div className="panel" style={{ marginTop: 16 }}>
            <h2>Oracle price and LTV path</h2>
            <p className="sub">
              Each transaction and price move advances one step. The dotted lines are the two
              thresholds fixed at co-sign.
            </p>
            <div style={{ height: 150 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                  <XAxis dataKey="step" tick={{ fontSize: 10, fill: "#5F6E7E" }} stroke="#D4DAE1" />
                  <YAxis
                    yAxisId="l"
                    tick={{ fontSize: 10, fill: "#5F6E7E" }}
                    stroke="#D4DAE1"
                    domain={[0, "auto"]}
                  />
                  <YAxis
                    yAxisId="r"
                    orientation="right"
                    tick={{ fontSize: 10, fill: "#5F6E7E" }}
                    stroke="#D4DAE1"
                    domain={[0, 120]}
                    width={34}
                  />
                  <Tooltip
                    contentStyle={{ fontSize: 12, borderRadius: 2, border: "1px solid #D4DAE1" }}
                    formatter={(v, n) =>
                      n === "price" ? [`$${fmt(v)}`, "Oracle price"] : [`${fmt(v, 1)}%`, "LTV"]
                    }
                  />
                  <ReferenceLine
                    yAxisId="r"
                    y={cfg.lltv * 100}
                    stroke="#A8322B"
                    strokeDasharray="4 3"
                  />
                  <ReferenceLine
                    yAxisId="r"
                    y={cfg.iltv * 100}
                    stroke="#B07A1E"
                    strokeDasharray="4 3"
                  />
                  <Line
                    yAxisId="l"
                    type="stepAfter"
                    dataKey="price"
                    stroke="#14202E"
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    yAxisId="r"
                    type="stepAfter"
                    dataKey="ltvPct"
                    stroke="#1F6F5C"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="panel ledger">
            <h2>Transaction ledger</h2>
            <p className="sub">Newest first. Every entry shows the rule the protocol applied.</p>
            {s.log.length === 0 ? (
              <div className="empty">
                Nothing has happened yet. Pledge collateral to open a position, or load the
                Appendix A example.
              </div>
            ) : (
              s.log.map((e, i) => (
                <div className={`entry tone-${e.tone}`} key={i}>
                  <div className="st">{e.step}</div>
                  <div className="ty">{e.type}</div>
                  <div className="de">{e.detail}</div>
                  <div className="lv">{e.ltv > 0 ? pct(e.ltv) : "—"}</div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* ---------------- actions ---------------- */}
        <div>
          <div className="panel">
            <h2>Borrower actions</h2>
            <p className="sub">Each one is checked against the live oracle price before it settles.</p>
            <div className="actions">
              <div className="field">
                <label>Collateral to pledge (XRP)</label>
                <input
                  type="number"
                  value={pledgeAmt}
                  onChange={(e) => setPledgeAmt(+e.target.value)}
                />
              </div>
              <button className="primary" onClick={depositCollateral}>
                DepositCollateral
              </button>

              <div className="field" style={{ marginTop: 8 }}>
                <label>
                  Draw (RLUSD) <b>max {fmtInt(pos.maxPrincipal)}</b>
                </label>
                <input type="number" value={drawAmt} onChange={(e) => setDrawAmt(+e.target.value)} />
              </div>
              <button className="primary" onClick={draw}>
                Draw loan
              </button>

              <div className="hr" />
              <button onClick={repayAll} disabled={pos.debt <= 0}>
                Repay in full (early, penalty free)
              </button>
              <button onClick={topUp} disabled={pos.debt <= 0}>
                Cure by topping up collateral
              </button>
              <div className="field" style={{ marginTop: 8 }}>
                <label>Collateral to release (XRP)</label>
                <input
                  type="number"
                  value={releaseAmt}
                  onChange={(e) => setReleaseAmt(+e.target.value)}
                />
              </div>
              <button onClick={releaseCollateral} disabled={s.pledged <= 0}>
                ReleaseCollateral
              </button>
            </div>
          </div>

          <div className="panel" style={{ marginTop: 16 }}>
            <h2>Market and stress</h2>
            <p className="sub">Move the oracle, or run the missed payment path.</p>
            <div className="field">
              <label>
                Oracle price (XRP/RLUSD) <b>${fmt(s.price)}</b>
              </label>
              <input
                type="range"
                min="0.2"
                max="6"
                step="0.05"
                value={s.price}
                onChange={(e) => setPrice(+e.target.value)}
              />
            </div>
            <div className="chips">
              <button onClick={() => setPrice(+(s.price * 0.9).toFixed(2))}>−10%</button>
              <button onClick={() => setPrice(+(s.price * 0.75).toFixed(2))}>−25%</button>
              <button onClick={() => setPrice(1.55)}>$1.55</button>
              <button onClick={() => setPrice(1.0)}>$1.00</button>
              <button onClick={() => setPrice(+(s.price * 1.15).toFixed(2))}>+15%</button>
            </div>

            <div className="hr" />
            <div className="field">
              <label>Scheduled payment (RLUSD)</label>
              <input
                type="number"
                value={paymentAmt}
                onChange={(e) => setPaymentAmt(+e.target.value)}
              />
            </div>
            <div className="actions">
              <button onClick={missPayment} disabled={!!s.missedPayment || pos.debt <= 0}>
                Miss this payment
              </button>
              <button onClick={cureByPayment} disabled={s.missedPayment?.state !== "grace"}>
                Cure within grace period
              </button>
              <button onClick={expireGrace} disabled={s.missedPayment?.state !== "grace"}>
                Let grace period expire
              </button>
            </div>

            <div className="hr" />
            <button className="danger" onClick={liquidate} disabled={!pos.eligible}>
              {pos.eligibleReason === "Overdue payment" && pos.ltv < cfg.lltv
                ? "Liquidate arrears"
                : "Liquidate position"}
            </button>
            <p className="sub" style={{ marginTop: 8, marginBottom: 0 }}>
              {pos.eligible
                ? `Eligible on: ${pos.eligibleReason}. ${
                    pos.eligibleReason === "LLTV breach"
                      ? "All or nothing — the whole position closes and surplus returns to the borrower."
                      : "Arrears only — just the overdue amount plus buffer; the loan continues."
                  }`
                : "Not eligible. Below LLTV and with payments current, no one can touch the collateral."}
            </p>
          </div>

          {s.defaulted && (
            <div className="panel" style={{ marginTop: 16, borderColor: "var(--danger)" }}>
              <h2 style={{ color: "var(--danger)" }}>Default waterfall</h2>
              <div className="stat">
                <span>Unsecured residual</span>
                <b>${fmtInt(s.defaulted.residual)}</b>
              </div>
              <div className="stat">
                <span>Absorbed by First Loss Capital</span>
                <b>${fmtInt(s.defaulted.flcAbsorbed)}</b>
              </div>
              <div className="stat">
                <span>Reaching lender capital</span>
                <b style={{ color: s.defaulted.lenderLoss > 0 ? "var(--danger)" : "var(--safe)" }}>
                  ${fmtInt(s.defaulted.lenderLoss)}
                </b>
              </div>
              <div className="formula">
                The FLC provider captures any subsequent recovery on the defaulted loan, not the
                lenders. Standard subrogation, consistent with V1.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
