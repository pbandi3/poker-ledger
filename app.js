import {
  computeLedger,
  formatWhatsApp,
  formatCents,
  formatDate,
  toDollars,
  parseBulk,
} from './src/engine.js';

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'poker-ledger-v1';
const SETTLED_KEY = 'poker-ledger-settled-v1';
// Bump alongside CACHE in sw.js; shown in the footer to confirm a deploy landed.
const APP_VERSION = 'v10';

const els = {
  date: $('date'),
  buyIn: $('buyIn'),
  host: $('host'),
  feeType: $('feeType'),
  feeValue: $('feeValue'),
  feeValueLabel: $('feeValueLabel'),
  feeScope: $('feeScope'),
  foodRecipient: $('foodRecipient'),
  foodType: $('foodType'),
  foodValue: $('foodValue'),
  foodValueLabel: $('foodValueLabel'),
  foodScope: $('foodScope'),
  playersBody: $('playersBody'),
  addRowBtn: $('addRowBtn'),
  sampleBtn: $('sampleBtn'),
  newGameBtn: $('newGameBtn'),
  calcBtn: $('calcBtn'),
  warnings: $('warnings'),
  results: $('results'),
  standingsTable: $('standingsTable'),
  settlementTable: $('settlementTable'),
  txnCount: $('txnCount'),
  waBtn: $('waBtn'),
  shareBtn: $('shareBtn'),
  waOut: $('waOut'),
  liveSummary: $('liveSummary'),
  photoInput: $('photoInput'),
  photoPreview: $('photoPreview'),
  photoDrop: $('photoDrop'),
  photoWrap: $('photoWrap'),
  changePhotoBtn: $('changePhotoBtn'),
  pasteText: $('pasteText'),
  fillBtn: $('fillBtn'),
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

// ---- Settled payments (survives reload so you can tick them off live) ------
function loadSettled() {
  try {
    return new Set(JSON.parse(localStorage.getItem(SETTLED_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

function saveSettled() {
  try {
    localStorage.setItem(SETTLED_KEY, JSON.stringify([...settled]));
  } catch {
    /* private mode */
  }
}

const settled = loadSettled();
const txnKey = (t) => `${t.from}>${t.to}:${t.amountCents}`;

// ---- Live tie-out strip ----------------------------------------------------
function updateLiveSummary() {
  const rows = readRows();
  const def = parseAmount(els.buyIn.value) ?? 100;
  let pool = 0;
  let chips = 0;
  for (const r of rows) {
    const b = r.buyIn === '' ? def : parseAmount(r.buyIn);
    const c = r.chips === '' ? 0 : parseAmount(r.chips);
    if (!Number.isNaN(b) && b !== null) pool += b;
    if (!Number.isNaN(c) && c !== null) chips += c;
  }
  if (rows.length === 0) {
    els.liveSummary.hidden = true;
    return;
  }
  els.liveSummary.hidden = false;
  const diff = chips - pool;
  const tie =
    diff === 0
      ? '<span class="tie ok">balanced</span>'
      : `<span class="tie off">off by $${Math.abs(diff).toFixed(2)}</span>`;
  els.liveSummary.innerHTML =
    `<span><b>${rows.length}</b> players</span>` +
    `<span>pool <b>$${pool.toFixed(2)}</b></span>` +
    `<span>chips <b>${chips.toFixed(0)}</b></span>` +
    tie;
}

// ---- Bulk fill from pasted photo text --------------------------------------
function fillFromText() {
  const parsed = parseBulk(els.pasteText.value);
  if (parsed.length === 0) {
    return showToast('No "name  number" lines found to parse.');
  }
  els.playersBody.innerHTML = '';
  parsed.forEach(addRow);
  addRow(); // spare row for a late arrival
  refreshHostOptions();
  persist();
  showToast(`Filled ${parsed.length} player${parsed.length === 1 ? '' : 's'} — review, then Calculate`);
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
  tr.querySelectorAll('input').forEach((inp) => {
    inp.addEventListener('input', () => {
      if (inp.classList.contains('j-name')) refreshHostOptions();
      persist();
      appendRowIfLastIsUsed(tr);
    });
    // Return moves to the next player instead of dismissing the keyboard.
    inp.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      let next = tr.nextElementSibling;
      if (!next) {
        addRow();
        next = els.playersBody.lastElementChild;
      }
      next.querySelector('.j-name').focus();
    });
  });
  return tr;
}

/** Keep one spare empty row at the bottom so you never hunt for "+ Add". */
function appendRowIfLastIsUsed(tr) {
  if (!tr || tr !== els.playersBody.lastElementChild) return;
  const used = [...tr.querySelectorAll('input')].some((i) => i.value.trim() !== '');
  if (used) addRow();
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

function fillPeopleSelect(selectEl, names) {
  const current = selectEl.value;
  selectEl.innerHTML = '<option value="">— none —</option>';
  for (const n of names) {
    const opt = document.createElement('option');
    opt.value = n;
    opt.textContent = n;
    selectEl.appendChild(opt);
  }
  if (names.includes(current)) selectEl.value = current;
}

function refreshHostOptions() {
  const names = readRows()
    .map((r) => r.name)
    .filter(Boolean);
  fillPeopleSelect(els.host, names);
  fillPeopleSelect(els.foodRecipient, names);
}

// ---- Persistence -----------------------------------------------------------
function persist() {
  const state = {
    date: els.date.value,
    buyIn: els.buyIn.value,
    host: els.host.value,
    feeType: els.feeType.value,
    feeValue: els.feeValue.value,
    feeScope: els.feeScope.value,
    foodRecipient: els.foodRecipient.value,
    foodType: els.foodType.value,
    foodValue: els.foodValue.value,
    foodScope: els.foodScope.value,
    rows: readRows(),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage full / private mode — non-fatal */
  }
  updateLiveSummary();
}

function restore() {
  let state = null;
  try {
    state = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    state = null;
  }
  if (state && Array.isArray(state.rows) && state.rows.length) {
    els.date.value = state.date ?? todayISO();
    els.buyIn.value = state.buyIn ?? '100';
    els.feeType.value = state.feeType ?? 'perHead';
    els.feeValue.value = state.feeValue ?? '5';
    els.feeScope.value = state.feeScope ?? 'all';
    els.foodType.value = state.foodType ?? 'perHead';
    if (!els.foodType.value) els.foodType.value = 'perHead'; // older saves used "none"
    els.foodValue.value = state.foodValue ?? '0';
    els.foodScope.value = state.foodScope ?? 'all';
    state.rows.forEach(addRow);
    appendRowIfLastIsUsed(els.playersBody.lastElementChild);
    refreshHostOptions();
    if (state.host) els.host.value = state.host;
    if (state.foodRecipient) els.foodRecipient.value = state.foodRecipient;
  } else {
    els.date.value = todayISO();
    for (let i = 0; i < 4; i++) addRow();
  }
  syncFeeControls();
  updateLiveSummary();
}

function todayISO() {
  const d = new Date();
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d - off).toISOString().slice(0, 10);
}

// ---- Fee control affordances ----------------------------------------------
function syncFeeControls() {
  const feeLabels = {
    perHead: 'Fee per player ($)',
    flat: 'Flat fee total ($)',
    percent: 'Fee (% of pool)',
    none: 'Fee value',
  };
  els.feeValueLabel.textContent = feeLabels[els.feeType.value] || 'Fee value';
  const feeOff = els.feeType.value === 'none';
  els.feeValue.disabled = feeOff;
  els.feeScope.disabled = feeOff;

  // Food has no "off" switch: $0 (or nobody selected) simply means no food.
  const foodLabels = {
    flat: 'Food total ($)',
    perHead: 'Food per player ($)',
    percent: 'Food (% of pool)',
  };
  els.foodValueLabel.textContent = foodLabels[els.foodType.value] || 'Food per player ($)';
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

  // Food is active only when someone fronted it AND the amount is non-zero.
  const foodValue = parseAmount(els.foodValue.value) ?? 0;
  if (Number.isNaN(foodValue)) return showToast('Bad food amount.');
  if (foodValue > 0 && !els.foodRecipient.value) {
    return showToast('Select who paid for food, or set the food amount to $0.');
  }
  const foodCfg =
    foodValue > 0 && els.foodRecipient.value
      ? {
          recipient: els.foodRecipient.value,
          type: els.foodType.value,
          value: foodValue,
          scope: els.foodScope.value,
        }
      : null;

  let ledger;
  try {
    ledger = computeLedger({
      defaultBuyIn: parseAmount(els.buyIn.value) ?? 100,
      date: els.date.value || null,
      host: els.host.value || null,
      fee: {
        type: els.feeType.value,
        value: parseAmount(els.feeValue.value) ?? 0,
        scope: els.feeScope.value,
      },
      food: foodCfg,
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
  const showFood = ledger.hasFood;

  const badges = (r) =>
    (r.isHost ? '<span class="host-badge">HOST</span>' : '') +
    (r.isFoodRecipient ? '<span class="host-badge food">FOOD</span>' : '');

  const rows = ledger.standings
    .map(
      (r) => `
    <tr>
      <td class="num rank-${r.rank}">${r.rank}</td>
      <td>${escapeHtml(r.name)}${badges(r)}</td>
      <td class="num col-detail">${toDollars(r.chipsCents).toFixed(0)}</td>
      <td class="num col-detail">${formatCents(r.buyInCents)}</td>
      ${pnlCell(r.pokerPnlCents)}
      ${pnlCell(r.feeCents)}
      ${showFood ? pnlCell(r.foodCents) : ''}
      ${pnlCell(r.netCents)}
    </tr>`
    )
    .join('');

  const sum = (key) => ledger.standings.reduce((a, r) => a + r[key], 0);
  const dateLabel = ledger.date ? formatDate(ledger.date) : '';

  els.standingsTable.innerHTML = `
    ${dateLabel ? `<caption>${escapeHtml(dateLabel)}</caption>` : ''}
    <thead>
      <tr>
        <th class="num">#</th><th>Player</th>
        <th class="num col-detail">Chips</th><th class="num col-detail">Buy-in</th>
        <th class="num">Poker P&L</th><th class="num">Host fee</th>
        ${showFood ? '<th class="num">Food</th>' : ''}
        <th class="num">Net</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
    <tfoot>
      <tr class="total-row">
        <td></td><td>Total</td>
        <td class="num col-detail">${toDollars(ledger.chipsCents).toFixed(0)}</td>
        <td class="num col-detail">${formatCents(ledger.poolCents)}</td>
        <td class="num">${formatCents(sum('pokerPnlCents'))}</td>
        <td class="num">${formatCents(sum('feeCents'))}</td>
        ${showFood ? `<td class="num">${formatCents(sum('foodCents'))}</td>` : ''}
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
  const rows = ledger.transactions
    .map(
      (t) => `
      <tr class="${settled.has(txnKey(t)) ? 'settled' : ''}" data-key="${escapeHtml(txnKey(t))}">
        <td><input type="checkbox" class="j-paid" ${
          settled.has(txnKey(t)) ? 'checked' : ''
        } aria-label="Mark paid" /></td>
        <td class="neg">${escapeHtml(t.from)}</td>
        <td>→</td>
        <td class="pos">${escapeHtml(t.to)}</td>
        <td class="num">${formatCents(t.amountCents)}</td>
      </tr>`
    )
    .join('');

  els.settlementTable.innerHTML = `
    <thead><tr><th></th><th>Pays</th><th></th><th>Receives</th><th class="num">Amount</th></tr></thead>
    <tbody>${
      rows || '<tr><td class="muted" colspan="5">Everyone is even — no payments needed.</td></tr>'
    }</tbody>`;

  els.settlementTable.querySelectorAll('.j-paid').forEach((box) => {
    box.addEventListener('change', () => {
      const tr = box.closest('tr');
      const key = tr.dataset.key;
      if (box.checked) settled.add(key);
      else settled.delete(key);
      tr.classList.toggle('settled', box.checked);
      saveSettled();
      updateTxnProgress(ledger);
    });
  });

  updateTxnProgress(ledger);
}

function updateTxnProgress(ledger) {
  const total = ledger.transactions.length;
  const done = ledger.transactions.filter((t) => settled.has(txnKey(t))).length;
  els.txnCount.textContent = total
    ? `${done} of ${total} settled`
    : '';
}

// ---- WhatsApp export -------------------------------------------------------
function blastText() {
  const ledger = window.__ledger;
  return ledger ? formatWhatsApp(ledger, { title: 'Poker Night' }) : null;
}

async function copyWhatsApp() {
  const text = blastText();
  if (!text) return;
  els.waOut.textContent = text;
  els.waOut.hidden = false;
  try {
    await navigator.clipboard.writeText(text);
    showToast('Copied — paste into WhatsApp');
  } catch {
    showToast('Copy failed — long-press the text to copy');
  }
}

async function shareWhatsApp() {
  const text = blastText();
  if (!text) return;
  try {
    await navigator.share({ text });
  } catch (err) {
    // AbortError just means the user dismissed the share sheet.
    if (err && err.name !== 'AbortError') copyWhatsApp();
  }
}

// ---- Photo preview (reference only; no upload) -----------------------------
function onPhoto(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  if (els.photoPreview.src) URL.revokeObjectURL(els.photoPreview.src);
  els.photoPreview.src = URL.createObjectURL(file);
  els.photoWrap.hidden = false;
  els.photoDrop.hidden = true;
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

// Autosave keeps a night's ledger safe across accidental reloads / phone locks,
// so a refresh intentionally restores. "New game" is the explicit way to wipe.
function newGame() {
  if (!confirm('Start a new game? This clears all players, chips and settings.')) return;

  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(SETTLED_KEY);
  } catch {
    /* private mode — nothing persisted anyway */
  }
  settled.clear();

  els.date.value = todayISO();
  els.buyIn.value = '100';
  els.feeType.value = 'perHead';
  els.feeValue.value = '5';
  els.feeScope.value = 'all';
  els.foodType.value = 'perHead';
  els.foodValue.value = '0';
  els.foodScope.value = 'all';

  els.playersBody.innerHTML = '';
  for (let i = 0; i < 4; i++) addRow();
  refreshHostOptions();
  els.host.value = '';
  els.foodRecipient.value = '';

  els.pasteText.value = '';
  els.photoInput.value = '';
  if (els.photoPreview.src) URL.revokeObjectURL(els.photoPreview.src);
  els.photoPreview.removeAttribute('src');
  els.photoWrap.hidden = true;
  els.photoDrop.hidden = false;

  els.results.hidden = true;
  els.warnings.hidden = true;
  els.waOut.hidden = true;
  window.__ledger = null;

  syncFeeControls();
  persist();
  showToast('Cleared — ready for a new game');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function loadSample() {
  els.playersBody.innerHTML = '';
  els.date.value = todayISO();
  els.buyIn.value = '100';
  els.feeType.value = 'perHead';
  els.feeValue.value = '5';
  els.feeScope.value = 'all';
  els.foodType.value = 'perHead';
  els.foodValue.value = '0';
  els.foodScope.value = 'all';
  SAMPLE.forEach(addRow);
  refreshHostOptions();
  els.host.value = 'Sudhakar';
  els.foodRecipient.value = '';
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
els.newGameBtn.addEventListener('click', newGame);
els.fillBtn.addEventListener('click', fillFromText);
els.calcBtn.addEventListener('click', calculate);
els.waBtn.addEventListener('click', copyWhatsApp);
if (navigator.share) {
  els.shareBtn.hidden = false;
  els.shareBtn.addEventListener('click', shareWhatsApp);
} else {
  // No share sheet (desktop) — promote Copy to the primary action.
  els.waBtn.classList.remove('ghost');
  els.waBtn.classList.add('primary');
}
els.photoInput.addEventListener('change', onPhoto);
els.changePhotoBtn.addEventListener('click', () => els.photoInput.click());
[els.feeType, els.foodType].forEach((el) =>
  el.addEventListener('change', () => {
    syncFeeControls();
    persist();
  })
);
[
  els.date,
  els.buyIn,
  els.host,
  els.feeValue,
  els.feeScope,
  els.foodRecipient,
  els.foodValue,
  els.foodScope,
].forEach((el) => el.addEventListener('input', persist));

const versionEl = $('appVersion');
if (versionEl) versionEl.textContent = ` · ${APP_VERSION}`;

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
