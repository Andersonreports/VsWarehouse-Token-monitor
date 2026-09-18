const CAT_ORDER = [
  { key: 'GENOME', label: 'Genome', varName: '--series-1' },
  { key: 'EXOME', label: 'Exome', varName: '--series-2' },
  { key: 'PANEL', label: 'Panel', varName: '--series-3' },
  { key: 'SUPPORTING', label: 'Supporting', varName: '--series-4' },
];

const fmtInt = (n) => (n == null ? '—' : n.toLocaleString('en-US'));
const fmtPct = (n) => (n == null ? '—' : `${n}%`);

function fmtDate(iso, opts) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(
    'en-US',
    opts || { year: 'numeric', month: 'short', day: 'numeric' }
  );
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

async function fetchOrgs() {
  const res = await fetch('/api/orgs');
  return res.json();
}

let selectedOrgLabel = null;
let currentOrgData = null;
let selectedMonth = 'all';

function monthKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function renderMonthOptions(sorted) {
  const select = document.getElementById('month-filter');
  const keys = [...new Set(sorted.map((r) => monthKey(r.reportDate)))].sort().reverse();
  select.innerHTML =
    '<option value="all">All time</option>' +
    keys.map((k) => `<option value="${k}">${monthLabel(k)}</option>`).join('');
  selectedMonth = keys.includes(selectedMonth) ? selectedMonth : 'all';
  select.value = selectedMonth;
}

function renderHistoryViews() {
  if (!currentOrgData) return;
  const sorted = currentOrgData.reports;
  const filtered =
    selectedMonth === 'all' ? sorted : sorted.filter((r) => monthKey(r.reportDate) === selectedMonth);
  renderTrend(filtered);
  renderReportsTable(filtered);
}

document.getElementById('month-filter').addEventListener('change', (e) => {
  selectedMonth = e.target.value;
  renderHistoryViews();
});

function renderTabs(orgs) {
  const tabBar = document.getElementById('org-tabs');
  tabBar.innerHTML = '';
  tabBar.hidden = orgs.length < 2;
  for (const org of orgs) {
    const btn = document.createElement('button');
    btn.className = 'org-tab' + (org.label === selectedOrgLabel ? ' active' : '');
    btn.textContent = org.label;
    btn.addEventListener('click', () => {
      selectedOrgLabel = org.label;
      localStorage.setItem('token-monitor-org', org.label);
      renderOrg(org);
      renderTabs(orgs);
    });
    tabBar.appendChild(btn);
  }
}

function renderHeader(orgLabel, latest) {
  document.getElementById('org-name').textContent = orgLabel || 'VSWarehouse license';

  const badge = document.getElementById('tier-badge');
  badge.hidden = false;
  if (latest.withinTier) {
    badge.className = 'badge good';
    badge.innerHTML =
      '<svg viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3 3 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Within usage tier';
  } else {
    badge.className = 'badge critical';
    badge.innerHTML =
      '<svg viewBox="0 0 16 16" fill="none"><path d="M8 4v5M8 11.5h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Over usage tier';
  }
}

function renderDelta(elId, delta, { goodDirection } = {}) {
  const el = document.getElementById(elId);
  if (delta == null || delta === 0) {
    el.textContent = delta === 0 ? 'No change since last report' : '';
    el.className = 'stat-delta flat';
    return;
  }
  const arrow = delta > 0 ? '▲' : '▼';
  const sign = delta > 0 ? '+' : '';
  const isGood = goodDirection === (delta > 0 ? 'up' : 'down');
  el.textContent = `${arrow} ${sign}${fmtInt(delta)} since last report`;
  el.className = `stat-delta ${isGood ? 'down' : 'up'}`;
}

