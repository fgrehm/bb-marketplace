// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { rpcContract } from "./server";
import type { Rating } from "./model";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const prompt = {
  threadId: "thr_a",
  title: "Debug an intermittent cache miss",
  archivedAt: 1000,
};

describe("archive-only UI", () => {
  it("has no thread header action and shows nothing before an archive", async () => {
    const app = await loadPluginApp(() => import("./app"));
    expect(app.threadHeaderActions).toHaveLength(0);
    const slot = renderSlot(
      app.appOverlays[0]!,
      {},
      { rpc: { pending: () => ({ prompt: null, count: 0 }) } },
    );
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(1));
    expect(slot.queryByRole("dialog")).toBe(null);
    slot.lifecycle.unmount();
  });
  it("opens on archive, preserves failed-save drafts, then saves or skips without sending chat messages", async () => {
    const app = await loadPluginApp(() => import("./app"));
    let archived = false;
    let failSave = true;
    const slot = renderSlot<{}, typeof rpcContract>(
      app.appOverlays[0]!,
      {},
      {
        rpc: {
          pending: () => ({
            prompt: archived ? prompt : null,
            count: archived ? 1 : 0,
          }),
          getRating: () => null,
          savePrompt: (input) => {
            if (failSave) throw new Error("History temporarily unavailable");
            archived = false;
            return {
              ...input,
              projectId: "proj_a",
              title: prompt.title,
              providerId: "pi",
              createdAt: 1000,
              updatedAt: 1000,
              revision: 1,
              history: {
                capturedAt: 1000,
                throughSeq: 0,
                status: "partial",
                warnings: [],
                observations: [],
              },
            };
          },
          dismiss: () => {
            archived = false;
            return { removed: true };
          },
          editRating: () => {
            throw new Error("Unexpected edit");
          },
          deleteRating: () => {
            throw new Error("Unexpected delete");
          },
          list: () => ({ ratings: [], total: 0 }),
          exportPage: () => ({ rating: null }),
        },
      },
    );
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(1));
    archived = true;
    await slot.behavior.emitRealtime("changed", null);
    await slot.findByRole("dialog");
    fireEvent.click(await slot.findByRole("radio", { name: "4, Useful" }));
    const note = slot.getByLabelText(/What worked/);
    fireEvent.change(note, {
      target: { value: "Great diagnosis, needed one hint" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Save rating" }));
    await slot.findByRole("alert");
    expect((note as HTMLTextAreaElement).value).toBe(
      "Great diagnosis, needed one hint",
    );
    failSave = false;
    fireEvent.click(slot.getByRole("button", { name: "Save rating" }));
    await waitFor(() => expect(slot.queryByRole("dialog")).toBe(null));
    archived = true;
    await slot.behavior.emitRealtime("changed", null);
    fireEvent.click(
      await slot.findByRole("button", { name: "Skip this chat" }),
    );
    await waitFor(() => expect(slot.queryByRole("dialog")).toBe(null));
    expect(
      slot.inspection.rpcCalls.some((call) => call.method === "savePrompt"),
    ).toBe(true);
    slot.lifecycle.unmount();
  });
  it("reconciles missed archive signals on socket reconnect without discarding an open draft", async () => {
    const app = await loadPluginApp(() => import("./app"));
    let archived = false;
    const slot = renderSlot(
      app.appOverlays[0]!,
      {},
      {
        rpc: {
          pending: () => ({
            prompt: archived ? prompt : null,
            count: archived ? 1 : 0,
          }),
          getRating: () => null,
        },
        realtimeConnectionState: "connected",
      },
    );
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(1));
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    archived = true;
    await slot.behavior.setRealtimeConnectionState("connected");
    const note = await slot.findByLabelText(/What worked/);
    fireEvent.change(note, {
      target: { value: "Keep my draft after reconnect" },
    });
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    await slot.behavior.setRealtimeConnectionState("connected");
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.filter((call) => call.method === "pending"),
      ).toHaveLength(3),
    );
    expect(
      (slot.getByLabelText(/What worked/) as HTMLTextAreaElement).value,
    ).toBe("Keep my draft after reconnect");
    expect(
      slot.inspection.rpcCalls.filter((call) => call.method === "getRating"),
    ).toHaveLength(1);
    slot.lifecycle.unmount();
  });
  it("refreshes the saved-rating library after reconnect", async () => {
    const app = await loadPluginApp(() => import("./app"));
    let reads = 0;
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          list: () => {
            reads++;
            return { ratings: [], total: 0 };
          },
        },
        realtimeConnectionState: "connected",
      },
    );
    await slot.findByText(/No saved ratings here yet/);
    expect(reads).toBe(1);
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    await slot.behavior.setRealtimeConnectionState("connected");
    await waitFor(() => expect(reads).toBe(2));
    slot.lifecycle.unmount();
  });
  it("edits saved feedback, confirms deletion, and exports all observations as a local download", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const first: Rating = {
      threadId: prompt.threadId,
      projectId: "proj_a",
      title: prompt.title,
      providerId: "pi",
      score: 4,
      useCase: "debugging",
      note: "Original note",
      archivedAt: prompt.archivedAt,
      createdAt: 1000,
      updatedAt: 1000,
      revision: 1,
      history: {
        capturedAt: 1000,
        throughSeq: 1,
        status: "recorded",
        warnings: [],
        observations: [
          {
            seq: 1,
            at: 1000,
            model: "example/model",
            reasoningLevel: "high",
            evidence: "requested",
            requestId: null,
            originalModel: null,
            rejected: false,
          },
        ],
      },
    };
    const second: Rating = {
      ...first,
      threadId: "thr_b",
      title: "Second rated chat",
      note: "Second note",
    };
    let records = [first, second];
    const downloads: Blob[] = [];
    const createUrl = vi.fn((blob: Blob) => {
      downloads.push(blob);
      return "blob:chat-ratings";
    });
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = createUrl;
        static revokeObjectURL = vi.fn();
      },
    );
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    const slot = renderSlot<{ subPath: string }, typeof rpcContract>(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          pending: () => ({ prompt: null, count: 0 }),
          dismiss: () => ({ removed: false }),
          savePrompt: () => {
            throw new Error("Unexpected archive save");
          },
          list: () => ({
            ratings: records.map((rating) => ({
              ...rating,
              variations: [],
              variationCount: 1,
            })),
            total: records.length,
          }),
          getRating: ({ threadId }: { threadId: string }) =>
            records.find((record) => record.threadId === threadId) ?? null,
          editRating: (input: {
            threadId: string;
            expectedRevision: number;
            score: number;
            useCase: Rating["useCase"];
            note: string;
          }) => {
            records = records.map((record) =>
              record.threadId === input.threadId
                ? { ...record, ...input, revision: record.revision + 1 }
                : record,
            );
            return records.find(
              (record) => record.threadId === input.threadId,
            )!;
          },
          deleteRating: ({ threadId }: { threadId: string }) => {
            records = records.filter((record) => record.threadId !== threadId);
            return { removed: true };
          },
          exportPage: ({ afterThreadId = "" }) => ({
            rating:
              records.find((record) => record.threadId > afterThreadId) ?? null,
          }),
        },
      },
    );
    await slot.findByText("Original note");
    fireEvent.click(slot.getByRole("button", { name: "Export JSON" }));
    await waitFor(() => expect(createUrl).toHaveBeenCalledOnce());
    const blobText = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(downloads[0]!);
    });
    expect(JSON.parse(blobText)).toMatchObject({
      schemaVersion: 1,
      ratings: [first, second],
    });
    expect(click).toHaveBeenCalledOnce();
    fireEvent.click(slot.getAllByRole("button", { name: "Edit feedback" })[0]!);
    fireEvent.change(await slot.findByLabelText(/What worked/), {
      target: { value: "Improved note" },
    });
    fireEvent.click(slot.getByRole("radio", { name: "5, Very useful" }));
    fireEvent.click(slot.getByRole("button", { name: "Save rating" }));
    await slot.findByText("Improved note");
    expect(records[0]).toMatchObject({
      score: 5,
      revision: 2,
      history: first.history,
    });
    fireEvent.click(slot.getAllByRole("button", { name: "Delete" })[0]!);
    expect(records).toHaveLength(2);
    fireEvent.click(slot.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(records).toHaveLength(1));
    await waitFor(() => expect(slot.queryByText(prompt.title)).toBe(null));
    slot.lifecycle.unmount();
  });
  it("library is read-only until explicit editing and has no rate-active-chat affordance", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      { rpc: { list: () => ({ ratings: [], total: 0 }) } },
    );
    await slot.findByText(/No saved ratings here yet/);
    expect(slot.queryByRole("radio")).toBe(null);
    expect(slot.queryByRole("button", { name: "Rate chat" })).toBe(null);
    slot.lifecycle.unmount();
  });
});
