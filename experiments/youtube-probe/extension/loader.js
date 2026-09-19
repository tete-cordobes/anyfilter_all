void import(chrome.runtime.getURL('content.js')).then(({ start }) => start()).catch(() => {});
