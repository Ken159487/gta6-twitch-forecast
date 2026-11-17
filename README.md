# GTA VI Twitch CCU forecast — make.fun `gta6-twitch-ccu-forecast-01`

Forecasts how many people watch Grand Theft Auto VI live on Twitch in each
hour of its release day (2026-11-19 UTC), as five quantiles per hour, from
the first hour's print and the launch-day curves of past big game launches.

## Run

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads every `<id>.in` in the input directory and writes `<id>.out`:
`{"hours": [{"hour": 2, "q": [q05, q25, q50, q75, q95]}, …]}` (23 rows,
hours 2–24). Node 22+, standard library only, no network, deterministic.

## Method (log space)

For each past launch in the case's `comparables`, its release-day curve is
written as log-ratios to its own hour-1 print, `r(h) = ln y(h) − ln y(1)`.
The forecast is the target's hour-1 print `p1` times a ratio curve:

`q_τ(h) = p1 · exp(Q_τ(h))`, where `Q_τ(h)` is the τ-quantile of the
ratio distribution at hour `h`.

Weighting of the reference launches:

- **Hour-1 size (the main signal).** How far a launch-day curve climbs
  depends on how much of the world was already unlocked at hour 1: a big
  hour-1 print means the curve stays flat, a small one means it climbs
  several-fold (practice launches: hour-1 23k → peak 9.1×, 117k → 3.2×,
  119k → 2.2×, 270k → 1.7×). Each comparable is weighted by a Gaussian
  kernel on `|ln(hour-1) − ln(p1)|`, bandwidth 1.0 in log units.
- **Unlock pattern / tier (mild priors, from each launch's own note).**
  Simultaneous-global launches keep full weight — tuning found the
  hour-1 kernel already separates the regimes. Unclassified patterns 0.5,
  early-access-contaminated 0.4, "weak" 0.3. Early access flattens the
  release-day curve because the audience was already playing.

Quantiles: at each hour the centre is the weighted median log-ratio and
the spread is a robust scale (weighted IQR / 1.349), smoothed over
neighbouring hours. Reported quantiles blend a normal approximation
(centre + z_τ · spread) with the weighted empirical quantiles of the
ratios, which keeps the right tail honest when the ratio distribution is
skewed. Pinball loss on the log scale is a proper scoring rule for
quantiles (Koenker & Bassett 1978; Gneiting & Raftery 2007), so the
forecast reports the quantiles it believes.

The program uses only the case file: hour-1 print + comparables. It does
not use `streams` or `categories_hourly` (null in the practice cases, so
any use of them would be untestable). If a case carries no usable
comparables it falls back to the house persistence shape, so it always
writes a valid forecast.

## Local validation

Scored with the competition's own pinball loss on the log scale
(`dev/eval.mjs`, outside this repository). Practice answers are the
public SullyGnome hourly counts for the four practice launches (the
source the kit's NOTICE names), verified against the case files
(hour-1 and history match exactly).

| | this entry | house baseline |
|---|---|---|
| Practice mean loss (p00–p03) | **0.211** | 0.387 |
| Practice, per case | p00 0.338, p01 0.168, p02 0.142, p03 0.195 | p00 0.744, p01 0.287, p02 0.215, p03 0.303 |
| Leave-one-out over 37 comparables | **0.402** | 0.930 |
| Leave-one-out, rolling-midnight only (30) | **0.360** | 0.784 |

Hyperparameters were tuned on leave-one-out scoring (bandwidth, spread,
blend, tier weights); a second kernel on hour-1 channels was tested and
rejected — it hurt leave-one-out (0.391 rolling vs 0.360).

Known limits: simultaneous-global launches are the worst case
(Black Myth: Wukong 1.83 in leave-one-out — a 02:00 UTC unlock spike no
hour-1 print can foresee). GTA VI unlocks at rolling local midnight, the
regime the model is built for, so this failure mode should not apply to
the final — but the final is one launch, and a single launch can always
surprise: the 5–95% band is the honest statement of that uncertainty.

## Files

- `main.ts` — the entry (Node 22, standard library only)
- `LICENSE` — MIT (from the kit's starter)
