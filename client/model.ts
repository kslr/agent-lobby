import type { PaseoAgent, PaseoWorkspace } from "./paseo-types";

export type CrewState = "needs-input" | "failed" | "working" | "ready" | "idle" | "closed";

export const STATE_ORDER: readonly CrewState[] = [
  "needs-input",
  "failed",
  "working",
  "ready",
  "idle",
  "closed",
];

export const STATE_LABEL: Record<CrewState, string> = {
  "needs-input": "Needs you",
  failed: "Failed",
  working: "Working",
  ready: "Ready",
  idle: "Idle",
  closed: "Closed",
};

export const PARENT_LABEL = "paseo.parent-agent-id";
export const ROLE_LABEL = "ghostline/role";

export function crewState(agent: PaseoAgent): CrewState {
  if (agent.pendingPermissions.length > 0 || agent.attentionReason === "permission") {
    return "needs-input";
  }
  if (agent.status === "error" || agent.attentionReason === "error") return "failed";
  if (agent.status === "running" || agent.status === "initializing") return "working";
  if (agent.status === "closed") return "closed";
  if (agent.requiresAttention && agent.attentionReason === "finished") return "ready";
  return "idle";
}

export function parentAgentId(agent: PaseoAgent): string | null {
  const fromLabel = agent.labels[PARENT_LABEL];
  if (fromLabel) return fromLabel;
  const first = (agent as { parentAgentId?: string | null }).parentAgentId;
  return first ?? null;
}

export function roleOf(agent: PaseoAgent): string | null {
  const value = agent.labels[ROLE_LABEL];
  if (!value) return null;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function activityAt(agent: PaseoAgent): string {
  return agent.attentionTimestamp ?? agent.updatedAt;
}

export function formatAge(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 45_000) return "now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * When `formatAge` next says something else for this timestamp; null for one
 * it cannot read. A view that shows ages sleeps until then.
 */
export function nextAgeChange(iso: string, now: number): number | null {
  const then = Date.parse(iso);
  const ms = now - then;
  if (!Number.isFinite(ms)) return null;
  if (ms < 45_000) return then + 45_000;
  const minutes = Math.round(ms / 60_000);
  // Each unit is the rounding of the one below it, so its boundaries sit half a step early, twice over.
  let at: number;
  if (minutes < 60) at = (minutes + 0.5) * 60_000;
  else {
    const hours = Math.round(minutes / 60);
    if (hours < 24) at = ((hours + 0.5) * 60 - 0.5) * 60_000;
    else at = (((Math.round(hours / 24) + 0.5) * 24 - 0.5) * 60 - 0.5) * 60_000;
  }
  return then + Math.ceil(at);
}

export function displayTitle(agent: PaseoAgent): string {
  const title = agent.title?.trim();
  if (title) return title;
  return `${agent.provider} · ${agent.id.slice(0, 7)}`;
}

export function displayModel(agent: PaseoAgent): string {
  return agent.model ? `${agent.provider}/${agent.model}` : agent.provider;
}

export function matches(agent: PaseoAgent, query: string, workspaceName: string | null): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    agent.title ?? "",
    agent.id,
    agent.provider,
    agent.model ?? "",
    agent.cwd,
    workspaceName ?? "",
    ...Object.values(agent.labels),
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(needle);
}

export interface CrewNode {
  agent: PaseoAgent;
  state: CrewState;
  depth: number;
  children: CrewNode[];
  descendants: number;
}

function compareNodes(a: CrewNode, b: CrewNode): number {
  const rank = STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state);
  if (rank !== 0) return rank;
  const created = a.agent.createdAt.localeCompare(b.agent.createdAt);
  if (created !== 0) return created;
  return a.agent.id.localeCompare(b.agent.id);
}

/**
 * Builds the crew forest for one workspace, or for every workspace when
 * `workspaceId` is null. Managed children keep their crew even when they run
 * in another workspace. Archived agents never appear.
 */
