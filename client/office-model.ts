import type { PaseoAgent } from "./paseo-types";
import { PROPS, PROP_USES } from "./pixel/props";
import { STATE_ORDER, activityAt, parentAgentId, roleOf, type CrewGroup, type CrewNode, type CrewState } from "./model";

/**
 * The office, in tiles. A room per workspace, a pod per crew tree, a desk per
 * agent, and along the bottom of each room a pantry and a lounge to go to when
 * there is nothing to do.
 *
 * Seats are assigned from facts that never change: who an agent's parent is and
 * when it was created. State is never consulted, so a seat does not move when
 * anyone's state does, and every later arrival is appended after the agents
 * already seated.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect extends Point {
  width: number;
  height: number;
}

/**
 * One desk cell: the desk across its top row, the chair under the desk's
 * middle, an aisle row below. Desks stand shoulder to shoulder.
 */
export const DESK_WIDTH = 2;
export const DESK_HEIGHT = 3;
/** Most desks in one row of a pod, however wide the room is. */
export const MAX_POD_COLUMNS = 6;
const WALL = 1;
/** A free column inside the left wall, from the door down to the lounge: where characters walk between rows. */
const CORRIDOR = 1;
/** Rows of wall face under the top wall. The first row of monitors rises against it. */
const FACE_ROWS = 1;
/**
 * The rows of the strip under the desks: a half wall with the appliances, the
 * shelves and the sofa against it, the row in front of them, and a walkway
 * that is always clear.
 */
const ZONE_ROWS = 3;
/** A room nobody sits in keeps one row of floor. */
const BARE_ROWS = 1;
/** The narrowest a room's floor may be: the name plate and the closed-agents fixture hang over it. */
const MIN_INNER_WIDTH = 4;
/** A zone is furniture, not floor: however wide the room, it stops here. */
export const PANTRY_MAX_WIDTH = 5;
export const LOUNGE_MAX_WIDTH = 6;
/** The narrowest room that still holds one desk between its walls. */
export const MIN_ROOM_WIDTH = DESK_WIDTH + 2 * WALL + CORRIDOR;

export interface Desk {
  agentId: string;
  /** `rootId/teamLeadId/index`: stable for as long as the agents seated before this one remain. */
  seatKey: string;
  rootId: string;
  parentId: string | null;
  /** The agent whose team this desk belongs to; the root leads its own desk. */
  leadId: string;
  depth: number;
  role: string | null;
  /** True when the agent runs in another workspace than the room it sits in. */
  remote: boolean;
  /** Top-left tile of the desk cell, in office coordinates. */
  cell: Point;
  /** Where the character sits, facing up at the desk. */
  seat: Point;
  /** Where the character stands when it has turned from the keyboard: at its own chair. */
  stand: Point;
  /** The free row under the desk cell, which characters walk along. */
  aisleY: number;
}

export interface Team {
  leadId: string;
  /** Index among the pod's teams, in founding order; a tint a view can key on. */
  index: number;
  /** The tiles this team's rows cover. */
  area: Rect;
  desks: Desk[];
}

export interface Pod extends Rect {
  rootId: string;
  teams: Team[];
}

/** The props a zone can hold; ids, footprints and use points are the sprite catalogue's table. */
export type ZonePropId = "fridge" | "counter" | "coffee" | "water" | "table" | "bookshelf" | "plant" | "sofa" | "beanbag" | "rug";

export interface ZoneProp {
  id: ZonePropId;
  /** Its leftmost tile. */
  x: number;
  y: number;
}

/** Somewhere a character goes to be: in front of the coffee machine, on the sofa. One character each. */
export interface UseSpot extends Point {
  /**
   * Which place this is, in the room's own terms: `sofa:1`, `table:0`,
   * `walkway:4`. The same place keeps its id when the room is laid out afresh.
   */
  id: string;
  /** The clear row it is reached by. */
  aisleY: number;
  pose: "stand" | "sit";
  facing: "up" | "down" | "left" | "right";
  /** Art pixels to raise a sitter so it rests on the seat. */
  lift: number;
  prop: ZonePropId | null;
  zone: "pantry" | "lounge" | "walkway";
}

export interface Zone extends Rect {
  kind: "pantry" | "lounge";
  props: ZoneProp[];
  spots: UseSpot[];
}

/** The strip under the desks. */
export interface Lounge extends Rect {
  /** The bottom row: always clear, where people pass, visitors stand and the overflow waits. */
  walkway: Rect;
  /** The tiles of the half wall the zones' appliances stand against, if the room is furnished. */
  wall: Rect | null;
}

export interface Room extends Rect {
  workspaceId: string;
  name: string;
  counts: Record<CrewState, number>;
  /** 0 needs you, 1 failed, 2 neither. Rooms are not reordered by it; a view may badge or jump. */
  urgency: 0 | 1 | 2;
  /** Every agent in the room is closed. */
  dormant: boolean;
  /** Where a view hangs the room's name plate: on the top wall, beside the door. */
  header: Rect;
  /** The first row of floor, under the wall. */
  floorTop: number;
  /** The free column characters use to walk between rows. */
  corridorX: number;
  /** Where characters come in and go out: the head of the corridor, under the doorway in the top wall. */
  door: Point;
  pods: Pod[];
  lounge: Lounge;
  /** The pantry and the lounge, each with its props and use points. Empty in a room nobody is in. */
  zones: Zone[];
  /** The zones stand beside the desks, against the top wall, instead of under them. */
  zonesBeside: boolean;
  /**
   * The room's closed agents, oldest first, and the tile their filing cabinet
   * stands on, against the wall at the end of the zones. They have no desk:
   * closing frees it.
   */
  closed: { ids: string[]; at: Point } | null;
  agentCount: number;
}

/** A crew's parent that has no desk in this office: it stands in the lounge of the room it parents into. */
export interface Visitor {
  agentId: string;
  /** The root it is the parent of. */
  hostId: string;
  workspaceId: string;
  at: Point;
}

