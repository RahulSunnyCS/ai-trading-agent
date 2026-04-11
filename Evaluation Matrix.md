# AI Trading Agent — Ideation-Phase Evaluation Matrix

## 1. Purpose & Scope

This matrix lets a **trader / quant manager** decide whether the AI Trading Agent
project is worth building at its current ideation stage. No code exists yet —
the evaluation is based solely on the three source design documents listed
below. It is deliberately lighter than a production quant rubric (no Sharpe,
drawdown, slippage rigour etc.); instead it focuses on the two questions that
matter at ideation time:

1. **Feasibility** — Can this actually be built and operated given the stated
   approach, data, infrastructure, team, and constraints?
2. **Value** — Is it worth building? What problem does it solve, how unique is
   it, what do we learn even if P&L fails, and what is the upside?

The final output is a recommendation to **BUILD MVP / DE-RISK FIRST /
DE-PRIORITISE / DROP**, backed by a score on each parameter with cited
evidence.

---

## 2. Stage

**Ideation.** No code has been written. Only design documentation exists.
This matrix will be re-run at each phase gate (after MVP, after paper-trading
pilot, after any live run) and the score deltas tracked in the change log.

---

## 3. Source Documents

All three files live at the repo root:

| File | Role |
| --- | --- |
| `PERSONALITIES.md` | 10 parallel trading personalities (7 fixed reference + 3 learning), risk caps, parameter-evolution thresholds. |
| `PRODUCT_OVERVIEW.md` | Strategies (Non-Directional / Directional ATM / Momentum Buy), signals, regime tagging, success & falsification criteria. |
| `TECHNICAL_REFERENCE.md` | Proposed architecture, DB schema, momentum-exhaustion algorithm, latency targets, 5-stage decision filter. |

---

## 4. Evaluation Prompt (reusable for reviewer / LLM)

Copy-paste this block to re-run the evaluation with any reviewer or LLM.

