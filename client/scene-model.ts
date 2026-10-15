import type { PaseoAgent } from "./paseo-types";
import type { Exchange } from "./exchanges";
import { STATE_LABEL, displayTitle, matches, roleOf, type CrewNode, type CrewState } from "./model";
import type { Act, Office, Point, Presence } from "./office-model";

/**
 * Everything the scene decides that is not drawing: how big a tile is, how a
 * character walks, where a message travels, who is dimmed. Pure and tested, so
 * the view only places what it is told.
 */

/** A tile is 16 art pixels; the scene draws it at a whole multiple. */
export const TILE = 16;
/** A character is one tile wide and one and a half tall, standing on the bottom of its tile. */
export const CHARACTER_HEIGHT = 1.5;
export const MIN_TOUCH = 44;
/** Layout pixels per art pixel the office aims for: a character about 19 by 29. */
export const SCENE_SCALE = 1.2;
/** A room of two desks across with its pantry and lounge under them is this many tiles wide. */
export const SCENE_MIN_TILES = 9;

export interface SceneScale {
  scale: number;
  /** Pixels per tile. */
  tile: number;
  /** How many tiles fit across. */
  widthTiles: number;
}

/**
 * How big the office is drawn. It lives in a side pane and is meant to be
 * glanced at, so it is small, and the same size on every screen: the size the
 * screen can draw without blur (one art pixel a whole number of device pixels)
 * that is nearest to `SCENE_SCALE`, and never under one to one. That is 1.2 on
 * a 1.67× screen, 1 on a 2× or a 1× screen, 1.33 on a 3× one. Words do not
 * shrink with it: bubbles have a scale of their own.
 */
export function sceneScale(widthPx: number, pixelRatio = 2): SceneScale {
  const width = Math.max(0, Math.floor(widthPx));
  const least = Math.ceil(pixelRatio - 1e-6) / pixelRatio;
  const below = Math.floor(SCENE_SCALE * pixelRatio + 1e-6) / pixelRatio;
  const above = Math.ceil(SCENE_SCALE * pixelRatio - 1e-6) / pixelRatio;
  // The nearer of the two crisp sizes either side of the aim; the smaller on a tie.
  const nearest = SCENE_SCALE - below <= above - SCENE_SCALE ? below : above;
  const normal = Math.max(least, nearest);
  // A pane too narrow for a room at that size gets the smallest size there is.
  const scale = Math.floor(width / (TILE * normal)) >= SCENE_MIN_TILES ? normal : least;
  const tile = TILE * scale;
  return { scale, tile, widthTiles: Math.floor(width / tile) };
}

/** The largest size the office grows to when a wide pane leaves room to spare. */
export const MAX_SCENE_SCALE = 2;

/**
 * The size an office `usedTiles` wide is drawn at in a pane `widthPx` wide:
 * the largest crisp size, up to `MAX_SCENE_SCALE`, at which it still fits
 * across, and never under `base`. The office is laid out again at that size.
 */
export function zoomScale(base: SceneScale, usedTiles: number, widthPx: number, pixelRatio = 2): SceneScale {
  const width = Math.max(0, Math.floor(widthPx));
  if (usedTiles <= 0) return base;
  const fit = Math.floor((Math.min(MAX_SCENE_SCALE, width / (TILE * usedTiles)) * pixelRatio) + 1e-6) / pixelRatio;
  if (fit <= base.scale) return base;
  const tile = TILE * fit;
  return { scale: fit, tile, widthTiles: Math.floor(width / tile) };
}

/** Padding that brings a `size` px target up to the 44 px minimum. */
export function touchSlop(size: number): number {
  return Math.max(0, Math.ceil((MIN_TOUCH - size) / 2));
}

export type SpriteRole = "overseer" | "nexus" | "meow" | "agent";

export function spriteRole(agent: PaseoAgent): SpriteRole {
  const role = roleOf(agent)?.toLowerCase();
  return role === "overseer" || role === "nexus" || role === "meow" ? role : "agent";
}

/** What a screen reader hears for a character: what the pixels say. */
export function characterLabel(
  agent: PaseoAgent,
  state: CrewState,
  saying?: string | null,
  visiting = false,
): string {
  const parts = [visiting ? "Visitor" : null, displayTitle(agent), roleOf(agent), STATE_LABEL[state]];
  if (saying) parts.push(saying);
  return parts.filter(Boolean).join(", ");
}

