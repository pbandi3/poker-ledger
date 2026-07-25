import { computeLedger, formatWhatsApp, formatCents, toDollars } from './src/engine.js';

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'poker-ledger-v1';

const els = {
  buyIn: $('buyIn'),
  host: $('host'),
  feeType: $('feeType'),
  feeValue: $('feeValue'),
  feeValueLabel: $('feeValueLabel'),
  feeScope: $('feeScope'),
  playersBody: $('playersBody'),
  addRowBtn: $('addRowBtn'),
  sampleBtn: $('sampleBtn'),
  calcBtn: $('calcBtn'),
  warnings: $('warnings'),
  results: $('results'),
  standingsTable: $('standingsTable'),
  settlementTable: $('settlementTable'),
  txnCount: $('txnCount'),
  waBtn: $('waBtn'),
  waOut: $('waOut'),
  photoInput: $('photoInput'),
  photoPreview: $('photoPreview'),
  photoHint: $('photoHint'),
  installBtn: $('installBtn'),
  toast: $('toast'),
};

const SAMPLE = [
  { name: 'Prudvi', buyIn: '', chips: '90' },
  { name: 'Aditya', buyIn: '', chips: '60+10' },
  { name: 'Pradeep', buyIn: '', chips: '120' },
  { name: 'Chandra', buyIn: '', chips: '30' },
  { name: 'Bala', buyIn: '', chips: '0' },
  { name: 'Balaji', buyIn: '', chips: '195' },
  { name: 'Sudhakar', buyIn: '', chips: '110' },
  { name: 'Siva', buyIn: '', chips: '175' },
  { name: 'Sharath', buyIn: '', chips: '110' },
];

// ---- Safe "60+10" style expression parser (additive only) ------------------
function parseAmount(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return null;
  if (!/^[\d+.\s]+$/.test(s)) return NaN;
  return s
    .split('+')
    .map((t) => Number(t.trim()))
    .reduce((a, b) => a + b, 0);
}