export interface Office {
  width: number;
  height: number;
  rooms: Room[];
  /** agentId → its desk. Every agent in the forest has exactly one. */
  desks: ReadonlyMap<string, Desk>;
  /** agentId → the room it sits in, or visits. */
  roomOf: ReadonlyMap<string, string>;
  /** agentId → where it stands. Visitors never take a desk, so they move nobody. */
  visitors: ReadonlyMap<string, Visitor>;
  /**
   * The building the rooms stand in: for each column of tiles, how far down it
   * goes, which is where the lowest room over that column ends. Its outline is
   * stepped, following the rooms; what is inside it and in no room is hallway,
   * a gap enclosed between rooms, never floor below the last room of a column.
   */
  building: { depth: number[] } | null;
  /**
   * The width the caller offered was narrower than `MIN_ROOM_WIDTH`; the office
   * is laid out at the minimum and a view has to scroll or scale.
   */
  cramped: boolean;
}

export interface OfficeOptions {
  /** Available width in tiles. */
  width: number;
  /**
   * Closed agents that still have their desk: they are on their way out, and
   * the desk is not given to anyone until they have left.
   */
  holding?: ReadonlySet<string>;
  /**
   * The whole directory. With it, the parent of a root that is not itself in
   * the office (it runs in a workspace the office does not show) is placed as a
   * visitor.
   */
  agents?: ReadonlyMap<string, PaseoAgent>;
}

const bySeniority = (a: PaseoAgent, b: PaseoAgent): number =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

interface Member {
  agent: PaseoAgent;
  depth: number;
  parentId: string | null;
}

interface TeamPlan {
  leadId: string;
  members: Member[];
}

/**
 * A crew tree as teams. The root's team is the root followed by its children;
 * every other agent with children leads a team made of those children, while
 * keeping its own desk in its parent's team. Teams are ordered by when their
 * first member was created, members by when they were. Only those `seated`
 * take a place: a closed agent has no desk, and the teammates after it sit
 * one desk up. Its own team stays its team.
 */
function planTeams(root: CrewNode, seated: (node: CrewNode) => boolean, away: string[]): TeamPlan[] {
  const teams: Array<TeamPlan & { founded: PaseoAgent }> = [];
  const walk = (node: CrewNode, isRoot: boolean) => {
    const children = [...node.children].sort((a, b) => bySeniority(a.agent, b.agent));
    const members: Member[] = children
      .filter(seated)
      .map((child) => ({ agent: child.agent, depth: child.depth, parentId: node.agent.id }));
    if (isRoot) {
      if (seated(node)) {
        // A root named in its own parent label still has no desk but its own.
        const parentId = parentAgentId(node.agent);
        members.unshift({ agent: node.agent, depth: node.depth, parentId: parentId === node.agent.id ? null : parentId });
      } else away.push(node.agent.id);
    }
    for (const child of children) if (!seated(child)) away.push(child.agent.id);
    const first = members[0];
    if (first) teams.push({ leadId: node.agent.id, members, founded: first.agent });
    for (const child of children) walk(child, false);
  };
  walk(root, true);
  return teams.sort((a, b) => bySeniority(a.founded, b.founded));
}

interface TeamBlock {
  team: TeamPlan;
  /** Desks across, and down. */
  columns: number;
  rows: number;
  /** In desks, within the pod. */
  x: number;
  y: number;
}

interface PodPlan {
  rootId: string;
  blocks: TeamBlock[];
  columns: number;
  rows: number;
}

/**
 * A crew's pod: its teams, each a block of desks of its own, set side by side
 * while they fit `columns` desks across and then on the next shelf. A team
 * wider than the pod wraps onto rows of its own. An agent on its own is a pod
 * of one desk.
 */
function planPod(rootId: string, teams: TeamPlan[], columns: number): PodPlan {
  const blocks: TeamBlock[] = [];
  let x = 0;
  let y = 0;
  let shelf = 0;
  let across = 0;
  for (const team of teams) {
    const wide = Math.max(1, Math.min(columns, team.members.length));
    const rows = Math.ceil(team.members.length / wide);
    if (x > 0 && x + wide > columns) {
      x = 0;
      y += shelf;
      shelf = 0;
    }
    blocks.push({ team, columns: wide, rows, x, y });
    x += wide;
    across = Math.max(across, x);
    shelf = Math.max(shelf, rows);
  }
  return { rootId, blocks, columns: Math.max(1, across), rows: y + shelf };
}

function placePod(plan: PodPlan, origin: Point, workspaceId: string): Pod {
  const teams = plan.blocks.map((block, index): Team => {
    const corner = { x: origin.x + block.x * DESK_WIDTH, y: origin.y + block.y * DESK_HEIGHT };
    const desks = block.team.members.map((member, seatIndex): Desk => {
      const cell = {
        x: corner.x + (seatIndex % block.columns) * DESK_WIDTH,
        y: corner.y + Math.floor(seatIndex / block.columns) * DESK_HEIGHT,
      };
      return {
        agentId: member.agent.id,
        seatKey: `${plan.rootId}/${block.team.leadId}/${seatIndex}`,
        rootId: plan.rootId,
        parentId: member.parentId,
        leadId: block.team.leadId,
        depth: member.depth,
        role: roleOf(member.agent),
        remote: (member.agent.workspaceId ?? "") !== workspaceId,
        cell,
        // Half a tile in: under the middle of the desk. It stands up where it sat, in front of its
        // chair and turned to the room, so nobody standing is in a neighbour's way.
        seat: { x: cell.x + 0.5, y: cell.y + 1 },
        stand: { x: cell.x + 0.5, y: cell.y + 1 },
        aisleY: cell.y + DESK_HEIGHT - 1,
      };
    });
    return {
      leadId: block.team.leadId,
      index,
      area: { ...corner, width: block.columns * DESK_WIDTH, height: block.rows * DESK_HEIGHT },
      desks,
    };
  });
  return {
    rootId: plan.rootId,
    x: origin.x,
    y: origin.y,
    width: plan.columns * DESK_WIDTH,
    height: plan.rows * DESK_HEIGHT,
    teams,
  };
}

