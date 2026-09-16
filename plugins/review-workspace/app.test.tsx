// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

vi.mock("@/components/ui/icon", () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
}));

vi.mock("@pierre/diffs/react", () => ({
  FileDiff: (props: any) => (
    <>
      <div
        data-testid="pierre-diff"
        data-expand-unchanged={String(props.options.expandUnchanged)}
        data-hunk-separators={props.options.hunkSeparators}
      />
      <div>
        {(props.lineAnnotations ?? []).map((la: any) => (
          <div key={String(la.lineNumber)} data-line={la.lineNumber}>
            {la.metadata && "id" in la.metadata ? (
              <div data-annotation-id={la.metadata.id} />
            ) : null}
            {la.metadata && "entityMarker" in la.metadata ? (
              <div data-entity-anchor={la.metadata.entityId} />
            ) : null}
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => void props.options.loadDiffFiles?.({})}
      >
        Load context
      </button>
    </>
  ),
}));

const patch = `diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,3 +1,3 @@
 context
-old
+new
 context
`;

function reviewFixture() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    threadId: "thread-ui",
    snapshot: "snapshot-ui",
    createdAt: 1,
    target: { type: "uncommitted" },
    files: [
      {
        path: "src/example.ts",
        previousPath: null,
        status: "modified",
        additions: 1,
        deletions: 1,
        binary: false,
        patch,
        truncated: false,
      },
    ],
    annotations: [],
    viewedPaths: [],
    summary: null,
  };
}

describe("Review Workspace app", () => {
  it("registers the header control and navigates to the review panel", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.threadHeaderActions[0]!, {
      threadId: "thread-ui",
      projectId: "project-ui",
      isCompactViewport: false,
    });

    slot.getByRole("button", { name: "Review" }).click();
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "review",
      options: { subPath: "review/thread-ui" },
    });

    const Header = app.threadHeaderActions[0]!.component;
    slot.rerender(
      <Header threadId="thread-ui" projectId="project-ui" isCompactViewport />,
    );
    expect(slot.queryByRole("button", { name: "Review" })).toBeNull();
    slot.lifecycle.unmount();
  });

  it("keeps collapsed context expandable through Pierre's supported loader", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const review = reviewFixture();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "review/thread-ui" },
      {
        context: { projectId: "project-ui", threadId: "thread-ui" },
        rpc: {
          review: async () => ({ review }),
          revisions: async () => ({
            revisions: [
              {
                id: review.id,
                threadId: review.threadId,
                snapshot: review.snapshot,
                createdAt: review.createdAt,
                target: { type: "uncommitted" },
                fileCount: 1,
                annotationCount: 0,
                unresolvedCount: 0,
                viewedCount: 0,
              },
            ],
          }),
          reviewFileContents: async () => ({
            old: { path: "src/example.ts", content: "context\nold\ncontext\n" },
            new: { path: "src/example.ts", content: "context\nnew\ncontext\n" },
          }),
        } as any,
      },
    );

    const diff = await slot.findByTestId("pierre-diff");
    expect(diff.getAttribute("data-expand-unchanged")).toBe("false");
    expect(diff.getAttribute("data-hunk-separators")).toBe("line-info");
    slot.getByRole("button", { name: "Load context" }).click();
    await vi.waitFor(() => {
      expect(slot.inspection.rpcCalls).toContainEqual({
        method: "reviewFileContents",
        input: { reviewId: review.id, filePath: "src/example.ts" },
      });
    });
    slot.lifecycle.unmount();
  });

  it("adds and shows a file-level comment", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const review = reviewFixture();
    const added = {
      id: "33333333-3333-4333-8333-333333333331",
      filePath: "src/example.ts",
      side: "new",
      startLine: 0,
      endLine: 0,
      body: "file note text",
      createdAt: 1,
      sentAt: null,
      resolvedAt: null,
      author: "human",
      parentId: null,
      fileLevel: true,
      carriedFromAnnotationId: null,
      resolutionSuggestion: null,
    };
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "review/thread-ui" },
      {
        context: { projectId: "project-ui", threadId: "thread-ui" },
        rpc: {
          review: async () => ({ review }),
          revisions: async () => ({ revisions: [] }),
          addAnnotation: async () => ({ annotation: added }),
        } as any,
      },
    );

    const open = await slot.findByRole("button", { name: "Comment on file" });
    open.click();
    const textarea = await slot.findByLabelText("File comment");
    textarea.focus();
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    setter.call(textarea, "file note text");
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
    slot.getByRole("button", { name: "Add comment" }).click();
    await vi.waitFor(() => {
      expect(slot.inspection.rpcCalls).toContainEqual({
        method: "addAnnotation",
        input: {
          reviewId: review.id,
          filePath: "src/example.ts",
          body: "file note text",
          fileLevel: true,
        },
      });
    });
    slot.lifecycle.unmount();
  });
});
describe("comment list behavior", () => {
  it("collapses resolved comments and marks agent comments unsendable", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const review = {
      ...reviewFixture(),
      annotations: [
        {
          id: "22222222-2222-4222-8222-222222222221",
          filePath: "src/example.ts",
          side: "new",
          startLine: 1,
          endLine: 1,
          body: "resolved human comment",
          createdAt: 1,
          sentAt: null,
          resolvedAt: 2,
          author: "human",
          carriedFromAnnotationId: null,
          resolutionSuggestion: null,
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          filePath: "src/example.ts",
          side: "new",
          startLine: 2,
          endLine: 2,
          body: "agent observation",
          createdAt: 3,
          sentAt: null,
          resolvedAt: null,
          author: "agent",
          carriedFromAnnotationId: null,
          resolutionSuggestion: null,
        },
      ],
    } as any;
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "review/thread-ui" },
      {
        context: { projectId: "project-ui", threadId: "thread-ui" },
        rpc: {
          review: async () => ({ review }),
          revisions: async () => ({
            revisions: [
              {
                id: review.id,
                threadId: review.threadId,
                snapshot: review.snapshot,
                createdAt: review.createdAt,
                target: { type: "uncommitted" },
                fileCount: 1,
                annotationCount: 2,
                unresolvedCount: 1,
                viewedCount: 0,
              },
            ],
          }),
        } as any,
      },
    );

    // Resolved comment renders collapsed: no checkbox until expanded.
    await slot.findByRole("button", { name: "Show src/example.ts:1 (new)" });
    expect(
      slot.queryByRole("checkbox", {
        name: "Select src/example.ts:1 (new)",
      }),
    ).toBeNull();
    slot.getByRole("button", { name: "Show src/example.ts:1 (new)" }).click();
    const resolvedBox = (await vi.waitFor(() => {
      const box = slot.container.querySelector(
        'input[aria-label="Select src/example.ts:1 (new)"]',
      ) as HTMLInputElement | null;
      expect(box).not.toBeNull();
      return box;
    })) as HTMLInputElement;
    expect(resolvedBox.disabled).toBe(true);

    // Agent comment shows the agent chip and cannot be selected for a batch.
    expect(slot.getByText("AI comment")).toBeTruthy();
    const agentBox = slot.container.querySelector(
      'input[aria-label="Select src/example.ts:2 (new)"]',
    ) as HTMLInputElement;
    expect(agentBox.disabled).toBe(true);

    // Only the agent comment is unresolved, but agent comments are never
    // pending, so nothing is counted or selectable to send.
    expect(slot.queryByText(/1 pending comment/)).toBeNull();
    slot.lifecycle.unmount();
  });
});

