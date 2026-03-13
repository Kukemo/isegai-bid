// ============================================================
//  ISEKAI Guild Bid System — Frontend JS
// ============================================================

let ME = null;
let DASH = null;

// ---- Toast ----
function toast(type, msg) {
  const el = document.getElementById('toast');
  el.className = 'toast ' + (type === 'ok' ? 'ok' : 'err');
  el.textContent = msg;
  setTimeout(() => { el.className = 'toast'; el.textContent = ''; }, 3500);
}

// ---- Time helpers (WIB = UTC+7) ----
function pad2(n) { return String(n).padStart(2, '0'); }

function timeNowUtc7() {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
}

function toUtc7Display(utcIso) {
  if (!utcIso) return '';
  const ms = Date.parse(utcIso);
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms + 7 * 3600 * 1000);
  return pad2(d.getUTCDate()) + '/' + pad2(d.getUTCMonth() + 1) + ', ' +
         pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
}

function toUtc7InputValue(utcIso) {
  if (!utcIso) return '';
  const ms = Date.parse(utcIso);
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms + 7 * 3600 * 1000);
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate())
       + 'T' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
}

function toUtcIsoFromUtc7LocalInput(localVal) {
  if (!localVal) return '';
  const parts = localVal.split('T');
  if (parts.length !== 2) return '';
  const ymd = parts[0].split('-').map(Number);
  const hm  = parts[1].split(':').map(Number);
  if (ymd.length !== 3 || hm.length < 2) return '';
  const utcMs = Date.UTC(ymd[0], ymd[1] - 1, ymd[2], hm[0] - 7, hm[1], 0, 0);
  const iso = new Date(utcMs).toISOString();
  return Number.isNaN(Date.parse(iso)) ? '' : iso;
}

function toUtc7HHMM(dt) {
  if (!dt) return '—';
  const iso = dt.indexOf('T') >= 0 ? dt : (dt.replace(' ', 'T') + 'Z');
  const ms  = Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  const d = new Date(ms + 7 * 3600 * 1000);
  return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
}

// ---- Section minimize/restore ----
function toggleSection(id) {
  const body = document.getElementById(id);
  const chev = document.getElementById('chev-' + id);
  const isMin = body.classList.toggle('min');
  chev.textContent = isMin ? '+' : '–';
  try { localStorage.setItem('min_' + id, isMin ? '1' : '0'); } catch (e) {}
}

function restoreSections() {
  ['secMembers', 'secItems', 'secFinals'].forEach(id => {
    let v = '0';
    try { v = localStorage.getItem('min_' + id) || '0'; } catch (e) {}
    const body = document.getElementById(id);
    const chev = document.getElementById('chev-' + id);
    if (v === '1') { body.classList.add('min'); chev.textContent = '+'; }
    else           { body.classList.remove('min'); chev.textContent = '–'; }
  });
}

// ---- Load current user ----
async function loadMe() {
  const me = await fetch('/api/me').then(r => r.json());
  if (!me.logged_in) { location.href = '/login'; return null; }
  ME = me;

  document.getElementById('who').textContent = me.member.nickname;
  document.getElementById('available').textContent = me.member.available_points;

  const heldEl = document.getElementById('heldPts');
  if (heldEl) heldEl.textContent = me.member.held_points;

  const bar   = document.getElementById('deadlineBar');
  const btn   = document.getElementById('bidBtn');
  const badge = document.getElementById('deadlineBadge');

  // Badge deadline
  badge.textContent = me.bid_deadline_utc ? toUtc7Display(me.bid_deadline_utc) : '—';

  // Deadline bar
  if (me.bid_deadline_utc) {
    const deadlineTxt = toUtc7Display(me.bid_deadline_utc);
    bar.style.display = 'block';
    if (me.bid_closed) {
      bar.innerHTML = '🔒 BID CLOSED — Deadline sudah lewat<small>Deadline: ' + deadlineTxt + ' (UTC+7)</small>';
      bar.className = 'deadline-bar';
      btn.disabled = true; btn.style.opacity = 0.45; btn.style.cursor = 'not-allowed';
    } else {
      bar.innerHTML = '⏰ Deadline Bid: <strong>' + deadlineTxt + '</strong> (UTC+7)<small>Jika lewat deadline, bid berhenti &amp; auto-finalize.</small>';
      bar.className = 'deadline-bar open-state';
      btn.disabled = false; btn.style.opacity = ''; btn.style.cursor = '';
    }
  } else {
    bar.style.display = 'none';
    btn.disabled = false; btn.style.opacity = ''; btn.style.cursor = '';
  }

  // Admin panels
  const adminLeft  = document.getElementById('adminLeft');
  const adminRight = document.getElementById('adminRight');
  if (adminLeft)  adminLeft.style.display  = me.is_admin ? 'block' : 'none';
  if (adminRight) adminRight.style.display = me.is_admin ? 'block' : 'none';

  if (me.is_admin) {
    const dlEl = document.getElementById('deadlineLocal');
    if (dlEl) dlEl.value = toUtc7InputValue(me.bid_deadline_utc || '');
  }
  return me;
}