function renderStats(latest, prev) {
  document.getElementById('stat-available').textContent = fmtInt(latest.tokensAvailable);
  document.getElementById('stat-available-sub').textContent = `as of ${fmtDate(latest.reportDate)}`;
  document.getElementById('stat-consumed').textContent = fmtInt(latest.tokensConsumed);
  document.getElementById('stat-total').textContent = fmtInt(latest.tokensTotal);
  document.getElementById('stat-usage').textContent = fmtPct(latest.usagePercent);
  document.getElementById('stat-usage-sub').textContent = `${fmtInt(latest.tokensConsumed)} / ${fmtInt(
    latest.tokensTotal
  )} tokens`;

  if (prev) {
    renderDelta('stat-consumed-delta', latest.tokensConsumed - prev.tokensConsumed, {
      goodDirection: 'down',
    });
  } else {
    document.getElementById('stat-consumed-delta').textContent = '';
  }

  const meterFill = document.getElementById('usage-meter-fill');
  const pct = Math.max(0, Math.min(100, latest.usagePercent || 0));
  const len = meterFill.getTotalLength();
  meterFill.style.strokeDasharray = `${len}`;
  meterFill.style.strokeDashoffset = `${len * (1 - pct / 100)}`;
  meterFill.classList.toggle('warn', pct >= 80);
}

function renderLicenseValidity(license) {
  if (!license) return '';
  const expiry = new Date(license.expiryDate);
  const daysLeft = Math.round((expiry - Date.now()) / 86400000);
  const warn = daysLeft < 30;
  return `
    <div class="burn-metric ${warn ? 'warn' : 'good'}">
      <div class="bm-label">Days remaining</div>
      <div class="bm-value">~${Math.max(0, daysLeft).toLocaleString('en-US')}</div>
    </div>
    <div class="burn-metric ${warn ? 'warn' : 'good'}">
      <div class="bm-label">License valid until</div>
      <div class="bm-value">${fmtDate(license.expiryDate)}</div>
    </div>
  `;
}

function renderBurnRate(reports, license) {
  const el = document.getElementById('burn-content');
  const licenseHtml = renderLicenseValidity(license);

  if (reports.length < 2) {
    el.innerHTML = `<div class="burn-empty">
      <span>Only one report ingested so far. Add another report for this org and the burn rate, days remaining, and a projected exhaustion date will appear here automatically.</span>
    </div>${licenseHtml ? `<div class="burn-grid">${licenseHtml}</div>` : ''}`;
    return;
  }

  const prev = reports[reports.length - 2];
  const latest = reports[reports.length - 1];
  const deltaTokens = latest.tokensConsumed - prev.tokensConsumed;
  const deltaDays = (new Date(latest.reportDate) - new Date(prev.reportDate)) / 86400000;

  if (deltaDays <= 0) {
    el.innerHTML = `<div class="burn-empty"><span>Reports must be at least a day apart to estimate a burn rate.</span></div>${
      licenseHtml ? `<div class="burn-grid">${licenseHtml}</div>` : ''
    }`;
    return;
  }

  const rate = deltaTokens / deltaDays;

  if (rate <= 0) {
    el.innerHTML = `<div class="burn-empty">
      <span>No net tokens consumed between ${fmtDate(prev.reportDate)} and ${fmtDate(
      latest.reportDate
    )} — usage is flat, so available tokens aren't projected to run out.</span>
    </div>${licenseHtml ? `<div class="burn-grid">${licenseHtml}</div>` : ''}`;
    return;
  }

  const availDelta = latest.tokensAvailable - prev.tokensAvailable;
  const availArrow = availDelta > 0 ? '▲' : availDelta < 0 ? '▼' : '';
  const availSign = availDelta > 0 ? '+' : '';

  el.innerHTML = `
    <div class="burn-grid">
      <div class="burn-metric ${availDelta < 0 ? 'warn' : 'good'}">
        <div class="bm-label">Since last report</div>
        <div class="bm-value">${availArrow} ${availSign}${fmtInt(availDelta)}</div>
      </div>
      <div class="burn-metric">
        <div class="bm-label">Burn rate</div>
        <div class="bm-value">${rate.toFixed(1)} / day</div>
      </div>
      ${licenseHtml}
    </div>
    <div class="burn-note">Based on ${fmtInt(deltaTokens)} tokens consumed over ${deltaDays.toFixed(
    1
  )} days, between the ${fmtDate(prev.reportDate)} and ${fmtDate(latest.reportDate)} reports.</div>
  `;
}

