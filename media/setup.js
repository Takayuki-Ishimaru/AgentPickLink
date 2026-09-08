/* AgentPickLink setup panel (webview). Framework-free ES2020.
 * Everything rendered here comes from the host as data; the DOM is built node by node (never
 * innerHTML) so agent-supplied names and descriptions can never become markup. */
/* global acquireVsCodeApi, document, window, setTimeout */
(function () {
  "use strict";

  var vscode = acquireVsCodeApi();

  var STRINGS = {
    ja: {
      title: "Microsoft 365 エージェント",
      setup: "環境をセットアップする",
      chooseNext: "エージェントを選択して保存",
      workspacePending: "このフォルダーはまだ設定されていません。",
      workspaceApproved: "このフォルダーの設定は保存・承認済みです。",
      workspaceApprovalRequired: "このフォルダーの設定は、このPCでの承認が必要です。",
      readyToUse: "利用可能",
      cancelDiscovery: "一覧の更新を中止",
      discoveryCancelled: "更新を中止しました。取得済み・保存済みの一覧は残しています。",
      savedNeedsSignIn: "設定は保存済みです。利用するにはサインインしてください。",
      descriptionSummary: "{total}件を表示・説明あり {descriptions}件",
      partialSummary:
        "一覧の追加取得が一部完了していません。取得済みの候補は選択できます。必要に応じて更新してください。",
      updatingSummary: "保存済みの一覧を表示しています。新しいエージェントは「一覧を更新」で取得できます。",
      refreshList: "一覧を更新",
      inspectingDetails: "エージェントの説明を取得しています",
      readingCatalogue: "利用できるエージェントを確認しています",
      loadingMicrosoft: "Microsoft 365 を読み込んでいます",
      refresh: "接続して更新",
      refreshHelp: "保存済みの一覧から利用できます。新しいエージェントを探すときは一覧を更新してください。",
      chooseHelp: "このワークスペースで使うエージェントを選び、保存してください。",
      descriptionMissing: "Microsoft 365 から説明を取得できませんでした。",
      authenticated: "Microsoft 365 に接続済み",
      signInRequired: "サインインが必要です",
      disconnected: "未接続",
      connectionOptions: "連携とファイルの設定",
      account: "アカウント・サポート",
      signIn: "サインイン",
      signOut: "サインアウト",
      openLogs: "ログを開く",
      save: "承認して保存",
      searchPlaceholder: "エージェントを検索",
      downloadHosts: "ダウンロードを許可するホスト (カンマ区切り)",
      downloadHostsPlaceholder: "*.sharepoint.com, onedrive.live.com, contoso.example",
      acceptDownloads: "ダウンロードを受け入れる",
      missingDownloadHosts:
        "保存を許可するホストが空のため、ファイルを保存できません。許可するホストを指定して「承認して保存」を押してください。",
      useDefaultDownloadHosts: "SharePoint・OneDriveの標準ホストを入力",
      integrations: "AI クライアント連携",
      codex: "Codex",
      claudeCode: "Claude Code",
      vscodeMcpJson: "VS Code",
      capability: "ファイル生成・アクションあり",
      details: "詳細",
      broker: "ブローカー",
      browser: "ブラウザー",
      workspace: "ワークスペース",
      platform: "プラットフォーム",
      running: "起動中",
      stopped: "停止",
      uiChanged: "Microsoft 365 の画面構成が想定と異なります。開発者に確認してください。",
      copyDiagnostics: "診断をコピー",
      unregister: "登録を削除",
      cancelSignIn: "サインインを中止",
      signInCancelled: "サインインを中止しました",
      browserSignInTitle: "開いたブラウザーでサインインしてください",
      browserSignInInstructions:
        "エージェントを利用する職場または学校アカウントでサインインし、追加認証もブラウザーで操作してください。個人用アカウントが表示された場合は、アカウントのメニューから職場・学校アカウントへ切り替えてください。完了するとウィンドウは自動で閉じます。その後、このパネルに戻ってください。",
      browserSignInFinishing: "サインインを確認しています。このパネルでお待ちください。",
      usageHint: "使い方のヒント",
      revokeWorkspace: "このワークスペースの承認を取り消す",
      advanced: "詳細設定",
      channel: "使用するブラウザー",
      attachmentRetentionHours: "添付ファイルの保持時間 (時間)",
      attachmentQuotaBytes: "添付ファイルの上限 (バイト)",
      applyAdvanced: "適用",
      suggestedHosts: "提案",
      devModeBadge: "開発モード",
      noAgents: "候補がまだありません。サインイン後に一覧を取得できます。",
      noAgentsConnected:
        "エージェントが見つかりませんでした。エージェントを利用する職場・学校アカウントか確認してください。別のアカウントを使う場合は、詳細設定からサインアウトして再接続できます。",
      noMatches: "検索条件に一致するエージェントがありません。",
      selected: "選択中",
      warnings: "警告",
      diagnostics: "診断情報",
      agents: "エージェント",
      phase: {
        idle: "待機中",
        checking: "確認中",
        "signing-in": "サインイン中",
        discovering: "エージェントを読み込み中",
        selecting: "エージェントを選択",
        saving: "保存中",
        done: "完了",
        connected: "接続済み",
        error: "エラー"
      },
      progressPhase: {
        connecting: "ローカル接続を開始しています",
        "restarting-broker": "接続を復旧しています",
        "login-waiting": "ブラウザーでのサインイン操作を待っています",
        "login-closing": "サインイン用のウィンドウを閉じています",
        verifying: "確認しています"
      },
      badge: { registered: "登録済み", assigned: "このワークスペース", manual: "手動" },
      assignmentStatus: {
        ready: "承認済み",
        "approval-required": "要承認",
        "binding-mismatch": "バインディング不一致",
        unverified: "未検証",
        disabled: "無効",
        "policy-blocked": "ポリシーでブロック",
        "unsupported-entrypoint": "未対応のエントリポイント",
        unresolved: "未解決"
      }
    },
    en: {
      title: "Microsoft 365 agents",
      setup: "Set up environment",
      chooseNext: "Choose agents and save",
      workspacePending: "This folder is not set up yet.",
      workspaceApproved: "Settings for this folder are saved and approved.",
      workspaceApprovalRequired: "This folder needs approval on this PC.",
      readyToUse: "Ready to use",
      cancelDiscovery: "Cancel list update",
      discoveryCancelled: "Update cancelled. Retrieved and saved agents have been kept.",
      savedNeedsSignIn: "Settings are saved. Sign in to use these agents.",
      descriptionSummary: "{total} agents shown · {descriptions} with descriptions",
      partialSummary:
        "Some additional agents could not be checked. Retrieved agents can still be selected. Refresh to try again.",
      updatingSummary: "Showing saved agents. Use Refresh list to find new agents.",
      refreshList: "Refresh list",
      inspectingDetails: "Reading agent descriptions",
      readingCatalogue: "Checking available agents",
      loadingMicrosoft: "Loading Microsoft 365",
      refresh: "Connect and refresh",
      refreshHelp: "Use your saved agents, or refresh the list to find new ones.",
      chooseHelp: "Select the agents to use in this workspace, then save.",
      descriptionMissing: "No description was retrieved from Microsoft 365.",
      authenticated: "Connected to Microsoft 365",
      signInRequired: "Sign-in required",
      disconnected: "Not connected",
      connectionOptions: "Client and file settings",
      account: "Account and support",
      signIn: "Sign in",
      signOut: "Sign out",
      openLogs: "Open logs",
      save: "Approve and save",
      searchPlaceholder: "Search agents",
      downloadHosts: "Download hosts (comma separated)",
      downloadHostsPlaceholder: "*.sharepoint.com, onedrive.live.com, contoso.example",
      acceptDownloads: "Accept downloads",
      missingDownloadHosts:
        "Files cannot be saved because no download hosts are allowed. Enter the hosts you allow, then approve and save.",
      useDefaultDownloadHosts: "Fill in standard SharePoint and OneDrive hosts",
      integrations: "AI client integrations",
      codex: "Codex",
      claudeCode: "Claude Code",
      vscodeMcpJson: "VS Code",
      capability: "File output / actions possible",
      details: "Details",
      broker: "Broker",
      browser: "Browser",
      workspace: "Workspace",
      platform: "Platform",
      running: "running",
      stopped: "stopped",
      uiChanged:
        "The Microsoft 365 page structure differs from what this version expects. Check with the developer.",
      copyDiagnostics: "Copy diagnostics",
      unregister: "Unregister",
      cancelSignIn: "Cancel sign-in",
      signInCancelled: "Sign-in cancelled",
      browserSignInTitle: "Sign in using the browser window that opened",
      browserSignInInstructions:
        "Sign in with the work or school account that has your agents and complete any additional authentication in the browser. If a personal account appears, use its account menu to switch to your work or school account. The window closes automatically when sign-in is complete. Then return to this panel.",
      browserSignInFinishing: "Checking your sign-in. Please wait in this panel.",
      usageHint: "Usage hint",
      revokeWorkspace: "Revoke this workspace's approval",
      advanced: "Advanced",
      channel: "Browser to use",
      attachmentRetentionHours: "Attachment retention (hours)",
      attachmentQuotaBytes: "Attachment quota (bytes)",
      applyAdvanced: "Apply",
      suggestedHosts: "Suggested",
      devModeBadge: "development mode",
      noAgents: "No agents yet. Sign in to load the available agents.",
      noAgentsConnected:
        "No agents were found. Check that you are using the work or school account with your agents. To use another account, sign out in Advanced and reconnect.",
      noMatches: "No agent matches the search.",
      selected: "selected",
      warnings: "Warnings",
      diagnostics: "Diagnostics",
      agents: "Agents",
      phase: {
        idle: "idle",
        checking: "Checking connection",
        "signing-in": "Signing in",
        discovering: "Loading agents",
        selecting: "select agents",
        saving: "Saving settings",
        done: "done",
        connected: "connected",
        error: "error"
      },
      progressPhase: {
        connecting: "Starting the local connection",
        "restarting-broker": "Restoring the connection",
        "login-waiting": "Waiting for you to sign in using the browser",
        "login-closing": "Closing the sign-in window",
        verifying: "Verifying"
      },
      badge: { registered: "registered", assigned: "this workspace", manual: "manual" },
      assignmentStatus: {
        ready: "approved",
        "approval-required": "approval required",
        "binding-mismatch": "binding mismatch",
        unverified: "unverified",
        disabled: "disabled",
        "policy-blocked": "policy blocked",
        "unsupported-entrypoint": "unsupported entry point",
        unresolved: "unresolved"
      }
    }
  };

  var INCIDENT_CODES = [
    // Only page-structure drift warrants the "check with the developer" banner; sign-in and
    // browser-process incidents are operational and are reflected in the status header instead.
    "UI_CHANGED",
    "UNSUPPORTED_UI",
    "CHAT_INPUT_NOT_FOUND",
    "CHAT_INPUT_AMBIGUOUS",
    "NEW_CONVERSATION_UNVERIFIED",
    "AGENT_IDENTITY_UNVERIFIED",
    "AGENT_IDENTITY_MISMATCH",
    "AGENT_CONTEXT_CHANGED",
    "RESPONSE_EXTRACTION_FAILED"
  ];

  var state = {
    phase: "idle",
    candidates: [],
    selectedKeys: [],
    warnings: [],
    diagnostics: [],
    incidents: [],
    integrations: { codex: false, claudeCode: false, vscodeMcpJson: false },
    locale: "en",
    version: ""
  };
  var local = {
    search: "",
    downloadHosts: undefined,
    acceptDownloads: undefined,
    integrations: undefined,
    selected: new Set(),
    edits: {},
    expanded: {},
    signature: null,
    advancedExpanded: false,
    advanced: {},
    optionsExpanded: false,
    selectionDirty: false
  };

  function t() {
    return STRINGS[state.locale] || STRINGS.en;
  }

  function h(tag, props) {
    var node = document.createElement(tag);
    if (props)
      Object.keys(props).forEach(function (key) {
        if (key === "class") node.className = props[key];
        else if (key === "text") node.textContent = props[key];
        else if (key.slice(0, 2) === "on") node.addEventListener(key.slice(2).toLowerCase(), props[key]);
        else if (props[key] === true) node[key] = true;
        else if (props[key] !== undefined && props[key] !== false && props[key] !== null)
          node.setAttribute(key, props[key]);
      });
    for (var index = 2; index < arguments.length; index += 1) {
      var child = arguments[index];
      if (child === undefined || child === null || child === false) continue;
      if (Array.isArray(child)) child.forEach(node.appendChild.bind(node));
      else node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }

  function send(message) {
    vscode.postMessage(message);
  }

  function busy() {
    return ["checking", "signing-in", "discovering", "saving"].indexOf(state.phase) >= 0;
  }

  function canSave() {
    return !busy() && local.selected.size > 0;
  }

  function selectionSummary() {
    var strings = t();
    return strings.agents + " (" + local.selected.size + " " + strings.selected + ")";
  }

  // Ticking an agent must not rebuild the whole panel: render() recreates the agent list, which
  // resets its scroll position. Only the two nodes that depend on the selection -- the count in
  // the heading and the Save button's enabled state -- are refreshed in place.
  function syncSelection() {
    var count = document.getElementById("agent-count");
    if (count) count.textContent = selectionSummary();
    var save = document.getElementById("save-button");
    if (save) save.disabled = !canSave();
  }

  function edit(key) {
    if (!local.edits[key]) local.edits[key] = {};
    return local.edits[key];
  }

  function candidateName(candidate) {
    return candidate.displayName || candidate.url;
  }

  function candidateDescription(candidate) {
    return candidate.description || "";
  }

  function candidateActions(candidate) {
    var stored = local.edits[candidate.key];
    if (stored && stored.actionsPossible !== undefined) return stored.actionsPossible;
    return !!(candidate.registered && candidate.registered.capabilityClass === "actions-possible");
  }

  function candidateUsageHint(candidate) {
    var stored = local.edits[candidate.key];
    if (stored && stored.usageHint !== undefined) return stored.usageHint;
    return (candidate.registered && candidate.registered.usageHint) || "";
  }

  /* ---------------------------------------------------------------- sections */

  function isDevMode() {
    var devMode = state.devMode;
    return !!(devMode && (devMode.insecureLoopback || devMode.devAppUrl));
  }

  function statusSection() {
    var strings = t();
    var status = state.status;
    var auth = status && status.broker.authState && status.broker.authState.state;
    var approved = status && status.workspace.configured && status.workspace.approvalStatus === "approved";
    var connection =
      auth === "authenticated"
        ? approved
          ? strings.readyToUse
          : strings.authenticated
        : ["sign-in-required", "interactive-auth", "access-denied"].indexOf(auth) >= 0
          ? strings.signInRequired
          : strings.disconnected;
    return h(
      "section",
      { class: "status-section" },
      h(
        "div",
        { class: "header-row" },
        h("span", { class: "brand-mark", "aria-hidden": "true" }),
        h("h2", { text: strings.title }),
        isDevMode() ? h("span", { class: "badge dev", text: strings.devModeBadge }) : null
      ),
      h("div", {
        class: "connection-status",
        role: "status",
        text: busy() ? strings.phase[state.phase] : connection
      }),
      h("p", {
        class: "workspace-state",
        text: approved
          ? strings.workspaceApproved
          : status && status.workspace.configured
            ? strings.workspaceApprovalRequired
            : strings.workspacePending
      }),
      h("p", { class: "muted", text: approved ? strings.updatingSummary : "" })
    );
  }

  function technicalStatus() {
    var status = state.status;
    if (!status) return null;
    var strings = t();
    var rows = [];
    var push = function (label, value) {
      rows.push(h("dt", { text: label }), h("dd", { text: value }));
    };
    push(strings.platform, status.platform.os);
    push(strings.browser, status.browser.channel);
    push(strings.broker, status.broker.live ? strings.running : strings.stopped);
    push(strings.workspace, status.workspace.approvalStatus);
    push("Version", state.version);
    return h("dl", { class: "status-grid" }, rows);
  }

  function noticeBanner() {
    if (!state.notice) return null;
    var strings = t();
    var text =
      {
        "sign-in-cancelled": strings.signInCancelled,
        "discovery-cancelled": strings.discoveryCancelled,
        "saved-needs-sign-in": strings.savedNeedsSignIn
      }[state.notice] || state.notice;
    return h("div", { class: "banner info", role: "status" }, h("div", { text: text }));
  }

  function signInBanner() {
    if (state.phase !== "signing-in") return null;
    var strings = t();
    var finishing =
      state.progress && ["login-closing", "verifying", "done"].indexOf(state.progress.phase) >= 0;
    return h(
      "div",
      { class: "banner info", role: "status" },
      finishing
        ? h("div", { text: strings.browserSignInFinishing })
        : [
            h("div", { class: "headline", text: strings.browserSignInTitle }),
            h("div", { text: strings.browserSignInInstructions })
          ]
    );
  }

  function incidentBanner() {
    var strings = t();
    var relevant = (state.incidents || []).filter(function (incident) {
      return INCIDENT_CODES.indexOf(incident.code) >= 0;
    });
    if (state.error || relevant.length === 0) return null;
    return h(
      "div",
      { class: "banner warn", role: "status" },
      h("div", { text: strings.uiChanged }),
      h(
        "div",
        { class: "actions" },
        h("button", {
          class: "secondary",
          text: strings.copyDiagnostics,
          onclick: function () {
            send({ type: "copyDiagnostics" });
          }
        })
      )
    );
  }

  /* The headline is the host's localized one-liner for the error code; the original English
   * message and remediation stay underneath in smaller type, verbatim, because that is the text a
   * user copies into a report and the developer greps for. An unknown code has no localized
   * summary, in which case the English message becomes the headline and is not repeated. */
  function errorBanner() {
    if (!state.error) return null;
    var error = state.error;
    var localizedRemediation = error.localizedRemediation || null;
    var showsOriginalRemediation = !!error.remediation && error.remediation !== localizedRemediation;
    return h(
      "div",
      { class: "banner error" },
      h("div", { class: "headline", text: error.summary || error.message }),
      localizedRemediation ? h("div", { text: localizedRemediation }) : null,
      h(
        "details",
        null,
        h("summary", { text: t().diagnostics }),
        h("div", { class: "code", text: error.code }),
        error.summary ? h("div", { class: "muted original", text: error.message }) : null,
        showsOriginalRemediation ? h("div", { class: "muted original", text: error.remediation }) : null
      )
    );
  }

  function warningsBanner() {
    if (!state.warnings || state.warnings.length === 0) return null;
    return h(
      "div",
      { class: "banner warn" },
      h("div", { text: t().warnings }),
      h(
        "ul",
        null,
        state.warnings.map(function (warning) {
          return h("li", { text: warning });
        })
      )
    );
  }

  /** Discovery's metadata-only summaries (strategy counts, store tally, page descriptions): what
   * the run saw, not what went wrong, so they get the neutral banner. */
  function diagnosticsBanner() {
    if (!state.diagnostics || state.diagnostics.length === 0) return null;
    return h(
      "div",
      { class: "banner info" },
      h("div", { text: t().diagnostics }),
      h(
        "ul",
        null,
        state.diagnostics.map(function (line) {
          return h("li", { text: line });
        })
      )
    );
  }

  function progressLine() {
    if (!state.progress) return null;
    var strings = t();
    var progress = state.progress;
    var label =
      strings.progressPhase[progress.phase] || strings.phase[state.phase] || strings.loadingMicrosoft;
    if (progress.phase === "discovering") {
      var message = progress.message || "";
      label = /description/.test(message)
        ? strings.inspectingDetails
        : /store|sidebar|links|agent list/.test(message)
          ? strings.readingCatalogue
          : strings.loadingMicrosoft;
    }
    var elapsed = progress.elapsedMs ? " (" + Math.floor(progress.elapsedMs / 1000) + "s)" : "";
    // Store card counts have changing denominators and include irrelevant catalogue entries.
    // Only a bounded verification pass is a meaningful x/y progress indicator.
    var count =
      progress.phase === "verifying" &&
      typeof progress.current === "number" &&
      typeof progress.total === "number"
        ? " " + progress.current + "/" + progress.total
        : "";
    return h("p", { class: "progress", role: "status", text: label + count + elapsed });
  }

  function discoverySummary() {
    var summary = state.discoverySummary;
    if (!summary) return null;
    return h(
      "div",
      { class: "banner " + (summary.partial ? "warn" : "info"), role: "status" },
      h("div", {
        text: t()
          .descriptionSummary.replace("{total}", summary.total)
          .replace("{descriptions}", summary.descriptions)
      }),
      summary.partial ? h("div", { text: t().partialSummary }) : null
    );
  }

  function actionsSection() {
    var strings = t();
    var disabled = busy();
    var button = function (label, message, secondary) {
      return h("button", {
        class: secondary ? "secondary" : "",
        text: label,
        disabled: disabled,
        onclick: function () {
          send({ type: message });
        }
      });
    };
    var buttons = [
      button(
        state.status &&
          (!state.status.broker.authState || state.status.broker.authState.state !== "authenticated")
          ? strings.signIn
          : state.candidates.length
            ? strings.refreshList
            : strings.setup,
        state.status &&
          (!state.status.broker.authState || state.status.broker.authState.state !== "authenticated")
          ? "signIn"
          : "refresh"
      )
    ];
    // G1: not gated on `disabled` -- it must stay clickable while `busy()` is true, since a
    // sign-in in progress is exactly what makes it busy.
    if (state.phase === "signing-in")
      buttons.push(
        h("button", {
          class: "secondary",
          text: strings.cancelSignIn,
          onclick: function () {
            send({ type: "cancelSignIn" });
          }
        })
      );
    if (state.phase === "discovering")
      buttons.push(
        h("button", {
          class: "secondary",
          text: strings.cancelDiscovery,
          onclick: function () {
            send({ type: "cancelDiscovery" });
          }
        })
      );
    return h("div", { class: "actions primary-actions" }, buttons);
  }

  function assignmentStatusLabel(candidate) {
    var strings = t();
    if (!candidate.assigned || !candidate.assignmentStatus) return null;
    return strings.assignmentStatus[candidate.assignmentStatus] || candidate.assignmentStatus;
  }

  function agentRow(candidate) {
    var strings = t();
    var key = candidate.key;
    var checked = local.selected.has(key);
    var expanded = !!local.expanded[key];
    var badges = [];
    if (candidate.assigned) badges.push(assignmentStatusLabel(candidate) || strings.badge.assigned);
    var head = h(
      "div",
      { class: "agent-head" },
      h(
        "label",
        { class: "agent-select", for: "select-" + key, "aria-label": candidateName(candidate) },
        h("input", {
          type: "checkbox",
          id: "select-" + key,
          checked: checked,
          disabled: busy(),
          onchange: function (event) {
            if (event.target.checked) local.selected.add(key);
            else local.selected.delete(key);
            local.selectionDirty = true;
            syncSelection();
          }
        })
      ),
      h(
        "span",
        { class: "agent-name" },
        h("span", { text: candidateName(candidate) }),
        badges.map(function (label) {
          return h("span", { class: "badge", text: label });
        }),
        h("p", {
          class: "agent-description",
          text: candidateDescription(candidate) || strings.descriptionMissing
        })
      ),
      h("button", {
        class: "link agent-details-toggle",
        "aria-expanded": String(expanded),
        text: expanded ? "▾ " + strings.details : "▸ " + strings.details,
        "aria-label": strings.details + ": " + candidateName(candidate),
        onclick: function () {
          local.expanded[key] = !expanded;
          render();
        }
      })
    );
    if (!expanded) return h("div", { class: "agent" }, head);
    return h(
      "div",
      { class: "agent" },
      head,
      h(
        "div",
        { class: "agent-body" },
        h("span", { class: "agent-url", text: candidate.url }),
        h("label", { for: "usage-" + key, text: strings.usageHint }),
        h(
          "textarea",
          {
            id: "usage-" + key,
            oninput: function (event) {
              edit(key).usageHint = event.target.value;
            }
          },
          candidateUsageHint(candidate)
        ),
        h(
          "label",
          { class: "check" },
          h("input", {
            type: "checkbox",
            id: "cap-" + key,
            checked: candidateActions(candidate),
            onchange: function (event) {
              edit(key).actionsPossible = event.target.checked;
            }
          }),
          h("span", { text: strings.capability })
        ),
        h(
          "div",
          { class: "row" },
          candidate.registered
            ? h("button", {
                class: "link danger",
                text: strings.unregister,
                onclick: function () {
                  send({ type: "unregisterAgent", key: key });
                }
              })
            : null
        )
      )
    );
  }

  function agentsSection() {
    var strings = t();
    var needle = local.search.trim().toLowerCase();
    var visible = state.candidates.filter(function (candidate) {
      if (needle.length === 0) return true;
      return (
        (candidateName(candidate) + " " + candidate.url + " " + (candidate.description || ""))
          .toLowerCase()
          .indexOf(needle) >= 0
      );
    });
    var list =
      state.candidates.length === 0
        ? [
            h("div", {
              class: "empty",
              text: busy()
                ? strings.phase[state.phase]
                : state.status?.broker.authState?.state === "authenticated"
                  ? strings.noAgentsConnected
                  : strings.noAgents
            })
          ]
        : visible.length === 0
          ? [h("div", { class: "empty", text: strings.noMatches })]
          : visible.map(agentRow);
    return h(
      "section",
      null,
      h("h2", { id: "agent-count", text: selectionSummary() }),
      h("p", { class: "muted", text: strings.chooseHelp }),
      h("input", {
        type: "search",
        id: "search",
        placeholder: strings.searchPlaceholder,
        "aria-label": strings.searchPlaceholder,
        value: local.search,
        oninput: function (event) {
          local.search = event.target.value;
          render();
        }
      }),
      h("div", { class: "agents", id: "agent-list", "aria-busy": String(busy()) }, list)
    );
  }

  function configuredDownloadHosts() {
    return state.status ? state.status.config.downloadHosts || [] : [];
  }

  // Whether one configured entry covers `host`: an exact hostname, or a `*.` wildcard suffix that
  // matches any host below that domain but not the domain itself. Mirrors HostAllowlist in
  // src/domain/host-pattern.ts, which is the authority on the broker side.
  function hostCoveredBy(host, entry) {
    var normalizedHost = host.toLowerCase().replace(/\.$/, "");
    var normalizedEntry = entry.toLowerCase().replace(/\.$/, "");
    if (normalizedEntry.slice(0, 2) === "*.") {
      var suffix = normalizedEntry.slice(1);
      return normalizedHost.length > suffix.length && normalizedHost.slice(-suffix.length) === suffix;
    }
    return normalizedHost === normalizedEntry;
  }

  // G4: `state.suggestedDownloadHosts`, re-filtered against the currently configured hosts.
  // discoverInto() (src/extension/setup-view.ts) already excludes hosts already configured at the
  // time it ran, but this still re-filters defensively in case a Save in between made a suggestion
  // redundant without a fresh discover() clearing it. A tenant host such as
  // `contoso.sharepoint.com` is redundant once the default `*.sharepoint.com` covers it.
  function activeSuggestedDownloadHosts() {
    var configured = configuredDownloadHosts();
    return (state.suggestedDownloadHosts || []).filter(function (host) {
      return !configured.some(function (entry) {
        return hostCoveredBy(host, entry);
      });
    });
  }

  function defaultDownloadHosts() {
    if (local.downloadHosts !== undefined) return local.downloadHosts;
    // Pre-fills the field with the configured hosts plus the active suggestions. This is a
    // pre-fill only: nothing is saved until the user presses Save, and editing the field replaces
    // this default entirely.
    return configuredDownloadHosts().concat(activeSuggestedDownloadHosts()).join(", ");
  }

  function defaultAcceptDownloads() {
    if (local.acceptDownloads !== undefined) return local.acceptDownloads;
    return !!(state.status && state.status.config.acceptDownloads);
  }

  function missingDownloadHosts() {
    return (
      defaultAcceptDownloads() &&
      !defaultDownloadHosts()
        .split(",")
        .some(function (host) {
          return host.trim();
        })
    );
  }

  function syncDownloadHostHint() {
    var hint = document.getElementById("download-host-hint");
    if (hint) hint.hidden = !missingDownloadHosts();
  }

  function integrationFlags() {
    return local.integrations || state.integrations;
  }

  function optionsSection() {
    var strings = t();
    var flags = integrationFlags();
    var toggle = function (name, label) {
      return h(
        "label",
        { class: "check" },
        h("input", {
          type: "checkbox",
          id: "integration-" + name,
          checked: flags[name],
          onchange: function (event) {
            local.integrations = Object.assign({}, integrationFlags());
            local.integrations[name] = event.target.checked;
          }
        }),
        h("span", { text: label })
      );
    };
    return h(
      "details",
      {
        class: "options-section",
        open: local.optionsExpanded || missingDownloadHosts(),
        ontoggle: function (event) {
          local.optionsExpanded = event.target.open;
        }
      },
      h("summary", { text: strings.connectionOptions }),
      h("label", { for: "download-hosts", class: "muted", text: strings.downloadHosts }),
      h("input", {
        type: "text",
        id: "download-hosts",
        value: defaultDownloadHosts(),
        placeholder: strings.downloadHostsPlaceholder,
        oninput: function (event) {
          local.downloadHosts = event.target.value;
          syncDownloadHostHint();
        }
      }),
      h(
        "div",
        { id: "download-host-hint", hidden: !missingDownloadHosts() },
        h("p", { text: strings.missingDownloadHosts }),
        h("button", {
          class: "secondary",
          text: strings.useDefaultDownloadHosts,
          onclick: function () {
            // This only edits the field. Persisting the allowlist still requires approval and Save.
            local.downloadHosts = "*.sharepoint.com, onedrive.live.com";
            render();
          }
        })
      ),
      (function () {
        var suggested = local.downloadHosts === undefined ? activeSuggestedDownloadHosts() : [];
        return suggested.length > 0
          ? h("div", {
              class: "muted suggested-hosts",
              text: strings.suggestedHosts + ": " + suggested.join(", ")
            })
          : null;
      })(),
      h(
        "label",
        { class: "check" },
        h("input", {
          type: "checkbox",
          id: "accept-downloads",
          checked: defaultAcceptDownloads(),
          onchange: function (event) {
            local.acceptDownloads = event.target.checked;
            syncDownloadHostHint();
          }
        }),
        h("span", { text: strings.acceptDownloads })
      ),
      h("h2", { text: strings.integrations }),
      toggle("codex", strings.codex),
      toggle("claudeCode", strings.claudeCode),
      toggle("vscodeMcpJson", strings.vscodeMcpJson)
    );
  }

  function saveSection() {
    return h(
      "div",
      { class: "actions save-actions" },
      h("button", {
        id: "save-button",
        text: t().save,
        disabled: !canSave(),
        onclick: submit
      })
    );
  }

  function submit() {
    var agents = [];
    state.candidates.forEach(function (candidate) {
      if (!local.selected.has(candidate.key)) return;
      agents.push({
        key: candidate.key,
        usageHint: candidateUsageHint(candidate),
        actionsPossible: candidateActions(candidate)
      });
    });
    send({
      type: "save",
      plan: {
        agents: agents,
        downloadHosts: defaultDownloadHosts()
          .split(",")
          .map(function (value) {
            return value.trim();
          })
          .filter(function (value) {
            return value.length > 0;
          }),
        acceptDownloads: defaultAcceptDownloads(),
        integrations: integrationFlags()
      }
    });
  }

  /* ---------------------------------------------------------------- advanced */

  function advancedValue(name, fallback) {
    return local.advanced[name] !== undefined ? local.advanced[name] : fallback;
  }

  function advancedSection() {
    var strings = t();
    var status = state.status;
    if (!status) return null;
    var expanded = !!local.advancedExpanded;
    var header = h(
      "h2",
      null,
      h("button", {
        class: "link",
        text: (expanded ? "▾ " : "▸ ") + strings.advanced,
        onclick: function () {
          local.advancedExpanded = !expanded;
          render();
        }
      })
    );
    if (!expanded) return h("section", null, header);

    var channelValue = advancedValue("channel", status.browser.channel);
    var retentionValue = advancedValue("attachmentRetentionHours", status.config.attachmentRetentionHours);
    var quotaValue = advancedValue("attachmentQuotaBytes", status.config.attachmentQuotaBytes);

    return h(
      "section",
      null,
      header,
      technicalStatus(),
      warningsBanner(),
      diagnosticsBanner(),
      h("h2", { text: strings.account }),
      h(
        "div",
        { class: "actions" },
        [
          [strings.signOut, "signOut"],
          [strings.openLogs, "openLogs"],
          [strings.copyDiagnostics, "copyDiagnostics"],
          [strings.revokeWorkspace, "revokeWorkspace"]
        ].map(function (entry) {
          return h("button", {
            class: "secondary",
            text: entry[0],
            disabled: busy(),
            onclick: function () {
              send({ type: entry[1] });
            }
          });
        })
      ),
      h("label", { for: "advanced-channel", class: "muted", text: strings.channel }),
      h(
        "select",
        {
          id: "advanced-channel",
          onchange: function (event) {
            local.advanced = Object.assign({}, local.advanced, { channel: event.target.value });
          }
        },
        ["msedge", "chrome", "chromium"].map(function (channel) {
          return h("option", { value: channel, selected: channel === channelValue, text: channel });
        })
      ),
      typeof retentionValue === "number"
        ? [
            h("label", {
              for: "advanced-retention",
              class: "muted",
              text: strings.attachmentRetentionHours
            }),
            h("input", {
              type: "number",
              id: "advanced-retention",
              min: "1",
              value: String(retentionValue),
              oninput: function (event) {
                var parsed = parseInt(event.target.value, 10);
                if (!isNaN(parsed))
                  local.advanced = Object.assign({}, local.advanced, { attachmentRetentionHours: parsed });
              }
            })
          ]
        : null,
      typeof quotaValue === "number"
        ? [
            h("label", { for: "advanced-quota", class: "muted", text: strings.attachmentQuotaBytes }),
            h("input", {
              type: "number",
              id: "advanced-quota",
              min: "0",
              value: String(quotaValue),
              oninput: function (event) {
                var parsed = parseInt(event.target.value, 10);
                if (!isNaN(parsed))
                  local.advanced = Object.assign({}, local.advanced, { attachmentQuotaBytes: parsed });
              }
            })
          ]
        : null,
      h(
        "div",
        { class: "actions" },
        h("button", {
          text: strings.applyAdvanced,
          disabled: busy(),
          onclick: function () {
            var patch = Object.assign({}, local.advanced);
            local.advanced = {};
            send({ type: "updateConfig", patch: patch });
          }
        })
      )
    );
  }

  /* ---------------------------------------------------------------- render */

  function render() {
    var active = document.activeElement;
    var focusId = active && active.id ? active.id : null;
    var caret = focusId && "selectionStart" in active ? active.selectionStart : null;

    var listBefore = document.getElementById("agent-list");
    var listScroll = listBefore ? listBefore.scrollTop : 0;
    var pageScroll = window.scrollY;
    var app = document.getElementById("app");
    while (app.firstChild) app.removeChild(app.firstChild);
    [
      statusSection(),
      signInBanner(),
      progressLine(),
      noticeBanner(),
      discoverySummary(),
      errorBanner(),
      incidentBanner(),
      actionsSection(),
      agentsSection(),
      optionsSection(),
      saveSection(),
      advancedSection()
    ].forEach(function (node) {
      if (node) app.appendChild(node);
    });

    if (focusId) {
      var restored = document.getElementById(focusId);
      if (restored) {
        restored.focus({ preventScroll: true });
        if (caret !== null && "setSelectionRange" in restored)
          try {
            restored.setSelectionRange(caret, caret);
          } catch {
            /* inputs of type search/number reject setSelectionRange in some builds */
          }
      }
    }
    var listAfter = document.getElementById("agent-list");
    if (listAfter) listAfter.scrollTop = listScroll;
    window.scrollTo(0, pageScroll);
  }

  function accept(next) {
    // NUL never occurs in a key (a URL or an agent id), so joined keys cannot collide.
    var signature = next.candidates
      .map(function (candidate) {
        return candidate.key;
      })
      .join("\u0000");
    state = next;
    if (next.phase === "idle" && !next.status) local.selectionDirty = false;
    if (signature !== local.signature) {
      local.signature = signature;
      if (!local.selectionDirty) local.selected = new Set(next.selectedKeys || []);
      else
        local.selected = new Set(
          Array.from(local.selected).filter(function (key) {
            return next.candidates.some(function (candidate) {
              return candidate.key === key;
            });
          })
        );
      var keys = {};
      next.candidates.forEach(function (candidate) {
        keys[candidate.key] = true;
      });
      Object.keys(local.edits).forEach(function (key) {
        if (!keys[key]) delete local.edits[key];
      });
    }
    if (next.phase === "done") {
      local.selectionDirty = false;
      local.selected = new Set(next.selectedKeys || []);
      local.downloadHosts = undefined;
      local.acceptDownloads = undefined;
      local.integrations = undefined;
    }
    render();
  }

  window.addEventListener("message", function (event) {
    var message = event.data;
    if (message && message.type === "state" && message.state) accept(message.state);
  });

  render();
  setTimeout(function () {
    send({ type: "ready" });
  }, 0);
})();
