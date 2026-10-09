import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  definePluginApp,
  experimental_usePluginId,
  useBbNavigate,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import * as Dialog from "@radix-ui/react-dialog";
import { FileDiff } from "@pierre/diffs/react";
import {
  getSingularPatch,
  type DiffLineAnnotation,
  type FileDiffContentsLoader,
  type FileDiffMetadata,
  type SelectedLineRange,
} from "@pierre/diffs";
import type { rpcContract, RecentReview, ReviewTour } from "./server";
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
import { normalizeChangeKind } from "./lib/utils";
import {
  isVisiblePatchRange,
  excerptPatch,
  patchHunkStarts,
  patchSourceLines,
} from "./lib/tours";

type File = {
  path: string;
  previousPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
  patch: string;
  deferredReason: string | null;
  truncated: boolean;
  oldIdentity: string | null;
  newIdentity: string | null;
  imageSides: {
    old: {
      path: string;
      mimeType: string;
      sizeBytes: number;
      width: number;
      height: number;
      sha256: string;
    } | null;
    new: {
      path: string;
      mimeType: string;
      sizeBytes: number;
      width: number;
      height: number;
      sha256: string;
    } | null;
  };
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
  | { type: "branch_committed"; mergeBaseBranch: string }
  | { type: "all"; mergeBaseBranch: string };

function describeTarget(target: ReviewTarget): string {
  if (target.type === "commit") return `commit ${target.sha.slice(0, 10)}`;
  if (target.type === "branch_committed")
    return `committed vs ${target.mergeBaseBranch}`;
  if (target.type === "all") return `everything vs ${target.mergeBaseBranch}`;
  return "uncommitted";
}

type ReviewTourAnchor = {
  filePath: string;
  side: "old" | "new";
  startLine: number;
  endLine: number;
  valid: boolean;
  reason: string | null;
};
type ReviewTourCard = Extract<
  ReviewTour["steps"][number]["blocks"][number],
  { kind: "evidence" }
>["card"];
type Review = {
  id: string;
  threadId: string;
  snapshot: string;
  baseIdentity: string | null;
  createdAt: number;
  target: ReviewTarget;
  files: File[];
  annotations: Annotation[];
  viewedPaths: string[];
  summary: string | null;
  tour: ReviewTour | null;
};
type RevisionDelta = {
  currentReviewId: string;
  status: "comparable" | "unknown";
  changedPaths: string[];
  unchangedPaths: string[];
  unknownPaths: string[];
  revertedPaths: string[];
  baselines: Array<{ path: string; reviewId: string; viewedAt: number }>;
  reason: string | null;
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
type KeyboardMarker = { keyboardMarker: true };
type DiffAnnotation = Annotation | ComposerMarker | KeyboardMarker;

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
        <StateChip>
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

/**
 * Shared no-op composer for surfaces that have no open draft. A stable
 * identity here keeps the memoized diff from re-rendering whenever an
 * unrelated file's draft changes.
 */
const INACTIVE_COMPOSER = {
  file: null,
  selection: null,
  body: "",
  busy: false,
  onBody: () => {},
  onAdd: async () => {},
  onCancel: () => {},
};

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
  keyboardSelection,
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
    onAdd: () => Promise<void>;
    onCancel: () => void;
  };
  onSelect: (range: SelectedLineRange | null) => void;
  keyboardSelection: SelectedLineRange | null;
}) {
  const options = useMemo(
    () => ({
      diffStyle: "unified" as const,
      lineDiffType: "word-alt" as const,
      overflow: wrapLines ? ("wrap" as const) : ("scroll" as const),
      enableLineSelection: true,
      disableFileHeader: true,
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
      selectedLines={keyboardSelection}
      disableWorkerPool
      options={options}
      renderAnnotation={(line) => {
        const annotation = line.metadata;
        if (!annotation) return null;
        if ("keyboardMarker" in annotation)
          return <div data-keyboard-cursor="" className="h-px" />;
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
            className={`group border-l-2 px-3 py-3 font-sans text-xs text-foreground ${
              annotation.resolvedAt
                ? "border-l-muted-foreground/30 bg-muted/30"
                : "border-l-primary/40 bg-card"
            }`}
          >
            <div className="mb-1.5">
              <AnnotationMeta annotation={annotation} />
            </div>
            <p
              className={`whitespace-pre-wrap leading-relaxed [overflow-wrap:anywhere] ${
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

/**
 * Mounts a file's diff only when it approaches the viewport. Rendering every
 * changed file at once made large reviews unusable on phones, so off-screen
 * surfaces stay as a light placeholder until the reader scrolls near them.
 * Once mounted they stay mounted, so scrolling back never re-tokenizes code.
 */
function LazyDiffSurface({
  rootMargin = "700px",
  placeholder,
  onMount,
  children,
}: {
  rootMargin?: string;
  placeholder: React.ReactNode;
  onMount?: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [near, setNear] = useState(false);
  const mountedRef = useRef(false);
  useEffect(() => {
    if (near) return;
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [near, rootMargin]);
  useEffect(() => {
    // Fire once. The parent's callback may have a fresh identity each render,
    // and notifying on every render would loop.
    if (near && !mountedRef.current) {
      mountedRef.current = true;
      onMount?.();
    }
  }, [near, onMount]);
  return <div ref={ref}>{near ? children : placeholder}</div>;
}

/**
 * Parses and renders one diff. Kept separate so patch parsing only happens
 * for surfaces that are actually mounted, instead of every changed file.
 */
const MountedDiff = memo(function MountedDiff({
  patch,
  lineAnnotations,
  annotations,
  replyDrafts,
  onReply,
  onReplyDraft,
  editDrafts,
  onEdit,
  onEditDraft,
  onRemove,
  wrapLines,
  loadDiffFiles,
  composer,
  onSelect,
  keyboardSelection,
}: {
  patch: string;
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
  composer: React.ComponentProps<typeof PierreReviewDiff>["composer"];
  onSelect: (range: SelectedLineRange | null) => void;
  keyboardSelection: SelectedLineRange | null;
}) {
  const parsed = useMemo(() => {
    if (!patch) return null;
    try {
      return getSingularPatch(patch);
    } catch {
      return null;
    }
  }, [patch]);
  if (!parsed)
    return (
      <p className="rounded border border-dashed p-4 text-xs text-muted-foreground">
        This stored patch could not be parsed. File-level feedback is still
        available.
      </p>
    );
  return (
    <PierreReviewDiff
      fileDiff={parsed}
      lineAnnotations={lineAnnotations}
      annotations={annotations}
      replyDrafts={replyDrafts}
      onReply={onReply}
      onReplyDraft={onReplyDraft}
      editDrafts={editDrafts}
      onEdit={onEdit}
      onEditDraft={onEditDraft}
      onRemove={onRemove}
      wrapLines={wrapLines}
      loadDiffFiles={loadDiffFiles}
      composer={composer}
      onSelect={onSelect}
      keyboardSelection={keyboardSelection}
    />
  );
});

function ImageSidePreview({
  reviewId,
  file,
  side,
}: {
  reviewId: string;
  file: File;
  side: "old" | "new";
}) {
  const rpc = useRpc<typeof rpcContract>();
  const info = file.imageSides[side];
  const [asset, setAsset] = useState<{
    contentBase64: string;
    mimeType: string;
  } | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (!info) return;
    rpc
      .call("reviewImageAsset", { reviewId, filePath: file.path, side })
      .then((result) => {
        if (cancelled) return;
        if (result.asset && result.asset.sha256 === info.sha256)
          setAsset({
            contentBase64: result.asset.contentBase64,
            mimeType: result.asset.mimeType,
          });
        else setUnavailable(true);
      })
      .catch(() => {
        if (!cancelled) setUnavailable(true);
      });
    return () => {
      cancelled = true;
    };
  }, [file.path, info?.sha256, reviewId, rpc, side]);

  return (
    <section
      className="min-w-0 rounded-lg border bg-background p-3"
      aria-label={`${side === "old" ? "Old" : "New"} image preview`}
    >
      <h3 className="mb-2 text-xs font-semibold">
        {side === "old" ? "Old" : "New"}
        {info ? ` · ${info.path}` : ""}
      </h3>
      {info && asset && !broken ? (
        <img
          src={`data:${asset.mimeType};base64,${asset.contentBase64}`}
          alt={`${side === "old" ? "Old" : "New"} snapshot of ${info.path}`}
          className="mx-auto max-h-[70vh] max-w-full object-contain"
          onError={() => setBroken(true)}
        />
      ) : (
        <p
          role="status"
          className="rounded border border-dashed p-6 text-center text-xs text-muted-foreground"
        >
          {!info
            ? "No captured safe raster preview is available for this side."
            : unavailable
              ? "Stored image preview is unavailable or corrupt."
              : broken
                ? "Image could not be decoded."
                : "Loading immutable image preview…"}
        </p>
      )}
      {info ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          {info.width} × {info.height} · {(info.sizeBytes / 1024).toFixed(1)}{" "}
          KiB
        </p>
      ) : null}
    </section>
  );
}

function BinaryImagePreview({
  file,
  reviewId,
}: {
  file: File;
  reviewId: string;
}) {
  const status = normalizeChangeKind(file.status);
  const sides: Array<"old" | "new"> =
    status === "added"
      ? ["new"]
      : status === "deleted"
        ? ["old"]
        : ["old", "new"];
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Binary changes have file-level feedback only. Image bytes are stored
        with this revision.
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {sides.map((side) => (
          <ImageSidePreview
            key={side}
            reviewId={reviewId}
            file={file}
            side={side}
          />
        ))}
      </div>
    </div>
  );
}

function TourCardView({ card }: { card: ReviewTourCard }) {
  if (card.kind === "before-after")
    return (
      <div className="grid gap-2 text-xs">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Agent-authored before / after
        </p>
        <pre className="overflow-auto rounded bg-muted p-2">{card.before}</pre>
        <pre className="overflow-auto rounded bg-muted p-2">{card.after}</pre>
        <p>{card.note}</p>
      </div>
    );
  if (card.kind === "call-graph")
    return (
      <div className="space-y-2 text-xs">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Agent-authored call graph · not runtime-verified
        </p>
        <p className="font-mono">{card.symbol}</p>
        {[
          ...card.callers.map((item) => ({ ...item, relation: "Caller" })),
          ...card.callees.map((item) => ({ ...item, relation: "Callee" })),
        ].map((item, index) => (
          <p key={`${item.relation}-${index}`}>
            <span className="font-semibold">
              {item.relation}: {item.label}
            </span>
            <br />
            <span className="text-muted-foreground">{item.detail}</span>
          </p>
        ))}
      </div>
    );
  return (
    <div className="space-y-2 text-xs">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Agent-authored impact notes · verify independently
      </p>
      {card.tests.map((test, index) => (
        <p
          key={`${test.label}-${index}`}
          className="flex justify-between gap-2"
        >
          <span>{test.label}</span>
          <span
            className={
              test.status === "missing"
                ? "text-destructive"
                : "text-muted-foreground"
            }
          >
            {test.status}
          </span>
        </p>
      ))}
      {card.modules.map((module, index) => (
        <p key={`${module.label}-${index}`}>
          <span className="font-semibold">{module.label}</span>
          <br />
          <span className="text-muted-foreground">{module.detail}</span>
        </p>
      ))}
    </div>
  );
}

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
      <article className="rounded-lg border bg-background p-3 text-xs opacity-65">
        <div className="flex items-start gap-2">
          <button
            type="button"
            aria-label={`Show ${annotationLabel(annotation)}`}
            aria-expanded={false}
            className="min-w-0 flex-1 text-left"
            onClick={() => setCollapsed(false)}
          >
            <span className="font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
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
      className={`group rounded-lg border bg-background p-3 font-sans text-xs ${annotation.sentAt || annotation.resolvedAt ? "opacity-65" : ""}`}
    >
      <div className="flex gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
            {annotationLabel(annotation)}
          </p>
          <div className="mt-1 flex flex-wrap items-center justify-between gap-1">
            <AnnotationMeta annotation={annotation} />
            {locate}
          </div>
          <p className="mt-2 whitespace-pre-wrap leading-relaxed [overflow-wrap:anywhere]">
            {annotation.body}
          </p>
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
          <div className="mt-2 flex flex-wrap items-center gap-1">
            {annotation.resolvedAt ? null : (
              <Button
                size="sm"
                variant="ghost"
                className="-ml-2 h-7 px-2 text-muted-foreground"
                onClick={() => onResolve(annotation)}
              >
                Resolve
              </Button>
            )}
            {hideReplyButton || replying || editing ? null : (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2"
                onClick={() => onReplyDraft(annotation.id, "")}
              >
                Reply
              </Button>
            )}
            {annotation.resolvedAt ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-muted-foreground"
                onClick={() => setCollapsed(true)}
              >
                Collapse
              </Button>
            ) : null}
            {onEdit ? (
              <div className="ml-auto">
                <CommentActions
                  annotation={annotation}
                  hasReplies={hasReplies}
                  editing={editing}
                  onEdit={() => onEditDraft(annotation.id, annotation.body)}
                  onDelete={onRemove}
                />
              </div>
            ) : null}
          </div>
          {replying ? (
            <ReplyBox
              parent={annotation}
              onReply={onReply}
              draft={replyDrafts.get(annotation.id) ?? ""}
              onDraft={(value) => onReplyDraft(annotation.id, value)}
              onCancel={() => onReplyDraft(annotation.id, null)}
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

// All comment entry points share focus, keyboard submission, and failure
// handling. A failed save keeps the draft and its error beside the editor.
function CommentEditor({
  fieldLabel,
  placeholder,
  draft,
  onDraft,
  onSubmit,
  onCancel,
  submitLabel,
  busyLabel,
  heading,
  anchorLabel,
  disabled = false,
}: {
  fieldLabel: string;
  placeholder: string;
  draft: string;
  onDraft: (value: string) => void;
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
  submitLabel: string;
  busyLabel: string;
  heading?: string;
  anchorLabel?: string;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const submittingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const active = document.activeElement;
    returnFocusRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
    textareaRef.current?.focus();
  }, []);
  function close() {
    onCancel();
    if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
  }
  function submit() {
    if (submittingRef.current || busy || disabled || !draft.trim()) return;
    submittingRef.current = true;
    setBusy(true);
    setError(null);
    void onSubmit(draft)
      .then(close)
      .catch((cause) =>
        setError(
          cause instanceof Error
            ? cause.message
            : "Unable to save comment. Try again.",
        ),
      )
      .finally(() => {
        submittingRef.current = false;
        setBusy(false);
      });
  }
  return (
    <div className="mt-2 min-w-0 font-sans text-xs text-foreground">
      {heading ? (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Icon
            name="MessageSquare"
            className="size-3.5 text-muted-foreground"
          />
          <span className="font-medium">{heading}</span>
          {anchorLabel ? (
            <span className="text-[11px] text-muted-foreground">
              {anchorLabel}
            </span>
          ) : null}
          <span className="ml-auto text-[11px] text-muted-foreground">
            Not sent until you send review feedback
          </span>
        </div>
      ) : null}
      <div className="overflow-hidden rounded-lg border border-border bg-background focus-within:border-ring/50">
        <textarea
          ref={textareaRef}
          aria-label={fieldLabel}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          maxLength={1000}
          rows={3}
          value={draft}
          readOnly={busy || disabled}
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape" && !busy && !disabled) {
              event.preventDefault();
              close();
              return;
            }
            if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey))
              return;
            event.preventDefault();
            submit();
          }}
          placeholder={placeholder}
          className={`block min-h-24 w-full resize-y border-0 bg-transparent px-3 py-2.5 text-xs leading-relaxed ${COARSE_POINTER_TEXT_BASE_CLASS} placeholder:text-muted-foreground focus-visible:outline-none read-only:opacity-60`}
        />
        {error ? (
          <p
            id={errorId}
            role="alert"
            className="px-3 pb-2 text-xs text-destructive [overflow-wrap:anywhere]"
          >
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/30 px-3 py-2">
          <span className="text-[11px] text-muted-foreground">
            {submitShortcutLabel()} to submit
          </span>
          <div className="ml-auto flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={close}
              disabled={busy || disabled}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={busy || disabled || !draft.trim()}
              onClick={submit}
            >
              {busy ? busyLabel : submitLabel}
            </Button>
          </div>
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
    "inline-flex size-7 min-h-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 group-focus-within:opacity-100 max-md:opacity-100";
  return (
    <div className="inline-flex items-center gap-0.5">
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
  const [showDone, setShowDone] = useState(false);
  if (!annotations.length)
    return (
      <div className="rounded-lg border border-dashed px-4 py-8 text-center">
        <Icon
          name="MessageSquare"
          className="mx-auto mb-2 size-5 text-muted-foreground"
        />
        <p className="text-sm font-medium">No comments yet</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Select lines in the diff or comment on a whole file. Your feedback
          will appear here before you send it.
        </p>
      </div>
    );
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
  annotations,
  busy,
  composerOpen,
  composerBody,
  onComposerBody,
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
  annotations: Annotation[];
  busy: boolean;
  composerOpen: boolean;
  composerBody: string;
  onComposerBody: (value: string) => void;
  onCloseComposer: () => void;
  onAdd: () => Promise<void>;
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
  const compactEmpty = roots.length === 0 && !composerOpen;
  const repliesByRoot = new Map<string, Annotation[]>();
  for (const annotation of annotations) {
    if (!annotation.parentId) continue;
    const list = repliesByRoot.get(annotation.parentId) ?? [];
    list.push(annotation);
    repliesByRoot.set(annotation.parentId, list);
  }
  if (compactEmpty) return null;
  return (
    <div className="mb-3 rounded-lg border bg-card px-3 py-2 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <p
          className={`flex items-center gap-2 text-xs font-medium ${compactEmpty ? "sr-only lg:not-sr-only" : ""}`}
        >
          <Icon
            name="MessageSquare"
            className="size-3.5 text-muted-foreground"
          />
          File comments
          {roots.length ? (
            <span className="text-[11px] text-muted-foreground">
              {roots.length}
            </span>
          ) : null}
        </p>
      </div>
      {composerOpen ? (
        <CommentEditor
          fieldLabel="File comment"
          heading="New comment"
          anchorLabel="Whole file"
          placeholder="What should the agent change or check? Markdown supported."
          draft={composerBody}
          onDraft={onComposerBody}
          onSubmit={onAdd}
          onCancel={onCloseComposer}
          submitLabel="Add comment"
          busyLabel="Adding..."
          disabled={busy}
        />
      ) : null}
      {roots.length ? (
        <div className="mt-3 space-y-2">
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
  onAdd: () => Promise<void>;
  onCancel: () => void;
}) {
  return (
    <div
      className="border-l-2 border-l-primary/40 bg-card px-3 py-2"
      title={file?.path}
    >
      <CommentEditor
        fieldLabel="Comment"
        heading="New comment"
        anchorLabel={`${selection.side === "new" ? "New" : "Old"} ${selection.endLine === selection.startLine ? "line" : "lines"} ${selection.startLine}${selection.endLine === selection.startLine ? "" : `-${selection.endLine}`}`}
        placeholder="What should the agent change or check? Markdown supported."
        draft={body}
        onDraft={onBody}
        onSubmit={onAdd}
        onCancel={onCancel}
        submitLabel="Add comment"
        busyLabel="Adding..."
        disabled={busy}
      />
    </div>
  );
}

function ReviewSummary({
  review,
  busy,
  error,
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
  error: string | null;
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
  const hasNotes = Boolean(summaryDraft.trim());
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-start justify-between gap-3 border-b pb-3">
        <div>
          <Dialog.Title className="text-base font-semibold">
            Review feedback
          </Dialog.Title>
          <p className="mt-1 text-xs text-muted-foreground">
            {pending.length
              ? `${pending.length} pending comment${pending.length === 1 ? "" : "s"} across ${new Set(pending.map((item) => item.filePath)).size} file${new Set(pending.map((item) => item.filePath)).size === 1 ? "" : "s"}`
              : hasNotes
                ? "Your review note is ready to send."
                : "No comments waiting to be sent."}
          </p>
        </div>
        {onClose ? (
          <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
            Done
          </Button>
        ) : null}
      </div>
      <div className="mt-3 shrink-0">
        {noteOpen ? (
          <>
            <label
              className="text-xs font-medium"
              htmlFor="review-overall-summary"
            >
              Review note
            </label>
            <textarea
              id="review-overall-summary"
              maxLength={2000}
              value={summaryDraft}
              onChange={(event) => onSummaryDraftChange(event.target.value)}
              disabled={busy}
              onBlur={() => {
                if (summaryDraft.trim() !== (review.summary ?? ""))
                  void onSaveSummary(summaryDraft).catch(() => undefined);
              }}
              placeholder="Optional context for the agent, included with your comments."
              className={`mt-2 block min-h-16 w-full rounded-lg border border-border bg-background px-3 py-2.5 text-xs leading-relaxed ${COARSE_POINTER_TEXT_BASE_CLASS} focus-visible:outline-none focus-visible:border-ring/50 disabled:opacity-60`}
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
      <div className="mt-3 min-h-0 flex-1 overflow-auto pb-1">
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
      <div className="mt-3 shrink-0 border-t pt-3">
        {error ? (
          <p
            role="alert"
            className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive [overflow-wrap:anywhere]"
          >
            {error}
          </p>
        ) : null}
        <Button
          className="w-full"
          onClick={() => onSend(pending.map((item) => item.id))}
          disabled={busy || (!pending.length && !hasNotes)}
        >
          <Icon name="Sent" className="size-3.5" />
          {busy
            ? "Sending..."
            : pending.length
              ? `Send ${pending.length} comment${pending.length === 1 ? "" : "s"} to agent`
              : hasNotes
                ? "Send review note to agent"
                : "Send comments to agent"}
        </Button>
        <p className="mt-2 text-center text-[11px] leading-relaxed text-muted-foreground">
          {pending.length
            ? `All unsent, unresolved comments${hasNotes ? " and your review note" : ""} go in one batch. You'll return to the thread.`
            : hasNotes
              ? "Sends your review note and returns to the thread."
              : "Add a comment or review note to get started."}
        </p>
      </div>
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
  const pluginId = experimental_usePluginId();
  // Full-screen mode: the panel spans the whole viewport (the BB tab it
  // normally lives in is only a slice of the page).
  const [fullscreen, setFullscreen] = useState(false);
  const navigate = useBbNavigate();
  const [review, setReview] = useState<Review | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [readingMode, setReadingMode] = useState<"files" | "tour">("files");
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(new Set());
  // Bumped when a lazy surface mounts, so keyboard scrolling can retry.
  const [mountedTick, setMountedTick] = useState(0);
  const surfaceRefs = useRef(new Map<string, HTMLElement>());
  const [activeSurface, setActiveSurface] = useState<string | null>(null);
  const [selectionSurface, setSelectionSurface] = useState<string | null>(null);
  const [fileCommentPath, setFileCommentPath] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [reviewScope, setReviewScope] = useState<"all" | "since-viewed">("all");
  const [revisionDelta, setRevisionDelta] = useState<RevisionDelta | null>(
    null,
  );
  const [selection, setSelection] = useState<Selection | null>(null);
  const [selectionPath, setSelectionPath] = useState<string | null>(null);
  const [draftNotice, setDraftNotice] = useState<string | null>(null);
  const [activeTourStepId, setActiveTourStepId] = useState<string | null>(null);
  const [deferredPatches, setDeferredPatches] = useState<Map<string, string>>(
    new Map(),
  );
  const [deferredLoading, setDeferredLoading] = useState(false);
  const [deferredError, setDeferredError] = useState<string | null>(null);
  const [keyboardCursor, setKeyboardCursor] = useState<{
    path: string;
    side: "old" | "new";
    line: number;
  } | null>(null);
  const [keyboardRangeStart, setKeyboardRangeStart] = useState<{
    path: string;
    side: "old" | "new";
    line: number;
  } | null>(null);
  const [keyboardRangeValue, setKeyboardRangeValue] =
    useState<Selection | null>(null);
  const [keyboardHelpOpen, setKeyboardHelpOpen] = useState(false);
  const [rangeSide, setRangeSide] = useState<"old" | "new">("new");
  const [rangeStartInput, setRangeStartInput] = useState("");
  const [rangeEndInput, setRangeEndInput] = useState("");
  const [rangeInputError, setRangeInputError] = useState<string | null>(null);
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
  const mobileMoreRef = useRef<HTMLDetailsElement | null>(null);
  const [mobilePanel, setMobilePanel] = useState<"compose" | null>(null);
  const [fileQuery, setFileQuery] = useState("");
  const [fileFilterMode, setFileFilterMode] = useState<FileFilterMode>("all");
  const [wrapLines, setWrapLines] = useState(false);
  const [busy, setBusy] = useState(false);
  const sendingRef = useRef(false);
  const summarySaveRef = useRef<Promise<void>>(Promise.resolve());
  const savedSummaryRef = useRef<{
    reviewId: string;
    text: string | null;
  } | null>(null);
  // Comment locate flow: a pending locate survives the file switch and
  // resolves after the diff re-renders.
  const [pendingLocate, setPendingLocate] = useState<{
    id: string;
    fileLevel: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [targetKind, setTargetKind] = useState<
    "uncommitted" | "commit" | "branch" | "all"
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
  const fileScrollFrameRef = useRef<number | null>(null);

  function buildRefreshTarget(): ReviewTarget | undefined {
    if (targetKind === "commit" && targetValue.trim())
      return { type: "commit", sha: targetValue.trim() };
    if (targetKind === "branch" && targetValue.trim())
      return { type: "branch_committed", mergeBaseBranch: targetValue.trim() };
    if (targetKind === "all" && targetValue.trim())
      return { type: "all", mergeBaseBranch: targetValue.trim() };
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
      if (next) {
        setTargetKind(
          next.target.type === "branch_committed" ? "branch" : next.target.type,
        );
        setTargetValue(
          next.target.type === "commit"
            ? next.target.sha
            : next.target.type === "uncommitted"
              ? ""
              : next.target.mergeBaseBranch,
        );
      }
      savedSummaryRef.current = next
        ? { reviewId: next.id, text: next.summary }
        : null;
      setSummaryDraft(next?.summary ?? "");
      setNoteOpen(Boolean(next?.summary?.trim()));
      setReplyDrafts(new Map());
      setFeedbackOpen(false);
      setRevisions(history.revisions as Revision[]);
      setSelection(null);
      setSelectionPath(null);
      setSelectionSurface(null);
      setActiveSurface(null);
      setCollapsedPaths(new Set());
      setFileComposerOpen(false);
      setFileCommentPath(null);
      setFileCommentBody("");
      setKeyboardCursor(null);
      setKeyboardRangeStart(null);
      setKeyboardRangeValue(null);
      setBody("");
      setDraftNotice(null);
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
  useEffect(() => {
    if (!review) {
      setRevisionDelta(null);
      return;
    }
    let cancelled = false;
    rpc
      .call("revisionDelta", { reviewId: review.id })
      .then((result) => {
        if (!cancelled) setRevisionDelta(result as RevisionDelta);
      })
      .catch(() => {
        if (!cancelled) setRevisionDelta(null);
      });
    return () => {
      cancelled = true;
    };
  }, [review?.id, review?.viewedPaths, rpc]);
  const scopedFiles = useMemo(() => {
    const files = review?.files ?? [];
    if (reviewScope === "all" || !revisionDelta) return files;
    const paths = new Set([
      ...revisionDelta.changedPaths,
      ...revisionDelta.unknownPaths,
    ]);
    return files.filter((candidate) => paths.has(candidate.path));
  }, [review?.files, reviewScope, revisionDelta]);
  const visibleFiles = useMemo(
    () =>
      filterChangedFiles(scopedFiles, fileQuery, {
        mode: fileFilterMode,
        viewedPaths,
        openThreadCounts,
      }),
    [fileFilterMode, fileQuery, openThreadCounts, scopedFiles, viewedPaths],
  );
  useEffect(() => {
    if (scopedFiles.some((candidate) => candidate.path === filePath)) return;
    setFilePath(scopedFiles[0]?.path ?? null);
  }, [filePath, scopedFiles]);
  const file =
    review?.files.find((candidate) => candidate.path === filePath) ?? null;
  const patchCacheKey = review && file ? `${review.id}\\0${file.path}` : "";
  const currentPatch = file
    ? (deferredPatches.get(patchCacheKey) ?? file.patch)
    : "";
  const preparedDiffs = useMemo(() => {
    const prepared = new Map<
      string,
      {
        patch: string;
        oldLines: number[];
        newLines: number[];
        loader?: FileDiffContentsLoader;
      }
    >();
    if (!review) return prepared;
    const prepare = (
      candidate: File,
      key: string,
      anchor?: ReviewTourAnchor,
    ) => {
      const stored =
        deferredPatches.get(`${review.id}\\0${candidate.path}`) ??
        candidate.patch;
      const patch = anchor ? (excerptPatch(stored, anchor) ?? "") : stored;
      const loader: FileDiffContentsLoader | undefined =
        !anchor &&
        !candidate.binary &&
        !candidate.truncated &&
        !["added", "deleted"].includes(normalizeChangeKind(candidate.status))
          ? async () => {
              const result = await rpc.call("reviewFileContents", {
                reviewId: review.id,
                filePath: candidate.path,
              });
              if (!result.old || !result.new)
                throw new Error(
                  "Full file contents are not available for this snapshot.",
                );
              return {
                oldFile: {
                  name: result.old.path,
                  contents: result.old.content,
                  cacheKey: `${review.id}:old:${candidate.path}`,
                },
                newFile: {
                  name: result.new.path,
                  contents: result.new.content,
                  cacheKey: `${review.id}:new:${candidate.path}`,
                },
              };
            }
          : undefined;
      prepared.set(key, {
        patch,
        oldLines: patchSourceLines(patch, "old"),
        newLines: patchSourceLines(patch, "new"),
        loader,
      });
    };
    review.files.forEach((candidate) =>
      prepare(candidate, `file:${candidate.path}`),
    );
    const step =
      review.tour?.steps.find((step) => step.id === activeTourStepId) ??
      review.tour?.steps[0];
    step?.blocks.forEach((block, index) => {
      if (block.kind !== "diff" || !block.anchor.valid) return;
      const candidate = review.files.find(
        (file) => file.path === block.anchor.filePath,
      );
      if (candidate)
        prepare(candidate, `tour:${step.id}:${index}`, block.anchor);
    });
    return prepared;
  }, [
    review?.id,
    review?.files,
    review?.tour,
    activeTourStepId,
    deferredPatches,
    rpc,
  ]);

  // Per-surface annotation arrays are rebuilt only when something that can
  // change an anchor changes (not while typing a draft), so the memoized diff
  // keeps its identity and off-screen or unrelated files do not re-render.
  const surfaceAnnotations = useMemo(() => {
    const map = new Map<string, DiffLineAnnotation<DiffAnnotation>[]>();
    if (!review) return map;
    const build = (
      candidate: File,
      key: string,
      prepared?: { patch: string; oldLines: number[]; newLines: number[] },
    ) => {
      const list: DiffLineAnnotation<DiffAnnotation>[] = review.annotations
        .filter(
          (annotation) =>
            annotation.filePath === candidate.path && !annotation.fileLevel,
        )
        .flatMap((annotation) => {
          const lines =
            annotation.side === "old" ? prepared?.oldLines : prepared?.newLines;
          const visible = (lines ?? []).find(
            (line) =>
              line >= annotation.startLine && line <= annotation.endLine,
          );
          return visible === undefined
            ? []
            : [
                {
                  side:
                    annotation.side === "old"
                      ? ("deletions" as const)
                      : ("additions" as const),
                  lineNumber: visible,
                  metadata: annotation,
                },
              ];
        });
      if (
        activeSurface === key &&
        keyboardCursor?.path === candidate.path &&
        isVisiblePatchRange(
          prepared?.patch ?? "",
          keyboardCursor.side,
          keyboardCursor.line,
          keyboardCursor.line,
        )
      )
        list.push({
          side: keyboardCursor.side === "old" ? "deletions" : "additions",
          lineNumber: keyboardCursor.line,
          metadata: { keyboardMarker: true },
        });
      if (
        selection &&
        selectionPath === candidate.path &&
        selectionSurface === key
      )
        list.push({
          side: selection.side === "old" ? "deletions" : "additions",
          lineNumber: selection.endLine,
          metadata: { composer: true, selection },
        });
      map.set(key, list);
    };
    review.files.forEach((candidate) =>
      build(
        candidate,
        `file:${candidate.path}`,
        preparedDiffs.get(`file:${candidate.path}`),
      ),
    );
    const step =
      review.tour?.steps.find((step) => step.id === activeTourStepId) ??
      review.tour?.steps[0];
    step?.blocks.forEach((block, index) => {
      if (block.kind !== "diff" || !block.anchor.valid) return;
      const key = `tour:${step.id}:${index}`;
      const candidate = review.files.find(
        (file) => file.path === block.anchor.filePath,
      );
      if (candidate) build(candidate, key, preparedDiffs.get(key));
    });
    return map;
  }, [
    activeSurface,
    activeTourStepId,
    keyboardCursor,
    preparedDiffs,
    review,
    selection,
    selectionPath,
    selectionSurface,
  ]);

  // Stable per-surface selection handlers keep the diff memo intact.
  const selectionHandlerRef = useRef<
    (range: SelectedLineRange | null, path: string, surface: string) => void
  >(() => {});
  const selectionHandlers = useRef(
    new Map<string, (range: SelectedLineRange | null) => void>(),
  );
  const surfaceSelectHandler = (path: string, surfaceKey: string) => {
    const existing = selectionHandlers.current.get(surfaceKey);
    if (existing) return existing;
    const handler = (range: SelectedLineRange | null) =>
      selectionHandlerRef.current(range, path, surfaceKey);
    selectionHandlers.current.set(surfaceKey, handler);
    return handler;
  };

  const currentIndex = file
    ? (visibleFiles.findIndex((candidate) => candidate.path === file.path) ??
        0) + 1
    : 0;
  const keyboardSelection = useMemo<SelectedLineRange | null>(() => {
    if (selection && selectionPath === file?.path)
      return {
        start: selection.startLine,
        end: selection.endLine,
        side: selection.side === "old" ? "deletions" : "additions",
        endSide: selection.side === "old" ? "deletions" : "additions",
      };
    if (keyboardRangeStart?.path === file?.path && keyboardRangeValue)
      return {
        start: keyboardRangeValue.startLine,
        end: keyboardRangeValue.endLine,
        side: keyboardRangeValue.side === "old" ? "deletions" : "additions",
        endSide: keyboardRangeValue.side === "old" ? "deletions" : "additions",
      };
    if (keyboardCursor && keyboardCursor.path === file?.path)
      return {
        start: keyboardCursor.line,
        end: keyboardCursor.line,
        side: keyboardCursor.side === "old" ? "deletions" : "additions",
        endSide: keyboardCursor.side === "old" ? "deletions" : "additions",
      };
    return null;
  }, [
    file?.path,
    keyboardCursor,
    keyboardRangeStart,
    keyboardRangeValue,
    selection,
    selectionPath,
  ]);
  const pendingCount =
    review?.annotations.filter(
      (annotation) =>
        annotation.sentAt === null &&
        annotation.resolvedAt === null &&
        annotation.author !== "agent",
    ).length ?? 0;
  const isViewed = Boolean(file && review?.viewedPaths.includes(file.path));

  const loadDeferredDiff = useCallback(
    async (path: string) => {
      if (!review) return;
      const key = `${review.id}\\0${path}`;
      const candidate = review.files.find((item) => item.path === path);
      if (!candidate?.deferredReason || deferredPatches.has(key)) return;
      setDeferredLoading(true);
      setDeferredError(null);
      try {
        const result = await rpc.call("reviewFileDiff", {
          reviewId: review.id,
          filePath: path,
        });
        setDeferredPatches((current) =>
          new Map(current).set(key, result.patch),
        );
      } catch (cause) {
        setDeferredError(
          cause instanceof Error ? cause.message : "Unable to load this diff.",
        );
      } finally {
        setDeferredLoading(false);
      }
    },
    [deferredPatches, review, rpc],
  );
  const chooseFile = useCallback(
    (path: string) => {
      setFilePath(path);
      if (!body.trim()) {
        setSelection(null);
        setSelectionPath(null);
        setKeyboardRangeStart(null);
        setKeyboardRangeValue(null);
        setDraftNotice(null);
      } else if (selection && selectionPath && selectionPath !== path) {
        setDraftNotice(
          `Draft remains anchored to ${selectionPath}. Return to that file or discard the draft before choosing a different range.`,
        );
      }
      setMobilePanel(null);
      // File-level drafts remain visible on their original file in the document.
      setCollapsedPaths((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
      setReadingMode("files");
      if (body.trim() && selectionPath)
        setSelectionSurface(`file:${selectionPath}`);
      setActiveSurface(`file:${path}`);
      requestAnimationFrame(() => {
        const container = scrollSectionRef.current;
        const surface = surfaceRefs.current.get(`file:${path}`);
        if (container && surface) {
          const stickyBar = container.querySelector<HTMLElement>(".sticky");
          const containerTop = container.getBoundingClientRect().top;
          const surfaceTop = surface.getBoundingClientRect().top;
          const targetTop =
            container.scrollTop +
            surfaceTop -
            containerTop -
            (stickyBar?.offsetHeight ?? 0);
          if (typeof container.scrollTo === "function")
            container.scrollTo({ top: targetTop, behavior: "auto" });
          else container.scrollTop = targetTop;
        }
        surface?.focus({ preventScroll: true });
      });
    },
    [body, selection, selectionPath],
  );
  const tourScopePaths = useMemo(
    () =>
      reviewScope === "all" || !revisionDelta
        ? null
        : new Set([
            ...(revisionDelta?.changedPaths ?? []),
            ...(revisionDelta?.unknownPaths ?? []),
          ]),
    [reviewScope, revisionDelta],
  );
  const fileDraftVisible =
    readingMode === "files"
      ? scopedFiles.some((file) => file.path === fileCommentPath) &&
        !collapsedPaths.has(fileCommentPath ?? "")
      : (
          review?.tour?.steps.find((step) => step.id === activeTourStepId) ??
          review?.tour?.steps[0]
        )?.anchors.some(
          (anchor) =>
            anchor.valid &&
            anchor.filePath === fileCommentPath &&
            (!tourScopePaths || tourScopePaths.has(anchor.filePath)),
        );
  useEffect(() => {
    setActiveTourStepId(review?.tour?.steps[0]?.id ?? null);
  }, [review?.id]);
  useEffect(() => {
    const steps = review?.tour?.steps ?? [];
    const step = steps.find((candidate) => candidate.id === activeTourStepId);
    if (step) return;
    setActiveTourStepId(steps[0]?.id ?? null);
  }, [activeTourStepId, review?.tour]);
  const handleDiffSelection = useCallback(
    (
      range: SelectedLineRange | null,
      path = file?.path ?? null,
      surface = activeSurface,
    ) => {
      const next = range ? rangeToAnchor(range) : null;
      if (
        next &&
        body.trim() &&
        selection &&
        (selectionPath !== path ||
          JSON.stringify(next) !== JSON.stringify(selection))
      ) {
        setDraftNotice(
          `Draft remains anchored to ${selectionPath ?? "its original file"}. Save or discard it before selecting another range.`,
        );
        return;
      }
      setSelection(next);
      setSelectionPath(next ? path : null);
      setSelectionSurface(surface);
      setActiveSurface(surface);
      if (path) setFilePath(path);
      if (next) {
        setKeyboardRangeStart(null);
        setKeyboardRangeValue(null);
      }
      setDraftNotice(null);
      setMobilePanel(next ? "compose" : null);
    },
    [activeSurface, body, file?.path, selection, selectionPath],
  );
  // The stable per-surface handlers read the latest selection logic through a
  // ref, so the memoized diffs keep their props between renders.
  useEffect(() => {
    selectionHandlerRef.current = (
      range: SelectedLineRange | null,
      path: string,
      surface: string,
    ) => handleDiffSelection(range, path, surface);
  });
  function selectExactRange() {
    if (!file || !currentPatch) return;
    const startLine = Number(rangeStartInput);
    const endLine = Number(rangeEndInput || rangeStartInput);
    if (!isVisiblePatchRange(currentPatch, rangeSide, startLine, endLine)) {
      setRangeInputError(
        `That ${rangeSide}-side range is not fully visible in this immutable patch.`,
      );
      return;
    }
    if (
      body.trim() &&
      selection &&
      (selectionPath !== file.path ||
        selection.side !== rangeSide ||
        selection.startLine !== startLine ||
        selection.endLine !== endLine)
    ) {
      setRangeInputError(
        `Save or discard the draft anchored to ${selectionPath ?? "another file"} first.`,
      );
      return;
    }
    setSelection({ side: rangeSide, startLine, endLine });
    setSelectionPath(file.path);
    setSelectionSurface(activeSurface ?? `file:${file.path}`);
    setKeyboardRangeStart(null);
    setKeyboardRangeValue(null);
    setKeyboardCursor({ path: file.path, side: rangeSide, line: startLine });
    setRangeInputError(null);
    setDraftNotice(null);
    setMobilePanel("compose");
  }
  const handleDiffKeyDown = useCallback(
    (
      event: React.KeyboardEvent<HTMLElement>,
      candidate = file,
      patch = currentPatch,
      surface = activeSurface,
    ) => {
      const file = candidate;
      const currentPatch = patch;
      if (
        event.target !== event.currentTarget ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.nativeEvent.isComposing ||
        !file ||
        file.binary ||
        !currentPatch
      )
        return;
      setFilePath(file.path);
      setActiveSurface(surface);
      const key = event.key;
      if (
        readingMode === "files" &&
        collapsedPaths.has(file.path) &&
        ![",", ".", "m", "?"].includes(key)
      ) {
        if (["j", "k", "h", "l", "V", "c", "[", "]"].includes(key))
          setDraftNotice("Expand this file before navigating its code.");
        return;
      }
      const side =
        keyboardCursor?.path === file.path ? keyboardCursor.side : "new";
      const lines = patchSourceLines(currentPatch, side);
      const cursorLine =
        keyboardCursor?.path === file.path && keyboardCursor.side === side
          ? keyboardCursor.line
          : null;
      const moveCursor = (nextSide: "old" | "new", line: number) => {
        setKeyboardCursor({ path: file.path, side: nextSide, line });
        if (
          keyboardRangeStart?.path === file.path &&
          keyboardRangeStart.side === nextSide
        ) {
          setKeyboardRangeValue({
            side: nextSide,
            startLine: Math.min(keyboardRangeStart.line, line),
            endLine: Math.max(keyboardRangeStart.line, line),
          });
        }
      };
      if (key === "j" || key === "k") {
        event.preventDefault();
        const index =
          cursorLine === null
            ? key === "j"
              ? -1
              : lines.length
            : lines.indexOf(cursorLine);
        const next = lines[index + (key === "j" ? 1 : -1)];
        if (next === undefined)
          setDraftNotice("End of visible lines on this side.");
        else {
          setDraftNotice(null);
          moveCursor(side, next);
        }
      } else if (key === "h" || key === "l") {
        event.preventDefault();
        if (keyboardRangeStart) {
          setDraftNotice(
            "Finish or clear the current range before changing sides.",
          );
          return;
        }
        const nextSide = key === "h" ? "old" : "new";
        const candidates = patchSourceLines(currentPatch, nextSide);
        if (!candidates.length) {
          setDraftNotice(`No visible ${nextSide}-side lines in this diff.`);
          return;
        }
        const target = candidates.reduce(
          (best, line) =>
            Math.abs(line - (cursorLine ?? line)) <
            Math.abs(best - (cursorLine ?? best))
              ? line
              : best,
          candidates[0]!,
        );
        moveCursor(nextSide, target);
        setDraftNotice(`Cursor on ${nextSide} side, line ${target}.`);
      } else if (key === "V") {
        event.preventDefault();
        const line = cursorLine ?? lines[0];
        if (line === undefined) {
          setDraftNotice("No visible source lines to select.");
          return;
        }
        if (body.trim() && selection) {
          setDraftNotice(
            `Draft remains anchored to ${selectionPath ?? file.path}. Save or discard it first.`,
          );
          return;
        }
        const anchor = { path: file.path, side, line };
        setKeyboardRangeStart(anchor);
        setKeyboardRangeValue({ side, startLine: line, endLine: line });
        setKeyboardCursor(anchor);
        setDraftNotice(
          `Selecting ${side} lines from ${line}. Use j/k to extend, c to comment, Escape to clear.`,
        );
      } else if (key === "c") {
        const line = cursorLine ?? lines[0];
        const range =
          keyboardRangeStart?.path === file.path && keyboardRangeValue
            ? keyboardRangeValue
            : line === undefined
              ? null
              : { side, startLine: line, endLine: line };
        if (!range) {
          setDraftNotice("No visible source line is selected.");
          return;
        }
        if (
          body.trim() &&
          selection &&
          (selectionPath !== file.path ||
            JSON.stringify(selection) !== JSON.stringify(range))
        ) {
          setDraftNotice(
            `Save or discard the draft on ${selectionPath} first.`,
          );
          return;
        }
        event.preventDefault();
        if (
          !isVisiblePatchRange(
            currentPatch,
            range.side,
            range.startLine,
            range.endLine,
          )
        ) {
          setDraftNotice(
            "That range includes lines outside this excerpt. Open the full file to comment on it.",
          );
          return;
        }
        setSelection(range);
        setSelectionPath(file.path);
        setSelectionSurface(surface);
        setMobilePanel("compose");
      } else if (key === "Escape" && keyboardRangeStart) {
        event.preventDefault();
        setKeyboardRangeStart(null);
        setKeyboardRangeValue(null);
        if (!body.trim()) {
          setSelection(null);
          setSelectionPath(null);
        }
        setDraftNotice("Line selection cleared.");
      } else if (key === "[" || key === "]") {
        event.preventDefault();
        if (keyboardRangeStart) {
          setDraftNotice(
            "Clear the current range before jumping between hunks.",
          );
          return;
        }
        const starts = patchHunkStarts(currentPatch, side);
        if (!starts.length) return;
        const next =
          key === "]"
            ? starts.find((line) => line > (cursorLine ?? 0))
            : [...starts]
                .reverse()
                .find(
                  (line) => line < (cursorLine ?? Number.POSITIVE_INFINITY),
                );
        if (next === undefined) setDraftNotice("No further hunk on this side.");
        else moveCursor(side, next);
      } else if (key === "," || key === ".") {
        event.preventDefault();
        if (keyboardRangeStart) {
          setDraftNotice("Clear the current range before changing files.");
          return;
        }
        const next = adjacentFilePath(
          visibleFiles,
          file.path,
          key === "," ? -1 : 1,
        );
        if (next) chooseFile(next);
      } else if (key === "m") {
        event.preventDefault();
        if (readingMode === "files")
          void markViewed(!viewedPaths.has(file.path), file.path);
      } else if (key === "?") {
        event.preventDefault();
        setKeyboardHelpOpen((open) => !open);
        if (mobileMoreRef.current) mobileMoreRef.current.open = true;
      }
    },
    [
      activeSurface,
      body,
      collapsedPaths,
      chooseFile,
      currentPatch,
      file,
      readingMode,
      viewedPaths,
      keyboardCursor,
      keyboardRangeStart,
      keyboardRangeValue,
      markViewed,
      selection,
      selectionPath,
      visibleFiles,
    ],
  );
  useEffect(() => {
    if (!keyboardCursor || !activeSurface) return;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;
    const scroll = () => {
      const marker = surfaceRefs.current
        .get(activeSurface)
        ?.querySelector("[data-keyboard-cursor]");
      if (marker) marker.scrollIntoView({ block: "nearest" });
      else if (attempts++ < 20) timer = setTimeout(scroll, 25);
    };
    timer = setTimeout(scroll, 0);
    return () => clearTimeout(timer);
  }, [activeSurface, keyboardCursor, mountedTick]);

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
  // Stable identities for the memoized diff. The implementations read the
  // latest state through a ref, so memo does not break on every render.
  const liveCommentHandlers = useRef({
    reply: async (_parent: Annotation, _body: string) => {},
    edit: async (_annotation: Annotation, _body: string) => {},
    remove: async (_id: string) => {},
  });
  const replyAnnotation = useCallback(
    (parent: Annotation, body: string) =>
      liveCommentHandlers.current.reply(parent, body),
    [],
  );
  const editAnnotation = useCallback(
    (annotation: Annotation, body: string) =>
      liveCommentHandlers.current.edit(annotation, body),
    [],
  );
  const removeAnnotationById = useCallback((id: string) => {
    void liveCommentHandlers.current.remove(id);
  }, []);
  const notifyMounted = useCallback(() => {
    setMountedTick((tick) => tick + 1);
  }, []);

  async function markViewed(
    viewed: boolean,
    path = file?.path,
  ): Promise<boolean> {
    if (!review || !path) return false;
    try {
      const result = await rpc.call("markFileViewed", {
        reviewId: review.id,
        filePath: path,
        viewed,
      });
      setReview((current) =>
        current?.id === review.id
          ? {
              ...current,
              viewedPaths: viewed
                ? [...new Set([...current.viewedPaths, path])]
                : current.viewedPaths.filter((candidate) => candidate !== path),
            }
          : current,
      );
      setRevisions((current) =>
        current.map((revision) =>
          revision.id === review.id
            ? { ...revision, viewedCount: result.viewedCount as number }
            : revision,
        ),
      );
      setError(null);
      if (readingMode === "files") {
        setCollapsedPaths((current) => {
          const next = new Set(current);
          if (viewed) next.add(path);
          else next.delete(path);
          return next;
        });
      }
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
      setKeyboardRangeStart(null);
      setKeyboardRangeValue(null);
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
      setReadingMode("files");
      setReviewScope("all");
      chooseFile(annotation.filePath);
      if (annotation.fileLevel) {
        // Whole-file comments have no in-diff anchor; snap to the top bar.
        surfaceRefs.current
          .get(`file:${annotation.filePath}`)
          ?.scrollIntoView({ block: "start" });
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
    if (!review || !fileCommentPath || !fileCommentBody.trim()) return;
    setBusy(true);
    try {
      const result = await rpc.call("addAnnotation", {
        reviewId: review.id,
        filePath: fileCommentPath,
        body: fileCommentBody.trim(),
        fileLevel: true,
      });
      const annotation = result.annotation as Annotation;
      setReview((current) =>
        current?.id === review.id
          ? { ...current, annotations: [...current.annotations, annotation] }
          : current,
      );
      setFileCommentBody("");
      setFileComposerOpen(false);
      requestAnimationFrame(() =>
        surfaceRefs.current
          .get(activeSurface ?? `file:${fileCommentPath}`)
          ?.focus(),
      );
      setError(null);
    } finally {
      setBusy(false);
    }
  }
  async function add() {
    if (!review || !selectionPath || !selection || !body.trim()) return;
    setBusy(true);
    try {
      const result = await rpc.call("addAnnotation", {
        reviewId: review.id,
        filePath: selectionPath,
        ...selection,
        body: body.trim(),
      });
      const annotation = result.annotation as Annotation;
      setReview((current) =>
        current?.id === review.id
          ? { ...current, annotations: [...current.annotations, annotation] }
          : current,
      );
      setBody("");
      setSelection(null);
      setSelectionPath(null);
      setKeyboardRangeStart(null);
      setKeyboardRangeValue(null);
      setDraftNotice(null);
      setMobilePanel(null);
      requestAnimationFrame(() =>
        surfaceRefs.current
          .get(selectionSurface ?? `file:${selectionPath}`)
          ?.focus(),
      );
      setError(null);
    } finally {
      setBusy(false);
    }
  }
  async function reply(parent: Annotation, body: string) {
    if (!review || !body.trim()) return;
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
    setReview((current) =>
      current?.id === review.id
        ? { ...current, annotations: [...current.annotations, annotation] }
        : current,
    );
    setError(null);
  }
  function saveSummary(text: string): Promise<void> {
    if (!review) return Promise.resolve();
    const reviewId = review.id;
    // Blur saves and sending share this queue. An older save must not arrive
    // after the final draft, and sending must wait for that draft to persist.
    const save = summarySaveRef.current
      .catch(() => undefined)
      .then(async () => {
        try {
          const result = await rpc.call("setReviewSummary", {
            reviewId,
            summary: text,
          });
          savedSummaryRef.current = {
            reviewId,
            text: result.summary as string | null,
          };
          setReview((current) =>
            current?.id === reviewId
              ? { ...current, summary: result.summary as string | null }
              : current,
          );
          setError(null);
        } catch (cause) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Unable to save review note.",
          );
          throw cause;
        }
      });
    summarySaveRef.current = save;
    return save;
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
  const hasNotes = Boolean(summaryDraft.trim());
  // Everything unsent, unresolved, and human goes in one batch. There is no
  // selection step: a comment you wrote is already addressed to the agent, and
  // resolving or deleting it is how you take it back out.
  async function send(ids: Iterable<string>) {
    if (!review || sendingRef.current) return;
    const targets = new Set(ids);
    if (targets.size === 0 && !hasNotes) return;
    sendingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await summarySaveRef.current.catch(() => undefined);
      const saved = savedSummaryRef.current;
      if (
        saved?.reviewId !== review.id ||
        summaryDraft.trim() !== (saved.text ?? "")
      )
        await saveSummary(summaryDraft);
      const result = await rpc.call("sendBatch", {
        reviewId: review.id,
        annotationIds: [...targets],
      });
      const sentAt = result.sentAt as number;
      setReview((current) =>
        current
          ? {
              ...current,
              annotations: current.annotations.map((annotation) =>
                targets.has(annotation.id)
                  ? { ...annotation, sentAt }
                  : annotation,
              ),
            }
          : current,
      );
      setMobilePanel(null);
      setError(null);
      navigate.toThread(threadId);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to send feedback.",
      );
    } finally {
      sendingRef.current = false;
      setBusy(false);
    }
  }

  // The stable wrappers above call the latest implementations through this ref.
  useEffect(() => {
    liveCommentHandlers.current = { reply, edit, remove };
  });

  const keyboardShortcutContent = (
    <>
      <p>
        Focus this diff surface, then use j/k for lines, h/l for old/new side, V
        to start a range, c to comment, [/] for hunks, ,/. for files, m to mark
        viewed, and ? for help. Navigation never sends feedback.
      </p>
      {keyboardHelpOpen ? (
        <p className="mt-1">
          Ranges stay on one file and one side. Escape clears a range. Use the
          Exact range controls for direct multiline line numbers. Tab continues
          through native controls and out of this surface.
        </p>
      ) : null}
    </>
  );
  const renderExactRangeControl = (mobile: boolean) => (
    <details className={mobile ? "rounded border p-2" : "relative"}>
      <summary
        className={`cursor-pointer rounded text-[11px] ${mobile ? "font-medium" : "border px-2 py-1"}`}
      >
        Exact range
      </summary>
      <div
        className={
          mobile
            ? "mt-2 border-t pt-2"
            : "absolute right-0 z-30 mt-1 w-64 rounded-md border bg-popover p-3 shadow-lg"
        }
      >
        <label className="block text-xs">
          Side
          <select
            aria-label="Exact range side"
            value={rangeSide}
            onChange={(event) =>
              setRangeSide(event.target.value as "old" | "new")
            }
            className="mt-1 w-full rounded border bg-background p-1"
          >
            <option value="old">Old</option>
            <option value="new">New</option>
          </select>
        </label>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <label className="text-xs">
            Start line
            <input
              aria-label="Exact range start line"
              type="number"
              min="1"
              value={rangeStartInput}
              onChange={(event) => setRangeStartInput(event.target.value)}
              className="mt-1 w-full rounded border bg-background p-1"
            />
          </label>
          <label className="text-xs">
            End line
            <input
              aria-label="Exact range end line"
              type="number"
              min="1"
              value={rangeEndInput}
              onChange={(event) => setRangeEndInput(event.target.value)}
              className="mt-1 w-full rounded border bg-background p-1"
            />
          </label>
        </div>
        {rangeInputError ? (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {rangeInputError}
          </p>
        ) : null}
        <Button className="mt-2 w-full" size="sm" onClick={selectExactRange}>
          Comment on exact range
        </Button>
      </div>
    </details>
  );

  function switchReadingMode(mode: "files" | "tour") {
    setReadingMode(mode);
    if (mode === "files") {
      if (selectionPath && body.trim()) {
        setSelectionSurface(`file:${selectionPath}`);
        setCollapsedPaths((current) => {
          const next = new Set(current);
          next.delete(selectionPath);
          return next;
        });
      }
      if (fileCommentPath && fileCommentBody.trim())
        setCollapsedPaths((current) => {
          const next = new Set(current);
          next.delete(fileCommentPath);
          return next;
        });
    } else if (selectionPath && selection && body.trim()) {
      const step =
        review?.tour?.steps.find((step) => step.id === activeTourStepId) ??
        review?.tour?.steps[0];
      const index = step?.blocks.findIndex(
        (block, index) =>
          block.kind === "diff" &&
          block.anchor.filePath === selectionPath &&
          isVisiblePatchRange(
            preparedDiffs.get(`tour:${step.id}:${index}`)?.patch ?? "",
            selection.side,
            selection.startLine,
            selection.endLine,
          ),
      );
      if (step && index !== undefined && index >= 0)
        setSelectionSurface(`tour:${step.id}:${index}`);
    }
    setKeyboardRangeStart(null);
    setKeyboardRangeValue(null);
  }

  function openFileComment(path: string, surfaceKey: string) {
    if (fileCommentBody.trim() && fileCommentPath !== path) {
      setDraftNotice(
        `Save or discard the file comment on ${fileCommentPath} first.`,
      );
      return;
    }
    setFilePath(path);
    setActiveSurface(surfaceKey);
    setCollapsedPaths((current) => {
      const next = new Set(current);
      next.delete(path);
      return next;
    });
    setFileCommentPath(path);
    setFileComposerOpen(true);
  }

  function renderFileComments(file: File) {
    return review ? (
      <FileCommentsBar
        annotations={review.annotations.filter(
          (annotation) =>
            annotation.fileLevel && annotation.filePath === file.path,
        )}
        busy={busy}
        composerOpen={fileComposerOpen && fileCommentPath === file.path}
        composerBody={fileCommentPath === file.path ? fileCommentBody : ""}
        onComposerBody={setFileCommentBody}
        onCloseComposer={() => {
          setFileCommentBody("");
          setFileComposerOpen(false);
        }}
        onAdd={addFileComment}
        onRemove={(id) => void remove(id)}
        onResolve={(annotation) => void resolve(annotation)}
        onSuggestion={(annotation, accept) =>
          void decideSuggestion(annotation, accept)
        }
        onReply={reply}
        replyDrafts={replyDrafts}
        onReplyDraft={updateReplyDraft}
        onEdit={(annotation, text) => edit(annotation, text)}
        onEditDraft={updateEditDraft}
        editDrafts={editDrafts}
      />
    ) : null;
  }

  function renderFile(
    candidate: File,
    anchor?: ReviewTourAnchor,
    surfaceKey = `file:${candidate.path}`,
  ) {
    if (!review) return null;
    const storedPatch =
      deferredPatches.get(`${review.id}\\0${candidate.path}`) ??
      candidate.patch;
    const prepared = preparedDiffs.get(surfaceKey);
    const patch = prepared?.patch ?? "";
    const collapsed = !anchor && collapsedPaths.has(candidate.path);
    const inlineAnnotations = surfaceAnnotations.get(surfaceKey) ?? [];
    const selected =
      selectionPath === candidate.path && selectionSurface === surfaceKey
        ? selection
        : null;
    return (
      <section
        key={surfaceKey}
        ref={(node) => {
          if (node) surfaceRefs.current.set(surfaceKey, node);
          else surfaceRefs.current.delete(surfaceKey);
        }}
        data-review-file={candidate.path}
        data-review-surface={surfaceKey}
        aria-label={
          candidate.path === filePath
            ? "File diff"
            : `Diff for ${candidate.path}`
        }
        tabIndex={0}
        onFocus={(event) => {
          if (event.target === event.currentTarget) {
            setFilePath(candidate.path);
            setActiveSurface(surfaceKey);
          }
        }}
        onKeyDown={(event) =>
          handleDiffKeyDown(event, candidate, patch, surfaceKey)
        }
        className="mb-6 scroll-mt-16 rounded-lg border bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <div className="flex flex-wrap items-center gap-2 border-b bg-card px-3 py-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 max-sm:basis-full">
            {!anchor ? (
              <Button
                size="sm"
                variant="ghost"
                aria-label={`${collapsed ? "Expand" : "Collapse"} ${candidate.path}`}
                aria-expanded={!collapsed}
                onClick={() =>
                  setCollapsedPaths((current) => {
                    const next = new Set(current);
                    if (next.has(candidate.path)) next.delete(candidate.path);
                    else next.add(candidate.path);
                    return next;
                  })
                }
              >
                {collapsed ? "▸" : "▾"}
              </Button>
            ) : null}
            <h3 className="min-w-0 flex-1 break-all font-mono text-xs font-semibold">
              {candidate.path}
              {anchor
                ? ` · ${anchor.side}:${anchor.startLine}-${anchor.endLine}`
                : ""}
            </h3>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => openFileComment(candidate.path, surfaceKey)}
          >
            Comment on file
          </Button>
          {anchor ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setFileQuery("");
                setFileFilterMode("all");
                setReviewScope("all");
                chooseFile(candidate.path);
              }}
            >
              Full file →
            </Button>
          ) : (
            <Button
              size="sm"
              variant={
                viewedPaths.has(candidate.path) ? "secondary" : "outline"
              }
              aria-pressed={viewedPaths.has(candidate.path)}
              onClick={() => {
                if (viewedPaths.has(candidate.path)) {
                  setCollapsedPaths((current) => {
                    const next = new Set(current);
                    next.delete(candidate.path);
                    return next;
                  });
                  void markViewed(false, candidate.path);
                } else {
                  void markViewed(true, candidate.path);
                }
              }}
            >
              {viewedPaths.has(candidate.path) ? "Viewed ✓" : "Mark viewed"}
            </Button>
          )}
        </div>
        {collapsed ? (
          <p className="p-3 text-xs text-muted-foreground">
            Diff collapsed. Expand to review the changes.
          </p>
        ) : (
          <div className="p-2 sm:p-3">
            {renderFileComments(candidate)}
            {candidate.binary ? (
              <BinaryImagePreview file={candidate} reviewId={review.id} />
            ) : !patch ? (
              <div className="space-y-2 rounded border border-dashed p-4 text-xs">
                <p>
                  {candidate.deferredReason
                    ? `${candidate.deferredReason} is deferred until requested.`
                    : anchor
                      ? "This excerpt is unavailable in the immutable snapshot."
                      : "No patch is available for this file."}
                </p>
                {candidate.deferredReason && !storedPatch ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void loadDeferredDiff(candidate.path)}
                    disabled={deferredLoading}
                  >
                    {deferredLoading ? "Loading diff…" : "Load diff"}
                  </Button>
                ) : null}
                {deferredError ? (
                  <p role="alert" className="text-destructive">
                    {deferredError}
                  </p>
                ) : null}
              </div>
            ) : (
              <LazyDiffSurface
                placeholder={
                  <p className="rounded border border-dashed p-4 text-center text-xs text-muted-foreground">
                    Diff renders as it scrolls into view.
                  </p>
                }
                onMount={notifyMounted}
              >
                {anchor ? (
                  <p className="mb-2 text-[11px] text-muted-foreground">
                    Excerpt with nearby context, not the complete file diff.
                  </p>
                ) : null}
                {candidate.truncated ? (
                  <p className="mb-2 text-xs text-amber-700 dark:text-amber-300">
                    This patch is truncated. Comments refer only to visible
                    snapshot lines.
                  </p>
                ) : null}
                <MountedDiff
                  patch={patch}
                  lineAnnotations={inlineAnnotations}
                  annotations={review.annotations}
                  replyDrafts={replyDrafts}
                  onReply={replyAnnotation}
                  onReplyDraft={updateReplyDraft}
                  editDrafts={editDrafts}
                  onEdit={editAnnotation}
                  onEditDraft={updateEditDraft}
                  onRemove={removeAnnotationById}
                  wrapLines={wrapLines}
                  loadDiffFiles={prepared?.loader}
                  composer={
                    selected
                      ? {
                          file: candidate,
                          selection: selected,
                          body,
                          busy,
                          onBody: setBody,
                          onAdd: add,
                          onCancel: () => {
                            setSelection(null);
                            setSelectionPath(null);
                            setSelectionSurface(null);
                            setBody("");
                            setKeyboardRangeStart(null);
                            setKeyboardRangeValue(null);
                            setMobilePanel(null);
                            setDraftNotice(null);
                            requestAnimationFrame(() =>
                              surfaceRefs.current.get(surfaceKey)?.focus(),
                            );
                          },
                        }
                      : INACTIVE_COMPOSER
                  }
                  onSelect={surfaceSelectHandler(candidate.path, surfaceKey)}
                  keyboardSelection={
                    activeSurface === surfaceKey ? keyboardSelection : null
                  }
                />
              </LazyDiffSurface>
            )}
          </div>
        )}
      </section>
    );
  }

  function renderTour() {
    const tour = review?.tour;
    if (!tour)
      return (
        <p className="rounded border bg-card p-4 text-sm text-muted-foreground">
          No tour is authored for this immutable revision. Review changes in
          Files mode.
        </p>
      );
    const step =
      tour.steps.find((candidate) => candidate.id === activeTourStepId) ??
      tour.steps[0];
    return (
      <div className="mx-auto max-w-5xl">
        <h2 className="text-lg font-semibold">{tour.title}</h2>
        {tour.overview ? (
          <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
            {tour.overview}
          </p>
        ) : null}
        <p className="my-3 text-[11px] text-muted-foreground">
          Agent-authored explanation, not runtime-verified. Tour reading does
          not mark files viewed.
        </p>
        {step ? (
          <article aria-label={step.title}>
            <h3 className="mb-4 text-base font-semibold">{step.title}</h3>
            {step.blocks.map((block, index) => {
              if (block.kind === "narrative")
                return (
                  <p
                    key={index}
                    className="my-4 whitespace-pre-wrap text-sm leading-relaxed"
                  >
                    {block.body}
                  </p>
                );
              if (block.kind === "evidence")
                return (
                  <div key={index} className="my-4 rounded border bg-card p-3">
                    <TourCardView card={block.card} />
                  </div>
                );
              const anchor = block.anchor;
              if (tourScopePaths && !tourScopePaths.has(anchor.filePath))
                return (
                  <p key={index} className="my-3 text-xs text-muted-foreground">
                    {anchor.filePath}: excerpt outside Since viewed scope.{" "}
                    <button
                      className="underline"
                      onClick={() => setReviewScope("all")}
                    >
                      Show all changes
                    </button>
                  </p>
                );
              const candidate = review?.files.find(
                (file) => file.path === anchor.filePath,
              );
              if (!anchor.valid || !candidate)
                return (
                  <p
                    key={index}
                    role="status"
                    className="my-3 rounded border border-amber-500/30 p-3 text-xs"
                  >
                    {anchor.filePath} · {anchor.side}:{anchor.startLine}-
                    {anchor.endLine} · unavailable (
                    {anchor.reason ?? "file-not-in-revision"})
                  </p>
                );
              return renderFile(candidate, anchor, `tour:${step.id}:${index}`);
            })}
          </article>
        ) : null}
        <details className="mt-4 rounded border p-3 text-xs">
          <summary className="cursor-pointer font-semibold">
            Outside the tour / raw-change coverage
          </summary>
          <p className="mt-2">
            {tour.coverage.coveredChangedLines} of{" "}
            {tour.coverage.totalChangedLines} added/deleted lines have tour
            anchors. {tour.coverage.uncovered.length} remain unanchored. This is
            not a reading or correctness verdict.
          </p>
          {[
            ...new Set(tour.coverage.uncovered.map((line) => line.filePath)),
          ].map((path) => (
            <button
              key={path}
              className="mt-2 block break-all text-left font-mono underline"
              onClick={() => {
                setReviewScope("all");
                setFileQuery("");
                setFileFilterMode("all");
                chooseFile(path);
              }}
            >
              {path} →
            </button>
          ))}
        </details>
      </div>
    );
  }

  return (
    <main
      className={`flex min-h-0 flex-col overflow-hidden bg-background text-foreground ${fullscreen ? "fixed inset-0 z-50" : "h-full"}`}
    >
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-card px-2 py-2 sm:px-3 sm:py-3 lg:gap-3 lg:px-4">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => navigate.toThread(threadId)}
          aria-label="Back to thread"
        >
          ← <span className="hidden sm:inline">Back</span>
        </Button>
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <span
            className="hidden size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary sm:inline-flex"
            aria-hidden="true"
          >
            <Icon name="GitPullRequest" className="size-4" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">Review changes</h1>
            <p className="truncate text-[11px] text-muted-foreground">
              {review ? describeTarget(review.target) : "No snapshot yet"}
              {review ? (
                <span className="ml-2 font-mono">
                  {review.snapshot.slice(0, 10)}
                </span>
              ) : null}
            </p>
          </div>
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
        <details className="relative" open={!review}>
          <summary className="flex h-8 cursor-pointer list-none items-center rounded-md border px-2 text-xs hover:bg-muted">
            Compare / refresh
          </summary>
          <div className="absolute right-0 top-full z-30 mt-2 flex w-[min(28rem,calc(100vw-2rem))] flex-wrap items-center gap-2 rounded-lg border bg-popover p-3 shadow-lg">
            <select
              aria-label="Review target"
              value={targetKind}
              onChange={(event) =>
                setTargetKind(event.target.value as typeof targetKind)
              }
              className="h-8 max-w-48 rounded-md border bg-background px-1 text-xs max-sm:w-44 sm:w-auto"
            >
              <option value="uncommitted">Uncommitted changes</option>
              <option value="commit">Specific commit</option>
              <option value="branch">Committed vs base</option>
              <option value="all">Everything vs base</option>
            </select>
            {targetKind === "commit" ? (
              recentCommits === null ? (
                <span className="text-[11px] text-muted-foreground">
                  Loading commits...
                </span>
              ) : recentCommits.status === "ok" &&
                recentCommits.commits.length ? (
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
                  className="h-8 min-w-0 max-w-64 flex-1 basis-44 rounded-md border bg-background px-1 text-xs max-sm:basis-24"
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
                aria-label={
                  targetKind === "commit" ? "Commit sha" : "Base branch"
                }
                className="h-8 w-44 rounded-md border bg-background px-2 font-mono text-xs max-sm:min-w-0 max-sm:w-auto max-sm:flex-1 max-sm:basis-24"
              />
            ) : null}
            <Button
              size="sm"
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
                    ? "Review committed"
                    : targetKind === "all"
                      ? "Review everything"
                      : review
                        ? "Refresh"
                        : "Open review"}
            </Button>
          </div>
        </details>
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
      {error && !feedbackOpen ? (
        <p
          role="alert"
          className="m-3 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
        >
          {error}
        </p>
      ) : null}
      {!review ? (
        <div className="p-6 text-sm text-muted-foreground">
          Open a review to load changes from this thread&apos;s environment.
        </div>
      ) : (
        <>
          <Dialog.Root open={feedbackOpen} onOpenChange={setFeedbackOpen}>
            <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b bg-card px-3 py-1.5 sm:gap-2 sm:py-2">
              <Button
                size="sm"
                variant={readingMode === "files" ? "secondary" : "ghost"}
                aria-pressed={readingMode === "files"}
                onClick={() => switchReadingMode("files")}
              >
                Files
              </Button>
              <Button
                size="sm"
                variant={readingMode === "tour" ? "secondary" : "ghost"}
                aria-pressed={readingMode === "tour"}
                onClick={() => switchReadingMode("tour")}
              >
                Tour
              </Button>
              {readingMode === "tour" ? (
                <select
                  aria-label="Review scope"
                  value={reviewScope}
                  onChange={(event) =>
                    setReviewScope(event.target.value as "all" | "since-viewed")
                  }
                  className="h-8 rounded-md border bg-background px-2 text-xs"
                >
                  <option value="all">All changes</option>
                  <option value="since-viewed">Since viewed</option>
                </select>
              ) : null}
              <div className="flex-1" />
              <Button
                size="sm"
                variant="ghost"
                className="hidden sm:inline-flex"
                aria-expanded={keyboardHelpOpen}
                onClick={() => setKeyboardHelpOpen((open) => !open)}
              >
                Keyboard ?
              </Button>
              <Dialog.Trigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Review feedback, ${pendingCount} pending/unsent comments`}
                  onClick={(event) => {
                    feedbackOpenerRef.current = event.currentTarget;
                  }}
                >
                  Review feedback{" "}
                  {pendingCount ? (
                    <span className="rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">
                      {pendingCount}
                    </span>
                  ) : null}
                </Button>
              </Dialog.Trigger>
            </div>
            <div className="shrink-0 border-b bg-muted/40 p-1 lg:hidden">
              <div className="flex min-w-0 items-center gap-1.5">
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
                {readingMode === "tour" ? (
                  <select
                    aria-label="Tour section"
                    value={activeTourStepId ?? review.tour?.steps[0]?.id ?? ""}
                    onChange={(event) => {
                      setActiveTourStepId(event.target.value);
                      setActiveSurface(null);
                      setKeyboardRangeStart(null);
                      setKeyboardRangeValue(null);
                      scrollSectionRef.current?.scrollTo?.({ top: 0 });
                    }}
                    className="min-w-0 flex-[1.5] rounded-md border bg-background px-2 py-2 text-xs"
                  >
                    {review.tour?.steps.map((step) => (
                      <option key={step.id} value={step.id}>
                        {step.title}
                      </option>
                    ))}
                  </select>
                ) : (
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
                )}
                <details className="relative shrink-0">
                  <summary
                    aria-label="File filters"
                    className="flex h-9 cursor-pointer list-none items-center rounded-md border bg-background px-2 text-xs"
                  >
                    Filters
                  </summary>
                  <div className="absolute right-0 z-30 mt-1 w-[min(22rem,calc(100vw-1rem))] rounded-md border bg-popover p-2 shadow-lg">
                    <FileFilterControls
                      compact
                      query={fileQuery}
                      onQuery={setFileQuery}
                      mode={fileFilterMode}
                      onModeChange={setFileFilterMode}
                    />
                  </div>
                </details>
              </div>
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[15rem_minmax(0,1fr)]">
              <aside className="hidden min-h-0 overflow-auto border-r bg-muted/30 lg:block">
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
                {readingMode === "files" ? (
                  <div className="border-b p-3">
                    <div className="flex justify-between text-xs font-medium">
                      <span>Files changed</span>
                      <span className="text-muted-foreground">
                        {review.viewedPaths.length} of {review.files.length}{" "}
                        viewed
                      </span>
                    </div>
                    <div
                      role="progressbar"
                      aria-label="Files viewed"
                      aria-valuemin={0}
                      aria-valuemax={review.files.length || 1}
                      aria-valuenow={review.viewedPaths.length}
                      aria-valuetext={`${review.viewedPaths.length} of ${review.files.length} files viewed`}
                      className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
                    >
                      <i
                        className="block h-full rounded-full bg-primary"
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
                ) : null}
                <nav
                  className="p-2"
                  aria-label={
                    readingMode === "files" ? "Changed files" : "Tour contents"
                  }
                >
                  {readingMode === "files"
                    ? visibleFiles.map((candidate) => (
                        <button
                          key={candidate.path}
                          aria-label={candidate.path}
                          onClick={() => chooseFile(candidate.path)}
                          aria-current={
                            candidate.path === filePath ? "true" : undefined
                          }
                          className={`mb-1 flex w-full items-center gap-2 rounded-lg border border-l-2 px-2 py-2.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${candidate.path === filePath ? "border-primary/30 border-l-primary bg-primary/10 font-semibold text-foreground hover:bg-primary/15" : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground"}`}
                        >
                          <span
                            className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${(() => {
                              const kind = normalizeChangeKind(
                                candidate.status,
                              );
                              return kind === "added"
                                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                                : kind === "deleted"
                                  ? "bg-red-500/15 text-red-700 dark:text-red-400"
                                  : "bg-amber-500/15 text-amber-700 dark:text-amber-400";
                            })()}`}
                          >
                            {candidate.status[0]?.toUpperCase()}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span
                              className="block truncate"
                              title={candidate.path}
                            >
                              {candidate.path.split("/").pop()}
                              <span className="block truncate text-[10px] font-normal text-muted-foreground">
                                {candidate.path.slice(
                                  0,
                                  candidate.path.lastIndexOf("/"),
                                )}
                              </span>
                            </span>
                            <span className="mt-0.5 flex gap-2 text-[11px] font-normal tabular-nums">
                              <span className="text-emerald-700 dark:text-emerald-400">
                                +{candidate.additions}
                              </span>
                              <span className="text-red-700 dark:text-red-400">
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
                      ))
                    : (review.tour?.steps ?? []).map((step, index) => (
                        <button
                          key={step.id}
                          aria-current={
                            step.id === activeTourStepId ? "step" : undefined
                          }
                          className={`mb-1 w-full rounded border px-3 py-2 text-left text-xs ${step.id === activeTourStepId ? "bg-primary/10 border-primary/30" : "border-transparent hover:bg-muted"}`}
                          onClick={() => {
                            setActiveTourStepId(step.id);
                            setActiveSurface(null);
                            setKeyboardRangeStart(null);
                            setKeyboardRangeValue(null);
                            scrollSectionRef.current?.scrollTo?.({ top: 0 });
                          }}
                        >
                          {index + 1}. {step.title}
                        </button>
                      ))}
                  {readingMode === "files" && !visibleFiles.length ? (
                    <p className="p-2 text-xs text-muted-foreground">
                      No matching files.
                    </p>
                  ) : null}
                </nav>
              </aside>
              <section
                ref={scrollSectionRef}
                onScroll={(event) => {
                  if (readingMode !== "files") return;
                  if (fileScrollFrameRef.current !== null)
                    cancelAnimationFrame(fileScrollFrameRef.current);
                  fileScrollFrameRef.current = requestAnimationFrame(() => {
                    fileScrollFrameRef.current = null;
                    const container = scrollSectionRef.current;
                    if (!container) return;
                    const containerTop = container.getBoundingClientRect().top;
                    const sections = Array.from(
                      container.querySelectorAll<HTMLElement>(
                        "[data-review-surface^='file:']",
                      ),
                    );
                    let current: HTMLElement | undefined;
                    for (const section of sections) {
                      if (
                        section.getBoundingClientRect().top <=
                        containerTop + 96
                      )
                        current = section;
                      else break;
                    }
                    current ??= sections[0];
                    const path = current?.dataset.reviewFile;
                    if (path)
                      setFilePath((previous) =>
                        previous === path ? previous : path,
                      );
                  });
                }}
                aria-label="Review document"
                className="min-h-0 overflow-auto bg-muted/60 pb-20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary lg:pb-3"
              >
                <div
                  hidden={readingMode === "tour"}
                  className="sticky top-0 z-10 flex flex-wrap items-center gap-1 border-b bg-card px-2 py-1 shadow-sm sm:gap-2 sm:px-3 sm:py-2 lg:px-4"
                >
                  <div className="relative flex min-w-0 flex-1 basis-full items-center gap-1 lg:basis-40">
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
                    <span
                      className="min-w-0 flex-1 truncate px-1 font-mono text-xs font-semibold"
                      title={file?.path}
                    >
                      {file?.path ?? "No changed files"}
                    </span>
                    <details ref={mobileMoreRef} className="shrink-0 lg:hidden">
                      <summary
                        aria-label="More diff controls"
                        className="flex h-8 cursor-pointer list-none items-center rounded-md border px-2 text-[11px]"
                      >
                        More
                      </summary>
                      <div className="absolute right-0 z-30 mt-1 max-h-[min(60dvh,24rem)] w-[min(18rem,calc(100vw-1rem))] overflow-auto rounded-md border bg-popover p-2 text-popover-foreground shadow-lg">
                        <Button
                          size="sm"
                          variant="outline"
                          className="mb-2 w-full justify-start"
                          onClick={() => {
                            if (
                              fileCommentBody.trim() &&
                              fileCommentPath !== file?.path
                            ) {
                              setDraftNotice(
                                `Save or discard the file comment on ${fileCommentPath} first.`,
                              );
                              return;
                            }
                            setFileCommentPath(file?.path ?? null);
                            setFileComposerOpen(true);
                            if (mobileMoreRef.current)
                              mobileMoreRef.current.open = false;
                          }}
                        >
                          <Icon name="MessageSquare" />
                          Comment on file
                        </Button>
                        <select
                          aria-label="Review scope"
                          value={reviewScope}
                          onChange={(event) =>
                            setReviewScope(
                              event.target.value as "all" | "since-viewed",
                            )
                          }
                          className="h-9 w-full rounded-md border bg-background px-2 text-xs"
                        >
                          <option value="all">All {review.files.length}</option>
                          <option value="since-viewed">
                            Since viewed{" "}
                            {(revisionDelta?.changedPaths.length ?? 0) +
                              (revisionDelta?.unknownPaths.length ?? 0)}
                          </option>
                        </select>
                        <div className="mt-2">
                          {renderExactRangeControl(true)}
                        </div>
                        <details className="rounded border px-2 py-1.5">
                          <summary className="cursor-pointer text-xs font-medium">
                            Baseline
                          </summary>
                          <div className="mt-2 max-h-48 overflow-auto text-[11px]">
                            <p className="mb-2 text-muted-foreground">
                              Each path uses its latest explicitly marked viewed
                              revision. Opening a review does not advance this
                              baseline.
                            </p>
                            {revisionDelta?.baselines.length ? (
                              <ul className="space-y-1">
                                {revisionDelta.baselines
                                  .slice(0, 30)
                                  .map((entry) => (
                                    <li key={entry.path} className="font-mono">
                                      {entry.path}
                                      <span className="ml-1 text-muted-foreground">
                                        · {entry.reviewId.slice(0, 8)}
                                      </span>
                                    </li>
                                  ))}
                              </ul>
                            ) : (
                              <p>
                                No file has a saved viewed baseline yet; current
                                changes remain in scope.
                              </p>
                            )}
                            {revisionDelta?.revertedPaths.length ? (
                              <p className="mt-2">
                                {revisionDelta.revertedPaths.length} path(s)
                                returned to the verified base; no current patch
                                row exists.
                              </p>
                            ) : null}
                            {revisionDelta?.unknownPaths.length ? (
                              <p className="mt-2">
                                {revisionDelta.unknownPaths.length} path(s) have
                                unknown deltas.
                              </p>
                            ) : null}
                            {revisionDelta?.reason ? (
                              <p className="mt-2 text-amber-700 dark:text-amber-300">
                                {revisionDelta.reason}
                              </p>
                            ) : null}
                          </div>
                        </details>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="mt-1 w-full justify-start"
                          onClick={() => setWrapLines((current) => !current)}
                          aria-pressed={wrapLines}
                        >
                          <Icon name="TextWrap" />
                          {wrapLines
                            ? "Disable line wrapping"
                            : "Wrap diff lines"}
                        </Button>
                        <button
                          type="button"
                          aria-controls="mobile-keyboard-shortcuts"
                          aria-expanded={keyboardHelpOpen}
                          className="mt-1 flex min-h-9 w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs hover:bg-muted"
                          onClick={() => setKeyboardHelpOpen((open) => !open)}
                        >
                          {keyboardHelpOpen
                            ? "Hide keyboard shortcuts"
                            : "Keyboard shortcuts"}
                          <span aria-hidden="true">
                            {keyboardHelpOpen ? "−" : "+"}
                          </span>
                        </button>
                        <div
                          id="mobile-keyboard-shortcuts"
                          hidden={!keyboardHelpOpen}
                          className="px-2 pb-2 text-[11px] text-muted-foreground"
                        >
                          {keyboardShortcutContent}
                        </div>
                      </div>
                    </details>
                    <Button
                      className="lg:hidden max-sm:px-2 max-sm:text-[11px]"
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
                    <span className="hidden text-[11px] text-muted-foreground sm:inline">
                      {currentIndex} / {review.files.length}
                    </span>
                  </div>
                  <div className="hidden min-w-0 max-w-full flex-1 basis-full items-center gap-1 lg:ml-auto lg:flex lg:basis-auto lg:flex-nowrap lg:shrink-0">
                    {renderExactRangeControl(false)}
                    <div
                      role="group"
                      aria-label="Review scope"
                      className="hidden items-center gap-1 rounded-md border p-0.5 lg:flex"
                    >
                      <Button
                        size="sm"
                        variant={reviewScope === "all" ? "secondary" : "ghost"}
                        aria-pressed={reviewScope === "all"}
                        onClick={() => setReviewScope("all")}
                      >
                        All {review.files.length}
                      </Button>
                      <Button
                        size="sm"
                        variant={
                          reviewScope === "since-viewed" ? "secondary" : "ghost"
                        }
                        aria-pressed={reviewScope === "since-viewed"}
                        onClick={() => setReviewScope("since-viewed")}
                      >
                        Since viewed{" "}
                        {(revisionDelta?.changedPaths.length ?? 0) +
                          (revisionDelta?.unknownPaths.length ?? 0)}
                      </Button>
                    </div>
                    <details className="relative hidden lg:block">
                      <summary className="cursor-pointer rounded px-1 text-[11px] text-muted-foreground">
                        Baseline
                      </summary>
                      <div className="absolute right-0 z-30 mt-1 max-h-64 w-72 overflow-auto rounded-md border bg-popover p-2 text-xs shadow-lg">
                        <p className="mb-2 text-muted-foreground">
                          Each path uses its latest explicitly marked viewed
                          revision. Opening a review does not advance this
                          baseline.
                        </p>
                        {revisionDelta?.baselines.length ? (
                          <ul className="space-y-1">
                            {revisionDelta.baselines
                              .slice(0, 30)
                              .map((entry) => (
                                <li key={entry.path} className="font-mono">
                                  {entry.path}
                                  <span className="ml-1 text-muted-foreground">
                                    · {entry.reviewId.slice(0, 8)}
                                  </span>
                                </li>
                              ))}
                          </ul>
                        ) : (
                          <p>
                            No file has a saved viewed baseline yet; current
                            changes remain in scope.
                          </p>
                        )}
                        {revisionDelta?.revertedPaths.length ? (
                          <div className="mt-2">
                            <p>
                              {revisionDelta.revertedPaths.length} path(s)
                              returned to the verified base; no current patch
                              row exists.
                            </p>
                            <ul className="mt-1 list-inside list-disc font-mono">
                              {revisionDelta.revertedPaths
                                .slice(0, 100)
                                .map((path) => (
                                  <li key={path}>{path}</li>
                                ))}
                            </ul>
                          </div>
                        ) : null}
                        {revisionDelta?.unknownPaths.length ? (
                          <div className="mt-2">
                            <p>
                              {revisionDelta.unknownPaths.length} path(s) have
                              unknown deltas.
                            </p>
                            <ul className="mt-1 list-inside list-disc font-mono">
                              {revisionDelta.unknownPaths
                                .slice(0, 100)
                                .map((path) => (
                                  <li key={path}>{path}</li>
                                ))}
                            </ul>
                          </div>
                        ) : null}
                        {revisionDelta?.reason ? (
                          <p
                            role="status"
                            className="mt-2 text-amber-700 dark:text-amber-300"
                          >
                            {revisionDelta.reason}
                          </p>
                        ) : null}
                      </div>
                    </details>
                    <Button
                      size="sm"
                      variant="ghost"
                      className={`hidden lg:inline-flex ${COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS} text-muted-foreground`}
                      onClick={() => setWrapLines((current) => !current)}
                      aria-pressed={wrapLines}
                      aria-label={
                        wrapLines ? "Disable diff line wrap" : "Wrap diff lines"
                      }
                    >
                      <Icon name="TextWrap" />
                    </Button>
                  </div>
                </div>
                <div className="p-1.5 sm:p-2 lg:p-4">
                  {keyboardHelpOpen ? (
                    <div className="mb-3 rounded border bg-background px-3 py-2 text-[11px] text-muted-foreground">
                      {keyboardShortcutContent}
                    </div>
                  ) : null}
                  {draftNotice ? (
                    <p
                      role="status"
                      aria-live="polite"
                      className="mb-2 rounded border border-amber-500/30 bg-amber-500/10 p-2 text-xs"
                    >
                      {draftNotice}
                    </p>
                  ) : null}
                  {fileComposerOpen &&
                  fileCommentBody.trim() &&
                  !fileDraftVisible ? (
                    <div className="mb-3 flex flex-wrap items-center gap-2 rounded border border-amber-500/30 p-2 text-xs">
                      <span>
                        Whole-file draft remains on{" "}
                        <code>{fileCommentPath}</code>.
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setReviewScope("all");
                          if (fileCommentPath) chooseFile(fileCommentPath);
                        }}
                      >
                        Return to file draft
                      </Button>
                    </div>
                  ) : null}
                  {selection &&
                  body.trim() &&
                  (selectionPath !== file?.path ||
                    (readingMode === "tour" &&
                      !selectionSurface?.startsWith(
                        `tour:${activeTourStepId}:`,
                      ))) ? (
                    <div className="mb-3 flex flex-wrap items-center gap-2 rounded border border-amber-500/30 bg-amber-500/10 p-2 text-xs">
                      <span>
                        Unsent draft remains anchored to{" "}
                        <code>{selectionPath}</code>.
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setReviewScope("all");
                          if (selectionPath) chooseFile(selectionPath);
                        }}
                      >
                        Return to draft
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setBody("");
                          setSelection(null);
                          setSelectionPath(null);
                          setKeyboardRangeStart(null);
                          setKeyboardRangeValue(null);
                          setDraftNotice(null);
                        }}
                      >
                        Discard draft
                      </Button>
                    </div>
                  ) : null}
                  {readingMode === "tour" ? (
                    renderTour()
                  ) : !scopedFiles.length ? (
                    <div className="space-y-2 text-sm text-muted-foreground">
                      <p>
                        {reviewScope === "since-viewed" &&
                        revisionDelta?.revertedPaths.length
                          ? `No current patch rows in scope. ${revisionDelta.revertedPaths.length} path(s) returned to the verified base; inspect Baseline details.`
                          : review.files.length
                            ? "No files match this scope or filter."
                            : "No changed files."}
                      </p>
                      {!review.files.length &&
                      review.target.type === "uncommitted" ? (
                        <div className="max-w-xl rounded border bg-card p-3 text-xs">
                          <p>
                            If the agent committed its work, switch targets to
                            include committed changes. This empty snapshot is
                            still retained as captured.
                          </p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setTargetKind("all");
                                setTargetValue("");
                              }}
                            >
                              Everything vs base
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setTargetKind("branch");
                                setTargetValue("");
                              }}
                            >
                              Committed vs base
                            </Button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    scopedFiles.map((candidate) => renderFile(candidate))
                  )}
                </div>
              </section>
            </div>
            <Dialog.Portal>
              <Dialog.Overlay
                data-bb-plugin={pluginId}
                data-bb-plugin-root=""
                data-bb-portaled-overlay=""
                className="fixed inset-0 z-40 bg-black/40"
              />
              <Dialog.Content
                data-bb-plugin={pluginId}
                data-bb-plugin-root=""
                data-bb-portaled-overlay=""
                onEscapeKeyDown={() => setFeedbackOpen(false)}
                onCloseAutoFocus={(event) => {
                  event.preventDefault();
                  feedbackOpenerRef.current?.focus();
                }}
                className="fixed inset-0 z-50 flex max-h-dvh w-full flex-col overflow-auto border bg-card p-4 shadow-2xl focus:outline-none lg:inset-y-0 lg:left-auto lg:right-0 lg:max-w-lg"
                style={{
                  paddingTop: "calc(env(safe-area-inset-top) + 1rem)",
                  paddingBottom: "calc(env(safe-area-inset-bottom) + 1rem)",
                }}
              >
                <Dialog.Description className="sr-only">
                  {pendingCount} pending/unsent comments. Review and send
                  feedback to the agent.
                </Dialog.Description>
                <ReviewSummary
                  review={review}
                  busy={busy}
                  error={error}
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
                onClick={() => {
                  setReadingMode("files");
                  setMobilePanel(null);
                }}
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
            {mobilePanel === "compose" &&
            selection &&
            selectionPath === file?.path ? (
              <div className="fixed inset-0 z-40 flex items-start bg-black/40 p-3 pt-[max(0.75rem,env(safe-area-inset-top))] lg:hidden">
                <div className="max-h-[85dvh] w-full overflow-auto rounded-xl border bg-background p-4 shadow-2xl">
                  <Composer
                    file={file}
                    selection={selection}
                    body={body}
                    busy={busy}
                    onBody={setBody}
                    onAdd={add}
                    onCancel={() => {
                      const restoreKeyboardFocus = Boolean(keyboardRangeStart);
                      setSelection(null);
                      setSelectionPath(null);
                      setKeyboardRangeStart(null);
                      setKeyboardRangeValue(null);
                      setBody("");
                      setMobilePanel(null);
                      if (restoreKeyboardFocus)
                        requestAnimationFrame(() =>
                          surfaceRefs.current
                            .get(selectionSurface ?? "")
                            ?.focus(),
                        );
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

function RecentReviews() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const pluginId = experimental_usePluginId();
  const [reviews, setReviews] = useState<RecentReview[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    rpc
      .call("recentReviews", {})
      .then((result) => {
        if (!cancelled) setReviews(result.reviews);
      })
      .catch((cause) => {
        if (!cancelled)
          setError(
            cause instanceof Error
              ? cause.message
              : "Unable to load recent reviews.",
          );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, reloadKey]);

  return (
    <main className="h-full overflow-auto bg-background text-foreground">
      <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-8">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <h1 className="text-xl font-semibold tracking-tight">
              Recent reviews
            </h1>
            <p className="text-sm text-muted-foreground">
              Latest saved snapshots, pending feedback first.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => setReloadKey((key) => key + 1)}
          >
            <Icon
              name="ArrowReloadHorizontal"
              className={`size-3.5 ${loading ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            {loading ? "Loading..." : error ? "Try again" : "Reload list"}
          </Button>
        </header>
        {error ? (
          <div
            role="alert"
            className="rounded-lg border border-destructive/25 bg-destructive/5 p-4 text-sm"
          >
            <p className="font-medium text-destructive">
              Could not load recent reviews
            </p>
            <p className="mt-1 break-words text-muted-foreground">{error}</p>
          </div>
        ) : null}
        {reviews === null && loading ? (
          <p
            role="status"
            className="py-10 text-center text-sm text-muted-foreground"
          >
            Loading reviews...
          </p>
        ) : reviews?.length === 0 && !error ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-12 text-center">
            <Icon
              name="GitPullRequest"
              className="size-7 text-muted-foreground"
              aria-hidden="true"
            />
            <h2 className="text-base font-medium">No recent reviews yet</h2>
            <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
              Open a thread and choose{" "}
              <span className="font-medium text-foreground">Review</span>, then{" "}
              <span className="font-medium text-foreground">Open review</span>{" "}
              to save a snapshot. Your recent reviews will appear here so you
              can pick up where you left off.
            </p>
          </div>
        ) : reviews?.length ? (
          <nav aria-label="Recent review workspaces" aria-busy={loading}>
            <ul className="divide-y rounded-xl border bg-card">
              {reviews.map((review) => (
                <li key={review.id}>
                  <a
                    href={`/plugins/${encodeURIComponent(pluginId)}/review/review/${encodeURIComponent(review.threadId)}`}
                    aria-label={`Open review for ${review.threadTitle}`}
                    className="group flex flex-col gap-4 rounded-lg p-4 transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:flex-row sm:items-center sm:p-5"
                    onClick={(event) => {
                      if (
                        event.button !== 0 ||
                        event.metaKey ||
                        event.ctrlKey ||
                        event.shiftKey ||
                        event.altKey
                      )
                        return;
                      event.preventDefault();
                      navigate.toPluginPanel("review", {
                        subPath: `review/${review.threadId}`,
                      });
                    }}
                  >
                    <div className="min-w-0 flex-1 space-y-2">
                      <div>
                        <p className="break-words text-sm font-semibold [overflow-wrap:anywhere]">
                          {review.threadTitle}
                        </p>
                        <p className="mt-0.5 break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
                          {review.projectName}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span className="break-all rounded bg-muted px-1.5 py-0.5 font-mono">
                          {review.target.type === "uncommitted"
                            ? "Uncommitted"
                            : describeTarget(review.target)}
                        </span>
                        <span>
                          Snapshot{" "}
                          <time
                            dateTime={new Date(review.createdAt).toISOString()}
                          >
                            {new Date(review.createdAt).toLocaleString(
                              undefined,
                              { dateStyle: "medium", timeStyle: "short" },
                            )}
                          </time>
                        </span>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 sm:flex-col sm:items-end sm:gap-2">
                      {review.pendingCount > 0 ? (
                        <StateChip tone="primary">
                          {review.pendingCount} pending{" "}
                          {review.pendingCount === 1 ? "comment" : "comments"}
                        </StateChip>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          No pending comments
                        </span>
                      )}
                      {review.fileCount > 0 ? (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span>
                            {review.viewedCount} of {review.fileCount} files
                            viewed
                          </span>
                          <div
                            role="progressbar"
                            aria-label={`Files viewed for ${review.threadTitle}`}
                            aria-valuemin={0}
                            aria-valuemax={review.fileCount}
                            aria-valuenow={review.viewedCount}
                            aria-valuetext={`${review.viewedCount} of ${review.fileCount} files viewed`}
                            className="h-1 w-12 overflow-hidden rounded-full bg-muted"
                          >
                            <div
                              className="h-full bg-primary/60"
                              style={{
                                width: `${(review.viewedCount / review.fileCount) * 100}%`,
                              }}
                            />
                          </div>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          No changed files
                        </span>
                      )}
                    </div>
                    <Icon
                      name="ChevronRight"
                      className="hidden size-4 shrink-0 text-muted-foreground sm:block"
                      aria-hidden="true"
                    />
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
        {reviews?.length ? (
          <p className="text-xs text-muted-foreground">
            Counts reflect saved snapshots. Reloading this list does not refresh
            diffs.
          </p>
        ) : null}
      </div>
    </main>
  );
}

function ReviewPage({ subPath }: { subPath: string }) {
  const threadId = subPath.replace(/^review\//, "");
  return threadId ? (
    <ReviewPanel key={threadId} threadId={threadId} />
  ) : (
    <RecentReviews />
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