function renderTrend(history) {
  const svg = document.getElementById('trend-svg');
  const tooltip = document.getElementById('trend-tooltip');
  const sub = document.getElementById('trend-sub');
  svg.innerHTML = '';

  if (history.length === 0) return;

  sub.textContent =
    history.length === 1
      ? 'Only one report ingested so far — add more to see a trend.'
      : `${history.length} reports, ${fmtDate(history[0].reportDate)} → ${fmtDate(
          history[history.length - 1].reportDate
        )}`;

  const W = 900,
    H = 220,
    padL = 46,
    padR = 16,
    padT = 16,
    padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const latestTotal = history[history.length - 1].tokensTotal || 0;
  const maxVal = Math.max(latestTotal, ...history.map((h) => h.tokensConsumed || 0)) || 1;

  const times = history.map((h) => new Date(h.reportDate).getTime());
  const minT = Math.min(...times);
  const maxT = Math.max(...times);
  const spanT = maxT - minT || 1;

  const xFor = (t, i) =>
    history.length === 1 ? padL + innerW / 2 : padL + ((t - minT) / spanT) * innerW;
  const yFor = (v) => padT + innerH - (v / maxVal) * innerH;

  const ns = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs) => {
    const n = document.createElementNS(ns, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  };

  const defs = el('defs', {});
  const gradient = el('linearGradient', { id: 'trend-gradient', x1: 0, y1: 0, x2: 0, y2: 1 });
  const stop1 = el('stop', { offset: '0%', 'stop-color': cssVar('--series-1'), 'stop-opacity': 0.28 });
  const stop2 = el('stop', { offset: '100%', 'stop-color': cssVar('--series-1'), 'stop-opacity': 0.02 });
  gradient.appendChild(stop1);
  gradient.appendChild(stop2);
  defs.appendChild(gradient);
  svg.appendChild(defs);

  // gridlines + y labels
  const steps = 4;
  for (let s = 0; s <= steps; s++) {
    const v = (maxVal / steps) * s;
    const y = yFor(v);
    svg.appendChild(el('line', { class: 'grid-line', x1: padL, x2: W - padR, y1: y, y2: y }));
    const label = el('text', { class: 'axis-label', x: padL - 8, y: y + 3, 'text-anchor': 'end' });
    label.textContent = Math.round(v).toLocaleString('en-US');
    svg.appendChild(label);
  }

  // reference line at latest total (capacity)
  const refY = yFor(latestTotal);
  svg.appendChild(
    el('line', { class: 'ref-line', x1: padL, x2: W - padR, y1: refY, y2: refY })
  );
  const refLabel = el('text', { class: 'ref-label', x: W - padR, y: refY - 5, 'text-anchor': 'end' });
  refLabel.textContent = `Total: ${latestTotal.toLocaleString('en-US')}`;
  svg.appendChild(refLabel);

  // points
  const pts = history.map((h, i) => ({
    x: xFor(new Date(h.reportDate).getTime(), i),
    y: yFor(h.tokensConsumed || 0),
    h,
  }));

  if (pts.length > 1) {
    const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
    const areaPath = `${linePath} L${pts[pts.length - 1].x},${yFor(0)} L${pts[0].x},${yFor(0)} Z`;
    svg.appendChild(el('path', { class: 'trend-area', d: areaPath }));
    svg.appendChild(el('path', { class: 'trend-line', d: linePath }));
  }

  // x-axis date labels (thin out if many, and never let two labels overlap)
  const labelEvery = Math.max(1, Math.ceil(pts.length / 8));
  const minLabelGap = 46;
  const candidates = pts
    .map((p, i) => ({ i, x: p.x, h: p.h }))
    .filter(({ i }) => i % labelEvery === 0 || i === pts.length - 1);

  const kept = [];
  candidates.forEach((c, idx) => {
    const isLast = idx === candidates.length - 1;
    if (kept.length === 0) {
      kept.push(c);
      return;
    }
    const prev = kept[kept.length - 1];
    if (c.x - prev.x < minLabelGap) {
      if (isLast) kept[kept.length - 1] = c;
      return;
    }
    kept.push(c);
  });

  kept.forEach((c) => {
    const label = el('text', {
      class: 'axis-label',
      x: c.x,
      y: H - 6,
      'text-anchor': c.i === 0 ? 'start' : c.i === pts.length - 1 ? 'end' : 'middle',
    });
    label.textContent = fmtDate(c.h.reportDate, { month: 'short', day: 'numeric' });
    svg.appendChild(label);
  });

  pts.forEach((p) => {
    const dot = el('circle', { class: 'trend-dot', cx: p.x, cy: p.y, r: 4 });
    svg.appendChild(dot);

    const hit = el('circle', {
      cx: p.x,
      cy: p.y,
      r: 12,
      fill: 'transparent',
      style: 'cursor:pointer',
    });
    hit.addEventListener('mouseenter', () => {
      dot.setAttribute('r', 6);
      const wrapRect = svg.parentElement.getBoundingClientRect();
      const scaleX = wrapRect.width / W;
      const scaleY = wrapRect.height / H;
      tooltip.innerHTML = `<div class="t-title">${fmtDateTime(p.h.reportDate)}</div>
        <div class="t-row">Consumed: ${fmtInt(p.h.tokensConsumed)} / ${fmtInt(p.h.tokensTotal)}</div>
        <div class="t-row">Available: ${fmtInt(p.h.tokensAvailable)}</div>`;
      tooltip.style.left = `${p.x * scaleX + 12}px`;
      tooltip.style.top = `${p.y * scaleY - 8}px`;
      tooltip.style.opacity = '1';
    });
    hit.addEventListener('mouseleave', () => {
      dot.setAttribute('r', 4);
      tooltip.style.opacity = '0';
    });
    svg.appendChild(hit);
  });
}

