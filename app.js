import {
  computeLedger,
  formatWhatsApp,
  formatCents,
  formatDate,
  toDollars,
  txnKey,
} from './src/engine.js';
import { supabase } from './src/supabaseClient.js';
import { mergeDraftStates, stableStringify } from './src/draft.js';

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'poker-ledger-v1';
const SETTLED_KEY = 'poker-ledger-settled-v1';
const KNOWN_NAMES_KEY = 'poker-ledger-known-names-v1';
const DRAFT_KEY = 'poker-ledger-draft-v1';
// Bump alongside CACHE in sw.js; shown in the footer to confirm a deploy landed.
const APP_VERSION = 'v26';

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
  regularsBtn: $('regularsBtn'),
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
  installBtn: $('installBtn'),
  playerNamesList: $('playerNamesList'),
  liveCard: $('liveCard'),
  testToggle: $('testToggle'),
  liveOff: $('liveOff'),
  liveOn: $('liveOn'),
  liveStartBtn: $('liveStartBtn'),
  liveLinkBtn: $('liveLinkBtn'),
  liveStopBtn: $('liveStopBtn'),
  liveDot: $('liveDot'),
  liveStatus: $('liveStatus'),
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
  if (!/^-?[\d+.\s]+$/.test(s)) return NaN;
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

