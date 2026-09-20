/* global window, document, fetch, TextDecoder */
/* A header-authenticated EventSource equivalent: native EventSource cannot set custom headers. */
(function () {
  "use strict";
  var headers = { "X-APL-Session": window.aplSession };
  delete window.aplSession;
  var listener;
  window.aplBrowser = {
    postMessage: function (message) {
      return fetch("/message", {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        headers: Object.assign({ "Content-Type": "application/json" }, headers),
        body: JSON.stringify(message)
      }).catch(function () {
        showNotice("Setup closed. / セットアップは終了しました。");
      });
    },
    onMessage: function (callback) {
      listener = callback;
    }
  };
  function showNotice(text) {
    document.getElementById("terminal-notice").textContent = text;
  }
  (async function () {
    try {
      var response = await fetch("/events", { headers: headers, credentials: "omit", cache: "no-store" });
      if (!response.ok) throw new Error("closed");
      var reader = response.body.getReader(),
        decoder = new TextDecoder(),
        pending = "";
      for (;;) {
        var chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        var end;
        while ((end = pending.indexOf("\n\n")) !== -1) {
          var event = pending.slice(0, end);
          pending = pending.slice(end + 2);
          if (event.indexOf("data: ") !== 0) continue;
          var message = JSON.parse(event.slice(6));
          if (message.type === "terminal") showNotice(message.text);
          else if (listener) listener(message);
        }
      }
    } catch {
      /* Never expose a URL or token in diagnostics. */
    }
    showNotice("Setup closed. Check the terminal. / セットアップは終了しました。端末を確認してください。");
  })();
})();
