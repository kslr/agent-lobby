/**
 * The selected agent's recent chat, reduced to what a narrow, read-only view
 * can show: what a person typed, what the agent wrote, one line per tool call,
 * and a pointer to the full chat for anything else.
 *
 * A refetched page sets the state; live events from one subscription are
 * folded onto it in sequence order. Everything here is pure.
 */
import {
  agentMessageOf,
  toolLabel,
  toolWord,
  type ExchangeEvent,
  type HistoryEntryLike,
  type StreamPayloadLike,
  type TimelineItemLike,
  type ToolStatus,
} from "./exchanges";
import { isWanted } from "./feed-plan";
import type { CrewState } from "./model";

/** How many timeline items the chat keeps, and how many a refetch asks for. */
export const CHAT_ITEMS = 20;
/** How much of one message the chat keeps. The rest is a line pointing to the full chat. */
export const CHAT_TEXT_MAX = 2_000;
/** How much of a tool call's argument the chat keeps: one line. */
const SUMMARY_MAX = 120;

export type ChatItem =
  /** What somebody typed, as typed. Never read as a message from another agent, whatever it looks like. */
  | { kind: "user"; key: string; text: string; cut: boolean; messageId?: string }
  | { kind: "assistant"; key: string; text: string; cut: boolean; messageId?: string }
  | { kind: "tool"; key: string; callId: string; word: string; label: string; summary: string; status: ToolStatus }
  /** A message from another agent, with the sender the daemon verified. */
  | { kind: "message"; key: string; fromTitle: string | null; event: ExchangeEvent; text: string; cut: boolean }
  | { kind: "error"; key: string; text: string; cut: boolean }
  | { kind: "note"; key: string; text: string }
  /** Something this view does not draw; it says what, and points to the full chat. */
  | { kind: "elsewhere"; key: string; what: string };

export interface ChatState {
  items: readonly ChatItem[];
  /** Highest timeline sequence number applied; live events at or below it are already in. */
  cursor: number | null;
  epoch: string | null;
  /** True while the last item is an assistant message that live chunks still extend. */
  open: boolean;
  /** The daemon has more than the chat shows. */
  hasOlder: boolean;
}

export const EMPTY_CHAT: ChatState = { items: [], cursor: null, epoch: null, open: false, hasOlder: false };

/** The slice of a refetched page this module reads. */
export interface HistoryPageLike {
  epoch?: string;
  hasOlder?: boolean;
  window?: { maxSeq?: number };
  entries: ReadonlyArray<HistoryEntryLike & { seqStart?: number }>;
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** At most `max` UTF-16 units, never ending in half of a pair. */
export function bounded(text: string, max = CHAT_TEXT_MAX): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), cut: true };
}

/** The first line with something on it, whitespace collapsed, cut to `max`. */
function oneLine(value: unknown, max = SUMMARY_MAX): string {
  const raw = str(value);
  if (!raw) return "";
  // Bound the work before splitting: a command can be megabytes long.
  const head = raw.slice(0, max * 4);
  const line = head.split(/\r?\n/).find((candidate) => candidate.trim()) ?? "";
  const flat = line.replace(/\s+/g, " ").trim();
  const points = Array.from(flat);
  return points.length > max ? `${points.slice(0, max - 1).join("")}…` : flat;
}

/** `/a/b/c/file.ts` reads as `c/file.ts`. */
function shortPath(value: unknown): string {
  const path = str(value);
  if (!path) return "";
  const parts = path.split(/[\\/]/).filter(Boolean);
  return oneLine(parts.slice(-2).join("/"));
}

/** What a tool call was about, in one line: the command, the file, the query. */
export function toolSummary(detail: unknown): string {
  if (!detail || typeof detail !== "object") return "";
  const d = detail as Record<string, unknown>;
  switch (d.type) {
    case "shell":
      return oneLine(d.command);
    case "read":
    case "edit":
    case "write":
      return shortPath(d.filePath);
    case "search":
      return oneLine(d.query);
    case "fetch":
      return oneLine(d.url);
    case "sub_agent":
      return oneLine(d.description) || oneLine(d.subAgentType);
    case "plain_text":
      return oneLine(d.label) || oneLine(d.text);
    case "worktree_setup":
      return oneLine(d.branchName);
    default:
      return "";
  }
}

const TOOL_STATUSES: readonly string[] = ["running", "completed", "failed", "canceled"];

const EVENT_TEXT: Record<Exclude<ExchangeEvent, "message">, string> = {
  finished: "finished",
  errored: "failed",
  "permission-required": "needs permission",
  closed: "closed",
};

