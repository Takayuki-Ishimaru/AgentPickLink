import { BaseChatUiAdapter, type SurfaceChatAdapterOptions } from "./base-chat-adapter.js";
export class M365CopilotChatAdapter extends BaseChatUiAdapter {
  constructor(options: SurfaceChatAdapterOptions = {}) {
    super({
      ...options,
      id: "m365-copilot-chat@1",
      surface: "m365-copilot",
      hostnames: options.hostnames ?? []
    });
  }
}
