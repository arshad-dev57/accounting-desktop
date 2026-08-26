const api = window.bisonDesktop;

document.getElementById('min').addEventListener('click', () => api?.window.minimize());
document.getElementById('max').addEventListener('click', () => api?.window.maximize());
document.getElementById('close').addEventListener('click', () => api?.window.close());

document.querySelector('.bar').addEventListener('dblclick', () => api?.window.maximize());

api?.window.onMaximizedChange((maximized) => {
  document.getElementById('max').textContent = maximized ? '❐' : '□';
});