export interface ZoneFit {
  pantry: { width: number; wall: ZonePropId[] } | null;
  lounge: { width: number; wall: ZonePropId[] } | null;
  /** A standing table between the two, where there is room for somebody either side. */
  table: boolean;
}

const tilesWide = (id: ZonePropId): number => PROPS[id].tilesWide;

/** The props that fit `room` tiles in a row, taken in order of `priority`, laid out in `order`. */
function pack(room: number, priority: readonly ZonePropId[], order: readonly ZonePropId[]): ZonePropId[] {
  const chosen = new Set<ZonePropId>();
  let left = room;
  for (const id of priority) {
    if (tilesWide(id) > left) continue;
    chosen.add(id);
    left -= tilesWide(id);
  }
  return order.filter((id) => chosen.has(id));
}

const span = (ids: readonly ZonePropId[]) => ids.reduce((sum, id) => sum + tilesWide(id), 0);

/**
 * What a room `contentWidth` tiles wide between corridor and right wall is
 * furnished with. Everything stands against the half wall: the pantry's
 * appliances on the left, then the lounge's shelves, plant, sofa and beanbag,
 * a tile apart, and each zone is exactly as wide as what it holds. As the room
 * narrows the pantry gives up its water cooler, then the counter, then the
 * fridge, and keeps the coffee machine; the lounge gives up the beanbag, then
 * the bookshelf, then the plant, and keeps the sofa.
 */
export function fitZones(contentWidth: number): ZoneFit {
  if (contentWidth < 1) return { pantry: null, lounge: null, table: false };
  const pantryRoom = Math.max(1, Math.min(PANTRY_MAX_WIDTH, Math.floor(contentWidth * 0.45)));
  const pantryWall = pack(pantryRoom, ["coffee", "fridge", "counter", "water"], ["fridge", "counter", "coffee", "water"]);
  const pantry = { width: span(pantryWall), wall: pantryWall };
  const loungeRoom = Math.min(LOUNGE_MAX_WIDTH, contentWidth - pantry.width - 1);
  if (loungeRoom < 2) return { pantry, lounge: null, table: false };
  const loungeWall = pack(loungeRoom, ["sofa", "plant", "bookshelf", "beanbag"], ["bookshelf", "plant", "sofa", "beanbag"]);
  const lounge = { width: span(loungeWall), wall: loungeWall };
  // The table stands in the tile between the zones; whoever uses it stands in the last tile of
  // the pantry and the first of the lounge, which must not be the rug in front of the sofa.
  return { pantry, lounge, table: loungeWall[0] !== "sofa" };
}

function furnish(left: number, top: number, contentWidth: number): Zone[] {
  const fit = fitZones(contentWidth);
  const wallY = top;
  const frontY = top + 1;
  const walkY = top + ZONE_ROWS - 1;
  const row = (ids: readonly ZonePropId[], x: number): ZoneProp[] => {
    const out: ZoneProp[] = [];
    let at = x;
    for (const id of ids) {
      out.push({ id, x: at, y: wallY });
      at += tilesWide(id);
    }
    return out;
  };
  const zones: Zone[] = [];
  const taken = new Set<string>();
  const spotsOf = (props: readonly ZoneProp[], zone: "pantry" | "lounge"): UseSpot[] => {
    const spots: UseSpot[] = [];
    for (const item of props) {
      PROP_USES[item.id].forEach((use, place) => {
        // Lying down takes a whole sofa; here a sofa seats two.
        if (use.pose === "lie") return;
        const spot = { x: item.x + use.dx, y: item.y + use.dy };
        const tile = `${spot.x},${spot.y}`;
        // One character to a tile, and nobody on the rug: whoever claimed it first has it.
        if (taken.has(tile)) return;
        taken.add(tile);
        spots.push({
          ...spot,
          id: `${item.id}:${place}`,
          // Everything is reached from the walkway: a step up to the row in front, two to a seat.
          aisleY: walkY,
          pose: use.pose === "sit" ? "sit" : "stand",
          facing: use.facing,
          lift: use.lift,
          prop: item.id,
          zone,
        });
      });
    }
    return spots;
  };
  if (!fit.pantry) return zones;
  const pantryProps = row(fit.pantry.wall, left);
  const loungeLeft = left + fit.pantry.width + 1;
  const loungeProps = fit.lounge ? row(fit.lounge.wall, loungeLeft) : [];
  const sofa = loungeProps.find((item) => item.id === "sofa");
  if (sofa) {
    // The rug lies in front of the sofa; nobody stands on it.
    loungeProps.push({ id: "rug", x: sofa.x, y: frontY });
    taken.add(`${sofa.x},${frontY}`);
    taken.add(`${sofa.x + 1},${frontY}`);
  }
  // The table's two places come first, so they win over the spots in front of the wall.
  const table: ZoneProp | null = fit.table ? { id: "table", x: loungeLeft - 1, y: frontY } : null;
  const tableSpots = table ? spotsOf([table], "pantry") : [];
  if (table) taken.add(`${table.x},${table.y}`);
  zones.push({
    kind: "pantry",
    x: left,
    y: top,
    width: fit.pantry.width,
    height: ZONE_ROWS,
    props: table ? [...pantryProps, table] : pantryProps,
    spots: [...tableSpots.filter((spot) => spot.x < loungeLeft - 1), ...spotsOf(pantryProps, "pantry")],
  });
  if (fit.lounge) {
    zones.push({
      kind: "lounge",
      x: loungeLeft,
      y: top,
      width: fit.lounge.width,
      height: ZONE_ROWS,
      props: loungeProps,
      spots: [
        ...tableSpots.filter((spot) => spot.x >= loungeLeft).map((spot) => ({ ...spot, zone: "lounge" as const })),
        ...spotsOf(loungeProps, "lounge"),
      ],
    });
  }
  return zones;
}

interface DeskBlock {
  pods: Array<{ plan: PodPlan; x: number; y: number }>;
  width: number;
  height: number;
}

