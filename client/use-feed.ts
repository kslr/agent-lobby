import type { PaseoAgentTimelineEvent, PaseoApi } from "@getpaseo/client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  EMPTY_FEED,
  eventsFromHistory,
  eventsFromStream,
  reduceFeed,
  retainAgents,
  visibleFeed,
  type Bubble,
  type Exchange,
  type FeedEvent,
  type FeedState,
} from "./exchanges";
import { hubFor, type FeedHub } from "./feed-hub";
import { FEED_CAP, FEED_RETRY_MS, isWanted, planFeed, type FeedCandidate } from "./feed-plan";

/** Stream chunks arrive many times a second; the view hears about them this often. */
const FLUSH_MS = 150;
/**
 * What a new subscription reads of the past. A busy agent writes more than a handful of items
 * inside the lifetime of a bubble or a message, and a room scrolled into view has to show them.
 */
const BACKFILL_LIMIT = 20;

export interface Feed {
  /** agentId → the bubble over its head right now. */
  bubbles: ReadonlyMap<string, Bubble>;
  /** Messages in flight between agents right now, oldest first. */
  exchanges: readonly Exchange[];
  /** The agents this view has a live timeline for; everyone else is state only. */
  live: ReadonlySet<string>;
}

export interface FeedOptions {
  /** False releases every subscription, e.g. while the list view is showing. Defaults to true. */
  enabled?: boolean;
  cap?: number;
}

/** Every mounted Lobby view on this connection, bubbles and chat alike, draws on the same budget. */
export function timelineHub(paseo: PaseoApi): FeedHub<PaseoAgentTimelineEvent> {
  return hubFor<PaseoAgentTimelineEvent>(paseo, () => ({
    subscribe(agentId, handler) {
      const stop = paseo.agents.ref(agentId).timeline.subscribe(handler);
      return { stop: () => stop(), ready: stop.ready };
    },
  }));
}

/**
 * Live bubbles and exchanges for the agents a view is showing. Pass the agents
 * of the visible room; `planFeed` picks which of them this view wants, and the
 * hub grants them out of one budget shared by every mounted view.
 */
