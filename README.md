# AI-driven engineering workflow automation: POC

A standalone portal where a **data engineer onboards a new source** and a **business user gets a published report**, both from plain-English requests. **Every generated output goes through a single reviewer before it goes live.** It runs on a reference data platform with synthetic data until the customer's platform and a masked sample are available.

## Run it

Requires Node.js 20 or later. No other services are needed: the reference platform is an embedded DuckDB database.

```bash
cd poc
npm install
npm start            # http://localhost:4310 (seeds the platform on first run)
```

- `npm test` runs the end-to-end tests (all three use cases through the HTTP API, plus the AI path with simulated model responses).
- `npm run seed` rebuilds the platform with fresh synthetic data. The **Conventions & setup** page has the same reset button.

### AI engine

| Setting | Behaviour |
|---|---|
| `ANTHROPIC_API_KEY` set | Claude (`claude-opus-5-5`) classifies requests, proposes schema mappings, breaks down requirements and parses alert rules, using schema-constrained JSON output. |
| No key, or `AI_ENGINE=rules` | A deterministic rule engine does the same steps offline. This keeps demos reliable without network access. |
| `CLAUDE_MODEL=...` | Overrides the model. |

Whichever engine runs, its output is **validated against the platform vocabulary and compiled into SQL by deterministic code**. The model never writes executable SQL. If a Claude proposal fails validation (for example, personal data left unhashed) or the call fails, the rule engine takes over. The artifact's *How this was produced* panel records which engine did what.

## Deploy to Render (hosted demo)

The repo includes a `Dockerfile` and a `render.yaml` Blueprint. The free plan is enough.

1. Push this `poc` folder to a GitHub repository. `.env`, `data/` and `node_modules/` are gitignored, so the API key and database stay local.
2. In Render, choose **New > Blueprint** and pick the repository.
3. When Render asks for values, set `PORTAL_PASSWORD` (the login is user `demo` plus that password). Leave `ANTHROPIC_API_KEY` blank to stay on the rules engine.
4. Wait for the deploy to finish, then open the `onrender.com` URL. The first start seeds the synthetic data, which takes about 10 seconds.

Things to know:
- **Password:** when `PORTAL_PASSWORD` is set, every page and API call needs it. Only `/healthz` is open. Locally, with no password set, the portal stays open.
- **Free plan:** the service sleeps after 15 minutes idle, and the first visit after that takes about a minute. The disk is temporary, so a restart or redeploy reseeds the data. That's a clean demo every time, but approvals made earlier are lost. For data that survives restarts, use a paid plan, add a disk mounted at `/app/data`, and set `POC_DB_PATH=/app/data/platform.duckdb`.
- **Claude:** add `ANTHROPIC_API_KEY` in the Render dashboard and set `AI_ENGINE=auto`.
- **Other hosts:** the same image runs anywhere Docker runs. Use `docker build -t ai-workflow-poc .` and then `docker run -p 10000:10000 -e PORTAL_PASSWORD=... ai-workflow-poc`.

## Demo script (about 10 minutes)

1. **Ask → Business user:** *"Show monthly warranty cost and claim rate per 1,000 units by product line for 2025, with a breakdown by region."*
   The request is **blocked**: warranty data is not on the platform yet. The portal says which source to onboard.
2. **Ask → Data engineer:** *"Onboard warranty claims from the dealer portal."* Open it in the review queue:
   - **Schema mapping:** every source column mapped to a Silver column, with a role, transform and rationale. The email column is flagged as PII and hashed.
   - **Source profile:** null rates, distinct counts, detected patterns and top values.
   - **Pipelines (SQL):** Bronze, Silver and quarantine SQL in the sample conventions.
   - **Data quality:** the dry run removes 88 duplicates, quarantines 58 rows with reasons, finds credit adjustments (negative amounts), and maps 95.4% of part numbers.
   - **Part mapping:** prefixes (`AT-`), revision suffixes, legacy numbers via supersession, plus flagged exceptions. Keying errors come with a suggested part; placeholders such as `TBD` and `UNKNOWN` are flagged, never guessed.
   - **Approve & deploy** with the suggested corrections accepted. The tables go live and appear in the **Catalog** and **Lineage**, with DQ history.
3. **Re-submit the business request from step 1.** Review it:
   - **Requirement breakdown:** measures, dimensions, period and stated assumptions.
   - **Gold plan:** **reuses** `gold.fct_sales`, **builds** `gold.fct_warranty_claims` plus a report mart, and registers new measures (`claims_per_1000_units`, and others).
   - **Reconciliation:** source system → Gold fact → report totals all match.
   - **Approve.** Open the dashboard in **Reports** and use **Download PDF** for the one-page version. The HD Series torque-converter spike (Jun–Oct 2025) is visible in the trend.
