// Live-sheet source, shared by any module's Excel Report tab.
// The sheet is a manually maintained upload log (not discrete report snapshots
// like the PDFs), so we reconstruct a report history from its running
// "Pending tokens" balance column.

const CATEGORY_KEYS = ['GENOME', 'EXOME', 'PANEL', 'SUPPORTING'];

function sheetCsvUrl(sheetId) {
  return `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv`;
}

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

function parseNumber(str) {
  if (str == null) return null;
  const cleaned = String(str).replace(/,/g, '').trim();
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Sheet dates are day-first: "7/9/2026" or "13-09-2026" (D-M-YYYY).
function parseSheetDate(str, timeStr) {
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec((str || '').trim());
  if (!m) return null;
  const [, d, mo, y] = m;

  let hour = 0;
  let minute = 0;
  const tm = /^(\d{1,2})[.:](\d{2})\.?\s*(AM|PM)$/i.exec((timeStr || '').trim());
  if (tm) {
    hour = parseInt(tm[1], 10) % 12;
    minute = parseInt(tm[2], 10);
    if (/PM/i.test(tm[3])) hour += 12;
  }

  return new Date(Date.UTC(+y, +mo - 1, +d, hour, minute, 0));
}

// "10/05/2026" in a day-first log is Oct 5 typed month-first. The log is kept
// chronologically, so when the literal reading jumps backwards but the
// day/month swap continues the sequence, the swap is the honest reading.
function dayOf(d) {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function swapDayMonth(str, timeStr) {
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec((str || '').trim());
  if (!m) return null;
  return parseSheetDate(`${m[2]}/${m[1]}/${m[3]}`, timeStr);
}

function categorize(panelText) {
  const t = (panelText || '').trim();
  if (!t) return 'SUPPORTING';
  if (/genome/i.test(t)) return 'GENOME';
  if (/exome/i.test(t)) return 'EXOME';
  return 'PANEL';
}

function findColumn(header, pattern) {
  return header.findIndex((h) => pattern.test(h));
}

// If a header cell's label text gets accidentally cleared in the sheet, fall
// back to the fixed column position the log has always used rather than
// losing that whole field.
const FIXED_POSITIONS = {
  sno: 0,
  date: 1,
  time: 2,
  server: 3,
  workspace: 4,
  panel: 5,
  sampleCount: 6,
  tokenConsumed: 7,
  username: 8,
  uploadedBy: 9,
  pending: 10,
};

async function fetchSheetCsv(sheetId) {
  const res = await fetch(sheetCsvUrl(sheetId));
  if (!res.ok) throw new Error(`Sheet fetch failed (${res.status})`);
  return res.text();
}

function buildReportFromCsv(csvText, { orgName, fallbackTotal } = {}) {
  const rows = parseCsv(csvText);
  if (rows.length === 0) throw new Error('Sheet is empty');

  const header = rows[0];
  const idx = {
    sno: findColumn(header, /^SNo/i),
    date: findColumn(header, /^Date/i),
    time: findColumn(header, /^Time/i),
    server: findColumn(header, /^Server/i),
    workspace: findColumn(header, /^Workspace/i),
    panel: findColumn(header, /^Panel/i),
    sampleCount: findColumn(header, /sample count/i),
    tokenConsumed: findColumn(header, /token consumed/i),
    username: findColumn(header, /^Username/i),
    uploadedBy: findColumn(header, /uploaded by/i),
    pending: findColumn(header, /pending tokens/i),
  };

  // A label cell blanked out in the sheet (e.g. someone typing over the
  // header row) shouldn't take down the whole column — fall back to the
  // position that column has always been at.
  let usedFallbackPosition = false;
  for (const [key, pos] of Object.entries(FIXED_POSITIONS)) {
    if (idx[key] === -1 && pos < header.length) {
      idx[key] = pos;
      usedFallbackPosition = true;
    }
  }

  const pendingHeaderCell = header[idx.pending] || '';
  const totalMatch = /\(([\d,]+)\)/.exec(pendingHeaderCell);
  let tokensTotal = totalMatch ? parseNumber(totalMatch[1]) : null;
  let usedFallbackTotal = false;
  if (tokensTotal == null && fallbackTotal != null) {
    tokensTotal = fallbackTotal;
    usedFallbackTotal = true;
  }
  if (tokensTotal == null) throw new Error('Could not determine total token capacity from sheet header');
  const headerIssue =
    usedFallbackTotal || usedFallbackPosition
      ? "This sheet's header row looks like it was edited (some column labels are missing) — showing best-effort totals. Restore the header row (e.g. \"Pending tokens (N)\") to clear this."
      : null;

  const dataRows = rows.slice(1);
  const parsedRows = [];

  // Entries are often logged before their Date cell is filled in (the newest
  // rows, and "supporting" continuation rows, routinely have a blank date).
  // Dropping those rows silently undercounts consumed tokens, so instead we
  // carry forward the last known date — nudged a minute ahead per blank row so
  // they keep their sheet order and sort after the dated entry they follow.
  let lastDate = null;
  let datelessOffset = 0;
  const dateWarnings = [];
  const SIXTY_DAYS = 60 * 24 * 60 * 60 * 1000;
  const ONE_DAY = 24 * 60 * 60 * 1000;

  // A log can also *open* with undated rows (the CMC sheet does), where there
  // is nothing behind them to carry forward. Find the first real date up front
  // so those rows can be back-filled instead of dropped.
  let firstDate = null;
  for (const r of dataRows) {
    const d = parseSheetDate(r[idx.date], r[idx.time]);
    if (d) {
      firstDate = d;
      break;
    }
  }

  for (const r of dataRows) {
    const username = (r[idx.username] || '').trim();
    const panel = (r[idx.panel] || '').trim();
    const pendingRaw = (r[idx.pending] || '').trim();
    const isReal = username !== '' || panel !== '' || pendingRaw !== '';
    if (!isReal) continue;

    let date = parseSheetDate(r[idx.date], r[idx.time]);
    if (date && lastDate && dayOf(date) < dayOf(lastDate)) {
      const swapped = swapDayMonth(r[idx.date], r[idx.time]);
      // Compare whole days: a swapped date carries no clock time, so against a
      // same-day entry logged at 19:30 it would otherwise look like a step back.
      if (
        swapped &&
        dayOf(swapped) >= dayOf(lastDate) &&
        dayOf(swapped) - dayOf(lastDate) <= SIXTY_DAYS
      ) {
        dateWarnings.push(
          `Row dated "${(r[idx.date] || '').trim()}" reads as ${date
            .toISOString()
            .slice(0, 10)}, which goes backwards in the log — read as ${swapped
            .toISOString()
            .slice(0, 10)} instead (day and month look swapped).`
        );
        date = swapped;
      }
    }
    if (date) {
      lastDate = date;
      datelessOffset = 0;
    } else if (lastDate) {
      datelessOffset += 1;
      date = new Date(lastDate.getTime() + datelessOffset * 60000);
    } else if (firstDate) {
      // Undated rows that open the log: sit them just before the first dated
      // entry, still in sheet order, so their tokens are counted.
      datelessOffset += 1;
      date = new Date(firstDate.getTime() - ONE_DAY + datelessOffset * 60000);
    } else {
      // No usable date anywhere in the sheet.
      continue;
    }

    parsedRows.push({
      sno: r[idx.sno],
      date,
      panel,
      sampleCount: parseNumber(r[idx.sampleCount]) || 1,
      tokensConsumedRow: parseNumber(r[idx.tokenConsumed]) || 0,
      username,
      uploadedBy: (r[idx.uploadedBy] || '').trim(),
      pending: parseNumber(pendingRaw),
      // raw sheet text, kept verbatim for the "sheet log" table
      raw: {
        sno: (r[idx.sno] || '').trim(),
        date: (r[idx.date] || '').trim(),
        time: (r[idx.time] || '').trim(),
        server: (r[idx.server] || '').trim(),
        workspace: (r[idx.workspace] || '').trim(),
        panel,
        sampleCount: (r[idx.sampleCount] || '').trim(),
        tokensConsumed: (r[idx.tokenConsumed] || '').trim(),
        username,
        uploadedBy: (r[idx.uploadedBy] || '').trim(),
        pending: pendingRaw,
      },
    });
  }

  parsedRows.sort((a, b) => a.date - b.date || (a.sno || 0) - (b.sno || 0));

  const categories = Object.fromEntries(CATEGORY_KEYS.map((k) => [k, { count: 0, tokens: 0 }]));
  const samples = [];
  let runningAvailable = tokensTotal;

  const reports = parsedRows.map((row, rowIndex) => {
    const n = Math.max(1, row.sampleCount);
    const base = Math.floor(row.tokensConsumedRow / n);
    const remainder = row.tokensConsumedRow - base * n;
    const cat = categorize(row.panel);

    for (let i = 0; i < n; i++) {
      const tokensForSample = i < remainder ? base + 1 : base;
      samples.push({
        date: row.date.toISOString().slice(0, 19).replace('T', ' '),
        hash: `${row.sno || rowIndex + 1}-${String(i + 1).padStart(2, '0')}`,
        variantCount: null,
        size: cat.charAt(0) + cat.slice(1).toLowerCase(),
      });
      categories[cat].count += 1;
      categories[cat].tokens += tokensForSample;
    }

    runningAvailable = row.pending != null ? row.pending : runningAvailable - row.tokensConsumedRow;
    const tokensAvailable = Math.max(0, Math.min(tokensTotal, runningAvailable));
    const tokensConsumed = tokensTotal - tokensAvailable;

    return {
      filename: `Sheet row #${row.sno || rowIndex + 1}${row.uploadedBy ? ` (${row.uploadedBy})` : ''}`,
      reportDate: row.date.toISOString(),
      orgName: orgName || null,
      withinTier: tokensConsumed <= tokensTotal,
      tokensConsumed,
      tokensTotal,
      tokensAvailable,
      usagePercent: Math.round((tokensConsumed / tokensTotal) * 1000) / 10,
      categories: null,
      samples: [],
    };
  });

  const totalSamples = CATEGORY_KEYS.reduce((sum, k) => sum + categories[k].count, 0);
  const totalTokensCat = CATEGORY_KEYS.reduce((sum, k) => sum + categories[k].tokens, 0);
  categories['TOTAL SAMPLES'] = { count: totalSamples, tokens: totalTokensCat };

  const latest = reports[reports.length - 1];
  if (latest) {
    latest.categories = categories;
    latest.samples = samples;
  }

  const rawRows = parsedRows.map((row) => ({ ...row.raw, sortDate: row.date.toISOString() }));

  return { reports, rawRows, tokensTotal, headerIssue, dateWarnings };
}

const cache = new Map();
const CACHE_MS = 20000;

async function getSheetReports(sheetId, meta = {}) {
  const now = Date.now();
  const cacheKey = `${sheetId}:${meta.fallbackTotal || ''}`;
  const cached = cache.get(cacheKey);
  if (cached && now - cached.at < CACHE_MS) return cached.data;
  const csv = await fetchSheetCsv(sheetId);
  const data = buildReportFromCsv(csv, meta);
  cache.set(cacheKey, { at: now, data });
  return data;
}

module.exports = { getSheetReports, buildReportFromCsv };