export function useFeed(paseo: PaseoApi, candidates: readonly FeedCandidate[], options?: FeedOptions): Feed {
  const enabled = options?.enabled ?? true;
  const cap = options?.cap ?? FEED_CAP;
  const [feed, setFeed] = useState<FeedState>(EMPTY_FEED);
  const [now, setNow] = useState(() => Date.now());
  const [live, setLive] = useState<ReadonlySet<string>>(() => new Set());

  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;
  const settings = useRef({ enabled, cap });
  settings.current = { enabled, cap };
  const sync = useRef<() => void>(() => {});

  useEffect(() => {
    let alive = true;
    const hub = timelineHub(paseo);
    const view = {};
    const subscriptions = new Map<string, { since: number; stop: () => void }>();
    const lastWanted = new Map<string, number>();
    const failed = new Map<string, number>();
    let pending: FeedEvent[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let recheckTimer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      flushTimer = null;
      const events = pending;
      pending = [];
      const at = Date.now();
      setNow(at);
      setFeed((current) => reduceFeed(current, events, at));
    };
    const enqueue = (events: FeedEvent[]) => {
      if (!alive || events.length === 0) return;
      pending.push(...events);
      flushTimer ??= setTimeout(flush, FLUSH_MS);
    };

    const backfill = (agentId: string) => {
      void paseo.agents
        .ref(agentId)
        .timeline.refetch({ direction: "tail", limit: BACKFILL_LIMIT, projection: "projected" })
        .then((page) => {
          if (subscriptions.has(agentId)) enqueue(eventsFromHistory(agentId, page.entries, Date.now()));
        })
        .catch(() => {});
    };

    const open = (agentId: string, rank: number) => {
      const entry = { since: Date.now(), stop: () => {} };
      const claim = {
        view,
        rank,
        // Another view was owed the slot. Ask again later; by then this view is at its share or the other has left.
        onRevoked() {
          if (subscriptions.get(agentId) !== entry) return;
          subscriptions.delete(agentId);
          failed.set(agentId, Date.now());
          sync.current();
        },
      };
      const lease = hub.acquire(agentId, (update) => {
        if (subscriptions.get(agentId) !== entry) return;
        switch (update.event.type) {
          case "error":
            // The SDK has already released the subscription.
            subscriptions.delete(agentId);
            failed.set(agentId, Date.now());
            sync.current();
            return;
          case "subscription_restored":
            backfill(agentId);
            return;
          case "replacement":
            enqueue(eventsFromStream(update, Date.now()));
            backfill(agentId);
            return;
          default:
            enqueue(eventsFromStream(update, Date.now()));
        }
      }, claim);
      if (!lease) {
        // The plugin-wide budget is spent, or the daemon refused: ask again after the retry delay.
        failed.set(agentId, Date.now());
        return;
      }
      entry.stop = lease.release;
      subscriptions.set(agentId, entry);
      // Live delivery only starts once the daemon confirms; what came before is history.
      lease.ready.then(() => backfill(agentId)).catch(() => {});
    };

    sync.current = () => {
      if (!alive) return;
      if (recheckTimer) clearTimeout(recheckTimer);
      recheckTimer = null;
      const at = Date.now();
      const visible = settings.current.enabled ? candidatesRef.current : [];
      for (const candidate of visible) {
        if (subscriptions.has(candidate.id) && isWanted(candidate.state)) lastWanted.set(candidate.id, at);
      }
      const plan = planFeed({
        candidates: visible,
        current: new Map([...subscriptions].map(([id, entry]) => [id, entry.since])),
        lastWanted,
        failed,
        now: at,
        // Disabled means released now, not after the linger.
        cap: settings.current.enabled ? settings.current.cap : 0,
      });
      for (const id of plan.unsubscribe) {
        subscriptions.get(id)?.stop();
        subscriptions.delete(id);
        lastWanted.delete(id);
      }
      for (const id of plan.subscribe) open(id, plan.selected.indexOf(id));
      // A refused agent is not in this plan's recheck; come back for it after the retry delay.
      const refused = plan.subscribe.some((id) => !subscriptions.has(id));
      const recheckAt = Math.min(plan.recheckAt ?? Infinity, refused ? at + FEED_RETRY_MS : Infinity);
      if (Number.isFinite(recheckAt)) {
        recheckTimer = setTimeout(() => sync.current(), Math.max(50, recheckAt - at));
      }
      const keep = new Set([...visible.map((candidate) => candidate.id), ...subscriptions.keys()]);
      setFeed((current) => retainAgents(current, keep));
      setLive((current) =>
        current.size === subscriptions.size && [...subscriptions.keys()].every((id) => current.has(id))
          ? current
          : new Set(subscriptions.keys()),
      );
    };
    sync.current();

    return () => {
      alive = false;
      sync.current = () => {};
      if (flushTimer) clearTimeout(flushTimer);
      if (recheckTimer) clearTimeout(recheckTimer);
      for (const entry of subscriptions.values()) entry.stop();
      subscriptions.clear();
    };
  }, [paseo]);

  // States and membership decide the plan; activity timestamps alone do not re-run it.
  const signature = candidates.map((candidate) => `${candidate.id}:${candidate.state}`).join("|");
  useEffect(() => {
    sync.current();
  }, [signature, enabled, cap]);

  const visible = useMemo(() => visibleFeed(feed, now), [feed, now]);
  const { nextExpiry } = visible;
  useEffect(() => {
    if (nextExpiry === null) return;
    const timer = setTimeout(() => {
      const at = Date.now();
      setNow(at);
      setFeed((current) => reduceFeed(current, [], at));
    }, Math.max(50, nextExpiry - Date.now()));
    return () => clearTimeout(timer);
  }, [nextExpiry]);

  return useMemo(
    () => ({ bubbles: visible.bubbles, exchanges: visible.exchanges, live }),
    [visible, live],
  );
}
