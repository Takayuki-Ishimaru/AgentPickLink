import { BaseChatUiAdapter, type SurfaceChatAdapterOptions } from "./base-chat-adapter.js";
export class CopilotStudioM365Adapter extends BaseChatUiAdapter {
  constructor(options: SurfaceChatAdapterOptions = {}) {
    super({
      ...options,
      id: "copilot-studio-m365-chat@1",
      surface: "m365-copilot",
      hostnames: options.hostnames ?? []
    });
  }
}