export function buildForest(agents: Iterable<PaseoAgent>, workspaceId: string | null): CrewNode[] {
  const live = new Map<string, PaseoAgent>();
  for (const agent of agents) {
    if (agent.archivedAt) continue;
    live.set(agent.id, agent);
  }
  const childrenOf = new Map<string, PaseoAgent[]>();
  for (const agent of live.values()) {
    const parent = parentAgentId(agent);
    if (!parent || !live.has(parent)) continue;
    const bucket = childrenOf.get(parent) ?? [];
    bucket.push(agent);
    childrenOf.set(parent, bucket);
  }
  const members = new Set<string>();
  const seed = [...live.values()].filter(
    (agent) => workspaceId === null || agent.workspaceId === workspaceId,
  );
  const queue = [...seed];
  while (queue.length > 0) {
    const agent = queue.pop() as PaseoAgent;
    if (members.has(agent.id)) continue;
    members.add(agent.id);
    for (const child of childrenOf.get(agent.id) ?? []) queue.push(child);
  }
  const reached = new Set<string>();
  const build = (agent: PaseoAgent, depth: number, seen: Set<string>): CrewNode => {
    const next = new Set(seen).add(agent.id);
    reached.add(agent.id);
    const children = (childrenOf.get(agent.id) ?? [])
      .filter((child) => members.has(child.id) && !next.has(child.id))
      .map((child) => build(child, depth + 1, next))
      .sort(compareNodes);
    const descendants = children.reduce((sum, child) => sum + 1 + child.descendants, 0);
    return { agent, state: crewState(agent), depth, children, descendants };
  };
  const roots: CrewNode[] = [];
  for (const id of members) {
    const agent = live.get(id) as PaseoAgent;
    const parent = parentAgentId(agent);
    if (parent && members.has(parent)) continue;
    roots.push(build(agent, 0, new Set()));
  }
  // A parent cycle leaves members that no root reaches; surface them rather than lose them.
  for (const id of members) {
    if (reached.has(id)) continue;
    roots.push(build(live.get(id) as PaseoAgent, 0, new Set()));
  }
  return roots.sort(compareNodes);
}

export function flatten(roots: CrewNode[], collapsed: ReadonlySet<string>): CrewNode[] {
  const out: CrewNode[] = [];
  const walk = (node: CrewNode) => {
    out.push(node);
    if (collapsed.has(node.agent.id)) return;
    for (const child of node.children) walk(child);
  };
  for (const root of roots) walk(root);
  return out;
}

export function countStates(nodes: CrewNode[]): Record<CrewState, number> {
  const counts: Record<CrewState, number> = {
    "needs-input": 0,
    failed: 0,
    working: 0,
    ready: 0,
    idle: 0,
    closed: 0,
  };
  const walk = (node: CrewNode) => {
    counts[node.state] += 1;
    for (const child of node.children) walk(child);
  };
  for (const node of nodes) walk(node);
  return counts;
}

export function filterForest(
  roots: CrewNode[],
  keep: (node: CrewNode) => boolean,
): CrewNode[] {
  const prune = (node: CrewNode): CrewNode | null => {
    const children = node.children.map(prune).filter((child): child is CrewNode => child !== null);
    if (!keep(node) && children.length === 0) return null;
    return {
      ...node,
      children,
      descendants: children.reduce((sum, child) => sum + 1 + child.descendants, 0),
    };
  };
  return roots.map(prune).filter((node): node is CrewNode => node !== null);
}

export interface CrewGroup {
  workspaceId: string;
  name: string;
  roots: CrewNode[];
  counts: Record<CrewState, number>;
}

/** Groups roots by the workspace each root lives in. Groups needing attention come first. */
export function groupByWorkspace(
  roots: CrewNode[],
  workspaces: ReadonlyMap<string, PaseoWorkspace>,
): CrewGroup[] {
  const buckets = new Map<string, CrewNode[]>();
  for (const root of roots) {
    const id = root.agent.workspaceId ?? "";
    const bucket = buckets.get(id) ?? [];
    bucket.push(root);
    buckets.set(id, bucket);
  }
  const groups: CrewGroup[] = [];
  for (const [workspaceId, nodes] of buckets) {
    const workspace = workspaces.get(workspaceId);
    groups.push({
      workspaceId,
      name: workspace
        ? `${workspace.projectDisplayName} · ${workspace.name}`
        : workspaceId
          ? workspaceId.slice(0, 8)
          : "No workspace",
      roots: nodes,
      counts: countStates(nodes),
    });
  }
  const urgency = (group: CrewGroup) =>
    group.counts["needs-input"] > 0 ? 0 : group.counts.failed > 0 ? 1 : 2;
  const latest = (group: CrewGroup) =>
    Math.max(...group.roots.map((node) => Date.parse(activityAt(node.agent))));
  return groups.sort((a, b) => urgency(a) - urgency(b) || latest(b) - latest(a));
}

export function summary(counts: Record<CrewState, number>): string {
  const total = STATE_ORDER.reduce((sum, state) => sum + counts[state], 0);
  const parts = [`${total} ${total === 1 ? "agent" : "agents"}`];
  if (counts["needs-input"] > 0) parts.push(`${counts["needs-input"]} need you`);
  else if (counts.working > 0) parts.push(`${counts.working} working`);
  return parts.join(" · ");
}
