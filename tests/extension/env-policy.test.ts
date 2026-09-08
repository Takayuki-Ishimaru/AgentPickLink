import { describe, expect, it } from "vitest";
import { persistedEnvironment } from "../../src/extension/env-policy.js";

describe("persistedEnvironment", () => {
  it("is empty when neither ELECTRON_RUN_AS_NODE nor an app-data override is set", () => {
    expect(persistedEnvironment({}, undefined)).toEqual({});
  });

  it("keeps ELECTRON_RUN_AS_NODE when the resolved Node runtime needed it", () => {
    expect(persistedEnvironment({ ELECTRON_RUN_AS_NODE: "1" }, undefined)).toEqual({
      ELECTRON_RUN_AS_NODE: "1"
    });
  });

  it("keeps an overridden M365_AGENT_APP_DATA", () => {
    expect(persistedEnvironment({}, "/custom/app-data")).toEqual({
      M365_AGENT_APP_DATA: "/custom/app-data"
    });
  });

  it("never lets M365_AGENT_DEV_* development overrides through, even if smuggled into nodeEnv", () => {
    const smuggled = {
      ELECTRON_RUN_AS_NODE: "1",
      M365_AGENT_DEV_APP_URL: "http://127.0.0.1:4000",
      M365_AGENT_DEV_INSECURE_LOOPBACK: "1"
    };
    expect(persistedEnvironment(smuggled, "/data")).toEqual({
      ELECTRON_RUN_AS_NODE: "1",
      M365_AGENT_APP_DATA: "/data"
    });
  });
});
