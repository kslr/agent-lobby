import { describe, expect, it } from "vitest";
import { createFeedHub, hubFor, type TimelineSource } from "../client/feed-hub";
import { FEED_CAP } from "../client/feed-plan";

interface Update {
  agentId: string;
  event: { type: string };
}

function fakeDaemon(failFor: readonly string[] = []) {
  const live = new Map<string, (update: Update) => void>();
  const opened: string[] = [];
  const stopped: string[] = [];
  const source: TimelineSource<Update> = {
    subscribe(agentId, handler) {
      if (failFor.includes(agentId)) throw new Error("disposed");
      opened.push(agentId);
      live.set(agentId, handler);
      return {
        ready: Promise.resolve(),
        stop() {
          stopped.push(agentId);
          live.delete(agentId);
        },
      };
    },
  };
  const emit = (agentId: string, type = "timeline") => live.get(agentId)?.({ agentId, event: { type } });
  return { source, emit, opened, stopped, live };
}

describe("createFeedHub", () => {
  it("opens one subscription for two views watching the same agent, and closes it when both leave", () => {
    const daemon = fakeDaemon();
    const hub = createFeedHub(daemon.source);
    const seen: string[] = [];
    const panel = hub.acquire("a", () => seen.push("panel"));
    const surface = hub.acquire("a", () => seen.push("surface"));
    expect(daemon.opened).toEqual(["a"]);
    expect(hub.size()).toBe(1);
    daemon.emit("a");
    expect(seen).toEqual(["panel", "surface"]);
    panel?.release();
    panel?.release();
    expect(daemon.stopped).toEqual([]);
    daemon.emit("a");
    expect(seen).toEqual(["panel", "surface", "surface"]);
    surface?.release();
    expect(daemon.stopped).toEqual(["a"]);
    expect(hub.size()).toBe(0);
  });

  it("holds every view together to the cap", () => {
    const daemon = fakeDaemon();
    const hub = createFeedHub(daemon.source);
    const leases = Array.from({ length: 30 }, (_, index) => hub.acquire(`agent-${index}`, () => {}));
    expect(leases.filter(Boolean)).toHaveLength(FEED_CAP);
    expect(daemon.opened).toHaveLength(FEED_CAP);
    // A share of something already open is free; a new agent has to wait for a slot.
    expect(hub.acquire("agent-0", () => {})).not.toBeNull();
    expect(hub.acquire("late", () => {})).toBeNull();
    leases[0]?.release();
    expect(hub.acquire("late", () => {})).toBeNull();
    expect(createFeedHub(daemon.source, 2).acquire("x", () => {})).not.toBeNull();
  });

  it("frees the slot when the last holder leaves", () => {
    const daemon = fakeDaemon();
    const hub = createFeedHub(daemon.source, 1);
    const first = hub.acquire("a", () => {});
    expect(hub.acquire("b", () => {})).toBeNull();
    first?.release();
    expect(hub.acquire("b", () => {})).not.toBeNull();
    expect(daemon.stopped).toEqual(["a"]);
  });

  it("tells every holder about an error, forgets the subscription, and does not stop it twice", () => {
    const daemon = fakeDaemon();
    const hub = createFeedHub(daemon.source);
    const seen: string[] = [];
    const one = hub.acquire("a", (update) => seen.push(`one:${update.event.type}`));
    const two = hub.acquire("a", (update) => seen.push(`two:${update.event.type}`));
    daemon.emit("a", "error");
    expect(seen).toEqual(["one:error", "two:error"]);
    expect(hub.size()).toBe(0);
    one?.release();
    two?.release();
    expect(daemon.stopped).toEqual([]);
    // It can be opened afresh afterwards.
    expect(hub.acquire("a", () => {})).not.toBeNull();
    expect(daemon.opened).toEqual(["a", "a"]);
  });

  it("gives nothing when the subscription cannot be opened, and spends no slot on it", () => {
    const daemon = fakeDaemon(["broken"]);
    const hub = createFeedHub(daemon.source, 1);
    expect(hub.acquire("broken", () => {})).toBeNull();
    expect(hub.size()).toBe(0);
    expect(hub.acquire("fine", () => {})).not.toBeNull();
  });

  it("lets a holder release from inside its own handler", () => {
    const daemon = fakeDaemon();
    const hub = createFeedHub(daemon.source);
    const seen: string[] = [];
    const first = hub.acquire("a", () => {
      seen.push("first");
      first?.release();
    });
    hub.acquire("a", () => seen.push("second"));
    daemon.emit("a");
    daemon.emit("a");
    expect(seen).toEqual(["first", "second", "second"]);
  });
});

