import { BaseChatUiAdapter, type SurfaceChatAdapterOptions } from "./base-chat-adapter.js";
export class TeamsWebAdapter extends BaseChatUiAdapter {
  constructor(options: SurfaceChatAdapterOptions = {}) {
    super({
      ...options,
      id: "teams-web-agent-chat@1",
      surface: "teams-web",
      hostnames: options.hostnames ?? []
    });
  }
}
