import { ProfileManager } from "./profile-manager.js";
import type { LocalStatePreparer, LocalStateReport } from "../transport.js";

/** BrowserTransport's LocalStatePreparer implementation: prepares/verifies the dedicated browser
 * profile directory via ProfileManager. Composition roots (src/broker/process.ts,
 * src/cli/runtime.ts) pass this to config/init.ts's initializeLocalState() and to doctor(), so
 * src/config never has to import anything under src/transports itself. */
export const browserLocalStatePreparer: LocalStatePreparer = {
  async prepareLocalState(profilePath: string): Promise<void> {
    await new ProfileManager(profilePath).prepare();
  },
  async verifyLocalState(profilePath: string): Promise<LocalStateReport> {
    await new ProfileManager(profilePath).verifyOwnership();
    return { owned: true };
  }
};
