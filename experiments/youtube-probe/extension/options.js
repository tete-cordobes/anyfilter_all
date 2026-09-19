import { settingsFrom } from './shared.js';

const $ = (id) => document.getElementById(id);
let settings = settingsFrom((await chrome.storage.local.get('settings')).settings);
const values = ['provider', 'rule', 'mode'];
const flags = ['enabled', 'filterCards', 'skipAds', 'accelerateAds', 'seekAds'];
function fillForm() {
  for (const field of values) $(field).value = settings[field];
  $('key').value = settings.apiKey;
  for (const field of flags) $(field).checked = settings[field];
}
function draft() {
  return settingsFrom({ ...settings, apiKey: $('key').value,
    ...Object.fromEntries(values.map((field) => [field, $(field).value])),
    ...Object.fromEntries(flags.map((field) => [field, $(field).checked])) });
}
function errorText(result) {
  const messages = {
    'no-key': 'Falta la API key de Jev. Introdúcela arriba.',
    auth: 'Jev ha rechazado la clave. Comprueba que corresponde al proveedor elegido y que tiene acceso al modelo.',
    'rate-limited': 'El proveedor ha limitado las solicitudes. Espera antes de volver a probar y revisa tu cuota.',
    'provider-http': 'El proveedor no pudo completar la consulta. Revisa el servicio y el saldo de tu cuenta.',
    timeout: 'Jev no respondió en 5 segundos. Vuelve a comprobar la conexión.',
    network: 'No se pudo conectar con Jev. Comprueba la conexión y el acceso al proveedor.',
    'invalid-scores': 'Jev respondió con un formato de puntuaciones que esta extensión no reconoce.',
    'invalid-json': 'El proveedor respondió con un formato que esta extensión no reconoce.',
    'content-startup': 'No se pudo iniciar el filtro en YouTube. Recarga esa pestaña.',
    transport: 'Se ha perdido la conexión con la extensión. Recarga YouTube y esta página.',
    'queue-timeout': 'La evaluación caducó mientras esperaba su turno. Vuelve a activar el filtro para reintentar.',
    'queue-full': 'Hay demasiadas tarjetas pendientes de evaluar. Vuelve a activar el filtro para reintentar.',
    'settings-changed': 'La configuración cambió durante una evaluación. La respuesta anterior se descartó.',
  };
  return (messages[result?.error] ?? 'No se pudo completar la operación. Recarga la extensión y vuelve a probar.') +
    (Number.isFinite(result?.status) ? ` (HTTP ${result.status})` : '');
}
const send = (message) => chrome.runtime.sendMessage(message);

async function save(next) {
  await chrome.storage.local.set({ settings: next });
  settings = next;
  fillForm();
  await send({ type: 'probe-connect-tabs' });
  await refresh();
}

async function testConnection(activate) {
  const next = draft();
  if (!next.apiKey) { $('status').textContent = errorText({ error: 'no-key' }); return; }
  $('controls').disabled = true;
  $('status').textContent = 'Comprobando una respuesta real de Jev…';
  try {
    const result = await send({ type: 'probe-test-connection', settings: next });
    if (!result?.ok) { $('status').textContent = errorText(result); return; }
    if (activate) {
      await save({ ...next, enabled: true, mode: 'act', filterCards: true, skipAds: true, accelerateAds: true });
      $('status').textContent = `Jev conectado (${result.latencyMs} ms). Filtro activado, incluida la prueba de anuncios a 16×.`;
    } else $('status').textContent = `Jev conectado (${result.latencyMs} ms). Esta comprobación no activa el filtro ni guarda cambios.`;
  } catch { $('status').textContent = errorText({ error: 'transport' }); }
  finally { $('controls').disabled = false; await refresh(); }
}