> **Role.** You are a senior quant / trading-desk manager reviewing an
> ideation-phase proposal for an AI options-trading agent. You have not met
> the team before and have no prior context.
>
> **Task.** Read the three source documents listed in §3 (`PERSONALITIES.md`,
> `PRODUCT_OVERVIEW.md`, `TECHNICAL_REFERENCE.md`). For each of the 16
> parameters in §5 and §6, assign a rating on the 1–5 scale defined below.
> For every rating you must:
>
> 1. **Cite evidence** in the form `<FILE>:<section/heading or line>` that
>    supports the rating. If the evidence is absent, write "not addressed".
> 2. **List 1–3 concrete risks or gaps** the document leaves open.
> 3. **Propose one specific, cheap action** that would de-risk that parameter
>    (e.g., "run a 2-week paper-trade of Clockwork only to validate data
>    plumbing"). The action must be executable in the ideation phase.
>
> **Rubric.**
>
> | Score | Meaning |
> | --- | --- |
> | **1** | Red flag / blocker — would kill the project if not fixed. |
> | **2** | Weak / concerning — significant gap, needs work before MVP. |
> | **3** | Adequate / uncertain — plausible but unproven. |
> | **4** | Strong / well-addressed — clear plan with evidence. |
> | **5** | Excellent / differentiating — a genuine strength of the proposal. |
>
> **Rules.**
> - Do **not** invent features, metrics, or infrastructure that are not in the
>   source documents.
> - Do **not** score on what "could be added later". Score what is written
>   today.
> - If two documents contradict, flag the contradiction in Risks/Gaps.
> - Keep each Risks/Gaps and De-risk Action cell ≤ 30 words.
>
> **Output.** Fill the Rating / Evidence / Risks-Gaps / De-risk Action cells
> of the tables in §5 and §6 in place. Then compute the rollup in §7, place
> the project in the 2×2 grid in §8, write the recommendation in §9, list
> the top 3 risks and strengths in §10, and append a row to the change log
> in §11.

---

## 5. Feasibility Parameters (A1–A8)

> _"Can we build this and run it?"_

| # | Parameter | Rating (1-5) | Evidence (file:section) | Risks / Gaps | Action to De-risk |
| --- | --- | :---: | --- | --- | --- |
| A1 | **Hypothesis feasibility** — is the core claim (momentum exhaustion predicts intraday reversals in weekly index options) precise, testable, and falsifiable? | — | — | — | — |
| A2 | **Data feasibility** — are tick data, option chain, 15-sec straddle snapshots, and India VIX actually available at required cadence, cost, and history depth? | — | — | — | — |
| A3 | **Technical / architectural feasibility** — is the Bun / Fastify / TimescaleDB / Redis stack realistic for the latency targets (<5 ms tick→straddle, <50 ms signal→decision, <100 ms order)? | — | — | — | — |
| A4 | **Execution feasibility (paper → live)** — can 10 parallel personalities actually trade weekly index straddles given liquidity, slippage, order types, and margin? | — | — | — | — |
| A5 | **Operational feasibility** — can a small team run and monitor 10 personalities daily, with a functional kill-switch and manual override? | — | — | — | — |
| A6 | **Regulatory & compliance feasibility** — SEBI / broker algo-trading rules, paper-first path, audit-trail requirements. | — | — | — | — |
| A7 | **Timeline & resource feasibility** — is the 4-phase roadmap (signal validation → S/R engine → multi-strategy → RL) realistic for the team size and budget? | — | — | — | — |
| A8 | **MVP scope clarity** — is the smallest testable slice (e.g., Clockwork + Precision on paper for 1 month) clearly defined, with go / no-go gates between phases? | — | — | — | — |

---

## 6. Value Parameters (B1–B8)

> _"Is it worth building?"_

| # | Parameter | Rating (1-5) | Evidence (file:section) | Risks / Gaps | Action to De-risk |
| --- | --- | :---: | --- | --- | --- |
| B1 | **Problem significance** — how big and painful is the "suboptimal entry timing in weekly options" problem, and who feels it (self-directed retail, prop desks, retail quants)? | — | — | — | — |
| B2 | **Uniqueness / differentiation** — is the controlled-experiment multi-personality design + regime-aware retrospection genuinely novel vs existing option bots, TradingView scripts, broker algos? | — | — | — | — |
| B3 | **Research / learning value** — even if P&L disappoints, what durable knowledge is produced (regime-conditional edge maps, personality evolution logs, probability calibration data)? | — | — | — | — |
| B4 | **Commercial / P&L upside** — plausible ROI on deployed capital if the edge holds, capacity before decay, and path to monetisation (personal alpha / SaaS / signals / fund). | — | — | — | — |
| B5 | **Strategic fit / optionality** — does it open adjacent opportunities (e.g., the retrospection engine generalising to other instruments / strategies)? | — | — | — | — |
| B6 | **Risk-adjusted attractiveness** — is the payoff asymmetric given paper-first approach? Worst-case downside vs best-case upside in time, capital, and reputation. | — | — | — | — |
| B7 | **Speed-to-signal** — how quickly can we learn whether the idea is working (weeks vs quarters)? Is there a cheap falsification path? | — | — | — | — |
| B8 | **Stakeholder / user value** — would a trader actually use and trust the output? Is personality behaviour and signal generation explainable? | — | — | — | — |

---

## 7. Category Rollup

| Dimension | Parameters | Avg Score (1-5) | Notes |
| --- | --- | :---: | --- |
| **Feasibility** | A1–A8 | — | — |
| **Value** | B1–B8 | — | — |

---

## 8. 2 × 2 Verdict Grid

Place the project with an `[X]` in the quadrant defined by the rollup scores in
§7. The dividing line is **3.0** on each axis.

```
                VALUE (low ← → high)
              1 ─────────────── 5
            5 ┌───────────────┬───────────────┐
              │               │               │
F         ↑   │  DE-PRIORITISE │  BUILD MVP   │
E         │   │   (high-F,    │   NOW         │
A         │   │   low-V)      │  (high-F,    │
S         │   │               │   high-V)    │
I       3.0 ├───────────────┼───────────────┤
B         │   │               │               │
I         │   │   DROP        │  DE-RISK     │
L         │   │  (low-F,      │   FIRST      │
I         ↓   │   low-V)      │  (low-F,     │
T             │               │   high-V)    │
Y         1 └───────────────┴───────────────┘
                     (to be filled on evaluation)
```

---

## 9. Recommendation

_Filled on evaluation run._

- **Verdict:** `BUILD MVP` / `DE-RISK FIRST` / `DE-PRIORITISE` / `DROP` — —
- **One-sentence rationale:** —
- **Next concrete step (if BUILD or DE-RISK):** —
- **Kill criteria (when to abandon):** —

---

## 10. Top 3 Risks & Top 3 Strengths

_Filled on evaluation run._

**Top 3 Risks**

1. —
2. —
3. —

**Top 3 Strengths**

1. —
2. —
3. —

---

## 11. Change Log

| Date | Reviewer | Feasibility Avg | Value Avg | Verdict | Notes |
| --- | --- | :---: | :---: | --- | --- |
| — | — | — | — | — | Matrix created with empty ratings. |
