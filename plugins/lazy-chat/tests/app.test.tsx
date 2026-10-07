// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { createFakeSdk } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type {
  PluginRpcTestHandlers,
  RenderSlotOptions,
} from "@get-bb/plugin-sdk/testing/app";
import type { PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import { createMarkdownStore } from "../markdown-store";
import type { rpcContract } from "../server";

afterEach(cleanup);

const message: PluginMessageDirectiveProps["message"] = {
  id: "msg-current",
  threadId: "thr_thread1",
  turnId: "turn-1",
  projectId: "project-1",
};
const props = { message, attributes: {}, source: "", openWorkspaceFile: null };
type ReplyRpcHandlers = PluginRpcTestHandlers<typeof rpcContract>;
type ReplyRenderOptions = Omit<RenderSlotOptions<typeof rpcContract>, "rpc"> & {
  rpc?: Partial<ReplyRpcHandlers>;
};
const eligible: ReplyRpcHandlers = {
  lazy_reply_eligible: async () => ({ eligible: true }),
  lazy_reply_load: async () => ({
    status: "loaded" as const,
    contributionBody: "Agent contribution",
    draftBody: null,
    draftSha256: null,
  }),
  lazy_reply_save: async () => ({
    status: "saved" as const,
    sha256: "a".repeat(64),
  }),
};
async function renderReply(
  options: ReplyRenderOptions,
  attributes: Readonly<Record<string, string>> = {},
  source = "",
) {
  const app = await loadPluginApp(() => import("../app"));
  const handlers: ReplyRpcHandlers = { ...eligible, ...options.rpc };
  return renderSlot<PluginMessageDirectiveProps, typeof rpcContract>(
    app.messageDirectives[0]!,
    { ...props, attributes, source },
    { ...options, rpc: handlers },
  );
}
function createStoreBackedRpc() {
  const entries = new Map<string, string>();
  const hash = (content: string) =>
    createHash("sha256").update(content, "utf8").digest("hex");
  const { sdk } = createFakeSdk({
    pluginId: "lazy-chat",
    overrides: {
      files: {
        read: async ({ path }) => {
          const content = entries.get(path);
          if (content === undefined)
            throw Object.assign(new Error("missing"), {
              status: 404,
              code: "ENOENT",
            });
          return {
            path,
            content,
            contentEncoding: "utf8",
            sizeBytes: Buffer.byteLength(content),
            sha256: hash(content),
          };
        },
        write: async ({ path, content, expectedSha256 }) => {
          const old = entries.get(path);
          const currentSha256 = old === undefined ? null : hash(old);
          if (expectedSha256 !== undefined && expectedSha256 !== currentSha256)
            return { outcome: "conflict", currentSha256 };
          entries.set(path, content);
          return {
            outcome: "written",
            sha256: hash(content),
            sizeBytes: Buffer.byteLength(content),
          };
        },
      },
    },
  });
  const store = createMarkdownStore(sdk.files, {
    hostId: "host-1",
    rootPath: "/workspace/project",
  });
  const contribution = {
    version: 1 as const,
    kind: "contribution" as const,
    threadId: message.threadId,
    turnId: message.turnId!,
    messageId: message.id,
    attribution: "agent" as const,
    draftStatus: "immutable" as const,
    body: "Agent contribution",
  };
  return {
    entries,
    lazy_reply_eligible: async () => ({ eligible: true }),
    async lazy_reply_load(identity: {
      threadId: string;
      turnId: string;
      messageId: string;
    }) {
      await store.saveContribution({ ...contribution, ...identity });
      const result = await store.loadDraft(identity);
      if (result.status === "loaded")
        return {
          status: "loaded" as const,
          contributionBody: contribution.body,
          draftBody: result.record.body,
          draftSha256: result.sha256,
        };
      if (result.status === "missing")
        return {
          status: "loaded" as const,
          contributionBody: contribution.body,
          draftBody: null,
          draftSha256: null,
        };
      return {
        status: "storage_error" as const,
        reason: "read_failed" as const,
      };
    },
    async lazy_reply_save(input: {
      threadId: string;
      turnId: string;
      messageId: string;
      body: string;
      expectedSha256: string | null;
    }) {
      const record = {
        version: 1 as const,
        kind: "draft" as const,
        attribution: "human" as const,
        draftStatus: "active" as const,
        ...input,
      };
      const result =
        input.expectedSha256 === null
          ? await store.createDraft(record)
          : await store.updateDraft(record, input.expectedSha256);
      if (
        result.status === "created" ||
        result.status === "updated" ||
        result.status === "reused"
      )
        return { status: "saved" as const, sha256: result.sha256 };
      const disk = await store.loadDraft(input);
      if (disk.status === "loaded")
        return {
          status: "conflict" as const,
          diskBody: disk.record.body,
          diskSha256: disk.sha256,
        };
      return {
        status: "conflict" as const,
        diskBody: null,
        diskSha256: null,
      };
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Lazy Chat reply directive", () => {
  it("renders directive context inside a card with BB theme classes", async () => {
    const slot = await renderReply(
      {
        rpc: eligible,
        context: { threadId: message.threadId },
        composer: {
          text: "",
          scope: { kind: "thread", threadId: message.threadId },
        },
      },
      { context: "What should we prioritize next?" },
    );

    expect(
      await screen.findByText("What should we prioritize next?"),
    ).toBeTruthy();
    const card = screen.getByRole("region", { name: "Lazy Chat reply" });
    expect(card.className).toContain("bg-card");
    expect(card.className).toContain("text-card-foreground");
    expect(card.className).toContain("border-border");
    slot.lifecycle.unmount();
  });

  it("falls back to the assistant message context and omits the directive", async () => {
    const slot = await renderReply(
      {
        rpc: {
          ...eligible,
          lazy_reply_load: async () => ({
            status: "loaded" as const,
            contributionBody:
              "Could you outline the next steps?\n\n::lazy-reply{}",
            draftBody: null,
            draftSha256: null,
          }),
        },
        context: { threadId: message.threadId },
        composer: {
          text: "",
          scope: { kind: "thread", threadId: message.threadId },
        },
      },
      {},
      "::lazy-reply{}",
    );

    expect(
      await screen.findByText("Could you outline the next steps?"),
    ).toBeTruthy();
    expect(screen.queryByText("::lazy-reply{}")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("autosaves and restores the same reply round after unmount and reopen", async () => {
    const rpc = createStoreBackedRpc();
    const first = await renderReply({
      rpc,
      context: { threadId: message.threadId },
      composer: {
        text: "",
        scope: { kind: "thread", threadId: message.threadId },
      },
    });
    const firstEditor = await screen.findByRole("textbox", {
      name: "Reply draft",
    });
    fireEvent.change(firstEditor, { target: { value: "unfinished reply" } });
    await screen.findByText(/saved/i);
    first.lifecycle.unmount();

    const reopened = await renderReply({
      rpc,
      context: { threadId: message.threadId },
      composer: {
        text: "",
        scope: { kind: "thread", threadId: message.threadId },
      },
    });
    const reopenedEditor = await screen.findByRole("textbox", {
      name: "Reply draft",
    });
    await waitFor(() =>
      expect((reopenedEditor as HTMLTextAreaElement).value).toBe(
        "unfinished reply",
      ),
    );
    expect(reopened.inspection.composer.text).toBe("");
    expect([...rpc.entries.keys()]).toContain(
      "/workspace/project/.lazyai/bb/thr_thread1/turn-1/draft.md",
    );
    reopened.lifecycle.unmount();
  });

  it("keeps inline edits in Lazy Chat without syncing the main composer", async () => {
    const slot = await renderReply({
      rpc: eligible,
      context: { threadId: message.threadId },
      composer: {
        text: "",
        scope: { kind: "thread", threadId: message.threadId },
      },
    });
    const editor = await screen.findByRole("textbox", { name: "Reply draft" });
    fireEvent.change(editor, { target: { value: "private lazy reply" } });
    await screen.findByText("Saved to thread storage.");

    expect(slot.inspection.composer.text).toBe("");
    expect((editor as HTMLTextAreaElement).value).toBe("private lazy reply");
    slot.lifecycle.unmount();
  });

  it("blocks sending without changing a populated main composer", async () => {
    const slot = await renderReply({
      rpc: eligible,
      context: { threadId: message.threadId },
      composer: {
        text: "native draft that must survive",
        scope: { kind: "thread", threadId: message.threadId },
      },
    });
    const editor = await screen.findByRole("textbox", { name: "Reply draft" });
    fireEvent.change(editor, { target: { value: "lazy reply" } });
    await screen.findByText("Saved to thread storage.");
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));

    expect(screen.getByRole("alert").textContent).toMatch(/main composer/i);
    expect(slot.inspection.composer.text).toBe(
      "native draft that must survive",
    );
    expect(slot.inspection.composer.submits).toEqual([]);
    expect((editor as HTMLTextAreaElement).value).toBe("lazy reply");
    slot.lifecycle.unmount();
  });

  it("autosaves a new inline edit made while an empty round is loading", async () => {
    const pendingLoad = deferred<{
      status: "loaded";
      contributionBody: string;
      draftBody: string | null;
      draftSha256: string | null;
    }>();
    const saves: { turnId: string; body: string }[] = [];
    const slot = await renderReply({
      rpc: {
        ...eligible,
        lazy_reply_load: () => pendingLoad.promise,
        lazy_reply_save: async (input) => {
          saves.push(input);
          return { status: "saved" as const, sha256: "c".repeat(64) };
        },
      },
      context: { threadId: message.threadId },
      composer: {
        text: "",
        scope: { kind: "thread", threadId: message.threadId },
      },
    });
    const editor = await screen.findByRole("textbox", { name: "Reply draft" });
    fireEvent.change(editor, { target: { value: "new round inline edit" } });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(saves).toEqual([]);
    await act(async () => {
      pendingLoad.resolve({
        status: "loaded",
        contributionBody: "Agent contribution",
        draftBody: null,
        draftSha256: null,
      });
      await Promise.resolve();
    });
    await screen.findByText("Saved to thread storage.");
    expect(
      screen.queryByRole("button", {
        name: "Use current draft for this reply",
      }),
    ).toBeNull();
    expect(saves).toMatchObject([
      { turnId: message.turnId, body: "new round inline edit" },
    ]);
    slot.lifecycle.unmount();
  });

  it("waits for an unmount flush before reopening the same round", async () => {
    let savedBody: string | null = null;
    let savedSha256: string | null = null;
    let loadCalls = 0;
    let resolveSave!: (result: { status: "saved"; sha256: string }) => void;
    const rpc = {
      ...eligible,
      lazy_reply_load: async () => {
        loadCalls += 1;
        return {
          status: "loaded" as const,
          contributionBody: "Agent contribution",
          draftBody: savedBody,
          draftSha256: savedSha256,
        };
      },
      lazy_reply_save: (input: { body: string }) =>
        new Promise<{ status: "saved"; sha256: string }>((resolve) => {
          resolveSave = (result) => {
            savedBody = input.body;
            savedSha256 = result.sha256;
            resolve(result);
          };
        }),
    };
    const first = await renderReply({
      rpc,
      context: { threadId: message.threadId },
      composer: {
        text: "",
        scope: { kind: "thread", threadId: message.threadId },
      },
    });
    const editor = await screen.findByRole("textbox", { name: "Reply draft" });
    fireEvent.change(editor, { target: { value: "flush before reopen" } });
    await waitFor(() => expect(resolveSave).toBeTypeOf("function"));
    first.lifecycle.unmount();

    const reopened = await renderReply({
      rpc,
      context: { threadId: message.threadId },
      composer: {
        text: "",
        scope: { kind: "thread", threadId: message.threadId },
      },
    });
    expect(loadCalls).toBe(1);
    await act(async () => {
      resolveSave({ status: "saved", sha256: "a".repeat(64) });
      await Promise.resolve();
    });
    const reopenedEditor = await screen.findByRole("textbox", {
      name: "Reply draft",
    });
    await waitFor(() =>
      expect((reopenedEditor as HTMLTextAreaElement).value).toBe(
        "flush before reopen",
      ),
    );
    expect(loadCalls).toBe(2);
    reopened.lifecycle.unmount();
  });

  it("queues the newest edit while an earlier save is pending", async () => {
    const saves: {
      body: string;
      expectedSha256: string | null;
      resolve: (result: { status: "saved"; sha256: string }) => void;
    }[] = [];
    const rpc = {
      ...eligible,
      lazy_reply_save: (input: {
        body: string;
        expectedSha256: string | null;
      }) =>
        new Promise<{ status: "saved"; sha256: string }>((resolve) => {
          saves.push({ ...input, resolve });
        }),
    };
    const slot = await renderReply({
      rpc,
      context: { threadId: message.threadId },
      composer: {
        text: "",
        scope: { kind: "thread", threadId: message.threadId },
      },
    });
    const editor = await screen.findByRole("textbox", { name: "Reply draft" });
    fireEvent.change(editor, { target: { value: "first revision" } });
    await waitFor(() => expect(saves).toHaveLength(1));
    fireEvent.change(editor, { target: { value: "latest revision" } });
    await act(async () => {
      saves[0]!.resolve({ status: "saved", sha256: "a".repeat(64) });
      await Promise.resolve();
    });
    await waitFor(() => expect(saves).toHaveLength(2));
    expect(saves[1]).toMatchObject({
      body: "latest revision",
      expectedSha256: "a".repeat(64),
    });
    await act(async () => {
      saves[1]!.resolve({ status: "saved", sha256: "b".repeat(64) });
      await Promise.resolve();
    });
    await screen.findByText("Saved to thread storage.");
    expect((editor as HTMLTextAreaElement).value).toBe("latest revision");
    slot.lifecycle.unmount();
  });

  it("keeps text after a failed save and offers an explicit retry", async () => {
    let attempts = 0;
    const slot = await renderReply({
      rpc: {
        ...eligible,
        lazy_reply_save: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("temporary host failure");
          return { status: "saved", sha256: "c".repeat(64) };
        },
      },
      context: { threadId: message.threadId },
      composer: {
        text: "",
        scope: { kind: "thread", threadId: message.threadId },
      },
    });
    const editor = await screen.findByRole("textbox", { name: "Reply draft" });
    fireEvent.change(editor, { target: { value: "keep this text" } });
    await screen.findByText("Reply save failed. Your text is preserved here.");
    expect((editor as HTMLTextAreaElement).value).toBe("keep this text");
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
    await screen.findByText("Saved to thread storage.");
    expect(attempts).toBe(2);
    slot.lifecycle.unmount();
  });

  it("preserves local and disk versions after a CAS conflict", async () => {
    let attempts = 0;
    const slot = await renderReply({
      rpc: {
        ...eligible,
        lazy_reply_save: async (input) => {
          attempts += 1;
          if (attempts === 1)
            return {
              status: "conflict" as const,
              diskBody: "disk version",
              diskSha256: "d".repeat(64),
            };
          expect(input).toMatchObject({
            body: "local version",
            expectedSha256: "d".repeat(64),
          });
          return { status: "saved" as const, sha256: "e".repeat(64) };
        },
      },
      context: { threadId: message.threadId },
      composer: {
        text: "",
        scope: { kind: "thread", threadId: message.threadId },
      },
    });
    const editor = await screen.findByRole("textbox", { name: "Reply draft" });
    fireEvent.change(editor, { target: { value: "local version" } });
    await screen.findByText(
      "A different saved reply exists. Choose which version to keep.",
    );
    expect((editor as HTMLTextAreaElement).value).toBe("local version");
    expect(screen.getByRole("alert").textContent).toContain("disk version");
    fireEvent.click(screen.getByRole("button", { name: "Keep local reply" }));
    await screen.findByText("Saved to thread storage.");
    expect((editor as HTMLTextAreaElement).value).toBe("local version");
    slot.lifecycle.unmount();
  });

  it("restores a saved local reply without changing newer native typing", async () => {
    const pending = deferred<{
      status: "loaded";
      contributionBody: string;
      draftBody: string | null;
      draftSha256: string | null;
    }>();
    const slot = await renderReply({
      rpc: {
        ...eligible,
        lazy_reply_load: () => pending.promise,
      },
      context: { threadId: message.threadId },
      composer: {
        text: "",
        scope: { kind: "thread", threadId: message.threadId },
      },
    });
    const editor = await screen.findByRole("textbox", { name: "Reply draft" });
    await slot.behavior.setComposerText("newer native typing");
    await act(async () => {
      pending.resolve({
        status: "loaded",
        contributionBody: "Agent contribution",
        draftBody: "older saved reply",
        draftSha256: "f".repeat(64),
      });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect((editor as HTMLTextAreaElement).value).toBe("older saved reply"),
    );
    expect(slot.inspection.composer.text).toBe("newer native typing");
    slot.lifecycle.unmount();
  });

  it("ignores a delayed load after the composer changes to another scope", async () => {
    const pending = deferred<{
      status: "loaded";
      contributionBody: string;
      draftBody: string | null;
      draftSha256: string | null;
    }>();
    const slot = await renderReply({
      rpc: {
        ...eligible,
        lazy_reply_load: () => pending.promise,
      },
      context: { threadId: message.threadId },
      composer: {
        text: "old scope text",
        scope: { kind: "thread", threadId: message.threadId },
      },
    });
    await slot.behavior.setComposerScope({
      kind: "thread",
      threadId: "thr_otherthread",
    });
    await slot.behavior.setComposerText("new scope text");
    await act(async () => {
      pending.resolve({
        status: "loaded",
        contributionBody: "Agent contribution",
        draftBody: "old saved reply",
        draftSha256: "1".repeat(64),
      });
      await Promise.resolve();
    });
    expect((await screen.findByRole("status")).textContent).toMatch(
      /unavailable/i,
    );
    expect(slot.inspection.composer.text).toBe("new scope text");
    expect(
      screen.queryByRole("textbox", { name: "Saved reply (read only)" }),
    ).toBeNull();
    slot.lifecycle.unmount();
  });

  it("sends the reply with Ctrl+Enter through the native submit pipeline", async () => {
    let saveCount = 0;
    const slot = await renderReply({
      rpc: {
        ...eligible,
        lazy_reply_load: async () => ({
          status: "loaded" as const,
          contributionBody: "Agent contribution",
          draftBody: "reply before send",
          draftSha256: "2".repeat(64),
        }),
        lazy_reply_save: async () => {
          saveCount += 1;
          return { status: "saved" as const, sha256: "3".repeat(64) };
        },
      },
      context: { threadId: message.threadId },
      composer: {
        text: "",
        scope: { kind: "thread", threadId: message.threadId },
      },
    });
    const editor = await screen.findByRole("textbox", { name: "Reply draft" });
    await screen.findByText("Saved to thread storage.");
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
    await screen.findByText(/autosave paused after local submission/i);
    expect(slot.inspection.composer.text).toBe("");
    expect((editor as HTMLTextAreaElement).value).toBe("reply before send");
    expect(saveCount).toBe(0);
    slot.lifecycle.unmount();
  });

  it("persists an intentional manual clear as an empty draft", async () => {
    let savedBody: string | null = null;
    const slot = await renderReply({
      rpc: {
        ...eligible,
        lazy_reply_save: async (input) => {
          savedBody = input.body;
          return { status: "saved" as const, sha256: "4".repeat(64) };
        },
      },
      context: { threadId: message.threadId },
      composer: {
        text: "",
        scope: { kind: "thread", threadId: message.threadId },
      },
    });
    const editor = await screen.findByRole("textbox", { name: "Reply draft" });
    fireEvent.change(editor, { target: { value: "draft to clear" } });
    await waitFor(() => expect(savedBody).toBe("draft to clear"));
    fireEvent.change(editor, { target: { value: "" } });
    await waitFor(() => expect(savedBody).toBe(""));
    await screen.findByText("Saved to thread storage.");
    slot.lifecycle.unmount();
  });

  it("flushes the captured old-round text without changing a new composer scope", async () => {
    const savedInputs: {
      threadId: string;
      turnId: string;
      messageId: string;
      body: string;
    }[] = [];
    const slot = await renderReply({
      rpc: {
        ...eligible,
        lazy_reply_save: async (input) => {
          savedInputs.push(input);
          return { status: "saved" as const, sha256: "5".repeat(64) };
        },
      },
      context: { threadId: message.threadId },
      composer: {
        text: "",
        scope: { kind: "thread", threadId: message.threadId },
      },
    });
    const editor = await screen.findByRole("textbox", { name: "Reply draft" });
    fireEvent.change(editor, { target: { value: "old round edit" } });
    await waitFor(() => expect(savedInputs).toHaveLength(1));
    expect(slot.inspection.composer.text).toBe("");
    await slot.behavior.setComposerScope({
      kind: "thread",
      threadId: "thr_otherthread",
    });
    await slot.behavior.setComposerText("new scope text");
    await waitFor(() => expect(savedInputs).toHaveLength(1));
    expect(savedInputs[0]).toMatchObject({
      threadId: message.threadId,
      turnId: message.turnId,
      messageId: message.id,
      body: "old round edit",
    });
    expect(slot.inspection.composer.text).toBe("new scope text");
    slot.lifecycle.unmount();
  });

  it("leaves native mentions and attachments unchanged while editing", async () => {
    const attachment = {
      name: "notes.txt",
      type: "localFile" as const,
      mimeType: "text/plain",
      sizeBytes: 12,
      path: "/thread-storage/notes.txt",
    };
    const slot = await renderReply({
      rpc: eligible,
      context: { threadId: message.threadId },
      composer: {
        text: "@before old @after",
        mentions: [
          {
            kind: "thread",
            from: 0,
            to: 7,
            label: "@before",
            threadId: "before",
          },
          {
            kind: "thread",
            from: 12,
            to: 18,
            label: "@after",
            threadId: "after",
          },
        ],
        attachments: [attachment],
        scope: { kind: "thread", threadId: message.threadId },
      },
    });
    const editor = await screen.findByRole("textbox", { name: "Reply draft" });
    fireEvent.change(editor, {
      target: { value: "@before new longer @after" },
    });
    await waitFor(() =>
      expect(slot.inspection.composer.text).toBe("@before old @after"),
    );
    expect(slot.inspection.composer.draft.mentions).toEqual([
      {
        kind: "thread",
        from: 0,
        to: 7,
        label: "@before",
        threadId: "before",
      },
      {
        kind: "thread",
        from: 12,
        to: 18,
        label: "@after",
        threadId: "after",
      },
    ]);
    expect(slot.inspection.composer.draft.attachments).toEqual([attachment]);
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    expect(screen.getByRole("alert").textContent).toMatch(
      /clear the main composer/i,
    );
    expect(slot.inspection.composer.submits).toHaveLength(0);
    expect(slot.inspection.composer.draft.attachments).toEqual([attachment]);
    slot.lifecycle.unmount();
  });

  it("keeps the inline reply separate from native composer text", async () => {
    const slot = await renderReply({
      rpc: eligible,
      context: { threadId: message.threadId },
      composer: {
        text: "native draft",
        scope: { kind: "thread", threadId: message.threadId },
      },
    });
    const editor = await screen.findByRole("textbox", { name: "Reply draft" });
    expect((editor as HTMLTextAreaElement).value).toBe("");
    fireEvent.change(editor, { target: { value: "inline edit" } });
    await screen.findByText("Saved to thread storage.");
    expect(slot.inspection.composer.text).toBe("native draft");
    await slot.behavior.setComposerScope({
      kind: "queued-message",
      threadId: message.threadId,
      queuedMessageId: "queued-1",
    });
    expect((await screen.findByRole("status")).textContent).toMatch(
      /unavailable/i,
    );
    expect(slot.inspection.composer.text).toBe("native draft");
    slot.lifecycle.unmount();
  });

  it("submits the private reply through the native composer", async () => {
    const slot = await renderReply({
      rpc: eligible,
      context: { threadId: message.threadId },
      composer: {
        text: "",
        scope: { kind: "thread", threadId: message.threadId },
      },
    });
    const editor = await screen.findByRole("textbox", { name: "Reply draft" });
    fireEvent.change(editor, { target: { value: "draft" } });
    await screen.findByText("Saved to thread storage.");
    expect(slot.inspection.composer.text).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    await waitFor(() =>
      expect(slot.inspection.composer.submits).toEqual([
        { experimental_data: null },
      ]),
    );
    slot.lifecycle.unmount();
  });

  it("cancels a pending submit when newer thread activity arrives", async (action) => {
    let activityOccurred = false;
    let initialCheck = true;
    const pending: ReturnType<typeof deferred<{ eligible: boolean }>>[] = [];
    const slot = await renderReply({
      rpc: {
        lazy_reply_eligible: () => {
          if (initialCheck) {
            initialCheck = false;
            return Promise.resolve({ eligible: true });
          }
          if (activityOccurred) return Promise.resolve({ eligible: false });
          const check = deferred<{ eligible: boolean }>();
          pending.push(check);
          return check.promise;
        },
      },
      context: { threadId: message.threadId },
      composer: {
        text: "",
        scope: { kind: "thread", threadId: message.threadId },
      },
    });
    const editor = await screen.findByRole("textbox", {
      name: "Reply draft",
    });
    fireEvent.change(editor, { target: { value: "reply for submit" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    await waitFor(() => expect(pending).toHaveLength(1));

    activityOccurred = true;
    await slot.behavior.emitRealtime("thread-activity", {
      threadId: message.threadId,
      sequence: 2,
    });
    expect(screen.queryByRole("textbox", { name: "Reply draft" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send reply" })).toBeNull();
    await act(async () => {
      pending[0]!.resolve({ eligible: true });
      await Promise.resolve();
    });
    await screen.findByRole("status");

    expect(slot.inspection.composer.text).toBe("");
    expect(slot.inspection.composer.submits).toHaveLength(0);
    slot.lifecycle.unmount();
  });

  it("refuses submission if eligibility expires after rendering", async () => {
    let checks = 0;
    const slot = await renderReply({
      rpc: {
        lazy_reply_eligible: async () => ({ eligible: ++checks === 1 }),
      },
      context: { threadId: message.threadId },
      composer: {
        text: "",
        scope: { kind: "thread", threadId: message.threadId },
      },
    });
    const editor = await screen.findByRole("textbox", { name: "Reply draft" });
    fireEvent.change(editor, { target: { value: "draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    await screen.findByRole("status");
    expect(slot.inspection.composer.submits).toHaveLength(0);
    slot.lifecycle.unmount();
  });

  it("does not submit a Lazy Chat reply after the composer switches threads", async () => {
    const pendingSendCheck = deferred<{ eligible: boolean }>();
    let checks = 0;
    const slot = await renderReply({
      rpc: {
        ...eligible,
        lazy_reply_eligible: () =>
          ++checks === 1
            ? Promise.resolve({ eligible: true })
            : pendingSendCheck.promise,
      },
      context: { threadId: message.threadId },
      composer: {
        text: "",
        scope: { kind: "thread", threadId: message.threadId },
      },
    });
    const editor = await screen.findByRole("textbox", { name: "Reply draft" });
    fireEvent.change(editor, { target: { value: "reply for old thread" } });
    await screen.findByText("Saved to thread storage.");
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    await waitFor(() => expect(checks).toBe(2));

    await slot.behavior.setComposerScope({
      kind: "thread",
      threadId: "thread-2",
    });
    await slot.behavior.setComposerText("new thread draft");
    await act(async () => {
      pendingSendCheck.resolve({ eligible: true });
      await Promise.resolve();
    });
    expect(screen.getByRole("status").textContent).toMatch(/unavailable/i);
    expect(slot.inspection.composer.text).toBe("new thread draft");
    expect(slot.inspection.composer.submits).toHaveLength(0);
    slot.lifecycle.unmount();
  });

  it("keeps native composer changes separate from the Lazy Chat reply", async () => {
    const slot = await renderReply({
      rpc: eligible,
      context: { threadId: message.threadId },
      composer: {
        text: "original native draft",
        scope: { kind: "thread", threadId: message.threadId },
      },
    });
    const editor = await screen.findByRole("textbox", { name: "Reply draft" });
    fireEvent.change(editor, { target: { value: "private lazy reply" } });
    await screen.findByText("Saved to thread storage.");

    await slot.behavior.setComposerText("newer native text");
    expect((editor as HTMLTextAreaElement).value).toBe("private lazy reply");
    expect(slot.inspection.composer.text).toBe("newer native text");
    slot.lifecycle.unmount();
  });

  it("flushes the private reply on unmount without changing native text", async () => {
    let savedBody: string | null = null;
    const slot = await renderReply({
      rpc: {
        ...eligible,
        lazy_reply_save: async (input) => {
          savedBody = input.body;
          return { status: "saved" as const, sha256: "c".repeat(64) };
        },
      },
      context: { threadId: message.threadId },
      composer: {
        text: "original native draft",
        scope: { kind: "thread", threadId: message.threadId },
      },
    });
    const editor = await screen.findByRole("textbox", { name: "Reply draft" });
    fireEvent.change(editor, { target: { value: "private reply on unmount" } });

    slot.lifecycle.unmount();
    await waitFor(() => expect(savedBody).toBe("private reply on unmount"));
    expect(slot.inspection.composer.text).toBe("original native draft");
  });

  it("does not mirror a newer native reply into an inactive older round", async () => {
    const saves: unknown[] = [];
    const slot = await renderReply({
      rpc: {
        lazy_reply_eligible: async () => ({ eligible: false }),
        lazy_reply_load: async () => ({
          status: "loaded" as const,
          contributionBody: "Earlier contribution",
          draftBody: "earlier round reply",
          draftSha256: "7".repeat(64),
        }),
        lazy_reply_save: async (input) => {
          saves.push(input);
          return { status: "saved" as const, sha256: "8".repeat(64) };
        },
      },
      context: { threadId: message.threadId },
      composer: {
        text: "active reply before update",
        scope: { kind: "thread", threadId: message.threadId },
      },
    });
    const oldDraft = await screen.findByRole("textbox", {
      name: "Saved reply (read only)",
    });
    await slot.behavior.setComposerText("newer active reply");
    expect((oldDraft as HTMLTextAreaElement).value).toBe("earlier round reply");
    slot.lifecycle.unmount();
    await act(async () => Promise.resolve());
    expect(saves).toEqual([]);
  });

  it("does not adopt a pre-existing native draft into Lazy Chat", async () => {
    const saves: unknown[] = [];
    const slot = await renderReply({
      rpc: {
        ...eligible,
        lazy_reply_save: async (input) => {
          saves.push(input);
          return { status: "saved" as const, sha256: "b".repeat(64) };
        },
      },
      context: { threadId: message.threadId },
      composer: {
        text: "pre-existing native text",
        scope: { kind: "thread", threadId: message.threadId },
      },
    });
    const editor = await screen.findByRole("textbox", { name: "Reply draft" });
    expect((editor as HTMLTextAreaElement).value).toBe("");
    expect(saves).toEqual([]);
    fireEvent.change(editor, { target: { value: "private reply" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    expect(screen.getByRole("alert").textContent).toMatch(/main composer/i);
    expect(slot.inspection.composer.text).toBe("pre-existing native text");
    expect(slot.inspection.composer.submits).toHaveLength(0);
    slot.lifecycle.unmount();
  });

  it("keeps a pending save isolated when the slot changes reply ownership", async () => {
    const pendingSave = deferred<{ status: "saved"; sha256: string }>();
    const pendingNewLoad = deferred<{
      status: "loaded";
      contributionBody: string;
      draftBody: string | null;
      draftSha256: string | null;
    }>();
    const saves: { turnId: string; body: string }[] = [];
    const rpc = {
      ...eligible,
      lazy_reply_load: (input: { turnId: string }) =>
        input.turnId === "turn-2"
          ? pendingNewLoad.promise
          : Promise.resolve({
              status: "loaded" as const,
              contributionBody: "Original contribution",
              draftBody: null,
              draftSha256: null,
            }),
      lazy_reply_save: (input: { turnId: string; body: string }) => {
        saves.push(input);
        return pendingSave.promise;
      },
    };
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot<PluginMessageDirectiveProps, typeof rpcContract>(
      app.messageDirectives[0]!,
      props,
      {
        rpc: { ...eligible, ...rpc },
        context: { threadId: message.threadId },
        composer: {
          text: "",
          scope: { kind: "thread", threadId: message.threadId },
        },
      },
    );
    const editor = await screen.findByRole("textbox", { name: "Reply draft" });
    fireEvent.change(editor, { target: { value: "old round pending reply" } });
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0]).toMatchObject({
      turnId: message.turnId,
      body: "old round pending reply",
    });

    const nextMessage = { ...message, id: "msg-next", turnId: "turn-2" };
    slot.lifecycle.rerender(
      createElement(app.messageDirectives[0]!.component, {
        ...props,
        message: nextMessage,
      }),
    );
    const newEditor = await screen.findByRole("textbox", {
      name: "Reply draft",
    });
    expect((newEditor as HTMLTextAreaElement).value).toBe("");
    await act(async () => {
      pendingSave.resolve({ status: "saved", sha256: "9".repeat(64) });
      await Promise.resolve();
    });
    expect(screen.getByRole("status").textContent).toMatch(
      /loading saved reply/i,
    );
    expect(slot.inspection.composer.text).toBe("");
    expect(saves).toHaveLength(1);
    slot.lifecycle.unmount();
  });

  it("shows a displaced round's own saved reply read-only", async () => {
    const slot = await renderReply({
      rpc: {
        lazy_reply_eligible: async () => ({ eligible: false }),
        lazy_reply_load: async () => ({
          status: "loaded",
          contributionBody: "Earlier contribution",
          draftBody: "earlier round reply",
          draftSha256: "6".repeat(64),
        }),
      },
      context: { threadId: message.threadId },
      composer: {
        text: "new active reply",
        scope: { kind: "thread", threadId: message.threadId },
      },
    });
    const historical = await screen.findByRole("textbox", {
      name: "Saved reply (read only)",
    });
    expect((historical as HTMLTextAreaElement).value).toBe(
      "earlier round reply",
    );
    expect((historical as HTMLTextAreaElement).readOnly).toBe(true);
    expect(slot.inspection.composer.text).toBe("new active reply");
    slot.lifecycle.unmount();
  });

  it("does not render an editor in a mismatched thread scope", async () => {
    await renderReply({
      rpc: eligible,
      context: { threadId: message.threadId },
      composer: {
        text: "other thread draft",
        scope: { kind: "thread", threadId: "thread-2" },
      },
    });
    expect((await screen.findByRole("status")).textContent).toMatch(
      /unavailable/i,
    );
    expect(screen.queryByRole("textbox", { name: "Reply draft" })).toBeNull();
  });
});
