const PDFDocument = require('pdfkit');

const COLORS = {
  text: '#0b0b0b',
  muted: '#6b6a66',
  border: '#c7c6bf',
  headerBg: '#e7eaf0',
  accent: '#184f95',
};

const FONT = {
  regular: 'Helvetica',
  bold: 'Helvetica-Bold',
};

const SIZE = {
  title: 21,
  meta: 9.5,
  section: 15,
  subhead: 11,
  body: 10,
  table: 9.5,
  note: 8.5,
  footer: 8,
};

const MARGIN = { top: 52, bottom: 52, left: 45, right: 45 };

const CATS = [
  { key: 'GENOME', label: 'Genome' },
  { key: 'EXOME', label: 'Exome' },
  { key: 'PANEL', label: 'Panel' },
  { key: 'SUPPORTING', label: 'Supporting' },
];

const fmtInt = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
const fmtPct = (n) => (n == null ? '—' : `${n}%`);
const fmtDate = (iso) =>
  iso
    ? new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : '—';
const fmtDateTime = (iso) =>
  iso
    ? new Date(iso).toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
const deltaText = (n) => (n > 0 ? `+${fmtInt(n)}` : fmtInt(n));

function contentWidth(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function resetCursor(doc) {
  doc.x = doc.page.margins.left;
}

function ensureSpace(doc, needed) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + needed > bottom) {
    doc.addPage();
    resetCursor(doc);
    return true;
  }
  return false;
}

function sectionHeading(doc, text) {
  ensureSpace(doc, 40);
  resetCursor(doc);
  doc
    .font(FONT.bold)
    .fontSize(SIZE.section)
    .fillColor(COLORS.text)
    .text(text, doc.page.margins.left, doc.y, { width: contentWidth(doc) });
  const y = doc.y + 3;
  doc
    .moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.width - doc.page.margins.right, y)
    .strokeColor(COLORS.accent)
    .lineWidth(1.5)
    .stroke();
  doc.y = y + 14;
  resetCursor(doc);
}

function subheading(doc, text) {
  ensureSpace(doc, 28);
  resetCursor(doc);
  doc
    .font(FONT.bold)
    .fontSize(SIZE.subhead)
    .fillColor(COLORS.text)
    .text(text, doc.page.margins.left, doc.y, { width: contentWidth(doc) });
  doc.y += 6;
  resetCursor(doc);
}

function bodyText(doc, text, { color = COLORS.muted, size = SIZE.body } = {}) {
  resetCursor(doc);
  doc
    .font(FONT.regular)
    .fontSize(size)
    .fillColor(color)
    .text(text, doc.page.margins.left, doc.y, { width: contentWidth(doc) });
  doc.y += 10;
  resetCursor(doc);
}

function note(doc, text) {
  resetCursor(doc);
  doc
    .font(FONT.regular)
    .fontSize(SIZE.note)
    .fillColor(COLORS.muted)
    .text(text, doc.page.margins.left, doc.y, { width: contentWidth(doc) });
  doc.y += 16;
  resetCursor(doc);
}

// A fully gridded table: every cell gets its own hairline border, so header
// and body rows line up into a clean, uniform grid regardless of page breaks.
// Cell text and the table block itself are both centered on the page.
function drawTable(doc, { headers, rows, colWidths }) {
  const tableWidth = colWidths.reduce((a, b) => a + b, 0);
  const x0 = doc.page.margins.left + Math.max(0, (contentWidth(doc) - tableWidth) / 2);
  const pad = 6;
  const align = () => 'center';

  function measure(cells, bold) {
    doc.font(bold ? FONT.bold : FONT.regular).fontSize(SIZE.table);
    return (
      Math.max(
        ...cells.map((c, i) => doc.heightOfString(String(c ?? ''), { width: colWidths[i] - pad * 2 }))
      ) +
      pad * 2
    );
  }

  function paint(cells, h, { bold = false, fill = null } = {}) {
    const y = doc.y;
    let cx = x0;
    cells.forEach((cell, i) => {
      const w = colWidths[i];
      if (fill) doc.rect(cx, y, w, h).fill(fill);
      doc.rect(cx, y, w, h).lineWidth(0.75).strokeColor(COLORS.border).stroke();
      doc
        .font(bold ? FONT.bold : FONT.regular)
        .fontSize(SIZE.table)
        .fillColor(COLORS.text)
        .text(String(cell ?? ''), cx + pad, y + pad, { width: w - pad * 2, align: align(i) });
      cx += w;
    });
    doc.y = y + h;
    resetCursor(doc);
  }

  function drawHeader() {
    const h = measure(headers, true);
    ensureSpace(doc, h);
    paint(headers, h, { bold: true, fill: COLORS.headerBg });
  }

  drawHeader();
  rows.forEach((row) => {
    const h = measure(row, false);
    if (ensureSpace(doc, h)) drawHeader();
    paint(row, h);
  });

  resetCursor(doc);
  doc.y += 14;
}

