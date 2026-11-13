const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
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

const { buildOrg, saveModuleCsv, parseUsageCsv } = require('./src/usage');
const { streamReportPdf } = require('./src/generateReport');
const { getSheetReports } = require('./src/parseSheet');
const { reconcile } = require('./src/reconcile');

// Each module pairs one license (a Golden Helix "usage by size" CSV — the token
// meter) with one live Google Sheet (the Excel report). The CSV carries no
// license key, so the module page it's uploaded from decides which license and
// token cap it belongs to.
const MODULES = {
  cmc: {
    label: 'Anderson CMC System',
    orgName: 'Anderson Diagnostics & Labs (Shivasanmuganatha)',
    licenseKey: 'S-f5de82-61948b-619091-caca6e',
    tokensTotal: 6000,
    sheetId: '1Qd_wFFydbtwOhpcx8flnHGAiTQ4z--bDmOUlX8TTVUQ',
    // Header row's "Pending tokens (N)" label has been getting overwritten in
    // this sheet; used only if the header itself can't tell us the total.
    sheetTokensTotalFallback: 6000,
  },
  ngs: {
    label: 'NGS Server System',
    orgName: 'Anderson Diagnostics & Labs (Honguntikar)',
    licenseKey: 'S-36f034-ff93dd-206acc-ccab28',
    tokensTotal: 6000,
    sheetId: '1Ncd7T2ajE2WafSFO82anQJiHsdot3HKPEpAU_yF0zmk',
    sheetTokensTotalFallback: 6000,
  },
};

const PORT = process.env.PORT || 4173;

function buildAllOrgs() {
  return Object.entries(MODULES)
    .map(([id, mod]) => buildOrg(id, mod))
    .filter(Boolean)
    .sort((a, b) => a.label.localeCompare(b.label));
}

// License keys are used server-side only for grouping and must never reach the
// client.
function sanitizeOrg(org) {
  if (!org) return org;
  const { licenseKey, label, reports, license } = org;
  return {
    label,
    license,
    reports: reports.map(({ licenseKey: _lk, ...rest }) => rest),
  };
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok =
      file.mimetype === 'text/csv' ||
      file.mimetype === 'application/vnd.ms-excel' ||
      file.mimetype === 'application/csv' ||
      file.originalname.toLowerCase().endsWith('.csv');
    cb(null, ok);
  },
});

const app = express();
app.use(
  express.static(path.join(__dirname, 'public'), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
  })
);

app.get('/api/modules', (req, res) => {
  res.json(
    Object.entries(MODULES).map(([id, m]) => ({
      id,
      label: m.label,
      sheetUrl: `https://docs.google.com/spreadsheets/d/${m.sheetId}/edit?usp=sharing`,
    }))
  );
});

app.get('/api/orgs', (req, res) => {
  res.json(buildAllOrgs().map(sanitizeOrg));
});

app.get('/api/orgs/:moduleId', (req, res) => {
  const mod = MODULES[req.params.moduleId];
  if (!mod) return res.status(404).json({ error: 'Unknown module.' });
  const org = buildOrg(req.params.moduleId, mod);
  if (!org) return res.status(404).json({ error: 'No CSV uploaded for this module yet.' });
  res.json(sanitizeOrg(org));
});

// Upload a usage CSV for one module. ?m=<moduleId> says which license it is.
app.post('/api/upload', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err || !req.file) {
      return res.status(400).json({ error: err?.message || 'Only CSV files are accepted.' });
    }
    const moduleId = req.query.m;
    const mod = MODULES[moduleId];
    if (!mod) return res.status(400).json({ error: 'Unknown or missing module (?m=...).' });

    const text = req.file.buffer.toString('utf8');
    try {
      const parsed = parseUsageCsv(text);
      if (!parsed.days.length) {
        return res.status(400).json({ error: 'No dated rows found in the CSV.' });
      }
    } catch (e) {
      return res.status(400).json({ error: `Could not read CSV: ${e.message}` });
    }

    saveModuleCsv(moduleId, req.file.buffer);
    console.log(`Ingested CSV for ${mod.label} (${req.file.originalname})`);
    res.json(sanitizeOrg(buildOrg(moduleId, mod)));
  });
});

app.get('/api/sheet/:moduleId', async (req, res) => {
  const mod = MODULES[req.params.moduleId];
  if (!mod) return res.status(404).json({ error: 'Unknown module.' });

  try {
    const { reports, rawRows, headerIssue, dateWarnings } = await getSheetReports(mod.sheetId, {
      orgName: mod.orgName,
      fallbackTotal: mod.sheetTokensTotalFallback,
    });
    const org = buildOrg(req.params.moduleId, mod);
    // Reconcile the log against the latest CSV snapshot, which is the license
    // meter for the full period it covers.
    const latest = org && org.reports.length ? org.reports[org.reports.length - 1] : null;
    res.json({
      label: mod.label,
      license: org?.license || null,
      reports,
      rawRows,
      headerIssue: headerIssue || null,
      dateWarnings: dateWarnings || [],
      reconciliation: latest ? reconcile(latest, rawRows) : null,
      meterSource: latest ? { filename: latest.filename, reportDate: latest.reportDate } : null,
    });
  } catch (err) {
    res.status(502).json({ error: `Failed to load live sheet: ${err.message}` });
  }
});

app.get('/api/report', (req, res) => {
  const allOrgs = buildAllOrgs().map(sanitizeOrg);

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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Token monitor running at http://localhost:${PORT}`);
  for (const addr of lanAddresses()) {
    console.log(`  also on your LAN at http://${addr}:${PORT}`);
  }
});