// ---- Name suggestions -------------------------------------------------------
// Cached locally (not fetched on load) so the app stays offline-first; the
// cache is refreshed whenever "Load regulars" already talks to Supabase.
function loadKnownNames() {
  try {
    return JSON.parse(localStorage.getItem(KNOWN_NAMES_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveKnownNames(names) {
  try {
    localStorage.setItem(KNOWN_NAMES_KEY, JSON.stringify(names));
  } catch {
    /* private mode */
  }
}

function populateNameSuggestions(names) {
  els.playerNamesList.innerHTML = names
    .map((n) => `<option value="${escapeHtml(n)}"></option>`)
    .join('');
}

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

// ---- Row management --------------------------------------------------------
function makeRow(data = { name: '', buyIn: '', chips: '' }) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="col-name"><input class="j-name" type="text" placeholder="Name" autocomplete="off" list="playerNamesList" /></td>
    <td class="col-num"><input class="j-buyin" type="text" inputmode="decimal" placeholder="def" /></td>
    <td class="col-num">
      <div class="chips-field">
        <input class="j-chips" type="text" inputmode="decimal" placeholder="0" />
        <button type="button" class="sign-toggle" title="Toggle negative (owes chips)" aria-label="Toggle negative chip count">&plusmn;</button>
      </div>
    </td>
    <td class="col-x"><button class="row-x" title="Remove" aria-label="Remove row">&times;</button></td>`;
  tr.querySelector('.j-name').value = data.name ?? '';
  tr.querySelector('.j-buyin').value = data.buyIn ?? '';
  const chipsInput = tr.querySelector('.j-chips');
  chipsInput.value = data.chips ?? '';
  // Identity + last-edit time let two phones merge the same row (see src/draft.js).
  tr.dataset.rid = data.id || newRowId();
  tr.dataset.t = String(Number(data.t) || 0);
  tr.dataset.sig = rowSig(tr);
  tr.querySelector('.row-x').addEventListener('click', () => {
    tr.remove();
    refreshHostOptions();
    persist();
  });
  const updateNegativeState = () => {
    const negative = chipsInput.value.trim().startsWith('-');
    chipsInput.classList.toggle('is-negative', negative);
    tr.querySelector('.sign-toggle').classList.toggle('active', negative);
  };
  tr.querySelector('.sign-toggle').addEventListener('click', () => {
    const raw = chipsInput.value.trim();
    chipsInput.value = raw.startsWith('-') ? raw.slice(1).trim() : `-${raw}`;
    chipsInput.dispatchEvent(new Event('input', { bubbles: true }));
    chipsInput.focus();
  });
  updateNegativeState();
  tr._refreshNegative = updateNegativeState;
  tr.querySelectorAll('input').forEach((inp) => {
    inp.addEventListener('input', () => {
      if (inp.classList.contains('j-name')) refreshHostOptions();
      if (inp === chipsInput) updateNegativeState();
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
  if (draft) trackDraftChanges();
  const state = { ...readSettings(), rows: liveRows(), test: testMode };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage full / private mode — non-fatal */
  }
  updateLiveSummary();
  if (draft) scheduleDraftPush();
}

function restore() {
  let state = null;
  try {
    state = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    state = null;
  }
  testMode = !!state?.test;
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

  // Host fee is active only when someone is set to receive it AND the amount is non-zero.
  const feeValue = parseAmount(els.feeValue.value) ?? 0;
  if (Number.isNaN(feeValue)) return showToast('Bad host fee amount.');
  if (els.feeType.value !== 'none' && feeValue > 0 && !els.host.value) {
    return showToast('Select who received the host fee, or set fee type to No fee.');
  }

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
        value: feeValue,
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
      if (currentGameId && !testMode) {
        supabase
          .from('payments')
          .upsert({
            game_id: currentGameId,
            txn_key: key,
            paid: box.checked,
            paid_at: box.checked ? new Date().toISOString() : null,
          })
          .then(({ error }) => {
            if (error) showToast("Couldn't sync payment status");
          });
      }
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

// ---- Share for payment (Supabase) -------------------------------------
// Publishes the settlement plan so anyone with the link can mark their own
// payment paid from their phone, synced live back here via Realtime.
let currentGameId = null;
let paymentsChannel = null;

function genGameId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => (b % 36).toString(36))
    .join('');
}

function paymentsUrl(id) {
  const base = new URL('./pay.html', location.href);
  base.searchParams.set('g', id);
  return base.toString();
}

async function pushLocalPaymentsToSupabase(ledger) {
  const rows = ledger.transactions
    .filter((t) => settled.has(txnKey(t)))
    .map((t) => ({
      game_id: currentGameId,
      txn_key: txnKey(t),
      paid: true,
      paid_at: new Date().toISOString(),
    }));
  if (rows.length) await supabase.from('payments').upsert(rows);
}

function applyRemotePaidState(key, paid) {
  if (paid) settled.add(key);
  else settled.delete(key);
  saveSettled();
  const tr = els.settlementTable.querySelector(`tr[data-key="${CSS.escape(key)}"]`);
  if (tr) {
    tr.classList.toggle('settled', paid);
    const box = tr.querySelector('.j-paid');
    if (box) box.checked = paid;
  }
  if (window.__ledger) updateTxnProgress(window.__ledger);
}

function subscribeToPayments() {
  if (paymentsChannel) supabase.removeChannel(paymentsChannel);
  paymentsChannel = supabase
    .channel(`payments-${currentGameId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'payments', filter: `game_id=eq.${currentGameId}` },
      (payload) => {
        if (!payload.new) return;
        applyRemotePaidState(payload.new.txn_key, !!payload.new.paid);
      }
    )
    .subscribe();
}

function stopSharing() {
  if (paymentsChannel) {
    supabase.removeChannel(paymentsChannel);
    paymentsChannel = null;
  }
  currentGameId = null;
}

// Publishes (or updates) the settlement plan in Supabase and returns its
// payment link. Throws on failure — callers decide how to degrade.
async function publishForPayment(ledger) {
  if (testMode) throw new Error('test game — nothing is saved online');
  const snapshot = {
    date: ledger.date,
    host: ledger.host,
    standings: ledger.standings,
    transactions: ledger.transactions,
    netSumCents: ledger.netSumCents,
  };
  if (!currentGameId && draft) {
    // Every phone on a live game must publish to the same game row and pay link.
    const id = await claimDraftGameId();
    const { error } = await supabase.from('games').upsert(
      { id, date: ledger.date, host: ledger.host, ledger: snapshot, updated_at: new Date().toISOString() },
      { onConflict: 'id' }
    );
    if (error) throw error;
    currentGameId = id;
    await pushLocalPaymentsToSupabase(ledger);
    subscribeToPayments();
  } else if (!currentGameId) {
    let id = genGameId();
    for (let attempt = 0; ; attempt += 1) {
      const { error } = await supabase
        .from('games')
        .insert({ id, date: ledger.date, host: ledger.host, ledger: snapshot });
      if (!error) {
        currentGameId = id;
        break;
      }
      if (error.code !== '23505' || attempt >= 2) throw error; // not a PK collision, or out of retries
      id = genGameId();
    }
    await pushLocalPaymentsToSupabase(ledger);
    subscribeToPayments();
  } else {
    const { error } = await supabase
      .from('games')
      .update({
        ledger: snapshot,
        date: ledger.date,
        host: ledger.host,
        updated_at: new Date().toISOString(),
      })
      .eq('id', currentGameId);
    if (error) throw error;
  }
  return paymentsUrl(currentGameId);
}

// ---- Live shared game (Supabase) --------------------------------------------
// Two phones, one game. The in-progress game lives in a `drafts` row that every
// phone saves to and listens on. A phone only saves if the version it started
// from is still current; otherwise it merges the newer copy in first (see
// src/draft.js), so one phone never silently overwrites the other.
let draft = null; // { id, version, removed, settingsT, settingsSig, lastRows, maxT } — also kept in localStorage
let draftChannel = null;
let draftPushTimer = null;
let draftPushing = false;
let draftPushAgain = false;
// A test game is never sent to Supabase: no live sync, no pay link, no saved game.
let testMode = false;
let lastServerJson = ''; // stableStringify of the last state known to match the server

// Row ids sort in creation order (time, then a counter for rows made in the same
// millisecond), so the shared row list has one natural order on every phone.
let rowSeq = 0;
function newRowId() {
  rowSeq = (rowSeq + 1) % 46656;
  return Date.now().toString(36) + rowSeq.toString(36).padStart(3, '0') + genGameId().slice(0, 3);
}

// Edit timestamps must beat everything this phone has already seen, even when its
// clock runs behind the other phone's, so an edit made after seeing a change
// always wins over it.
function nextT() {
  const t = Math.max(Date.now(), (draft?.maxT ?? 0) + 1);
  if (draft) draft.maxT = t;
  return t;
}

function noteMaxT(state) {
  draft.maxT = Math.max(
    draft.maxT ?? 0,
    state.settingsT ?? 0,
    ...state.rows.map((r) => r.t ?? 0),
    ...Object.values(state.removed ?? {})
  );
}

function readSettings() {
  return {
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
  };
}

const rowSig = (tr) =>
  ['.j-name', '.j-buyin', '.j-chips'].map((cls) => tr.querySelector(cls).value).join('\u0001');
const isRowEmpty = (tr) => [...tr.querySelectorAll('input')].every((i) => i.value.trim() === '');

// A row is part of the shared game once anything is typed in it; the empty
// spare row at the bottom stays private to each phone.
function liveRows() {
  return [...els.playersBody.querySelectorAll('tr')]
    .map((tr) => ({
      id: tr.dataset.rid,
      name: tr.querySelector('.j-name').value.trim(),
      buyIn: tr.querySelector('.j-buyin').value.trim(),
      chips: tr.querySelector('.j-chips').value.trim(),
      t: Number(tr.dataset.t) || 0,
    }))
    .filter((r) => r.name || r.buyIn || r.chips);
}

function loadDraftMeta() {
  try {
    return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
  } catch {
    return null;
  }
}

function saveDraftMeta() {
  try {
    if (draft) localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* private mode */
  }
}

function buildDraftState() {
  return {
    settings: readSettings(),
    settingsT: draft.settingsT,
    rows: liveRows().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    removed: { ...draft.removed },
  };
}

// Runs on every local change: stamp what was edited, record removed rows, and
// keep the saved bookkeeping current (so a reload can't lose a removal).
function trackDraftChanges() {
  const now = nextT();
  for (const tr of els.playersBody.querySelectorAll('tr')) {
    const sig = rowSig(tr);
    if (sig !== tr.dataset.sig) {
      tr.dataset.sig = sig;
      tr.dataset.t = String(now);
    }
  }
  const settingsSig = JSON.stringify(readSettings());
  if (settingsSig !== draft.settingsSig) {
    draft.settingsSig = settingsSig;
    draft.settingsT = now;
  }
  const ids = liveRows().map((r) => r.id);
  const alive = new Set(ids);
  for (const id of draft.lastRows) if (!alive.has(id)) draft.removed[id] = now;
  draft.lastRows = ids;
  saveDraftMeta();
}

// Write a merged state into the page without touching whatever the person is
// typing in right now, and without counting it as a local edit.
function applyDraftState(state) {
  const s = state.settings ?? {};
  let selectUnsettable = false;
  const setField = (el, value) => {
    if (value !== undefined && el.value !== value) el.value = value;
  };
  const setSelect = (el, value) => {
    if (value === undefined || el.value === value) return;
    if ([...el.options].some((o) => o.value === value)) el.value = value;
    else selectUnsettable = true; // e.g. the host's row isn't here; this phone's choice stands
  };
  setField(els.date, s.date);
  setField(els.buyIn, s.buyIn);
  setField(els.feeType, s.feeType);
  setField(els.feeValue, s.feeValue);
  setField(els.feeScope, s.feeScope);
  setField(els.foodType, s.foodType);
  setField(els.foodValue, s.foodValue);
  setField(els.foodScope, s.foodScope);

  const wanted = new Set(state.rows.map((r) => r.id));
  for (const tr of [...els.playersBody.querySelectorAll('tr')]) {
    if (!wanted.has(tr.dataset.rid) && !isRowEmpty(tr)) tr.remove(); // removed on another phone
  }
  const have = new Map([...els.playersBody.querySelectorAll('tr')].map((tr) => [tr.dataset.rid, tr]));
  for (const r of state.rows) {
    const tr = have.get(r.id);
    if (!tr) {
      const fresh = makeRow(r);
      const last = els.playersBody.lastElementChild;
      if (last && isRowEmpty(last)) els.playersBody.insertBefore(fresh, last);
      else els.playersBody.appendChild(fresh);
      continue;
    }
    for (const [cls, key] of [
      ['.j-name', 'name'],
      ['.j-buyin', 'buyIn'],
      ['.j-chips', 'chips'],
    ]) {
      const input = tr.querySelector(cls);
      const value = r[key] ?? '';
      if (input.value !== value) input.value = value;
    }
    tr._refreshNegative?.();
    tr.dataset.t = String(r.t ?? 0);
    tr.dataset.sig = rowSig(tr);
  }

  refreshHostOptions();
  setSelect(els.host, s.host);
  setSelect(els.foodRecipient, s.foodRecipient);
  syncFeeControls();
  const last = els.playersBody.lastElementChild;
  if (!last) addRow();
  else appendRowIfLastIsUsed(last);

  noteMaxT(state);
  draft.settingsT = selectUnsettable ? nextT() : (state.settingsT ?? 0);
  draft.settingsSig = JSON.stringify(readSettings());
  draft.removed = { ...state.removed };
  draft.lastRows = liveRows().map((r) => r.id);
  saveDraftMeta();
  updateLiveSummary();
}

function adoptGameId(row) {
  if (row?.game_id && !currentGameId) {
    currentGameId = row.game_id;
    subscribeToPayments();
  }
}

// Merge a copy from the server into this phone (no network, no persist).
function mergeRemote(remote) {
  if (draft.maxT === undefined) draft.maxT = 0;
  applyDraftState(mergeDraftStates(buildDraftState(), remote.state));
  draft.version = Math.max(draft.version, remote.version);
  adoptGameId(remote);
}

function adoptRemote(remote) {
  mergeRemote(remote);
  const remoteJson = stableStringify(remote.state);
  if (stableStringify(buildDraftState()) === remoteJson) lastServerJson = remoteJson;
  persist(); // saves locally; schedules a push only if this phone still has newer edits
}

async function fetchDraftRow(id) {
  const { data, error } = await supabase
    .from('drafts')
    .select('state, version, game_id')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

function setSyncStatus(status) {
  els.liveStatus.textContent = { ok: 'Synced', pending: 'Saving…', offline: 'Offline — will retry' }[status];
  els.liveDot.dataset.state = status;
}

function renderLiveBar() {
  els.liveOff.hidden = !!draft || testMode;
  els.liveOn.hidden = !draft;
  els.testToggle.checked = testMode;
  // Once a game is live or has a pay link it is already saved online.
  els.testToggle.disabled = !!draft || !!currentGameId;
  els.liveCard.classList.toggle('is-test', testMode);
  els.liveLinkBtn.textContent = navigator.share ? 'Share link' : 'Copy link';
}

function scheduleDraftPush() {
  if (!draft) return;
  setSyncStatus('pending');
  clearTimeout(draftPushTimer);
  draftPushTimer = setTimeout(pushDraft, 700);
}

async function pushDraft() {
  if (!draft || testMode) return;
  if (draftPushing) {
    draftPushAgain = true;
    return;
  }
  draftPushing = true;
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const state = buildDraftState();
      if (stableStringify(state) === lastServerJson) {
        setSyncStatus('ok');
        return;
      }
      const { data, error } = await supabase
        .from('drafts')
        .update({ state, version: draft.version + 1, updated_at: new Date().toISOString() })
        .eq('id', draft.id)
        .eq('version', draft.version)
        .select('version, game_id');
      if (error) throw error;
      if (data.length === 1) {
        draft.version = data[0].version;
        lastServerJson = stableStringify(state);
        adoptGameId(data[0]);
        saveDraftMeta();
        setSyncStatus('ok');
        return;
      }
      // Another phone saved first: merge their copy in, then save on top of it.
      const remote = await fetchDraftRow(draft.id);
      if (!remote) throw new Error('shared game not found');
      mergeRemote(remote);
    }
    draftPushAgain = true; // still racing another phone; try again shortly
  } catch {
    setSyncStatus('offline');
    clearTimeout(draftPushTimer);
    draftPushTimer = setTimeout(scheduleDraftPush, 5000);
  } finally {
    draftPushing = false;
    if (draftPushAgain) {
      draftPushAgain = false;
      scheduleDraftPush();
    }
  }
}

// Catch up on anything missed (phone asleep, connection dropped) and save
// anything this phone changed while it was away.
async function refreshDraft() {
  if (!draft) return;
  try {
    const remote = await fetchDraftRow(draft.id);
    if (!remote) return;
    adoptGameId(remote);
    if (remote.version > draft.version) {
      adoptRemote(remote);
      return;
    }
    const local = stableStringify(buildDraftState());
    if (local === stableStringify(remote.state)) {
      lastServerJson = local;
      setSyncStatus('ok');
    } else {
      scheduleDraftPush();
    }
  } catch {
    setSyncStatus('offline');
  }
}

function subscribeToDraft() {
  if (draftChannel) supabase.removeChannel(draftChannel);
  draftChannel = supabase
    .channel(`draft-${draft.id}`)
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'drafts', filter: `id=eq.${draft.id}` },
      (payload) => {
        const row = payload.new;
        if (!row || !draft) return;
        adoptGameId(row); // the game id can arrive without a version bump
        if (row.version > draft.version) adoptRemote(row);
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') refreshDraft();
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setSyncStatus('offline');
    });
}