/** One timeline item as a chat item, or null for what the chat leaves out on purpose. */
export function chatItemOf(item: unknown, key: string): ChatItem | null {
  if (!item || typeof item !== "object") return { kind: "elsewhere", key, what: "Something" };
  const record = item as TimelineItemLike & Record<string, unknown>;
  switch (record.type) {
    case "user_message": {
      const typed = str(record.text);
      if (!typed?.trim()) return null;
      const messageId = str(record.messageId);
      return { kind: "user", key, ...bounded(typed), ...(messageId ? { messageId } : {}) };
    }
    case "assistant_message": {
      const said = str(record.text);
      if (said === null) return null;
      const messageId = str(record.messageId);
      return { kind: "assistant", key, ...bounded(said), ...(messageId ? { messageId } : {}) };
    }
    case "tool_call": {
      const message = agentMessageOf(record);
      if (message) {
        const body = message.event === "message" ? message.body : EVENT_TEXT[message.event];
        return { kind: "message", key: `message:${message.id}`, fromTitle: message.fromTitle, event: message.event, ...bounded(body) };
      }
      const callId = str(record.callId);
      const status = str(record.status);
      if (!callId) return { kind: "elsewhere", key, what: "A tool call" };
      const label = toolLabel(str(record.name) ?? "");
      return {
        kind: "tool",
        key: `tool:${callId}`,
        callId,
        word: toolWord(label),
        label,
        summary: toolSummary(record.detail),
        status: status && TOOL_STATUSES.includes(status) ? (status as ToolStatus) : "running",
      };
    }
    // Thinking is left out, as Paseo folds it away too.
    case "reasoning":
      return null;
    case "todo": {
      const tasks = Array.isArray(record.items) ? (record.items as unknown[]) : [];
      const done = tasks.filter((task) => (task as { completed?: unknown } | null)?.completed === true).length;
      return tasks.length > 0 ? { kind: "note", key: "todo", text: `Tasks: ${done} of ${tasks.length} done` } : null;
    }
    case "error": {
      const message = str(record.message);
      return { kind: "error", key, ...bounded(message?.trim() ? message : "Error") };
    }
    case "notification": {
      const message = oneLine(record.message, 200);
      return message ? { kind: "note", key, text: message } : null;
    }
    case "compaction":
      return record.status === "completed" ? { kind: "note", key, text: "Context compacted" } : null;
    case "plugin":
      return { kind: "elsewhere", key, what: oneLine(record.kind, 40) || "A plugin item" };
    default:
      return { kind: "elsewhere", key, what: "Something" };
  }
}

/** Places `next`: a tool call, a message or a task list already shown is updated where it is. */
function place(items: ChatItem[], next: ChatItem): void {
  if (next.kind === "note" && next.key === "todo") {
    const index = items.findIndex((item) => item.key === "todo");
    if (index >= 0) items.splice(index, 1);
    items.push(next);
    return;
  }
  if (next.kind === "tool" || next.kind === "message" || (next.kind === "user" && next.messageId)) {
    const index = items.findIndex(
      (item) =>
        item.key === next.key || (next.kind === "user" && item.kind === "user" && item.messageId === next.messageId),
    );
    if (index >= 0) {
      const before = items[index];
      // A later update can come without the arguments the first one had.
      items[index] = next.kind === "tool" && before?.kind === "tool" && !next.summary ? { ...next, summary: before.summary } : next;
      return;
    }
  }
  items.push(next);
}

const keep = (items: ChatItem[]): ChatItem[] => (items.length > CHAT_ITEMS ? items.slice(-CHAT_ITEMS) : items);

function trimmed(state: ChatState, items: ChatItem[], cursor: number | null, open: boolean): ChatState {
  const kept = keep(items);
  return { ...state, items: kept, cursor, open, hasOlder: state.hasOlder || kept.length < items.length };
}

/** A refetched page, oldest first, as the whole chat. */
export function chatFromHistory(page: HistoryPageLike): ChatState {
  const items: ChatItem[] = [];
  let cursor: number | null = null;
  for (const entry of page.entries ?? []) {
    const seq = typeof entry.seqStart === "number" ? entry.seqStart : entry.seqEnd;
    const item = chatItemOf(entry.item, `seq:${seq ?? items.length}`);
    if (typeof entry.seqEnd === "number") cursor = Math.max(cursor ?? entry.seqEnd, entry.seqEnd);
    if (item) place(items, item);
  }
  const maxSeq = page.window?.maxSeq;
  if (typeof maxSeq === "number") cursor = Math.max(cursor ?? maxSeq, maxSeq);
  const kept = keep(items);
  return {
    items: kept,
    cursor,
    epoch: str(page.epoch),
    open: kept[kept.length - 1]?.kind === "assistant",
    hasOlder: Boolean(page.hasOlder) || kept.length < items.length,
  };
}

/** What a live event asks of the view besides the new state. */
export interface ChatStep {
  state: ChatState;
  /** The timeline was replaced; what is shown is gone, and the page must be loaded again. */
  reload: boolean;
}

