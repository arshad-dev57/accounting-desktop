(function () {
  try {
    var mode = new URLSearchParams(window.location.search).get('posMode');
    if (mode === 'restaurant') {
      document.documentElement.classList.add('pos-mode-restaurant');
    }
  } catch (e) {
    /* ignore */
  }
})();
