import type { PaseoAgent, PaseoApi, PaseoWorkspace } from "./paseo-types";
import { useCallback, useEffect, useRef, useState } from "react";
import { HIDE_AFTER_MS, wakeDelay } from "./wake";

const PAGE_LIMIT = 200;
const MAX_PAGES = 10;
/**
 * The list subscription carries every change while the connection holds, and
 * says when it has been restored after a break: that is when updates can have
 * been lost (nothing is replayed), and everything is loaded again then. This
 * timer is only the last resort behind that: agents again, and the
 * subscription itself again if it failed, every five minutes.
 */
const BACKSTOP_MS = 5 * 60_000;
const WORKSPACE_DEBOUNCE_MS = 500;

export interface Directory {
  agents: ReadonlyMap<string, PaseoAgent>;
  workspaces: ReadonlyMap<string, PaseoWorkspace>;
  phase: "loading" | "ready" | "error";
  error: string | null;
  truncated: boolean;
  reload: () => void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fetchAgents(paseo: PaseoApi): Promise<{ agents: Map<string, PaseoAgent>; truncated: boolean }> {
  const agents = new Map<string, PaseoAgent>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await paseo.agents.list({
      filter: { includeArchived: false },
      sort: [{ key: "updated_at", direction: "desc" }],
      page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    });
    for (const entry of result.entries) agents.set(entry.agent.id, entry.agent);
    if (!result.pageInfo.hasMore || !result.pageInfo.nextCursor) return { agents, truncated: false };
    cursor = result.pageInfo.nextCursor;
  }
  return { agents, truncated: true };
}

export async function fetchWorkspaces(paseo: PaseoApi): Promise<Map<string, PaseoWorkspace>> {
  const workspaces = new Map<string, PaseoWorkspace>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await paseo.workspaces.list({
      page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    });
    for (const workspace of result.entries) workspaces.set(workspace.id, workspace);
    if (!result.pageInfo.hasMore || !result.pageInfo.nextCursor) break;
    cursor = result.pageInfo.nextCursor;
  }
  return workspaces;
}

/**
 * One full load, then live `agent_update` events from one list subscription
 * applied in place. The backstop refetch only guards against a missed event;
 * it is not the feed.
 *
 * While `shown` is false nothing is held: no subscription, no timer, no
 * request. What was loaded stays as it was, and showing again loads once.
 */
