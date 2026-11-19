/**
 * POS admin — receipt template editor (mirrors web ReceiptEditorTab).
 */
(function () {
  const api = window.bisonDesktop;
  const PR = window.PosReceipt;

  let template = {};
  let companyProfile = null;
  let saving = false;

  function patch(partial) {
    template = { ...template, ...partial };
    renderPreview();
    hideMsg();
  }

  function hideMsg() {
    const ok = document.getElementById('receipt-msg-ok');
    const err = document.getElementById('receipt-msg-err');
    if (ok) ok.classList.add('hidden');
    if (err) err.classList.add('hidden');
  }

  function showOk(msg) {
    const el = document.getElementById('receipt-msg-ok');
    if (el) {
      el.textContent = msg;
      el.classList.remove('hidden');
    }
  }

  function showErr(msg) {
    const el = document.getElementById('receipt-msg-err');
    if (el) {
      el.textContent = msg;
      el.classList.remove('hidden');
    }
  }

  function renderPreview() {
    const box = document.getElementById('receipt-live-preview');
    if (!box || !PR) return;
    const comp = PR.resolveReceiptCompany(companyProfile, template);
    box.innerHTML =
      '<div class="pos-receipt-paper">' +
      PR.buildReceiptHtml(PR.sampleReceiptSale(), comp, template) +
      '</div>';
  }

  function bindField(id, key, opts = {}) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
      const v = opts.number ? Number(el.value) : el.value;
      patch({ [key]: v });
    });
    if (opts.type === 'checkbox') {
      el.addEventListener('change', () => patch({ [key]: el.checked }));
    }
  }

  function syncFormFromTemplate() {
    const map = [
      ['rcp-store-name', 'storeName'],
      ['rcp-store-address', 'storeAddress'],
      ['rcp-phone', 'phone'],
      ['rcp-email', 'email'],
      ['rcp-website', 'website'],
      ['rcp-tax-id', 'taxId'],
      ['rcp-header', 'receiptHeader'],
      ['rcp-copy', 'copyLabel'],
      ['rcp-footer', 'receiptFooter'],
      ['rcp-return', 'receiptReturnPolicy'],
      ['rcp-notes', 'receiptNotes'],
      ['rcp-served', 'servedByPrefix'],
      ['rcp-powered', 'poweredBy'],
      ['rcp-logo-url', 'storeLogo'],
    ];
    map.forEach(([id, key]) => {
      const el = document.getElementById(id);
      if (el) el.value = template[key] || '';
    });
    const width = document.getElementById('rcp-width');
    if (width) width.value = String(template.thermalPaperWidthMm || 80);
    const toggles = [
      ['rcp-show-logo', 'showLogo'],
      ['rcp-show-address', 'showAddress'],
      ['rcp-show-phone', 'showPhone'],
      ['rcp-show-email', 'showEmail'],
      ['rcp-show-website', 'showWebsite'],
      ['rcp-show-taxid', 'showTaxId'],
      ['rcp-show-barcode', 'showBarcode'],
      ['rcp-show-sku', 'showSku'],
      ['rcp-show-cashier', 'showCashier'],
      ['rcp-show-terminal', 'showTerminal'],
      ['rcp-show-loyalty', 'showLoyalty'],
    ];
    toggles.forEach(([id, key]) => {
      const el = document.getElementById(id);
      if (el) el.checked = !!template[key];
    });
    const previewImg = document.getElementById('rcp-logo-preview');
    const removeBtn = document.getElementById('rcp-logo-remove');
    if (previewImg) {
      if (template.storeLogo) {
        previewImg.src = template.storeLogo;
        previewImg.classList.remove('hidden');
        removeBtn?.classList.remove('hidden');
      } else {
        previewImg.classList.add('hidden');
        removeBtn?.classList.add('hidden');
      }
    }
  }

  function shellHtml() {
    return `
      <div class="rcp-head row">
        <div>
          <h2>Receipt template</h2>
          <p class="muted" style="margin:6px 0 0;max-width:520px;line-height:1.5">
            Company-wide logo, store details, and receipt text. Desktop POS terminals sync this template for printing.
          </p>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button type="button" class="btn btn-gray" id="rcp-reset">Reset defaults</button>
          <button type="button" class="btn btn-brand" id="rcp-save">Save receipt</button>
        </div>
      </div>
      <div id="receipt-msg-err" class="card hidden" style="border-color:#fecaca;background:#fef2f2;color:#b91c1c;margin-bottom:12px"></div>
      <div id="receipt-msg-ok" class="card hidden" style="border-color:#a7f3d0;background:#ecfdf5;color:#047857;margin-bottom:12px"></div>
      <div class="rcp-grid">
        <div class="rcp-form">
          <div class="card rcp-section">
            <h3>Store details <span class="muted" style="font-weight:500">(blank = company profile)</span></h3>
            <label class="rcp-label">Store name</label>
            <input id="rcp-store-name" placeholder="Uses company name if empty" />
            <label class="rcp-label">Address</label>
            <input id="rcp-store-address" />
            <label class="rcp-label">Phone</label>
            <input id="rcp-phone" />
            <label class="rcp-label">Email</label>
            <input id="rcp-email" />
            <label class="rcp-label">Website</label>
            <input id="rcp-website" />
            <label class="rcp-label">NTN / Tax ID</label>
            <input id="rcp-tax-id" />
            <label class="rcp-label">Receipt logo</label>
            <p class="muted" style="margin:0 0 8px;font-size:12px">PNG/JPEG/WebP/SVG, max 1.5 MB</p>
            <img id="rcp-logo-preview" class="rcp-logo-preview hidden" alt="" />
            <button type="button" class="btn btn-red hidden" id="rcp-logo-remove" style="margin:8px 0">Remove logo</button>
            <input type="file" id="rcp-logo-file" accept="image/png,image/jpeg,image/webp,image/svg+xml" />
            <label class="rcp-label" style="margin-top:10px">Or logo URL</label>
            <input id="rcp-logo-url" placeholder="https://… (leave blank if using upload)" />
          </div>
          <div class="card rcp-section">
            <h3>Receipt text</h3>
            <label class="rcp-label">Header</label>
            <input id="rcp-header" />
            <label class="rcp-label">Copy label</label>
            <input id="rcp-copy" />
            <label class="rcp-label">Footer</label>
            <input id="rcp-footer" />
            <label class="rcp-label">Return / exchange policy</label>
            <textarea id="rcp-return" rows="3"></textarea>
            <label class="rcp-label">Extra notes</label>
            <textarea id="rcp-notes" rows="3"></textarea>
            <label class="rcp-label">Served by prefix</label>
            <input id="rcp-served" />
            <label class="rcp-label">Bottom line</label>
            <input id="rcp-powered" />
            <label class="rcp-label">Thermal paper width</label>
            <select id="rcp-width"><option value="58">58mm</option><option value="80">80mm</option></select>
          </div>
          <div class="card rcp-section">
            <h3>Show / hide sections</h3>
            <div class="rcp-toggles">
              ${[
                ['rcp-show-logo', 'showLogo', 'Logo'],
                ['rcp-show-address', 'showAddress', 'Address'],
                ['rcp-show-phone', 'showPhone', 'Phone'],
                ['rcp-show-email', 'showEmail', 'Email'],
                ['rcp-show-website', 'showWebsite', 'Website'],
                ['rcp-show-taxid', 'showTaxId', 'Tax ID'],
                ['rcp-show-barcode', 'showBarcode', 'Barcode'],
                ['rcp-show-sku', 'showSku', 'SKU'],
                ['rcp-show-cashier', 'showCashier', 'Cashier'],
                ['rcp-show-terminal', 'showTerminal', 'Terminal'],
                ['rcp-show-loyalty', 'showLoyalty', 'Loyalty points'],
              ]
                .map(
                  ([id, , label]) => `
                <label class="rcp-toggle-row"><span>${label}</span>
                  <input type="checkbox" id="${id}" />
                </label>`
                )
                .join('')}
            </div>
          </div>
        </div>
        <div class="rcp-preview-col">
          <div class="rcp-preview-label">LIVE PREVIEW</div>
          <div class="rcp-preview-wrap">
            <div id="receipt-live-preview"></div>
          </div>
        </div>
      </div>`;
  }

  async function load() {
    const wrap = document.getElementById('panel-receipt');
    if (!wrap || !PR) {
      wrap.innerHTML = '<p class="error">Receipt module not loaded.</p>';
      return;
    }
    wrap.innerHTML = shellHtml();
    template = { ...PR.DEFAULT_RECEIPT_TEMPLATE() };

    try {
      const [receiptRes, profileRes] = await Promise.all([
        api.pos.getReceiptSettings(),
        api.pos.getProfile(),
      ]);
      if (receiptRes?.success && receiptRes.data) {
        const localAsk = !!PR.loadReceiptTemplate().askCashReceived;
        const cloud = { ...receiptRes.data };
        delete cloud.askCashReceived;
        template = PR.replaceReceiptTemplate(cloud, localAsk);
      } else {
        template = PR.loadReceiptTemplate();
      }
      if (profileRes?.success) companyProfile = profileRes.data;
    } catch (e) {
      template = PR.loadReceiptTemplate();
      showErr(e.message || 'Failed to load receipt template');
    }

    syncFormFromTemplate();
    renderPreview();
    bindAll();
  }

  function bindAll() {
    bindField('rcp-store-name', 'storeName');
    bindField('rcp-store-address', 'storeAddress');
    bindField('rcp-phone', 'phone');
    bindField('rcp-email', 'email');
    bindField('rcp-website', 'website');
    bindField('rcp-tax-id', 'taxId');
    bindField('rcp-header', 'receiptHeader');
    bindField('rcp-copy', 'copyLabel');
    bindField('rcp-footer', 'receiptFooter');
    bindField('rcp-return', 'receiptReturnPolicy');
    bindField('rcp-notes', 'receiptNotes');
    bindField('rcp-served', 'servedByPrefix');
    bindField('rcp-powered', 'poweredBy');
    document.getElementById('rcp-width')?.addEventListener('change', (e) => {
      patch({ thermalPaperWidthMm: Number(e.target.value) === 58 ? 58 : 80 });
    });

    const toggles = [
      ['rcp-show-logo', 'showLogo'],
      ['rcp-show-address', 'showAddress'],
      ['rcp-show-phone', 'showPhone'],
      ['rcp-show-email', 'showEmail'],
      ['rcp-show-website', 'showWebsite'],
      ['rcp-show-taxid', 'showTaxId'],
      ['rcp-show-barcode', 'showBarcode'],
      ['rcp-show-sku', 'showSku'],
      ['rcp-show-cashier', 'showCashier'],
      ['rcp-show-terminal', 'showTerminal'],
      ['rcp-show-loyalty', 'showLoyalty'],
    ];
    toggles.forEach(([id, key]) => {
      document.getElementById(id)?.addEventListener('change', (e) => patch({ [key]: e.target.checked }));
    });

    document.getElementById('rcp-logo-url')?.addEventListener('input', (e) => {
      const v = e.target.value.trim();
      patch({ storeLogo: v, showLogo: v ? true : template.showLogo });
      syncFormFromTemplate();
    });

    document.getElementById('rcp-logo-file')?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      if (file.size > 1.5 * 1024 * 1024) {
        showErr('Logo must be under 1.5 MB');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : '';
        if (result) {
          patch({ storeLogo: result, showLogo: true });
          syncFormFromTemplate();
        }
      };
      reader.readAsDataURL(file);
    });

    document.getElementById('rcp-logo-remove')?.addEventListener('click', () => {
      patch({ storeLogo: '', showLogo: false });
      document.getElementById('rcp-logo-url').value = '';
      syncFormFromTemplate();
    });

    document.getElementById('rcp-reset')?.addEventListener('click', () => {
      if (!confirm('Reset all receipt fields to defaults? Click Save receipt to apply on the server.')) return;
      const localAsk = !!PR.loadReceiptTemplate().askCashReceived;
      template = { ...PR.DEFAULT_RECEIPT_TEMPLATE(), askCashReceived: localAsk };
      syncFormFromTemplate();
      renderPreview();
      showOk('Defaults restored. Click Save receipt to apply.');
    });

    document.getElementById('rcp-save')?.addEventListener('click', async () => {
      if (saving) return;
      saving = true;
      const btn = document.getElementById('rcp-save');
      btn.disabled = true;
      btn.textContent = 'Saving…';
      hideMsg();
      const payload = { ...template };
      delete payload.askCashReceived;
      try {
        const res = await api.pos.saveReceiptSettings(payload);
        if (!res?.success) {
          showErr(res?.message || 'Failed to save');
          return;
        }
        const localAsk = !!PR.loadReceiptTemplate().askCashReceived;
        const saved = res.data && typeof res.data === 'object' ? res.data : payload;
        PR.replaceReceiptTemplate(saved, localAsk);
        template = PR.loadReceiptTemplate();
        syncFormFromTemplate();
        renderPreview();
        showOk(res.message || 'Receipt template saved.');
      } catch (err) {
        showErr(err.message || 'Save failed');
      } finally {
        saving = false;
        btn.disabled = false;
        btn.textContent = 'Save receipt';
      }
    });
  }

  window.ManagementReceiptEditor = { load };
})();