import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLUSH_MS, createChatController, type ChatSink } from "../client/chat-controller";
import type { ChatState, ChatWant, HistoryPageLike } from "../client/chat-model";
import { createFeedHub, type TimelineSource } from "../client/feed-hub";

interface Update {
  agentId: string;
  seq?: number;
  event: { type: string; item?: Record<string, unknown> };
}

const AT = "2026-10-15T03:00:00.000Z";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A daemon whose subscriptions confirm when the test says so, and whose pages arrive when it says so. */
function fakeDaemon() {
  const log: string[] = [];
  const live = new Map<string, (update: Update) => void>();
  const ready = new Map<string, ReturnType<typeof deferred<void>>>();
  const pages: Array<{ agentId: string; answer: ReturnType<typeof deferred<HistoryPageLike>> }> = [];
  const timeline: TimelineSource<Update> = {
    subscribe(agentId, handler) {
      log.push(`subscribe ${agentId}`);
      live.set(agentId, handler);
      const confirm = deferred<void>();
      ready.set(agentId, confirm);
      return {
        ready: confirm.promise,
        stop() {
          log.push(`release ${agentId}`);
          live.delete(agentId);
        },
      };
    },
  };
  const source = {
    refetch(agentId: string) {
      log.push(`refetch ${agentId}`);
      const answer = deferred<HistoryPageLike>();
      pages.push({ agentId, answer });
      return answer.promise;
    },
  };
  const say = (agentId: string, seq: number, text: string) =>
    live.get(agentId)?.({ agentId, seq, event: { type: "timeline", item: { type: "assistant_message", text, messageId: "m" } } });
  const page = (seq: number, text: string): HistoryPageLike => ({
    epoch: "e1",
    window: { maxSeq: seq },
    entries: [{ item: { type: "assistant_message", text, messageId: "m" }, timestamp: AT, seqStart: seq, seqEnd: seq }],
  });
  return { log, live, ready, pages, timeline, source, say, page };
}

function setup(cap?: number) {
  const daemon = fakeDaemon();
  const hub = createFeedHub(daemon.timeline, cap);
  const states: ChatState[] = [];
  const lives: boolean[] = [];
  const phases: string[] = [];
  const sink: ChatSink = { state: (state) => states.push(state), live: (live) => lives.push(live), phase: (phase) => phases.push(phase) };
  const chat = createChatController(daemon.source, hub, sink);
  const last = () => states[states.length - 1];
  const text = () => last()?.items.map((item) => ("text" in item ? item.text : item.kind)).join("|");
  return { daemon, hub, chat, states, lives, phases, last, text };
}