function liveUrl() {
  const url = new URL('./index.html', location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('d', draft.id);
  return url.toString();
}

async function shareLiveLink() {
  if (!draft) return;
  const url = liveUrl();
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Poker Night — live game', text: 'Join the live game:', url });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    showToast('Link copied — open it on the other phone');
  } catch {
    showToast(url);
  }
}

function leaveDraft() {
  if (draftChannel) {
    supabase.removeChannel(draftChannel);
    draftChannel = null;
  }
  clearTimeout(draftPushTimer);
  draft = null;
  lastServerJson = '';
  draftPushAgain = false;
  saveDraftMeta();
  renderLiveBar();
}

async function startLiveGame() {
  if (testMode) return showToast("Test games aren't shared — untick Test game first");
  els.liveStartBtn.disabled = true;
  try {
    const now = Date.now();
    for (const tr of els.playersBody.querySelectorAll('tr')) {
      tr.dataset.sig = rowSig(tr);
      tr.dataset.t = String(now);
    }
    const candidate = {
      id: genGameId(),
      version: 1,
      removed: {},
      settingsT: now,
      settingsSig: JSON.stringify(readSettings()),
      lastRows: liveRows().map((r) => r.id),
      maxT: now,
    };
    draft = candidate; // only so buildDraftState can read it
    const state = buildDraftState();
    draft = null; // not shared until the server has it
    for (let attempt = 0; ; attempt += 1) {
      // If this game already has a pay link, carry it over so the other phone
      // updates that same game instead of creating a second one.
      const { error } = await supabase
        .from('drafts')
        .insert({ id: candidate.id, state, version: 1, game_id: currentGameId });
      if (!error) break;
      if (error.code !== '23505' || attempt >= 2) throw error;
      candidate.id = genGameId();
    }
    draft = candidate;
    lastServerJson = stableStringify(state);
    saveDraftMeta();
    subscribeToDraft();
    setSyncStatus('ok');
    renderLiveBar();
    trackDraftChanges(); // anything typed while the request was in flight
    scheduleDraftPush();
    showToast('Live game started — tap Share link to send it to your other phone');
  } catch (err) {
    draft = null;
    saveDraftMeta();
    renderLiveBar();
    const missing = /drafts|schema cache/i.test(err.message || '');
    showToast(
      missing
        ? "Live game isn't set up yet — run supabase/drafts.sql in Supabase first"
        : `Couldn't start live game: ${err.message || 'network error'}`
    );
  } finally {
    els.liveStartBtn.disabled = false;
  }
}