function renderCategories(latest) {
  const legend = document.getElementById('cat-legend');
  const bars = document.getElementById('cat-bars');
  const miniStats = document.getElementById('mini-stats');
  const sub = document.getElementById('category-sub');
  legend.innerHTML = '';
  bars.innerHTML = '';
  miniStats.innerHTML = '';
  sub.textContent = `${fmtDate(latest.reportDate)} · ${fmtInt(
    latest.categories?.['TOTAL SAMPLES']?.count
  )} samples · ${fmtInt(latest.tokensConsumed)} tokens`;

  for (const cat of CAT_ORDER) {
    const data = latest.categories?.[cat.key] || { count: 0, tokens: 0 };
    const cell = document.createElement('div');
    cell.className = 'mini-stat';
    cell.innerHTML = `
      <div class="ms-label">${cat.label}</div>
      <div class="ms-count">${fmtInt(data.count)}</div>
      <div class="ms-tokens">${fmtInt(data.tokens)} tokens</div>
    `;
    miniStats.appendChild(cell);
  }
  const totalData = latest.categories?.['TOTAL SAMPLES'] || { count: 0, tokens: 0 };
  const totalCell = document.createElement('div');
  totalCell.className = 'mini-stat divider total';
  totalCell.innerHTML = `
    <div class="ms-label">Total Samples</div>
    <div class="ms-count">${fmtInt(totalData.count)}</div>
    <div class="ms-tokens">${fmtInt(totalData.tokens)} tokens</div>
  `;
  miniStats.appendChild(totalCell);

  const maxTokens = Math.max(1, ...CAT_ORDER.map((c) => latest.categories?.[c.key]?.tokens || 0));

  for (const cat of CAT_ORDER) {
    const color = cssVar(cat.varName);
    const item = document.createElement('div');
    item.className = 'item';
    item.innerHTML = `<span class="swatch" style="background:${color}"></span>${cat.label}`;
    legend.appendChild(item);

    const data = latest.categories?.[cat.key] || { count: 0, tokens: 0 };
    const pct = (data.tokens / maxTokens) * 100;

    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML = `
      <div class="bar-label">${cat.label}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div>
      <div class="bar-value">${fmtInt(data.tokens)} tok · ${fmtInt(data.count)} smp</div>
    `;
    bars.appendChild(row);
  }
}

