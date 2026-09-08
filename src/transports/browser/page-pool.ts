import type { BrowserManager } from "./browser-manager.js";
import type { PageHandle } from "./types.js";
export class PagePool {
  private pages = new Map<string, PageHandle>();
  constructor(private readonly manager: BrowserManager) {}
  async acquire(pageKey: string): Promise<PageHandle> {
    const existing = this.pages.get(pageKey);
    if (existing && !existing.page.isClosed?.()) return existing;
    const page = await this.manager.createConversationPage(pageKey);
    this.pages.set(pageKey, page);
    return page;
  }
  async release(pageKey: string, close = false): Promise<void> {
    if (close) {
      await this.manager.closePage(pageKey);
      this.pages.delete(pageKey);
    }
  }
  async closeAll(): Promise<void> {
    for (const key of this.pages.keys()) await this.manager.closePage(key);
    this.pages.clear();
  }
  size(): number {
    return this.pages.size;
  }
}
