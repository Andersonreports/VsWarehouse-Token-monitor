const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const ORG_LABELS_FILE = path.join(DATA_DIR, 'org-labels.json');
const ORG_LICENSES_FILE = path.join(DATA_DIR, 'org-licenses.json');

function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveHistory(history) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const sorted = [...history].sort(
    (a, b) => new Date(a.reportDate) - new Date(b.reportDate)
  );
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(sorted, null, 2));
  return sorted;
}

function upsertReport(report) {
  const history = loadHistory();
  const idx = history.findIndex((r) => r.filename === report.filename);
  if (idx >= 0) history[idx] = report;
  else history.push(report);
  return saveHistory(history);
}

function loadOrgLabels() {
  if (!fs.existsSync(ORG_LABELS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(ORG_LABELS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function loadOrgLicenses() {
  if (!fs.existsSync(ORG_LICENSES_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(ORG_LICENSES_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function licenseInfo(licenseKey, licenses) {
  const entry = licenses[licenseKey];
  if (!entry || !entry.purchaseDate || !entry.termMonths) return null;
  const purchaseDate = new Date(entry.purchaseDate);
  const expiryDate = new Date(purchaseDate);
  expiryDate.setMonth(expiryDate.getMonth() + entry.termMonths);
  return { purchaseDate: purchaseDate.toISOString(), expiryDate: expiryDate.toISOString() };
}

function groupByOrg(history) {
  const labels = loadOrgLabels();
  const licenses = loadOrgLicenses();
  const groups = new Map();
  for (const report of history) {
    const key = report.licenseKey || 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(report);
  }
  return [...groups.entries()]
    .map(([licenseKey, reports]) => {
      const sorted = [...reports].sort((a, b) => new Date(a.reportDate) - new Date(b.reportDate));
      const latest = sorted[sorted.length - 1];
      return {
        licenseKey,
        label: labels[licenseKey] || latest.orgName || licenseKey,
        reports: sorted,
        license: licenseInfo(licenseKey, licenses),
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

module.exports = { loadHistory, saveHistory, upsertReport, loadOrgLabels, groupByOrg, HISTORY_FILE };
