import type { DownloadHostCheck } from "../../src/services/setup-plan.js";

/**
 * APL-REVIEW-04: one table of "download hosts" field texts and the verdict both implementations must
 * reach -- `checkDownloadHosts()` on the host (tests/extension/plan.test.ts, which splits the text
 * on commas the way media/setup.js submits it) and the webview's live mirror
 * (tests/extension/webview-browser.test.ts). Only inputs that Node's and Chromium's URL parsers
 * treat identically belong here.
 */
export const DOWNLOAD_HOST_VECTORS: ReadonlyArray<{ text: string } & DownloadHostCheck> = [
  { text: "https://bad host/", hosts: [], invalid: [{ value: "https://bad host/", problem: "whitespace" }] },
  {
    text: "*.sharepoint.com, onedrive.live.com",
    hosts: ["*.sharepoint.com", "onedrive.live.com"],
    invalid: []
  },
  {
    text: "  HTTPS://Files.Example.com/x  , files.example.com, nope, ",
    hosts: ["files.example.com"],
    invalid: [{ value: "nope", problem: "not-a-domain" }]
  },
  { text: "localhost", hosts: [], invalid: [{ value: "localhost", problem: "not-a-domain" }] },
  {
    text: "*.com, contoso.*.com, *sharepoint.com",
    hosts: [],
    invalid: [
      { value: "*.com", problem: "invalid-wildcard" },
      { value: "contoso.*.com", problem: "invalid-wildcard" },
      { value: "*sharepoint.com", problem: "invalid-wildcard" }
    ]
  },
  {
    text: "user@example.com, example.com., 例え.jp",
    hosts: [],
    invalid: [
      { value: "user@example.com", problem: "invalid-host" },
      { value: "example.com.", problem: "invalid-host" },
      { value: "例え.jp", problem: "invalid-host" }
    ]
  },
  {
    text: "onedrive.live.com:443, https://*.SharePoint.com/sites/x, https://files.example.com:8443/p?q=1",
    hosts: ["*.sharepoint.com", "files.example.com", "onedrive.live.com"],
    invalid: []
  },
  {
    text: "exam ple.com, ok.example.com",
    hosts: ["ok.example.com"],
    invalid: [{ value: "exam ple.com", problem: "whitespace" }]
  },
  { text: "192.168.0.10", hosts: ["192.168.0.10"], invalid: [] },
  { text: " , ,", hosts: [], invalid: [] }
];