// ---- Load item dropdown ----
async function loadOptions() {
  const items = await fetch('/api/items').then(r => r.json());
  const sel = document.getElementById('item');
  const openItems = items.filter(i => i.status === 'OPEN');
  sel.innerHTML = openItems.length
    ? openItems.map(i => `<option value="${i.name}">${i.name}</option>`).join('')
    : '<option disabled>— Tidak ada item OPEN —</option>';
}

function quickSet() {
  document.getElementById('amount').value = parseInt(document.getElementById('quick').value, 10);
}

// ---- Dashboard ----
async function loadDashboard(tablesOnly) {
  const data = await fetch('/api/dashboard').then(r => r.json());
  DASH = data;

  // Members table
  document.getElementById('membersTbody').innerHTML = data.members.map(m => `
    <tr>
      <td title="${m.nickname}"><strong>${m.nickname}</strong></td>
      <td class="right">${m.points_total}</td>
      <td class="right">${m.held_points}</td>
      <td class="right"><strong>${m.available_points}</strong></td>
    </tr>`
  ).join('');

  // Items table
  document.getElementById('itemsTbody').innerHTML = data.items.map(i => {
    const t = i.highest_time ? toUtc7HHMM(i.highest_time) : '—';
    const statusEl = i.status === 'OPEN'
      ? '<span class="status-open">OPEN</span>'
      : '<span class="status-closed">CLOSED</span>';
    return `<tr>
      <td title="${i.name}"><strong>${i.name}</strong></td>
      <td>${statusEl}</td>
      <td title="${i.highest_nickname || '—'}">${i.highest_nickname || '—'}</td>
      <td class="right">${i.highest_amount || '—'}</td>
      <td>${t}</td>
    </tr>`;
  }).join('');

  // Finals table
  const finals = data.finals || [];
  document.getElementById('finalsTbody').innerHTML = finals.length
    ? finals.map(f => `<tr class="winner-row">
        <td title="${f.item_name}"><strong>${f.item_name}</strong></td>
        <td title="${f.winner}">🏆 ${f.winner}</td>
        <td class="right"><strong>${f.amount}</strong></td>
        <td title="${f.finalized_at}">${toUtc7HHMM(f.finalized_at)}</td>
      </tr>`).join('')
    : '<tr><td colspan="4" class="center" style="color:var(--faint);padding:18px">Belum ada finalize.</td></tr>';

  document.getElementById('lastUpdated').textContent = 'Updated: ' + timeNowUtc7();
  updateHighestForSelectedItem();

  if (!tablesOnly && ME && ME.is_admin) {
    populateAdminDropdowns();
    await loadBidLog();
  }
}

function updateHighestForSelectedItem() {
  const itemName = document.getElementById('item').value;
  const found    = DASH && DASH.items ? DASH.items.find(x => x.name === itemName) : null;
  document.getElementById('highest').textContent =
    (found && found.highest_amount)
      ? found.highest_amount + ' (' + found.highest_nickname + ')'
      : '—';
}

async function refreshAll() {
  await loadMe();
  await loadOptions();
  await loadDashboard(false);
  toast('ok', 'Data berhasil direfresh.');
}

// ---- Bid ----
async function placeBid() {
  const itemName = document.getElementById('item').value;
  const amount   = parseInt(document.getElementById('amount').value, 10);
  if (!itemName || itemName.startsWith('—')) return toast('err', 'Tidak ada item OPEN.');
  if (!amount || amount < 1) return toast('err', 'Bid minimal 1.');

  const btn = document.getElementById('bidBtn');
  btn.disabled = true;

  const resp = await fetch('/api/bid', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemName, amount })
  });
  const data = await resp.json();
  btn.disabled = false;

  if (!resp.ok) { toast('err', data.error || 'Gagal bid.'); await refreshAll(); return; }
  toast('ok', data.message || 'Bid diterima!');
  await refreshAll();
}

