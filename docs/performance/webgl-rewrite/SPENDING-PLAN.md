# Spending plan: USD200 owner ceiling for the full renderer rewrite

Status: plan only. None of this has been spent. USD200 is a ceiling, not a target or a promise that the work completes. The plan has stages, gates and stop-losses. If the cap is reached first, the work stops in a shippable state behind a flag.

This file replaces the earlier baseline spending plan. Corrections are listed in §8.

## 0. Rates and billing facts (from OWNER-BRIEF.md:13)

| Model | Input | Output | Cache write 5m / 1h | Cache read |
|---|---|---|---|---|
| Opus 5.5 | $4/M | $20/M | $5/M / $8/M | $0.20/M |
| Haiku 5.5, prompt ≤100k | $0.10/M | $0.50/M | $0.125/M (5m) | $0.01/M |
| Haiku 5.5, prompt >100k (5× long-context premium) | $0.50/M | $2.50/M | $0.625/M | $0.05/M |

- Thinking tokens bill as output.
- Native child-agent cost is included in `total_cost_usd` / `modelUsage`. Top-level `usage` leaves children out, so it must never be used as the ledger.
- CLI totals are client-side estimates. The Console / Usage Cost API is authoritative. Credits are prepaid spend, not free spend.
- **Opus long-context tier: unverified.** The brief lists no Opus premium above any prompt size. §3.4 is a sensitivity row in case one exists. Policy: keep Opus contexts at or below ~150k by compacting at phase boundaries.

## 1. What counts against the USD200

The owner wrote "USD200 total". The conservative reading is that ideation spend counts too.

| Line | Amount | Basis |
|---|---|---|
| Ideation sessions (the earlier baseline session plus this one) | **cap $30** (actual: orchestrator receipts) | Each CLI session is capped at $15 including children. The actual figures come from the orchestrator receipts, not this file. |
| Implementation stages P0 to P4 | **$140** in stage caps | §4 |
| Owner-held reserve | **$30** | Released only by an explicit owner decision after a gate report |
| **Total** | **$200** | |

If the receipts show ideation cost less than $30, the difference goes into the owner reserve. It does not go into stage caps automatically.

## 2. Calibration from real usage (this session), not guesses

This ideation session is a small, real sample of the same workload: an Opus 5.5 orchestrator plus 10 native Haiku 5.5 children, each doing bounded read-only audits.

- One completed Haiku audit (whole-SVG consumers) reported `subagent_tokens` 36,172, 55 tool uses and about 177 s. The other audits were similar, with tens of tool calls each. **`subagent_tokens` is the final context size, not billable tokens.** Billable cache reads are roughly turns × average context: 55 × ~22k ≈ 1.2M → $0.012. Add ~60k cache writes → $0.008 and ~25k output including thinking → $0.013. That is about **$0.03 to $0.05 per Haiku audit** (derived, not a receipt).
- The CLI's running estimate for the whole session was about $2.4 when 9 of 10 children had finished. That is a non-authoritative mid-session snapshot; the orchestrator holds the receipt. Haiku children explain roughly $0.3 to $0.5 of it, so **the Opus orchestrator is about 80% of spend**. The biggest Opus parts were cache writes (including a context compaction) and output.
- Lesson for the budget: Haiku spend is small. What costs money is Opus turns × context (cache reads), Opus cache rewrites after compaction or a TTL lapse, and Opus output including thinking. A Haiku packet is only worth delegating if it saves more Opus turns than it costs in Opus review. Each packet costs about 3 to 6 Opus review turns, roughly $0.3 to $0.6 at base context.

## 3. Low, base and high cost math (billable tokens)

Formula per class: `cost = turns × (ctx × cacheRead + write × cacheWrite + uncached × input + out × output)`. "ctx" is the average cached prefix re-read each turn. "write" is the new tokens cached per turn: tool results and file reads, plus amortized compaction rewrites.

### 3.1 Opus 5.5 primaries: contracts, GL core, text, bridge, integration and every gate review

| Case | Turns | ctx (read) | write/turn | uncached/turn | out/turn incl. thinking | Read $ | Write $ (5m) | Input $ | Output $ | **Opus** |
|---|---|---|---|---|---|---|---|---|---|---|
| Low | 600 | 55k | 3k | 0.5k | 2.0k | 33M → 6.6 | 1.8M → 9.0 | 0.3M → 1.2 | 1.2M → 24.0 | **$40.8** |
| Base | 1,100 | 75k | 5k | 1.0k | 2.5k | 82.5M → 16.5 | 5.5M → 27.5 | 1.1M → 4.4 | 2.75M → 55.0 | **$103.4** |
| High | 2,000 | 120k | 9k | 2.0k | 4.0k | 240M → 48.0 | 18M → 90.0 | 4M → 16.0 | 8M → 160.0 | **$314.0** |

- 1h cache writes cost $8 instead of $5. Use them only for the stable ~30k contract and plan prefix in sessions with gaps longer than 5 minutes. Using 1h writes everywhere would add +$16.5 to base and +$54 to high.
- The base case has 1,100 turns over 5 phases. That is about 25 Opus sessions of ~45 turns each, matching the 25 Opus work items in IMPLEMENTATION-BACKLOG.json.

