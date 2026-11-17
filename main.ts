// gta6-twitch-ccu-forecast-01 entry: forecast GTA VI's launch-day Twitch viewers,
// hour by hour, from the first hour's print and the launch-day curves of past
// big game launches shipped in the case file.
//
// Method (log space, per forecast hour h = 2..24):
//   Every past launch in the case's `comparables` has a full release-day curve.
//   For launch j, write its curve as log-ratios to its own hour-1 print,
//   r_j(h) = ln(y_j(h)) - ln(y_j(1)). The forecast for the target case is
//   its hour-1 print p1 times a ratio curve, q_tau(h) = p1 * exp(Q_tau(h)),
//   where Q_tau(h) is the tau-quantile of the ratio distribution at hour h.
//
//   Two facts from the data drive the weighting:
//   (a) Launch-day curves split by unlock pattern. A rolling-midnight launch
//       (consoles unlock at local midnight, the US hours later) starts small
//       at 00:00 UTC and climbs into the evening; a simultaneous global
//       unlock spikes at its unlock hour instead. GTA VI unlocks at rolling
//       local midnight (stated in the competition rules). Tuning on
//       leave-one-out scoring nevertheless found that downweighting
//       simultaneous launches hurts: the hour-1-size kernel below already
//       separates the regimes, and their evening peaks still inform the
//       diurnal shape, so they keep full weight. Only unclassified patterns
//       (0.5), early-access-contaminated (0.4) and "weak" comparables (0.3)
//       are downweighted, from their own unlock notes.
//   (b) Within one unlock pattern, how far the curve climbs depends on how
//       much of the world was already unlocked at hour 1: a big hour-1 print
//       means the curve stays flat, a small one means it climbs several-fold
//       (the four practice launches: hour-1 23k -> peak 9.1x, 117k -> 3.2x,
//       119k -> 2.2x, 270k -> 1.7x). So each comparable is also weighted by
//       a Gaussian kernel on |ln(hour-1_j) - ln(p1)|.
//   Early-access-contaminated and "weak" comparables (flagged in their own
//   unlock notes) are downweighted: early access flattens the release-day
//   curve because the audience was already playing.
//
//   Quantiles: at each hour, the centre is the weighted median log-ratio and
//   the spread is a robust scale (weighted IQR / 1.349) of the log-ratios,
//   smoothed over neighbouring hours. The reported quantiles blend a
//   normal approximation (centre + z_tau * spread) with the weighted
//   empirical quantiles of the ratios, which keeps the right tail honest
//   when the ratio distribution is skewed (a few launches climb 100x+).
//   Pinball loss on the log scale is a proper scoring rule for quantiles
//   (Koenker & Bassett 1978; Gneiting & Raftery 2007), so the forecast
//   reports the quantiles it believes, not a hedged point estimate.
//
//   The program is deterministic (no randomness, no clock, no network) and
//   reads only the case file it is given. If the case carries no usable
//   comparables it falls back to the house persistence baseline shape, so
//   it always writes a valid forecast.
//
// Run locally: mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

// ---- Tuned constants (chosen on leave-one-out scoring over the 37 usable
// ---- comparables in the kit's practice cases; see dev/eval.mjs). ----
/** Bandwidth (natural-log units) of the Gaussian kernel on hour-1 size. */
const BW = 1.0;
/** Multiplier on the robust spread before turning it into quantiles. */
const SPREAD = 1.0;
/** Blend of normal-approx quantiles (0) and weighted empirical quantiles (1). */
const BLEND = 0.5;
/** Smooth the centre and spread curves over neighbouring hours (3-point). */
const SMOOTH = true;
/** Prior weight of a simultaneous-global-unlock comparable (vs 1.0 rolling).
 *  Tuning found no benefit in downweighting them (1.0 tested best): the
 *  hour-1-size kernel already separates the regimes, and their evening
 *  peaks still inform the diurnal shape. Kept as a named constant so the
 *  choice is explicit and re-tunable. */
const W_SIMULTANEOUS = 1.0;
/** Prior weight of a comparable whose unlock pattern is not classified. */
const W_OTHER = 0.5;
/** Multiplier for early-access-contaminated comparables. */
const W_CONTAMINATED = 0.4;
/** Multiplier for "weak" comparables. */
const W_WEAK = 0.3;
/** Floor / cap on the robust log-spread, to avoid absurdly narrow/wide bands. */
const SIGMA_MIN = 0.1;
const SIGMA_MAX = 1.6;

interface Comparable {
  name: string;
  day_start: string;
  unlock?: string;
  hourly: Array<{ from: string; viewers: number; channels?: number | null }>;
}

interface Case {
  id: string;
  levels: number[];
  known: Array<{ hour: number; viewers: number }>;
  forecast: Array<{ hour: number }>;
  comparables: Comparable[];
}

/** One usable reference curve: log-ratios to its own hour-1 print. */
interface RefCurve {
  name: string;
  logH1: number;
  weight: number;
  /** log-ratio for hours 2..24, indexed 0..22 (hour h -> index h - 2). */
  logRatios: number[];
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Weighted quantile of values (weights need not sum to 1); linear interpolation. */
function weightedQuantile(values: number[], weights: number[], tau: number): number {
  const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b] || a - b);
  let total = 0;
  for (const w of weights) total += w;
  if (total <= 0) return values[order[0]];
  const target = tau * total;
  let cum = 0;
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    const prev = cum;
    cum += weights[i];
    if (cum >= target) {
      if (k === 0 || cum === prev) return values[i];
      // Interpolate between this point and the previous one.
      const frac = (target - prev) / (cum - prev);
      return values[order[k - 1]] + frac * (values[i] - values[order[k - 1]]);
    }
  }
  return values[order[order.length - 1]];
}

