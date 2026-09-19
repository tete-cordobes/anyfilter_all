import { settingsFrom } from './shared.js';

const $ = (id) => document.getElementById(id);
const settings = settingsFrom((await chrome.storage.local.get('settings')).settings);
for (const field of ['provider', 'rule', 'mode']) $(field).value = settings[field];
$('key').value = settings.apiKey;
for (const field of ['enabled', 'filterCards', 'skipAds', 'accelerateAds', 'seekAds']) $(field).checked = settings[field];
$('settings').addEventListener('submit', async (event) => {
  event.preventDefault();
  const next = settingsFrom({ ...settings, apiKey: $('key').value,
    ...Object.fromEntries(['provider', 'rule', 'mode'].map((field) => [field, $(field).value])),
    ...Object.fromEntries(['enabled', 'filterCards', 'skipAds', 'accelerateAds', 'seekAds'].map((field) => [field, $(field).checked])) });
  if (next.enabled && !next.apiKey) { $('status').textContent = 'Falta la API key.'; return; }
  await chrome.storage.local.set({ settings: next });
  $('status').textContent = 'Guardado. Se aplica a las pestañas de YouTube abiertas.';
});
async function refresh() {
  const { events = [] } = await chrome.storage.session.get('events');
  $('events').textContent = JSON.stringify({ scope: 'YouTube experiment; events are not proof of blocked ads', events }, null, 2);
}
$('refresh').addEventListener('click', refresh);
$('restore').addEventListener('click', async () => { await chrome.runtime.sendMessage({ type: 'probe-restore' }); });
$('clear').addEventListener('click', async () => { await chrome.storage.session.remove('events'); await refresh(); });
$('export').addEventListener('click', async () => {
  await refresh();
  const url = URL.createObjectURL(new Blob([$('events').textContent], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'anyfilter-youtube-observations.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
chrome.storage.onChanged.addListener((_changes, area) => { if (area === 'session') void refresh(); });
await refresh();
