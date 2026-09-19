// Declarative loading and connecting an existing tab may run together.
if (!globalThis.__anyfilterYoutubeProbe) {
  globalThis.__anyfilterYoutubeProbe = import(chrome.runtime.getURL('content.js'))
    .then(({ start }) => start()).catch(() => {
      delete globalThis.__anyfilterYoutubeProbe;
      void chrome.runtime.sendMessage({ type: 'probe-report', event: {
        surface: 'connection', outcome: 'startup-error', error: 'content-startup',
      } }).catch(() => {});
    });
}