export function useDirectory(paseo: PaseoApi, shown = true): Directory {
  const [agents, setAgents] = useState<Map<string, PaseoAgent>>(() => new Map());
  const [workspaces, setWorkspaces] = useState<Map<string, PaseoWorkspace>>(() => new Map());
  const [phase, setPhase] = useState<Directory["phase"]>("loading");
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const generation = useRef(0);
  const known = useRef(workspaces);
  known.current = workspaces;

  const reload = useCallback(() => {
    const run = ++generation.current;
    void (async () => {
      try {
        const [loaded, loadedWorkspaces] = await Promise.all([fetchAgents(paseo), fetchWorkspaces(paseo)]);
        if (run !== generation.current) return;
        setAgents((current) => keepKnown(current, loaded.agents));
        setWorkspaces(loadedWorkspaces);
        setTruncated(loaded.truncated);
        setError(null);
        setPhase("ready");
      } catch (cause) {
        if (run !== generation.current) return;
        setError(message(cause));
        setPhase((current) => (current === "ready" ? "ready" : "error"));
      }
    })();
  }, [paseo]);

  useEffect(() => {
    if (!shown) return;
    reload();
    const asked = new Set<string>();
    const unsubscribeAgents = paseo.agents.subscribe((update) => {
      setAgents((current) => {
        const next = new Map(current);
        if (update.kind === "remove") {
          if (!next.delete(update.agentId)) return current;
          return next;
        }
        if (update.agent.archivedAt) {
          if (!next.delete(update.agent.id)) return current;
          return next;
        }
        next.set(update.agent.id, update.agent);
        return next;
      });
      // An agent in a workspace nobody has told us about: its event was missed, so ask, once for each.
      const workspaceId = update.kind === "remove" ? null : update.agent.workspaceId;
      if (workspaceId && !known.current.has(workspaceId) && !asked.has(workspaceId)) {
        asked.add(workspaceId);
        refreshWorkspaces();
      }
    });
    // `agents.subscribe` only hears what a subscribing list call brings in: without one, no
    // `agent_update` arrives at all. The page is irrelevant, the subscription follows the filter.
    let disposed = false;
    let feed: { release(): Promise<void> } | null = null;
    let opening = false;
    const openFeed = () => {
      if (disposed || feed || opening) return;
      opening = true;
      void paseo.agents
        .list({ filter: { includeArchived: false }, page: { limit: 1 }, subscribe: {} })
        .then((result) => {
          if (disposed) {
            void result.subscription.release().catch(() => {});
            return;
          }
          const mine = result.subscription;
          feed = mine;
          const first = result.subscriptionId;
          mine.subscribe({
            // The snapshot this call returned comes round once more here. Any other is the subscription
            // set up again after the connection came back: updates sent in between were not kept.
            snapshot(snapshot) {
              if (snapshot.subscriptionId !== first) reload();
            },
            update() {},
            // The SDK has released it; the timer below opens another.
            error() {
              if (feed === mine) feed = null;
            },
          });
        })
        .catch(() => {})
        .finally(() => {
          opening = false;
        });
    };
    openFeed();
    let workspaceTimer: ReturnType<typeof setTimeout> | null = null;
    const refreshWorkspaces = () => {
      if (workspaceTimer) clearTimeout(workspaceTimer);
      workspaceTimer = setTimeout(() => {
        workspaceTimer = null;
        void fetchWorkspaces(paseo).then(setWorkspaces).catch(() => {});
      }, WORKSPACE_DEBOUNCE_MS);
    };
    const unsubscribeWorkspaces = paseo.workspaces.subscribe(refreshWorkspaces);
    const backstop = setInterval(() => {
      openFeed();
      const run = generation.current;
      void fetchAgents(paseo)
        .then((loaded) => {
          // A reload since then has newer news.
          if (run !== generation.current) return;
          setAgents((current) => keepKnown(current, loaded.agents));
          setTruncated(loaded.truncated);
        })
        .catch(() => {});
    }, BACKSTOP_MS);
    return () => {
      generation.current += 1;
      disposed = true;
      void feed?.release().catch(() => {});
      unsubscribeAgents();
      unsubscribeWorkspaces();
      if (workspaceTimer) clearTimeout(workspaceTimer);
      clearInterval(backstop);
    };
  }, [paseo, reload, shown]);

  return { agents, workspaces, phase, error, truncated, reload };
}

/**
 * A refetch brings every agent as a new object. Whoever reads the same as
 * before keeps the object it had, and a refetch that brought nothing new keeps
 * the whole map, so that it draws nothing.
 */
function keepKnown(before: Map<string, PaseoAgent>, after: Map<string, PaseoAgent>): Map<string, PaseoAgent> {
  let same = before.size === after.size;
  const out = new Map<string, PaseoAgent>();
  for (const [id, agent] of after) {
    const known = before.get(id);
    const kept = known && JSON.stringify(known) === JSON.stringify(agent) ? known : agent;
    if (kept !== known) same = false;
    out.set(id, kept);
  }
  return same ? before : out;
}

/** Runs `onWake` once, just past `at`; nothing while `at` is null. `turn` re-arms it for the same moment. */
export function useWake(at: number | null, turn: number, onWake: () => void): void {
  const latest = useRef(onWake);
  latest.current = onWake;
  useEffect(() => {
    const delay = wakeDelay(at, Date.now());
    if (delay === null) return;
    const timer = setTimeout(() => latest.current(), delay);
    return () => clearTimeout(timer);
  }, [at, turn]);
}

/**
 * Whether the pane counts as shown: at once when it has a size, and only after
 * it has had none for `HIDE_AFTER_MS` when it has not.
 */
export function useShown(sized: boolean): boolean {
  const [held, setHeld] = useState(sized);
  useEffect(() => {
    if (sized) {
      setHeld(true);
      return;
    }
    // Nothing to let go of when it was not shown: a pane not laid out yet starts no timer.
    if (!held) return;
    const timer = setTimeout(() => setHeld(false), HIDE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [sized, held]);
  return sized || held;
}