// ---- Row management --------------------------------------------------------
function makeRow(data = { name: '', buyIn: '', chips: '' }) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="col-name"><input class="j-name" type="text" placeholder="Name" autocomplete="off" /></td>
    <td class="col-num"><input class="j-buyin" type="text" inputmode="decimal" placeholder="def" /></td>
    <td class="col-num"><input class="j-chips" type="text" inputmode="decimal" placeholder="0" /></td>
    <td class="col-x"><button class="row-x" title="Remove" aria-label="Remove row">&times;</button></td>`;
  tr.querySelector('.j-name').value = data.name ?? '';
  tr.querySelector('.j-buyin').value = data.buyIn ?? '';
  tr.querySelector('.j-chips').value = data.chips ?? '';
  tr.querySelector('.row-x').addEventListener('click', () => {
    tr.remove();
    refreshHostOptions();
    persist();
  });
  tr.querySelectorAll('input').forEach((inp) =>
    inp.addEventListener('input', () => {
      if (inp.classList.contains('j-name')) refreshHostOptions();
      persist();
    })
  );
  return tr;
}

function addRow(data) {
  els.playersBody.appendChild(makeRow(data));
}

function readRows() {
  return [...els.playersBody.querySelectorAll('tr')]
    .map((tr) => ({
      name: tr.querySelector('.j-name').value.trim(),
      buyIn: tr.querySelector('.j-buyin').value.trim(),
      chips: tr.querySelector('.j-chips').value.trim(),
    }))
    .filter((r) => r.name !== '' || r.chips !== '');
}

function refreshHostOptions() {
  const current = els.host.value;
  const names = readRows()
    .map((r) => r.name)
    .filter(Boolean);
  els.host.innerHTML = '<option value="">— none —</option>';
  for (const n of names) {
    const opt = document.createElement('option');
    opt.value = n;
    opt.textContent = n;
    els.host.appendChild(opt);
  }
  if (names.includes(current)) els.host.value = current;
}

// ---- Persistence -----------------------------------------------------------
function persist() {
  const state = {
    buyIn: els.buyIn.value,
    host: els.host.value,
    feeType: els.feeType.value,
    feeValue: els.feeValue.value,
    feeScope: els.feeScope.value,
    rows: readRows(),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage full / private mode — non-fatal */
  }
}

function restore() {
  let state = null;
  try {
    state = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    state = null;
  }
  if (state && Array.isArray(state.rows) && state.rows.length) {
    els.buyIn.value = state.buyIn ?? '100';
    els.feeType.value = state.feeType ?? 'perHead';
    els.feeValue.value = state.feeValue ?? '5';
    els.feeScope.value = state.feeScope ?? 'all';
    state.rows.forEach(addRow);
    refreshHostOptions();
    if (state.host) els.host.value = state.host;
  } else {
    for (let i = 0; i < 4; i++) addRow();
  }
  syncFeeControls();
}

// ---- Fee control affordances ----------------------------------------------
function syncFeeControls() {
  const t = els.feeType.value;
  const labels = {
    perHead: 'Fee per player ($)',
    flat: 'Flat fee total ($)',
    percent: 'Fee (% of pool)',
    none: 'Fee value',
  };
  els.feeValueLabel.textContent = labels[t] || 'Fee value';
  const disabled = t === 'none';
  els.feeValue.disabled = disabled;
  els.feeScope.disabled = disabled;
}

// ---- Compute + render ------------------------------------------------------
function calculate() {
  const rows = readRows();
  const players = [];
  for (const r of rows) {
    if (!r.name) return showToast('Every row needs a name.');
    const chips = parseAmount(r.chips) ?? 0;
    if (Number.isNaN(chips)) return showToast(`Bad chip value for ${r.name}.`);
    const buyIn = r.buyIn === '' ? null : parseAmount(r.buyIn);
    if (buyIn !== null && Number.isNaN(buyIn)) return showToast(`Bad buy-in for ${r.name}.`);
    players.push({ name: r.name, chips, ...(buyIn !== null ? { buyIn } : {}) });
  }
  if (players.length === 0) return showToast('Add at least one player.');

  let ledger;
  try {
    ledger = computeLedger({
      defaultBuyIn: parseAmount(els.buyIn.value) ?? 100,
      host: els.host.value || null,
      fee: {
        type: els.feeType.value,
        value: parseAmount(els.feeValue.value) ?? 0,
        scope: els.feeScope.value,
      },
      players,
    });
  } catch (err) {
    return showToast(err.message);
  }

  renderWarnings(ledger);
  renderStandings(ledger);
  renderSettlement(ledger);
  els.results.hidden = false;
  els.waOut.hidden = true;
  window.__ledger = ledger; // handy for the WhatsApp export
  els.results.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderWarnings(ledger) {
  if (!ledger.warnings.length) {
    els.warnings.hidden = true;
    els.warnings.innerHTML = '';
    return;
  }
  els.warnings.hidden = false;
  els.warnings.innerHTML = ledger.warnings.map((w) => `<div>⚠️ ${escapeHtml(w)}</div>`).join('');
}

function pnlCell(cents) {
  const cls = cents > 0 ? 'pos' : cents < 0 ? 'neg' : '';
  return `<td class="num ${cls}">${formatCents(cents, { sign: true })}</td>`;
}

function renderStandings(ledger) {
  const rows = ledger.standings
    .map(
      (r) => `
    <tr>
      <td class="num">${r.rank}</td>
      <td>${escapeHtml(r.name)}${r.isHost ? '<span class="host-badge">HOST</span>' : ''}</td>
      <td class="num">${(toDollars(r.chipsCents)).toFixed(0)}</td>
      <td class="num">${formatCents(r.buyInCents)}</td>
      ${pnlCell(r.pokerPnlCents)}
      ${pnlCell(r.feeCents)}
      ${pnlCell(r.netCents)}
    </tr>`
    )
    .join('');

  const sum = (key) => ledger.standings.reduce((a, r) => a + r[key], 0);

  els.standingsTable.innerHTML = `
    <thead>
      <tr>
        <th class="num">#</th><th>Player</th>
        <th class="num">Chips</th><th class="num">Buy-in</th>
        <th class="num">Poker P&L</th><th class="num">Host fee</th><th class="num">Net</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
    <tfoot>
      <tr class="total-row">
        <td></td><td>Total</td>
        <td class="num">${toDollars(ledger.chipsCents).toFixed(0)}</td>
        <td class="num">${formatCents(ledger.poolCents)}</td>
        <td class="num">${formatCents(sum('pokerPnlCents'))}</td>
        <td class="num">${formatCents(sum('feeCents'))}</td>
        <td class="num">${formatCents(ledger.netSumCents)}</td>
      </tr>
    </tfoot>`;
}

function renderSettlement(ledger) {
  if (!ledger.balanced) {
    els.settlementTable.innerHTML =
      '<tbody><tr><td class="muted">Fix the chip discrepancy above to generate a settlement plan.</td></tr></tbody>';
    els.txnCount.textContent = '';
    return;
  }
  els.txnCount.textContent = `${ledger.transactions.length} payment${
    ledger.transactions.length === 1 ? '' : 's'
  }`;
  const rows = ledger.transactions
    .map(
      (t, i) => `
      <tr>
        <td class="num">${i + 1}</td>
        <td class="neg">${escapeHtml(t.from)}</td>
        <td>→</td>
        <td class="pos">${escapeHtml(t.to)}</td>
        <td class="num">${formatCents(t.amountCents)}</td>
      </tr>`
    )
    .join('');
  els.settlementTable.innerHTML = `
    <thead><tr><th class="num">#</th><th>Pays</th><th></th><th>Receives</th><th class="num">Amount</th></tr></thead>
    <tbody>${rows || '<tr><td class="muted" colspan="5">Everyone is even — no payments needed.</td></tr>'}</tbody>`;
}

// ---- WhatsApp export -------------------------------------------------------
async function copyWhatsApp() {
  const ledger = window.__ledger;
  if (!ledger) return;
  const text = formatWhatsApp(ledger, { title: 'Poker Night' });
  els.waOut.textContent = text;
  els.waOut.hidden = false;
  try {
    await navigator.clipboard.writeText(text);
    showToast('Copied — paste into WhatsApp');
  } catch {
    showToast('Copy failed — long-press the text to copy');
  }
}

// ---- Photo preview (reference only; no upload) -----------------------------
function onPhoto(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  els.photoPreview.src = url;
  els.photoPreview.hidden = false;
  els.photoHint.hidden = true;
}

// ---- Misc helpers ----------------------------------------------------------
let toastTimer;
function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 2600);
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function loadSample() {
  els.playersBody.innerHTML = '';
  els.buyIn.value = '100';
  els.feeType.value = 'perHead';
  els.feeValue.value = '5';
  els.feeScope.value = 'all';
  SAMPLE.forEach(addRow);
  refreshHostOptions();
  els.host.value = 'Sudhakar';
  syncFeeControls();
  persist();
  showToast('Sample poker night loaded');
}

// ---- Wire up ---------------------------------------------------------------
els.addRowBtn.addEventListener('click', () => {
  addRow();
  persist();
});
els.sampleBtn.addEventListener('click', loadSample);
els.calcBtn.addEventListener('click', calculate);
els.waBtn.addEventListener('click', copyWhatsApp);
els.photoInput.addEventListener('change', onPhoto);
els.feeType.addEventListener('change', () => {
  syncFeeControls();
  persist();
});
[els.buyIn, els.host, els.feeValue, els.feeScope].forEach((el) =>
  el.addEventListener('input', persist)
);

restore();

// ---- PWA: install prompt + service worker ---------------------------------
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  els.installBtn.hidden = false;
});
els.installBtn.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  els.installBtn.hidden = true;
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* offline support is best-effort */
    });
  });
}
