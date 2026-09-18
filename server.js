const fs = require('fs');
const path = require('path');
const express = require('express');
const chokidar = require('chokidar');
const multer = require('multer');

const { parsePdfBuffer } = require('./src/parsePdf');
const { loadHistory, upsertReport, groupByOrg } = require('./src/store');
const { streamReportPdf } = require('./src/generateReport');

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
app.use(express.static(path.join(__dirname, 'public')));

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

app.listen(PORT, async () => {
  console.log(`Token monitor running at http://localhost:${PORT}`);
  await scanReportsDir();

  chokidar
    .watch(REPORTS_DIR, { ignoreInitial: true, awaitWriteFinish: true })
    .on('add', ingestFile)
    .on('change', ingestFile);
});
