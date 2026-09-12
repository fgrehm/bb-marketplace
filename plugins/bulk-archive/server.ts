import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const threadSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  parentThreadId: z.string().nullable(),
  status: z.enum(["active", "error", "idle", "pending", "starting", "stopping"]),
  createdAt: z.number(),
  updatedAt: z.number(),
  latestAttentionAt: z.number(),
  hasPendingInteraction: z.boolean(),
  environmentName: z.string().nullable(),
  projectName: z.string(),
});
const projectSchema = z.object({ id: z.string(), name: z.string(), kind: z.enum(["personal", "standard"]) });
const archiveFailureSchema = z.object({ threadId: z.string(), message: z.string() });

export type ArchiveThread = z.infer<typeof threadSchema>;

export const rpcContract = defineRpcContract({
  threads_list: {
    input: z.object({ projectId: z.string().nullable().default(null) }).strict(),
    output: z.object({ threads: z.array(threadSchema), projects: z.array(projectSchema) }),
  },
  threads_archive: {
    input: z.object({ threadIds: z.array(z.string()).min(1).max(500) }).strict(),
    output: z.object({
      requestedCount: z.number().int().nonnegative(),
      archivedThreadIds: z.array(z.string()),
      failures: z.array(archiveFailureSchema),
    }),
  },
});

const THREADS_CHANGED = "bulk-archive.threads-changed";

export default async function plugin(bb: BbPluginApi) {
  async function activeThreads() {
    const threads: Awaited<ReturnType<typeof bb.sdk.threads.list>> = [];
    const pageSize = 100;
    for (let offset = 0; offset < 5_000; offset += pageSize) {
      const page = await bb.sdk.threads.list({ archived: false, includeHidden: false, limit: pageSize, offset });
      threads.push(...page);
      if (page.length < pageSize) break;
    }
    return threads;
  }

  bb.rpc.register(rpcContract, {
    async threads_list({ projectId }) {
      const [threads, projects] = await Promise.all([
        activeThreads(),
        bb.sdk.projects.list({ includePersonal: true }),
      ]);
      const projectNames = new Map(projects.map((project) => [project.id, project.name]));
      return {
        threads: threads
          .filter((thread) => projectId === null || thread.projectId === projectId)
          .map((thread) => ({
            id: thread.id,
            projectId: thread.projectId,
            title: thread.title ?? thread.titleFallback ?? "Untitled thread",
            parentThreadId: thread.parentThreadId,
            status: thread.status,
            createdAt: thread.createdAt,
            updatedAt: thread.updatedAt,
            latestAttentionAt: thread.latestAttentionAt,
            hasPendingInteraction: thread.hasPendingInteraction,
            environmentName: thread.environmentName,
            projectName: projectNames.get(thread.projectId) ?? "Unknown project",
          }))
          .sort((a, b) => b.latestAttentionAt - a.latestAttentionAt),
        projects: projects.map((project) => ({ id: project.id, name: project.name, kind: project.kind })),
      };
    },

    async threads_archive({ threadIds }) {
      const requested = new Set(threadIds);
      const threads = await activeThreads();
      const byId = new Map(threads.map((thread) => [thread.id, thread]));
      const selected = [...requested].filter((id) => byId.has(id));

      // Archiving a parent cascades to its descendants. Do not repeat archive
      // requests for explicitly selected children, which makes results clearer.
      const roots = selected.filter((id) => {
        let parentId = byId.get(id)?.parentThreadId ?? null;
        while (parentId !== null) {
          if (requested.has(parentId)) return false;
          parentId = byId.get(parentId)?.parentThreadId ?? null;
        }
        return true;
      });

      const archivedThreadIds = new Set<string>();
      const failures: Array<{ threadId: string; message: string }> = [];
      for (const threadId of roots) {
        try {
          const result = await bb.sdk.threads.archive({ threadId });
          result.archivedThreadIds.forEach((id) => archivedThreadIds.add(id));
        } catch (cause) {
          failures.push({
            threadId,
            message: cause instanceof Error ? cause.message : "Unable to archive this thread.",
          });
        }
      }

      bb.realtime.publish(THREADS_CHANGED, { archivedCount: archivedThreadIds.size });
      return {
        requestedCount: threadIds.length,
        archivedThreadIds: [...archivedThreadIds],
        failures,
      };
    },
  });

  bb.log.info("Bulk Archive loaded");
}