fillForm();
$('activate').addEventListener('click', () => void testConnection(true));
$('test').addEventListener('click', () => void testConnection(false));
$('settings').addEventListener('submit', async (event) => {
  event.preventDefault();
  const next = draft();
  if (next.enabled && !next.apiKey) { $('status').textContent = errorText({ error: 'no-key' }); return; }
  try {
    await save(next);
    $('status').textContent = !next.enabled ? 'Guardado. El filtro está desactivado.' : next.mode === 'observe'
      ? 'Guardado en modo observar: se consulta Jev, pero no se oculta ni acelera nada.'
      : 'Guardado. Filtro activo. Consulta el estado de YouTube y los resultados de Jev arriba.';
  } catch { $('status').textContent = errorText({ error: 'transport' }); }
});

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const [{ events = [] }, health] = await Promise.all([
      chrome.storage.session.get('events'), send({ type: 'probe-diagnostics' }),
    ]);
    if (!health?.ok) throw new Error('No diagnostics');
    const live = health.settings;
    $('health-state').textContent = !health.hasKey ? 'Sin configurar: introduce tu clave de Jev.' :
      !live.enabled ? 'Desactivado: pulsa «Comprobar Jev y activar filtro».' :
        live.mode === 'observe' ? 'Modo observar: no se oculta ni acelera nada.' :
          !live.filterCards && !live.skipAds ? 'Sin filtros activos: activa tarjetas o anuncios en los ajustes.' :
            `Filtro activo · Tarjetas: ${live.filterCards ? 'sí' : 'no'} · Anuncios: ${live.skipAds ? 'sí' : 'no'} · 16×: ${live.skipAds && live.accelerateAds ? 'sí' : 'no'}`;
    const connected = health.tabs.filter((tab) => tab.connected);
    const unsupported = connected.filter((tab) => !tab.supported).length;
    const noCards = live.filterCards && connected.some((tab) => tab.supported) && connected.every((tab) => !tab.cards);
    $('health-youtube').textContent = !health.tabs.length ? 'Abre YouTube en este mismo perfil de Chrome.' :
      `YouTube: ${connected.length}/${health.tabs.length} pestañas conectadas.` +
      (connected.length < health.tabs.length ? ' Pulsa «Conectar pestañas de YouTube» o recarga las que falten.' : '') +
      (unsupported ? ' Hay páginas no compatibles; prueba Inicio, búsqueda o un vídeo normal, fuera del reproductor vertical de Shorts.' : '') +
      (noCards ? ' Aún no se detectan tarjetas compatibles en la página.' : '');
    const ads = connected.filter((tab) => tab.adShowing);
    const skipStates = { ready: 'botón Saltar disponible', disabled: 'botón Saltar aún deshabilitado',
      countdown: 'cuenta atrás para Saltar', hidden: 'botón Saltar oculto', missing: 'no se encuentra un botón Saltar' };
    const lastPlayer = [...events].reverse().find((e) => e.surface === 'player' &&
      ['action-attempted', 'action-aborted', 'action-error', 'ad-still-playing-after-attempt', 'ad-ended-after-attempt'].includes(e.outcome));
    $('health-player').textContent = (ads.length ? ads.map((tab) => 'Anuncio detectado: ' + (skipStates[tab.skipState] ?? 'comprobando botón Saltar')).join('. ') :
      connected.some((tab) => tab.player) ? 'No hay un anuncio detectado en el reproductor ahora.' : '') +
      (lastPlayer?.action === 'click-skip' ? lastPlayer.outcome === 'ad-still-playing-after-attempt'
        ? ' Se intentó Saltar, pero el anuncio seguía reproduciéndose.'
        : lastPlayer.outcome === 'action-attempted' ? ` Último clic en Saltar: intento ${lastPlayer.clickAttempt ?? 1}.` : '' : '');
    const evaluations = events.filter((e) => ['evaluated', 'kept', 'hidden', 'would-hide'].includes(e.outcome)).length;
    const hidden = events.filter((e) => e.outcome === 'hidden').length;
    const attempts = events.filter((e) => e.outcome === 'action-attempted').length;
    $('health-activity').textContent = `Actividad reciente: ${evaluations} evaluaciones · ${hidden} tarjetas ocultadas · ${attempts} intentos sobre anuncios.`;
    const latest = [...events].reverse().find((e) => e.error || ['jev-connected', 'evaluated', 'kept', 'hidden', 'would-hide'].includes(e.outcome));
    $('health-error').textContent = latest?.error ? 'Última evaluación: ' + errorText(latest) : '';
    $('events').textContent = JSON.stringify({ version: chrome.runtime.getManifest().version,
      scope: 'YouTube experiment; events are not proof of blocked ads',
      configuration: { provider: live.provider, hasKey: health.hasKey, enabled: live.enabled, mode: live.mode,
        filterCards: live.filterCards, skipAds: live.skipAds, accelerateAds: live.accelerateAds },
      tabs: health.tabs, events }, null, 2);
  } catch { $('health-error').textContent = errorText({ error: 'transport' }); }
  finally { refreshing = false; }
}
$('connect').addEventListener('click', async () => {
  $('connect').disabled = true;
  try { await send({ type: 'probe-connect-tabs' }); await refresh(); }
  catch { $('health-error').textContent = errorText({ error: 'transport' }); }
  finally { $('connect').disabled = false; }
});
$('refresh').addEventListener('click', refresh);
$('restore').addEventListener('click', async () => { await send({ type: 'probe-restore' }); });
$('clear').addEventListener('click', async () => { await chrome.storage.session.remove('events'); await refresh(); });
$('export').addEventListener('click', async () => {
  await refresh();
  const url = URL.createObjectURL(new Blob([$('events').textContent], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'anyfilter-youtube-observations.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
chrome.storage.onChanged.addListener((_changes, area) => { if (area === 'session') void refresh(); });
setInterval(() => { if (!document.hidden) void refresh(); }, 2000);
await refresh();