### 3.2 Haiku 5.5 packets: 34 bounded packets (IMPLEMENTATION-BACKLOG.json)

| Case | Turns | ctx | write/turn | uncached | out/turn | Tier | Read $ | Write $ | Input $ | Output $ | **Haiku** |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Low | 34 × 40 = 1,360 | 35k | 2.0k | 0.3k | 1.0k | ≤100k | 47.6M → 0.48 | 2.72M → 0.34 | 0.41M → 0.04 | 1.36M → 0.68 | **$1.54** |
| Base | 34 × 60 × 1.5 rework = 3,060 | 50k | 2.5k | 0.5k | 1.5k | ≤100k | 153M → 1.53 | 7.65M → 0.96 | 1.53M → 0.15 | 4.59M → 2.30 | **$4.94** |
| High, ≤100k share | 4,080 | 80k | 3.0k | 1.0k | 2.0k | ≤100k | 326M → 3.26 | 12.2M → 1.53 | 4.1M → 0.41 | 8.2M → 4.08 | $9.28 |
| High, >100k share (25% of turns breach) | 1,360 | 130k | 3.0k | 1.0k | 2.0k | **>100k** | 177M → 8.84 | 4.1M → 2.55 | 1.4M → 0.68 | 2.7M → 6.80 | $18.87 |
| **High total** | 34 × 80 × 2 = 5,440 | | | | | | | | | | **$28.15** |

The high case shows the long-context premium at work. A quarter of the turns over 100k costs twice as much as the other three quarters. Hence the rule in §6: every packet input stays at or below 60k tokens, and a packet is split rather than allowed to grow.

### 3.3 Totals

| Case | Opus | Haiku | **Implementation total** | vs $140 stage caps | vs $170 (caps + reserve) |
|---|---|---|---|---|---|
| Low | $40.8 | $1.5 | **≈ $42** | fits | fits |
| Base | $103.4 | $4.9 | **≈ $108** | fits, with $32 of headroom | fits |
| High | $314.0 | $28.2 | **≈ $342** | over by 2.4× | over by 2.0×, so a stop-loss fires at a gate |

### 3.4 Sensitivity: Opus long-context tier (UNVERIFIED, hypothetical)

Suppose a tier existed above 200k charging 2× input and cache, and 1.5× output, and 15% of high-case turns crossed it (300 turns at 220k). The extra cost would be about +$13 in reads, +$12 in output and +$2 in input: **about +$27 in the high case**. The base case is unaffected because contexts stay at or below 150k. Mitigation: compact at every phase boundary and keep contracts as a short, stable cached prefix.

### 3.5 Working-token Fermi vs billable usage

- Earlier working-token estimates (OWNER-BRIEF.md:12): GPU viewport 80k to 180k; full-fidelity replacement 250k to 500k+, with about 2× uncertainty. With no functionality loss as a hard criterion, the plan assumes the upper half: **400k to 900k working tokens** of code, tests and docs that survive.
- Billable output in the base case is about 7.3M tokens (Opus 2.75M plus Haiku 4.6M). That is 8 to 18× the working estimate, because thinking, tool JSON, retries and re-reads all bill.
- Billable cache reads in the base case are about 235M tokens, roughly 250 to 600× the working estimate. Even so, reads are only about $18 of the $108, because cache reads are cheap. **The dollars come from Opus output (~51%) and Opus cache writes (~25%).**
- So working-token counts are a poor proxy for dollars. The levers are fewer Opus turns, shorter Opus output, a stable cached prefix, and fewer compactions.

## 4. Staged allocation of the $140 implementation caps

| Stage | Scope (backlog IDs) | Base expect | Opus cap | Haiku cap | **Stage cap** | Exit gate (PROOF-PLAN.md) |
|---|---|---|---|---|---|---|
| P0 Contracts + parity harness | O01–O04, H01–H08 | $14 | $16 | $2 | **$18** | G0: harness green against the current renderer; DOM-attribute census complete; SceneDocument shadow parse passes I1–I6 on the corpus |
| P1 GPU proof slice | O05–O10, H09–H15 | $25 | $30 | $2 | **$32** | G1: performance go/no-go plus hatch, stroke, compat-lane and context-loss checks |
| P2 Full layer + text + editor bridge | O11–O17, H16–H26 | $35 | $42 | $3 | **$45** | G2: parity matrix rows for all layers, text and editors green behind `?renderer=gpu` |
| P3 Whole-SVG consumers + file/export | O18–O21, H27–H31 | $17 | $20 | $2 | **$22** | G3: save/load/export/3D/minimap/transform-preview goldens; the flag default can flip |
| P4 SceneDocument ownership + hardening | O22–O25, H32–H34 | $17 | $21 | $2 | **$23** | G4: gesture and layout coupling removed from the frame path; second GPU family; owner sign-off |
| **Sum** | 25 Opus items, 34 Haiku packets | **$108** | $129 | $11 | **$140** | |

The Haiku caps are about twice the base Haiku estimate because Haiku costs little and the margin keeps a packet from being cut over cents. Opus caps are about 1.25× base.

