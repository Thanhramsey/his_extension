/**
 * VNPT HIS Network Interceptor
 * Injected script running in the main page context to intercept XHR & Fetch API requests.
 * Manifest V3 CSP Compliant.
 */
(function() {
  if (window.__HIS_INTERCEPTOR_INJECTED__) return;
  window.__HIS_INTERCEPTOR_INJECTED__ = true;

  console.log('🩺 VNPT HIS Network Interceptor active (XHR + Fetch Interceptor)');

  // 1. Intercept XMLHttpRequest
  const origXHR = window.XMLHttpRequest.prototype.open;
  window.XMLHttpRequest.prototype.open = function(method, url) {
    this.addEventListener('load', function() {
      try {
        if (url) {
          const u = String(url).toLowerCase();
          if (u.includes('cls') || u.includes('xetnghiem') || u.includes('cdha') || u.includes('buongdieutri') || u.includes('ketqua') || u.includes('danhsach') || u.includes('benhnhan') || u.includes('pacs') || u.includes('dicom')) {
            window.postMessage({
              type: 'HIS_XHR_DATA',
              url: url,
              response: this.responseText
            }, '*');
          }
        }
      } catch(e) {}
    });
    return origXHR.apply(this, arguments);
  };

  // 2. Intercept Fetch API
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = async function(...args) {
      const response = await origFetch.apply(this, args);
      try {
        const url = args[0] ? (typeof args[0] === 'string' ? args[0] : args[0].url) : '';
        if (url) {
          const u = String(url).toLowerCase();
          if (u.includes('cls') || u.includes('xetnghiem') || u.includes('cdha') || u.includes('buongdieutri') || u.includes('ketqua') || u.includes('danhsach') || u.includes('benhnhan') || u.includes('pacs') || u.includes('dicom')) {
            const clone = response.clone();
            clone.text().then(text => {
              window.postMessage({
                type: 'HIS_XHR_DATA',
                url: url,
                response: text
              }, '*');
            }).catch(() => {});
          }
        }
      } catch(e) {}
      return response;
    };
  }
})();