let app0: any = null;

const entityChange = {
  entityId: "src/example.ts::function::alpha",
  changeType: "modified",
  entityType: "function",
  entityName: "alpha",
  startLine: 5,
  endLine: 6,
  oldStartLine: 5,
  oldEndLine: 6,
  filePath: "src/example.ts",
  structuralChange: false,
} as any;

describe("comment locate flow", () => {
  function locateFixture() {
    return {
      ...reviewFixture(),
      annotations: [
        {
          id: "55555555-5555-4555-8555-555555555551",
          filePath: "src/example.ts",
          side: "new",
          startLine: 1,
          endLine: 1,
          body: "locate me",
          createdAt: 1,
          sentAt: null,
          resolvedAt: null,
          author: "human",
          parentId: null,
          fileLevel: false,
          carriedFromAnnotationId: null,
          resolutionSuggestion: null,
        },
      ],
    } as any;
  }

  it("renders a Show in diff button on sidebar comments that scrolls to the card", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "review/thread-ui" },
      {
        context: { projectId: "project-ui", threadId: "thread-ui" },
        rpc: {
          review: async () => ({ review: locateFixture() }),
          revisions: async () => ({ revisions: [] }),
        } as any,
      },
    );
    Element.prototype.scrollIntoView = vi.fn();
    const locateButton = await slot.findByRole("button", {
      name: "Show src/example.ts:1 (new) in diff",
    });
    locateButton.click();
    await vi.waitFor(() => {
      expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    });
    slot.lifecycle.unmount();
  });

  it("keeps polling when the diff card renders late (file switch)", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "review/thread-ui" },
      {
        context: { projectId: "project-ui", threadId: "thread-ui" },
        rpc: {
          review: async () => ({ review: locateFixture() }),
          revisions: async () => ({ revisions: [] }),
        } as any,
      },
    );
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const locateButton = await slot.findByRole("button", {
      name: "Show src/example.ts:1 (new) in diff",
    });
    // Simulate Pierre's late render: the annotation card appears only after
    // the first poll intervals would have passed (the old 3-attempt fix
    // failed here because it stopped at 180ms).
    const marker = document.createElement("div");
    marker.setAttribute(
      "data-annotation-id",
      "55555555-5555-4555-8555-555555555551",
    );
    marker.scrollIntoView = scrollIntoView;
    setTimeout(() => {
      document.body.appendChild(marker);
    }, 400);
    locateButton.click();
    await vi.waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalled();
    });
    slot.lifecycle.unmount();
  });
});

