// Process entrypoints intentionally construct BrowserTransport outside this foundation module.
// Keeping this file dependency-free prevents browser automation objects from crossing IPC/domain boundaries.
export { BrokerServer } from "./broker-server.js";
