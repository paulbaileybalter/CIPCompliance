// Sign-in / first-time PIN setup.
(async () => {
  const $ = (id) => document.getElementById(id);
  const msg = (t) => { $('msg').textContent = t || ''; };
  let st = { configured: true };
  try { st = await (await fetch('/api/auth/status', { credentials: 'same-origin' })).json(); } catch { msg('Can’t reach the server — check your connection.'); }
  if (st.authed) { location.replace('/'); return; }
  const setup = !st.configured;
  $('lead').textContent = setup ? 'First-time setup — choose a 4-digit PIN for this site. Anyone you share it with can sign in.' : 'Enter your PIN to continue.';
  $('pw').autocomplete = setup ? 'new-password' : 'current-password';
  $('pw2Row').hidden = !setup;
  if (setup) $('pw').maxLength = 4;      // existing longer passwords (from an earlier version) can still sign in
  $('codeRow').hidden = !(setup && st.needsCode);
  $('go').textContent = setup ? 'Set PIN & enter' : 'Sign in';
  $('go').disabled = false;
  $('form').addEventListener('submit', async (e) => {
    e.preventDefault(); msg('');
    const password = $('pw').value;
    if (setup) {
      if (!/^\d{4}$/.test(password)) return msg('Choose a 4-digit PIN.');
      if (password !== $('pw2').value) return msg('The two PINs don’t match.');
    } else if (!password) return msg('Enter your PIN.');
    $('go').disabled = true;
    try {
      const res = await fetch(setup ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, code: $('code').value }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { location.replace('/'); return; }
      msg(data.error || 'Something went wrong.');
    } catch { msg('Can’t reach the server — check your connection.'); }
    $('go').disabled = false;
  });
  // floating bubbles, same as the app
  const el = document.querySelector('.bubbles');
  if (el && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.innerHTML = Array.from({ length: 14 }, (_, i) => `<i style="--s:${8 + Math.round(Math.random() * 30)}px;left:${Math.round(Math.random() * 100)}%;animation-duration:${(14 + Math.random() * 18).toFixed(1)}s;animation-delay:${(-Math.random() * 30).toFixed(1)}s;--c:${['#47D7AC', '#99D6EA', '#F1EB9C', '#FFD637', '#7566A0'][i % 5]}"></i>`).join('');
  }
})();