describe("entity summary flow (semantic entry)", () => {
  it("renders the summary on toggle and hides cosmetics by default", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const review = reviewFixture();
    const summaryCalls: any[] = [];
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "review/thread-ui" },
      {
        context: { projectId: "project-ui", threadId: "thread-ui" },
        rpc: {
          review: async () => ({ review }),
          revisions: async () => ({ revisions: [] }),
          entitySummary: async (input: any) => {
            summaryCalls.push(input);
            return {
              status: "ok",
              reason: null,
              changes: [
                {
                  entityId: "a::function::mod",
                  changeType: "modified",
                  entityType: "function",
                  entityName: "mod",
                  filePath: "src/example.ts",
                  startLine: 5,
                  endLine: 6,
                  structuralChange: null,
                },
                {
                  entityId: "a::function::cosmetic",
                  changeType: "modified",
                  entityType: "function",
                  entityName: "cosmeticOnlyRefactor",
                  filePath: "src/example.ts",
                  startLine: 40,
                  endLine: 42,
                  structuralChange: false,
                },
                {
                  entityId: "a::function::gone",
                  changeType: "deleted",
                  entityType: "function",
                  entityName: "gone",
                  filePath: "src/example.ts",
                  startLine: null,
                  endLine: null,
                  structuralChange: null,
                },
              ],
            };
          },
        } as any,
      },
    );

    await vi.waitFor(() => {
      slot.getByRole("button", { name: "Entities view (experimental)" });
    });
    slot.getByRole("button", { name: "Entities view (experimental)" }).click();
    await vi.waitFor(() => {
      expect(summaryCalls).toContainEqual({ reviewId: review.id });
      // priority order: deleted first, then modified
      slot.getByText("deleted");
      slot.getByText(/gone/);
      slot.getByText("modified");
    });
    // cosmetics hidden by default
    expect(slot.queryByText(/cosmeticOnlyRefactor/)).toBeNull();
    slot.getByLabelText("Hide cosmetic-only changes").click();
    slot.getByText(/cosmeticOnlyRefactor/);
    slot.lifecycle.unmount();
  });

  it("jumps to the diff when a summary row is located", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const review = reviewFixture();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "review/thread-ui" },
      {
        context: { projectId: "project-ui", threadId: "thread-ui" },
        rpc: {
          review: async () => ({ review }),
          revisions: async () => ({ revisions: [] }),
          entitySummary: async () => ({
            status: "ok",
            reason: null,
            changes: [
              {
                entityId: "a::function::mod",
                changeType: "modified",
                entityType: "function",
                entityName: "mod",
                filePath: "src/example.ts",
                startLine: 5,
                endLine: 6,
                structuralChange: null,
              },
            ],
          }),
        } as any,
      },
    );

    await vi.waitFor(() => {
      slot.getByRole("button", { name: "Entities view (experimental)" });
    });
    slot.getByRole("button", { name: "Entities view (experimental)" }).click();
    await vi.waitFor(() => {
      slot.getByText("modified");
    });
    slot.getByRole("button", { name: "Go to mod" }).click();
    // jump only switches file/pends the anchor; no error surfaced
    expect(slot.queryByText(/sem is unavailable/)).toBeNull();
    slot.lifecycle.unmount();
  });

  it("groups entities by file and renders per-entity content diffs", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const review = {
      ...reviewFixture(),
      files: [
        reviewFixture().files[0],
        {
          path: "src/other.ts",
          previousPath: null,
          status: "modified",
          additions: 1,
          deletions: 0,
          binary: false,
          patch: `diff --git a/src/other.ts b/src/other.ts
--- a/src/other.ts
+++ b/src/other.ts
@@ -1,2 +1,3 @@
 first
+second
 third
`,
          truncated: false,
        },
      ],
    };
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "review/thread-ui" },
      {
        context: { projectId: "project-ui", threadId: "thread-ui" },
        rpc: {
          review: async () => ({ review }),
          revisions: async () => ({ revisions: [] }),
          entitySummary: async () => ({
            status: "ok",
            reason: null,
            changes: [
              {
                entityId: "src/example.ts::function::alpha",
                changeType: "modified",
                entityType: "function",
                entityName: "alpha",
                filePath: "src/example.ts",
                startLine: 5,
                endLine: 6,
                structuralChange: true,
                beforeContent: "function alpha() {\n  return 1;\n}",
                afterContent: "function alpha() {\n  return 42;\n}",
              },
              {
                entityId: "src/other.ts::function::beta",
                changeType: "added",
                entityType: "function",
                entityName: "beta",
                filePath: "src/other.ts",
                startLine: 2,
                endLine: 3,
                structuralChange: true,
                beforeContent: null,
                afterContent: "function beta() {\n  return 2;\n}",
              },
            ],
          }),
        } as any,
      },
    );

    await vi.waitFor(() => {
      slot.getByRole("button", { name: "Entities view (experimental)" });
    });
    slot.getByRole("button", { name: "Entities view (experimental)" }).click();
    // grouped by file, one count chip per file section
    await vi.waitFor(() => {
      expect(slot.getAllByText(/entit(y|ies)$/)).toHaveLength(2);
    });
    // alpha expands into a before/after content diff
    slot.getByRole("button", { name: /modified alpha/ }).click();
    await vi.waitFor(() => {
      expect(slot.getAllByText(/return (1|42);/).length).toBeGreaterThanOrEqual(
        2,
      );
    });
    await vi.waitFor(() => {
      expect(slot.getAllByText(/return (1|42);/).length).toBeGreaterThanOrEqual(
        2,
      );
    });
    // beta is one-sided (added): the after side renders as context
    slot.getByText(/beta/).click();
    await vi.waitFor(() => {
      slot.getByText(/function beta/);
    });
    slot.lifecycle.unmount();
  });

  it("expands a summary row and loads its transitive impact", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const review = reviewFixture();
    const impactCalls: any[] = [];
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "review/thread-ui" },
      {
        context: { projectId: "project-ui", threadId: "thread-ui" },
        rpc: {
          review: async () => ({ review }),
          revisions: async () => ({ revisions: [] }),
          entitySummary: async () => ({
            status: "ok",
            reason: null,
            changes: [{ ...entityChange, structuralChange: true }],
          }),
          entityImpact: async (input: any) => {
            impactCalls.push(input);
            return {
              status: "ok",
              reason: null,
              dependents: [
                {
                  entityId: "src/other.ts::function::caller",
                  file: "src/other.ts",
                  lines: [12, 20],
                  name: "caller",
                  type: "function",
                },
              ],
              tests: [],
              total: 1,
              depth: 1,
            };
          },
        } as any,
      },
    );

    await vi.waitFor(() => {
      slot.getByRole("button", { name: "Entities view (experimental)" });
    });
    slot.getByRole("button", { name: "Entities view (experimental)" }).click();
    await vi.waitFor(() => {
      slot.getByText("modified");
    });
    slot.getByText(/alpha/).click();
    await vi.waitFor(() => {
      expect(impactCalls).toHaveLength(1);
    });
    // impact detail lists dependents once the rpc resolves
    await slot.findByText(/caller/);
    slot.lifecycle.unmount();
  });

  it("reports when a summarized entity cannot be located in the diff", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const review = reviewFixture();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "review/thread-ui" },
      {
        context: { projectId: "project-ui", threadId: "thread-ui" },
        rpc: {
          review: async () => ({ review }),
          revisions: async () => ({ revisions: [] }),
          entitySummary: async () => ({
            status: "ok",
            reason: null,
            changes: [
              {
                ...entityChange,
                entityName: "faraway",
                startLine: 900,
                endLine: 910,
                structuralChange: true,
              },
            ],
          }),
        } as any,
      },
    );

    await vi.waitFor(() => {
      slot.getByRole("button", { name: "Entities view (experimental)" });
    });
    slot.getByRole("button", { name: "Entities view (experimental)" }).click();
    await vi.waitFor(() => {
      slot.getByText("modified");
    });
    slot.getByRole("button", { name: "Go to faraway" }).click();
    await slot.findByText(/faraway has no visible lines in the diff/);
    slot.lifecycle.unmount();
  });

  it("shows the reason when the revision summary is unavailable", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const review = reviewFixture();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "review/thread-ui" },
      {
        context: { projectId: "project-ui", threadId: "thread-ui" },
        rpc: {
          review: async () => ({ review }),
          revisions: async () => ({ revisions: [] }),
          entitySummary: async () => ({
            status: "unavailable",
            reason: "sem binary not found",
            changes: [],
          }),
        } as any,
      },
    );

    await vi.waitFor(() => {
      slot.getByRole("button", { name: "Entities view (experimental)" });
    });
    slot.getByRole("button", { name: "Entities view (experimental)" }).click();
    await slot.findByText(/sem is unavailable: sem binary not found/);
    slot.lifecycle.unmount();
  });
});