/** Pods on shelves `columns` desks wide: left to right in seniority order, then the next shelf. */
function shelve(crews: ReadonlyArray<{ rootId: string; teams: TeamPlan[] }>, columns: number): DeskBlock {
  const limit = columns * DESK_WIDTH;
  const pods: DeskBlock["pods"] = [];
  let x = 0;
  let y = 0;
  let shelf = 0;
  let width = 0;
  for (const crew of crews) {
    const plan = planPod(crew.rootId, crew.teams, columns);
    const podWidth = plan.columns * DESK_WIDTH;
    if (x > 0 && x + podWidth > limit) {
      x = 0;
      y += shelf;
      shelf = 0;
    }
    pods.push({ plan, x, y });
    x += podWidth;
    width = Math.max(width, x);
    shelf = Math.max(shelf, plan.rows * DESK_HEIGHT);
  }
  return { pods, width, height: y + shelf };
}

/** How much room the zones of a crew of `seated` ask for: a few people need a small pantry. */
function zoneBudget(seated: number): number {
  return Math.max(6, Math.min(PANTRY_MAX_WIDTH + 1 + LOUNGE_MAX_WIDTH, 4 + seated));
}

const zonesWidth = (fit: ZoneFit): number =>
  (fit.pantry?.width ?? 0) + (fit.lounge ? 1 + fit.lounge.width : 0);

interface Shape {
  block: DeskBlock;
  beside: boolean;
  zoneRoom: number;
  innerWidth: number;
  innerHeight: number;
}

/**
 * The shape a room takes: how many desks across, and whether its pantry and
 * lounge stand beside the desks or under them. Of everything that fits
 * `maxInner` tiles between corridor and right wall, it is the arrangement that
 * covers the least floor, so a small crew makes a small room and a wide pane is
 * used across before it is used downwards.
 */
function shapeRoom(
  crews: ReadonlyArray<{ rootId: string; teams: TeamPlan[] }>,
  seated: number,
  maxInner: number,
  /** Tiles the closed agents' cabinet takes at the end of the zones' wall. */
  cabinet: number,
): Shape {
  if (seated === 0) {
    return { block: { pods: [], width: 0, height: 0 }, beside: false, zoneRoom: 0, innerWidth: MIN_INNER_WIDTH, innerHeight: BARE_ROWS };
  }
  const budget = zoneBudget(seated);
  const mostColumns = Math.max(1, Math.min(MAX_POD_COLUMNS, Math.floor(maxInner / DESK_WIDTH)));
  let best: (Shape & { area: number }) | null = null;
  const consider = (shape: Shape) => {
    const area = (shape.innerWidth + 3) * (shape.innerHeight + 3);
    if (
      !best ||
      area < best.area ||
      (area === best.area && shape.innerHeight < best.innerHeight)
    ) {
      best = { ...shape, area };
    }
  };
  for (let columns = 1; columns <= mostColumns; columns += 1) {
    const block = shelve(crews, columns);
    if (block.width > maxInner && columns > 1) break;
    const under = Math.min(budget, maxInner - cabinet);
    consider({
      block,
      beside: false,
      zoneRoom: under,
      innerWidth: Math.max(block.width, zonesWidth(fitZones(under)) + cabinet, MIN_INNER_WIDTH),
      innerHeight: block.height + ZONE_ROWS,
    });
    const aside = Math.min(budget, maxInner - block.width - 1 - cabinet);
    // Beside the desks only if at least a coffee machine and a sofa fit there.
    if (aside >= 4 && fitZones(aside).lounge) {
      consider({
        block,
        beside: true,
        zoneRoom: aside,
        innerWidth: block.width + 1 + zonesWidth(fitZones(aside)) + cabinet,
        innerHeight: Math.max(block.height, ZONE_ROWS),
      });
    }
  }
  return best as unknown as Shape;
}

function layoutRoom(group: CrewGroup, origin: Point, maxWidth: number, holding: ReadonlySet<string>): Room {
  const seated = (node: CrewNode) => node.state !== "closed" || holding.has(node.agent.id);
  const away: string[] = [];
  const crews = [...group.roots]
    .sort((a, b) => bySeniority(a.agent, b.agent))
    .map((root) => ({ rootId: root.agent.id, teams: planTeams(root, seated, away) }))
    .filter((crew) => crew.teams.length > 0);
  const agentCount = crews.reduce((sum, crew) => sum + crew.teams.reduce((inCrew, team) => inCrew + team.members.length, 0), 0);
  const cabinet = away.length > 0 ? 1 : 0;
  const shape = shapeRoom(crews, agentCount, Math.max(DESK_WIDTH, maxWidth - 2 * WALL - CORRIDOR), cabinet);
  const width = shape.innerWidth + 2 * WALL + CORRIDOR;
  const left = origin.x + WALL + CORRIDOR;
  const top = origin.y + WALL + FACE_ROWS;
  const pods = shape.block.pods.map((pod) => placePod(pod.plan, { x: left + pod.x, y: top + pod.y }, group.workspaceId));
  // Beside the desks the zones stand against the top wall, a tile clear of the last desk;
  // under them they follow the last aisle row.
  const stripLeft = shape.beside ? left + shape.block.width + 1 : left;
  const stripTop = shape.beside ? top : top + shape.block.height;
  const zones = agentCount > 0 ? furnish(stripLeft, stripTop, shape.zoneRoom) : [];
  const rows = agentCount > 0 ? ZONE_ROWS : BARE_ROWS;
  const lastZone = zones.at(-1);
  const lounge: Lounge = {
    x: stripLeft,
    y: stripTop,
    width: origin.x + width - WALL - stripLeft,
    height: rows,
    // The walkway runs the width of the room: beside the desks it is their first aisle row.
    walkway: { x: origin.x + WALL, y: stripTop + rows - 1, width: width - 2 * WALL, height: 1 },
    // The half wall runs behind the zones, and behind the cabinet at their end.
    wall: lastZone
      ? { x: stripLeft, y: stripTop, width: lastZone.x + lastZone.width - stripLeft + cabinet, height: 1 }
      : null,
  };
  const order = new Map<string, PaseoAgent>();
  const collect = (node: CrewNode) => {
    order.set(node.agent.id, node.agent);
    node.children.forEach(collect);
  };
  group.roots.forEach(collect);
  const closedIds = away.sort((a, b) => bySeniority(order.get(a) as PaseoAgent, order.get(b) as PaseoAgent));
  // The cabinet stands against the wall at the end of the zones; in a bare room, at the head of its floor.
  const cabinetAt = { x: lastZone ? lastZone.x + lastZone.width : left, y: stripTop };
  return {
    workspaceId: group.workspaceId,
    name: group.name,
    counts: group.counts,
    urgency: group.counts["needs-input"] > 0 ? 0 : group.counts.failed > 0 ? 1 : 2,
    dormant: agentCount === 0,
    x: origin.x,
    y: origin.y,
    width,
    height: WALL + FACE_ROWS + shape.innerHeight + WALL,
    // The plate hangs on the top wall, to the right of the doorway.
    header: { x: left, y: origin.y, width: shape.innerWidth, height: WALL },
    floorTop: top,
    corridorX: origin.x + WALL,
    door: { x: origin.x + WALL, y: top - 1 },
    pods,
    lounge,
    zones,
    zonesBeside: shape.beside,
    closed: closedIds.length > 0 ? { ids: closedIds, at: cabinetAt } : null,
    agentCount,
  };
}