export type Heading = "up" | "down" | "left" | "right";

export interface Leg {
  from: Point;
  to: Point;
  heading: Heading;
  durationMs: number;
  /** The row to stack the walker on for this leg: the lower end, so it passes in front of who it walks past. */
  row: number;
}

/** A walking pace: just under four tiles a second. */
export const WALK_MS_PER_TILE = 260;
/** Past this a walk across a very tall room is hurried, evenly, to end here. */
export const MAX_WALK_MS = 9_000;

/** Somewhere a character can be, and the free row it leaves or arrives by. */
export interface Place {
  at: Point;
  /** A row nothing stands on, next to `at`: the aisle under a desk, the row in front of the pantry wall, the walkway. */
  aisleY: number;
}

function legsThrough(corners: readonly Point[], msPerTile: number): Leg[] {
  const legs: Leg[] = [];
  for (let index = 1; index < corners.length; index += 1) {
    const start = corners[index - 1] as Point;
    const end = corners[index] as Point;
    const distance = Math.abs(end.x - start.x) + Math.abs(end.y - start.y);
    if (distance === 0) continue;
    const heading: Heading = end.x > start.x ? "right" : end.x < start.x ? "left" : end.y > start.y ? "down" : "up";
    legs.push({ from: start, to: end, heading, durationMs: distance * msPerTile, row: Math.max(start.y, end.y) });
  }
  return legs;
}

/**
 * A walk between two places as straight legs, at a constant pace. Nobody walks
 * through a desk: a walker steps to its aisle row, follows it to the room's
 * corridor (the free column inside the left wall), takes the corridor to the
 * destination's aisle row, and follows that to the destination. On the same
 * aisle the corridor is skipped, and one step sideways (out of the chair to
 * stand beside it) is taken directly.
 */
export function walkPath(from: Place, to: Place, corridorX: number): Leg[] {
  const a = from.at;
  const b = to.at;
  let corners: Point[];
  if (a.y === b.y && Math.abs(a.x - b.x) <= 1) corners = [a, b];
  else if (from.aisleY === to.aisleY) corners = [a, { x: a.x, y: from.aisleY }, { x: b.x, y: to.aisleY }, b];
  else {
    corners = [
      a,
      { x: a.x, y: from.aisleY },
      { x: corridorX, y: from.aisleY },
      { x: corridorX, y: to.aisleY },
      { x: b.x, y: to.aisleY },
      b,
    ];
  }
  const legs = legsThrough(corners, WALK_MS_PER_TILE);
  const total = legs.reduce((sum, leg) => sum + leg.durationMs, 0);
  if (total > MAX_WALK_MS) {
    for (const leg of legs) leg.durationMs = Math.round((leg.durationMs * MAX_WALK_MS) / total);
  }
  return legs;
}

/** Where a character belongs: in its chair, beside it, on a break (pantry, lounge, walkway), or out of the room. */
export type Spot = "seat" | "stand" | "lounge" | "out";

export interface Standing {
  spot: Spot;
  /**
   * Which place of that kind, in the room's own terms: the same before and
   * after the room moves, different when the agent picks another place (a
   * break that moves from the coffee machine to the sofa).
   */
  key: string;
  at: Point;
  /** Pixels per tile. */
  tile: number;
}

/**
 * How a character gets to where it now belongs.
 *
 * - `walk`: its spot changed, or it chose another place of the same kind. That
 *   is the agent's own doing (it started work, finished, went idle, moved on
 *   from the pantry to the sofa, closed, came back), so it walks.
 * - `enter`: it was not in the room a moment ago and the room was, so it walks
 *   in from the door.
 * - `snap`: the same spot is somewhere else, or the scale changed. That is the
 *   room moving (a reflow, a resize), not the character; it is placed.
 * - `stay`: nothing changed.
 *
 * A character that changes spot during a reflow walks from where its old spot
 * is in the new layout, so only the agent's own move is shown as a walk.
 */
