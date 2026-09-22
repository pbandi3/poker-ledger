import { formatCents, formatDate, txnKey } from './src/engine.js';
import { supabase } from './src/supabaseClient.js';

const $ = (id) => document.getElementById(id);
const els = {
  title: $('payTitle'),
  progress: $('payProgress'),
  table: $('payTable'),
  toast: $('toast'),
};

const gameId = new URLSearchParams(location.search).get('g');

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

let transactions = [];
const paidByKey = new Map();

function render() {
  const done = transactions.filter((t) => paidByKey.get(txnKey(t))).length;
  els.progress.textContent = transactions.length ? `${done} of ${transactions.length} settled` : '';

  if (!transactions.length) {
    els.table.innerHTML =
      '<tbody><tr><td class="muted">Everyone was already even — no payments needed.</td></tr></tbody>';
    return;
  }

  const rows = transactions
    .map((t) => {
      const key = txnKey(t);
      const paid = !!paidByKey.get(key);
      return `
        <tr class="${paid ? 'settled' : ''}" data-key="${escapeHtml(key)}">
          <td><input type="checkbox" class="j-paid" ${paid ? 'checked' : ''} aria-label="Mark paid" /></td>
          <td class="neg">${escapeHtml(t.from)}</td>
          <td>→</td>
          <td class="pos">${escapeHtml(t.to)}</td>
          <td class="num">${formatCents(t.amountCents)}</td>
        </tr>`;
    })
    .join('');

  els.table.innerHTML = `
    <thead><tr><th></th><th>Pays</th><th></th><th>Receives</th><th class="num">Amount</th></tr></thead>
    <tbody>${rows}</tbody>`;

  els.table.querySelectorAll('.j-paid').forEach((box) => {
    box.addEventListener('change', async () => {
      const tr = box.closest('tr');
      const key = tr.dataset.key;
      const paid = box.checked;
      box.disabled = true;
      const { error } = await supabase.from('payments').upsert({
        game_id: gameId,
        txn_key: key,
        paid,
        paid_at: paid ? new Date().toISOString() : null,
      });
      box.disabled = false;
      if (error) {
        box.checked = !paid; // revert on failure
        showToast("Couldn't save — check your connection");
        return;
      }
      paidByKey.set(key, paid);
      tr.classList.toggle('settled', paid);
      render();
    });
  });
}

async function load() {
  if (!gameId) {
    els.title.textContent = 'Missing link';
    els.table.innerHTML = '<tbody><tr><td class="muted">This link is missing its game id.</td></tr></tbody>';
    return;
  }

  const { data: game, error: gameErr } = await supabase
    .from('games')
    .select('ledger')
    .eq('id', gameId)
    .maybeSingle();

  if (gameErr || !game) {
    els.title.textContent = 'Not found';
    els.table.innerHTML =
      '<tbody><tr><td class="muted">This game link is no longer available.</td></tr></tbody>';
    return;
  }

  transactions = game.ledger?.transactions ?? [];
  els.title.textContent = game.ledger?.date
    ? `Poker Night — ${formatDate(game.ledger.date)}`
    : 'Poker Night — Settle Up';

  const { data: payments } = await supabase
    .from('payments')
    .select('txn_key, paid')
    .eq('game_id', gameId);
  (payments ?? []).forEach((p) => paidByKey.set(p.txn_key, p.paid));

  render();

  supabase
    .channel(`payments-${gameId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'payments', filter: `game_id=eq.${gameId}` },
      (payload) => {
        if (!payload.new) return;
        paidByKey.set(payload.new.txn_key, !!payload.new.paid);
        render();
      }
    )
    .subscribe();
}

load();
