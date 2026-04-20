// Runs in the page's MAIN world. Monkey-patches fetch and XMLHttpRequest
// so we can capture the JSON response from Metabase's query endpoints.
// The last successful result is posted to the content-script world via
// window.postMessage, and the content script caches it for the Copy button.
//
// This sidesteps the virtualized-grid problem: we get the full row set
// straight from the API, no scrolling required.

(() => {
  if (window.__mbbqaInterceptorV2) return;
  window.__mbbqaInterceptorV2 = true;
  console.log("[mbbqa] interceptor v2 loaded (main world, patches fetch/XHR)");

  const matchUrl = (url) => {
    if (!url || typeof url !== "string") return false;
    return (
      url.includes("/api/dataset") ||
      /\/api\/card\/[^/]+\/query/.test(url) ||
      /\/api\/dashboard\/[^/]+\/card\/[^/]+\/query/.test(url)
    );
  };

  const toColumnNames = (cols) =>
    (cols || []).map((c) => c.display_name || c.name || c.id || "");

  const publish = (data) => {
    try {
      if (!data || !data.data) return;
      const cols = toColumnNames(data.data.cols);
      const rows = Array.isArray(data.data.rows) ? data.data.rows : [];
      const payload = {
        cols,
        rows: rows.map((r) => r.map((v) => stringifyCell(v))),
        rowCount: rows.length,
        totalRowsFromApi: data.row_count || data.data.rows_affected || null,
        capturedAt: Date.now(),
      };
      window.postMessage({ __mbbqa: "data-ready", payload }, "*");
    } catch (e) {
      // swallow — never let the interceptor break the page
    }
  };

  function stringifyCell(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }

  // --- fetch ---------------------------------------------------------------
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url =
        typeof args[0] === "string"
          ? args[0]
          : args[0] && args[0].url
          ? args[0].url
          : "";
      if (matchUrl(url)) {
        const clone = res.clone();
        clone
          .json()
          .then((data) => publish(data))
          .catch(() => {});
      }
    } catch {
      /* ignore */
    }
    return res;
  };

  // --- XMLHttpRequest ------------------------------------------------------
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__mbbqaUrl = url;
    return origOpen.apply(this, arguments);
  };
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    if (matchUrl(this.__mbbqaUrl)) {
      this.addEventListener("load", () => {
        try {
          const data = JSON.parse(this.responseText);
          publish(data);
        } catch {
          /* ignore */
        }
      });
    }
    return origSend.apply(this, arguments);
  };
})();
