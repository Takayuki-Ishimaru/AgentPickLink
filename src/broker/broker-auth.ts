import { randomBytes, randomUUID } from "node:crypto";
export const createBrokerSecret = (): string => randomBytes(32).toString("base64url");
export const createBrokerInstanceId = (): string => `broker_${randomUUID()}`;
