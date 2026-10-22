const api = window.bisonDesktop;

const listEl = document.getElementById('companies');
const errorEl = document.getElementById('error');
const continueBtn = document.getElementById('continue');
const logoutBtn = document.getElementById('logout');

let companies = [];
let selectedId = '';

function showError(message) {
  errorEl.textContent = message || 'Something went wrong';
  errorEl.classList.remove('hidden');
}

function hideError() {
  errorEl.classList.add('hidden');
}

function render() {
  if (!companies.length) {
    listEl.innerHTML = '<p class="sub">No companies found for this account.</p>';
    continueBtn.disabled = true;
    return;
  }

  listEl.innerHTML = companies
    .map((c) => {
      const id = String(c.id);
      const active = id === selectedId ? 'active' : '';
      const logo = c.logo
        ? `<img src="${c.logo}" alt="" />`
        : `<img src="../../assets/icon.png" alt="" />`;
      const badge = c.isPrimary ? ' · Primary' : '';
      return `<button type="button" class="co ${active}" data-id="${id}">
        ${logo}
        <div class="meta">
          <b>${c.name || 'Company'}</b>
          <span>${c.email || c.businessType || 'Company workspace'}${badge}</span>
        </div>
      </button>`;
    })
    .join('');

  listEl.querySelectorAll('.co').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedId = btn.getAttribute('data-id');
      continueBtn.disabled = !selectedId;
      render();
    });
  });
  continueBtn.disabled = !selectedId;
}

async function boot() {
  hideError();
  try {
    const res = await api.auth.listCompanies();
    if (!res?.success) {
      showError(res?.message || 'Could not load companies');
      return;
    }
    companies = Array.isArray(res.companies) ? res.companies : [];
    selectedId = String(res.activeCompanyId || companies[0]?.id || '');
    if (companies.length === 1) {
      selectedId = String(companies[0].id);
      continueBtn.disabled = true;
      continueBtn.textContent = 'Opening…';
      const pick = await api.auth.selectCompany(selectedId);
      if (!pick?.success) {
        continueBtn.textContent = 'Continue';
        continueBtn.disabled = false;
        showError(pick?.message || 'Could not open company');
        render();
        return;
      }
      return;
    }
    render();
  } catch (err) {
    showError(err.message || 'Failed to load companies');
  }
}

continueBtn.addEventListener('click', async () => {
  hideError();
  if (!selectedId) {
    showError('Select a company');
    return;
  }
  continueBtn.disabled = true;
  continueBtn.textContent = 'Opening…';
  try {
    const res = await api.auth.selectCompany(selectedId);
    if (!res?.success) {
      showError(res?.message || 'Could not open company');
      continueBtn.disabled = false;
      continueBtn.textContent = 'Continue';
    }
  } catch (err) {
    showError(err.message || 'Could not open company');
    continueBtn.disabled = false;
    continueBtn.textContent = 'Continue';
  }
});

logoutBtn.addEventListener('click', () => {
  api.auth.logout();
});

boot();