function computeSamplesByDay(samples) {
  const byDay = new Map();
  for (const s of samples) {
    const day = (s.date || '').split(' ')[0];
    if (!day) continue;
    if (!byDay.has(day)) byDay.set(day, { GENOME: 0, EXOME: 0, PANEL: 0, SUPPORTING: 0 });
    const key = (s.size || '').toUpperCase();
    const bucket = byDay.get(day);
    if (key in bucket) bucket[key]++;
  }
  return [...byDay.entries()].sort((a, b) => new Date(a[0]) - new Date(b[0]));
}

function renderSamplesByDay(latest) {
  const svg = document.getElementById('day-svg');
  const tooltip = document.getElementById('day-tooltip');
  const sub = document.getElementById('day-sub');
  const legend = document.getElementById('day-legend');
  svg.innerHTML = '';
  legend.innerHTML = '';

  for (const cat of CAT_ORDER) {
    const item = document.createElement('div');
    item.className = 'item';
    item.innerHTML = `<span class="swatch" style="background:${cssVar(cat.varName)}"></span>${cat.label}`;
    legend.appendChild(item);
  }

  const data = computeSamplesByDay(latest.samples || []);
  if (data.length === 0) {
    sub.textContent = 'No samples in this report.';
    return;
  }
  const totalSamples = (latest.samples || []).length;
  sub.textContent = `${fmtDate(latest.reportDate)} · ${fmtInt(totalSamples)} samples across ${
    data.length
  } day${data.length === 1 ? '' : 's'}`;

  const W = 900,
    H = 220,
    padL = 30,
    padR = 16,
    padT = 16,
    padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const totals = data.map(([, counts]) => CAT_ORDER.reduce((s, cat) => s + counts[cat.key], 0));
  const maxCount = Math.max(1, ...totals);
  const niceMax = Math.ceil(maxCount / 4) * 4 || 4;

  const band = innerW / data.length;
  const barW = Math.min(70, band * 0.5);

  const ns = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs) => {
    const n = document.createElementNS(ns, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  };

  const steps = 4;
  for (let s = 0; s <= steps; s++) {
    const v = Math.round((niceMax / steps) * s);
    const y = padT + innerH - (v / niceMax) * innerH;
    svg.appendChild(el('line', { class: 'grid-line', x1: padL, x2: W - padR, y1: y, y2: y }));
    const label = el('text', { class: 'axis-label', x: padL - 8, y: y + 3, 'text-anchor': 'end' });
    label.textContent = v;
    svg.appendChild(label);
  }

  data.forEach(([day, counts], i) => {
    const cx = padL + band * i + band / 2;
    let yCursor = padT + innerH;
    const total = totals[i];

    CAT_ORDER.forEach((cat) => {
      const c = counts[cat.key];
      if (!c) return;
      const segH = (c / niceMax) * innerH;
      const y = yCursor - segH;
      svg.appendChild(
        el('rect', {
          class: 'day-bar-seg',
          x: cx - barW / 2,
          y,
          width: barW,
          height: segH,
          fill: cssVar(cat.varName),
        })
      );
      yCursor = y;
    });

    const label = el('text', { class: 'axis-label', x: cx, y: H - 6, 'text-anchor': 'middle' });
    label.textContent = fmtDate(`${day}T00:00:00`, { month: 'short', day: 'numeric' });
    svg.appendChild(label);

    const hit = el('rect', {
      x: padL + band * i,
      y: padT,
      width: band,
      height: innerH,
      fill: 'transparent',
      style: 'cursor:pointer',
    });
    hit.addEventListener('mouseenter', () => {
      const wrapRect = svg.parentElement.getBoundingClientRect();
      const scaleX = wrapRect.width / W;
      const scaleY = wrapRect.height / H;
      const rows = CAT_ORDER.filter((cat) => counts[cat.key])
        .map((cat) => `<div class="t-row">${cat.label}: ${counts[cat.key]}</div>`)
        .join('');
      tooltip.innerHTML = `<div class="t-title">${fmtDate(`${day}T00:00:00`)}</div>${rows}<div class="t-row">Total: ${total}</div>`;
      tooltip.style.left = `${cx * scaleX + 12}px`;
      tooltip.style.top = `${padT * scaleY}px`;
      tooltip.style.opacity = '1';
    });
    hit.addEventListener('mouseleave', () => {
      tooltip.style.opacity = '0';
    });
    svg.appendChild(hit);
  });
}

