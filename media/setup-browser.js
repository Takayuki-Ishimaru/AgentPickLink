/* global window, document, fetch, TextDecoder */
/* A header-authenticated EventSource equivalent: native EventSource cannot set custom headers. */
(function () {
  "use strict";
  var headers = { "X-APL-Session": window.aplSession };
  delete window.aplSession;
  var listener;
  var pendingRequests = 0;
  var expired = false;
  var requestFailure = false;
  function transportState() {
    if (listener) listener({ type: "transport", pending: pendingRequests > 0, expired: expired });
  }
  window.aplBrowser = {
    postMessage: async function (message) {
      var cancellation = message.type === "cancelDiscovery" || message.type === "cancelSignIn";
      if (expired) {
        showNotice(
          "Session expired. Restart setup from the terminal. / セッションが失効しました。端末からセットアップをやり直してください。"
        );
        return;
      }
      if (pendingRequests && !cancellation) {
        showNotice(
          "An operation is in progress. Wait for its result. / 操作を実行中です。結果をお待ちください。"
        );
        return;
      }
      pendingRequests += 1;
      transportState();
      if (message.type !== "ready") showNotice("Sending request… / 要求を送信中…");
      try {
        var response = await fetch("/message", {
          method: "POST",
          credentials: "omit",
          cache: "no-store",
          headers: Object.assign({ "Content-Type": "application/json" }, headers),
          body: JSON.stringify(message)
        });
        requestFailure = !response.ok;
        if (response.status === 403 || response.status === 410) {
          expired = true;
          showNotice(
            "Session expired or access denied (HTTP " +
              response.status +
              "). Restart setup from the terminal. / セッション失効またはアクセス拒否です。端末からセットアップをやり直してください。"
          );
        } else if (response.status === 409) {
          showNotice(
            "Another operation is running (409). Wait and check its result before trying again. / 別の操作を実行中です。完了と結果を確認してから操作してください。"
          );
        } else if (!response.ok) {
          showNotice(
            "Server error (HTTP " +
              response.status +
              "). Check the terminal and current settings before retrying; the operation may have partly completed. / サーバーエラーです。処理が一部完了した可能性があります。端末と現在の設定を確認してください。"
          );
        } else if (
          message.type !== "ready" &&
          document.getElementById("terminal-notice").textContent === "Sending request… / 要求を送信中…"
        ) {
          showNotice(
            "Request finished. Check the status below. / 要求の処理が終了しました。下の状態を確認してください。"
          );
        }
      } catch {
        requestFailure = true;
        showNotice(
          "Network disconnected; result unknown. Check the terminal and current settings before sending again. / 通信が切断され、結果は不明です。再送する前に端末と現在の設定を確認してください。"
        );
      } finally {
        pendingRequests -= 1;
        transportState();
      }
    },
    onMessage: function (callback) {
      listener = callback;
      transportState();
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
    expired = true;
    transportState();
    if (!requestFailure)
      showNotice("Setup closed. Check the terminal. / セットアップは終了しました。端末を確認してください。");
  })();
})();