/** A workspace whose agents are all closed: nobody is in. */
export function isDormant(group: CrewGroup): boolean {
  return STATE_ORDER.every((state) => state === "closed" || group.counts[state] === 0);
}

function oldestRoot(group: CrewGroup): PaseoAgent | null {
  let oldest: PaseoAgent | null = null;
  for (const root of group.roots) {
    if (!oldest || bySeniority(root.agent, oldest) < 0) oldest = root.agent;
  }
  return oldest;
}

/**
 * Lays out the office for the groups `groupByWorkspace` returned. Rooms are
 * ordered by their oldest crew, not by urgency, so a room does not change
 * places when one of its agents starts needing you. A closed agent has no desk:
 * the room shrinks around those who are left, and when its last agent closes it
 * joins the dormant rooms at the end. A room that appears, leaves or changes
 * size moves only the rooms after it in that order.
 */
export function layoutOffice(groups: readonly CrewGroup[], options: OfficeOptions): Office {
  const cramped = options.width < MIN_ROOM_WIDTH;
  const width = Math.max(MIN_ROOM_WIDTH, Math.floor(options.width));
  const holding = options.holding ?? new Set<string>();

  const leaving = (node: CrewNode): boolean => holding.has(node.agent.id) || node.children.some(leaving);
  // A room whose last agent is still walking out is not empty yet.
  const empty = (group: CrewGroup) => isDormant(group) && !group.roots.some(leaving);
  const ordered = [...groups].sort((a, b) => {
    // Rooms nobody is in go last, so that the rooms in use keep their places among themselves.
    const asleep = Number(empty(a)) - Number(empty(b));
    if (asleep !== 0) return asleep;
    const left = oldestRoot(a);
    const right = oldestRoot(b);
    if (left && right) return bySeniority(left, right) || a.workspaceId.localeCompare(b.workspaceId);
    return a.workspaceId.localeCompare(b.workspaceId);
  });

  const rooms: Room[] = [];
  const desks = new Map<string, Desk>();
  const roomOf = new Map<string, string>();
  const inOffice = new Set<string>();
  // One floor plan. Each room is as large as what it holds, and goes, in order, to the highest
  // place it fits, leftmost first: against the top, beside a neighbour whose wall it shares, or
  // under one whose bottom wall becomes its top wall. `skyline[x]` is the row of the lowest wall
  // in column x so far.
  const skyline = Array.from({ length: width }, () => 0);
  for (const group of ordered) {
    const size = layoutRoom(group, { x: 0, y: 0 }, width, holding);
    // The highest place it fits; among those, the one that leaves least hallway under it; then the leftmost.
    let at = { x: 0, y: Infinity, gap: Infinity };
    for (let x = 0; x + size.width <= width; x += 1) {
      let y = 0;
      for (let column = x; column < x + size.width; column += 1) y = Math.max(y, skyline[column] as number);
      let gap = 0;
      for (let column = x; column < x + size.width; column += 1) gap += y - (skyline[column] as number);
      if (y < at.y || (y === at.y && gap < at.gap)) at = { x, y, gap };
    }
    if (!Number.isFinite(at.y)) at = { x: 0, y: Math.max(...skyline), gap: 0 };
    const room = layoutRoom(group, at, width, holding);
    // The right wall stays open to a neighbour: only the columns left of it are spoken for.
    for (let column = room.x; column < room.x + room.width - WALL && column < width; column += 1) {
      skyline[column] = room.y + room.height - WALL;
    }
    rooms.push(room);
    const note = (node: CrewNode) => {
      inOffice.add(node.agent.id);
      roomOf.set(node.agent.id, room.workspaceId);
      node.children.forEach(note);
    };
    group.roots.forEach(note);
    for (const pod of room.pods) {
      for (const team of pod.teams) {
        for (const desk of team.desks) desks.set(desk.agentId, desk);
      }
    }
  }
  const visitors = new Map<string, Visitor>();
  ordered.forEach((group, index) => {
    const room = rooms[index] as Room;
    // Nobody visits a room nobody is in.
    if (room.agentCount === 0) return;
    const guests: Array<{ agent: PaseoAgent; hostId: string }> = [];
    for (const root of group.roots) {
      const parentId = parentAgentId(root.agent);
      const parent = parentId ? options.agents?.get(parentId) : undefined;
      if (!parent || parent.archivedAt || inOffice.has(parent.id) || visitors.has(parent.id)) continue;
      if (guests.some((guest) => guest.agent.id === parent.id)) continue;
      guests.push({ agent: parent, hostId: root.agent.id });
    }
    guests.sort((a, b) => bySeniority(a.agent, b.agent));
    const walkway = room.lounge.walkway;
    const slots = Math.max(1, Math.floor((walkway.width - 1) / 2));
    guests.forEach((guest, slot) => {
      visitors.set(guest.agent.id, {
        agentId: guest.agent.id,
        hostId: guest.hostId,
        workspaceId: room.workspaceId,
        // On the walkway by the lounge, from the right wall inwards, every other tile.
        at: { x: walkway.x + walkway.width - 1 - (slot % slots) * 2, y: walkway.y },
      });
      roomOf.set(guest.agent.id, room.workspaceId);
    });
  });
  const height = rooms.reduce((bottom, room) => Math.max(bottom, room.y + room.height), 0);
  const right = rooms.reduce((edge, room) => Math.max(edge, room.x + room.width), 0);
  const depth = Array.from({ length: right }, () => 0);
  for (const room of rooms) {
    for (let column = room.x; column < room.x + room.width; column += 1) {
      depth[column] = Math.max(depth[column] as number, room.y + room.height);
    }
  }
  const building = rooms.length > 0 ? { depth } : null;
  return { width, height, rooms, desks, roomOf, visitors, building, cramped };
}

