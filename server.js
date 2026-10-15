const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const chokidar = require('chokidar');
const multer = require('multer');

function lanAddresses() {
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const ifaceList of Object.values(nets)) {
    for (const iface of ifaceList || []) {
      if (iface.family === 'IPv4' && !iface.internal) addrs.push(iface.address);
    }
  }
  return addrs;
}

const { parsePdfBuffer } = require('./src/parsePdf');
const { loadHistory, upsertReport, deleteReport, groupByOrg } = require('./src/store');
const { streamReportPdf } = require('./src/generateReport');
const { getSheetReports } = require('./src/parseSheet');
const { reconcile } = require('./src/reconcile');

// Each module pairs one license (PDF reports) with one live Google Sheet (Excel report).
const MODULES = {
  cmc: {
    label: 'Anderson CMC System',
    orgName: 'Anderson Diagnostics & Labs (Shivasanmuganatha)',
    sheetId: '1Qd_wFFydbtwOhpcx8flnHGAiTQ4z--bDmOUlX8TTVUQ',
    // Header row's "Pending tokens (N)" label has been getting overwritten in
    // this sheet; used only if the header itself can't tell us the total.
    sheetTokensTotalFallback: 6000,
  },
  ngs: {
    label: 'NGS Server System',
    orgName: 'Anderson Diagnostics & Labs (Honguntikar)',
    sheetId: '1Ncd7T2ajE2WafSFO82anQJiHsdot3HKPEpAU_yF0zmk',
    sheetTokensTotalFallback: 6000,
  },
};

const REPORTS_DIR = path.join(__dirname, 'reports');
const PORT = process.env.PORT || 4173;

fs.mkdirSync(REPORTS_DIR, { recursive: true });

async function ingestFile(filePath) {
  const filename = path.basename(filePath);
  if (!filename.toLowerCase().endsWith('.pdf')) return;
  try {
    const buffer = fs.readFileSync(filePath);
    const report = await parsePdfBuffer(buffer, filename);
    upsertReport(report);
    console.log(`Ingested ${filename} (${report.tokensConsumed}/${report.tokensTotal} tokens)`);
  } catch (err) {
    console.error(`Failed to parse ${filename}:`, err.message);
  }
}

async function scanReportsDir() {
  const files = fs.readdirSync(REPORTS_DIR).filter((f) => f.toLowerCase().endsWith('.pdf'));
  for (const f of files) {
    await ingestFile(path.join(REPORTS_DIR, f));
  }
}

const upload = multer({
  storage: multer.diskStorage({
    destination: REPORTS_DIR,
    filename: (req, file, cb) => {
      const safeName = path.basename(file.originalname).replace(/[^A-Za-z0-9._-]/g, '_');
      let target = safeName;
      let n = 1;
      while (fs.existsSync(path.join(REPORTS_DIR, target))) {
        const ext = path.extname(safeName);
        target = `${safeName.slice(0, -ext.length)}-${n}${ext}`;
        n++;
      }
      cb(null, target);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype === 'application/pdf'),
});

const app = express();
app.use(
  express.static(path.join(__dirname, 'public'), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
  })
);

// License keys are used server-side only for grouping and must never reach the client.
function sanitizeOrgs(orgs) {
  return orgs.map(({ licenseKey, label, reports, license }) => ({
    label,
    license,
    reports: reports.map(({ licenseKey: _lk, ...rest }) => rest),
  }));
}

app.get('/api/orgs', (req, res) => {
  res.json(sanitizeOrgs(groupByOrg(loadHistory())));
});

app.get('/api/orgs/:moduleId', (req, res) => {
  const mod = MODULES[req.params.moduleId];
  if (!mod) return res.status(404).json({ error: 'Unknown module.' });
  const org = sanitizeOrgs(groupByOrg(loadHistory())).find((o) => o.label === mod.label);
  if (!org) return res.status(404).json({ error: 'No PDF reports ingested for this module yet.' });
  res.json(org);
});

app.post('/api/rescan', async (req, res) => {
  await scanReportsDir();
  res.json(sanitizeOrgs(groupByOrg(loadHistory())));
});

app.post('/api/upload', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err || !req.file) {
      return res.status(400).json({ error: err?.message || 'Only PDF files are accepted.' });
    }
    await ingestFile(req.file.path);
    res.json(sanitizeOrgs(groupByOrg(loadHistory())));
  });
});

app.delete('/api/reports/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(REPORTS_DIR, filename);
  if (path.dirname(filePath) !== REPORTS_DIR) {
    return res.status(400).json({ error: 'Invalid filename.' });
  }

  const removed = deleteReport(filename);
  if (!removed) return res.status(404).json({ error: 'No such report in history.' });

  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  res.json(sanitizeOrgs(groupByOrg(loadHistory())));
});

app.get('/api/modules', (req, res) => {
  res.json(
    Object.entries(MODULES).map(([id, m]) => ({
      id,
      label: m.label,
      sheetUrl: `https://docs.google.com/spreadsheets/d/${m.sheetId}/edit?usp=sharing`,
    }))
  );
});

app.get('/api/sheet/:moduleId', async (req, res) => {
  const mod = MODULES[req.params.moduleId];
  if (!mod) return res.status(404).json({ error: 'Unknown module.' });

  try {
    const { reports, rawRows, headerIssue, dateWarnings } = await getSheetReports(mod.sheetId, {
      orgName: mod.orgName,
      fallbackTotal: mod.sheetTokensTotalFallback,
    });
    const org = sanitizeOrgs(groupByOrg(loadHistory())).find((o) => o.label === mod.label);
    // Reconcile the log against the most recent PDF, which is the license meter.
    const latestPdf = org && org.reports.length ? org.reports[org.reports.length - 1] : null;
    res.json({
      label: mod.label,
      license: org?.license || null,
      reports,
      rawRows,
      headerIssue: headerIssue || null,
      dateWarnings: dateWarnings || [],
      reconciliation: latestPdf ? reconcile(latestPdf, rawRows) : null,
      meterSource: latestPdf
        ? { filename: latestPdf.filename, reportDate: latestPdf.reportDate }
        : null,
    });
  } catch (err) {
    res.status(502).json({ error: `Failed to load live sheet: ${err.message}` });
  }
});

app.get('/api/report', (req, res) => {
  const allOrgs = sanitizeOrgs(groupByOrg(loadHistory()));

  let selected;
  let scopeLabel;
  let slugSource;

  if (req.query.orgs) {
    const wanted = Array.isArray(req.query.orgs) ? req.query.orgs : [req.query.orgs];
    selected = allOrgs.filter((o) => wanted.includes(o.label));
    scopeLabel = wanted.join(', ');
    slugSource = wanted.join('-');
  } else {
    const scope = req.query.scope || 'all';
    selected = scope === 'all' ? allOrgs : allOrgs.filter((o) => o.label === scope);
    scopeLabel = scope === 'all' ? undefined : scope;
    slugSource = scope === 'all' ? 'all-orgs' : scope;
  }

  if (selected.length === 0) {
    return res.status(404).send('No report data available for that scope.');
  }

  const slug = slugSource.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const today = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="token-report-${slug}-${today}.pdf"`);

  streamReportPdf(res, selected, { scopeLabel });
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Token monitor running at http://localhost:${PORT}`);
  for (const addr of lanAddresses()) {
    console.log(`  also on your LAN at http://${addr}:${PORT}`);
  }
  await scanReportsDir();

  chokidar
    .watch(REPORTS_DIR, { ignoreInitial: true, awaitWriteFinish: true })
    .on('add', ingestFile)
    .on('change', ingestFile);
});
