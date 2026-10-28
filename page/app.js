const THEME_KEYS = [
  'bg', 'card', 'card-2', 'pill', 'line', 'fg', 'fg-2', 'muted', 'faint',
  'accent', 'accent-soft', 'green', 'red', 'amber', 'font', 'code',
  'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7',
];

function tokenValue(tokens, key) {
  return tokens?.[`--magpie-${key}`] ?? tokens?.[`--${key}`] ?? tokens?.[key];
}

async function openDashboard() {
  // A normal browser tab has no Magpie bridge and can use the dashboard directly.
  if (location.protocol !== 'file:') {
    location.replace(`http://127.0.0.1:3426/${location.search}`);
    return;
  }
  let theme = null;
  try {
    theme = await window.magpie?.ready;
  } catch {}
  const params = new URLSearchParams();
  if (theme?.dark === true) params.set('theme', 'dark');
  else if (theme?.dark === false) params.set('theme', 'light');
  for (const key of THEME_KEYS) {
    const value = tokenValue(theme?.tokens, key);
    if (typeof value === 'string' && value) params.set(`magpie-${key}`, value);
  }
  // Magpie page iframes cannot fetch the local usage API directly. Navigate this
  // frame to the loopback dashboard; the local helper then queries Magpie server-side.
  window.location.href = `http://127.0.0.1:3426/${params.size ? `?${params}` : ''}`;
}

if (window.magpie?.ready) {
  window.magpie.ready.then(() => {
    const lang = window.magpie.theme?.lang;
    if (lang?.startsWith('en')) document.documentElement.lang = 'en';
  }).catch(() => {});
}

openDashboard();