## 5. Opus integration vs Haiku packets

- **Opus owns** everything that defines or crosses a contract: the SceneDocument schema, the device and camera layers, the frame graph, the compat capture lane, text shaping and layout, the editor bridge (d3.mouse shim, hidden-live model, gesture controller), save, load and export call sites, the `public/main.js` and `layers.js` integration points, and every gate review. There are 25 sequential work items (O01–O25).
- **Haiku owns** leaf work that can be checked mechanically: inventories and censuses, pure functions with tests, layer IR extractors checked against the current SVG output, spec and test authoring (never executed by agents), and docs. There are **34 packets (H01–H34)**.
- **Why 34, not 20 or 40.** The parity matrix has 23 layer and consumer families. About 15 need an extractor or test packet. Text, pick, file and editor utilities add about 12, and harness and docs add about 7. Merging packets to get near 20 would push inputs past 60k and risk the 5× premium. Going past 40 would add Opus review turns (§2) faster than it saves Opus implementation turns.
- Each Haiku packet writes exactly one owned file, plus its test file where listed. No two packets share a file. Open questions go into a per-stage `followup-*.md` file, not into concurrent edits.

## 6. Packet and session rules (cost controls)

1. Every Haiku prompt is at or below 60k input tokens. Above 100k it is aborted and split. That is treated as a process error, not a cost to absorb.
2. Haiku output is a report of 300 words or less plus the owned file. Every child prompt says: *"No Bash/agents/paid API, secrets, production writes; only scoped artifact."* The implementation phases may allow `vitest` execution only if the owner explicitly enables it per stage. Playwright is never auto-run (source/CONTEXT.md:24).
3. Opus sessions: compact at phase boundaries, keep the contracts plus plan prefix at or below ~30k, avoid re-reading large files (`index.html` is about 9k lines; read slices only), and keep output terse.
4. Reconcile spend from the Console or Usage Cost API at every gate, not from CLI estimates.
5. Disable credit auto-reload, or set a workspace spend limit, so billing enforces the ceiling.

## 7. Stop-loss rules

1. **G1 is a hard stop.** If P1 hits its $32 cap without passing the G1 performance thresholds, the GPU track stops. The P0 harness and SceneDocument shadow model are still useful to the SVG track, so P0 spend is not wasted.
2. **Stage overrun.** A stage that reaches 100% of its cap freezes. Opus writes a gate report of one page or less, and the owner decides whether to release reserve. Nothing carries over silently.
3. **Burn-rate tripwire.** If cumulative spend at any gate exceeds 1.3× the base curve ($18 / $51 / $96 / $118 / $140), re-plan before continuing.
4. **Packet failure.** A Haiku packet that fails acceptance twice moves to Opus or is re-scoped. There is no third Haiku attempt.
5. **No feature drop as a cost fix.** If a feature row cannot reach parity inside its stage cap, it falls back to the exact compat capture lane (REWRITE-PLAN §5) and is logged as a performance debt. It is never removed. The only escape hatch is fidelity-preserving.
6. **Never spend to use up the allowance.** Unspent stage budget returns to the owner reserve.

## 8. Corrections to the baseline spending plan

- The baseline left ideation outside the $200. The owner's "total" wording makes counting it the conservative choice, so ideation now has a $30 line (§1).
- The baseline Haiku high case modelled every turn at >100k ($58). The new model makes the breach share explicit (25%) and pushes it toward zero through the 60k packet rule.
- The baseline packet H06 asserted scaleExtent [0.8,20]. The source has `[1,20]` (source/public/main.js:238) and a dynamic minimum (source/public/modules/ui/options.js:213-222). Fixed in the backlog.
- The baseline packet H32 targeted `mcp/src/bridge.js`, which is not in the snapshot (Glob found nothing). It was replaced by a census of map-global consumers (H08).
- The baseline packets H17 and H18 assumed SDF text. The new text strategy is a CPU-shaped Canvas2D glyph atlas with size buckets (REWRITE-PLAN §6), so the SDF EDT packet is gone.
- The baseline G1 had input ≤4 ms and an approximate raster bridge at ≤3 ms. The new G1 uses per-metric thresholds tied to the measured baseline (PROOF-PLAN §3), and the compat lane must be exact, not approximate.
- The baseline staged only 13 Opus items. With no functionality loss, the editor bridge, consumers and SceneDocument ownership phases add 12 more, so the base case is $108 instead of $125. That is lower because the Opus context and output-per-turn assumptions were re-calibrated against this session. Turns went down from 1,200 to 1,100, and cache writes per turn from 6k to 5k.

## 9. Why more agents cannot remove integration risk

The risky parts are shared contracts: the camera and d3.zoom coupling, the SceneDocument and save byte contract, editor reliance on DOM geometry, and the hidden-live model. They live in a few files (`public/main.js`, `layers.js`, `editors.js`, `save.ts`, `load.ts`, `export.ts`), and only one writer can own each at a time. Each extra agent adds an interface and Opus review turns. Verification on real hardware needs the owner's attention, which agents cannot parallelize. So the critical path stays sequential Opus work, and Haiku stays on the leaves.
