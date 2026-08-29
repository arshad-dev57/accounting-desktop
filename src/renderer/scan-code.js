'use strict';

(function () {
  const FORMATS = [
    'qr_code',
    'code_128',
    'code_39',
    'ean_13',
    'ean_8',
    'upc_a',
    'upc_e',
    'codabar',
    'itf',
    'data_matrix',
    'pdf417',
    'aztec',
    'maxi_code',
  ];

  function normalizeScanCode(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        return String(parsed.sku || parsed.barcode || parsed.id || text).trim();
      }
    } catch {
      /* keep raw text */
    }
    return text;
  }

  function ensureStyles() {
    if (document.getElementById('code-scanner-styles')) return;
    const style = document.createElement('style');
    style.id = 'code-scanner-styles';
    style.textContent = `
      #code-scanner-overlay {
        position: fixed; inset: 0; z-index: 80;
        background: rgba(0,0,0,.7);
        display: flex; align-items: center; justify-content: center;
        padding: 16px;
      }
      #code-scanner-card {
        background: #fff; width: 420px; max-width: 95vw;
        border-radius: 16px; overflow: hidden; box-shadow: 0 20px 50px rgba(0,0,0,.3);
      }
      #code-scanner-card header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 14px 16px; border-bottom: 1px solid #e5e7eb;
      }
      #code-scanner-card header h4 { margin: 0; font-size: 15px; }
      #code-scanner-card .scan-close {
        border: 0; background: #f3f4f6; width: 32px; height: 32px;
        border-radius: 8px; cursor: pointer; font-size: 16px;
      }
      #code-scanner-card .scan-body { padding: 16px; }
      #code-scanner-video-wrap {
        position: relative; background: #000; border-radius: 12px;
        overflow: hidden; aspect-ratio: 16 / 10;
      }
      #code-scanner-video { width: 100%; height: 100%; object-fit: cover; }
      #code-scanner-video-wrap .scan-frame {
        position: absolute; inset: 18%;
        border: 2px solid #014582; border-radius: 10px;
        box-shadow: 0 0 0 9999px rgba(0,0,0,.35); pointer-events: none;
      }
      #code-scanner-status {
        position: absolute; left: 50%; bottom: 10px; transform: translateX(-50%);
        background: rgba(0,0,0,.6); color: #fff; font-size: 12px;
        padding: 6px 10px; border-radius: 999px; white-space: nowrap;
      }
      #code-scanner-error {
        padding: 10px 12px; background: #fef2f2; color: #b91c1c;
        border: 1px solid #fecaca; border-radius: 10px; font-size: 13px;
      }
      #code-scanner-card .scan-or {
        display: flex; align-items: center; gap: 8px;
        color: #9ca3af; font-size: 11px; margin: 14px 0 10px;
      }
      #code-scanner-card .scan-or::before,
      #code-scanner-card .scan-or::after {
        content: ''; flex: 1; height: 1px; background: #e5e7eb;
      }
      #code-scanner-manual { display: flex; gap: 8px; }
      #code-scanner-manual input {
        flex: 1; height: 36px; border: 1px solid #e5e7eb; border-radius: 8px;
        padding: 0 10px; font-size: 13px;
      }
      #code-scanner-manual button {
        height: 36px; border: 0; border-radius: 8px; padding: 0 14px;
        background: #014582; color: #fff; font-weight: 700; font-size: 12px; cursor: pointer;
      }
    `;
    document.head.appendChild(style);
  }

  function openCodeScanner({ title = 'Scan barcode', onScan } = {}) {
    if (document.getElementById('code-scanner-overlay')) return;

    ensureStyles();
    let settled = false;
    let stream = null;
    let raf = 0;

    const overlay = document.createElement('div');
    overlay.id = 'code-scanner-overlay';
    overlay.innerHTML = `
      <div id="code-scanner-card">
        <header>
          <h4>${title}</h4>
          <button type="button" class="scan-close" id="code-scanner-close">✕</button>
        </header>
        <div class="scan-body">
          <div id="code-scanner-video-wrap">
            <video id="code-scanner-video" autoplay muted playsinline></video>
            <div class="scan-frame"></div>
            <div id="code-scanner-status">Starting camera…</div>
          </div>
          <div class="scan-or">or enter manually / USB scanner</div>
          <div id="code-scanner-manual">
            <input id="code-scanner-input" type="text" placeholder="Type or scan a code..." autocomplete="off" />
            <button type="button" id="code-scanner-apply">Use</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const video = overlay.querySelector('#code-scanner-video');
    const status = overlay.querySelector('#code-scanner-status');
    const input = overlay.querySelector('#code-scanner-input');
    const applyBtn = overlay.querySelector('#code-scanner-apply');

    function finish(value) {
      const code = normalizeScanCode(value);
      if (!code || settled) return;
      settled = true;
      cleanup();
      if (typeof onScan === 'function') onScan(code);
    }

    function cleanup() {
      cancelAnimationFrame(raf);
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
        stream = null;
      }
      overlay.remove();
    }

    overlay.querySelector('#code-scanner-close').addEventListener('click', () => {
      if (settled) return;
      settled = true;
      cleanup();
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        if (settled) return;
        settled = true;
        cleanup();
      }
    });
    applyBtn.addEventListener('click', () => finish(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(input.value);
      }
    });

    async function startCamera() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        video.srcObject = stream;
        await video.play();
        status.textContent = 'Scanning… point at barcode / QR';

        if (typeof BarcodeDetector !== 'function') {
          status.textContent = 'Camera open — USB scanner or type the code';
          input.focus();
          return;
        }

        // Try to create detector with all supported formats
        let detector;
        try {
          detector = new BarcodeDetector({ formats: FORMATS });
        } catch (e) {
          // If specific formats fail, try without format restriction
          try {
            detector = new BarcodeDetector();
          } catch (e2) {
            status.textContent = 'Camera open — USB scanner or type the code';
            input.focus();
            return;
          }
        }
        const tick = async () => {
          if (settled) return;
          if (video.readyState >= 2) {
            try {
              const codes = await detector.detect(video);
              const value = codes[0]?.rawValue;
              if (value) {
                finish(value);
                return;
              }
            } catch {
              /* keep scanning */
            }
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch (err) {
        const wrap = overlay.querySelector('#code-scanner-video-wrap');
        wrap.innerHTML = `<div id="code-scanner-error">${err.message || 'Camera access denied. Use a USB scanner or type the code.'}</div>`;
        input.focus();
      }
    }

    startCamera();
    setTimeout(() => input.focus(), 50);
  }

  window.normalizeScanCode = normalizeScanCode;
  window.openCodeScanner = openCodeScanner;
})();