// ---- Auth ----
async function logout() {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login';
}

async function openAdmin() {
  const pw = prompt('Masukkan password admin:');
  if (!pw) return;
  const resp = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw })
  });
  const data = await resp.json();
  if (!resp.ok) return toast('err', data.error || 'Gagal admin login.');
  toast('ok', data.message || 'Admin aktif.');
  await loadImportUrls();
  await refreshAll();
}

async function adminLogout() {
  const resp = await fetch('/api/admin/logout', { method: 'POST' });
  const data = await resp.json();
  toast('ok', data.message || 'Admin off.');
  await refreshAll();
}

// ---- Admin dropdowns ----
function populateAdminDropdowns() {
  const members  = DASH && DASH.members ? DASH.members : [];
  const itemsAll = DASH && DASH.items   ? DASH.items   : [];
  const itemsOpen = itemsAll.filter(i => i.status === 'OPEN');

  const memOpt = members.map(m => `<option value="${m.nickname}">${m.nickname}</option>`).join('');
  const aM = document.getElementById('adminMember'); if (aM) aM.innerHTML = memOpt;
  const dM = document.getElementById('delMember');   if (dM) dM.innerHTML = memOpt;

  const fI = document.getElementById('finalizeItem');
  if (fI) fI.innerHTML = itemsOpen.map(i => `<option value="${i.name}">${i.name}</option>`).join('');

  const dI = document.getElementById('delItem');
  if (dI) dI.innerHTML = itemsAll.map(i => `<option value="${i.name}">${i.name}</option>`).join('');
}

async function loadBidLog() {
  const el    = document.getElementById('finalizeItem');
  const tbody = document.getElementById('logTbody');
  if (!tbody) return;
  const itemName = el ? el.value : '';
  if (!itemName) {
    tbody.innerHTML = '<tr><td colspan="3" class="center" style="color:var(--faint);padding:14px">Pilih item OPEN untuk melihat log.</td></tr>';
    return;
  }
  const resp = await fetch('/api/admin/bids?itemName=' + encodeURIComponent(itemName));
  const data = await resp.json();
  if (!resp.ok) {
    tbody.innerHTML = '<tr><td colspan="3">Gagal memuat log.</td></tr>';
    return;
  }
  tbody.innerHTML = (data.bids || []).map(b =>
    `<tr><td title="${b.created_at}">${b.created_at}</td><td><strong>${b.nickname}</strong></td><td class="right">${b.amount}</td></tr>`
  ).join('') || '<tr><td colspan="3" class="center" style="color:var(--faint);padding:14px">Belum ada bid.</td></tr>';
}

// ---- Admin: Member CRUD ----
async function addMember() {
  const nickname     = document.getElementById('newMember').value.trim();
  const points_total = parseInt(document.getElementById('newMemberPoints').value, 10);
  const resp = await fetch('/api/admin/add-member', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname, points_total })
  });
  const data = await resp.json();
  if (!resp.ok) return toast('err', data.error || 'Gagal tambah member.');
  toast('ok', data.message || 'Member ditambah.');
  document.getElementById('newMember').value = '';
  await refreshAll();
}

async function deleteMember() {
  const nickname = document.getElementById('delMember').value;
  if (!confirm('Yakin hapus member: ' + nickname + ' ?')) return;
  const resp = await fetch('/api/admin/delete-member', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname })
  });
  const data = await resp.json();
  if (!resp.ok) return toast('err', data.error || 'Gagal hapus member.');
  toast('ok', data.message || 'Member dihapus.');
  await refreshAll();
}

async function setPoints() {
  const nickname     = document.getElementById('adminMember').value;
  const points_total = parseInt(document.getElementById('adminPoints').value, 10);
  const resp = await fetch('/api/admin/set-points', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname, points_total })
  });
  const data = await resp.json();
  if (!resp.ok) return toast('err', data.error || 'Gagal set poin.');
  toast('ok', data.message || 'Poin tersimpan.');
  await refreshAll();
}

// ---- Admin: Item CRUD ----
async function addItem() {
  const name = document.getElementById('newItem').value.trim();
  const resp = await fetch('/api/admin/add-item', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  const data = await resp.json();
  if (!resp.ok) return toast('err', data.error || 'Gagal tambah item.');
  toast('ok', data.message || 'Item ditambah.');
  document.getElementById('newItem').value = '';
  await refreshAll();
}

async function deleteItem() {
  const itemName = document.getElementById('delItem').value;
  if (!confirm('Yakin hapus item: ' + itemName + ' ?')) return;
  const resp = await fetch('/api/admin/delete-item', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemName })
  });
  const data = await resp.json();
  if (!resp.ok) return toast('err', data.error || 'Gagal hapus item.');
  toast('ok', data.message || 'Item dihapus.');
  await refreshAll();
}