export type Activity =
  /** At the desk, working. */
  | "typing"
  /** Standing by the desk, turned to the viewer, waiting on a permission. */
  | "asking"
  /** At the desk, stopped on an error. */
  | "stuck"
  /** Standing by the desk with finished work to show. */
  | "done"
  /** Recently idle, resting: on the sofa, at the shelves, stretching on the walkway. */
  | "wandering"
  /** Finished and waiting to be read: at the pantry with the others who are. */
  | "gathering"
  /** Idle for a long while, asleep at the desk. */
  | "asleep"
  /** Closed: the desk is kept, nobody is at it. */
  | "away"
  /** A parent from a workspace the office does not show, standing in the lounge. */
  | "visiting";

export type Emote = "question" | "alert" | "check" | "zzz";

/** Something a character does at a place: sipping, chatting with whoever is opposite, stretching, nodding off, reading. */
export type Act = "drink" | "talk" | "stretch" | "doze" | "read";

export interface Presence {
  agentId: string;
  state: CrewState;
  activity: Activity;
  /** Where the character belongs. */
  at: Point;
  /** The clear row `at` is reached by, when it is not at its desk. */
  aisleY: number;
  facing: "up" | "down" | "left" | "right";
  /** Whether a character is drawn at all. */
  visible: boolean;
  /** In its chair at the desk. */
  seated: boolean;
  /** Sitting somewhere else: a sofa, a beanbag. */
  lounging: boolean;
  /** What it is doing where it is, when that is more than standing or sitting. */
  act: Act | null;
  /** Which break place it is at, by `UseSpot.id`; null at its desk. */
  placeId: string | null;
  /** Art pixels to raise the sprite so a sitter rests on the seat. */
  lift: number;
  carry: "cup" | "book" | null;
  /** Whether the monitor on its desk is on. */
  screenOn: boolean;
  emote: Emote | null;
  /** For someone waiting on the walkway: the tiles it may stroll. */
  range: Rect | null;
}

/**
 * How long a break lasts. An idle agent rests this long after it last did
 * something, then goes back to its desk to sleep; a finished one stays at the
 * pantry this long, then goes back to stand at its desk until it is read.
 */
export const WANDER_MS = 15 * 60_000;
/** How long somebody on a break stays at one spot before choosing another: between this ... */
export const BREAK_DWELL_MIN_MS = 3 * 60_000;
/** ... and this much longer, a length that is each agent's own. */
export const BREAK_DWELL_SPREAD_MS = 3 * 60_000;

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  }
  // Mixed once more, so ids that differ in a letter do not make the same choices.
  result ^= result >>> 15;
  result = Math.imul(result, 0x2c1b3c6d);
  result ^= result >>> 12;
  return result >>> 0;
}

/**
 * Which stretch of its break an agent is in, and when that stretch began. Each
 * agent has its own dwell length and its own phase, so they neither all move
 * at once nor ever stand still for a whole break; within a stretch the answer
 * does not change.
 */
export function breakStretch(agentId: string, now: number): { index: number; startedAt: number; endsAt: number } {
  const dwell = BREAK_DWELL_MIN_MS + (hash(`${agentId}/dwell`) % BREAK_DWELL_SPREAD_MS);
  const phase = hash(`${agentId}/phase`) % dwell;
  const index = Math.floor((now + phase) / dwell);
  return { index, startedAt: index * dwell - phase, endsAt: (index + 1) * dwell - phase };
}

export interface Idler {
  agentId: string;
  /** When it went idle, or finished, epoch ms. */
  since: number;
  /** Finished agents gather at the pantry; idle ones rest in the lounge. Defaults to resting. */
  purpose?: "rest" | "gather";
}

/**
 * Where everybody on a break in one room is. An idle agent rests: for each
 * stretch of its break it has its own order of preference, the lounge first.
 * A finished agent gathers: the pantry's standing table first, then outwards
 * from it. Each takes the first place that was free when its stretch began:
 * whoever was already somewhere keeps it. So no two share a tile, nobody is unseated by a
 * newcomer, and nobody moves except when their own stretch ends. When the use
 * points are all taken the rest wait on the walkway, one tile each, and when
 * that is full too they are left out: they stay at their desks.
 */