export function moveKind(
  previous: Standing | null,
  next: Standing,
  roomWasHere: boolean,
): "stay" | "snap" | "walk" | "enter" {
  if (!previous) return roomWasHere && next.spot !== "out" ? "enter" : "snap";
  if (previous.tile !== next.tile) return "snap";
  if (previous.spot !== next.spot || previous.key !== next.key) return "walk";
  return previous.at.x === next.at.x && previous.at.y === next.at.y ? "stay" : "snap";
}

export interface MarkerPath {
  /** Tile coordinates of tile centres are `point + 0.5`; these are tile origins. */
  from: Point;
  to: Point;
  /** False when that end is not an agent seated in this office: the marker uses the room's door instead. */
  fromSeated: boolean;
  toSeated: boolean;
}

/**
 * Where a message travels. Between two agents in the office (seated, or
 * visiting) it goes from one to the other, also across rooms. When the sender is unknown or sits in a room this office does
 * not show, it comes in through the door of the recipient's room; when only
 * the sender is here, it leaves through the sender's door. With neither end here there is nothing to draw.
 */
export function markerPath(exchange: Pick<Exchange, "from" | "to">, office: Office): MarkerPath | null {
  const door = (agentId: string): Point | null =>
    office.rooms.find((entry) => entry.workspaceId === office.roomOf.get(agentId))?.door ?? null;
  const spot = (agentId: string) => office.desks.get(agentId)?.seat ?? office.visitors.get(agentId)?.at ?? null;
  const to = spot(exchange.to);
  const from = exchange.from ? spot(exchange.from) : null;
  if (from && to) return { from, to, fromSeated: true, toSeated: true };
  if (to) {
    const entry = door(exchange.to);
    return entry ? { from: entry, to, fromSeated: false, toSeated: true } : null;
  }
  if (from && exchange.from) {
    const exit = door(exchange.from);
    return exit ? { from, to: exit, fromSeated: true, toSeated: false } : null;
  }
  return null;
}

export const MARKER_TRAVEL_MS = 1_200;

/** 0 at the sender, 1 at the recipient, where the marker rests until the exchange expires. */
export function markerProgress(sentAt: number, now: number): number {
  return Math.min(1, Math.max(0, (now - sentAt) / MARKER_TRAVEL_MS));
}

export interface Link {
  /** Centre of the line, in pixels. */
  cx: number;
  cy: number;
  length: number;
  /** Rotation of a horizontal bar of `length`, in degrees. */
  angle: number;
}

/** A straight line between two tile centres, as a rotated bar a View can draw. */
export function linkBetween(from: Point, to: Point, tile: number): Link {
  const ax = (from.x + 0.5) * tile;
  const ay = (from.y + 0.5) * tile;
  const bx = (to.x + 0.5) * tile;
  const by = (to.y + 0.5) * tile;
  return {
    cx: (ax + bx) / 2,
    cy: (ay + by) / 2,
    length: Math.hypot(bx - ax, by - ay),
    angle: (Math.atan2(by - ay, bx - ax) * 180) / Math.PI,
  };
}

const SPOT: Record<Presence["activity"], Spot> = {
  typing: "seat",
  stuck: "seat",
  asleep: "seat",
  asking: "stand",
  done: "stand",
  wandering: "lounge",
  gathering: "lounge",
  visiting: "lounge",
  away: "out",
};

/**
 * Which frame of what it is doing a character shows on the scene's `beat`
 * (one every 280 ms). Frame 0 is the rest pose, held most of the time: a sip
 * now and then, a stretch now and then, a slow nod. Two people talking take
 * turns: `seed` is even for one and odd for the other.
 */
export function actFrame(act: Act, beat: number, seed: number): 0 | 1 {
  switch (act) {
    case "drink":
      return (beat + seed * 3) % 10 < 2 ? 1 : 0;
    case "stretch":
      return (beat + seed * 5) % 14 < 4 ? 1 : 0;
    case "talk":
      return ((beat >> 1) + seed) % 2 === 0 ? 1 : 0;
    case "doze":
      return ((beat >> 2) + seed) % 2 === 0 ? 1 : 0;
    case "read":
      return 0;
  }
}

/** How many beats it takes each activity to come back to where it began, whatever the seed. */
const ACT_BEATS: Record<Act, number> = { drink: 10, stretch: 14, talk: 4, doze: 8, read: 1 };