async function joinDraft(id) {
  if (liveRows().length > 0 && !confirm('Join this shared game? It replaces the game currently on this phone.')) {
    return;
  }
  try {
    const remote = await fetchDraftRow(id);
    if (!remote) {
      showToast('That shared game was not found');
      return;
    }
    leaveDraft();
    testMode = false; // a game you join is a real, shared one
    els.playersBody.innerHTML = '';
    els.results.hidden = true;
    els.warnings.hidden = true;
    els.waOut.hidden = true;
    window.__ledger = null;
    stopSharing();
    draft = {
      id,
      version: 0,
      removed: {},
      settingsT: 0,
      settingsSig: JSON.stringify(readSettings()),
      lastRows: [],
      maxT: 0,
    };
    adoptRemote(remote);
    subscribeToDraft();
    renderLiveBar();
    setSyncStatus('ok');
    history.replaceState(null, '', location.pathname);
    showToast('Joined the shared game');
  } catch (err) {
    showToast(`Couldn't join: ${err.message || 'network error'}`);
  }
}

// On load: open a shared link if one was tapped, otherwise rejoin the shared
// game this phone was already in.
async function resumeOrJoinDraft() {
  const joinId = new URLSearchParams(location.search).get('d');
  const saved = loadDraftMeta();
  if (joinId && saved?.id !== joinId) return joinDraft(joinId);
  if (joinId) history.replaceState(null, '', location.pathname);
  if (!saved) return;
  draft = saved;
  lastServerJson = '';
  subscribeToDraft();
  renderLiveBar();
  setSyncStatus('pending');
  await refreshDraft();
}

