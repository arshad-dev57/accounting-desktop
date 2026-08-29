const api = window.bisonDesktop;

const userEl = document.getElementById('user');
const listEl = document.getElementById('terminals');
const cashEl = document.getElementById('cash');
const errorEl = document.getElementById('error');
const openBtn = document.getElementById('open');
const logoutBtn = document.getElementById('logout');
const resumeBox = document.getElementById('resume-box');
const resumeBtn = document.getElementById('resume');
const terminalBox = document.getElementById('terminal-box');

let terminals = [];
let selectedId = '';
let suspended = null;

function showError(message) {
  errorEl.textContent = message || 'Something went wrong';
  errorEl.classList.remove('hidden');
}

function hideError() {
  errorEl.classList.add('hidden');
}

function renderTerminals() {
  if (!terminals.length) {
    listEl.innerHTML = '<p class="sub">No terminals at your assigned location yet. Sign out and sign in again — a counter will be created automatically. Or ask an admin to create a terminal for your warehouse in POS → Management → Terminals.</p>';
    openBtn.disabled = true;
    return;
  }
  openBtn.disabled = false;

  // Single terminal for scoped users — auto-selected, no need to pick
  const locked = terminals.length === 1;
  listEl.innerHTML = terminals
    .map(
      (t) => `
      <button class="term ${t.id === selectedId ? 'active' : ''}" data-id="${t.id}" type="button" ${locked ? 'disabled' : ''}>
        <b>${t.name || t.code || 'Terminal'}</b>
        <span>${t.code || ''} ${t.location?.name ? '· ' + t.location.name : ''}</span>
      </button>`
    )
    .join('');

  if (!locked) {
    listEl.querySelectorAll('.term').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedId = btn.getAttribute('data-id');
        renderTerminals();
      });
    });
  }
}

async function boot() {
  const session = await api.auth.getSession();
  const user = session?.user || {};
  userEl.textContent = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || '';
  const syncEl = document.getElementById('sync-status');
  // Show local catalog status immediately — no live sync on startup (use manual Sync button)
  try {
    const statusRes = await api.pos.getMasterSyncStatus();
    if (syncEl) {
      const c = statusRes?.data || {};
      const total = (c.products || 0);
      if (total > 0) {
        syncEl.textContent = `Catalog ready · ${total} products`;
      } else {
        syncEl.textContent = 'Catalog empty — use Sync to load from cloud';
      }
    }
  } catch (err) {
    if (syncEl) syncEl.textContent = 'Local catalog status unavailable';
  }

  const isAdmin = !!(session?.isAdmin || ['admin', 'owner', 'superadmin', 'company_admin'].includes(String(user.role || '').toLowerCase()));
  const adminBtn = document.getElementById('admin');
  if (adminBtn && isAdmin) {
    adminBtn.classList.remove('hidden');
    adminBtn.addEventListener('click', () => api.pos.enterManagement());
  }

  const current = await api.pos.getCurrentShift();
  const shift = current?.data;
  if (shift?.status === 'Open') {
    await api.pos.enterSell();
    return;
  }
  if (shift?.status === 'Suspended') {
    suspended = shift;
    resumeBox.classList.remove('hidden');
  }

  const res = await api.pos.listTerminals();
  if (!res?.success) {
    showError(res?.message || 'Could not load terminals');
    return;
  }
  terminals = Array.isArray(res.data) ? res.data : [];
  selectedId = terminals[0]?.id || '';

  // Hint for scoped cashiers
  if (!isAdmin && terminals.length === 1) {
    const locName = terminals[0].location?.name || 'your assigned location';
    if (terminalBox) {
      const hint = document.createElement('p');
      hint.className = 'sub';
      hint.style.marginBottom = '8px';
      hint.textContent = `Working at ${locName} · ${terminals[0].name || terminals[0].code || 'Terminal'}`;
      terminalBox.insertBefore(hint, listEl);
    }
  }

  renderTerminals();
}



openBtn.addEventListener('click', async () => {
  hideError();
  if (!selectedId) {
    showError('Select a terminal');
    return;
  }
  openBtn.disabled = true;
  try {
    const res = await api.pos.openShift({
      terminalId: selectedId,
      openingCash: Number(cashEl.value || 0),
    });
    if (!res?.success) {
      showError(res?.message || 'Could not open shift');
      return;
    }
    await api.pos.enterSell();
  } catch (err) {
    showError(err.message);
  } finally {
    openBtn.disabled = false;
  }
});

resumeBtn.addEventListener('click', async () => {
  if (!suspended?.id) return;
  resumeBtn.disabled = true;
  try {
    const res = await api.pos.resumeShift(suspended.id);
    if (!res?.success) {
      showError(res?.message || 'Could not resume shift');
      return;
    }
    await api.pos.enterSell();
  } catch (err) {
    showError(err.message);
  } finally {
    resumeBtn.disabled = false;
  }
});

logoutBtn.addEventListener('click', () => api.auth.logout());
api.auth.onExpired(() => api.auth.logout());

boot().catch((err) => showError(err.message));
