import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { definePluginApp, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
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
} from "./lib/review-navigation";
import {
  changeTypeLabels,
  entityAnchor,
  stableEntityId,
} from "./lib/sem-outline";
import type {
  SemEntityChange,
  SemImpactResult,
  SemEntityBrief,
} from "./lib/sem";
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
// EXPERIMENTAL: entity outline markers rendered invisibly inside the diff so
// entity outline rows can scroll to their region.
type EntityMarker = { entityMarker: true; entityId: string };
type DiffAnnotation = Annotation | ComposerMarker | EntityMarker;

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

function StateChip({
  tone = "muted",
  children,
}: {
  tone?: "muted" | "primary" | "emerald";
  children: React.ReactNode;
}) {
  const tones = {
    muted: "bg-muted text-muted-foreground",
    primary: "bg-primary text-primary-foreground",
    emerald: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
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
    "author" | "carriedFromAnnotationId" | "resolvedAt" | "sentAt"
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
        <StateChip tone="primary">Review comment</StateChip>
      )}
      {annotation.carriedFromAnnotationId ? (
        <StateChip>carried</StateChip>
      ) : null}
      {annotation.sentAt ? <StateChip>sent</StateChip> : null}
      {annotation.resolvedAt ? (
        <StateChip tone="emerald">✓ resolved</StateChip>
      ) : null}
    </div>
  );
}