async function deleteAllItems() {
  if (!confirm('INI AKAN MENGHAPUS SEMUA ITEMS + BIDS + HOLDS + FINALS.\nLanjut?')) return;
  const resp = await fetch('/api/admin/delete-all-items?confirm=YES', { method: 'POST' });
  const data = await resp.json();
  if (!resp.ok) return toast('err', data.error || 'Gagal delete all items.');
  toast('ok', data.message || 'Semua item dibersihkan.');
  await refreshAll();
}

async function finalizeSelected() {
  const itemName = document.getElementById('finalizeItem').value;
  if (!itemName) return toast('err', 'Tidak ada item OPEN untuk finalize.');
  const resp = await fetch('/api/admin/finalize', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemName })
  });
  const data = await resp.json();
  if (!resp.ok) return toast('err', data.error || 'Gagal finalize.');
  toast('ok', data.message || 'Finalize berhasil.');
  await refreshAll();
}

// ---- Admin: Deadline ----
async function saveDeadline() {
  const localVal     = document.getElementById('deadlineLocal').value;
  const deadline_utc = toUtcIsoFromUtc7LocalInput(localVal);
  if (!deadline_utc) return toast('err', 'Deadline belum diisi / format tidak valid.');
  const resp = await fetch('/api/admin/set-deadline', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deadline_utc })
  });
  const data = await resp.json();
  if (!resp.ok) return toast('err', data.error || 'Gagal simpan deadline.');
  toast('ok', data.message || 'Deadline tersimpan.');
  await refreshAll();
}

async function clearDeadline() {
  const resp = await fetch('/api/admin/set-deadline', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deadline_utc: '' })
  });
  const data = await resp.json();
  if (!resp.ok) return toast('err', data.error || 'Gagal clear deadline.');
  toast('ok', data.message || 'Deadline dikosongkan.');
  await refreshAll();
}

// ---- Admin: Import/Export CSV ----
async function loadImportUrls() {
  const r = await fetch('/api/admin/import-urls');
  const d = await r.json();
  if (!r.ok) return toast('err', d.error || 'Gagal load URL');
  const a = document.getElementById('membersCsvUrl');
  const b = document.getElementById('itemsCsvUrl');
  if (a) a.value = d.members_csv_url || '';
  if (b) b.value = d.items_csv_url   || '';
}

async function saveImportUrls() {
  const members_csv_url = (document.getElementById('membersCsvUrl').value || '').trim();
  const items_csv_url   = (document.getElementById('itemsCsvUrl').value   || '').trim();
  const r = await fetch('/api/admin/set-import-urls', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ members_csv_url, items_csv_url })
  });
  const d = await r.json();
  if (!r.ok) return toast('err', d.error || 'Gagal simpan URL');
  toast('ok', d.message || 'URL tersimpan');
}

async function importMembers() {
  if (!confirm('IMPORT MEMBERS akan REPLACE ALL + reset bidding. Lanjut?')) return;
  const r = await fetch('/api/admin/import-members', { method: 'POST' });
  const d = await r.json();
  if (!r.ok) return toast('err', d.error || 'Import members gagal');
  toast('ok', d.message || 'Import members ok');
  await refreshAll();
}

async function importItems() {
  if (!confirm('IMPORT ITEMS akan REPLACE ALL + reset bidding. Lanjut?')) return;
  const r = await fetch('/api/admin/import-items', { method: 'POST' });
  const d = await r.json();
  if (!r.ok) return toast('err', d.error || 'Import items gagal');
  toast('ok', d.message || 'Import items ok');
  await refreshAll();
}

function downloadCsv(url) {
  const a = document.createElement('a');
  a.href = url; a.target = '_blank'; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
}

// ---- Change handlers ----
document.addEventListener('change', e => {
  if (e.target && e.target.id === 'item')         updateHighestForSelectedItem();
  if (e.target && e.target.id === 'finalizeItem') loadBidLog();
});

// ---- Boot ----
async function boot() {
  restoreSections();
  await loadMe();
  await loadOptions();
  await loadDashboard(false);

  // Auto refresh every 10s
  setInterval(async () => {
    await loadMe();
    await loadDashboard(true); // tables only
  }, 10000);
}

boot();
