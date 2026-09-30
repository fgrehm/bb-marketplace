import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_usePluginId,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "./components/ui/button";
import { Icon } from "./components/ui/icon";
import { SCORE_LABELS, USE_CASES, type Prompt, type Rating } from "./model";
import type { rpcContract, RatingSummary } from "./server";

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const fieldClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function useRefreshOnReconnect(refresh: () => void) {
  const connection = useRealtimeConnectionState();
  const previous = useRef(connection);
  useEffect(() => {
    if (connection === "connected" && previous.current !== "connected")
      refresh();
    previous.current = connection;
  }, [connection, refresh]);
}

function FeedbackForm({
  rating,
  pending,
  onSubmit,
}: {
  rating: Rating | null;
  pending: boolean;
  onSubmit: (feedback: {
    score: number;
    useCase: (typeof USE_CASES)[number];
    note: string;
  }) => Promise<void>;
}) {
  const id = useId();
  const [score, setScore] = useState(rating?.score ?? 0);
  const [useCase, setUseCase] = useState<(typeof USE_CASES)[number]>(
    rating?.useCase ?? "coding",
  );
  const [note, setNote] = useState(rating?.note ?? "");
  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (score && !pending) void onSubmit({ score, useCase, note });
      }}
    >
      <fieldset disabled={pending} className="space-y-2">
        <legend className="mb-2 text-sm font-medium">
          How useful was this chat?
        </legend>
        <div className="grid grid-cols-5 gap-2">
          {SCORE_LABELS.map((label, index) => (
            <label
              key={label}
              className={`flex cursor-pointer flex-col items-center gap-1 rounded-lg border p-2 text-center text-sm ${score === index + 1 ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:bg-muted"}`}
            >
              <input
                className="sr-only peer"
                type="radio"
                name={`${id}-score`}
                value={index + 1}
                checked={score === index + 1}
                onChange={() => setScore(index + 1)}
                aria-label={`${index + 1}, ${label}`}
                required
              />
              <span className="rounded px-1 text-lg font-semibold peer-focus-visible:ring-2 peer-focus-visible:ring-ring">
                {index + 1}
              </span>
            </label>
          ))}
        </div>
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>Not useful</span>
          <span>Very useful</span>
        </div>
      </fieldset>
      <div className="space-y-2">
        <label htmlFor={`${id}-case`} className="text-sm font-medium">
          What was it for?
        </label>
        <select
          id={`${id}-case`}
          value={useCase}
          disabled={pending}
          className={fieldClass}
          onChange={(event) => setUseCase(event.target.value as typeof useCase)}
        >
          {USE_CASES.map((value) => (
            <option key={value} value={value}>
              {value[0]!.toUpperCase() + value.slice(1)}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-2">
        <label htmlFor={`${id}-note`} className="text-sm font-medium">
          What worked or didn't?{" "}
          <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <textarea
          id={`${id}-note`}
          value={note}
          disabled={pending}
          maxLength={4000}
          rows={3}
          placeholder="A note for your future self"
          className={fieldClass}
          onChange={(event) => setNote(event.target.value)}
        />
      </div>
      <Button
        type="submit"
        disabled={pending || score === 0}
        className="w-full"
      >
        {pending ? "Saving locally…" : "Save rating"}
      </Button>
    </form>
  );
}

function ArchivePrompt({
  prompt,
  count,
  onDone,
}: {
  prompt: Prompt;
  count: number;
  onDone: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const pluginId = experimental_usePluginId();
  const portalScope = {
    "data-bb-plugin-root": "",
    "data-bb-plugin": pluginId,
    "data-bb-portaled-overlay": "",
  };
  const [rating, setRating] = useState<Rating | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    let cancelled = false;
    setError(null);
    rpc.call("getRating", { threadId: prompt.threadId }).then(
      (value) => {
        if (!cancelled) {
          setRating(value);
          setLoaded(true);
        }
      },
      (cause) => {
        if (!cancelled) setError(errorText(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, prompt.threadId]);
  useEffect(load, [load]);
  const dismiss = async () => {
    if (pending) return;
    setPending(true);
    try {
      await rpc.call("dismiss", {
        threadId: prompt.threadId,
        archivedAt: prompt.archivedAt,
      });
      onDone();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) void dismiss();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          {...portalScope}
          className="fixed inset-0 z-50 bg-black/50"
        />
        <Dialog.Content
          {...portalScope}
          className="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-background p-6 text-foreground shadow-xl"
          onEscapeKeyDown={(event) => {
            if (pending) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (pending) event.preventDefault();
          }}
        >
          <div className="mb-4 flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Icon name="Star" className="size-4" /> ARCHIVED CHAT{" "}
            {count > 1 ? <span className="ml-auto">1 of {count}</span> : null}
          </div>
          <Dialog.Title className="text-xl font-semibold">
            How did this chat go?
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-muted-foreground">
            Rate the whole conversation, not one reply. This is just for you.
          </Dialog.Description>
          <p className="my-4 rounded-lg bg-muted px-3 py-2 text-sm font-medium break-words">
            {prompt.title}
          </p>
          {loaded ? (
            <FeedbackForm
              rating={rating}
              pending={pending}
              onSubmit={async (feedback) => {
                setPending(true);
                setError(null);
                try {
                  await rpc.call("savePrompt", {
                    ...feedback,
                    threadId: prompt.threadId,
                    archivedAt: prompt.archivedAt,
                    expectedRevision: rating?.revision ?? null,
                  });
                  onDone();
                } catch (cause) {
                  setError(errorText(cause));
                } finally {
                  setPending(false);
                }
              }}
            />
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              Loading saved feedback…
            </p>
          )}
          {error ? (
            <div className="mt-3 text-sm">
              <p role="alert" className="text-destructive">
                {error}
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setLoaded(false);
                  load();
                }}
                disabled={pending}
              >
                Reload saved rating
              </Button>
            </div>
          ) : null}
          <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
            <Icon name="Lock" className="mr-1 inline size-3" /> Saved on your BB
            server. Recorded model and reasoning variations are captured when
            you save. Nothing goes to providers.
          </p>
          <Button
            variant="ghost"
            className="mt-2 w-full"
            disabled={pending}
            onClick={() => void dismiss()}
          >
            Skip this chat
          </Button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ArchiveFeedback() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<{
    prompt: Prompt | null;
    count: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(() => {
    const request = ++generation.current;
    rpc.call("pending").then(
      (value) => {
        if (request === generation.current) {
          setState(value);
          setError(null);
        }
      },
      (cause) => {
        if (request === generation.current) setError(errorText(cause));
      },
    );
  }, [rpc]);
  useEffect(() => {
    refresh();
    return () => {
      generation.current++;
    };
  }, [refresh]);
  useRealtime("changed", refresh);
  useRefreshOnReconnect(refresh);
  if (state?.prompt)
    return (
      <ArchivePrompt
        key={`${state.prompt.threadId}/${state.prompt.archivedAt}`}
        prompt={state.prompt}
        count={state.count}
        onDone={refresh}
      />
    );
  // Don't interrupt ordinary chats with a transport error. A reload retries pending prompts.
  if (error) return null;
  return null;
}

function Variations({ rating }: { rating: RatingSummary }) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">
        {rating.providerId} · {rating.variationCount} recorded variation
        {rating.variationCount === 1 ? "" : "s"}
      </p>
      <div className="flex flex-wrap gap-2">
        {rating.variations.map((v, index) => (
          <span
            key={index}
            className="rounded-md border border-border bg-muted/50 px-2 py-1 text-xs break-all"
          >
            <span className="font-mono">{v.model ?? "Unknown model"}</span> ·{" "}
            {v.reasoningLevel ?? "reasoning unknown"}{" "}
            <span className="text-muted-foreground">
              ({v.evidence}, {v.count})
            </span>
          </span>
        ))}
      </div>
      {rating.variationCount > rating.variations.length ? (
        <p className="text-xs text-muted-foreground">
          More variations in the full export.
        </p>
      ) : null}
      {rating.history.warnings.map((warning) => (
        <p key={warning} className="text-xs text-muted-foreground">
          {warning}
        </p>
      ))}
    </div>
  );
}

function RatingsPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [rows, setRows] = useState<RatingSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Rating | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const downloadTimers = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const [url, timer] of downloadTimers.current) {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
      }
      downloadTimers.current.clear();
    };
  }, []);
  const refresh = useCallback(() => {
    const request = ++generation.current;
    rpc.call("list", { offset }).then(
      (value) => {
        if (request === generation.current) {
          setRows(value.ratings);
          setTotal(value.total);
          setLoaded(true);
          setError(null);
        }
      },
      (cause) => {
        if (request === generation.current) setError(errorText(cause));
      },
    );
  }, [rpc, offset]);
  useEffect(() => {
    refresh();
    return () => {
      generation.current++;
    };
  }, [refresh]);
  useRealtime("changed", refresh);
  useRefreshOnReconnect(refresh);
  const exportRatings = async () => {
    setBusy(true);
    setError(null);
    try {
      const ratings: Rating[] = [];
      let afterThreadId = "";
      for (;;) {
        const { rating } = await rpc.call("exportPage", { afterThreadId });
        if (!mounted.current) return;
        if (!rating) break;
        if (rating.threadId <= afterThreadId)
          throw new Error("Export cursor did not advance.");
        ratings.push(rating);
        afterThreadId = rating.threadId;
      }
      const url = URL.createObjectURL(
        new Blob(
          [
            JSON.stringify(
              {
                schemaVersion: 1,
                exportedAt: new Date().toISOString(),
                ratings,
              },
              null,
              2,
            ),
          ],
          { type: "application/json" },
        ),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "chat-ratings.json";
      link.click();
      downloadTimers.current.set(
        url,
        setTimeout(() => {
          URL.revokeObjectURL(url);
          downloadTimers.current.delete(url);
        }, 1000),
      );
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-5 px-5 py-6 text-foreground">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Chat ratings</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Your feedback, kept local. {total} rated chat
              {total === 1 ? "" : "s"}.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={refresh}>
              Reload
            </Button>
            <Button
              variant="outline"
              disabled={busy || total === 0}
              onClick={() => void exportRatings()}
            >
              <Icon name="Download" className="size-4" />
              {busy ? "Working…" : "Export JSON"}
            </Button>
          </div>
        </header>
        <p className="text-sm text-muted-foreground">
          Ratings are offered after you archive a chat. Scores apply to the
          whole conversation, including all recorded model and reasoning
          variations, not to each model individually.
        </p>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {!loaded ? (
          <p role="status">Loading ratings…</p>
        ) : rows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No saved ratings here yet. Archive a chat to leave feedback.
          </div>
        ) : (
          rows.map((rating) => (
            <article
              key={rating.threadId}
              className="space-y-4 rounded-xl border border-border bg-card p-5"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="font-medium break-words">{rating.title}</h2>
                  <p className="mt-1 text-xs text-muted-foreground capitalize">
                    {rating.useCase} ·{" "}
                    {new Date(rating.updatedAt).toLocaleDateString()}
                  </p>
                </div>
                <span className="flex shrink-0 items-center gap-1 rounded-lg bg-primary/10 px-3 py-1 text-sm font-semibold">
                  <Icon name="Star" className="size-4" />
                  {rating.score}/5
                </span>
              </div>
              {rating.note ? (
                <p className="whitespace-pre-wrap break-words text-sm">
                  {rating.note}
                </p>
              ) : null}
              <Variations rating={rating} />
              <p className="text-xs text-muted-foreground">
                History captured{" "}
                {new Date(rating.history.capturedAt).toLocaleString()} · through
                metadata event {rating.history.throughSeq}
                {rating.history.status === "partial"
                  ? " · partial history"
                  : ""}
              </p>
              {editing?.threadId === rating.threadId ? (
                <div className="space-y-2 border-t border-border pt-4">
                  <FeedbackForm
                    key={editing.revision}
                    rating={editing}
                    pending={busy}
                    onSubmit={async (feedback) => {
                      setBusy(true);
                      setError(null);
                      try {
                        await rpc.call("editRating", {
                          ...feedback,
                          threadId: editing.threadId,
                          expectedRevision: editing.revision,
                        });
                        setEditing(null);
                        refresh();
                      } catch (cause) {
                        setError(errorText(cause));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  />
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setEditing(null)}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        const value = await rpc.call("getRating", {
                          threadId: rating.threadId,
                        });
                        if (!value)
                          throw new Error(
                            "Rating no longer exists. Reload the list.",
                          );
                        setEditing(value);
                      } catch (cause) {
                        setError(errorText(cause));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Edit feedback
                  </Button>
                  {deleting === rating.threadId ? (
                    <>
                      <span className="text-xs">Delete permanently?</span>
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          try {
                            await rpc.call("deleteRating", {
                              threadId: rating.threadId,
                              expectedRevision: rating.revision,
                            });
                            setDeleting(null);
                            refresh();
                          } catch (cause) {
                            setError(errorText(cause));
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        Confirm delete
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => setDeleting(null)}
                      >
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => setDeleting(rating.threadId)}
                    >
                      Delete
                    </Button>
                  )}
                </div>
              )}
            </article>
          ))
        )}
        {total > 20 || offset > 0 ? (
          <div className="flex items-center justify-between">
            <Button
              variant="outline"
              disabled={offset === 0}
              onClick={() => setOffset((value) => Math.max(0, value - 20))}
            >
              Previous
            </Button>
            <span className="text-xs text-muted-foreground">
              {offset + 1}–{Math.min(offset + rows.length, total)} of {total}
            </span>
            <Button
              variant="outline"
              disabled={offset + rows.length >= total}
              onClick={() => setOffset((value) => value + 20)}
            >
              Next
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({
    id: "archive-feedback",
    component: ArchiveFeedback,
  });
  app.slots.navPanel({
    id: "ratings",
    path: "ratings",
    title: "Chat ratings",
    icon: "Star",
    component: RatingsPage,
  });
});