const PierreReviewDiff = memo(function PierreReviewDiff({
  fileDiff,
  lineAnnotations,
  composer,
  wrapLines,
  loadDiffFiles,
  onSelect,
}: {
  fileDiff: FileDiffMetadata;
  lineAnnotations: DiffLineAnnotation<DiffAnnotation>[];
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
        if ("entityMarker" in annotation) {
          // Invisible anchor for the entity outline's scrollIntoView.
          return (
            <div
              key={annotation.entityId}
              data-entity-anchor={annotation.entityId}
            />
          );
        }
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
  selected,
  onToggle,
  onRemove,
  onResolve,
  onSuggestion,
  onReply,
  onLocate,
  hideReplyButton = false,
}: {
  annotation: Annotation;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onResolve: (annotation: Annotation) => void;
  onSuggestion: (annotation: Annotation, accept: boolean) => void;
  onReply: (parent: Annotation, body: string) => Promise<void>;
  onLocate?: (annotation: Annotation) => void;
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
  const [replying, setReplying] = useState(false);
  const selectLabel = `Select ${annotationLabel(annotation)}`;
  const notSendable =
    annotation.sentAt !== null ||
    annotation.resolvedAt !== null ||
    annotation.author === "agent";
  if (collapsed) {
    return (
      <article className="rounded-md border p-2 text-xs opacity-65">
        <button
          type="button"
          aria-label={`Show ${annotationLabel(annotation)}`}
          aria-expanded={false}
          className="block w-full text-left"
          onClick={() => setCollapsed(false)}
        >
          <span className="font-mono text-[11px] text-muted-foreground">
            {annotationLabel(annotation)}
          </span>
          <span className="ml-2 inline-block align-middle">
            <AnnotationMeta annotation={annotation} />
          </span>
          <span className="ml-auto inline-block align-middle">{locate}</span>
          <p className="mt-1 truncate text-muted-foreground">
            {annotation.body}
          </p>
        </button>
      </article>
    );
  }
  return (
    <article
      className={`rounded-md border p-2 text-xs ${annotation.sentAt || annotation.resolvedAt ? "opacity-65" : ""}`}
    >
      <div className="flex gap-2">
        <input
          type="checkbox"
          aria-label={selectLabel}
          checked={selected.has(annotation.id)}
          disabled={notSendable}
          onChange={() => onToggle(annotation.id)}
          className="mt-0.5"
        />
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
          {annotation.sentAt ? null : (
            <button
              className={
                annotation.resolvedAt
                  ? "mt-1.5 text-muted-foreground hover:text-foreground"
                  : "ml-3 mt-1.5 text-destructive hover:opacity-80"
              }
              onClick={() => onRemove(annotation.id)}
            >
              Remove
            </button>
          )}
          {hideReplyButton ? null : replying ? null : (
            <button
              className="ml-3 mt-1.5 text-primary hover:opacity-80"
              onClick={() => setReplying(true)}
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
              onCancel={() => setReplying(false)}
            />
          ) : null}
        </div>
      </div>
    </article>
  );
}

function ReplyBox({
  parent,
  onReply,
  onCancel,
}: {
  parent: Annotation;
  onReply: (parent: Annotation, body: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="mt-2 rounded bg-muted p-2">
      <textarea
        aria-label={`Reply to ${annotationLabel(parent)}`}
        maxLength={1000}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Reply in this thread..."
        className="min-h-14 w-full rounded border bg-background p-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div className="mt-1 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={busy || !draft.trim()}
          onClick={() => {
            setBusy(true);
            void onReply(parent, draft)
              .then(onCancel)
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "Replying..." : "Reply"}
        </Button>
      </div>
    </div>
  );
}

function CommentList({
  annotations,
  selected,
  onToggle,
  onRemove,
  onResolve,
  onSuggestion,
  onReply,
  onLocate,
}: {
  annotations: Annotation[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onResolve: (annotation: Annotation) => void;
  onSuggestion: (annotation: Annotation, accept: boolean) => void;
  onReply: (parent: Annotation, body: string) => Promise<void>;
  onLocate?: (annotation: Annotation) => void;
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
  return (
    <div className="space-y-2">
      {roots.map((root) => (
        <div key={root.id}>
          <CommentCard
            annotation={root}
            selected={selected}
            onToggle={onToggle}
            onRemove={onRemove}
            onResolve={onResolve}
            onSuggestion={onSuggestion}
            onReply={onReply}
            onLocate={onLocate}
          />
          {repliesByRoot.has(root.id) ? (
            <div className="ml-4 border-l-2 border-muted pl-2">
              {(repliesByRoot.get(root.id) ?? []).map((reply) => (
                <CommentCard
                  key={reply.id}
                  annotation={reply}
                  selected={selected}
                  onToggle={onToggle}
                  onRemove={onRemove}
                  onResolve={onResolve}
                  onSuggestion={onSuggestion}
                  onReply={onReply}
                  onLocate={onLocate}
                  hideReplyButton
                />
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function FileCommentsBar({
  path,
  annotations,
  selected,
  busy,
  composerOpen,
  composerBody,
  onComposerBody,
  onOpenComposer,
  onCloseComposer,
  onAdd,
  onToggle,
  onRemove,
  onResolve,
  onSuggestion,
  onReply,
}: {
  path: string;
  annotations: Annotation[];
  selected: Set<string>;
  busy: boolean;
  composerOpen: boolean;
  composerBody: string;
  onComposerBody: (value: string) => void;
  onOpenComposer: () => void;
  onCloseComposer: () => void;
  onAdd: () => void;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onResolve: (annotation: Annotation) => void;
  onSuggestion: (annotation: Annotation, accept: boolean) => void;
  onReply: (parent: Annotation, body: string) => Promise<void>;
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
                selected={selected}
                onToggle={onToggle}
                onRemove={onRemove}
                onResolve={onResolve}
                onSuggestion={onSuggestion}
                onReply={onReply}
              />
              {repliesByRoot.has(root.id) ? (
                <div className="ml-4 border-l-2 border-muted pl-2">
                  {(repliesByRoot.get(root.id) ?? []).map((reply) => (
                    <CommentCard
                      key={reply.id}
                      annotation={reply}
                      selected={selected}
                      onToggle={onToggle}
                      onRemove={onRemove}
                      onResolve={onResolve}
                      onSuggestion={onSuggestion}
                      onReply={onReply}
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

// EXPERIMENTAL: single semantic surface - aggregated "Changes by entity"
// summary for the whole revision, the only sem-powered surface in the app.
// Rows jump straight to the diff at the entity anchor when the range has
// visible lines; otherwise the jump is reported as a miss instead of
// silently doing nothing.
function EntitySummary({
  changes,
  onLoadImpact,
  impacts,
  onJump,
}: {
  changes: SemEntityChange[];
  onLoadImpact: (entityId: string) => void;
  impacts: Map<string, SemImpactResult | undefined>;
  onJump: (entity: SemEntityChange) => void;
}) {
  const [hideCosmetics, setHideCosmetics] = useState(true);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const visible = hideCosmetics
    ? changes.filter((change) => change.structuralChange !== false)
    : changes;
  if (!changes.length)
    return (
      <p className="mb-2 rounded-md border border-dashed p-2 text-xs text-muted-foreground">
        sem found no entity-level changes in this revision.
      </p>
    );
  return (
    <div className="mb-2 rounded-md border border-primary/40 bg-card p-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Changes by entity (experimental - sem)
        </p>
        <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            checked={hideCosmetics}
            onChange={(event) => setHideCosmetics(event.target.checked)}
            aria-label="Hide cosmetic-only changes"
          />
          hide cosmetics
        </label>
      </div>
      <ul className="mt-1 space-y-0.5">
        {visible.map((entity) => {
          const impact = impacts.get(entity.entityId);
          const expanded = expandedIds.has(entity.entityId);
          return (
            <li key={entity.entityId}>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-muted/40"
                  onClick={() => {
                    setExpandedIds((current) => {
                      const next = new Set(current);
                      if (next.has(entity.entityId)) {
                        next.delete(entity.entityId);
                      } else {
                        next.add(entity.entityId);
                        onLoadImpact(entity.entityId);
                      }
                      return next;
                    });
                  }}
                  title={expanded ? "Hide impact" : "Show transitive impact"}
                >
                  <StateChip
                    tone={
                      entity.changeType === "added"
                        ? "emerald"
                        : entity.changeType === "deleted"
                          ? "primary"
                          : "muted"
                    }
                  >
                    {changeTypeLabels[entity.changeType]}
                  </StateChip>
                  <span className="truncate font-mono text-[11px]">
                    {compactPath(entity.filePath, 28)}{" "}
                    <strong>{entity.entityName}</strong>
                  </span>
                  {expanded && impact ? (
                    impact.status === "ok" ? (
                      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                        {impact.total} affected
                      </span>
                    ) : null
                  ) : null}
                </button>
                <button
                  type="button"
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  aria-label={`Go to ${entity.entityName}`}
                  title="Go to diff"
                  onClick={() => onJump(entity)}
                >
                  <Icon name="Target" className="size-3" />
                </button>
              </div>
              {expanded ? (
                <div className="ml-6 rounded border bg-background p-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Impact
                    {impact?.status === "ok" &&
                    impact.resolvedAs &&
                    impact.resolvedAs.entityId !==
                      stableEntityId(entity.entityId) ? (
                      <span
                        className="ml-1 font-normal normal-case"
                        title="sem indexes the owning entity, not this granular one"
                      >
                        (of {impact.resolvedAs.type} {impact.resolvedAs.name})
                      </span>
                    ) : null}
                  </p>
                  {impact === undefined ? (
                    <p className="text-[11px] text-muted-foreground">
                      Computing impact...
                    </p>
                  ) : impact.status === "unavailable" ? (
                    <p className="text-[11px] text-muted-foreground">
                      sem impact unavailable: {impact.reason}
                    </p>
                  ) : (
                    <>
                      <p className="text-[11px] text-muted-foreground">
                        {impact.total} affected entit
                        {impact.total === 1 ? "y" : "ies"}
                        {impact.depth > 1
                          ? ` (${impact.depth} levels deep)`
                          : ""}
                        {impact.tests.length
                          ? `, ${impact.tests.length} test suite${impact.tests.length === 1 ? "" : "s"}`
                          : ""}
                      </p>
                      {impact.dependents.length ? (
                        <ul className="mt-1 space-y-0.5">
                          {impact.dependents.slice(0, 10).map((dependent) => (
                            <li
                              key={dependent.entityId}
                              className="truncate text-[11px]"
                            >
                              <span className="font-mono text-muted-foreground">
                                {dependent.file}:{dependent.lines[0]}
                              </span>{" "}
                              {dependent.name} ({dependent.type})
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-[11px] text-muted-foreground">
                          No dependents found outside this revision.
                        </p>
                      )}
                      {impact.tests.length ? (
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          affected tests:{" "}
                          {impact.tests
                            .slice(0, 3)
                            .map((test) => test.name)
                            .join(", ")}
                        </p>
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {!visible.length ? (
        <p className="mt-1 text-[11px] text-muted-foreground">
          All changes are cosmetic-only (formatting, comments) - sem found no
          structural entity edits.
        </p>
      ) : null}
    </div>
  );
}

function ReviewSummary({
  review,
  selected,
  onSaveSummary,
  onToggle,
  onRemove,
  onResolve,
  onSuggestion,
  onSend,
  onReply,
  onLocate,
  onClose,
}: {
  review: Review;
  selected: Set<string>;
  onSaveSummary: (summary: string) => Promise<void>;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onResolve: (annotation: Annotation) => void;
  onSuggestion: (annotation: Annotation, accept: boolean) => void;
  onSend: () => void;
  onReply: (parent: Annotation, body: string) => Promise<void>;
  onLocate: (annotation: Annotation) => void;
  onClose?: () => void;
}) {
  const [summaryDraft, setSummaryDraft] = useState(review.summary ?? "");
  useEffect(() => setSummaryDraft(review.summary ?? ""), [review.id]);
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
          <h2 className="text-sm font-semibold">Review summary</h2>
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
          onChange={(event) => setSummaryDraft(event.target.value)}
          onBlur={() => {
            if (summaryDraft.trim() !== (review.summary ?? ""))
              void onSaveSummary(summaryDraft);
          }}
          placeholder="Optional note about the changeset as a whole, sent with every batch."
          className={`mt-1 min-h-16 w-full rounded border bg-background p-2 ${COARSE_POINTER_TEXT_BASE_CLASS} focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring`}
        />
      </div>
      <div className="mt-3 min-h-0 overflow-auto">
        <CommentList
          annotations={review.annotations}
          selected={selected}
          onToggle={onToggle}
          onRemove={onRemove}
          onResolve={onResolve}
          onSuggestion={onSuggestion}
          onReply={onReply}
          onLocate={onLocate}
        />
      </div>
      <Button
        className="mt-3 w-full"
        onClick={onSend}
        disabled={!selected.size && !hasNotes}
      >
        {selected.size
          ? `Send ${selected.size} comment${selected.size === 1 ? "" : "s"} to agent`
          : "Send summary to agent"}
      </Button>
      <p className="mt-2 text-center text-[11px] text-muted-foreground">
        Select unresolved comments to send as one batch, or send just the review
        note.
      </p>
    </div>
  );
}

function ReviewPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [review, setReview] = useState<Review | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [body, setBody] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mobilePanel, setMobilePanel] = useState<"compose" | "batch" | null>(
    null,
  );
  const [fileQuery, setFileQuery] = useState("");
  const [wrapLines, setWrapLines] = useState(false);
  const [busy, setBusy] = useState(false);
  // Comment locate flow: a pending locate survives the file switch and
  // resolves after the diff re-renders.
  const [pendingLocate, setPendingLocate] = useState<{
    id: string;
    fileLevel: boolean;
  } | null>(null);
  // EXPERIMENTAL: single semantic surface (revision-level "Changes by
  // entity" summary), fully off by default.
  const [entitiesEnabled, setEntitiesEnabled] = useState(false);
  const [entitySummaryChanges, setEntitySummaryChanges] = useState<
    SemEntityChange[] | null
  >(null);
  const [entitySummaryReason, setEntitySummaryReason] = useState<string | null>(
    null,
  );
  const [entityImpacts, setEntityImpacts] = useState<
    Map<string, SemImpactResult | undefined>
  >(new Map());
  const [pendingEntityJump, setPendingEntityJump] = useState<string | null>(
    null,
  );
  const [entityJumpMiss, setEntityJumpMiss] = useState<string | null>(null);
  async function loadEntitySummary() {
    if (!review) return;
    try {
      const result = await rpc.call("entitySummary", { reviewId: review.id });
      if (result.status === "ok") {
        setEntitySummaryChanges(result.changes as SemEntityChange[]);
        setEntitySummaryReason(null);
      } else {
        setEntitySummaryChanges([]);
        setEntitySummaryReason(result.reason ?? "sem is unavailable");
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to load summary.",
      );
    }
  }
  // Refresh the summary whenever the toggle is on and the revision changes.
  useEffect(() => {
    if (!entitiesEnabled || !review) {
      setEntitySummaryChanges(null);
      setEntitySummaryReason(null);
      setEntityJumpMiss(null);
      return;
    }
    setEntityJumpMiss(null);
    void loadEntitySummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entitiesEnabled, review?.id]);

  // Poll for the jumped entity's anchor after a file switch (same pattern as
  // the late-looking-annotation locate flow).
  useEffect(() => {
    if (!pendingEntityJump) return;
    const entityId = pendingEntityJump;
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = () => {
      const element = scrollSectionRef.current?.querySelector(
        `[data-entity-anchor="${entityId}"]`,
      );
      if (element) {
        element.scrollIntoView({ block: "center" });
        setPendingEntityJump(null);
        return;
      }
      if (Date.now() - startedAt > 5000) {
        setPendingEntityJump(null);
        return;
      }
      timer = setTimeout(attempt, 100);
    };
    attempt();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [pendingEntityJump]);

  async function loadEntityImpact(entityId: string) {
    if (!review || entityImpacts.has(entityId)) return;
    setEntityImpacts((current) => {
      const next = new Map(current);
      next.set(entityId, undefined);
      return next;
    });
    try {
      const result = await rpc.call("entityImpact", {
        reviewId: review.id,
        entityId,
      });
      setEntityImpacts((current) => {
        const next = new Map(current);
        next.set(entityId, result as SemImpactResult);
        return next;
      });
    } catch (cause) {
      setEntityImpacts((current) => {
        const next = new Map(current);
        next.set(entityId, {
          status: "unavailable",
          reason:
            cause instanceof Error ? cause.message : "sem impact failed to run",
        });
        return next;
      });
    }
  }
  const [error, setError] = useState<string | null>(null);
  const [targetKind, setTargetKind] = useState<
    "uncommitted" | "commit" | "branch"
  >("uncommitted");
  const [targetValue, setTargetValue] = useState("");
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
      setRevisions(history.revisions as Revision[]);
      setSelected(new Set());
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

  const visibleFiles = useMemo(
    () => filterChangedFiles(review?.files ?? [], fileQuery),
    [fileQuery, review?.files],
  );
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
  // Entity outline markers placed at each anchor line, only while enabled.
  // Anchors come from the revision-level summary, filtered to the file
  // currently on screen.
  const entityMarkers = useMemo(() => {
    if (!entitiesEnabled || !entitySummaryChanges || !file) return [];
    return entitySummaryChanges
      .filter((entity) => entity.filePath === file.path)
      .map((entity) => ({ entity, anchor: entityAnchor(entity, file.patch) }))
      .filter(
        (
          item,
        ): item is {
          entity: SemEntityChange;
          anchor: { side: "new" | "old"; line: number };
        } => Boolean(item.anchor),
      )
      .map((item) => ({
        side:
          item.anchor.side === "old"
            ? ("deletions" as const)
            : ("additions" as const),
        lineNumber: item.anchor.line,
        metadata: {
          entityMarker: true,
          entityId: item.entity.entityId,
        } as const,
      }));
  }, [entitiesEnabled, entitySummaryChanges, file]);

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
    // EXPERIMENTAL: entity outline markers ride along when enabled.
    annotations.push(...entityMarkers);
    if (selection) {
      annotations.push({
        side: selection.side === "old" ? "deletions" : "additions",
        lineNumber: selection.startLine,
        metadata: { composer: true, selection },
      });
    }
    return annotations;
  }, [file?.path, review?.annotations, selection, entityMarkers]);
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
  const toggleSelected = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
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
      review.files,
      file.path,
      review.viewedPaths,
    );
    if (await markViewed(true)) {
      if (nextPath) chooseFile(nextPath);
      else if (openBatchWhenDone) setMobilePanel("batch");
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
      setSelected(new Set());
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

  function jumpToEntity(entity: SemEntityChange) {
    if (!review) return;
    // Only jump when the entity has visible lines in the target diff;
    // otherwise say so instead of silently timing out.
    const target = review.files.find(
      (candidate) => candidate.path === entity.filePath,
    );
    if (!target || !entityAnchor(entity, target.patch)) {
      setEntityJumpMiss(entity.entityName);
      return;
    }
    setEntityJumpMiss(null);
    if (entity.filePath !== filePath) chooseFile(entity.filePath);
    setPendingEntityJump(entity.entityId);
  }

  function toggleEntities(next: boolean) {
    setEntitiesEnabled(next);
  }

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
      setSelected((current) => new Set(current).add(annotation.id));
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
      setSelected((current) => new Set(current).add(annotation.id));
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
      setSelected((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to remove comment.",
      );
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
      setSelected((current) => {
        const next = new Set(current);
        next.delete(annotation.id);
        return next;
      });
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
      setSelected(new Set());
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
  async function send() {
    if (!review || (selected.size === 0 && !hasNotes)) return;
    setBusy(true);
    try {
      const result = await rpc.call("sendBatch", {
        reviewId: review.id,
        annotationIds: [...selected],
      });
      const sentAt = result.sentAt as number;
      setReview({
        ...review,
        annotations: review.annotations.map((annotation) =>
          selected.has(annotation.id) ? { ...annotation, sentAt } : annotation,
        ),
      });
      setSelected(new Set());
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
    <main className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-2 border-b bg-card px-3 py-2 lg:px-4">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => navigate.toThread(threadId)}
          aria-label="Back to thread"
        >
          ← <span className="hidden sm:inline">Back</span>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">Review changes</h1>
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
          <div className="absolute right-0 top-10 z-30 w-56 rounded-md border bg-popover p-2 text-popover-foreground shadow-lg">
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
        <Button
          size="sm"
          variant="outline"
          onClick={() => void refresh({ target: buildRefreshTarget() })}
          disabled={busy}
        >
          {busy ? "Working..." : review ? "Refresh" : "Open review"}
        </Button>
        <select
          aria-label="Review target"
          value={targetKind}
          onChange={(event) =>
            setTargetKind(event.target.value as typeof targetKind)
          }
          className="h-8 rounded-md border bg-background px-1 text-xs"
        >
          <option value="uncommitted">Uncommitted</option>
          <option value="commit">Commit</option>
          <option value="branch">Branch vs base</option>
        </select>
        {targetKind !== "uncommitted" ? (
          <input
            value={targetValue}
            onChange={(event) => setTargetValue(event.target.value)}
            placeholder={targetKind === "commit" ? "commit sha" : "base branch"}
            aria-label={targetKind === "commit" ? "Commit sha" : "Base branch"}
            className="h-8 w-28 rounded-md border bg-background px-2 text-xs"
          />
        ) : null}
      </header>
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
          <div className="flex shrink-0 gap-2 border-b bg-muted/20 p-2 lg:hidden">
            <select
              aria-label="Review revision"
              value={review.id}
              onChange={(event) => void load(event.target.value)}
              className="min-w-0 flex-1 rounded-md border bg-background px-2 py-2 text-xs"
            >
              {revisions.map((revision) => (
                <option key={revision.id} value={revision.id}>
                  {new Date(revision.createdAt).toLocaleString()} ·{" "}
                  {describeTarget(revision.target)} · {revision.unresolvedCount}{" "}
                  open
                </option>
              ))}
            </select>
            <select
              aria-label="Changed file"
              value={filePath ?? ""}
              onChange={(event) => chooseFile(event.target.value)}
              className="min-w-0 flex-[1.5] rounded-md border bg-background px-2 py-2 text-xs"
            >
              {review.files.map((candidate, index) => (
                <option key={candidate.path} value={candidate.path}>
                  {index + 1}/{review.files.length} · {candidate.path}
                </option>
              ))}
            </select>
          </div>
          <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[15rem_minmax(0,1fr)_19rem]">
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
                    {review.viewedPaths.length} of {review.files.length} viewed
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
                <Input
                  className="mt-3 h-8 text-xs"
                  value={fileQuery}
                  onChange={(event) => setFileQuery(event.target.value)}
                  placeholder="Filter files..."
                  aria-label="Filter changed files"
                />
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
                    {review.annotations.some(
                      (annotation) =>
                        annotation.fileLevel &&
                        annotation.filePath === candidate.path,
                    ) ? (
                      <span
                        aria-label="Has file comment"
                        title="Has file comment"
                        className="shrink-0 text-muted-foreground"
                      >
                        <Icon name="FileText" />
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
                <Button
                  size="sm"
                  variant={entitiesEnabled ? "default" : "outline"}
                  onClick={() => toggleEntities(!entitiesEnabled)}
                  aria-pressed={entitiesEnabled}
                  aria-label="Entities (experimental)"
                >
                  Entities
                </Button>
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
              {entitiesEnabled &&
              entitySummaryChanges &&
              !entitySummaryReason ? (
                <div className="mx-2 mt-2 lg:mx-4">
                  <EntitySummary
                    changes={entitySummaryChanges}
                    onLoadImpact={loadEntityImpact}
                    impacts={entityImpacts}
                    onJump={jumpToEntity}
                  />
                </div>
              ) : null}
              {entitiesEnabled && entitySummaryReason ? (
                <div className="mx-2 mt-2 lg:mx-4">
                  <p className="mb-2 rounded-md border border-dashed p-2 text-xs text-muted-foreground">
                    sem is unavailable: {entitySummaryReason}
                  </p>
                </div>
              ) : null}
              {entitiesEnabled && entityJumpMiss ? (
                <div className="mx-2 mt-2 lg:mx-4">
                  <p className="text-[11px] text-muted-foreground">
                    {entityJumpMiss} has no visible lines in the diff, so it
                    cannot be located.
                  </p>
                </div>
              ) : null}
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
                      selected={selected}
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
                      onToggle={toggleSelected}
                      onRemove={(id) => void remove(id)}
                      onResolve={(annotation) => void resolve(annotation)}
                      onSuggestion={(annotation, accept) =>
                        void decideSuggestion(annotation, accept)
                      }
                      onReply={reply}
                    />
                    <div className="overflow-hidden rounded-md border bg-card">
                      <PierreReviewDiff
                        fileDiff={parsed}
                        lineAnnotations={currentAnnotations}
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
            <aside className="hidden min-h-0 overflow-auto border-l bg-card p-3 lg:flex lg:flex-col">
              {review.id !== revisions[0]?.id ? (
                <p className="mb-3 rounded border border-yellow-500/30 bg-yellow-500/10 p-2 text-xs text-yellow-700 dark:text-yellow-300">
                  Viewing a stale revision. Anchors stay on this snapshot.
                </p>
              ) : null}
              <ReviewSummary
                review={review}
                selected={selected}
                onSaveSummary={saveSummary}
                onToggle={toggleSelected}
                onRemove={(id) => void remove(id)}
                onResolve={(annotation) => void resolve(annotation)}
                onSuggestion={(annotation, accept) =>
                  void decideSuggestion(annotation, accept)
                }
                onSend={() => void send()}
                onReply={reply}
                onLocate={locateComment}
              />
            </aside>
          </div>
          <div className="fixed bottom-3 left-3 right-3 z-20 flex items-center gap-3 rounded-md border bg-card/95 p-2 shadow-lg backdrop-blur lg:hidden">
            <div className="min-w-0 flex-1">
              <strong className="block truncate text-xs">
                {pendingCount} pending comment{pendingCount === 1 ? "" : "s"}
              </strong>
              <small className="text-[11px] text-muted-foreground">
                {review.viewedPaths.length} of {review.files.length} files
                viewed
              </small>
            </div>
            <Button size="sm" onClick={() => setMobilePanel("batch")}>
              Review feedback
            </Button>
          </div>
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
          {mobilePanel === "batch" ? (
            <div className="fixed inset-0 z-40 flex items-start bg-black/40 p-3 pt-[max(0.75rem,env(safe-area-inset-top))] lg:hidden">
              <div className="max-h-[88dvh] w-full overflow-auto rounded-xl border bg-background p-4 shadow-2xl">
                <ReviewSummary
                  review={review}
                  selected={selected}
                  onSaveSummary={saveSummary}
                  onToggle={toggleSelected}
                  onRemove={(id) => void remove(id)}
                  onResolve={(annotation) => void resolve(annotation)}
                  onSuggestion={(annotation, accept) =>
                    void decideSuggestion(annotation, accept)
                  }
                  onSend={() => void send()}
                  onReply={reply}
                  onLocate={locateComment}
                  onClose={() => setMobilePanel(null)}
                />
              </div>
            </div>
          ) : null}
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
  if (isCompactViewport) return null;
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
  app.slots.threadPanelAction({
    id: "review-thread-panel",
    title: "Review changes",
    icon: "GitPullRequest",
    layout: "flush",
    component: ({ threadId }) => <ReviewPanel threadId={threadId} />,
  });
});