function renderSamples(latest) {
  const tbody = document.querySelector('#samples-table tbody');
  tbody.innerHTML = '';
  const samples = [...(latest.samples || [])].sort((a, b) => new Date(b.date) - new Date(a.date));
  if (samples.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="color:var(--text-muted)">No samples in this report.</td></tr>';
    return;
  }
  for (const s of samples) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${s.date}</td><td class="mono">${s.hash}</td><td>${fmtInt(
      s.variantCount
    )}</td><td>${s.size}</td>`;
    tbody.appendChild(tr);
  }
}

function renderReportsTable(history) {
  const tbody = document.querySelector('#reports-table tbody');
  tbody.innerHTML = '';
  const rows = [...history].sort((a, b) => new Date(b.reportDate) - new Date(a.reportDate));
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${fmtDate(r.reportDate)}</td><td class="mono">${r.filename}</td><td>${fmtInt(
      r.tokensConsumed
    )}</td><td>${fmtInt(r.tokensTotal)}</td><td>${fmtInt(r.tokensAvailable)}</td><td>${fmtPct(
      r.usagePercent
    )}</td>`;
    tbody.appendChild(tr);
  }
}

function renderOrg(org) {
  currentOrgData = org;
  const sorted = org.reports; // already sorted ascending by server
  const latest = sorted[sorted.length - 1];
  const prev = sorted.length > 1 ? sorted[sorted.length - 2] : null;

  renderHeader(org.label, latest);
  renderStats(latest, prev);
  renderBurnRate(sorted, org.license);
  renderCategories(latest);
  renderSamplesByDay(latest);
  renderSamples(latest);

  renderMonthOptions(sorted);
  renderHistoryViews();
}

async function refresh() {
  const orgs = await fetchOrgs();
  if (orgs.length === 0) {
    document.getElementById('org-tabs').hidden = true;
    document.getElementById('org-name').textContent = 'No reports ingested yet';
    document.getElementById('trend-sub').textContent =
      'Drop a tokenstatus_*.pdf file into the reports/ folder to get started.';
    return;
  }

  renderReportMenu(orgs);

  const remembered = localStorage.getItem('token-monitor-org');
  const match = orgs.find((o) => o.label === selectedOrgLabel) || orgs.find((o) => o.label === remembered);
  const active = match || orgs[0];
  selectedOrgLabel = active.label;

  renderTabs(orgs);
  renderOrg(active);
}

