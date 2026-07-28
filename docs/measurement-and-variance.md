# Measurement, variance, and what the leaderboard can actually resolve

Measured against production data on 2026-07-28 (7 standings, 35 runs, 16 tasks).
Every number here comes from `/api/leaderboard` and `/api/runs`; none is estimated.

This started from *"You Don't Need to Run Every Eval"* (BenchPress; Zeng &
Papailiopoulos, Microsoft Research, arXiv 2606.24020), which shows a
model × benchmark score matrix is roughly rank-2, so most cells can be
predicted from a handful of probes.

---

## The framing that turned out to matter

The paper's rows are labelled "models", but nobody benchmarks naked weights —
those scores come from a model *plus* a harness *plus* prompting. So the rows
are already agent configurations, which is exactly what a Harness Arena
standing is. Swapping the model and swapping the system prompt are moves along
the same axis; "respond like a cat" and "you are an expert programmer" differ
more than two frontier models do.

That means the paper's structure claim should transfer. It mostly does — but
measuring it surfaced a bigger problem than the one the paper solves.

---

## 1. The matrix is low-rank here too, but noisier

Variance explained by successive factors of the standings × tasks matrix:

| Factor | Variance | Cumulative |
|---|---:|---:|
| 1 | 65.2% | 65.2% |
| 2 | 21.0% | **86.2%** |
| 3 | 5.8% | 92.0% |

The paper reports >90% at rank 2 across 133 benchmarks. We get 86.2% across 16
tasks. Two caveats, pulling opposite ways: n=7 rows makes this estimate
unstable, and our cells are 3–5 binary trials rather than a score aggregated
over hundreds of items. The gap is most likely noise, not a structural
difference.

## 2. The prompt axis is real but truncated

| Axis | Observed spread |
|---|---:|
| Model (across all standings) | **42.1 points** |
| Prompt (within a fixed model) | **5.9 points** max |

The model axis is **7.1×** the prompt axis. Not because prompts don't matter —
because the low end never gets submitted. Everyone sends a serious prompt and
the fairness judge rejects non-functional ones. We only ever rank the top few
points of a range that in principle spans everything.

## 3. The measurement problem

Repeating the same prompt on the same model:

- within-prompt sd: **0.78 tasks ≈ 4.8 points**
- sd of the 5-run mean: **0.35 tasks ≈ 2.2 points**
- prompt effect we are trying to resolve: **~5 points**

So on the **main arena** (5 runs) signal is about 2× measurement error — thin
but workable. On a **competition entry** (1 run) the error is ~4.8 points
against a ~5 point effect. **Ranking two good prompts on single runs is close
to a coin flip.**

## 4. Cost is the weaker tiebreak, not the stronger one

The competition ranks by tasks solved, then cost. Cost is noisier:

| Signal | Mean coefficient of variation |
|---|---:|
| Tasks passed | **10.6%** |
| Total cost | **14.8%** |

Ranking on cost to escape task-count noise would make things worse, not better.

## 5. One task is dead weight

`query-optimize`: mean pass rate **0.00**, spread **0.00** — nobody has ever
passed it, so it separates nobody. It costs **$0.063 per run**, 3.6% of a
$1.75 run, and buys zero ranking information.

Three more are nearly as weak (everyone passes): `modernize-scientific-stack`,
`nginx-request-logging`, `fix-git` — all ~0.94 mean with ≤0.25 spread.

---

## The two-stage runoff, sized

Proposal: one cheap screening run for everyone, then re-run the top K several
times at close. The shape is right — it is a standard screen-then-confirm
design. The risk is that the true winner is eliminated *during screening*.

Simulated on the measured sd (0.78 tasks), 25 entrants, true best 0.8 tasks
(~5 points) ahead, 20k trials:

| Design | Runs | Cost | Picks the true best |
|---|---:|---:|---:|
| screen 1×, top 5 runoff 5× | 50 | $88 | 35.1% |
| screen 1×, top 8 runoff 5× | 65 | $114 | 38.7% |
| screen 1×, top 5 runoff 10× | 75 | $131 | 40.0% |
| screen 2×, top 5 runoff 5× | 75 | $131 | **41.2%** |
| screen 2×, top 5 runoff 10× | 100 | $175 | 48.0% |
| screen 3×, top 8 runoff 8× | 139 | $243 | 52.7% |

Three conclusions:

1. **Screening depth is worth at least as much as runoff depth, per dollar.**
   At the same $131, two screening runs beats a doubled runoff (41.2% vs
   40.0%). A winner eliminated in round one cannot be recovered by any amount
   of runoff.
2. **Widening K is the cheapest survival buy.** At 10 entrants, K=8 keeps the
   true best 94.4% of the time versus 56.5% at K=3.
3. **No affordable design is reliable at this effect size.** Even at $243 the
   true best wins 52.7% of the time. The problem is not the design; it is that
   a 0.8-task gap sits on top of a 0.78-task standard deviation.

---

## Where to go

Ordered by value per unit of effort.

**Drop `query-optimize`, or fix it.** Free money — 3.6% of every run for zero
information. Decide whether it is too hard (drop) or broken (fix). This is the
only item here that costs nothing to act on.

**Adopt the two-stage runoff, but screen twice and keep K generous.** Two
screening runs and a top-8 cut, rather than one run and a top-3. The evidence
says the cut is where accuracy is won or lost.

**Say what the number can bear.** Given ±2.2 points on a 5-run mean and ±4.8 on
a single run, adjacent standings are frequently not distinguishable. Showing a
confidence interval, or banding statistically-tied entries at the same rank,
would make the board honest rather than falsely precise. The ranking code
already computes ties on exact equality — extending that to a measurement band
is a small change.

**To make the contest genuinely decidable, widen the signal or narrow the
noise.** More tasks reduce noise relative to spread (16 tasks *is* the sample
size for a single score). Tasks with real spread — `sanitize-git-repo`,
`qemu-startup`, `write-compressor` all show 1.00 spread — are worth more than
uniform ones. This is the paper's probe-selection idea pointed at task
curation rather than at skipping evaluation.

**Where the paper's method does apply: triage, not scoring.** Predicting a
score cheaply is fine for telling a submitter "this looks well below the
baseline" before spending a full run. It is not fine for ranking: their MedAE
of 4.63 points is ~0.74 tasks here, larger than the gap between adjacent
ranks, and their own ranking result preserves 92.1% of pairwise orderings only
*with a five-point margin*. With prize money attached, an 8% pairwise error
rate is disqualifying.

---

## Reproducing

```
curl -s $BASE/api/leaderboard   # per-standing per_task pass rates, costs, turns
curl -s $BASE/api/runs          # per-run task_results, for within-prompt variance
```

Every figure above is derived from those two endpoints.