describe("two views contending", () => {
  function view(hub: ReturnType<typeof createFeedHub<Update>>, name: string) {
    const token = {};
    const has = new Map<string, { release(): void }>();
    const revoked: string[] = [];
    const want = (agentId: string, rank: number) => {
      const lease = hub.acquire(agentId, () => {}, {
        view: token,
        rank,
        onRevoked() {
          has.delete(agentId);
          revoked.push(agentId);
        },
      });
      if (lease) has.set(agentId, lease);
      return lease !== null;
    };
    return { name, has, revoked, want };
  }

  it("gives a second view a share of a spent budget, taking the first view's least wanted agents", () => {
    const daemon = fakeDaemon();
    const hub = createFeedHub(daemon.source, 8);
    const surface = view(hub, "surface");
    for (let rank = 0; rank < 8; rank += 1) expect(surface.want(`s${rank}`, rank)).toBe(true);
    expect(surface.want("s8", 8)).toBe(false);

    const panel = view(hub, "panel");
    for (let rank = 0; rank < 6; rank += 1) panel.want(`p${rank}`, rank);
    // Half each, the total never over the cap.
    expect([...panel.has.keys()]).toEqual(["p0", "p1", "p2", "p3"]);
    expect(surface.revoked).toEqual(["s7", "s6", "s5", "s4"]);
    expect([...surface.has.keys()]).toEqual(["s0", "s1", "s2", "s3"]);
    expect(hub.size()).toBe(8);
    expect(daemon.stopped).toEqual(["s7", "s6", "s5", "s4"]);
  });

  it("does not pass a slot back and forth", () => {
    const daemon = fakeDaemon();
    const hub = createFeedHub(daemon.source, 4);
    const first = view(hub, "first");
    const second = view(hub, "second");
    for (let rank = 0; rank < 4; rank += 1) first.want(`a${rank}`, rank);
    second.want("b0", 0);
    second.want("b1", 1);
    const settled = [...daemon.opened];
    // Both at their share: whoever retries what it lost is refused, and nothing is opened or closed.
    for (let round = 0; round < 5; round += 1) {
      for (const agentId of first.revoked) expect(first.want(agentId, 9)).toBe(false);
      expect(second.want("b2", 2)).toBe(false);
    }
    expect(daemon.opened).toEqual(settled);
    expect(first.has.size).toBe(2);
    expect(second.has.size).toBe(2);
  });

  it("leaves a shared agent alone and gives slots back when a view leaves", () => {
    const daemon = fakeDaemon();
    const hub = createFeedHub(daemon.source, 2);
    const first = view(hub, "first");
    const second = view(hub, "second");
    first.want("shared", 0);
    first.want("mine", 1);
    // Sharing what is already open costs nothing.
    expect(second.want("shared", 0)).toBe(true);
    expect(hub.size()).toBe(2);
    // The second view has its share of one; it may not take more.
    expect(second.want("other", 1)).toBe(false);
    expect(first.revoked).toEqual([]);
    for (const lease of first.has.values()) lease.release();
    expect(hub.size()).toBe(1);
    expect(second.want("other", 1)).toBe(true);
  });

  it("grants a late view one slot from a view above its share, and refuses a third when everyone is at one", () => {
    const daemon = fakeDaemon();
    const hub = createFeedHub(daemon.source, 2);
    const first = view(hub, "first");
    first.want("a", 0);
    first.want("b", 1);
    const second = view(hub, "second");
    expect(second.want("c", 0)).toBe(true);
    expect(first.revoked).toEqual(["b"]);
    // A third view finds everyone at one each: nobody is above their share, so it waits.
    const third = view(hub, "third");
    expect(third.want("d", 0)).toBe(false);
    expect(hub.size()).toBe(2);
  });
});