document.addEventListener('visibilitychange', () => {
  if (!draft) return;
  if (document.hidden) pushDraft();
  else refreshDraft();
});
window.addEventListener('online', refreshDraft);

// Every phone on a live game publishes to the same game row: the first one to
// publish claims a game id on the draft, the others reuse it.
async function claimDraftGameId() {
  const existing = await fetchDraftRow(draft.id);
  if (existing?.game_id) return existing.game_id;
  const id = genGameId();
  const { data, error } = await supabase
    .from('drafts')
    .update({ game_id: id })
    .eq('id', draft.id)
    .is('game_id', null)
    .select('game_id');
  if (error) throw error;
  if (data.length === 1) return id;
  const again = await fetchDraftRow(draft.id); // another phone claimed it first
  if (again?.game_id) return again.game_id;
  throw new Error('could not agree on a game id');
}

// ---- WhatsApp export -------------------------------------------------------
async function blastText() {
  const ledger = window.__ledger;
  if (!ledger) return null;

  let payLink = null;
  if (!testMode && ledger.balanced && ledger.transactions.length) {
    try {
      payLink = await publishForPayment(ledger);
      renderLiveBar(); // now saved online, so it can no longer be a test game
    } catch (err) {
      showToast(`Payment link unavailable (${err.message || 'network error'}) — sharing standings only`);
    }
  }
  return formatWhatsApp(ledger, { title: testMode ? 'Poker Night (Test)' : 'Poker Night', payLink });
}