function renderReportMenu(orgs) {
  const menu = document.getElementById('report-menu');
  menu.innerHTML = '';

  if (orgs.length === 1) {
    const btn = document.createElement('button');
    btn.innerHTML = `<svg viewBox="0 0 16 16" fill="none"><path d="M4 2.5h6l2.5 2.5v8.5H4v-11z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 6v4.5M8 10.5L6 8.5M8 10.5l2-2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Download report</span>`;
    btn.addEventListener('click', () => {
      window.location.href = `/api/report?scope=${encodeURIComponent(orgs[0].label)}`;
      menu.hidden = true;
    });
    menu.appendChild(btn);
    return;
  }

  const label = document.createElement('div');
  label.className = 'dd-label';
  label.textContent = 'Select organizations';
  menu.appendChild(label);

  const checkboxes = orgs.map((org) => {
    const item = document.createElement('label');
    item.className = 'dd-checkbox';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = org.label;
    input.checked = true;
    const text = document.createElement('span');
    text.textContent = org.label;
    item.appendChild(input);
    item.appendChild(text);
    menu.appendChild(item);
    return input;
  });

  const hr = document.createElement('hr');
  menu.appendChild(hr);

  const downloadBtn = document.createElement('button');
  downloadBtn.className = 'dd-primary';
  downloadBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="none"><path d="M4 2.5h6l2.5 2.5v8.5H4v-11z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 6v4.5M8 10.5L6 8.5M8 10.5l2-2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Download report</span>`;
  const updateDownloadState = () => {
    downloadBtn.disabled = !checkboxes.some((c) => c.checked);
  };
  checkboxes.forEach((c) => c.addEventListener('change', updateDownloadState));
  updateDownloadState();

  downloadBtn.addEventListener('click', () => {
    const selected = checkboxes.filter((c) => c.checked).map((c) => c.value);
    if (selected.length === 0) return;
    const params =
      selected.length === orgs.length
        ? 'scope=all'
        : selected.map((label) => `orgs=${encodeURIComponent(label)}`).join('&');
    window.location.href = `/api/report?${params}`;
    menu.hidden = true;
  });
  menu.appendChild(downloadBtn);
}

document.getElementById('report-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = document.getElementById('report-menu');
  menu.hidden = !menu.hidden;
});
document.getElementById('report-menu').addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => {
  document.getElementById('report-menu').hidden = true;
});

document.getElementById('rescan-btn').addEventListener('click', async () => {
  const btn = document.getElementById('rescan-btn');
  const label = btn.querySelector('span');
  btn.disabled = true;
  label.textContent = 'Rescanning…';
  try {
    await fetch('/api/rescan', { method: 'POST' });
    await refresh();
  } finally {
    btn.disabled = false;
    label.textContent = 'Rescan reports';
  }
});

function showUploadStatus(kind, message) {
  const bar = document.getElementById('upload-status');
  bar.className = `upload-status ${kind}`;
  bar.textContent = message;
  bar.hidden = false;
  if (kind !== 'info') {
    clearTimeout(showUploadStatus._t);
    showUploadStatus._t = setTimeout(() => {
      bar.hidden = true;
    }, 5000);
  }
}

async function uploadPdf(file) {
  if (!file) return;
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    showUploadStatus('error', `"${file.name}" isn't a PDF file.`);
    return;
  }
  showUploadStatus('info', `Uploading ${file.name}…`);
  const formData = new FormData();
  formData.append('file', file);
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Upload failed (${res.status})`);
    }
    showUploadStatus('success', `${file.name} ingested successfully.`);
    await refresh();
  } catch (err) {
    showUploadStatus('error', `Failed to ingest ${file.name}: ${err.message}`);
  }
}

const uploadInput = document.getElementById('upload-input');
document.getElementById('upload-btn').addEventListener('click', () => uploadInput.click());
uploadInput.addEventListener('change', () => {
  if (uploadInput.files[0]) uploadPdf(uploadInput.files[0]);
  uploadInput.value = '';
});

const dropOverlay = document.getElementById('drop-overlay');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  dropOverlay.hidden = false;
});
window.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  e.preventDefault();
});
window.addEventListener('dragleave', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.hidden = true;
});
window.addEventListener('drop', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  const files = [...(e.dataTransfer.files || [])];
  files.forEach(uploadPdf);
});

refresh();
setInterval(refresh, 15000);
