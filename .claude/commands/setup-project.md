---
description: Interview the project owner to capture all domain-specific facts and write them to .claude/project/ — overview.md, business.md, and technical.md. Run this when setting up the pipeline on a new project, onboarding a new codebase, or when the project context files are outdated or missing.
---

# /setup-project — Domain Owner Interview

You are setting up the project context files that every agent in this pipeline reads. Your goal is to capture accurate, non-duplicated facts and write them to three files:

- `.claude/project/overview.md` — what the product does and who uses it
- `.claude/project/business.md` — business model, tiers, pricing, billing rules
- `.claude/project/technical.md` — stack, patterns, conventions, gotchas, commands

**Before asking anything, explore the codebase first.** Read:
- `package.json` (dependencies, scripts, name)
- `README.md` or `START_HERE.md` (product description)
- Any existing `.claude/project/` files (what is already captured)
- `prisma/schema.prisma` or equivalent (data model)
- `.env.example` (environment variables, integrations)
- Key source files (auth, payments, API routes, main entry points)

Answer every question you can from the code before asking. Only ask about things you genuinely cannot determine from reading the codebase.

---

## Interview Rules

1. Ask **one question at a time**. Never batch questions.
2. For each question, state in one sentence **why you need it** (which pipeline decision it affects).
3. Always offer a **recommended answer** derived from your codebase exploration. If you can infer it confidently, say so and ask for confirmation only.
4. If the user says "skip" or "not relevant", omit that fact from the output file.
5. Stop asking when every section below has been covered or explicitly skipped.
6. After the interview, **do not ask for more input** — write the files and report what was created.

---

## Question Sets

Work through these sections in order. Skip any question whose answer is already clear from the codebase.

### SECTION 1 — Overview (feeds overview.md)

Q1.1: What does this product do? (One or two plain-English sentences — what problem it solves and for whom.)
Q1.2: Who are the target users? (Developer tool? Consumer app? Internal team tool? B2B SaaS?)
Q1.3: What are the core feature areas? (e.g. "Security scan, Performance audit, SEO check" — a short bullet list.)
Q1.4: Are there any secondary surfaces — CLI, API, mobile app, browser extension — beyond the main web UI?

### SECTION 2 — Business (feeds business.md)

Q2.1: What is the business model? (Fully free? Freemium? Paid-only? Usage-based? Enterprise licence?)
Q2.2: What pricing tiers exist? For each tier: name, price, billing period, and what it unlocks.
Q2.3: Which payment provider handles billing? (Stripe, Paddle, Lemon Squeezy, custom, none.)
Q2.4: Are there any billing-specific flags, bypass modes, or test-flow overrides the pipeline must know about? (e.g. a flag that grants a tier without charging in dev/staging — and whether it must be disabled in prod.)
Q2.5: Are there any compliance or legal constraints on the billing flow? (PCI, GDPR data-minimisation, strong customer authentication, etc.)

### SECTION 3 — Technical (feeds technical.md)

Q3.1: What is the framework and primary language? (e.g. Next.js 14 / TypeScript, FastAPI / Python 3.12, Rails 7 / Ruby.)
Q3.2: What database and ORM are in use? Are there separate dev and prod providers? (e.g. SQLite dev / PostgreSQL prod.)
Q3.3: What authentication system is used, and which providers are configured? (NextAuth, Auth0, Supabase, custom JWT, etc.)
Q3.4: What package manager and Node/runtime version? Are there multiple lockfiles or version constraints to be aware of?
Q3.5: What are the essential development commands? (dev server, build, test, lint, database migrate/reset.) List them as shell commands.
Q3.6: What external services are integrated? (AI/LLM, object storage, email, monitoring, queue, CDN, analytics — which ones and via which SDKs.)
Q3.7: What are the key architectural patterns every developer must know? (e.g. scanner module signature, server vs client components, pagination style, i18n approach.)
Q3.8: What are the gotchas — non-obvious things that trip up new contributors? (e.g. two lockfiles, CI scripts missing from package.json, a db:push that targets prod, an env var that must never be set in prod.)
Q3.9: What does the test setup look like? (Framework, environment, mocking strategy, where tests live, coverage threshold.)
Q3.10: Which environment variables are critical to call out? (Not a full list — just the ones whose misconfiguration causes subtle or hard-to-debug failures.)

---

## Output Format

After the interview is complete, write all three files. Follow the exact format of the existing files in `.claude/project/` so every agent reads them consistently.

**overview.md format:**
```
# Project Overview

**[Product name]** ([package name], repo `[repo name]`) is [1–2 sentence description].

- **[Feature area 1]** — [brief description]
- **[Feature area 2]** — [brief description]
[repeat]
```

**business.md format:**
```
# Business & Product Context

[Product name] is a [model] [product type]. [One sentence on free vs paid split and cost structure.]

## Offering

- [Feature 1 — free or paid]
- [Feature 2]
[repeat]

## Tiers ([provider]-gated)

Product tiers, lowest → highest: **[tier] → [tier] → ...**. [One sentence on what higher tiers unlock.]

[Tier details: name, price, what it includes]

## Caveats

- [Any billing bypass flags, prod constraints, compliance notes]
```

**technical.md format:**
```
# Technical Context

## Tech Stack

| Area | Choice |
|---|---|
| Framework | [name + version] |
| ORM / DB | [name + version] — [dev provider] (dev) / [prod provider] (prod) |
| Auth | [system + providers] |
[repeat key rows]

## Package Manager & Runtime

- [Package manager and lockfile note]
- [Node/runtime version and where it is pinned]
- [Any version conflicts or gotchas]

## Essential Commands

[Shell commands for dev, build, test, lint, migrate, reset]

## Repository Structure

[Key directories and what lives in each — only the non-obvious ones]

## Architecture

[Key architectural patterns — module signatures, data flow, auth helper, middleware, feature flags, etc.]

## Key Patterns & Conventions

[Bullet list: naming, server vs client, i18n, error handling, pagination, secret hygiene, TypeScript config, formatting, lint, commits]

## Testing

[Framework, environment, mocking, test locations, coverage thresholds]

## Environment Variables

[Highlights only: the ones whose misconfiguration causes real pain]

## Common Tasks

[Step-by-step for: add a module, add a page, add an API route, schema change, toggle a feature]

## Gotchas

[Bullet list of non-obvious traps]
```

---

## After Writing

Report back:
```
PROJECT CONTEXT WRITTEN
━━━━━━━━━━━━━━━━━━━━━━━

Files written:
✅ .claude/project/overview.md  — [N lines]
✅ .claude/project/business.md  — [N lines]
✅ .claude/project/technical.md — [N lines]

Inferred from codebase (no questions asked):
- [List of facts taken directly from code]

Confirmed with you:
- [List of facts that needed your input]

Skipped (you said not relevant):
- [Any sections skipped]

Next step: run /start to let the orchestrator read the repo with your new context in place.
```

If any `.claude/project/` file already existed and was overwritten, note what changed and what was preserved.