/** Classify a comparable's unlock pattern from its own research note. */
function unlockKind(unlock: string | undefined): 'rolling' | 'simultaneous' | 'other' {
  const t = (unlock ?? '').toLowerCase();
  if (t.includes('simultaneous') || t.includes('single global')) return 'simultaneous';
  if (t.includes('rolling') || t.includes('midnight local')) return 'rolling';
  return 'other';
}

function tierOf(unlock: string | undefined): string {
  const m = (unlock ?? '').match(/Tier:\s*([^.;]+)/i);
  return m ? m[1].trim().toLowerCase() : '';
}

/** Build the usable reference curves from a case's comparables. */
function referenceCurves(comps: Comparable[]): RefCurve[] {
  const curves: RefCurve[] = [];
  for (const comp of comps) {
    const dayStart = Date.parse(comp.day_start);
    if (Number.isNaN(dayStart)) continue;
    const byHour = new Map<number, number>();
    for (const p of comp.hourly ?? []) {
      const t = Date.parse(p.from);
      if (Number.isNaN(t) || typeof p.viewers !== 'number' || p.viewers <= 0) continue;
      const h = Math.round((t - dayStart) / 3_600_000);
      if (h >= 0 && h < 24 && !byHour.has(h)) byHour.set(h, p.viewers);
    }
    const h1 = byHour.get(0);
    if (h1 === undefined || h1 <= 0) continue; // no launch-day hour 1 (e.g. pre-launch history)
    // Need a complete curve: every release-day hour present (a missing hour
    // fails the loop below, so partial curves are excluded, not partially used).
    if (byHour.size < 20) continue;
    const logRatios: number[] = [];
    let ok = true;
    for (let h = 1; h < 24; h++) {
      const v = byHour.get(h);
      if (v === undefined) {
        ok = false;
        break;
      }
      logRatios.push(Math.log(v) - Math.log(h1));
    }
    if (!ok) continue;
    const kind = unlockKind(comp.unlock);
    const tier = tierOf(comp.unlock);
    let prior = kind === 'rolling' ? 1.0 : kind === 'simultaneous' ? W_SIMULTANEOUS : W_OTHER;
    if (tier.includes('early-access')) prior *= W_CONTAMINATED;
    if (tier.includes('weak')) prior *= W_WEAK;
    curves.push({ name: comp.name, logH1: Math.log(h1), weight: prior, logRatios });
  }
  return curves;
}

/** 3-point centred moving average (edges repeat), for smoothing across hours. */
function smooth3(xs: number[]): number[] {
  return xs.map((x, i) => {
    const a = xs[Math.max(0, i - 1)];
    const b = xs[Math.min(xs.length - 1, i + 1)];
    return (a + x + b) / 3;
  });
}

/**
 * Forecast one case. Returns the 23 rows for hours 2..24.
 * Falls back to the persistence shape when there are no usable comparables.
 */
function forecastCase(c: Case): Array<{ hour: number; q: number[] }> {
  const first = c.known.find((k) => k.hour === 1);
  const p1 = Math.max(1, first?.viewers ?? 1);
  const logP1 = Math.log(p1);
  const curves = referenceCurves(c.comparables ?? []);
  const hours = c.forecast.map((f) => f.hour).sort((a, b) => a - b);

  if (curves.length === 0) {
    // No reference curves: persistence baseline shape (never crash, always valid).
    return hours.map((h) => ({
      hour: h,
      q: Z.map((z) => round2(p1 * Math.exp(z * 0.15 * Math.sqrt(h - 1)))),
    }));
  }

  // Per-hour centre (weighted median log-ratio) and robust spread.
  const centres: number[] = [];
  const sigmas: number[] = [];
  const empirical: number[][] = []; // empirical quantiles per hour, in log space
  for (let idx = 0; idx < 23; idx++) {
    const values = curves.map((cu) => cu.logRatios[idx]);
    const weights = curves.map(
      (cu) => cu.weight * Math.exp(-((cu.logH1 - logP1) ** 2) / (2 * BW * BW)),
    );
    const med = weightedQuantile(values, weights, 0.5);
    const q25 = weightedQuantile(values, weights, 0.25);
    const q75 = weightedQuantile(values, weights, 0.75);
    const sigma = clamp((q75 - q25) / 1.349, SIGMA_MIN, SIGMA_MAX);
    centres.push(med);
    sigmas.push(sigma);
    empirical.push(LEVELS.map((tau) => weightedQuantile(values, weights, tau)));
  }
  const centresS = SMOOTH ? smooth3(centres) : centres;
  const sigmasS = SMOOTH ? smooth3(sigmas) : sigmas;
  const empiricalS = SMOOTH
    ? LEVELS.map((_, j) => smooth3(empirical.map((row) => row[j])))
    : LEVELS.map((_, j) => empirical.map((row) => row[j]));

  return hours.map((h) => {
    const idx = h - 2;
    const m = centresS[idx];
    const s = sigmasS[idx] * SPREAD;
    const qs = LEVELS.map((_, j) => {
      const normal = m + Z[j] * s;
      const emp = empiricalS[j][idx];
      const blended = (1 - BLEND) * normal + BLEND * emp;
      return round2(clamp(p1 * Math.exp(blended), 0.01, 1e9));
    });
    // Enforce non-decreasing quantiles after rounding/clamping.
    for (let j = 1; j < qs.length; j++) qs[j] = Math.max(qs[j], qs[j - 1]);
    return { hour: h, q: qs };
  });
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  const hours = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
}
