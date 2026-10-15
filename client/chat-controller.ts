import {
  EMPTY_CHAT,
  applyHistory,
  chatActions,
  reduceChat,
  wantsLive,
  type ChatState,
  type ChatWant,
  type HistoryPageLike,
} from "./chat-model";
import type { FeedHub, Lease } from "./feed-hub";

/** Stream chunks arrive many times a second; the chat is drawn again this often. */
export const FLUSH_MS = 100;

type Payload = Parameters<typeof reduceChat>[1];

export interface ChatSource {
  /** The tail page of the agent's timeline. */
  refetch(agentId: string): Promise<HistoryPageLike>;
}

/** Where the controller reports what the view draws. */
export interface ChatSink {
  state(state: ChatState): void;
  phase(phase: "loading" | "ready" | "error"): void;
  live(live: boolean): void;
}

export interface ChatController {
  /** What the chat should show now; it works out what to hold, release and load. */
  update(want: ChatWant): void;
  /** Loads the page again, and asks to be live again if it should be. */
  refresh(): void;
  /** Lets go of everything; nothing is reported after. */
  dispose(): void;
}

/**
 * The chat's side effects, apart from React: one lease from `hub` while the agent
 * should be live, tail refetches at the moments `chatActions` names, live events
 * queued while a page is on its way and drawn at most every `FLUSH_MS`.
 */
export function createChatController<Update extends Payload>(
  source: ChatSource,
  hub: FeedHub<Update>,
  sink: ChatSink,
): ChatController {
  // The chat is a view of its own: it has its share of the budget whatever the bubbles hold.
  const view = {};
  let alive = true;
  let current: ChatState = EMPTY_CHAT;
  let wanted: ChatWant = { agentId: null, shown: false, state: null };
  let lease: Lease | null = null;
  // The page on its way. Forgotten when what is shown stops being the agent's, so its late answer is dropped.
  let loading: { arrived: Update[]; again: boolean } | null = null;
  let pending: Update[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const show = (next: ChatState) => {
    current = next;
    if (alive) sink.state(next);
  };

  const refetch = () => {
    const target = wanted.agentId;
    if (!alive || !target || !wanted.shown) return;
    if (loading) {
      loading.again = true;
      return;
    }
    const mine = { arrived: [] as Update[], again: false };
    loading = mine;
    // What was queued for the screen is in the page or comes after it.
    mine.arrived.push(...pending);
    pending = [];
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    void source
      .refetch(target)
      .then(
        (page) => {
          if (loading !== mine) return;
          loading = null;
          const step = applyHistory(page, mine.arrived);
          show(step.state);
          if (alive) sink.phase("ready");
          if (step.reload || mine.again) refetch();
        },
        () => {
          if (loading !== mine) return;
          loading = null;
          // What arrived is still worth showing on what was there.
          let state = current;
          for (const update of mine.arrived) state = reduceChat(state, update).state;
          show(state);
          if (alive) sink.phase(current.items.length > 0 ? "ready" : "error");
        },
      );
  };

  const flush = () => {
    flushTimer = null;
    const updates = pending;
    pending = [];
    let state = current;
    let reload = false;
    for (const update of updates) {
      const step = reduceChat(state, update);
      state = step.state;
      reload ||= step.reload;
    }
    show(state);
    if (reload) refetch();
  };

  const release = () => {
    lease?.release();
    lease = null;
    pending = [];
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    if (alive) sink.live(false);
  };

  const acquire = () => {
    const target = wanted.agentId;
    if (!target) return;
    let mine: Lease | null = null;
    const onUpdate = (update: Update) => {
      if (lease !== mine || !mine) return;
      if (update.event.type === "error") {
        // The SDK has already let the subscription go; what was loaded stays.
        lease = null;
        if (alive) sink.live(false);
        return;
      }
      if (loading) {
        loading.arrived.push(update);
        return;
      }
      pending.push(update);
      flushTimer ??= setTimeout(flush, FLUSH_MS);
    };
    mine = hub.acquire(target, onUpdate, {
      view,
      rank: 0,
      // Another Lobby view was owed the slot. The chat keeps what it has and says it is no longer live.
      onRevoked() {
        if (lease !== mine) return;
        lease = null;
        if (alive) sink.live(false);
      },
    });
    if (!mine) {
      // The budget is spent: the chat is loaded, not followed.
      refetch();
      return;
    }
    lease = mine;
    if (alive) sink.live(true);
    const held = mine;
    // Live delivery only starts once the daemon confirms; what came before is in the page.
    held.ready.then(
      () => {
        if (lease === held) refetch();
      },
      () => {
        if (lease !== held) return;
        release();
        refetch();
      },
    );
  };

  return {
    update(next) {
      const actions = chatActions(wanted, next, lease !== null);
      wanted = next;
      if (actions.release) release();
      if (actions.clear) {
        loading = null;
        show(EMPTY_CHAT);
        if (alive) sink.phase("loading");
      }
      if (!next.shown) {
        // Hidden: nothing held, nothing asked, no timer.
        pending = [];
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (actions.acquire) acquire();
      if (actions.refetch) refetch();
    },
    refresh() {
      if (wantsLive(wanted) && !lease) acquire();
      else refetch();
    },
    dispose() {
      alive = false;
      release();
      loading = null;
    },
  };

}
