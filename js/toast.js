// Lightweight toast notifications, shared by UI and sketch views.

export function showToast(msg, ms = 2200) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.opacity = '0'; }, ms);
}