describe("a slot taken for a subscription that cannot be opened", () => {
  it("goes back to the view it was taken from, which loses nothing", () => {
    const daemon = fakeDaemon(["broken"]);
    const hub = createFeedHub(daemon.source, 2);
    const seen: string[] = [];
    const revoked: string[] = [];
    const first = {};
    const keep = (agentId: string, rank: number) =>
      hub.acquire(agentId, (update) => seen.push(`${agentId}:${update.event.type}`), { view: first, rank, onRevoked: () => revoked.push(agentId) });
    const a = keep("a", 0);
    const b = keep("b", 1);
    expect(hub.acquire("broken", () => {}, { view: {}, rank: 0, onRevoked() {} })).toBeNull();
    expect(revoked).toEqual([]);
    expect(hub.size()).toBe(2);
    // The slot was closed and opened again; its holder still hears it, and can still give it up.
    expect(daemon.stopped).toEqual(["b"]);
    expect(daemon.opened).toEqual(["a", "b", "b"]);
    daemon.emit("b");
    daemon.emit("a");
    expect(seen).toEqual(["b:timeline", "a:timeline"]);
    b?.release();
    expect(hub.size()).toBe(1);
    expect(daemon.stopped).toEqual(["b", "b"]);
    a?.release();
    expect(hub.size()).toBe(0);
  });

  it("is lost only when it cannot be reopened either, and its holder is told", () => {
    const daemon = fakeDaemon();
    const flaky = { ...daemon.source };
    let refuse = false;
    flaky.subscribe = (agentId, handler) => {
      if (refuse) throw new Error("gone");
      return daemon.source.subscribe(agentId, handler);
    };
    const hub = createFeedHub(flaky, 1);
    const revoked: string[] = [];
    hub.acquire("a", () => {}, { view: {}, rank: 0, onRevoked: () => revoked.push("a") });
    const again = hub.acquire("a2", () => {}, { view: {}, rank: 0, onRevoked() {} });
    // One view at its share of one: nothing to take.
    expect(again).toBeNull();
    expect(revoked).toEqual([]);
    const two = createFeedHub(flaky, 2);
    const owner = {};
    two.acquire("x", () => {}, { view: owner, rank: 0, onRevoked() {} });
    two.acquire("y", () => {}, { view: owner, rank: 1, onRevoked: () => revoked.push("y") });
    refuse = true;
    expect(two.acquire("z", () => {}, { view: {}, rank: 0, onRevoked() {} })).toBeNull();
    expect(revoked).toEqual(["y"]);
    expect(two.size()).toBe(1);
  });
});

describe("hubFor", () => {
  it("gives one hub per connection", () => {
    const daemon = fakeDaemon();
    const connection = {};
    const hub = hubFor(connection, () => daemon.source);
    expect(hubFor(connection, () => fakeDaemon().source)).toBe(hub);
    expect(hubFor({}, () => daemon.source)).not.toBe(hub);
  });
});

describe("the chat beside the bubbles", () => {
  const claim = (view: object, revoked: string[] = [], name = "") => ({ view, rank: 0, onRevoked: () => revoked.push(name) });

  it("shares the subscription the bubbles already hold, and leaves it open for them", () => {
    const daemon = fakeDaemon();
    const hub = createFeedHub(daemon.source);
    const bubbles = {};
    const chat = {};
    const bubble = hub.acquire("a", () => {}, claim(bubbles));
    const lease = hub.acquire("a", () => {}, claim(chat));
    expect(lease).not.toBeNull();
    expect(daemon.opened).toEqual(["a"]);
    lease?.release();
    expect(daemon.stopped).toEqual([]);
    bubble?.release();
    expect(daemon.stopped).toEqual(["a"]);
  });

  it("takes a slot from bubbles that hold the whole budget, and never carries more than the cap", () => {
    const daemon = fakeDaemon();
    const hub = createFeedHub(daemon.source);
    const bubbles = {};
    const revoked: string[] = [];
    for (let index = 0; index < FEED_CAP; index += 1) {
      expect(hub.acquire(`b${index}`, () => {}, { view: bubbles, rank: index, onRevoked: () => revoked.push(`b${index}`) })).not.toBeNull();
    }
    const lease = hub.acquire("chosen", () => {}, claim({}));
    expect(lease).not.toBeNull();
    expect(hub.size()).toBe(FEED_CAP);
    // The bubbles' least important agent gave its slot up.
    expect(revoked).toEqual([`b${FEED_CAP - 1}`]);
    lease?.release();
    expect(hub.size()).toBe(FEED_CAP - 1);
  });
});