function renderCombinedSummary(doc, orgs) {
  sectionHeading(doc, 'Combined summary — all organizations');
  const latests = orgs.map((o) => o.reports[o.reports.length - 1]);
  const totalAvailable = latests.reduce((s, r) => s + (r.tokensAvailable || 0), 0);
  const totalConsumed = latests.reduce((s, r) => s + (r.tokensConsumed || 0), 0);
  const totalCap = latests.reduce((s, r) => s + (r.tokensTotal || 0), 0);
  const pct = totalCap > 0 ? `${((totalConsumed / totalCap) * 100).toFixed(1)}%` : '—';

  drawTable(doc, {
    headers: ['Organization', 'Available', 'Consumed', 'Total', 'Usage', 'As of'],
    aligns: ['left', 'right', 'right', 'right', 'right', 'left'],
    rows: [
      ...orgs.map((o) => {
        const r = o.reports[o.reports.length - 1];
        return [
          o.label,
          fmtInt(r.tokensAvailable),
          fmtInt(r.tokensConsumed),
          fmtInt(r.tokensTotal),
          fmtPct(r.usagePercent),
          fmtDate(r.reportDate),
        ];
      }),
      ['All organizations', fmtInt(totalAvailable), fmtInt(totalConsumed), fmtInt(totalCap), pct, ''],
    ],
    colWidths: [140, 75, 75, 65, 60, 85],
  });
}

function renderOrgSection(doc, org) {
  const reports = org.reports;
  const latest = reports[reports.length - 1];
  const prev = reports.length > 1 ? reports[reports.length - 2] : null;

  sectionHeading(doc, org.label);
  bodyText(
    doc,
    `Report date: ${fmtDate(latest.reportDate)}     ·     Status: ${
      latest.withinTier ? 'Within usage tier' : 'Over usage tier'
    }`,
    { size: SIZE.meta }
  );
  doc.y += 4;

  subheading(doc, 'Token availability');
  drawTable(doc, {
    headers: ['Available', 'Consumed', 'Total', 'Usage'],
    aligns: ['right', 'right', 'right', 'right'],
    rows: [
      [
        fmtInt(latest.tokensAvailable),
        fmtInt(latest.tokensConsumed),
        fmtInt(latest.tokensTotal),
        fmtPct(latest.usagePercent),
      ],
    ],
    colWidths: [125, 125, 125, 125],
  });
  if (prev) {
    note(
      doc,
      `Change since the ${fmtDate(prev.reportDate)} report: ${deltaText(
        latest.tokensConsumed - prev.tokensConsumed
      )} tokens consumed, ${deltaText(latest.tokensAvailable - prev.tokensAvailable)} available.`
    );
  }

  subheading(doc, 'Category breakdown');
  const catRows = CATS.map((c) => {
    const d = latest.categories?.[c.key] || { count: 0, tokens: 0 };
    return [c.label, fmtInt(d.count), fmtInt(d.tokens)];
  });
  const totalD = latest.categories?.['TOTAL SAMPLES'] || { count: 0, tokens: 0 };
  catRows.push(['Total', fmtInt(totalD.count), fmtInt(totalD.tokens)]);
  drawTable(doc, {
    headers: ['Category', 'Samples', 'Tokens'],
    aligns: ['left', 'right', 'right'],
    rows: catRows,
    colWidths: [200, 150, 150],
  });

  subheading(doc, `Sample detail — ${fmtDate(latest.reportDate)} report`);
  const samples = [...(latest.samples || [])].sort((a, b) => new Date(b.date) - new Date(a.date));
  if (samples.length) {
    const sampleRows = samples.map((s) => {
      const catData = latest.categories?.[(s.size || '').toUpperCase()];
      const perSample = catData && catData.count ? catData.tokens / catData.count : null;
      return [
        s.date,
        s.hash,
        fmtInt(s.variantCount),
        s.size,
        perSample != null ? `~${Math.round(perSample * 10) / 10}` : '—',
      ];
    });
    drawTable(doc, {
      headers: ['Date & time', 'Sample hash', 'Variant count', 'Category', 'Est. tokens'],
      aligns: ['left', 'left', 'right', 'left', 'right'],
      rows: sampleRows,
      colWidths: [105, 120, 90, 80, 80],
    });
    note(
      doc,
      'Est. tokens = this report’s category token total ÷ category sample count. The source license report does not itemize cost per individual sample.'
    );
  } else {
    note(doc, 'No samples recorded in the latest report.');
  }

  if (reports.length > 1) {
    subheading(doc, 'Report history');
    const histRows = [...reports]
      .reverse()
      .map((r) => [
        fmtDate(r.reportDate),
        fmtInt(r.tokensConsumed),
        fmtInt(r.tokensTotal),
        fmtInt(r.tokensAvailable),
        fmtPct(r.usagePercent),
        r.filename,
      ]);
    drawTable(doc, {
      headers: ['Report date', 'Consumed', 'Total', 'Available', 'Usage', 'Source file'],
      aligns: ['left', 'right', 'right', 'right', 'right', 'left'],
      rows: histRows,
      colWidths: [90, 75, 70, 80, 65, 125],
    });
  }
}