4. **Ask → Quality engineer (thin slice):** *"Alert me when monthly warranty cost for any product line rises more than 50% month over month."* Review the back-test, approve, then use **Evaluate now** on the Alerts page.
5. **Audit trail:** who asked, what was generated, who approved it, and what was deployed.

## Scope coverage

| Scope item | Where it lives |
|---|---|
| **UC1** Profile a source on an existing platform | `src/profiler.js`: nulls, cardinality, uniqueness, value patterns, duplicates |
| **UC1** Propose the schema mapping | `src/onboarding.js` (Claude prompt + JSON schema, validator), `src/rules.js` (fallback) |
| **UC1** Bronze and Silver pipelines in sample conventions | `compileOnboarding()` follows `config/conventions.json`: audit columns, typed casts, dedupe, quarantine, PII hashing |
| **UC1** Part numbers → product hierarchy, flag exceptions | `silver.std_part_no` macro, supersession, steward overrides, `meta.part_exceptions` with near-match suggestions |
| **UC1** Register in a catalog | `meta.catalog` (columns with roles, PII, owner, DQ status) and the **Catalog** page |
| **UC2** Requirement → measures and dimensions | `src/reporting.js` (Claude prompt + schema, constrained to `src/semantic.js`), `rules.decomposeRequirement` |
| **UC2** Reuse existing Gold, build missing Gold tables and measures | Plan step: reuse `gold.fct_sales`, build `gold.fct_*` from onboarded Silver by column role, register measures in `meta.measures` |
| **UC2** In-portal dashboard and one-page PDF | **Reports** page (SVG charts) and `src/pdf.js` (PDFKit, single page, vector chart) |
| **UC2** Reconcile report totals to source | `reconcile()` recomputes each base measure straight from the source system and compares it with the Gold fact and the report |
| **UC3** One plain-English alert rule (thin slice) | `src/alerts.js`: rule → SQL over a Gold fact, back-test, approval, evaluate on demand |
| Natural-language intake | `src/workflow.js` `intake()`: classify and route |
| Single-reviewer approval gate | `decide()`: the dry run happens in a **rolled-back transaction**; approval re-runs **the exact reviewed SQL**, re-checks DQ, and rolls back on any blocking failure |
| Data quality checks | Onboarding: completeness, key not null and unique, plausible dates, numeric parse, negatives, mapping rate, PII, quarantine rate. Reports: mart not empty, fact grain unique, unmapped share. |
| Lineage back to source | `meta.lineage` edges from every deploy; **Lineage** graph from source to Bronze, Silver, Gold and the report, also printed on the PDF |

Out of scope, as agreed: unstructured or file-upload sources, SSO and integration with Allison portals, Power BI publishing, scheduling and distribution (phase 2), streaming, multi-level approvals, cost controls, and production-grade security.

## Architecture

```
public/          portal UI (vanilla JS, no build step)
src/server.js    Express API
src/workflow.js  NL intake routing + approval gate
src/onboarding.js   UC1: profile -> mapping -> Bronze/Silver SQL -> dry run -> deploy
src/reporting.js    UC2: requirement -> spec -> Gold plan -> mart -> dashboard/recon -> publish
src/alerts.js       UC3: alert rule -> SQL -> back-test -> activate
src/llm.js       Claude client (structured outputs, fallbacks) ; src/rules.js deterministic engine
src/semantic.js  measures, dimensions, column roles, transforms, Gold fact templates
src/seed.js      synthetic reference platform (ERP, dealer portal, MES)
config/conventions.json   layer conventions the generated code follows
```

The **reference platform** is a DuckDB file (`data/platform.duckdb`) with one schema per system and layer: `src_erp`, `src_dealer`, `src_mes`, `bronze`, `silver`, `gold`, plus `meta` for portal state. The ERP sales domain is pre-onboarded to simulate an existing estate. Dealer warranty claims and MES inspections are not onboarded yet. The warranty data is deliberately messy: duplicates, bad dates, thousands separators, credits, part-number variants, typos and placeholders.

### Moving to the customer's platform

Swap `src/db.js` for the customer's SQL engine (for example Databricks SQL or Snowflake), point the `src_*` sources at their schemas, and replace `config/conventions.json` with their standards. The compilers emit ANSI-style SQL with a few DuckDB functions (`try_strptime`, `QUALIFY`, `levenshtein`, `sha256`) that have direct equivalents.

## Known limitations (POC)

- The live Claude path has not been exercised against the API in this environment, because no API key was available. It is covered by tests with simulated model responses (`test/ai-path.test.js`), and the rule engine runs the full demo.
- Reconciliation is at total level for the report period. Per-slice reconciliation would be a next step.
- Alert evaluation is on demand; scheduling is phase 2.
- There is no authentication: reviewer identity is a typed name, which matches the single-reviewer, no-production assumption.
