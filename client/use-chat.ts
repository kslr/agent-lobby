import type { PaseoAgentTimelineEvent, PaseoApi } from "@getpaseo/client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CHAT_PAGE,
  EMPTY_CHAT,
  applyHistory,
  chatActions,
  reduceChat,
  wantsLive,
  type ChatState,
  type ChatWant,
} from "./chat-model";
import type { Lease } from "./feed-hub";
import type { CrewState } from "./model";
import { timelineHub } from "./use-feed";

/** Stream chunks arrive many times a second; the chat is drawn again this often. */
const FLUSH_MS = 100;

export interface Chat {
  state: ChatState;
  phase: "loading" | "ready" | "error";
  /** The agent is working or waiting, so the chat should be live. */
  wanted: boolean;
  /** The chat holds a share of the agent's subscription. False while wanted means the budget was spent or the subscription lost. */
  live: boolean;
  /** Loads the page again, and asks to be live again if it should be. */
  refresh: () => void;
}

type Update = PaseoAgentTimelineEvent;

/**
 * The selected agent's recent chat. One tail refetch when it is selected or shown
 * again; a live share of its timeline from the plugin-wide hub only while it is
 * working or waiting on you, given back on deselect, on another agent, when it
 * goes idle and when the pane is hidden. Nothing is written to the agent.
 */
export function useChat(paseo: PaseoApi, agentId: string | null, crewState: CrewState | null, shown: boolean): Chat {
  const [state, setState] = useState<ChatState>(EMPTY_CHAT);
  const [phase, setPhase] = useState<Chat["phase"]>("loading");
  const [live, setLive] = useState(false);
  const control = useRef<{ update(want: ChatWant): void; refresh(): void } | null>(null);
  const want: ChatWant = { agentId, shown, state: crewState };

  useEffect(() => {
    const hub = timelineHub(paseo);
    // The chat is a view of its own: it has its share of the budget whatever the bubbles hold.
    const view = {};
    let alive = true;
    let current: ChatState = EMPTY_CHAT;
    let wanted: ChatWant = { agentId: null, shown: false, state: null };
    let lease: Lease | null = null;
    // Bumped whenever what is shown stops being the agent's: late answers are dropped.
    let generation = 0;
    let loading: { generation: number; arrived: Update[]; again: boolean } | null = null;
    let pending: Update[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const show = (next: ChatState) => {
      current = next;
      if (alive) setState(next);
    };

    const refetch = () => {
      const target = wanted.agentId;
      if (!alive || !target || !wanted.shown) return;
      if (loading && loading.generation === generation) {
        loading.again = true;
        return;
      }
      const mine = { generation, arrived: [] as Update[], again: false };
      loading = mine;
      // What was queued for the screen is in the page or comes after it.
      mine.arrived.push(...pending);
      pending = [];
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      void paseo.agents
        .ref(target)
        .timeline.refetch({ direction: "tail", limit: CHAT_PAGE, projection: "projected" })
        .then(
          (page) => {
            if (loading !== mine) return;
            loading = null;
            const step = applyHistory(page, mine.arrived);
            show(step.state);
            if (alive) setPhase("ready");
            if (step.reload || mine.again) refetch();
          },
          () => {
            if (loading !== mine) return;
            loading = null;
            // What arrived is still worth showing on what was there.
            let state = current;
            for (const update of mine.arrived) state = reduceChat(state, update).state;
            show(state);
            if (alive) setPhase(current.items.length > 0 ? "ready" : "error");
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
      if (alive) setLive(false);
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
          if (alive) setLive(false);
          return;
        }
        if (loading && loading.generation === generation) {
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
          if (alive) setLive(false);
        },
      });
      if (!mine) {
        // The budget is spent: the chat is loaded, not followed.
        refetch();
        return;
      }
      lease = mine;
      if (alive) setLive(true);
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

    control.current = {
      update(next) {
        const actions = chatActions(wanted, next, lease !== null);
        wanted = next;
        if (actions.release) release();
        if (actions.clear) {
          generation += 1;
          loading = null;
          show(EMPTY_CHAT);
          if (alive) setPhase("loading");
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
    };

    return () => {
      alive = false;
      control.current = null;
      release();
      loading = null;
    };
  }, [paseo]);

  useEffect(() => {
    control.current?.update({ agentId, shown, state: crewState });
  }, [paseo, agentId, shown, crewState]);

  const refresh = useCallback(() => control.current?.refresh(), []);
  return { state, phase, wanted: wantsLive(want), live, refresh };
}