function streamReportPdf(res, orgs, { scopeLabel } = {}) {
  const doc = new PDFDocument({
    size: 'A4',
    margins: MARGIN,
    bufferPages: true,
    info: { Title: 'VSWarehouse Token Usage Report' },
  });

  doc.pipe(res);

  doc
    .font(FONT.bold)
    .fontSize(SIZE.title)
    .fillColor(COLORS.text)
    .text('VSWarehouse Token Usage Report', doc.page.margins.left, doc.y, {
      width: contentWidth(doc),
      align: 'center',
    });
  doc.y += 4;
  resetCursor(doc);
  doc
    .font(FONT.regular)
    .fontSize(SIZE.meta)
    .fillColor(COLORS.muted)
    .text(`Generated ${fmtDateTime(new Date().toISOString())}`, doc.page.margins.left, doc.y, {
      width: contentWidth(doc),
      align: 'center',
    });
  doc.y += 2;
  resetCursor(doc);
  doc.text(
    `Scope: ${scopeLabel || (orgs.length > 1 ? `All organizations (${orgs.length})` : orgs[0]?.label || 'No data')}`,
    doc.page.margins.left,
    doc.y,
    { width: contentWidth(doc), align: 'center' }
  );
  doc.y += 10;
  const ruleY = doc.y;
  doc
    .moveTo(doc.page.margins.left, ruleY)
    .lineTo(doc.page.width - doc.page.margins.right, ruleY)
    .strokeColor(COLORS.border)
    .lineWidth(1)
    .stroke();
  doc.y = ruleY + 22;
  resetCursor(doc);

  if (orgs.length === 0) {
    doc.font(FONT.regular).fontSize(SIZE.body + 1).fillColor(COLORS.text).text('No reports have been ingested yet.');
  } else {
    if (orgs.length > 1) {
      renderCombinedSummary(doc, orgs);
      doc.addPage();
      resetCursor(doc);
    }
    orgs.forEach((org, idx) => {
      if (idx > 0) {
        doc.addPage();
        resetCursor(doc);
      }
      renderOrgSection(doc, org);
    });
  }

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Writing inside the bottom margin would otherwise make pdfkit auto-add a
    // trailing blank page, even with an absolute y position.
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc
      .font(FONT.regular)
      .fontSize(SIZE.footer)
      .fillColor(COLORS.muted)
      .text(
        `VSWarehouse Token Monitor · Page ${i + 1} of ${range.count}`,
        doc.page.margins.left,
        doc.page.height - 30,
        {
          width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
          align: 'center',
          lineBreak: false,
        }
      );
    doc.page.margins.bottom = savedBottom;
  }

  doc.end();
}

module.exports = { streamReportPdf };