async function copyWhatsApp() {
  const text = await blastText();
  if (!text) return;
  els.waOut.textContent = text;
  els.waOut.hidden = false;
  try {
    await navigator.clipboard.writeText(text);
    showToast(testMode ? 'Copied (test game — no pay link)' : 'Copied — paste into WhatsApp');
  } catch {
    showToast('Copy failed — long-press the text to copy');
  }
}

async function shareWhatsApp() {
  const text = await blastText();
  if (!text) return;
  try {
    await navigator.share({ text });
  } catch (err) {
    // AbortError just means the user dismissed the share sheet.
    if (err && err.name !== 'AbortError') copyWhatsApp();
  }
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
  const msg = draft
    ? 'Start a new game? This clears this phone and stops syncing it; the shared game stays on your other phones.'
    : 'Start a new game? This clears all players, chips and settings.';
  if (!confirm(msg)) return;
  leaveDraft();

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

  els.results.hidden = true;
  els.warnings.hidden = true;
  els.waOut.hidden = true;
  window.__ledger = null;
  stopSharing();
  testMode = false;
  renderLiveBar();

  syncFeeControls();
  persist();
  showToast('Cleared — ready for a new game');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Pulls names from every shared game's standings and fills the roster with
// anyone who's played MIN_REGULAR_GAMES+ times — a quick start for a group
// that mostly repeats week to week. Leaves date/buy-in/fee settings alone.
const MIN_REGULAR_GAMES = 3;

async function loadRegulars() {
  els.regularsBtn.disabled = true;
  try {
    const { data: games, error } = await supabase.from('games').select('ledger');
    if (error) throw error;

    const counts = new Map();
    for (const g of games ?? []) {
      const names = new Set((g.ledger?.standings ?? []).map((s) => s?.name).filter(Boolean));
      for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
    }

    // Refresh the name-suggestion cache with everyone ever seen, not just
    // regulars — a one-time player's name is still worth suggesting later.
    const allNames = [...counts.keys()].sort((a, b) => a.localeCompare(b));
    saveKnownNames(allNames);
    populateNameSuggestions(allNames);

    const regulars = [...counts.entries()]
      .filter(([, count]) => count >= MIN_REGULAR_GAMES)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name]) => name);

    if (!regulars.length) {
      return showToast(`No players with ${MIN_REGULAR_GAMES}+ games yet.`);
    }

    els.playersBody.innerHTML = '';
    regulars.forEach((name) => addRow({ name, buyIn: '', chips: '' }));
    addRow(); // spare row for a late arrival
    refreshHostOptions();
    persist();
    showToast(`Loaded ${regulars.length} regular${regulars.length === 1 ? '' : 's'} (${MIN_REGULAR_GAMES}+ games) — add chips and buy-ins`);
  } catch (err) {
    showToast(`Couldn't load regulars: ${err.message || 'network error'}`);
  } finally {
    els.regularsBtn.disabled = false;
  }
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
els.regularsBtn.addEventListener('click', loadRegulars);
els.sampleBtn.addEventListener('click', loadSample);
els.newGameBtn.addEventListener('click', newGame);
els.liveStartBtn.addEventListener('click', startLiveGame);
els.testToggle.addEventListener('change', () => {
  if (els.testToggle.checked && (draft || currentGameId)) {
    els.testToggle.checked = false;
    showToast('This game is already saved online');
    return;
  }
  const leavingTest = testMode && !els.testToggle.checked;
  testMode = els.testToggle.checked;
  if (leavingTest) {
    // Payment ticks are remembered by payer/payee/amount, not by game, so ticks
    // made during a test would otherwise be published with the real game.
    settled.clear();
    saveSettled();
    if (window.__ledger) renderSettlement(window.__ledger);
  }
  renderLiveBar();
  persist();
  showToast(testMode ? 'Test game — nothing will be saved online' : 'Back to a real game');
});
els.liveLinkBtn.addEventListener('click', shareLiveLink);
els.liveStopBtn.addEventListener('click', () => {
  if (!confirm('Stop syncing on this phone? Your copy stays here; other phones keep the shared game.')) return;
  leaveDraft();
  showToast('Stopped syncing on this phone');
});
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

populateNameSuggestions(loadKnownNames());
restore();
renderLiveBar();
resumeOrJoinDraft();

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
