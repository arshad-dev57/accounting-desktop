/**
 * Product barcode (Code128) + QR live previews for create/edit forms.
 * Encodes the ACTUAL stored value (not truncated receipt-style digits)
 * so sell-page scans match what is printed on the label.
 */
(function (global) {
  'use strict';

  var CODE128_PATTERNS = [
    '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213',
    '221312','231212','112232','122132','122231','113222','123122','123221','223211','221132',
    '221231','213212','223112','312131','311222','321122','321221','312212','322112','322211',
    '212123','212321','232121','111323','131123','131321','112313','132113','132311','211313',
    '231113','231311','112133','112331','132131','113123','113321','133121','313121','211331',
    '231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
    '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214',
    '112412','122114','122411','142112','142211','241211','221114','413111','241112','134111',
    '111242','121142','121241','114212','124112','124211','411212','421112','421211','212141',
    '214121','412121','111143','111341','131141','114113','114311','411113','411311','113141',
    '114131','311141','411131','211412','211214','211232','2331112'
  ];

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function normalizeProductCode(raw) {
    if (typeof global.normalizeScanCode === 'function') {
      return global.normalizeScanCode(raw);
    }
    return String(raw || '').replace(/[\x00-\x1F\x7F]/g, '').trim();
  }

  /** Code128B/C encode — keeps exact printable ASCII (no forced uppercase / truncate). */
  function encodeCode128(text) {
    var t = String(text || '');
    var useC = /^\d+$/.test(t) && t.length >= 2;
    if (useC && t.length % 2 === 1) t = '0' + t;

    var codes = [];
    var sum = 0;
    if (useC) {
      codes.push(105);
      sum = 105;
      var pos = 1;
      for (var i = 0; i < t.length; i += 2) {
        var pair = Number(t.slice(i, i + 2));
        codes.push(pair);
        sum += pair * pos;
        pos += 1;
      }
    } else {
      codes.push(104);
      sum = 104;
      for (var j = 0; j < t.length; j++) {
        var v = t.charCodeAt(j) - 32;
        if (v < 0 || v > 94) v = ('?').charCodeAt(0) - 32;
        codes.push(v);
        sum += v * (j + 1);
      }
    }
    codes.push(sum % 103);
    codes.push(106);
    return { codes: codes, text: t, set: useC ? 'C' : 'B' };
  }

  function moduleWidth(codes) {
    var n = 0;
    for (var i = 0; i < codes.length; i++) {
      var pat = CODE128_PATTERNS[codes[i]];
      if (!pat) return 0;
      for (var d = 0; d < pat.length; d++) n += Number(pat[d]);
    }
    return n;
  }

  /**
   * Scannable Code128 SVG for product labels.
   * Human-readable line = exact product barcode (what POS will match).
   */
  function productBarcodeSvg(value, maxWidth) {
    var display = normalizeProductCode(value);
    if (!display) {
      return '<div style="color:#9ca3af;font-size:13px;text-align:center;padding:12px;">Scan or enter a barcode</div>';
    }
    // Encode printable ASCII only; keep display as the real stored value
    var encodeText = display.replace(/[^\x20-\x7E]/g, '');
    if (!encodeText) encodeText = display.replace(/[^A-Za-z0-9]/g, '') || 'CODE';

    var maxInner = Math.max(220, Number(maxWidth) || 360);
    var module = 3;
    var quietMods = 10;
    var height = 64;
    var encoded = encodeCode128(encodeText);
    var mods = moduleWidth(encoded.codes) + quietMods * 2;
    while (mods * module > maxInner && module > 2) module -= 1;
    // Still too wide: keep full value, use module 2 (never truncate product codes)

    var quiet = quietMods * module;
    var x = quiet;
    var bars = '';
    for (var c = 0; c < encoded.codes.length; c++) {
      var pat = CODE128_PATTERNS[encoded.codes[c]];
      if (!pat) {
        return '<div style="color:#b91c1c;font-size:12px;">Invalid barcode characters</div>';
      }
      for (var d = 0; d < pat.length; d++) {
        var w = Number(pat[d]) * module;
        if (d % 2 === 0) {
          bars += '<rect x="' + x + '" y="0" width="' + w + '" height="' + height + '" fill="#000"/>';
        }
        x += w;
      }
    }
    var totalW = x + quiet;
    var totalH = height + 4;

    return (
      '<div style="display:flex;flex-direction:column;align-items:center;gap:6px;width:100%;">' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + totalW + '" height="' + totalH + '"' +
      ' viewBox="0 0 ' + totalW + ' ' + totalH + '" shape-rendering="crispEdges"' +
      ' style="display:block;max-width:100%;height:auto;background:#fff;">' +
      '<rect width="100%" height="100%" fill="#fff"/>' + bars + '</svg>' +
      '<div style="font-family:ui-monospace,Menlo,monospace;font-size:13px;font-weight:800;letter-spacing:1px;word-break:break-all;text-align:center;">' +
      esc(display) +
      '</div>' +
      '<div style="font-size:11px;color:#059669;font-weight:600;">CODE128 · ready to scan</div>' +
      '</div>'
    );
  }

  function emptyQrHtml() {
    return '<div style="color:#9ca3af;font-size:13px;text-align:center;padding:12px;">Scan or enter a QR value</div>';
  }

  /**
   * QR SVG via main-process `qrcode` (IPC). Falls back to text-only if unavailable.
   */
  async function productQrSvg(value, size) {
    var display = normalizeProductCode(value);
    if (!display) return emptyQrHtml();

    var px = Math.max(120, Number(size) || 160);
    var svg = '';
    try {
      if (global.bisonDesktop && global.bisonDesktop.codes && typeof global.bisonDesktop.codes.qrSvg === 'function') {
        var res = await global.bisonDesktop.codes.qrSvg(display, px);
        if (res && res.success && res.svg) svg = res.svg;
      }
    } catch (err) {
      console.warn('[product-codes] QR render failed', err);
    }

    if (!svg) {
      return (
        '<div style="display:flex;flex-direction:column;align-items:center;gap:6px;">' +
        '<div style="font-family:ui-monospace,Menlo,monospace;font-size:14px;font-weight:800;word-break:break-all;text-align:center;">' +
        esc(display) +
        '</div>' +
        '<div style="font-size:11px;color:#b45309;">QR preview unavailable — value saved for scanning</div>' +
        '</div>'
      );
    }

    return (
      '<div style="display:flex;flex-direction:column;align-items:center;gap:6px;">' +
      '<div style="background:#fff;padding:8px;border-radius:8px;line-height:0;">' + svg + '</div>' +
      '<div style="font-family:ui-monospace,Menlo,monospace;font-size:12px;font-weight:800;word-break:break-all;text-align:center;max-width:220px;">' +
      esc(display) +
      '</div>' +
      '<div style="font-size:11px;color:#059669;font-weight:600;">QR · ready to scan</div>' +
      '</div>'
    );
  }

  function printLabelHtml(kind, value, productName) {
    var title = kind === 'qr' ? 'QR Code' : 'Barcode';
    var body = kind === 'qr'
      ? '<div id="code-slot"></div>'
      : productBarcodeSvg(value, 420);
    return (
      '<!DOCTYPE html><html><head><title>' + esc(title) + ' - ' + esc(productName || '') + '</title>' +
      '<style>body{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;font-family:system-ui,sans-serif;padding:24px;margin:0;}' +
      '.name{margin-top:12px;font-size:16px;color:#374151;font-weight:600;text-align:center;}' +
      '@page{margin:8mm;}</style></head><body>' +
      (kind === 'qr' ? body : body) +
      '<div class="name">' + esc(productName || '') + '</div>' +
      '<script>(async function(){' +
      (kind === 'qr'
        ? 'var slot=document.getElementById("code-slot");' +
          'if(window.opener&&window.opener.PosProductCodes){slot.innerHTML=await window.opener.PosProductCodes.productQrSvg(' +
          JSON.stringify(String(value || '')) + ',200);}'
        : '') +
      'setTimeout(function(){window.focus();window.print();},400);' +
      '})();<\/script></body></html>'
    );
  }

  global.PosProductCodes = {
    normalizeProductCode: normalizeProductCode,
    productBarcodeSvg: productBarcodeSvg,
    productQrSvg: productQrSvg,
    printLabelHtml: printLabelHtml,
  };
})(window);
