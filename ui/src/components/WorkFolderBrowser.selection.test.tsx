// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorkFolderBrowser } from "./WorkFolderBrowser";

const api = vi.hoisted(() => ({ list: vi.fn(), sync: vi.fn(), operation: vi.fn() }));
vi.mock("@/api/work-folders", () => ({ workFoldersApi: api }));
const owner = { companyId: "company", scope: "task" as const, ownerId: "task" };
const a = { id: "a", path: "a.txt", kind: "file" };
const b = { id: "b", path: "b.txt", kind: "file" };
let active = [a, b];
let deleted: typeof active = [];
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}
async function click(element: HTMLElement) {
  await act(async () => { element.focus(); element.click(); });
  await settle();
}
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.includes(text));
const checkbox = (path: string) => container.querySelector<HTMLInputElement>(`[data-file-tree-path="${path}"] input`)!;
beforeEach(async () => {
  active = [a, b]; deleted = [];
  api.list.mockImplementation(async (_owner, trash) => ({ files: [...(trash ? deleted : active)] }));
  api.sync.mockResolvedValue([]);
  api.operation.mockImplementation(async (_owner, operation) => {
    if (operation.action === "delete") {
      deleted.push(...active.filter((file) => file.path === operation.path));
      active = active.filter((file) => file.path !== operation.path);
    } else {
      active.push(...deleted.filter((file) => file.id === operation.fileId));
      deleted = deleted.filter((file) => file.id !== operation.fileId);
    }
    return { applied: true };
  });
  container = document.createElement("div"); document.body.append(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  root = createRoot(container);
  await act(async () => root.render(<QueryClientProvider client={client}><TooltipProvider><WorkFolderBrowser owner={owner} readOnly allowTrashActions /></TooltipProvider></QueryClientProvider>));
  await settle();
});
afterEach(async () => {
  await act(async () => root.unmount()); client.clear(); container.remove(); vi.clearAllMocks();
});
describe("cached file selection and retained trash", () => {
  it("only shows trash action for checked files and restores from the Trash tab", async () => {
    expect(button("to trash")).toBeUndefined();
    await click(checkbox("a.txt"));
    expect(checkbox("a.txt").checked).toBe(true);
    expect(button("Move 1 file to trash")).toBeDefined();
    await click(button("Move 1 file to trash")!);
    expect(active).toEqual([b]);
    expect(button("to trash")).toBeUndefined();
    await click(button("Trash")!);
    expect(container.textContent).toContain("a.txt");
    expect(button("Purge")).toBeUndefined();
    await click(button("Restore")!);
    await click(button("Files")!);
    expect(checkbox("a.txt")).not.toBeNull();
    expect(deleted).toEqual([]);
  });
  it("refreshes partial successes and leaves only failed files selected for retry", async () => {
    const operate = api.operation.getMockImplementation()!;
    api.operation.mockImplementation(async (target, operation) => {
      if (operation.path === "b.txt") throw new Error("Storage unavailable");
      return operate(target, operation);
    });
    await click(checkbox("a.txt")); await click(checkbox("b.txt"));
    await click(button("Move 2 files to trash")!);
    expect(checkbox("a.txt")).toBeNull();
    expect(checkbox("b.txt").checked).toBe(true);
    expect(container.textContent).toContain("Storage unavailable");
    expect(button("Move 1 file to trash")).toBeDefined();
    expect(deleted).toEqual([a]);
  });
});
