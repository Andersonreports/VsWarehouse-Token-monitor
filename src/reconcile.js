// Explains *why* the sheet log and the Golden Helix meter disagree, rather
// than just reporting that they do.
//
// Two things make a naive comparison wrong:
//   1. The PDF headline "Tokens Consumed" is all-time, but its category table
//      is windowed ("Last 30 Days"). They only reconcile as
//      headline = tokens before the window + the windowed category total.
//   2. Golden Helix prices by variant count, not by the panel name the lab
//      types. A mito case is logged as "Exome" but bills at 1 token and lands
//      in the meter's PANEL row. So EXOME and PANEL are compared as one
//      bucket — splitting them would flag every mito case as a discrepancy.

const BUCKETS = [
  { key: 'exomePanel', label: 'Exome/mito' },
  { key: 'genome', label: 'Genome' },
  { key: 'supporting', label: 'Supporting' },
];

function num(v) {
  const n = parseInt(String(v == null ? '' : v).replace(/,/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

function empty() {
  return { count: 0, tokens: 0 };
}

function meterBuckets(categories = {}) {
  const pick = (k) => categories[k] || empty();
  const exome = pick('EXOME');
  const panel = pick('PANEL');
  return {
    exomePanel: { count: exome.count + panel.count, tokens: exome.tokens + panel.tokens },
    genome: { ...pick('GENOME') },
    supporting: { ...pick('SUPPORTING') },
  };
}

function bucketFor(panelText) {
  const p = (panelText || '').toLowerCase();
  if (p.includes('genome')) return 'genome';
  if (p.includes('support')) return 'supporting';
  return 'exomePanel';
}

function sheetBuckets(rawRows, start, end) {
  const buckets = { exomePanel: empty(), genome: empty(), supporting: empty() };
  let tokensOutsideWindow = 0;
  for (const r of rawRows || []) {
    const day = String(r.sortDate || '').slice(0, 10);
    const tokens = num(r.tokensConsumed);
    if (!day || day < start || day > end) {
      tokensOutsideWindow += tokens;
      continue;
    }
    const b = buckets[bucketFor(r.panel)];
    b.count += num(r.sampleCount);
    b.tokens += tokens;
  }
  return { buckets, tokensOutsideWindow };
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function describe(label, dCount, dTokens) {
  // Samples and tokens drifting in opposite directions can't be a plain
  // missing row — the panel label in the sheet disagrees with how Golden Helix
  // classified those samples, so say that instead of inventing a token count.
  if (dCount !== 0 && dTokens !== 0 && Math.sign(dCount) !== Math.sign(dTokens)) {
    const more = dCount > 0 ? 'meter' : 'sheet';
    return {
      kind: 'mismatch',
      text: `${label}: the ${more} has ${Math.abs(dCount)} more ${
        Math.abs(dCount) === 1 ? 'sample' : 'samples'
      }, yet the ${more === 'meter' ? 'sheet' : 'meter'} carries ${Math.abs(
        dTokens
      )} more tokens.`,
      hint: `The panel named in the sheet doesn't match how Golden Helix sized these samples — it prices by variant count, not by the label.`,
    };
  }
  if (dCount > 0) {
    return {
      kind: 'unlogged',
      text: `${plural(dCount, `${label} sample`)} billed on the meter ${
        dCount === 1 ? 'is' : 'are'
      } not in the sheet log (${dTokens} tokens).`,
      hint: 'A sample was processed on the server but never written down.',
    };
  }
  if (dCount < 0) {
    return {
      kind: 'unbilled',
      text: `${plural(-dCount, `${label} sample`)} in the sheet log ${
        dCount === -1 ? 'was' : 'were'
      } never billed by the meter (${-dTokens} tokens).`,
      hint: 'Points at a failed or abandoned upload rather than a missed entry.',
    };
  }
  // Same samples, different tokens — a pricing difference, not a missing row.
  if (dTokens > 0) {
    return {
      kind: 'rate',
      text: `${label} sample counts match, but the meter charged ${dTokens} more tokens than the sheet records.`,
      hint: 'A mito discount (1 token) was applied in the sheet where the meter charged the full rate.',
    };
  }
  return {
    kind: 'rate',
    text: `${label} sample counts match, but the sheet records ${-dTokens} more tokens than the meter charged.`,
    hint: 'Likely mito cases — they bill at 1 token but were logged at the full Exome rate of 3.',
  };
}

function totals(buckets) {
  return BUCKETS.reduce(
    (acc, { key }) => ({
      count: acc.count + buckets[key].count,
      tokens: acc.tokens + buckets[key].tokens,
    }),
    { count: 0, tokens: 0 }
  );
}

/**
 * @param {object} report  latest parsed PDF (the meter)
 * @param {Array}  rawRows sheet rows from parseSheet
 */
function reconcile(report, rawRows) {
  if (!report || !report.windowStart || !report.windowEnd) return null;
  const meter = meterBuckets(report.categories);
  const meterTotals = totals(meter);
  if (meterTotals.count === 0) return null;

  const { buckets: sheet, tokensOutsideWindow } = sheetBuckets(
    rawRows,
    report.windowStart,
    report.windowEnd
  );
  const sheetTotals = totals(sheet);

  const findings = [];
  for (const { key, label } of BUCKETS) {
    const dCount = meter[key].count - sheet[key].count;
    const dTokens = meter[key].tokens - sheet[key].tokens;
    if (dCount === 0 && dTokens === 0) continue;
    findings.push({ bucket: label, ...describe(label, dCount, dTokens) });
  }

  // Everything before the window has to agree too, or the window comparison is
  // sitting on top of an older, invisible discrepancy.
  const meterBeforeWindow =
    report.tokensConsumed != null ? report.tokensConsumed - meterTotals.tokens : null;
  if (meterBeforeWindow != null && meterBeforeWindow !== tokensOutsideWindow) {
    const d = meterBeforeWindow - tokensOutsideWindow;
    findings.push({
      bucket: 'Before window',
      kind: d > 0 ? 'unlogged' : 'unbilled',
      text: `Entries before ${report.windowStart} differ by ${Math.abs(d)} tokens.`,
      hint: 'The gap predates this report, so the sample-level breakdown above cannot see it.',
    });
  }

  return {
    window: { start: report.windowStart, end: report.windowEnd, days: report.windowDays || null },
    meter: { ...meter, total: meterTotals, allTime: report.tokensConsumed ?? null },
    sheet: { ...sheet, total: sheetTotals },
    findings,
    reconciled: findings.length === 0,
  };
}

module.exports = { reconcile };
