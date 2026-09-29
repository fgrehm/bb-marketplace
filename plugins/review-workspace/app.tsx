import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { definePluginApp, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import * as Dialog from "@radix-ui/react-dialog";
import { FileDiff } from "@pierre/diffs/react";
import {
  getSingularPatch,
  type DiffLineAnnotation,
  type FileDiffContentsLoader,
  type FileDiffMetadata,
  type SelectedLineRange,
} from "@pierre/diffs";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import {
  COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS,
  COARSE_POINTER_TEXT_BASE_CLASS,
} from "@/components/ui/coarse-pointer-sizing";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import {
  adjacentFilePath,
  filterChangedFiles,
  nextUnviewedFilePath,
  unresolvedRootThreadCounts,
  type FileFilterMode,
} from "./lib/review-navigation";
import { compactPath, normalizeChangeKind } from "./lib/utils";

type File = {
  path: string;
  previousPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
  patch: string;
  truncated: boolean;
};
type Annotation = {
  id: string;
  filePath: string;
  side: "old" | "new";
  startLine: number;
  endLine: number;
  body: string;
  createdAt: number;
  sentAt: number | null;
  resolvedAt: number | null;
  author: "human" | "agent";
  parentId: string | null;
  fileLevel: boolean;
  carriedFromAnnotationId: string | null;
  resolutionSuggestion: {
    id: string;
    rationale: string;
    createdAt: number;
  } | null;
};
type ReviewTarget =
  | { type: "uncommitted" }
  | { type: "commit"; sha: string }
  | { type: "branch_committed"; mergeBaseBranch: string };

function describeTarget(target: ReviewTarget): string {
  if (target.type === "commit") return `commit ${target.sha.slice(0, 10)}`;
  if (target.type === "branch_committed")
    return `committed vs ${target.mergeBaseBranch}`;
  return "uncommitted";
}

type Review = {
  id: string;
  threadId: string;
  snapshot: string;
  createdAt: number;
  target: ReviewTarget;
  files: File[];
  annotations: Annotation[];
  viewedPaths: string[];
  summary: string | null;
};
type Revision = {
  id: string;
  threadId: string;
  snapshot: string;
  createdAt: number;
  target: ReviewTarget;
  fileCount: number;
  annotationCount: number;
  unresolvedCount: number;
  viewedCount: number;
};
type Selection = {
  side: "old" | "new";
  startLine: number;
  endLine: number;
};
type ComposerMarker = { composer: true; selection: Selection };
type DiffAnnotation = Annotation | ComposerMarker;

function rangeToAnchor(range: SelectedLineRange): Selection | null {
  const side =
    range.side === "deletions"
      ? "old"
      : range.side === "additions"
        ? "new"
        : null;
  if (!side || (range.endSide && range.endSide !== range.side)) return null;
  return {
    side,
    startLine: Math.min(range.start, range.end),
    endLine: Math.max(range.start, range.end),
  };
}

function annotationLabel(annotation: Annotation): string {
  if (annotation.fileLevel) return `${annotation.filePath} (whole file)`;
  return `${annotation.filePath}:${annotation.startLine}${annotation.endLine === annotation.startLine ? "" : `-${annotation.endLine}`} (${annotation.side})`;
}

function inlineReplyRoot(
  annotation: Annotation,
  annotations: Annotation[],
): Annotation | null {
  if (annotation.author !== "agent" || annotation.fileLevel) return null;
  const root = annotation.parentId
    ? annotations.find((candidate) => candidate.id === annotation.parentId)
    : annotation;
  if (
    !root ||
    root.parentId !== null ||
    root.fileLevel ||
    root.filePath !== annotation.filePath ||
    root.side !== annotation.side ||
    root.startLine !== annotation.startLine ||
    root.endLine !== annotation.endLine
  )
    return null;
  return root;
}

function StateChip({
  tone = "muted",
  children,
}: {
  tone?: "muted" | "primary" | "emerald" | "amber";
  children: React.ReactNode;
}) {
  const tones = {
    muted: "bg-muted text-muted-foreground",
    primary: "bg-primary text-primary-foreground",
    emerald: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    amber: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold leading-4 ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

function AnnotationMeta({
  annotation,
}: {
  annotation: Pick<
    Annotation,
    "author" | "carriedFromAnnotationId" | "resolvedAt" | "sentAt" | "parentId"
  >;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {annotation.author === "agent" ? (
        <StateChip tone="primary">
          <Icon name="AiContentGenerator01" className="size-3" />
          AI comment
        </StateChip>
      ) : (
        <StateChip tone="primary">
          {annotation.parentId ? "Your reply" : "Review comment"}
        </StateChip>
      )}
      {annotation.sentAt ? (
        <StateChip>sent</StateChip>
      ) : annotation.resolvedAt ? null : annotation.author === "human" ? (
        // A reply nests under an AI comment, so say plainly that this one is
        // still waiting to go to the agent.
        <StateChip tone="amber">unsent</StateChip>
      ) : null}
      {annotation.resolvedAt ? (
        <StateChip tone="emerald">✓ resolved</StateChip>
      ) : null}
    </div>
  );
}

const PierreReviewDiff = memo(function PierreReviewDiff({
  fileDiff,
  lineAnnotations,
  annotations,
  replyDrafts,
  onReply,
  onReplyDraft,
  editDrafts,
  onEdit,
  onEditDraft,
  onRemove,
  composer,
  wrapLines,
  loadDiffFiles,
  onSelect,
}: {
  fileDiff: FileDiffMetadata;
  lineAnnotations: DiffLineAnnotation<DiffAnnotation>[];
  annotations: Annotation[];
  replyDrafts: Map<string, string>;
  onReply: (parent: Annotation, body: string) => Promise<void>;
  onReplyDraft: (id: string, value: string | null) => void;
  editDrafts: Map<string, string>;
  onEdit: (annotation: Annotation, body: string) => Promise<void>;
  onEditDraft: (id: string, value: string | null) => void;
  onRemove: (id: string) => void;
  wrapLines: boolean;
  loadDiffFiles?: FileDiffContentsLoader;
  composer: {
    file: File | null;
    selection: Selection | null;
    body: string;
    busy: boolean;
    onBody: (value: string) => void;
    onAdd: () => void;
    onCancel: () => void;
  };
  onSelect: (range: SelectedLineRange | null) => void;
}) {
  const options = useMemo(
    () => ({
      diffStyle: "unified" as const,
      overflow: wrapLines ? ("wrap" as const) : ("scroll" as const),
      enableLineSelection: true,
      enableGutterUtility: true,
      lineHoverHighlight: "both" as const,
      hunkSeparators: "line-info" as const,
      expandUnchanged: false,
      expansionLineCount: 50,
      loadDiffFiles,
      onLineSelectionEnd: onSelect,
    }),
    [loadDiffFiles, onSelect, wrapLines],
  );
  return (
    <FileDiff<DiffAnnotation>
      fileDiff={fileDiff}
      lineAnnotations={lineAnnotations}
      disableWorkerPool
      options={options}
      renderAnnotation={(line) => {
        const annotation = line.metadata;
        if (!annotation) return null;
        if ("composer" in annotation) {
          return composer.selection ? (
            <div className="hidden lg:block">
              <Composer
                file={composer.file}
                selection={composer.selection}
                body={composer.body}
                busy={composer.busy}
                onBody={composer.onBody}
                onAdd={composer.onAdd}
                onCancel={composer.onCancel}
              />
            </div>
          ) : null;
        }
        const replyRoot = inlineReplyRoot(annotation, annotations);
        const editing = editDrafts.has(annotation.id);
        const hasReplies = annotations.some(
          (candidate) => candidate.parentId === annotation.id,
        );
        return (
          <div
            data-annotation-id={annotation.id}
            className={`border-l-2 px-3 py-2 text-xs ${
              annotation.resolvedAt
                ? "border-l-muted-foreground/30 bg-muted/30"
                : "border-l-primary bg-primary/5"
            }`}
          >
            <div className="mb-1.5">
              <AnnotationMeta annotation={annotation} />
            </div>
            <p
              className={`whitespace-pre-wrap ${
                annotation.resolvedAt ? "text-muted-foreground" : ""
              }`}
            >
              {annotation.body}
            </p>
            {replyRoot || editing || annotation.author === "human" ? (
              <div
                className="mt-2"
                onPointerDown={(event) => event.stopPropagation()}
                onPointerUp={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                onMouseUp={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
              >
                {editing ? (
                  <CommentEditor
                    fieldLabel={`Edit ${annotationLabel(annotation)}`}
                    placeholder="Update this comment..."
                    draft={editDrafts.get(annotation.id) ?? ""}
                    onDraft={(value) => onEditDraft(annotation.id, value)}
                    onSubmit={(body) => onEdit(annotation, body)}
                    onCancel={() => onEditDraft(annotation.id, null)}
                    submitLabel="Save"
                    busyLabel="Saving..."
                  />
                ) : null}
                {replyRoot && replyDrafts.has(annotation.id) ? (
                  <ReplyBox
                    parent={replyRoot ?? annotation}
                    onReply={onReply}
                    draft={replyDrafts.get(annotation.id) ?? ""}
                    onDraft={(value) => onReplyDraft(annotation.id, value)}
                    onCancel={() => onReplyDraft(annotation.id, null)}
                  />
                ) : null}
                {!editing && !replyDrafts.has(annotation.id) && replyRoot ? (
                  <button
                    type="button"
                    className="min-h-9 rounded px-2 py-1 text-primary hover:bg-muted"
                    aria-label={`Reply to AI comment at ${annotationLabel(annotation)}`}
                    onClick={() => onReplyDraft(annotation.id, "")}
                  >
                    Reply
                  </button>
                ) : null}
                {annotation.author === "human" ? (
                  <CommentActions
                    annotation={annotation}
                    hasReplies={hasReplies}
                    editing={editing}
                    onEdit={() => onEditDraft(annotation.id, annotation.body)}
                    onDelete={onRemove}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        );
      }}
      renderGutterUtility={(getHoveredLine) => (
        <button
          type="button"
          aria-label="Add comment on this line"
          title="Add comment"
          className="relative z-10 inline-flex size-7 translate-x-3 items-center justify-center rounded-md bg-primary text-lg leading-none text-primary-foreground shadow-md hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:hidden"
          onClick={() => {
            const hovered = getHoveredLine();
            if (hovered)
              onSelect({
                start: hovered.lineNumber,
                end: hovered.lineNumber,
                side: hovered.side,
              });
          }}
        >
          +
        </button>
      )}
    />
  );
});

function CommentCard({
  annotation,
  onRemove,
  onResolve,
  onSuggestion,
  onReply,
  onLocate,
  replyDrafts,
  onReplyDraft,
  hasReplies = false,
  onEdit,
  onEditDraft,
  editDrafts,
  hideReplyButton = false,
}: {
  annotation: Annotation;
  onRemove: (id: string) => void;
  onResolve: (annotation: Annotation) => void;
  onSuggestion: (annotation: Annotation, accept: boolean) => void;
  onReply: (parent: Annotation, body: string) => Promise<void>;
  onLocate?: (annotation: Annotation) => void;
  replyDrafts: Map<string, string>;
  onReplyDraft: (id: string, value: string | null) => void;
  hasReplies?: boolean;
  onEdit?: (annotation: Annotation, body: string) => Promise<void>;
  onEditDraft: (id: string, value: string | null) => void;
  editDrafts: Map<string, string>;
  hideReplyButton?: boolean;
}) {
  const locate = onLocate ? (
    <button
      type="button"
      className="text-muted-foreground hover:text-foreground"
      aria-label={`Show ${annotationLabel(annotation)} in diff`}
      title="Show in diff"
      onClick={() => onLocate(annotation)}
    >
      <Icon name="Target" className="size-3" />
    </button>
  ) : null;
  // Resolved comments start collapsed to keep the list scannable.
  const [collapsed, setCollapsed] = useState(annotation.resolvedAt !== null);
  const replying = replyDrafts.has(annotation.id);
  const editing = editDrafts.has(annotation.id);
  if (collapsed) {
    return (
      <article className="rounded-md border p-2 text-xs opacity-65">
        <div className="flex items-start gap-2">
          <button
            type="button"
            aria-label={`Show ${annotationLabel(annotation)}`}
            aria-expanded={false}
            className="min-w-0 flex-1 text-left"
            onClick={() => setCollapsed(false)}
          >
            <span className="font-mono text-[11px] text-muted-foreground">
              {annotationLabel(annotation)}
            </span>
            <span className="ml-2 inline-block align-middle">
              <AnnotationMeta annotation={annotation} />
            </span>
            <p className="mt-1 truncate text-muted-foreground">
              {annotation.body}
            </p>
          </button>
          {locate}
        </div>
      </article>
    );
  }
  return (
    <article
      className={`group rounded-md border p-2 text-xs ${annotation.sentAt || annotation.resolvedAt ? "opacity-65" : ""}`}
    >
      <div className="flex gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[11px] text-muted-foreground">
            {annotationLabel(annotation)}
          </p>
          <div className="mt-1 flex flex-wrap items-center justify-between gap-1">
            <AnnotationMeta annotation={annotation} />
            {locate}
          </div>
          <p className="mt-1.5 whitespace-pre-wrap">{annotation.body}</p>
          {annotation.resolutionSuggestion && !annotation.resolvedAt ? (
            <div className="mt-2 rounded bg-muted p-2">
              <p>
                Agent suggests resolving:{" "}
                {annotation.resolutionSuggestion.rationale}
              </p>
              <button
                className="mt-1 text-primary"
                onClick={() => onSuggestion(annotation, true)}
              >
                Accept
              </button>
              <button
                className="ml-2 text-muted-foreground"
                onClick={() => onSuggestion(annotation, false)}
              >
                Keep open
              </button>
            </div>
          ) : null}
          {annotation.resolvedAt ? null : (
            <button
              className="mt-1.5 text-muted-foreground hover:text-foreground"
              onClick={() => onResolve(annotation)}
            >
              Resolve
            </button>
          )}
          {hideReplyButton ? null : replying || editing ? null : (
            <button
              className="ml-3 mt-1.5 text-primary hover:opacity-80"
              onClick={() => onReplyDraft(annotation.id, "")}
            >
              Reply
            </button>
          )}
          {annotation.resolvedAt ? (
            <button
              className="ml-3 mt-1.5 text-muted-foreground hover:text-foreground"
              onClick={() => setCollapsed(true)}
            >
              Collapse
            </button>
          ) : null}
          {replying ? (
            <ReplyBox
              parent={annotation}
              onReply={onReply}
              draft={replyDrafts.get(annotation.id) ?? ""}
              onDraft={(value) => onReplyDraft(annotation.id, value)}
              onCancel={() => onReplyDraft(annotation.id, null)}
            />
          ) : null}
          {onEdit ? (
            <CommentActions
              annotation={annotation}
              hasReplies={hasReplies}
              editing={editing}
              onEdit={() => onEditDraft(annotation.id, annotation.body)}
              onDelete={onRemove}
            />
          ) : null}
          {editing ? (
            <CommentEditor
              fieldLabel={`Edit ${annotationLabel(annotation)}`}
              placeholder="Update this comment..."
              draft={editDrafts.get(annotation.id) ?? ""}
              onDraft={(value) => onEditDraft(annotation.id, value)}
              onSubmit={
                onEdit
                  ? (body) => onEdit(annotation, body)
                  : () => Promise.resolve()
              }
              onCancel={() => onEditDraft(annotation.id, null)}
              submitLabel="Save"
              busyLabel="Saving..."
            />
          ) : null}
        </div>
      </div>
    </article>
  );
}

// Submit shortcut label follows the platform so the hint matches the keys the
// reviewer will actually press.
// The key handler accepts metaKey OR ctrlKey, which is exactly what bb calls
// `mod` ("Command on macOS, Control elsewhere") on a PluginCommandShortcut.
// bb exposes that only for shortcuts the host matches itself, so there is no
// resolver to borrow here and the label is the only thing that must guess.
// navigator.platform is deprecated, so prefer userAgentData and fall back to
// the legacy pair.
function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const data = (
    navigator as Navigator & { userAgentData?: { platform?: string } }
  ).userAgentData;
  if (data?.platform) return /mac/i.test(data.platform);
  return /mac|iphone|ipad|ipod/i.test(
    `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`,
  );
}
function submitShortcutLabel(): string {
  return isApplePlatform() ? "Cmd+Enter" : "Ctrl+Enter";
}

// One editor for both replies and edits: it mounts only while its draft is
// open, so focusing on mount covers opening, cancelling, and reopening. The
// submit path is guarded so a second click or keypress cannot fire the RPC
// twice while the first is still in flight.
function CommentEditor({
  fieldLabel,
  placeholder,
  draft,
  onDraft,
  onSubmit,
  onCancel,
  submitLabel,
  busyLabel,
}: {
  fieldLabel: string;
  placeholder: string;
  draft: string;
  onDraft: (value: string) => void;
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
  submitLabel: string;
  busyLabel: string;
}) {
  const [busy, setBusy] = useState(false);
  const submittingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);
  function submit() {
    if (submittingRef.current || busy || !draft.trim()) return;
    submittingRef.current = true;
    setBusy(true);
    void onSubmit(draft)
      .then(onCancel)
      .catch(() => undefined)
      .finally(() => {
        submittingRef.current = false;
        setBusy(false);
      });
  }
  return (
    <div className="mt-2 rounded bg-muted p-2">
      <textarea
        ref={textareaRef}
        aria-label={fieldLabel}
        maxLength={1000}
        value={draft}
        onChange={(event) => onDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey))
            return;
          event.preventDefault();
          submit();
        }}
        placeholder={placeholder}
        className="min-h-14 w-full rounded border bg-background p-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">
          {submitShortcutLabel()} to submit
        </span>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" disabled={busy || !draft.trim()} onClick={submit}>
            {busy ? busyLabel : submitLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ReplyBox({
  parent,
  onReply,
  onCancel,
  draft,
  onDraft,
}: {
  parent: Annotation;
  onReply: (parent: Annotation, body: string) => Promise<void>;
  onCancel: () => void;
  draft: string;
  onDraft: (value: string) => void;
}) {
  return (
    <CommentEditor
      fieldLabel={`Reply to ${annotationLabel(parent)}`}
      placeholder="Reply in this thread..."
      draft={draft}
      onDraft={onDraft}
      onSubmit={(body) => onReply(parent, body)}
      onCancel={onCancel}
      submitLabel="Reply"
      busyLabel="Replying..."
    />
  );
}

// Edit and delete are human-only: the agent's own comments and anything
// already sent are immutable, so the affordances are hidden rather than
// offered and then refused. Delete on a comment that has replies is shown
// disabled with the server's reason, because the user needs to see why.
function CommentActions({
  annotation,
  hasReplies,
  editing,
  onEdit,
  onDelete,
}: {
  annotation: Annotation;
  hasReplies: boolean;
  editing: boolean;
  onEdit: (annotation: Annotation) => void;
  onDelete: (id: string) => void;
}) {
  if (annotation.author !== "human" || annotation.sentAt !== null) return null;
  // Icon-only and revealed on hover or keyboard focus: these are secondary
  // actions, and filled pills made them read as primary.
  const className =
    "inline-flex size-7 min-h-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100";
  return (
    <div className="mt-1.5 flex items-center gap-0.5">
      {editing ? null : (
        <button
          type="button"
          className={className}
          aria-label={`Edit ${annotationLabel(annotation)}`}
          title="Edit comment"
          onClick={() => onEdit(annotation)}
        >
          <Icon name="Edit" className="size-3" />
        </button>
      )}
      <button
        type="button"
        className={`${className} disabled:opacity-50`}
        aria-label={`Delete ${annotationLabel(annotation)}`}
        title={
          hasReplies
            ? "Comment has replies and cannot be deleted on its own."
            : "Delete comment"
        }
        disabled={hasReplies}
        onClick={() => onDelete(annotation.id)}
      >
        <Icon name="Trash2" className="size-3" />
      </button>
    </div>
  );
}

// Resolved threads are history: keep them behind one disclosure so the open
// work is what the drawer shows first.
function partitionByResolved(
  roots: Annotation[],
): [Annotation[], Annotation[]] {
  const open: Annotation[] = [];
  const done: Annotation[] = [];
  for (const root of roots) {
    (root.resolvedAt ? done : open).push(root);
  }
  return [open, done];
}

function CommentList({
  annotations,
  onRemove,
  onResolve,
  onSuggestion,
  onReply,
  onLocate,
  replyDrafts,
  onReplyDraft,
  onEdit,
  onEditDraft,
  editDrafts,
}: {
  annotations: Annotation[];
  onRemove: (id: string) => void;
  onResolve: (annotation: Annotation) => void;
  onSuggestion: (annotation: Annotation, accept: boolean) => void;
  onReply: (parent: Annotation, body: string) => Promise<void>;
  onLocate?: (annotation: Annotation) => void;
  replyDrafts: Map<string, string>;
  onReplyDraft: (id: string, value: string | null) => void;
  onEdit: (annotation: Annotation, body: string) => Promise<void>;
  onEditDraft: (id: string, value: string | null) => void;
  editDrafts: Map<string, string>;
}) {
  if (!annotations.length)
    return <p className="text-xs text-muted-foreground">No comments yet.</p>;
  // One top-level comment with replies (Slack style): roots keep arrival order,
  // replies render indented under their root in arrival order.
  const roots = annotations.filter((annotation) => !annotation.parentId);
  const repliesByRoot = new Map<string, Annotation[]>();
  for (const annotation of annotations) {
    if (!annotation.parentId) continue;
    const list = repliesByRoot.get(annotation.parentId) ?? [];
    list.push(annotation);
    repliesByRoot.set(annotation.parentId, list);
  }
  const replyCountByParent = new Map<string, number>();
  for (const annotation of annotations) {
    if (!annotation.parentId) continue;
    replyCountByParent.set(
      annotation.parentId as string,
      (replyCountByParent.get(annotation.parentId) ?? 0) + 1,
    );
  }
  const [openRoots, doneRoots] = partitionByResolved(roots);
  const [showDone, setShowDone] = useState(false);
  const renderThread = (root: Annotation) => (
    <div key={root.id}>
      <CommentCard
        annotation={root}
        onRemove={onRemove}
        onResolve={onResolve}
        onSuggestion={onSuggestion}
        onReply={onReply}
        onLocate={onLocate}
        replyDrafts={replyDrafts}
        onReplyDraft={onReplyDraft}
        hasReplies={(replyCountByParent.get(root.id) ?? 0) > 0}
        onEdit={onEdit}
        onEditDraft={onEditDraft}
        editDrafts={editDrafts}
      />
      {repliesByRoot.has(root.id) ? (
        <div className="ml-4 border-l-2 border-muted pl-2">
          {(repliesByRoot.get(root.id) ?? []).map((reply) => (
            <CommentCard
              key={reply.id}
              annotation={reply}
              onRemove={onRemove}
              onResolve={onResolve}
              onSuggestion={onSuggestion}
              onReply={onReply}
              onLocate={onLocate}
              replyDrafts={replyDrafts}
              onReplyDraft={onReplyDraft}
              onEdit={onEdit}
              onEditDraft={onEditDraft}
              editDrafts={editDrafts}
              hideReplyButton
            />
          ))}
        </div>
      ) : null}
    </div>
  );
  return (
    <div className="space-y-2">
      {openRoots.map(renderThread)}
      {doneRoots.length ? (
        <div className="pt-1">
          <button
            type="button"
            className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            aria-expanded={showDone}
            onClick={() => setShowDone((current) => !current)}
          >
            <Icon
              name={showDone ? "ChevronDown" : "ChevronRight"}
              className="size-3"
            />
            Resolved ({doneRoots.length})
          </button>
          {showDone ? (
            <div className="mt-1 space-y-2">{doneRoots.map(renderThread)}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function FileCommentsBar({
  path,
  annotations,
  busy,
  composerOpen,
  composerBody,
  onComposerBody,
  onOpenComposer,
  onCloseComposer,
  onAdd,
  onRemove,
  onResolve,
  onSuggestion,
  onReply,
  replyDrafts,
  onReplyDraft,
  onEdit,
  onEditDraft,
  editDrafts,
}: {
  path: string;
  annotations: Annotation[];
  busy: boolean;
  composerOpen: boolean;
  composerBody: string;
  onComposerBody: (value: string) => void;
  onOpenComposer: () => void;
  onCloseComposer: () => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onResolve: (annotation: Annotation) => void;
  onSuggestion: (annotation: Annotation, accept: boolean) => void;
  onReply: (parent: Annotation, body: string) => Promise<void>;
  replyDrafts: Map<string, string>;
  onReplyDraft: (id: string, value: string | null) => void;
  onEdit: (annotation: Annotation, body: string) => Promise<void>;
  onEditDraft: (id: string, value: string | null) => void;
  editDrafts: Map<string, string>;
}) {
  const roots = annotations.filter((annotation) => !annotation.parentId);
  const repliesByRoot = new Map<string, Annotation[]>();
  for (const annotation of annotations) {
    if (!annotation.parentId) continue;
    const list = repliesByRoot.get(annotation.parentId) ?? [];
    list.push(annotation);
    repliesByRoot.set(annotation.parentId, list);
  }
  return (
    <div className="mb-2 rounded-md border bg-card p-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          File comments
        </p>
        {!composerOpen ? (
          <Button size="sm" variant="outline" onClick={onOpenComposer}>
            Comment on file
          </Button>
        ) : null}
      </div>
      {composerOpen ? (
        <div className="mt-2 rounded-md border border-primary bg-background p-3 shadow-lg">
          <p className="text-xs text-muted-foreground">
            Comment on {path} (whole file)
          </p>
          <textarea
            maxLength={1000}
            value={composerBody}
            onChange={(event) => onComposerBody(event.target.value)}
            placeholder="Leave feedback on the whole file... Markdown supported"
            aria-label="File comment"
            className={`mt-2 min-h-24 w-full rounded border bg-background p-2 ${COARSE_POINTER_TEXT_BASE_CLASS} focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring`}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onCloseComposer}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={onAdd}
              disabled={busy || !composerBody.trim()}
            >
              Add comment
            </Button>
          </div>
        </div>
      ) : null}
      {roots.length ? (
        <div className="mt-2">
          {roots.map((root) => (
            <div key={root.id}>
              <CommentCard
                annotation={root}
                onRemove={onRemove}
                onResolve={onResolve}
                onSuggestion={onSuggestion}
                onReply={onReply}
                replyDrafts={replyDrafts}
                onReplyDraft={onReplyDraft}
                hasReplies={(repliesByRoot.get(root.id)?.length ?? 0) > 0}
                onEdit={onEdit}
                onEditDraft={onEditDraft}
                editDrafts={editDrafts}
              />
              {repliesByRoot.has(root.id) ? (
                <div className="ml-4 border-l-2 border-muted pl-2">
                  {(repliesByRoot.get(root.id) ?? []).map((reply) => (
                    <CommentCard
                      key={reply.id}
                      annotation={reply}
                      onRemove={onRemove}
                      onResolve={onResolve}
                      onSuggestion={onSuggestion}
                      onReply={onReply}
                      replyDrafts={replyDrafts}
                      onReplyDraft={onReplyDraft}
                      onEdit={onEdit}
                      onEditDraft={onEditDraft}
                      editDrafts={editDrafts}
                      hideReplyButton
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Composer({
  file,
  selection,
  body,
  busy,
  onBody,
  onAdd,
  onCancel,
}: {
  file: File | null;
  selection: Selection;
  body: string;
  busy: boolean;
  onBody: (value: string) => void;
  onAdd: () => void;
  onCancel: () => void;
}) {
  // autoFocus does not fire reliably here on desktop: the composer mounts
  // through Pierre's renderAnnotation callback after React's initial commit,
  // so focus the textarea explicitly once it is in the DOM.
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);
  return (
    <div className="rounded-md border border-primary bg-background p-3 shadow-lg">
      <p className="text-xs text-muted-foreground">
        Comment on {file?.path}:{selection.startLine}
        {selection.endLine === selection.startLine
          ? ""
          : `-${selection.endLine}`}{" "}
        ({selection.side})
      </p>
      <textarea
        ref={textareaRef}
        maxLength={1000}
        value={body}
        onChange={(event) => onBody(event.target.value)}
        placeholder="Leave feedback... Markdown supported"
        aria-label="Comment"
        className={`mt-2 min-h-24 w-full rounded border bg-background p-2 ${COARSE_POINTER_TEXT_BASE_CLASS} focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring`}
      />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={onAdd} disabled={busy || !body.trim()}>
          Add comment
        </Button>
      </div>
    </div>
  );
}

function ReviewSummary({
  review,
  busy,
  summaryDraft,
  onSummaryDraftChange,
  noteOpen,
  onNoteOpenChange,
  replyDrafts,
  onReplyDraft,
  onSaveSummary,
  onRemove,
  onResolve,
  onSuggestion,
  onSend,
  onReply,
  onLocate,
  onEdit,
  onEditDraft,
  editDrafts,
  onClose,
}: {
  review: Review;
  busy: boolean;
  summaryDraft: string;
  onSummaryDraftChange: (summary: string) => void;
  noteOpen: boolean;
  onNoteOpenChange: (open: boolean) => void;
  replyDrafts: Map<string, string>;
  onReplyDraft: (id: string, value: string | null) => void;
  onSaveSummary: (summary: string) => Promise<void>;
  onRemove: (id: string) => void;
  onResolve: (annotation: Annotation) => void;
  onSuggestion: (annotation: Annotation, accept: boolean) => void;
  onSend: (ids: Iterable<string>) => void;
  onReply: (parent: Annotation, body: string) => Promise<void>;
  onLocate: (annotation: Annotation) => void;
  onEdit: (annotation: Annotation, body: string) => Promise<void>;
  onEditDraft: (id: string, value: string | null) => void;
  editDrafts: Map<string, string>;
  onClose?: () => void;
}) {
  const pending = review.annotations.filter(
    (annotation) =>
      annotation.sentAt === null &&
      annotation.resolvedAt === null &&
      annotation.author !== "agent",
  );
  const hasNotes = Boolean(review.summary?.trim());
  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Dialog.Title className="text-sm font-semibold">
            Review feedback
          </Dialog.Title>
          <p className="mt-1 text-xs text-muted-foreground">
            {pending.length} pending comment{pending.length === 1 ? "" : "s"}{" "}
            across {new Set(pending.map((item) => item.filePath)).size} file
            {new Set(pending.map((item) => item.filePath)).size === 1
              ? ""
              : "s"}
          </p>
        </div>
        {onClose ? (
          <Button size="sm" variant="ghost" onClick={onClose}>
            Done
          </Button>
        ) : null}
      </div>
      <div className="mt-3">
        {noteOpen ? (
          <>
            <label
              className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
              htmlFor="review-overall-summary"
            >
              Review note
            </label>
            <textarea
              id="review-overall-summary"
              maxLength={2000}
              value={summaryDraft}
              onChange={(event) => onSummaryDraftChange(event.target.value)}
              onBlur={() => {
                if (summaryDraft.trim() !== (review.summary ?? ""))
                  void onSaveSummary(summaryDraft);
              }}
              placeholder="Optional note about the changeset as a whole, sent with every batch."
              className={`mt-1 min-h-16 w-full rounded border bg-background p-2 ${COARSE_POINTER_TEXT_BASE_CLASS} focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring`}
            />
          </>
        ) : (
          // A permanently open textarea outshouted the comments it describes.
          <button
            type="button"
            className="flex w-full items-center gap-1.5 rounded border border-dashed px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
            onClick={() => onNoteOpenChange(true)}
          >
            <Icon name="Edit" className="size-3" />
            {summaryDraft.trim() || review.summary
              ? "Edit review note"
              : "Add a review note"}
          </button>
        )}
      </div>
      <div className="mt-3 min-h-0 overflow-auto">
        <CommentList
          annotations={review.annotations}
          onRemove={onRemove}
          onResolve={onResolve}
          onSuggestion={onSuggestion}
          onReply={onReply}
          onLocate={onLocate}
          replyDrafts={replyDrafts}
          onReplyDraft={onReplyDraft}
          onEdit={onEdit}
          onEditDraft={onEditDraft}
          editDrafts={editDrafts}
        />
      </div>
      <Button
        className="mt-3 w-full"
        onClick={() => onSend(pending.map((item) => item.id))}
        disabled={busy || (!pending.length && !hasNotes)}
      >
        {busy
          ? "Sending..."
          : pending.length
            ? `Send ${pending.length} comment${pending.length === 1 ? "" : "s"} to agent`
            : "Send review note to agent"}
      </Button>
      <p className="mt-2 text-center text-[11px] text-muted-foreground">
        {pending.length
          ? "Everything you have not resolved goes to the agent in one batch."
          : hasNotes
            ? "No pending comments left; this sends the review note only."
            : "Nothing to send yet. Add a comment or a review note."}
      </p>
    </div>
  );
}

function FileFilterControls({
  query,
  onQuery,
  mode,
  onModeChange,
  compact = false,
}: {
  query: string;
  onQuery: (query: string) => void;
  mode: FileFilterMode;
  onModeChange: (mode: FileFilterMode) => void;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "flex min-w-0 flex-1 gap-2" : "space-y-2"}>
      <Input
        className={compact ? "h-8 min-w-0 flex-1 text-xs" : "h-8 text-xs"}
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        placeholder="Search files..."
        aria-label={compact ? "Search files on mobile" : "Search changed files"}
      />
      {compact ? (
        <select
          aria-label="Changed file filter"
          value={mode}
          onChange={(event) =>
            onModeChange(event.target.value as FileFilterMode)
          }
          className="h-8 max-w-40 rounded-md border bg-background px-2 text-xs"
        >
          <option value="all">All</option>
          <option value="unviewed">Unviewed</option>
          <option value="with-open-comments">With open comments</option>
        </select>
      ) : (
        <div className="flex gap-1" aria-label="Changed file filters">
          {(
            [
              ["all", "All"],
              ["unviewed", "Unviewed"],
              ["with-open-comments", "With open comments"],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              size="sm"
              variant={mode === value ? "secondary" : "ghost"}
              aria-pressed={mode === value}
              onClick={() => onModeChange(value)}
              className="px-2 text-[11px]"
            >
              {label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

function ReviewPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  // Full-screen mode: the panel spans the whole viewport (the BB tab it
  // normally lives in is only a slice of the page).
  const [fullscreen, setFullscreen] = useState(false);
  const navigate = useBbNavigate();
  const [review, setReview] = useState<Review | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [body, setBody] = useState("");
  const [replyDrafts, setReplyDrafts] = useState<Map<string, string>>(
    new Map(),
  );
  const [editDrafts, setEditDrafts] = useState<Map<string, string>>(new Map());
  const [summaryDraft, setSummaryDraft] = useState("");
  // Collapsed by default: a permanently open note outshouted the comments it
  // describes. Lives in the panel so it survives the drawer unmounting.
  const [noteOpen, setNoteOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const feedbackOpenerRef = useRef<HTMLElement | null>(null);
  const [mobilePanel, setMobilePanel] = useState<"compose" | null>(null);
  const [fileQuery, setFileQuery] = useState("");
  const [fileFilterMode, setFileFilterMode] = useState<FileFilterMode>("all");
  const [wrapLines, setWrapLines] = useState(false);
  const [busy, setBusy] = useState(false);
  // Comment locate flow: a pending locate survives the file switch and
  // resolves after the diff re-renders.
  const [pendingLocate, setPendingLocate] = useState<{
    id: string;
    fileLevel: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [targetKind, setTargetKind] = useState<
    "uncommitted" | "commit" | "branch"
  >("uncommitted");
  const [targetValue, setTargetValue] = useState("");
  const [recentCommits, setRecentCommits] = useState<{
    status: "ok" | "unavailable";
    reason: string | null;
    commits: Array<{
      sha: string;
      short: string;
      date: string;
      subject: string;
      author: string;
    }>;
  } | null>(null);
  // Load the checkout's recent commits whenever the commit target is picked;
  // they feed the picker so shas never have to be pasted by hand.
  useEffect(() => {
    if (targetKind !== "commit") return;
    let cancelled = false;
    setRecentCommits(null);
    rpc
      .call("recentCommits", { threadId, limit: 15 })
      .then((result) => {
        if (cancelled) return;
        setRecentCommits(
          result as {
            status: "ok" | "unavailable";
            reason: string | null;
            commits: never[];
          },
        );
      })
      .catch(() => {
        if (cancelled) return;
        setRecentCommits({
          status: "unavailable",
          reason: "Unable to list commits.",
          commits: [],
        });
      });
    return () => {
      cancelled = true;
    };
  }, [targetKind, threadId, rpc]);
  const [fileComposerOpen, setFileComposerOpen] = useState(false);
  const [fileCommentBody, setFileCommentBody] = useState("");
  const scrollSectionRef = useRef<HTMLElement>(null);

  function buildRefreshTarget(): ReviewTarget | undefined {
    if (targetKind === "commit" && targetValue.trim())
      return { type: "commit", sha: targetValue.trim() };
    if (targetKind === "branch" && targetValue.trim())
      return { type: "branch_committed", mergeBaseBranch: targetValue.trim() };
    return undefined;
  }

  const load = useCallback(
    async (reviewId?: string) => {
      const [result, history] = await Promise.all([
        rpc.call("review", { threadId, ...(reviewId ? { reviewId } : {}) }),
        rpc.call("revisions", { threadId }),
      ]);
      const next = result.review as Review | null;
      setReview(next);
      setSummaryDraft(next?.summary ?? "");
      setNoteOpen(Boolean(next?.summary?.trim()));
      setReplyDrafts(new Map());
      setFeedbackOpen(false);
      setRevisions(history.revisions as Revision[]);
      setSelection(null);
      setFilePath((current) =>
        current && next?.files.some((file) => file.path === current)
          ? current
          : (next?.files[0]?.path ?? null),
      );
    },
    [rpc, threadId],
  );
  useEffect(() => {
    void load().catch((cause) =>
      setError(
        cause instanceof Error ? cause.message : "Unable to load review.",
      ),
    );
  }, [load]);

  const openThreadCounts = useMemo(
    () => unresolvedRootThreadCounts(review?.annotations ?? []),
    [review?.annotations],
  );
  const viewedPaths = useMemo(
    () => new Set(review?.viewedPaths ?? []),
    [review?.viewedPaths],
  );
  const visibleFiles = useMemo(
    () =>
      filterChangedFiles(review?.files ?? [], fileQuery, {
        mode: fileFilterMode,
        viewedPaths,
        openThreadCounts,
      }),
    [fileFilterMode, fileQuery, openThreadCounts, review?.files, viewedPaths],
  );
  useEffect(() => {
    if (visibleFiles.some((candidate) => candidate.path === filePath)) return;
    setFilePath(visibleFiles[0]?.path ?? null);
    setSelection(null);
  }, [filePath, visibleFiles]);
  const file =
    review?.files.find((candidate) => candidate.path === filePath) ?? null;
  const parsed = useMemo(
    () => (file?.patch ? getSingularPatch(file.patch) : null),
    [file],
  );
  const loadDiffFiles = useMemo<FileDiffContentsLoader | undefined>(() => {
    if (
      !review ||
      !file ||
      file.binary ||
      file.truncated ||
      ["added", "deleted"].includes(normalizeChangeKind(file.status)) ||
      !parsed
    )
      return undefined;
    return async () => {
      const result = await rpc.call("reviewFileContents", {
        reviewId: review.id,
        filePath: file.path,
      });
      if (!result.old || !result.new)
        throw new Error(
          "Full file contents are not available for this snapshot.",
        );
      return {
        oldFile: {
          name: result.old.path,
          contents: result.old.content,
          cacheKey: `${review.snapshot}:old:${result.old.path}`,
        },
        newFile: {
          name: result.new.path,
          contents: result.new.content,
          cacheKey: `${review.snapshot}:new:${result.new.path}`,
        },
      };
    };
  }, [file, parsed, review, rpc]);
  const currentIndex = file
    ? (review?.files.findIndex((candidate) => candidate.path === file.path) ??
        0) + 1
    : 0;
  const currentAnnotations = useMemo<
    DiffLineAnnotation<DiffAnnotation>[]
  >(() => {
    const annotations: DiffLineAnnotation<DiffAnnotation>[] = (
      review?.annotations ?? []
    )
      // File-level comments (and their replies) have no in-diff anchor;
      // they render in the File comments bar instead.
      .filter(
        (annotation) =>
          annotation.filePath === file?.path && !annotation.fileLevel,
      )
      .map((annotation) => ({
        side: annotation.side === "old" ? "deletions" : "additions",
        lineNumber: annotation.startLine,
        metadata: annotation,
      }));
    if (selection) {
      annotations.push({
        side: selection.side === "old" ? "deletions" : "additions",
        lineNumber: selection.startLine,
        metadata: { composer: true, selection },
      });
    }
    return annotations;
  }, [file?.path, review?.annotations, selection]);
  const pendingCount =
    review?.annotations.filter(
      (annotation) =>
        annotation.sentAt === null &&
        annotation.resolvedAt === null &&
        annotation.author !== "agent",
    ).length ?? 0;
  const isViewed = Boolean(file && review?.viewedPaths.includes(file.path));

  const chooseFile = useCallback((path: string) => {
    setFilePath(path);
    setSelection(null);
    setMobilePanel(null);
    setFileComposerOpen(false);
    scrollSectionRef.current?.scrollTo?.({ top: 0 });
  }, []);
  const handleDiffSelection = useCallback((range: SelectedLineRange | null) => {
    const next = range ? rangeToAnchor(range) : null;
    setSelection(next);
    setMobilePanel(next ? "compose" : null);
  }, []);
  const updateReplyDraft = useCallback((id: string, value: string | null) => {
    setReplyDrafts((current) => {
      const next = new Map(current);
      if (value === null) next.delete(id);
      else next.set(id, value);
      return next;
    });
  }, []);
  // Edit drafts live in their own map so opening an editor on a comment never
  // disturbs a reply draft on the same thread.
  const updateEditDraft = useCallback((id: string, value: string | null) => {
    setEditDrafts((current) => {
      const next = new Map(current);
      if (value === null) next.delete(id);
      else next.set(id, value);
      return next;
    });
  }, []);

  async function markViewed(viewed: boolean): Promise<boolean> {
    if (!review || !file) return false;
    try {
      const result = await rpc.call("markFileViewed", {
        reviewId: review.id,
        filePath: file.path,
        viewed,
      });
      setReview({
        ...review,
        viewedPaths: viewed
          ? [...new Set([...review.viewedPaths, file.path])]
          : review.viewedPaths.filter((path) => path !== file.path),
      });
      setRevisions((current) =>
        current.map((revision) =>
          revision.id === review.id
            ? { ...revision, viewedCount: result.viewedCount as number }
            : revision,
        ),
      );
      setError(null);
      // The reviewed diff stays on screen; snap back to its top so the
      // reading position resets after the viewed toggle.
      scrollSectionRef.current?.scrollTo?.({ top: 0 });
      return true;
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to update viewed state.",
      );
      return false;
    }
  }
  async function markViewedAndNext(openBatchWhenDone: boolean) {
    if (!review || !file) return;
    const nextPath = nextUnviewedFilePath(
      visibleFiles,
      file.path,
      review.viewedPaths,
    );
    if (await markViewed(true)) {
      if (nextPath) chooseFile(nextPath);
      else if (openBatchWhenDone && fileFilterMode !== "unviewed")
        setFeedbackOpen(true);
    }
  }
  async function clearPrevious() {
    if (
      !review ||
      revisions.length < 2 ||
      !window.confirm(
        "Delete every older review revision and its comments? This cannot be undone.",
      )
    )
      return;
    setBusy(true);
    try {
      await rpc.call("clearPreviousReviews", {
        threadId,
        keepReviewId: review.id,
      });
      await load(review.id);
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to clear previous reviews.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function refresh(input?: { target?: ReviewTarget }) {
    setBusy(true);
    try {
      const result = await rpc.call("refreshReview", {
        threadId,
        ...(input?.target ? { target: input.target } : {}),
      });
      const next = result.review as Review;
      setReview(next);
      setFilePath(next.files[0]?.path ?? null);
      setSelection(null);
      await load(next.id);
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to load changes.",
      );
    } finally {
      setBusy(false);
    }
  }
  const locateComment = useCallback(
    (annotation: Annotation) => {
      if (!review || !annotation.filePath) return;
      setFeedbackOpen(false);
      setFileQuery("");
      setFileFilterMode("all");
      if (annotation.filePath !== filePath) chooseFile(annotation.filePath);
      if (annotation.fileLevel) {
        // Whole-file comments have no in-diff anchor; snap to the top bar.
        scrollSectionRef.current?.scrollTo?.({ top: 0 });
        return;
      }
      setPendingLocate({ id: annotation.id, fileLevel: false });
    },
    [review, filePath, chooseFile],
  );
  // Scroll once the relocated file's diff annotation exists in the DOM.
  // Pierre renders annotations asynchronously after the file switch (rpc +
  // diff build can take longer than any fixed short wait), so poll until
  // the marker card exists, giving up after ~5s.
  useEffect(() => {
    if (!pendingLocate) return;
    const id = pendingLocate.id;
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = () => {
      const element = scrollSectionRef.current?.querySelector(
        `[data-annotation-id="${id}"]`,
      );
      if (element) {
        element.scrollIntoView({ block: "center" });
        setPendingLocate(null);
        return;
      }
      if (Date.now() - startedAt > 5000) {
        setPendingLocate(null);
        return;
      }
      timer = setTimeout(attempt, 100);
    };
    attempt();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [pendingLocate]);

  async function addFileComment() {
    if (!review || !file || !fileCommentBody.trim()) return;
    setBusy(true);
    try {
      const result = await rpc.call("addAnnotation", {
        reviewId: review.id,
        filePath: file.path,
        body: fileCommentBody.trim(),
        fileLevel: true,
      });
      const annotation = result.annotation as Annotation;
      setReview({
        ...review,
        annotations: [...review.annotations, annotation],
      });
      setFileCommentBody("");
      setFileComposerOpen(false);
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to add file comment.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function add() {
    if (!review || !file || !selection || !body.trim()) return;
    setBusy(true);
    try {
      const result = await rpc.call("addAnnotation", {
        reviewId: review.id,
        filePath: file.path,
        ...selection,
        body: body.trim(),
      });
      const annotation = result.annotation as Annotation;
      setReview({
        ...review,
        annotations: [...review.annotations, annotation],
      });
      setBody("");
      setSelection(null);
      setMobilePanel(null);
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to add comment.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function reply(parent: Annotation, body: string) {
    if (!review || !body.trim()) return;
    try {
      const result = await rpc.call("addAnnotation", {
        reviewId: review.id,
        filePath: parent.filePath,
        side: parent.side,
        startLine: parent.startLine,
        endLine: parent.endLine,
        body: body.trim(),
        parentId: parent.id,
      });
      const annotation = result.annotation as Annotation;
      setReview({
        ...review,
        annotations: [...review.annotations, annotation],
      });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to add reply.");
      throw cause;
    }
  }
  async function saveSummary(text: string) {
    if (!review) return;
    try {
      const result = await rpc.call("setReviewSummary", {
        reviewId: review.id,
        summary: text,
      });
      setReview({ ...review, summary: result.summary as string | null });
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to save review note.",
      );
    }
  }
  async function remove(id: string) {
    try {
      await rpc.call("removeAnnotation", { annotationId: id });
      setReview((current) =>
        current
          ? {
              ...current,
              annotations: current.annotations.filter(
                (annotation) => annotation.id !== id,
              ),
            }
          : current,
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to remove comment.",
      );
    }
  }
  async function edit(annotation: Annotation, body: string) {
    try {
      const result = await rpc.call("editAnnotation", {
        annotationId: annotation.id,
        body: body.trim(),
      });
      const updated = result.annotation as Annotation;
      setReview((current) =>
        current
          ? {
              ...current,
              annotations: current.annotations.map((candidate) =>
                candidate.id === updated.id ? updated : candidate,
              ),
            }
          : current,
      );
      setError(null);
    } catch (cause) {
      // Rethrow so the editor keeps the draft open with the error visible.
      setError(
        cause instanceof Error ? cause.message : "Unable to edit comment.",
      );
      throw cause;
    }
  }
  async function resolve(annotation: Annotation) {
    try {
      const result = await rpc.call("resolveAnnotation", {
        annotationId: annotation.id,
        resolved: annotation.resolvedAt === null,
      });
      const resolvedAt = result.resolvedAt as number | null;
      setReview((current) =>
        current
          ? {
              ...current,
              annotations: current.annotations.map((item) =>
                item.id === annotation.id ? { ...item, resolvedAt } : item,
              ),
            }
          : current,
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to update comment.",
      );
    }
  }
  async function decideSuggestion(annotation: Annotation, accept: boolean) {
    if (!annotation.resolutionSuggestion) return;
    try {
      const result = await rpc.call("decideResolutionSuggestion", {
        suggestionId: annotation.resolutionSuggestion.id,
        accept,
      });
      const resolvedAt = result.resolvedAt as number | null;
      setReview((current) =>
        current
          ? {
              ...current,
              annotations: current.annotations.map((item) =>
                item.id === annotation.id
                  ? { ...item, resolvedAt, resolutionSuggestion: null }
                  : item,
              ),
            }
          : current,
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to decide resolution suggestion.",
      );
    }
  }
  async function carryForward() {
    if (!review || !revisions[0] || review.id === revisions[0].id) return;
    const annotationIds = review.annotations
      .filter((annotation) => annotation.resolvedAt === null)
      .map((annotation) => annotation.id);
    if (!annotationIds.length) return;
    setBusy(true);
    try {
      await rpc.call("carryForward", {
        sourceReviewId: review.id,
        targetReviewId: revisions[0].id,
        annotationIds,
      });
      await load(revisions[0].id);
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to carry comments forward.",
      );
    } finally {
      setBusy(false);
    }
  }
  const hasNotes = Boolean(review?.summary?.trim());
  // Everything unsent, unresolved, and human goes in one batch. There is no
  // selection step: a comment you wrote is already addressed to the agent, and
  // resolving or deleting it is how you take it back out.
  async function send(ids: Iterable<string>) {
    if (!review) return;
    const targets = new Set(ids);
    if (targets.size === 0 && !hasNotes) return;
    setBusy(true);
    try {
      const result = await rpc.call("sendBatch", {
        reviewId: review.id,
        annotationIds: [...targets],
      });
      const sentAt = result.sentAt as number;
      setReview({
        ...review,
        annotations: review.annotations.map((annotation) =>
          targets.has(annotation.id) ? { ...annotation, sentAt } : annotation,
        ),
      });
      setMobilePanel(null);
      setError(null);
      navigate.toThread(threadId);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to send feedback.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main
      className={`flex min-h-0 flex-col overflow-hidden bg-background text-foreground ${fullscreen ? "fixed inset-0 z-50" : "h-full"}`}
    >
      <header className="flex flex-wrap shrink-0 items-center gap-2 border-b bg-card px-3 py-2 lg:px-4">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => navigate.toThread(threadId)}
          aria-label="Back to thread"
        >
          ← <span className="hidden sm:inline">Back</span>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="hidden truncate text-sm font-semibold sm:block">
            Review changes
          </h1>
          <p className="hidden truncate text-xs text-muted-foreground sm:block">
            Diff-first review · {review?.snapshot.slice(0, 10) ?? "not opened"}
          </p>
        </div>
        {review && revisions[0] && review.id !== revisions[0].id ? (
          <Button
            className="hidden xl:inline-flex"
            size="sm"
            variant="outline"
            onClick={() => void carryForward()}
            disabled={
              busy ||
              !review.annotations.some(
                (annotation) => annotation.resolvedAt === null,
              )
            }
          >
            Carry open comments forward
          </Button>
        ) : null}
        <details className="relative">
          <summary
            className="flex h-8 cursor-pointer list-none items-center rounded-md border px-2 text-xs hover:bg-muted"
            aria-label="Review actions"
          >
            •••
          </summary>
          <div className="absolute top-10 right-0 z-30 w-56 max-lg:left-0 max-lg:right-auto rounded-md border bg-popover p-2 text-popover-foreground shadow-lg">
            {review && revisions[0] && review.id !== revisions[0].id ? (
              <button
                className="block w-full rounded px-2 py-2 text-left text-xs hover:bg-muted xl:hidden"
                onClick={() => void carryForward()}
              >
                Carry open comments forward
              </button>
            ) : null}
            <button
              className="block w-full rounded px-2 py-2 text-left text-xs text-destructive hover:bg-muted"
              onClick={() => void clearPrevious()}
              disabled={busy || revisions.length < 2}
            >
              Delete older review revisions
            </button>
          </div>
        </details>
        <select
          aria-label="Review target"
          value={targetKind}
          onChange={(event) =>
            setTargetKind(event.target.value as typeof targetKind)
          }
          className="h-8 max-w-48 rounded-md border bg-background px-1 text-xs"
        >
          <option value="uncommitted">Uncommitted changes</option>
          <option value="commit">Specific commit</option>
          <option value="branch">Branch vs base</option>
        </select>
        {targetKind === "commit" ? (
          recentCommits === null ? (
            <span className="text-[11px] text-muted-foreground">
              Loading commits...
            </span>
          ) : recentCommits.status === "ok" && recentCommits.commits.length ? (
            <select
              aria-label="Recent commits"
              value={
                recentCommits.commits.some(
                  (commit) => commit.sha === targetValue,
                )
                  ? targetValue
                  : ""
              }
              onChange={(event) => setTargetValue(event.target.value)}
              className="h-8 min-w-0 max-w-64 flex-1 rounded-md border bg-background px-1 text-xs"
            >
              <option value="">Pick a commit...</option>
              {recentCommits.commits.map((commit) => (
                <option
                  key={commit.sha}
                  value={commit.sha}
                  title={`${commit.author} · ${commit.date}`}
                >
                  {`${commit.short} · ${commit.subject.slice(0, 60)} (${commit.date})`}
                </option>
              ))}
            </select>
          ) : null
        ) : null}
        {targetKind !== "uncommitted" ? (
          <input
            value={targetValue}
            onChange={(event) => setTargetValue(event.target.value)}
            placeholder={
              targetKind === "commit" ? "paste commit sha" : "base branch"
            }
            aria-label={targetKind === "commit" ? "Commit sha" : "Base branch"}
            className="h-8 w-44 rounded-md border bg-background px-2 font-mono text-xs"
          />
        ) : null}
        <Button
          size="sm"
          variant="outline"
          onClick={() => void refresh({ target: buildRefreshTarget() })}
          disabled={
            busy || (targetKind !== "uncommitted" && !targetValue.trim())
          }
        >
          {busy
            ? "Working..."
            : targetKind === "commit"
              ? "Review commit"
              : targetKind === "branch"
                ? "Review branch"
                : review
                  ? "Refresh"
                  : "Open review"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className={COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS}
          onClick={() => setFullscreen((current) => !current)}
          aria-pressed={fullscreen}
          aria-label={fullscreen ? "Exit full screen" : "Full screen"}
        >
          <Icon name={fullscreen ? "Minimize2" : "Maximize2"} />
        </Button>
      </header>
      {review && revisions[0] && review.id !== revisions[0].id ? (
        <p
          role="status"
          aria-label="Stale review revision"
          title="Comment anchors stay on this immutable snapshot."
          className="mx-3 mt-2 shrink-0 rounded border border-yellow-500/30 bg-yellow-500/10 px-2 py-1 text-xs text-yellow-700 dark:text-yellow-300"
        >
          Viewing a stale revision. Anchors stay on this snapshot.
        </p>
      ) : null}
      {error ? (
        <p className="m-3 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {!review ? (
        <div className="p-6 text-sm text-muted-foreground">
          Open a review to load the uncommitted changes in this thread&apos;s
          environment.
        </div>
      ) : (
        <>
          <Dialog.Root open={feedbackOpen} onOpenChange={setFeedbackOpen}>
            <div className="shrink-0 space-y-2 border-b bg-muted/20 p-2 lg:hidden">
              <div className="flex gap-2">
                <select
                  aria-label="Review revision"
                  value={review.id}
                  onChange={(event) => void load(event.target.value)}
                  className="min-w-0 flex-1 rounded-md border bg-background px-2 py-2 text-xs"
                >
                  {revisions.map((revision) => (
                    <option key={revision.id} value={revision.id}>
                      {new Date(revision.createdAt).toLocaleString()} ·{" "}
                      {describeTarget(revision.target)} ·{" "}
                      {revision.unresolvedCount} open
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Changed file"
                  value={filePath ?? ""}
                  disabled={!visibleFiles.length}
                  onChange={(event) => chooseFile(event.target.value)}
                  className="min-w-0 flex-[1.5] rounded-md border bg-background px-2 py-2 text-xs"
                >
                  {visibleFiles.length ? null : (
                    <option value="" disabled>
                      No matching files
                    </option>
                  )}
                  {visibleFiles.map((candidate, index) => (
                    <option key={candidate.path} value={candidate.path}>
                      {index + 1}/{visibleFiles.length} · {candidate.path}
                      {openThreadCounts.has(candidate.path)
                        ? ` · ${openThreadCounts.get(candidate.path)} open`
                        : ""}
                    </option>
                  ))}
                </select>
              </div>
              <FileFilterControls
                compact
                query={fileQuery}
                onQuery={setFileQuery}
                mode={fileFilterMode}
                onModeChange={setFileFilterMode}
              />
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[15rem_minmax(0,1fr)]">
              <aside className="hidden min-h-0 overflow-auto border-r bg-card lg:block">
                <div className="border-b p-3">
                  <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Revision
                  </label>
                  <select
                    aria-label="Review revision"
                    value={review.id}
                    onChange={(event) => void load(event.target.value)}
                    className="mt-2 w-full rounded-md border bg-background px-2 py-2 text-xs"
                  >
                    {revisions.map((revision) => (
                      <option key={revision.id} value={revision.id}>
                        {new Date(revision.createdAt).toLocaleString()} ·{" "}
                        {describeTarget(revision.target)} ·{" "}
                        {revision.unresolvedCount} open
                      </option>
                    ))}
                  </select>
                </div>
                <div className="border-b p-3">
                  <div className="flex justify-between text-xs font-medium">
                    <span>Files changed</span>
                    <span className="text-muted-foreground">
                      {review.viewedPaths.length} of {review.files.length}{" "}
                      viewed
                    </span>
                  </div>
                  <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
                    <i
                      className="block h-full rounded-full bg-emerald-500"
                      style={{
                        width: `${review.files.length ? (review.viewedPaths.length / review.files.length) * 100 : 0}%`,
                      }}
                    />
                  </div>
                  <div className="mt-3">
                    <FileFilterControls
                      query={fileQuery}
                      onQuery={setFileQuery}
                      mode={fileFilterMode}
                      onModeChange={setFileFilterMode}
                    />
                  </div>
                </div>
                <nav className="p-2" aria-label="Changed files">
                  {visibleFiles.map((candidate) => (
                    <button
                      key={candidate.path}
                      onClick={() => chooseFile(candidate.path)}
                      className={`mb-1 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs ${candidate.path === filePath ? "bg-muted font-medium shadow-[inset_2px_0_theme(colors.primary)]" : "hover:bg-muted/60"}`}
                    >
                      <span
                        className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${(() => {
                          const kind = normalizeChangeKind(candidate.status);
                          return kind === "added"
                            ? "bg-green-500/15 text-green-600"
                            : kind === "deleted"
                              ? "bg-red-500/15 text-red-600"
                              : "bg-yellow-500/15 text-yellow-600";
                        })()}`}
                      >
                        {candidate.status[0]?.toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate" title={candidate.path}>
                          {compactPath(candidate.path, 32)}
                        </span>
                        <span className="mt-0.5 flex gap-2 text-[11px] font-normal">
                          <span className="text-green-600">
                            +{candidate.additions}
                          </span>
                          <span className="text-red-600">
                            -{candidate.deletions}
                          </span>
                        </span>
                      </span>
                      {review.viewedPaths.includes(candidate.path) ? (
                        <span aria-label="Viewed" className="text-primary">
                          ✓
                        </span>
                      ) : null}
                      {openThreadCounts.get(candidate.path) ? (
                        <span
                          aria-label={`${openThreadCounts.get(candidate.path)} open comment threads`}
                          title={`${openThreadCounts.get(candidate.path)} open comment threads`}
                          className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary"
                        >
                          {openThreadCounts.get(candidate.path)}
                        </span>
                      ) : null}
                    </button>
                  ))}
                  {!visibleFiles.length ? (
                    <p className="p-2 text-xs text-muted-foreground">
                      No matching files.
                    </p>
                  ) : null}
                </nav>
              </aside>
              <section
                ref={scrollSectionRef}
                className="min-h-0 overflow-auto pb-20 lg:pb-3"
              >
                <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background/95 px-3 py-2 backdrop-blur lg:px-4">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      chooseFile(
                        adjacentFilePath(visibleFiles, filePath, -1) ??
                          filePath ??
                          "",
                      )
                    }
                    disabled={!visibleFiles.length}
                    aria-label="Previous changed file"
                  >
                    ‹
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      chooseFile(
                        adjacentFilePath(visibleFiles, filePath, 1) ??
                          filePath ??
                          "",
                      )
                    }
                    disabled={!visibleFiles.length}
                    aria-label="Next changed file"
                  >
                    ›
                  </Button>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs font-semibold">
                    {file?.path ?? "No changed files"}
                  </span>
                  <span className="hidden text-[11px] text-muted-foreground sm:inline">
                    {currentIndex} / {review.files.length}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className={`${COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS} text-muted-foreground`}
                    onClick={() => setWrapLines((current) => !current)}
                    aria-pressed={wrapLines}
                    aria-label={
                      wrapLines ? "Disable diff line wrap" : "Wrap diff lines"
                    }
                  >
                    <Icon name="TextWrap" />
                  </Button>
                  <Dialog.Trigger asChild>
                    <Button
                      className="hidden lg:inline-flex"
                      size="sm"
                      variant="outline"
                      aria-label={`Review feedback, ${pendingCount} pending/unsent comments`}
                      onClick={(event) => {
                        feedbackOpenerRef.current = event.currentTarget;
                      }}
                    >
                      Review feedback{" "}
                      <span className="text-[11px] tabular-nums">
                        {pendingCount} pending/unsent
                      </span>
                    </Button>
                  </Dialog.Trigger>
                  <Button
                    className="hidden lg:inline-flex"
                    size="sm"
                    variant={isViewed ? "secondary" : "outline"}
                    onClick={() =>
                      void (isViewed
                        ? markViewed(false)
                        : markViewedAndNext(false))
                    }
                    disabled={!file}
                  >
                    {isViewed ? "Viewed ✓" : "Mark viewed"}
                  </Button>
                  <Button
                    className="lg:hidden"
                    size="sm"
                    variant={isViewed ? "secondary" : "default"}
                    onClick={() =>
                      void (isViewed
                        ? markViewed(false)
                        : markViewedAndNext(true))
                    }
                    disabled={!file}
                  >
                    {isViewed ? "Viewed ✓" : "Viewed & next"}
                  </Button>
                </div>
                <div className="p-2 lg:p-4">
                  {!file ? (
                    <p className="text-sm text-muted-foreground">
                      No changed files.
                    </p>
                  ) : file.binary ? (
                    <p className="text-sm text-muted-foreground">
                      {file.path} is binary and cannot be annotated.
                    </p>
                  ) : !parsed ? (
                    <p className="text-sm text-muted-foreground">
                      No patch is available for {file.path}.
                    </p>
                  ) : (
                    <>
                      {file.truncated ? (
                        <p className="mb-2 rounded border border-yellow-500/30 bg-yellow-500/10 p-2 text-xs text-yellow-700 dark:text-yellow-300">
                          This patch is truncated. Comments still refer only to
                          the visible immutable snapshot.
                        </p>
                      ) : null}
                      <FileCommentsBar
                        path={file.path}
                        annotations={review.annotations.filter(
                          (annotation) =>
                            annotation.fileLevel &&
                            annotation.filePath === file.path,
                        )}
                        busy={busy}
                        composerOpen={fileComposerOpen}
                        composerBody={fileCommentBody}
                        onComposerBody={setFileCommentBody}
                        onOpenComposer={() => {
                          setFileCommentBody("");
                          setFileComposerOpen(true);
                        }}
                        onCloseComposer={() => {
                          setFileCommentBody("");
                          setFileComposerOpen(false);
                        }}
                        onAdd={() => void addFileComment()}
                        onRemove={(id) => void remove(id)}
                        onResolve={(annotation) => void resolve(annotation)}
                        onSuggestion={(annotation, accept) =>
                          void decideSuggestion(annotation, accept)
                        }
                        onReply={reply}
                        replyDrafts={replyDrafts}
                        onReplyDraft={updateReplyDraft}
                        onEdit={(annotation, body) => edit(annotation, body)}
                        onEditDraft={updateEditDraft}
                        editDrafts={editDrafts}
                      />
                      <div className="overflow-hidden rounded-md border bg-card">
                        <PierreReviewDiff
                          fileDiff={parsed}
                          lineAnnotations={currentAnnotations}
                          annotations={review.annotations}
                          replyDrafts={replyDrafts}
                          onReply={reply}
                          onReplyDraft={updateReplyDraft}
                          editDrafts={editDrafts}
                          onEdit={(annotation, body) => edit(annotation, body)}
                          onEditDraft={updateEditDraft}
                          onRemove={(id) => void remove(id)}
                          wrapLines={wrapLines}
                          loadDiffFiles={loadDiffFiles}
                          composer={{
                            file,
                            selection,
                            body,
                            busy,
                            onBody: setBody,
                            onAdd: () => void add(),
                            onCancel: () => {
                              setSelection(null);
                              setBody("");
                            },
                          }}
                          onSelect={handleDiffSelection}
                        />
                      </div>
                    </>
                  )}
                </div>
              </section>
            </div>
            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
              <Dialog.Content
                onEscapeKeyDown={() => setFeedbackOpen(false)}
                onCloseAutoFocus={(event) => {
                  event.preventDefault();
                  feedbackOpenerRef.current?.focus();
                }}
                className="fixed inset-0 z-50 flex max-h-dvh w-full flex-col overflow-auto border bg-background p-4 shadow-2xl focus:outline-none lg:inset-y-0 lg:left-auto lg:right-0 lg:max-w-lg"
              >
                <Dialog.Description className="sr-only">
                  {pendingCount} pending/unsent comments. Review, select, and
                  send feedback to the agent.
                </Dialog.Description>
                <ReviewSummary
                  review={review}
                  busy={busy}
                  summaryDraft={summaryDraft}
                  onSummaryDraftChange={setSummaryDraft}
                  noteOpen={noteOpen}
                  onNoteOpenChange={setNoteOpen}
                  replyDrafts={replyDrafts}
                  onReplyDraft={updateReplyDraft}
                  onSaveSummary={saveSummary}
                  onRemove={(id) => void remove(id)}
                  onResolve={(annotation) => void resolve(annotation)}
                  onSuggestion={(annotation, accept) =>
                    void decideSuggestion(annotation, accept)
                  }
                  onSend={(ids) => void send(ids)}
                  onReply={reply}
                  onLocate={locateComment}
                  onEdit={(annotation, body) => edit(annotation, body)}
                  onEditDraft={updateEditDraft}
                  editDrafts={editDrafts}
                  onClose={() => setFeedbackOpen(false)}
                />
              </Dialog.Content>
            </Dialog.Portal>
            <nav
              className="fixed bottom-0 left-0 right-0 z-20 flex items-stretch border-t bg-card/95 backdrop-blur lg:hidden"
              aria-label="Review sections"
              style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
            >
              <button
                type="button"
                onClick={() => setMobilePanel(null)}
                aria-current={mobilePanel === null ? "page" : undefined}
                className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] ${mobilePanel === null ? "text-foreground" : "text-muted-foreground"}`}
              >
                <Icon name="FileDiff" className="size-4" />
                Diff
              </button>
              <button
                type="button"
                aria-label={`Review feedback, ${pendingCount} pending/unsent comments`}
                aria-haspopup="dialog"
                aria-expanded={feedbackOpen}
                aria-current={feedbackOpen ? "page" : undefined}
                onClick={(event) => {
                  feedbackOpenerRef.current = event.currentTarget;
                  setFeedbackOpen(true);
                }}
                className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] ${feedbackOpen ? "text-foreground" : "text-muted-foreground"}`}
              >
                <span className="relative">
                  <Icon name="MessageSquare" className="size-4" />
                  {pendingCount > 0 ? (
                    <span
                      aria-hidden="true"
                      className="absolute -right-2 -top-1.5 flex size-4 items-center justify-center rounded-full bg-primary text-[9px] font-semibold leading-none text-primary-foreground"
                    >
                      {pendingCount}
                    </span>
                  ) : null}
                </span>
                Feedback
              </button>
            </nav>
            {mobilePanel === "compose" && selection ? (
              <div className="fixed inset-0 z-40 flex items-start bg-black/40 p-3 pt-[max(0.75rem,env(safe-area-inset-top))] lg:hidden">
                <div className="max-h-[85dvh] w-full overflow-auto rounded-xl border bg-background p-4 shadow-2xl">
                  <Composer
                    file={file}
                    selection={selection}
                    body={body}
                    busy={busy}
                    onBody={setBody}
                    onAdd={() => void add()}
                    onCancel={() => {
                      setSelection(null);
                      setBody("");
                      setMobilePanel(null);
                    }}
                  />
                </div>
              </div>
            ) : null}
          </Dialog.Root>
        </>
      )}
    </main>
  );
}

function ReviewPage({ subPath }: { subPath: string }) {
  const threadId = subPath.replace(/^review\//, "");
  return threadId ? (
    <ReviewPanel threadId={threadId} />
  ) : (
    <main className="p-6 text-sm text-muted-foreground">
      Open Review Workspace from a thread&apos;s Review button.
    </main>
  );
}

function ReviewHeaderAction({
  threadId,
  isCompactViewport,
}: {
  threadId: string;
  isCompactViewport: boolean;
}) {
  const navigate = useBbNavigate();
  if (isCompactViewport) {
    // Compact (phone) header action row: 28px icon-only control that opens
    // the same full-page review panel.
    return (
      <Button
        size="icon"
        variant="ghost"
        className="size-7"
        aria-label="Open Review Workspace"
        onClick={() =>
          navigate.toPluginPanel("review", { subPath: `review/${threadId}` })
        }
      >
        <Icon name="GitPullRequest" className="size-4" />
      </Button>
    );
  }
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() =>
        navigate.toPluginPanel("review", { subPath: `review/${threadId}` })
      }
    >
      Review
    </Button>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "review",
    title: "Review Workspace",
    icon: "GitPullRequest",
    path: "review",
    component: ReviewPage,
  });
  app.slots.experimental_threadHeaderAction({
    id: "review-header",
    title: "Open Review Workspace",
    component: ReviewHeaderAction,
  });
});