export function assignBreaks(room: Room, idlers: readonly Idler[], reserved: readonly Point[], now: number): Map<string, UseSpot> {
  const spots = room.zones.flatMap((zone) => zone.spots);
  const walkway: UseSpot[] = [];
  // The corridor's foot is kept clear: everybody comes in through it.
  for (let x = room.lounge.walkway.x + 1; x < room.lounge.walkway.x + room.lounge.walkway.width; x += 1) {
    walkway.push({
      id: `walkway:${x - room.lounge.walkway.x}`,
      x,
      y: room.lounge.walkway.y,
      aisleY: room.lounge.walkway.y,
      pose: "stand",
      facing: "down",
      lift: 0,
      prop: null,
      zone: "walkway",
    });
  }
  const key = (spot: Point) => `${spot.x},${spot.y}`;
  // The table stands between the two zones; both its places belong with the pantry.
  const pantry = spots.filter((spot) => spot.zone === "pantry" || spot.prop === "table");
  const lounge = spots.filter((spot) => !pantry.includes(spot));
  // Where people gather: the standing table, or failing that the middle of the pantry.
  const table = room.zones.flatMap((zone) => zone.props).find((item) => item.id === "table");
  const hub = table ? table.x : pantry.reduce((sum, spot) => sum + spot.x, 0) / Math.max(1, pantry.length);
  const blocked = new Set(reserved.map(key));
  const people = [...idlers].sort((a, b) => a.agentId.localeCompare(b.agentId));

  /** When the stretch an agent was in at `time` began for it: not before it went idle. */
  const begun = (idler: Idler, time: number) => {
    const stretch = breakStretch(idler.agentId, time);
    return { index: stretch.index, at: Math.max(stretch.startedAt, idler.since) };
  };
  const known = new Map<string, UseSpot | null>();
  /** Where an agent was at `time`: the choice it made when that stretch began. */
  const placeAt = (idler: Idler, time: number): UseSpot | null => {
    const mine = begun(idler, time);
    const memo = `${idler.agentId}/${mine.index}`;
    const cached = known.get(memo);
    if (cached !== undefined) return cached;
    const taken = new Set(blocked);
    for (const other of people) {
      if (other === idler || other.since > mine.at) continue;
      const theirs = begun(other, mine.at);
      // Whoever began earlier was there first; a tie goes to the lower id.
      if (theirs.at > mine.at || (theirs.at === mine.at && other.agentId > idler.agentId)) continue;
      const place = placeAt(other, theirs.at === mine.at ? mine.at : mine.at - 1);
      if (place) taken.add(key(place));
    }
    const anyOf = (choices: readonly UseSpot[]) =>
      choices
        .map((spot, index) => ({ spot, rank: hash(`${idler.agentId}/${mine.index}/${index}`) }))
        .sort((a, b) => a.rank - b.rank)
        .map((entry) => entry.spot);
    // Whoever has finished goes where the others are: the table first, then outwards from it, the
    // same order for everybody, so they stand together and not spread along the wall.
    const together = (choices: readonly UseSpot[]) =>
      [...choices].sort((a, b) => Math.abs(a.x - hub) - Math.abs(b.x - hub) || b.y - a.y || a.x - b.x);
    const order =
      idler.purpose === "gather"
        ? [...together(pantry), ...together(walkway.filter((spot) => Math.abs(spot.x - hub) <= 3)), ...anyOf(lounge), ...anyOf(walkway)]
        : [...anyOf(lounge), ...anyOf(pantry), ...anyOf(walkway)];
    const choice = order.find((spot) => !taken.has(key(spot))) ?? null;
    known.set(memo, choice);
    return choice;
  };

  const out = new Map<string, UseSpot>();
  for (const idler of people) {
    const place = placeAt(idler, now);
    if (place) out.set(idler.agentId, place);
  }
  return out;
}

/**
 * Where a character is and what it is doing. `breakSpot` is where an idle or
 * finished agent's break takes it, from `assignBreaks`; without one an idle
 * agent sleeps at its desk and a finished one stands at it. `company` says
 * somebody is standing across the table from it.
 */
export function presenceOf(
  agent: PaseoAgent,
  state: CrewState,
  desk: Desk,
  breakSpot: UseSpot | null,
  now: number,
  company = false,
): Presence {
  const base = {
    agentId: agent.id,
    state,
    visible: true,
    range: null,
    aisleY: desk.aisleY,
    lounging: false,
    lift: 0,
    carry: null,
    act: null,
    placeId: null,
  };
  const away = breakSpot && onBreak(agent, now) ? breakSpot : null;
  switch (state) {
    case "working":
      return { ...base, activity: "typing", at: desk.seat, facing: "up", seated: true, screenOn: true, emote: null };
    case "needs-input":
      return { ...base, activity: "asking", at: desk.stand, facing: "down", seated: false, screenOn: true, emote: "question" };
    case "failed":
      return { ...base, activity: "stuck", at: desk.seat, facing: "down", seated: true, screenOn: true, emote: "alert" };
    case "ready": {
      if (!away) {
        return { ...base, activity: "done", at: desk.stand, facing: "down", seated: false, screenOn: true, emote: "check" };
      }
      // It keeps its check wherever it goes, and its screen stays lit: there is something to read.
      const atTable = away.prop === "table";
      const sitting = away.pose === "sit";
      return {
        ...base,
        activity: "gathering",
        placeId: away.id,
        at: { x: away.x, y: away.y },
        aisleY: away.aisleY,
        // At the table it faces whoever is opposite; anywhere else it turns to the room, cup in hand.
        facing: atTable || sitting ? away.facing : "down",
        seated: false,
        lounging: sitting,
        lift: away.lift,
        act: sitting ? null : atTable && company ? "talk" : "drink",
        screenOn: true,
        emote: "check",
      };
    }
    case "closed":
      return { ...base, activity: "away", at: desk.seat, facing: "up", visible: false, seated: false, screenOn: false, emote: null };
    case "idle": {
      if (!away) {
        return { ...base, activity: "asleep", at: desk.seat, facing: "up", seated: true, screenOn: false, emote: "zzz" };
      }
      const whim = hash(`${agent.id}/${breakStretch(agent.id, now).index}/whim`) % 3;
      const sitting = away.pose === "sit";
      const act: Act | null = sitting
        ? away.prop === "beanbag" || whim === 1
          ? "doze"
          : whim === 2
            ? "read"
            : null
        : away.prop === "table"
          ? company
            ? "talk"
            : "drink"
          : away.zone === "walkway"
            ? "stretch"
            : null;
      return {
        ...base,
        activity: "wandering",
        placeId: away.id,
        at: { x: away.x, y: away.y },
        aisleY: away.aisleY,
        facing: away.facing,
        seated: false,
        lounging: sitting,
        lift: away.lift,
        carry: act === "read" ? "book" : null,
        act,
        screenOn: false,
        emote: null,
      };
    }
  }
}

