const pdf = require('pdf-parse');

const CATEGORY_KEYS = ['GENOME', 'EXOME', 'PANEL', 'SUPPORTING'];

function parseNumber(str) {
  return parseInt(String(str).replace(/,/g, ''), 10);
}

function parsePdfDate(pdfDate) {
  // Format: D:20260910053514+00'00'
  const m = /^D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(pdfDate || '');
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)).toISOString();
}

function parseFilenameDate(filename) {
  // tokenstatus_D_M_YYYY.pdf (day_month_year)
  const m = /tokenstatus_(\d{1,2})_(\d{1,2})_(\d{4})/.exec(filename);
  if (!m) return null;
  const [, d, mo, y] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d)).toISOString();
}

async function parsePdfBuffer(buffer, filename) {
  const data = await pdf(buffer);
  const text = data.text.replace(/\r\n/g, '\n');

  const orgMatch = /Usage Report - (.+)/.exec(text);
  const orgName = orgMatch ? orgMatch[1].trim() : null;

  const licenseMatch = /License Key:\s*\n?\s*([A-Za-z0-9-]+)/.exec(text);
  const licenseKey = licenseMatch ? licenseMatch[1].trim() : null;

  const withinTier = /✓\s*Within Usage Tier/.test(text);
  const overTier = /Over Usage Tier|Usage Tier Exceeded/i.test(text);

  const tokensMatch = /Tokens Consumed:\s*([\d,]+)\s*\/\s*([\d,]+)\s*\(([\d.]+)%\)/.exec(text);
  const tokensConsumed = tokensMatch ? parseNumber(tokensMatch[1]) : null;
  const tokensTotal = tokensMatch ? parseNumber(tokensMatch[2]) : null;
  const usagePercent = tokensMatch ? parseFloat(tokensMatch[3]) : null;
  const tokensAvailable =
    tokensTotal != null && tokensConsumed != null ? tokensTotal - tokensConsumed : null;

  const categories = {};
  const categoryRe = /(GENOME|EXOME|PANEL|SUPPORTING|TOTAL SAMPLES)\n(\d+)\n(\d+) tokens/g;
  let cm;
  while ((cm = categoryRe.exec(text))) {
    const [, label, count, tokens] = cm;
    categories[label] = { count: parseNumber(count), tokens: parseNumber(tokens) };
  }
  for (const key of CATEGORY_KEYS) {
    if (!categories[key]) categories[key] = { count: 0, tokens: 0 };
  }

  const samples = [];
  // Supporting samples (Father/Mother/Normal) carry a role suffix on the hash,
  // e.g. "79b0485329b413e1:R" — without the optional suffix here they fall out
  // of the sample table entirely.
  const sampleRe =
    /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})([0-9a-f]{16}(?::[A-Za-z])?)(\d+)(Genome|Exome|Panel|Supporting)/g;
  let sm;
  while ((sm = sampleRe.exec(text))) {
    const [, date, hash, variantCount, size] = sm;
    samples.push({ date, hash, variantCount: parseNumber(variantCount), size });
  }

  const reportDate = parsePdfDate(data.info && data.info.CreationDate) || parseFilenameDate(filename);

  // The headline "Tokens Consumed" is all-time, but the category table is
  // scoped to a window ("Last 30 Days") — they only reconcile once we know it.
  // Golden Helix puts the exact range in the download filename; otherwise fall
  // back to counting back from the report date.
  const range = /start_date_(\d{4}-\d{2}-\d{2})_end_date_(\d{4}-\d{2}-\d{2})/.exec(filename || '');
  const daysMatch = /Last (\d+) Days/.exec(text);
  const windowDays = daysMatch ? parseNumber(daysMatch[1]) : null;
  let windowStart = range ? range[1] : null;
  let windowEnd = range ? range[2] : null;
  if (!windowStart && windowDays != null && reportDate) {
    const end = new Date(reportDate);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - windowDays);
    windowStart = start.toISOString().slice(0, 10);
    windowEnd = end.toISOString().slice(0, 10);
  }

  return {
    filename,
    reportDate,
    orgName,
    licenseKey,
    withinTier: overTier ? false : withinTier,
    tokensConsumed,
    tokensTotal,
    tokensAvailable,
    usagePercent,
    categories,
    samples,
    windowDays,
    windowStart,
    windowEnd,
  };
}

module.exports = { parsePdfBuffer };
