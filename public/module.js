const params = new URLSearchParams(location.search);
const MODULE_ID = params.get('m');

const CAT_ORDER = [
  { key: 'GENOME', label: 'Genome', varName: '--series-1' },
  { key: 'EXOME', label: 'Exome', varName: '--series-2' },
  { key: 'PANEL', label: 'Panel', varName: '--series-3' },
  { key: 'SUPPORTING', label: 'Supporting', varName: '--series-4' },
];

const fmtInt = (n) => (n == null || n === '' ? '—' : n.toLocaleString ? n.toLocaleString('en-US') : n);
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

let moduleMeta = null;
let activeSource = 'csv';
let currentOrgData = null;
let selectedMonth = 'all';

async function loadModuleMeta() {
  const res = await fetch('/api/modules');
  const modules = await res.json();
  const mod = modules.find((m) => m.id === MODULE_ID);
  if (!mod) throw new Error(`Unknown module "${MODULE_ID}"`);
  return mod;
}

async function fetchCsvOrg() {
  const res = await fetch(`/api/orgs/${MODULE_ID}`);
  const body = await res.json();
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

async function fetchExcelOrg() {
  const res = await fetch(`/api/sheet/${MODULE_ID}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

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

  if (activeSource === 'excel') {
    const rows = currentOrgData.rawRows || [];
    const filteredRows =
      selectedMonth === 'all' ? rows : rows.filter((r) => monthKey(r.sortDate) === selectedMonth);
    renderReportsTableSheet(filteredRows);
    renderUserTrend(filteredRows);
  } else {
    renderReportsTableCsv(filtered);
  }
}

document.getElementById('month-filter').addEventListener('change', (e) => {
  selectedMonth = e.target.value;
  renderHistoryViews();
});

function renderHeader(latest, source) {
  const orgNameEl = document.getElementById('org-name');
  orgNameEl.textContent =
    source === 'excel' ? 'Live from Google Sheet' : latest.orgName || moduleMeta.label;
}

function renderDelta(elId, delta, { goodDirection } = {}) {
  const el = document.getElementById(elId);
  if (delta == null || delta === 0) {
    el.textContent = delta === 0 ? 'No change since last entry' : '';
    el.className = 'stat-delta flat';
    return;
  }
  const arrow = delta > 0 ? '▲' : '▼';
  const sign = delta > 0 ? '+' : '';
  const isGood = goodDirection === (delta > 0 ? 'up' : 'down');
  el.textContent = `${arrow} ${sign}${fmtInt(delta)} since last entry`;
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

function renderLicenseStat(license) {
  const daysEl = document.getElementById('stat-days-remaining');
  const expiryEl = document.getElementById('stat-license-expiry');
  if (!license) {
    daysEl.textContent = '—';
    expiryEl.textContent = '—';
    return;
  }
  const daysLeft = Math.round((new Date(license.expiryDate) - Date.now()) / 86400000);
  daysEl.textContent = `~${Math.max(0, daysLeft).toLocaleString('en-US')}`;
  expiryEl.textContent = fmtDate(license.expiryDate);
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
      <span>Only one entry so far. Add another report/row and the burn rate, days remaining, and a projected exhaustion date will appear here automatically.</span>
    </div>${licenseHtml ? `<div class="burn-grid">${licenseHtml}</div>` : ''}`;
    return;
  }

  const prev = reports[reports.length - 2];
  const latest = reports[reports.length - 1];
  const deltaTokens = latest.tokensConsumed - prev.tokensConsumed;
  const deltaDays = (new Date(latest.reportDate) - new Date(prev.reportDate)) / 86400000;

  if (deltaDays <= 0) {
    el.innerHTML = `<div class="burn-empty"><span>Entries must be at least a day apart to estimate a burn rate.</span></div>${
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
        <div class="bm-label">Since last entry</div>
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
  )} days, between the ${fmtDate(prev.reportDate)} and ${fmtDate(latest.reportDate)} entries.</div>
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
      ? 'Only one entry so far — add more to see a trend.'
      : `${history.length} entries, ${fmtDate(history[0].reportDate)} → ${fmtDate(
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
  const stop1 = el('stop', { offset: '0%', 'stop-color': cssVar('--accent'), 'stop-opacity': 0.28 });
  const stop2 = el('stop', { offset: '100%', 'stop-color': cssVar('--accent'), 'stop-opacity': 0.02 });
  gradient.appendChild(stop1);
  gradient.appendChild(stop2);
  defs.appendChild(gradient);
  svg.appendChild(defs);

  const steps = 4;
  for (let s = 0; s <= steps; s++) {
    const v = (maxVal / steps) * s;
    const y = yFor(v);
    svg.appendChild(el('line', { class: 'grid-line', x1: padL, x2: W - padR, y1: y, y2: y }));
    const label = el('text', { class: 'axis-label', x: padL - 8, y: y + 3, 'text-anchor': 'end' });
    label.textContent = Math.round(v).toLocaleString('en-US');
    svg.appendChild(label);
  }

  const refY = yFor(latestTotal);
  svg.appendChild(el('line', { class: 'ref-line', x1: padL, x2: W - padR, y1: refY, y2: refY }));
  const refLabel = el('text', { class: 'ref-label', x: W - padR, y: refY - 5, 'text-anchor': 'end' });
  refLabel.textContent = `Total: ${latestTotal.toLocaleString('en-US')}`;
  svg.appendChild(refLabel);

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

    const hit = el('circle', { cx: p.x, cy: p.y, r: 12, fill: 'transparent', style: 'cursor:pointer' });
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

const USER_TREND_COLORS = ['--series-1', '--series-2', '--series-3', '--series-4', '--seq-300', '--seq-600'];

function renderUserTrend(rawRows) {
  const svg = document.getElementById('user-trend-svg');
  const tooltip = document.getElementById('user-trend-tooltip');
  const sub = document.getElementById('user-trend-sub');
  const legend = document.getElementById('user-trend-legend');
  svg.innerHTML = '';
  legend.innerHTML = '';

  const byUser = new Map();
  for (const r of rawRows) {
    const user = (r.username || '').trim();
    if (!user) continue;
    if (!byUser.has(user)) byUser.set(user, []);
    byUser.get(user).push(r);
  }

  const usernames = [...byUser.keys()].sort();
  if (usernames.length === 0) {
    sub.textContent = 'No usage logged yet.';
    return;
  }

  const series = usernames.map((user, i) => {
    const rows = [...byUser.get(user)].sort((a, b) => new Date(a.sortDate) - new Date(b.sortDate));
    let cumulative = 0;
    const points = rows.map((r) => {
      cumulative += Number(r.tokensConsumed) || 0;
      return { x: new Date(r.sortDate).getTime(), y: cumulative, row: r };
    });
    return { user, color: USER_TREND_COLORS[i % USER_TREND_COLORS.length], points };
  });

  const totalTokens = series.reduce((s, ser) => s + (ser.points[ser.points.length - 1]?.y || 0), 0);
  sub.textContent = `${usernames.length} user${usernames.length === 1 ? '' : 's'} · ${fmtInt(totalTokens)} tokens total`;

  for (const ser of series) {
    const item = document.createElement('div');
    item.className = 'item';
    const last = ser.points[ser.points.length - 1];
    item.innerHTML = `<span class="swatch" style="background:${cssVar(ser.color)}"></span>${ser.user} (${fmtInt(
      last.y
    )})`;
    legend.appendChild(item);
  }

  const allPoints = series.flatMap((s) => s.points);
  const W = 900,
    H = 220,
    padL = 46,
    padR = 16,
    padT = 16,
    padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const maxVal = Math.max(1, ...allPoints.map((p) => p.y));
  const minT = Math.min(...allPoints.map((p) => p.x));
  const maxT = Math.max(...allPoints.map((p) => p.x));
  const spanT = maxT - minT || 1;

  const xFor = (t) => (allPoints.length <= 1 ? padL + innerW / 2 : padL + ((t - minT) / spanT) * innerW);
  const yFor = (v) => padT + innerH - (v / maxVal) * innerH;

  const ns = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs) => {
    const n = document.createElementNS(ns, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  };

  const steps = 4;
  for (let s = 0; s <= steps; s++) {
    const v = (maxVal / steps) * s;
    const y = yFor(v);
    svg.appendChild(el('line', { class: 'grid-line', x1: padL, x2: W - padR, y1: y, y2: y }));
    const label = el('text', { class: 'axis-label', x: padL - 8, y: y + 3, 'text-anchor': 'end' });
    label.textContent = Math.round(v).toLocaleString('en-US');
    svg.appendChild(label);
  }

  const dateLabels = [...new Set(allPoints.map((p) => p.x))].sort((a, b) => a - b);
  const labelEvery = Math.max(1, Math.ceil(dateLabels.length / 6));
  dateLabels.forEach((t, i) => {
    if (i % labelEvery !== 0 && i !== dateLabels.length - 1) return;
    const x = xFor(t);
    const label = el('text', {
      class: 'axis-label',
      x,
      y: H - 6,
      'text-anchor': i === 0 ? 'start' : i === dateLabels.length - 1 ? 'end' : 'middle',
    });
    label.textContent = fmtDate(new Date(t).toISOString(), { month: 'short', day: 'numeric' });
    svg.appendChild(label);
  });

  for (const ser of series) {
    const color = cssVar(ser.color);
    const pts = ser.points.map((p) => ({ ...p, sx: xFor(p.x), sy: yFor(p.y) }));

    if (pts.length > 1) {
      const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.sx},${p.sy}`).join(' ');
      svg.appendChild(el('path', { d: linePath, fill: 'none', stroke: color, 'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    }

    pts.forEach((p) => {
      const dot = el('circle', { cx: p.sx, cy: p.sy, r: 4, fill: cssVar('--surface'), stroke: color, 'stroke-width': 2.5 });
      svg.appendChild(dot);

      const hit = el('circle', { cx: p.sx, cy: p.sy, r: 12, fill: 'transparent', style: 'cursor:pointer' });
      hit.addEventListener('mouseenter', () => {
        dot.setAttribute('r', 6);
        const wrapRect = svg.parentElement.getBoundingClientRect();
        const scaleX = wrapRect.width / W;
        const scaleY = wrapRect.height / H;
        tooltip.innerHTML = `<div class="t-title">${ser.user}</div>
          <div class="t-row">${fmtDate(p.row.sortDate)}: ${fmtInt(Number(p.row.tokensConsumed) || 0)} tokens</div>
          <div class="t-row">Cumulative: ${fmtInt(p.y)}</div>`;
        tooltip.style.left = `${p.sx * scaleX + 12}px`;
        tooltip.style.top = `${p.sy * scaleY - 8}px`;
        tooltip.style.opacity = '1';
      });
      hit.addEventListener('mouseleave', () => {
        dot.setAttribute('r', 4);
        tooltip.style.opacity = '0';
      });
      svg.appendChild(hit);
    });
  }
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
    sub.textContent = 'No samples logged yet.';
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
    tbody.innerHTML = '<tr><td colspan="4" style="color:var(--text-muted)">No samples logged yet.</td></tr>';
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

function setReportsTableHead(mode, tokensTotal) {
  const thead = document.getElementById('reports-table-head');
  if (mode === 'excel') {
    thead.innerHTML = `<tr>
      <th>Date</th><th>Time</th><th>Server</th><th>Workspace</th><th>Panel</th>
      <th>Total sample count</th><th>Total token consumed</th><th>Username</th><th>Uploaded by</th>
      <th>Pending tokens (${fmtInt(tokensTotal)})</th>
    </tr>`;
  } else {
    thead.innerHTML = `<tr><th>Date</th><th>Genome</th><th>Exome</th><th>Panel</th><th>Supporting</th><th>Samples</th><th>Consumed</th><th>Available</th></tr>`;
  }
}

// One row per day from the usage CSV: the day's per-size sample counts plus the
// running (cumulative) tokens consumed and available up to that day.
function renderReportsTableCsv(history) {
  const tbody = document.querySelector('#reports-table tbody');
  tbody.innerHTML = '';
  const rows = [...history].sort((a, b) => new Date(b.reportDate) - new Date(a.reportDate));
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="color:var(--text-muted)">No CSV uploaded yet.</td></tr>';
    return;
  }
  for (const r of rows) {
    const d = r.dailyCounts || {};
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${fmtDate(r.reportDate)}</td><td>${fmtInt(d.GENOME || 0)}</td><td>${fmtInt(
      d.EXOME || 0
    )}</td><td>${fmtInt(d.PANEL || 0)}</td><td>${fmtInt(d.SUPPORTING || 0)}</td><td>${fmtInt(
      d.TOTAL || 0
    )}</td><td>${fmtInt(r.tokensConsumed)}</td><td>${fmtInt(r.tokensAvailable)}</td>`;
    tbody.appendChild(tr);
  }
}

function renderReportsTableSheet(rawRows) {
  const tbody = document.querySelector('#reports-table tbody');
  tbody.innerHTML = '';
  const rows = [...rawRows].sort((a, b) => new Date(b.sortDate) - new Date(a.sortDate));
  if (rows.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="10" style="color:var(--text-muted)">No entries logged yet.</td></tr>';
    return;
  }
  const cell = (v) => (v == null || v === '' ? '—' : v);
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${cell(r.date)}</td><td>${cell(r.time)}</td><td>${cell(
      r.server
    )}</td><td>${cell(r.workspace)}</td><td>${cell(r.panel)}</td><td>${cell(
      r.sampleCount
    )}</td><td>${cell(r.tokensConsumed)}</td><td>${cell(r.username)}</td><td>${cell(
      r.uploadedBy
    )}</td><td>${cell(r.pending)}</td>`;
    tbody.appendChild(tr);
  }
}

function showEmptyDashboard(message) {
  ['stat-total', 'stat-consumed', 'stat-available', 'stat-usage'].forEach(
    (id) => (document.getElementById(id).textContent = '—')
  );
  document.getElementById('stat-consumed-delta').textContent = '';
  document.getElementById('stat-available-sub').textContent = '';
  document.getElementById('stat-usage-sub').textContent = '';
  document.getElementById('burn-content').innerHTML = `<div class="burn-empty"><span>${message}</span></div>`;
  document.getElementById('trend-svg').innerHTML = '';
  document.getElementById('trend-sub').textContent = message;
  document.getElementById('user-trend-svg').innerHTML = '';
  document.getElementById('user-trend-sub').textContent = message;
  document.getElementById('user-trend-legend').innerHTML = '';
  renderLicenseStat(null);
  document.getElementById('mini-stats').innerHTML = '';
  document.getElementById('cat-legend').innerHTML = '';
  document.getElementById('cat-bars').innerHTML = '';
  document.getElementById('category-sub').textContent = '';
  document.getElementById('day-svg').innerHTML = '';
  document.getElementById('day-legend').innerHTML = '';
  document.getElementById('day-sub').textContent = '';
  document.querySelector('#samples-table tbody').innerHTML = `<tr><td colspan="4" style="color:var(--text-muted)">${message}</td></tr>`;
  const colspan = activeSource === 'excel' ? 11 : 8;
  document.querySelector('#reports-table tbody').innerHTML = `<tr><td colspan="${colspan}" style="color:var(--text-muted)">${message}</td></tr>`;
  document.getElementById('month-filter').innerHTML = '<option value="all">All time</option>';
}

function renderOrg(org, source) {
  currentOrgData = org;
  setReportsTableHead(source, org.reports[org.reports.length - 1]?.tokensTotal);

  // The sample-hash table only makes sense for sheet/legacy data; the CSV meter
  // is count-based, so its per-size counts live in the reports ledger instead.
  document.getElementById('section-samples').hidden = source === 'csv';

  const sorted = org.reports;
  if (sorted.length === 0) {
    document.getElementById('org-name').textContent =
      source === 'excel' ? 'Live from Google Sheet' : moduleMeta.label;
    showEmptyDashboard(
      source === 'excel'
        ? 'No entries logged in the sheet yet.'
        : 'No usage CSV uploaded for this module yet.'
    );
    return;
  }

  const latest = sorted[sorted.length - 1];
  const prev = sorted.length > 1 ? sorted[sorted.length - 2] : null;

  renderHeader(latest, source);
  renderStats(latest, prev);
  renderLicenseStat(org.license);
  renderBurnRate(sorted, org.license);
  renderCategories(latest);
  renderSamplesByDay(latest);
  renderSamples(latest);

  renderMonthOptions(sorted);
  renderHistoryViews();
}

// Explains why the sheet log and the licence meter disagree. Only meaningful
// on the Excel tab, where both sources are in play.
function renderReconciliation(org, source) {
  const panel = document.getElementById('reconcile-panel');
  const rec = source === 'excel' ? org && org.reconciliation : null;
  const warnings = source === 'excel' && org ? org.dateWarnings || [] : [];

  if (!rec && warnings.length === 0) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  const clean = !rec || rec.reconciled;
  panel.classList.toggle('is-clean', clean && warnings.length === 0);

  const badge = document.getElementById('reconcile-badge');
  const scope = document.getElementById('reconcile-scope');
  if (!rec) {
    badge.textContent = 'Sheet notes';
    scope.textContent = '';
  } else {
    badge.textContent = rec.reconciled
      ? 'Reconciled with license meter'
      : 'Unaccounted against license meter';
    scope.textContent = `${rec.window.start} to ${rec.window.end} · meter ${fmtInt(
      rec.meter.total.tokens
    )} tokens / ${fmtInt(rec.meter.total.count)} samples · sheet ${fmtInt(
      rec.sheet.total.tokens
    )} / ${fmtInt(rec.sheet.total.count)}`;
  }

  const list = document.getElementById('reconcile-list');
  list.innerHTML = '';
  const add = (text, why) => {
    const li = document.createElement('li');
    li.textContent = text;
    if (why) {
      const span = document.createElement('span');
      span.className = 'why';
      span.textContent = why;
      li.appendChild(span);
    }
    list.appendChild(li);
  };

  if (rec && rec.reconciled) {
    add('Every sample the meter billed is present in the sheet log.');
  }
  for (const f of (rec && rec.findings) || []) add(f.text, f.hint);
  for (const w of warnings) add(w);
}

function showFetchError(message, kind = 'error') {
  const bar = document.getElementById('fetch-error');
  if (!message) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  bar.textContent = message;
  bar.classList.toggle('warn', kind === 'warn');
}

async function refresh() {
  try {
    if (activeSource === 'excel') {
      const org = await fetchExcelOrg();
      showFetchError(org.headerIssue || null, 'warn');
      renderOrg(org, 'excel');
      renderReconciliation(org, 'excel');
    } else {
      const org = await fetchCsvOrg();
      showFetchError(null);
      renderOrg(
        org || { label: moduleMeta.label, license: null, reports: [] },
        'csv'
      );
      renderReconciliation(org, 'csv');
    }
  } catch (err) {
    showFetchError(`Couldn't load data: ${err.message}`);
  }
}

function setActiveSource(source) {
  activeSource = source;
  document.documentElement.dataset.mode = source;
  document.getElementById('tab-csv').classList.toggle('active', source === 'csv');
  document.getElementById('tab-excel').classList.toggle('active', source === 'excel');
  document.getElementById('csv-actions').hidden = source !== 'csv';
  document.getElementById('excel-actions').hidden = source !== 'excel';
  document.getElementById('upload-status').hidden = true;
  document.getElementById('reconcile-panel').hidden = true;
  showFetchError(null);
  selectedMonth = 'all';
  refresh();
}

document.getElementById('tab-csv').addEventListener('click', () => setActiveSource('csv'));
document.getElementById('tab-excel').addEventListener('click', () => setActiveSource('excel'));

document.getElementById('refresh-btn').addEventListener('click', async () => {
  const btn = document.getElementById('refresh-btn');
  const label = btn.querySelector('span');
  btn.disabled = true;
  label.textContent = 'Refreshing…';
  try {
    await refresh();
  } finally {
    btn.disabled = false;
    label.textContent = 'Refresh';
  }
});

document.getElementById('download-btn').addEventListener('click', () => {
  window.location.href = `/api/report?scope=${encodeURIComponent(moduleMeta.label)}`;
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

async function uploadCsv(file) {
  if (!file) return;
  if (file.type !== 'text/csv' && !file.name.toLowerCase().endsWith('.csv')) {
    showUploadStatus('error', `"${file.name}" isn't a CSV file.`);
    return;
  }
  showUploadStatus('info', `Uploading ${file.name}…`);
  const formData = new FormData();
  formData.append('file', file);
  try {
    const res = await fetch(`/api/upload?m=${encodeURIComponent(MODULE_ID)}`, {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Upload failed (${res.status})`);
    }
    showUploadStatus('success', `${file.name} loaded successfully.`);
    if (activeSource !== 'csv') setActiveSource('csv');
    else await refresh();
  } catch (err) {
    showUploadStatus('error', `Failed to load ${file.name}: ${err.message}`);
  }
}

const uploadInput = document.getElementById('upload-input');
document.getElementById('upload-btn').addEventListener('click', () => uploadInput.click());
uploadInput.addEventListener('change', () => {
  if (uploadInput.files[0]) uploadCsv(uploadInput.files[0]);
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
  files.forEach(uploadCsv);
});

async function init() {
  if (!MODULE_ID) {
    document.getElementById('module-title').textContent = 'Unknown module';
    showFetchError('No module specified. Go back to the report menu and pick a system.');
    return;
  }
  try {
    moduleMeta = await loadModuleMeta();
  } catch (err) {
    document.getElementById('module-title').textContent = 'Unknown module';
    showFetchError(err.message);
    return;
  }
  document.getElementById('module-title').textContent = moduleMeta.label;
  document.getElementById('open-sheet-link').href = moduleMeta.sheetUrl;
  setActiveSource('csv');
  setInterval(refresh, 15000);
}

init();