/** One loop of an activity, a frame per beat: `actFrame` written out, for whoever animates it without a timer. */
export function actCycle(act: Act, seed: number): (0 | 1)[] {
  return Array.from({ length: ACT_BEATS[act] }, (_, beat) => actFrame(act, beat, seed));
}

/** The spot an activity is done at. */
export function spotOf(activity: Presence["activity"]): Spot {
  return SPOT[activity];
}

export interface Track {
  inputRange: [number, number];
  outputRange: [number, number];
}

/**
 * How a bubble follows a walking character without leaving the office: its
 * left edge as a function of the character's x, and its top as a function of
 * the character's y, each a slope-one line clamped at the office's edges.
 */
export function bubbleTrack(
  bubbleWidth: number,
  bubbleHeight: number,
  tile: number,
  officeWidthPx: number,
  /** How far above the head the bubble's tail ends, in pixels: room for what must stay in view. */
  clearPx = 0,
): { x: Track & { fixed: number | null }; y: Track } {
  const min = 2;
  const max = officeWidthPx - bubbleWidth - 2;
  // left = x + tile / 2 - width / 2, held within [min, max].
  const shift = tile / 2 - bubbleWidth / 2;
  const lift = (CHARACTER_HEIGHT - 1) * tile + bubbleHeight + Math.max(2, clearPx);
  return {
    x: { inputRange: [min - shift, Math.max(min, max) - shift + (max <= min ? 1 : 0)], outputRange: [min, Math.max(min, max) + (max <= min ? 1 : 0)], fixed: max <= min ? min : null },
    // top = y - lift, never above the office.
    y: { inputRange: [lift, lift + 1], outputRange: [0, 1] },
  };
}

/**
 * The same track for a follower that is moved piece by piece: where the bubble
 * is for a speaker at `at` (both in pixels), and the speaker positions at which
 * that line bends.
 */
export function bubbleFollow(track: ReturnType<typeof bubbleTrack>): {
  place: (at: Point) => Point;
  knotsX: number[];
  knotsY: number[];
} {
  const { x, y } = track;
  return {
    place: (at) => ({
      x: x.fixed ?? Math.min(x.outputRange[1], Math.max(x.outputRange[0], at.x - x.inputRange[0] + x.outputRange[0])),
      y: Math.max(y.outputRange[0], at.y - y.inputRange[0] + y.outputRange[0]),
    }),
    knotsX: x.fixed === null ? [...x.inputRange] : [],
    knotsY: [y.inputRange[0]],
  };
}

/**
 * The agents a search and a state filter single out, or null when neither is
 * set. The office dims everyone else in place: filtering never moves a seat.
 */
export function highlighted(
  roots: readonly CrewNode[],
  filter: CrewState | "all",
  query: string,
  workspaceName: (agent: PaseoAgent) => string | null,
): ReadonlySet<string> | null {
  if (filter === "all" && !query.trim()) return null;
  const out = new Set<string>();
  const walk = (node: CrewNode) => {
    if ((filter === "all" || node.state === filter) && matches(node.agent, query, workspaceName(node.agent))) {
      out.add(node.agent.id);
    }
    for (const child of node.children) walk(child);
  };
  for (const root of roots) walk(root);
  return out;
}

/** Workspace ids of the rooms that intersect a vertical window, both in tiles. */
export function roomsInView(office: Office, top: number, bottom: number): string[] {
  return office.rooms
    .filter((room) => room.y < bottom && room.y + room.height > top)
    .map((room) => room.workspaceId);
}

/**
 * How far above its speaker's head a bubble floats, in tiles. At a desk it
 * clears the monitor, so the screen's state and the emote beside the head stay
 * in view; away from one it clears the emote over the head, if there is one.
 */
export function bubbleClearance(spot: Spot, hasEmote: boolean): number {
  if (spot === "seat" || spot === "stand") return 1.25;
  return hasEmote ? 0.8 : 0.1;
}

/** Every node of a forest by agent id. */
export function indexNodes(roots: readonly CrewNode[]): Map<string, CrewNode> {
  const out = new Map<string, CrewNode>();
  const walk = (node: CrewNode) => {
    out.set(node.agent.id, node);
    for (const child of node.children) walk(child);
  };
  for (const root of roots) walk(root);
  return out;
}