/** Folds one live event onto the chat. An event already applied changes nothing. */
export function reduceChat(state: ChatState, payload: StreamPayloadLike & { epoch?: string }): ChatStep {
  const { event } = payload;
  if (event.type === "replacement") {
    return { state: { ...EMPTY_CHAT, epoch: str(event.epoch) }, reload: true };
  }
  if (event.type === "subscription_restored") return { state, reload: true };
  if (payload.epoch && state.epoch && payload.epoch !== state.epoch) return { state, reload: false };
  if (typeof payload.seq === "number") {
    if (state.cursor !== null && payload.seq <= state.cursor) return { state, reload: false };
  }
  const cursor = typeof payload.seq === "number" ? payload.seq : state.cursor;
  switch (event.type) {
    case "timeline": {
      const items = [...state.items];
      const key = `seq:${payload.seq ?? `${items.length}:${payload.timestamp ?? ""}`}`;
      const item = chatItemOf(event.item, key);
      const last = items[items.length - 1];
      if (item?.kind === "assistant") {
        // A live assistant item is a chunk of the message being written.
        if (state.open && last?.kind === "assistant" && (!item.messageId || !last.messageId || item.messageId === last.messageId)) {
          if (last.cut) return { state: { ...state, cursor }, reload: false };
          items[items.length - 1] = { ...last, ...bounded(last.text + item.text) };
          return { state: { ...state, items, cursor }, reload: false };
        }
        if (!item.text) return { state: { ...state, cursor }, reload: false };
        items.push(item);
        return { state: trimmed(state, items, cursor, true), reload: false };
      }
      if (!item) {
        // Thinking between two stretches of text still parts them.
        return { state: { ...state, cursor, open: false }, reload: false };
      }
      // An update to something already shown does not part the message being written after it.
      const shown = item.key !== "todo" && items.some((existing) => existing.key === item.key);
      place(items, item);
      return { state: trimmed(state, items, cursor, shown ? state.open : false), reload: false };
    }
    case "turn_started":
    case "turn_completed":
    case "turn_canceled":
      return { state: { ...state, cursor, open: false }, reload: false };
    case "turn_failed": {
      const items = [...state.items];
      items.push({
        kind: "error",
        key: `failed:${payload.seq ?? items.length}:${payload.timestamp ?? ""}`,
        ...bounded(str(event.error)?.trim() || "Failed"),
      });
      return { state: trimmed(state, items, cursor, false), reload: false };
    }
    default:
      return { state, reload: false };
  }
}

/** A loaded page, then whatever arrived live while it was on its way. */
export function applyHistory(page: HistoryPageLike, arrived: readonly (StreamPayloadLike & { epoch?: string })[]): ChatStep {
  let state = chatFromHistory(page);
  let reload = false;
  for (const payload of arrived) {
    const step = reduceChat(state, payload);
    state = step.state;
    reload ||= step.reload;
  }
  return { state, reload };
}

export type ChatRow =
  | { kind: "item"; key: string; item: Exclude<ChatItem, { kind: "tool" }> }
  /** Tool calls in a row are one line: the latest, and how many came before it. */
  | { kind: "tools"; key: string; tools: Array<Extract<ChatItem, { kind: "tool" }>> };

export function chatRows(items: readonly ChatItem[]): ChatRow[] {
  const rows: ChatRow[] = [];
  for (const item of items) {
    const last = rows[rows.length - 1];
    if (item.kind === "tool") {
      if (last?.kind === "tools") last.tools.push(item);
      else rows.push({ kind: "tools", key: item.key, tools: [item] });
      continue;
    }
    // Several things the view cannot draw in a row are one pointer.
    if (item.kind === "elsewhere" && last?.kind === "item" && last.item.kind === "elsewhere") continue;
    rows.push({ kind: "item", key: item.key, item });
  }
  return rows;
}

/** What the chat should hold for the agent it shows. */
export interface ChatWant {
  agentId: string | null;
  /** The pane is shown. */
  shown: boolean;
  state: CrewState | null;
}

/** Live only for an agent that is producing a timeline, and only while it can be seen. */
export function wantsLive(want: ChatWant): boolean {
  return want.agentId !== null && want.shown && want.state !== null && isWanted(want.state);
}

export interface ChatActions {
  /** Give the subscription share back. */
  release: boolean;
  /** Take a share; the page is loaded once it is live, or at once if it cannot be. */
  acquire: boolean;
  /** Load the page now. */
  refetch: boolean;
  /** Forget what is shown: it belongs to another agent. */
  clear: boolean;
}

/**
 * What to do when what the chat should show changes. An idle or closed agent is
 * loaded once and not followed; one that starts working is followed; one that
 * stops is let go and loaded once more for the end of what it wrote.
 */
export function chatActions(previous: ChatWant, next: ChatWant, held: boolean): ChatActions {
  const none = { release: false, acquire: false, refetch: false, clear: false };
  if (next.agentId === null || !next.shown) {
    return { ...none, release: held, clear: next.agentId !== previous.agentId };
  }
  const live = wantsLive(next);
  const fresh = next.agentId !== previous.agentId || !previous.shown;
  if (fresh) {
    return { release: held, acquire: live, refetch: !live, clear: next.agentId !== previous.agentId };
  }
  if (live && !held && !wantsLive(previous)) return { ...none, acquire: true };
  if (!live && held) return { ...none, release: true, refetch: true };
  return none;
}
