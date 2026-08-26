'use strict';

const api = window.bisonDesktop;

let catalog = [];
let tab = 'cats';
let editing = null;

const tableWrap = document.getElementById('table-wrap');
const searchInp = document.getElementById('search');
const overlay = document.getElementById('overlay');
const form = document.getElementById('form');
const formTitle = document.getElementById('form-title');
const formError = document.getElementById('form-error');
const parentField = document.getElementById('parent-field');
const parentSel = document.getElementById('f-parent');
const btnAdd = document.getElementById('btn-add');

function q() {
  return (searchInp.value || '').trim().toLowerCase();
}

function render() {
  if (tab === 'cats') renderCategories();
  else renderSubcategories();
}

function renderCategories() {
  const rows = catalog.filter((c) =>
    `${c.name} ${c.code} ${c.description}`.toLowerCase().includes(q())
  );
  if (!rows.length) {
    tableWrap.innerHTML = '<div class="empty">No categories found</div>';
    return;
  }
  tableWrap.innerHTML = `<table>
    <thead><tr><th>Name</th><th>Code</th><th>Description</th><th>Subcategories</th><th>Actions</th></tr></thead>
    <tbody>${rows.map((c) => `<tr>
      <td><b>${c.name}</b></td>
      <td>${c.code || '—'}</td>
      <td>${c.description || '—'}</td>
      <td>${(c.subCategories || []).length}</td>
      <td>
        <button class="icon-btn" data-edit-cat="${c.id}">✎</button>
        <button class="icon-btn" data-del-cat="${c.id}">🗑</button>
      </td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function renderSubcategories() {
  const rows = [];
  catalog.forEach((c) => {
    (c.subCategories || []).forEach((s) => {
      rows.push({ ...s, parentName: c.name, parentId: c.id });
    });
  });
  const filtered = rows.filter((r) =>
    `${r.name} ${r.code} ${r.parentName}`.toLowerCase().includes(q())
  );
  if (!filtered.length) {
    tableWrap.innerHTML = '<div class="empty">No subcategories found</div>';
    return;
  }
  tableWrap.innerHTML = `<table>
    <thead><tr><th>Name</th><th>Code</th><th>Parent Category</th><th>Description</th><th>Actions</th></tr></thead>
    <tbody>${filtered.map((s) => `<tr>
      <td><b>${s.name}</b></td>
      <td>${s.code || '—'}</td>
      <td>${s.parentName}</td>
      <td>${s.description || '—'}</td>
      <td>
        <button class="icon-btn" data-edit-sub="${s.id}" data-parent="${s.parentId}">✎</button>
        <button class="icon-btn" data-del-sub="${s.id}">🗑</button>
      </td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function fillParents(selected) {
  parentSel.innerHTML = catalog.map((c) =>
    `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${c.name}</option>`
  ).join('');
}

function openForm(kind, row) {
  editing = { kind, row };
  formError.textContent = '';
  formTitle.textContent = kind === 'cats'
    ? (row ? 'Edit Category' : 'Add Category')
    : (row ? 'Edit Subcategory' : 'Add Subcategory');
  parentField.style.display = kind === 'subs' ? 'block' : 'none';
  fillParents(row?.categoryId || row?.parentId || '');
  document.getElementById('f-name').value = row?.name || '';
  document.getElementById('f-code').value = row?.code || '';
  document.getElementById('f-desc').value = row?.description || '';
  overlay.classList.add('show');
}

function closeForm() {
  overlay.classList.remove('show');
  editing = null;
}

async function reload() {
  const res = await api.catalog.list();
  catalog = Array.isArray(res?.data) ? res.data : [];
  render();
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    tab = btn.getAttribute('data-tab');
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    btnAdd.textContent = tab === 'cats' ? '+ Add Category' : '+ Add Subcategory';
    render();
  });
});

searchInp.addEventListener('input', render);
btnAdd.addEventListener('click', () => openForm(tab, null));
document.getElementById('btn-cancel').addEventListener('click', closeForm);
document.getElementById('btn-back').addEventListener('click', () => {
  window.location.href = './sell.html';
});

tableWrap.addEventListener('click', async (e) => {
  const editCat = e.target.closest('[data-edit-cat]');
  const delCat = e.target.closest('[data-del-cat]');
  const editSub = e.target.closest('[data-edit-sub]');
  const delSub = e.target.closest('[data-del-sub]');
  if (editCat) {
    const row = catalog.find((c) => c.id === editCat.getAttribute('data-edit-cat'));
    openForm('cats', row);
  }
  if (delCat && confirm('Delete this category and its subcategories?')) {
    await api.catalog.deleteCategory(delCat.getAttribute('data-del-cat'));
    await reload();
  }
  if (editSub) {
    const id = editSub.getAttribute('data-edit-sub');
    const parentId = editSub.getAttribute('data-parent');
    const parent = catalog.find((c) => c.id === parentId);
    const row = (parent?.subCategories || []).find((s) => s.id === id);
    openForm('subs', row);
  }
  if (delSub && confirm('Delete this subcategory?')) {
    await api.catalog.deleteSubcategory(delSub.getAttribute('data-del-sub'));
    await reload();
  }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('f-name').value.trim();
  const code = document.getElementById('f-code').value.trim();
  const description = document.getElementById('f-desc').value.trim();
  if (!name) {
    formError.textContent = 'Name is required';
    return;
  }
  if (editing?.kind === 'subs' && !parentSel.value) {
    formError.textContent = 'Please select a parent category';
    return;
  }
  const payload = { id: editing?.row?.id, name, code, description };
  const res = editing?.kind === 'subs'
    ? await api.catalog.saveSubcategory({ ...payload, categoryId: parentSel.value })
    : await api.catalog.saveCategory(payload);
  if (!res?.success) {
    formError.textContent = res?.message || 'Save failed';
    return;
  }
  closeForm();
  await reload();
});

reload().catch((err) => {
  tableWrap.innerHTML = `<div class="empty">${err.message}</div>`;
});
