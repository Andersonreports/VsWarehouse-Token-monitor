// Golden Helix "Usage by Size" CSV is the token meter (replaces the old PDF).
//
// Shape: one row per calendar day, columns are per-size *sample counts*:
//
//   Category,"Genome Samples (...) (5)","Exome Samples (...) (700)",...
//   2026-09-07,0,1,0,0
//   2026-09-09,0,4,0,0
//
// The first column holds the date (its header is literally "Category"); the
// remaining columns are counts for Genome / Exome / Panel / Supporting, and
// each column header carries that size's all-time total in parentheses.
//
// The CSV has no token column, so tokens are derived from counts using Golden
// Helix's per-size rate. These rates come straight from the clean meter data
// (Exome 270 samples -> 810 tokens = 3; Panel 1:1; Genome 2 -> 12 = 6).
// Supporting samples bill at 1; re-analysing a sample within 30 days is free,
// so a derived total can run a few tokens above the meter — close enough for a
// usage dashboard, and the rates are overridable per module.

const fs = require('fs');
const path = require('path');
const { loadOrgLicenses, licenseInfo } = require('./store');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CATS = ['GENOME', 'EXOME', 'PANEL', 'SUPPORTING'];
const SIZE_LABEL = { GENOME: 'Genome', EXOME: 'Exome', PANEL: 'Panel', SUPPORTING: 'Supporting' };
const DEFAULT_RATES = { GENOME: 6, EXOME: 3, PANEL: 1, SUPPORTING: 1 };

function csvPath(moduleId) {
  return path.join(DATA_DIR, `${moduleId}-usage.csv`);
}

function hasModuleCsv(moduleId) {
  return fs.existsSync(csvPath(moduleId));
}

function saveModuleCsv(moduleId, buffer) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(csvPath(moduleId), buffer);
}

// Minimal RFC-4180-ish parser: handles quoted fields and \r\n, drops blank rows.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

// Map a column header to a category by keyword, so the exact header text
// ("Exome Samples (5K-1.5M variants) (700)") doesn't have to be hard-coded.
function categoryForHeader(header) {
  const h = String(header || '').toLowerCase();
  if (h.includes('genome')) return 'GENOME';
  if (h.includes('exome')) return 'EXOME';
  if (h.includes('panel')) return 'PANEL';
  if (h.includes('support')) return 'SUPPORTING';
  return null;
}

/**
 * Parse the usage-by-size CSV text into an ordered list of day rows.
 * @returns {{ days: Array<{date:string, counts:Object}>, firstDate:string|null, lastDate:string|null }}
 */
function parseUsageCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return { days: [], firstDate: null, lastDate: null };

  const header = rows[0];
  const colCat = header.map(categoryForHeader);
  if (!colCat.some((k) => k)) {
    throw new Error('CSV has no Genome/Exome/Panel/Supporting columns — is this a "usage by size" export?');
  }

  const days = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const date = (r[0] || '').trim();
    // Skip any non-date row (stray totals line, blank, etc.).
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const counts = { GENOME: 0, EXOME: 0, PANEL: 0, SUPPORTING: 0 };
    for (let c = 1; c < r.length; c++) {
      const key = colCat[c];
      if (!key) continue;
      const n = parseInt(String(r[c] || '').replace(/,/g, ''), 10);
      if (Number.isFinite(n)) counts[key] += n;
    }
    days.push({ date, counts });
  }
  days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return {
    days,
    firstDate: days.length ? days[0].date : null,
    lastDate: days.length ? days[days.length - 1].date : null,
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * Build an org object (same shape the dashboard already consumes) from a
 * module's stored CSV. `org.reports` is a per-day cumulative series: each day
 * is a snapshot of tokens consumed so far, so the trend, burn rate and stats
 * all work off daily data. The latest snapshot also carries every synthesised
 * sample and the full-period category totals used for reconciliation.
 *
 * @param {string} moduleId
 * @param {object} mod  { label, orgName, licenseKey, tokensTotal, rates? }
 * @returns {object|null} null when the module has no CSV yet
 */
function buildOrg(moduleId, mod) {
  if (!hasModuleCsv(moduleId)) return null;
  const text = fs.readFileSync(csvPath(moduleId), 'utf8');
  const { days, firstDate, lastDate } = parseUsageCsv(text);
  const rates = { ...DEFAULT_RATES, ...(mod.rates || {}) };
  const licenses = loadOrgLicenses();

  const cum = {
    GENOME: { count: 0, tokens: 0 },
    EXOME: { count: 0, tokens: 0 },
    PANEL: { count: 0, tokens: 0 },
    SUPPORTING: { count: 0, tokens: 0 },
  };
  const allSamples = [];
  const reports = [];

  for (const day of days) {
    for (const key of CATS) {
      const c = day.counts[key] || 0;
      cum[key].count += c;
      cum[key].tokens += c * rates[key];
      for (let i = 0; i < c; i++) {
        allSamples.push({ date: `${day.date} 00:00:00`, hash: '', variantCount: null, size: SIZE_LABEL[key] });
      }
    }

    const categories = {};
    let totalCount = 0;
    let totalTokens = 0;
    for (const key of CATS) {
      categories[key] = { count: cum[key].count, tokens: cum[key].tokens };
      totalCount += cum[key].count;
      totalTokens += cum[key].tokens;
    }
    categories['TOTAL SAMPLES'] = { count: totalCount, tokens: totalTokens };

    const tokensTotal = mod.tokensTotal;
    const tokensConsumed = totalTokens;
    const tokensAvailable = tokensTotal != null ? tokensTotal - tokensConsumed : null;

    reports.push({
      filename: `${moduleId}-usage.csv`,
      reportDate: new Date(`${day.date}T00:00:00Z`).toISOString(),
      orgName: mod.orgName,
      licenseKey: mod.licenseKey,
      withinTier: tokensTotal != null ? tokensConsumed <= tokensTotal : true,
      tokensConsumed,
      tokensTotal: tokensTotal != null ? tokensTotal : null,
      tokensAvailable,
      usagePercent: tokensTotal ? round1((tokensConsumed / tokensTotal) * 100) : null,
      categories,
      // Only the latest snapshot needs the full sample list (breakdown views).
      samples: [],
      dailyCounts: { ...day.counts, TOTAL: CATS.reduce((s, k) => s + (day.counts[k] || 0), 0) },
      // Full-period window so reconciliation covers the whole CSV, not a
      // rolling 30 days like the old PDF meter did.
      windowStart: firstDate,
      windowEnd: day.date,
      windowDays: null,
    });
  }

  if (reports.length) {
    reports[reports.length - 1].samples = allSamples;
  }

  return {
    licenseKey: mod.licenseKey,
    label: mod.label,
    reports,
    license: licenseInfo(mod.licenseKey, licenses),
  };
}

module.exports = {
  parseUsageCsv,
  buildOrg,
  hasModuleCsv,
  saveModuleCsv,
  csvPath,
  DEFAULT_RATES,
};
