import { HostAllowlist } from "../../src/domain/host-pattern.js";
import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../../src/transports/browser/markdown-converter.js";
import {
  extractAttachmentCandidates,
  normalizeCitations,
  parseGroupedCitationAttributes,
  ResponseExtractor,
  truncate
} from "../../src/transports/browser/response-extractor.js";
import type { PageLike } from "../../src/transports/browser/types.js";

describe("browser response extraction helpers", () => {
  it("recognizes personal and shared opaque file links without filenames, including repeated labels", () => {
    const hosts = new HostAllowlist(["*.sharepoint.com"]);
    const links = ["b", "w", "x", "p", "t", "i", "v", "u"].flatMap((kind) =>
      ["p", "s", "r", "g"].map((scope) => ({
        title: "Download file",
        url: `https://tenant-my.sharepoint.com/:${kind}:/${scope}/person/token-${kind}-${scope}`
      }))
    );
    const found = extractAttachmentCandidates(links.slice(0, 16), hosts);
    expect(found).toHaveLength(16);
    expect(found.map((item) => item.url)).toEqual(links.slice(0, 16).map((item) => item.url));
    expect(extractAttachmentCandidates(links.slice(16), hosts)).toHaveLength(16);
    expect(
      extractAttachmentCandidates(
        [
          { title: "Folder", url: "https://tenant-my.sharepoint.com/:f:/p/person/token" },
          { title: "Download", url: "https://outside.example/:b:/p/person/token" }
        ],
        hosts
      )
    ).toEqual([]);
  });
  it("converts supported response structure and strips scripts", () => {
    expect(
      htmlToMarkdown(
        "<h2>Answer</h2><p>Hello <code>world</code></p><ul><li>One</li></ul><script>secret()</script>"
      )
    ).toContain("## Answer");
    expect(htmlToMarkdown("<script>secret()</script>Hi")).toBe("Hi");
  });
  it("deduplicates, caps, and filters citations", () => {
    expect(
      normalizeCitations([
        { url: "https://a.example/x#one" },
        { url: "https://a.example/x#two" },
        { url: "http://bad.example" }
      ])
    ).toHaveLength(1);
  });
  it("truncates on Unicode code points and marks the result", () => {
    const result = truncate("😀😀😀\n\nrest", 3);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe("😀😀😀");
  });

  it("targets current M365 Copilot replies without accepting generic articles", async () => {
    const extractor = new ResponseExtractor();
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      evaluate: async (_fn: unknown, arg?: unknown) => {
        const selector = (arg as { selector: string }).selector;
        expect(selector).toContain('[role="article"].fai-CopilotMessage');
        expect(selector).toContain('[data-testid="markdown-reply"]');
        expect(selector.split(", ")).not.toContain('[role="article"]');
        return {
          html: "<p>Current reply</p>",
          citations: [],
          groupedCitationAttributes: [
            JSON.stringify([
              {
                index: "1-f8d969",
                occurrence: 5,
                url: "https://github.com/nodejs/Release",
                name: "github.com"
              }
            ])
          ],
          actionRequired: false
        };
      }
    };

    await expect(extractor.extract(page, { assistantCount: 1 })).resolves.toMatchObject({
      text: "Current reply",
      citations: [
        {
          index: 1,
          marker: "1-f8d969",
          title: "github.com",
          source: "github.com",
          url: "https://github.com/nodejs/Release"
        }
      ]
    });
  });

  it("parses grouped M365 citation metadata and ignores malformed values", () => {
    expect(
      parseGroupedCitationAttributes([
        "not-json",
        JSON.stringify([
          { index: "2-abc", url: "https://nodejs.org/en/blog/release/v24.11.0", name: "nodejs.org" },
          { index: "missing-url", name: "ignored" }
        ])
      ])
    ).toEqual([
      {
        index: 2,
        marker: "2-abc",
        title: "nodejs.org",
        source: "nodejs.org",
        url: "https://nodejs.org/en/blog/release/v24.11.0"
      }
    ]);
  });

  it("classifies explicit filename anchors as attachments without treating normal citations as files", () => {
    expect(
      extractAttachmentCandidates([
        { title: "APL-01.pdf", url: "https://tenant.sharepoint.com/a" },
        { title: "diagram.png", url: "https://tenant.sharepoint.com/c" },
        { title: "bundle.tar.gz", url: "https://tenant.sharepoint.com/d" },
        { title: "Project documentation", url: "https://tenant.sharepoint.com/docs" },
        { title: "github.com", url: "https://github.com/nodejs/Release" },
        { title: "tenant.sharepoint.com", url: "https://tenant.sharepoint.com/docs" },
        { title: "github.com", url: "https://tenant.sharepoint.com/docs" },
        { title: "Something v1.0", url: "https://tenant.sharepoint.com/version" },
        { title: "unsafe.zip", url: "http://tenant.sharepoint.com/unsafe" },
        { title: "APL-02.docx", url: "https://tenant.sharepoint.com/b#viewer" }
      ])
    ).toEqual([
      { index: 1, name: "APL-01.pdf", url: "https://tenant.sharepoint.com/a" },
      { index: 2, name: "diagram.png", url: "https://tenant.sharepoint.com/c" },
      { index: 3, name: "bundle.tar.gz", url: "https://tenant.sharepoint.com/d" },
      { index: 4, name: "APL-02.docx", url: "https://tenant.sharepoint.com/b" }
    ]);
  });

  it("accepts arbitrary filename extensions on HTTPS attachment links", () => {
    const names = [
      "photo.jpeg",
      "vector.svg",
      "README.md",
      "config.xml",
      "page.html",
      "recording.mp3",
      "movie.mp4",
      "bundle.tar.gz",
      "single.x",
      "成果物.独自形式",
      "artifact.custom-binary"
    ];
    expect(
      extractAttachmentCandidates(
        names.map((title, index) => ({ title, url: `https://tenant.sharepoint.com/file-${index}` }))
      )
    ).toEqual(
      names.map((name, index) => ({
        index: index + 1,
        name,
        url: `https://tenant.sharepoint.com/file-${index}`
      }))
    );
  });

  it("classifies only explicitly identified download controls as attachment candidates", () => {
    expect(
      extractAttachmentCandidates([
        { title: "APL-T05-Word-Result 4", downloadControlIndex: 0 },
        { title: "recording", downloadControlIndex: 1 },
        { title: "payload.com", downloadControlIndex: 2 },
        { title: "APL-T06-Spreadsheet.xlsx", fileCardIndex: 2 },
        { title: "diagram.svg", fileCardIndex: 3 },
        { title: "design.ai", fileCardIndex: 4 },
        { title: "report.1.0", fileCardIndex: 5 },
        { title: "成果物.独自形式", fileCardIndex: 6 },
        { title: "Approve", actionControlIndex: 1 }
      ])
    ).toEqual([
      { index: 1, name: "APL-T05-Word-Result 4", downloadControlIndex: 0 },
      { index: 2, name: "recording", downloadControlIndex: 1 },
      { index: 3, name: "payload.com", downloadControlIndex: 2 },
      { index: 4, name: "APL-T06-Spreadsheet.xlsx", fileCardIndex: 2 },
      { index: 5, name: "diagram.svg", fileCardIndex: 3 },
      { index: 6, name: "design.ai", fileCardIndex: 4 },
      { index: 7, name: "report.1.0", fileCardIndex: 5 },
      { index: 8, name: "成果物.独自形式", fileCardIndex: 6 }
    ]);
  });

  it("recognizes a blob download anchor by its explicit download attribute", async () => {
    const extractor = new ResponseExtractor();
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      evaluate: async (fn: unknown) => {
        const source = String(fn);
        expect(source).toContain('getAttribute("download")');
        expect(source).toContain('matches("a[download]")');
        expect(source).not.toContain('hasAttribute("download")');
        return {
          html: "<p>Three PDFs and one ZIP are ready.</p>",
          citations: [
            { title: "APL-T09-Multi-01.pdf", url: "https://tenant.sharepoint.com/files/one.pdf" },
            { title: "APL-T09-Multi-02.pdf", url: "https://tenant.sharepoint.com/files/two.pdf" },
            { title: "APL-T09-Multi-03.pdf", url: "https://tenant.sharepoint.com/files/three.pdf" },
            { title: "APL-T09-Multi.zip", url: "blob:https://m365.cloud.microsoft/opaque" }
          ],
          downloadControls: [{ title: "APL-T09-Multi.zip", downloadControlIndex: 0 }],
          fileCards: [],
          actionRequired: false
        };
      }
    };

    await expect(extractor.extract(page, { assistantCount: 1 })).resolves.toMatchObject({
      attachmentCandidates: [
        { name: "APL-T09-Multi-01.pdf", url: "https://tenant.sharepoint.com/files/one.pdf" },
        { name: "APL-T09-Multi-02.pdf", url: "https://tenant.sharepoint.com/files/two.pdf" },
        { name: "APL-T09-Multi-03.pdf", url: "https://tenant.sharepoint.com/files/three.pdf" },
        { name: "APL-T09-Multi.zip", downloadControlIndex: 0 }
      ]
    });
  });

  it("does not promote a filename-only blob citation without a download attribute", () => {
    expect(
      extractAttachmentCandidates([
        { title: "APL-T09-Multi.zip", url: "blob:https://m365.cloud.microsoft/opaque" },
        { title: "APL-T09-Multi.zip" }
      ])
    ).toEqual([]);
  });

  it("keeps a button download attribute out of the control index before a ZIP anchor", async () => {
    const extractor = new ResponseExtractor();
    const page: PageLike = {
      url: () => "https://m365.example.test/chat",
      evaluate: async (fn: unknown) => {
        const source = String(fn);
        expect(source).toContain('matches("a[download]")');
        // A button carrying a filename is not a native download anchor and must not shift the
        // downloadControlIndex used later by attachment-saver.
        return {
          html: "<p>ZIP ready</p>",
          citations: [],
          downloadControls: [{ title: "APL-T09-Multi.zip", downloadControlIndex: 0 }],
          fileCards: [],
          actionRequired: false
        };
      }
    };

    await expect(extractor.extract(page, { assistantCount: 1 })).resolves.toMatchObject({
      attachmentCandidates: [{ name: "APL-T09-Multi.zip", downloadControlIndex: 0 }]
    });
  });

  it("prefers the real M365 file card over a same-name task-page link", () => {
    expect(
      extractAttachmentCandidates([
        { title: "APL-T08-PdfFile.pdf", url: "https://m365.cloud.microsoft/tasks" },
        { title: "APL-T08-PdfFile.pdf", fileCardIndex: 4 }
      ])
    ).toEqual([{ index: 1, name: "APL-T08-PdfFile.pdf", fileCardIndex: 4 }]);
  });

  it("accepts opaque SharePoint sharing links only on an explicit attachment host", () => {
    const citation = {
      title: "IQCbOpaqueCitationTitle",
      url: "https://tenant.sharepoint.com/:b:/g/personal/user/opaque-token"
    };

    expect(extractAttachmentCandidates([citation])).toEqual([]);
    expect(extractAttachmentCandidates([citation], new HostAllowlist(["tenant.sharepoint.com"]))).toEqual([
      {
        index: 1,
        name: "attachment-1",
        url: "https://tenant.sharepoint.com/:b:/g/personal/user/opaque-token"
      }
    ]);
  });

  it("ignores filename-shaped links outside configured attachment hosts", () => {
    expect(
      extractAttachmentCandidates(
        [{ title: "APL-T08-PdfFile.pdf", url: "https://m365.cloud.microsoft/tasks" }],
        new HostAllowlist(["tenant.sharepoint.com"])
      )
    ).toEqual([]);
  });

  it("accepts filename-shaped links on any host below a `*.` attachment-host wildcard, not the apex", () => {
    expect(
      extractAttachmentCandidates(
        [
          { title: "APL-T09-Wild.pdf", url: "https://contoso-my.sharepoint.com/personal/u/APL-T09-Wild.pdf" },
          { title: "APL-T09-Apex.pdf", url: "https://sharepoint.com/APL-T09-Apex.pdf" }
        ],
        new HostAllowlist(["*.sharepoint.com"])
      )
    ).toEqual([
      {
        index: 1,
        name: "APL-T09-Wild.pdf",
        url: "https://contoso-my.sharepoint.com/personal/u/APL-T09-Wild.pdf"
      }
    ]);
  });
});