const flushPromises = () => vi.advanceTimersByTimeAsync(0);
const want = (agentId: string | null, state: ChatWant["state"], shown = true): ChatWant => ({ agentId, state, shown });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createChatController", () => {
  it("loads an idle agent once and subscribes to nothing", async () => {
    const { daemon, chat, phases, text } = setup();
    chat.update(want("idle", "idle"));
    expect(daemon.log).toEqual(["refetch idle"]);
    daemon.pages[0]?.answer.resolve(daemon.page(3, "Done."));
    await flushPromises();
    expect(text()).toBe("Done.");
    expect(phases).toContain("ready");
    chat.update(want("idle", "idle"));
    expect(daemon.log).toEqual(["refetch idle"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("subscribes to a working agent and loads it once the subscription is confirmed", async () => {
    const { daemon, chat, lives } = setup();
    chat.update(want("w", "working"));
    expect(daemon.log).toEqual(["subscribe w"]);
    expect(lives).toEqual([true]);
    daemon.ready.get("w")?.resolve();
    await flushPromises();
    expect(daemon.log).toEqual(["subscribe w", "refetch w"]);
  });

  it("applies what arrives while the page is on its way after the page, and batches the rest", async () => {
    const { daemon, chat, states, text } = setup();
    chat.update(want("w", "working"));
    daemon.ready.get("w")?.resolve();
    await flushPromises();
    daemon.say("w", 4, " more");
    daemon.pages[0]?.answer.resolve(daemon.page(3, "Work"));
    await flushPromises();
    expect(text()).toBe("Work more");
    const drawn = states.length;
    daemon.say("w", 5, " and");
    daemon.say("w", 6, " more");
    expect(states).toHaveLength(drawn);
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    expect(states).toHaveLength(drawn + 1);
    expect(text()).toBe("Work more and more");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets go of one agent before it takes the next, and drops the first one's late page", async () => {
    const { daemon, chat, text } = setup();
    chat.update(want("a", "working"));
    daemon.ready.get("a")?.resolve();
    await flushPromises();
    chat.update(want("b", "working"));
    expect(daemon.log).toEqual(["subscribe a", "refetch a", "release a", "subscribe b"]);
    daemon.pages[0]?.answer.resolve(daemon.page(9, "from a"));
    await flushPromises();
    expect(text()).toBe("");
  });

  it("stops batching when the agent is deselected: no timer and nothing drawn after", async () => {
    const { daemon, chat, states } = setup();
    chat.update(want("w", "working"));
    daemon.ready.get("w")?.resolve();
    await flushPromises();
    daemon.pages[0]?.answer.resolve(daemon.page(1, "Hi"));
    await flushPromises();
    daemon.say("w", 2, " there");
    expect(vi.getTimerCount()).toBe(1);
    chat.update(want(null, null));
    expect(daemon.log).toEqual(["subscribe w", "refetch w", "release w"]);
    expect(vi.getTimerCount()).toBe(0);
    const drawn = states.length;
    await vi.advanceTimersByTimeAsync(FLUSH_MS * 2);
    expect(states).toHaveLength(drawn);
  });

  it("holds and asks nothing while hidden, and loads again when shown", async () => {
    const { daemon, chat } = setup();
    chat.update(want("w", "working"));
    daemon.ready.get("w")?.resolve();
    await flushPromises();
    chat.update(want("w", "working", false));
    chat.update(want("w", "idle", false));
    chat.update(want("w", "working", false));
    expect(daemon.log).toEqual(["subscribe w", "refetch w", "release w"]);
    expect(vi.getTimerCount()).toBe(0);
    chat.update(want("w", "working"));
    expect(daemon.log.slice(3)).toEqual(["subscribe w"]);
  });

  it("lets go when the agent stops, with one last load", async () => {
    const { daemon, chat } = setup();
    chat.update(want("w", "working"));
    daemon.ready.get("w")?.resolve();
    await flushPromises();
    daemon.pages[0]?.answer.resolve(daemon.page(1, "x"));
    await flushPromises();
    chat.update(want("w", "idle"));
    expect(daemon.log).toEqual(["subscribe w", "refetch w", "release w", "refetch w"]);
  });

  it("is loaded, not followed, when the budget is spent, and asks again only on refresh", async () => {
    const { daemon, hub, chat, lives } = setup(1);
    hub.acquire("other", () => {}, { view: {}, rank: 0, onRevoked() {} });
    chat.update(want("w", "working"));
    // A view at its share keeps its slot: the chat goes without.
    expect(daemon.log).toEqual(["subscribe other", "refetch w"]);
    expect(lives).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    chat.refresh();
    expect(daemon.log.slice(2)).toEqual([]);
  });

  it("says it is no longer live on a subscription error, and keeps what it shows", async () => {
    const { daemon, chat, lives, text } = setup();
    chat.update(want("w", "working"));
    daemon.ready.get("w")?.resolve();
    await flushPromises();
    daemon.pages[0]?.answer.resolve(daemon.page(1, "kept"));
    await flushPromises();
    daemon.live.get("w")?.({ agentId: "w", event: { type: "error" } });
    expect(lives[lives.length - 1]).toBe(false);
    expect(text()).toBe("kept");
    chat.refresh();
    expect(daemon.log[daemon.log.length - 1]).toBe("subscribe w");
  });

  it("loads again on a restored subscription, and reports nothing once disposed", async () => {
    const { daemon, chat, states } = setup();
    chat.update(want("w", "working"));
    daemon.ready.get("w")?.resolve();
    await flushPromises();
    daemon.pages[0]?.answer.resolve(daemon.page(1, "x"));
    await flushPromises();
    daemon.live.get("w")?.({ agentId: "w", event: { type: "subscription_restored" } });
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    expect(daemon.log).toEqual(["subscribe w", "refetch w", "refetch w"]);
    chat.dispose();
    expect(daemon.log[daemon.log.length - 1]).toBe("release w");
    const drawn = states.length;
    daemon.pages[1]?.answer.resolve(daemon.page(2, "late"));
    await flushPromises();
    expect(states).toHaveLength(drawn);
    expect(vi.getTimerCount()).toBe(0);
  });
});
