import express from "express";
import request from "supertest";
import { beforeEach, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  loadConfig: vi.fn(() => ({ storageProvider: "local_disk" })),
  provider: vi.fn(() => ({})),
  ensure: vi.fn(async (owner) => owner),
  list: vi.fn(async () => ({ files: [] })),
}));
vi.mock("../config.js", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("../storage/provider-registry.js", () => ({ createStorageProviderFromConfig: mocks.provider }));
vi.mock("../services/work-folder-access.js", () => ({ assertWorkFolderAccess: mocks.access }));
vi.mock("../services/work-folders.js", () => ({
  workFolderService: () => ({ ensure: mocks.ensure, list: mocks.list }),
}));
import { workFolderRoutes } from "../routes/work-folders.js";

beforeEach(() => vi.clearAllMocks());

it("initializes storage only after access succeeds and reuses it while checking every request", async () => {
  const app = express();
  app.use("/api", workFolderRoutes({} as Db));
  app.use((_error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.sendStatus(403);
  });
  const base = "/api/companies/11111111-1111-4111-8111-111111111111/work-folders/task/22222222-2222-4222-8222-222222222222";
  expect(mocks.loadConfig).not.toHaveBeenCalled();
  mocks.access.mockRejectedValueOnce(new Error("denied"));
  await request(app).get(base).expect(403);
  expect(mocks.loadConfig).not.toHaveBeenCalled();
  await request(app).get(base).expect(200);
  await request(app).get(`${base}?trash=true`).expect(200);
  expect(mocks.loadConfig).toHaveBeenCalledTimes(1);
  expect(mocks.provider).toHaveBeenCalledTimes(1);
  mocks.access.mockRejectedValueOnce(new Error("revoked"));
  await request(app).get(base).expect(403);
  expect(mocks.access).toHaveBeenCalledTimes(4);
  expect(mocks.list).toHaveBeenCalledTimes(2);
});