/** Whether an idle agent is still within its break; an unreadable timestamp counts as long ago. */
export function onBreak(agent: PaseoAgent, now: number): boolean {
  return now - Date.parse(activityAt(agent)) < WANDER_MS;
}

/** Presence for every agent seated in the office, and for its visitors. */
export function presences(
  office: Office,
  agents: ReadonlyMap<string, PaseoAgent>,
  stateOf: (agent: PaseoAgent) => CrewState,
  now: number,
): Map<string, Presence> {
  const states = new Map<string, CrewState>();
  const idlers = new Map<string, Idler[]>();
  for (const agentId of office.desks.keys()) {
    const agent = agents.get(agentId);
    if (!agent) continue;
    const state = stateOf(agent);
    states.set(agentId, state);
    if ((state !== "idle" && state !== "ready") || !onBreak(agent, now)) continue;
    const roomId = office.roomOf.get(agentId) ?? "";
    idlers.set(roomId, [
      ...(idlers.get(roomId) ?? []),
      { agentId, since: Date.parse(activityAt(agent)), purpose: state === "ready" ? "gather" : "rest" },
    ]);
  }
  const breaks = new Map<string, UseSpot>();
  for (const room of office.rooms) {
    const guests = [...office.visitors.values()].filter((visitor) => visitor.workspaceId === room.workspaceId);
    const assigned = assignBreaks(room, idlers.get(room.workspaceId) ?? [], guests.map((guest) => guest.at), now);
    for (const [agentId, spot] of assigned) breaks.set(agentId, spot);
  }
  const occupied = new Set([...breaks.values()].map((spot) => `${spot.x},${spot.y}`));
  const out = new Map<string, Presence>();
  for (const [agentId, desk] of office.desks) {
    const agent = agents.get(agentId);
    const state = states.get(agentId);
    if (!agent || !state) continue;
    const spot = breaks.get(agentId) ?? null;
    // The table's two places are a tile either side of it: somebody opposite is two tiles along.
    const company =
      spot?.prop === "table" && occupied.has(`${spot.x + (spot.facing === "right" ? 2 : -2)},${spot.y}`);
    out.set(agentId, presenceOf(agent, state, desk, spot, now, company));
  }
  for (const [agentId, visitor] of office.visitors) {
    const agent = agents.get(agentId);
    if (!agent) continue;
    const state = stateOf(agent);
    out.set(agentId, {
      agentId,
      state,
      activity: "visiting",
      at: visitor.at,
      aisleY: visitor.at.y,
      facing: "down",
      visible: true,
      seated: false,
      lounging: false,
      lift: 0,
      carry: null,
      act: null,
      placeId: "visitor",
      screenOn: false,
      emote: state === "needs-input" ? "question" : state === "failed" ? "alert" : state === "ready" ? "check" : null,
      range: null,
    });
  }
  return out;
}

/**
 * The next moment at which `presences` gives a different answer though no
 * agent has changed: somebody's stretch of a break ends and it may move on, or
 * its break is over and it goes back to its desk. Null when nobody is on a
 * break: then nothing in the office changes until an agent does.
 */
export function nextPresenceChange(
  office: Office,
  agents: ReadonlyMap<string, PaseoAgent>,
  stateOf: (agent: PaseoAgent) => CrewState,
  now: number,
): number | null {
  let next: number | null = null;
  for (const agentId of office.desks.keys()) {
    const agent = agents.get(agentId);
    if (!agent) continue;
    const state = stateOf(agent);
    if ((state !== "idle" && state !== "ready") || !onBreak(agent, now)) continue;
    const at = Math.min(Date.parse(activityAt(agent)) + WANDER_MS, breakStretch(agentId, now).endsAt);
    if (at > now && (next === null || at < next)) next = at;
  }
  return next;
}

/** Plain data compared by what it holds: arrays and objects all the way down. */
function alike(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => key in right && alike(left[key], right[key]));
}

function shareEntries<Value>(before: ReadonlyMap<string, Value>, after: ReadonlyMap<string, Value>): ReadonlyMap<string, Value> {
  let same = before.size === after.size;
  const out = new Map<string, Value>();
  for (const [key, value] of after) {
    const old = before.get(key);
    const kept = old !== undefined && alike(old, value) ? old : value;
    if (kept !== old) same = false;
    out.set(key, kept);
  }
  // Order is part of a map: the scene draws in it.
  if (same) {
    const order = before.keys();
    for (const key of after.keys()) if (order.next().value !== key) return out;
    return before;
  }
  return out;
}

/**
 * `after`, with every room, desk and visitor that is the same as in `before`
 * being the very object from `before`. A layout is computed whole each time an
 * agent changes; with this, what did not change is seen not to have, and only
 * what did is drawn again.
 */
export function shareOffice(before: Office | null, after: Office): Office {
  if (!before) return after;
  const old = new Map(before.rooms.map((room) => [room.workspaceId, room]));
  const rooms = after.rooms.map((room) => {
    const known = old.get(room.workspaceId);
    return known && alike(known, room) ? known : room;
  });
  const sameRooms = rooms.length === before.rooms.length && rooms.every((room, index) => room === before.rooms[index]);
  const desks = shareEntries(before.desks, after.desks);
  const roomOf = shareEntries(before.roomOf, after.roomOf);
  const visitors = shareEntries(before.visitors, after.visitors);
  const building = alike(before.building, after.building) ? before.building : after.building;
  if (
    sameRooms &&
    desks === before.desks &&
    roomOf === before.roomOf &&
    visitors === before.visitors &&
    building === before.building &&
    before.width === after.width &&
    before.height === after.height &&
    before.cramped === after.cramped
  ) {
    return before;
  }
  return { ...after, rooms: sameRooms ? before.rooms : rooms, desks, roomOf, visitors, building };
}

/** The same for presences: whoever is doing what it was doing keeps its object. */
export function sharePresences(
  before: ReadonlyMap<string, Presence> | null,
  after: ReadonlyMap<string, Presence>,
): ReadonlyMap<string, Presence> {
  return before ? shareEntries(before, after) : after;
}
