import { BaseChatUiAdapter, type SurfaceChatAdapterOptions } from "./base-chat-adapter.js";
export class AgentBuilderChatAdapter extends BaseChatUiAdapter {
  constructor(options: SurfaceChatAdapterOptions = {}) {
    super({
      ...options,
      id: "agent-builder-chat@1",
      surface: "m365-copilot",
      hostnames: options.hostnames ?? []
    });
  }
}
