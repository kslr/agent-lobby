import { usePaseo, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import type { PaseoAgent } from "./paseo-types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PixelRatio, Pressable, Text, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import { AgentDialogs, Detail, useAgentActions } from "./detail";
import { candidatesOf } from "./feed-plan";
import { CrewList } from "./list";
import {
  buildForest,
  countStates,
  crewState,
  displayModel,
  displayTitle,
  filterForest,
  groupByWorkspace,
  matches,
  roleOf,
  activityAt,
  formatAge,
  nextAgeChange,
  STATE_LABEL,
  STATE_ORDER,
  summary,
  type CrewNode,
  type CrewState,
} from "./model";
import { MotionPaused } from "./motion";
import { OfficeScene } from "./office";
import {
  isDormant,
  layoutOffice,
  nextPresenceChange,
  presences as presencesOf,
  shareOffice,
  sharePresences,
  type Office,
  type Presence,
} from "./office-model";
import { highlighted as highlightedBy, indexNodes, sceneScale, zoomScale } from "./scene-model";
import {
  Chip,
  Empty,
  IconButton,
  Muted,
  StatusDot,
  font,
  pressStyle,
  radius,
  space,
  stateColor,
  useReducedMotion,
} from "./ui";
import { useDirectory, useShown, useWake } from "./use-directory";
import { useFeed } from "./use-feed";
import { nextWake, paneShown } from "./wake";

type Filter = CrewState | "all";
type Mode = "office" | "list";

/** Below this width the detail docks under the office instead of beside it. */
const SIDE_DOCK_MIN_WIDTH = 720;
const SIDE_DOCK_WIDTH = 320;
const SIDE_DOCK_MAX_WIDTH = 420;
const NOBODY: ReadonlySet<string> = new Set();

export interface CrewViewProps extends PluginSurfaceProps {
  scope: string | null;
}

export function CrewView({ scope: homeScope, theme, host, layout, navigation }: CrewViewProps) {
  // A panel starts on its own workspace and can widen to every workspace; the surface is always wide.
  const inPanel = homeScope !== null;
  const [allWorkspaces, setAllWorkspaces] = useState(false);
  const scope = inPanel && !allWorkspaces ? homeScope : null;
  const paseo = usePaseo();
  const [size, setSize] = useState({ view: 0, height: 0, scene: 0 });
  // The host keeps a pane mounted behind another tab; then nothing here runs.
  const shown = useShown(paneShown(size.view, size.height));
  const directory = useDirectory(paseo, shown);
  // Time moves here only when something drawn depends on it: see `wakeAt`.
  const [turn, setTurn] = useState(0);
  const now = useMemo(() => Date.now(), [turn, directory.agents, shown]);
  const actions = useAgentActions(paseo);
  const reducedMotion = useReducedMotion();
  const [mode, setMode] = useState<Mode>("office");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<string | null>(null);
  // The room whose closed agents are listed in the dock.
  const [closedRoom, setClosedRoom] = useState<string | null>(null);
  const [inView, setInView] = useState<readonly string[] | null>(null);
  const { colors } = theme;
  const { setDialog, respond, busy } = actions;

  const roots = useMemo(() => buildForest(directory.agents.values(), scope), [directory.agents, scope]);
  const counts = useMemo(() => countStates(roots), [roots]);
  const workspaceName = useCallback(
    (agent: PaseoAgent) => (agent.workspaceId ? (directory.workspaces.get(agent.workspaceId)?.name ?? null) : null),
    [directory.workspaces],
  );
  const keep = useCallback(
    (node: CrewNode) =>
      (filter === "all" || node.state === filter) && matches(node.agent, query, workspaceName(node.agent)),
    [filter, query, workspaceName],
  );
  // The list drops what does not match; the office keeps every seat and dims instead.
  const listed = useMemo(() => filterForest(roots, keep), [roots, keep]);
  const highlighted = useMemo(
    () => highlightedBy(roots, filter, query, workspaceName),
    [roots, filter, query, workspaceName],
  );

  const office = mode === "office";
  // Small in a side pane; a wider pane draws it larger, as far as the office still fits across.
  const baseScale = useMemo(() => sceneScale(size.scene, PixelRatio.get()), [size.scene]);
  const nodes = useMemo(() => indexNodes(roots), [roots]);
  // A closed agent has no desk, but it keeps the one it had until it has walked out of the door.
  const [left, setLeft] = useState<ReadonlySet<string>>(NOBODY);
  const seatedBefore = useRef<ReadonlySet<string>>(NOBODY);
  const holding = useMemo(() => {
    if (!office || reducedMotion) return NOBODY;
    const out = new Set<string>();
    for (const [id, node] of nodes) {
      if (node.state === "closed" && seatedBefore.current.has(id) && !left.has(id)) out.add(id);
    }
    return out.size > 0 ? out : NOBODY;
  }, [nodes, left, office, reducedMotion]);
  const everyGroup = useMemo(() => groupByWorkspace(roots, directory.workspaces), [roots, directory.workspaces]);
  // Across workspaces, a room nobody is in stays folded away until a search or
  // the Closed filter singles out somebody in it.
  const groups = useMemo(() => {
    if (scope !== null) return everyGroup;
    return everyGroup.filter(
      (group) =>
        !isDormant(group) ||
        // Its last agent is still walking out.
        candidatesOf(group.roots).some((candidate) => holding.has(candidate.id)) ||
        (highlighted !== null && candidatesOf(group.roots).some((candidate) => highlighted.has(candidate.id))),
    );
  }, [everyGroup, scope, highlighted, holding]);
  const folded = everyGroup.length - groups.length;
  // Laid out whole each time; what came out as before is the object from before, and is not drawn again.
  const lastPlan = useRef<Office | null>(null);
  const { plan, scale } = useMemo(() => {
    const options = { agents: directory.agents, holding };
    const natural = layoutOffice(groups, { ...options, width: baseScale.widthTiles });
    const zoomed = zoomScale(baseScale, natural.building?.depth.length ?? 0, size.scene, PixelRatio.get());
    const laid = zoomed === baseScale ? natural : layoutOffice(groups, { ...options, width: zoomed.widthTiles });
    const next = shareOffice(lastPlan.current, laid);
    lastPlan.current = next;
    return { plan: next, scale: zoomed };
  }, [groups, baseScale, size.scene, directory.agents, holding]);
  useEffect(() => {
    seatedBefore.current = office ? new Set(plan.desks.keys()) : NOBODY;
  }, [plan, office]);
  useEffect(() => {
    // Whoever is no longer closed, or no longer here, is forgotten.
    setLeft((current) => {
      const kept = [...current].filter((id) => nodes.get(id)?.state === "closed");
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [nodes]);
  const onLeft = useCallback((agentId: string) => setLeft((current) => new Set(current).add(agentId)), []);
  const lastPresences = useRef<ReadonlyMap<string, Presence> | null>(null);
  const presences = useMemo(() => {
    const next = sharePresences(lastPresences.current, presencesOf(plan, directory.agents, crewState, now));
    lastPresences.current = next;
    return next;
  }, [plan, directory.agents, now]);
  // Only the rooms on screen compete for the live subscriptions.
  const candidates = useMemo(() => {
    const visible = inView ? new Set(inView) : null;
    return candidatesOf(groups.filter((group) => !visible || visible.has(group.workspaceId)).flatMap((group) => group.roots));
  }, [groups, inView]);
  // The scene's own size passes through nothing too; its leases are held through that like the rest.
  const sceneShown = useShown(size.scene > 0);
  const feed = useFeed(paseo, candidates, { enabled: shown && office && sceneShown });

  const openAgent = useCallback(
    (agent: PaseoAgent) => navigation?.openAgent({ agentId: agent.id, serverId: host.id }),
    [navigation, host.id],
  );
  const toggle = useCallback((agentId: string) => {
    setClosedRoom(null);
    setSelected((current) => (current === agentId ? null : agentId));
  }, []);
  const openClosed = useCallback((workspaceId: string) => {
    setSelected(null);
    setClosedRoom((current) => (current === workspaceId ? null : workspaceId));
  }, []);
  const closedList = useMemo(() => {
    const room = office && closedRoom ? plan.rooms.find((entry) => entry.workspaceId === closedRoom) : undefined;
    if (!room?.closed) return null;
    const listed = room.closed.ids.flatMap((id) => nodes.get(id) ?? []);
    // What a search or filter singles out comes first.
    const first = highlighted ? listed.filter((node) => highlighted.has(node.agent.id)) : [];
    return { name: room.name, nodes: [...first, ...listed.filter((node) => !first.includes(node))], matching: first.length };
  }, [office, closedRoom, plan, nodes, highlighted]);

  const detailFor = useCallback(
    (node: CrewNode, place: { dock: boolean; style: StyleProp<ViewStyle> }) => (
      <Detail
        theme={theme}
        paseo={paseo}
        node={node}
        shown={shown}
        still={reducedMotion}
        workspaceName={workspaceName(node.agent)}
        title={place.dock}
        {...(place.dock
          ? {
              onClose: () => setSelected(null),
              closeIcon: closedList ? "ArrowLeft" : "X",
              closeLabel: closedList ? "Back to the closed agents" : "Close details",
            }
          : {})}
        canOpen={Boolean(navigation)}
        onOpen={() => openAgent(node.agent)}
        onMessage={() => setDialog({ kind: "message", agent: node.agent })}
        onArchive={() => setDialog({ kind: "archive", agent: node.agent })}
        onReview={(requestId) => setDialog({ kind: "permission", agent: node.agent, requestId })}
        onRespond={(requestId, allow) => void respond(node.agent, requestId, allow)}
        busy={busy}
        compact={!place.dock}
        style={place.style}
        // In the dock the chat takes what is left and scrolls; under a list row it is its last few lines.
        chatStyle={place.dock ? { flex: 1 } : undefined}
      />
    ),
    [theme, paseo, shown, reducedMotion, workspaceName, closedList, navigation, openAgent, setDialog, respond, busy],
  );
  const renderDetail = useCallback(
    (node: CrewNode, style: StyleProp<ViewStyle>) => detailFor(node, { dock: false, style }),
    [detailFor],
  );

  const chips = STATE_ORDER.filter((state) => counts[state] > 0);
  const emptyLabel =
    directory.phase === "loading"
      ? ""
      : scope
        ? "No agents in this workspace"
        : "No agents";
  const noMatchLabel = query || filter !== "all" ? "No matching agents" : emptyLabel;

  // A visitor has no node in this forest; it still has a detail.
  const selectedNode = useMemo<CrewNode | undefined>(() => {
    if (!selected) return undefined;
    const seated = nodes.get(selected);
    if (seated) return seated;
    const visitor = office && plan.visitors.has(selected) ? directory.agents.get(selected) : undefined;
    return visitor
      ? { agent: visitor, state: crewState(visitor), depth: 0, children: [], descendants: 0 }
      : undefined;
  }, [selected, nodes, office, plan.visitors, directory.agents]);
  const sideDock = size.view >= SIDE_DOCK_MIN_WIDTH;
  // A chat reads better wider; the office keeps at least as much as the dock takes.
  const dockWidth = Math.round(Math.min(SIDE_DOCK_MAX_WIDTH, Math.max(SIDE_DOCK_WIDTH, size.view * 0.4)));
  // A workspace pane fills its dock; the global list is reading-width, like Paseo's list pages.
  const column = !inPanel ? { width: "100%" as const, maxWidth: 720, alignSelf: "center" as const } : null;
  const onViewLayout = (event: LayoutChangeEvent) => {
    const width = Math.round(event.nativeEvent.layout.width);
    const height = Math.round(event.nativeEvent.layout.height);
    setSize((current) => (current.view === width && current.height === height ? current : { ...current, view: width, height }));
  };
  // The one timer of a view at rest: the next break that moves on or ends, or the next age that reads differently.
  const wakeAt = useMemo(() => {
    if (!shown) return null;
    const aged = office ? (closedList?.nodes ?? []) : [...nodes.values()];
    return nextWake(
      office ? nextPresenceChange(plan, directory.agents, crewState, now) : null,
      aged.map((node) => nextAgeChange(activityAt(node.agent), now)),
      now,
    );
  }, [shown, office, closedList, nodes, plan, directory.agents, now]);
  useWake(wakeAt, turn, () => setTurn((count) => count + 1));
  const onSceneLayout = (event: LayoutChangeEvent) => {
    const width = Math.round(event.nativeEvent.layout.width);
    setSize((current) => (current.scene === width ? current : { ...current, scene: width }));
  };

  // The header is the same from one agent's update to the next unless a count moved: it is not drawn again for each.
  const countsKey = STATE_ORDER.map((state) => counts[state]).join(",");
  const noMatches = office && highlighted !== null && highlighted.size === 0;
  const header = useMemo(
    () => (
        <View style={[{ paddingHorizontal: space.lg, paddingTop: space.md, gap: space.sm }, office ? null : column]}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            {directory.phase === "loading" ? (
              <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: space.sm }}>
                <StatusDot theme={theme} state="working" pulse />
                <Muted theme={theme} size={font.sm}>
                  Loading agents
                </Muted>
              </View>
            ) : (
              <Muted theme={theme} size={font.sm} style={{ flex: 1 }}>
                {summary(counts)}
                {directory.truncated ? " · first 2000" : ""}
              </Muted>
            )}
            <Chip theme={theme} label="Office" selected={office} onPress={() => setMode("office")} />
            <Chip theme={theme} label="List" selected={!office} onPress={() => setMode("list")} />
            <IconButton theme={theme} icon="RefreshCw" label="Refresh" onPress={directory.reload} />
          </View>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Find an agent"
            placeholderTextColor={colors.foregroundMuted}
            autoCorrect={false}
            style={{
              height: 32,
              paddingHorizontal: space.md,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: colors.border,
              color: colors.foreground,
              fontSize: font.base,
            }}
          />
          {inPanel ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
              <Chip theme={theme} label="This workspace" selected={!allWorkspaces} onPress={() => setAllWorkspaces(false)} />
              <Chip theme={theme} label="All workspaces" selected={allWorkspaces} onPress={() => setAllWorkspaces(true)} />
            </View>
          ) : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
            <Chip theme={theme} label="All" selected={filter === "all"} onPress={() => setFilter("all")} />
            {chips.map((state) => (
              <Chip
                key={state}
                theme={theme}
                label={STATE_LABEL[state]}
                count={counts[state]}
                color={stateColor(theme, state)}
                selected={filter === state}
                onPress={() => setFilter(filter === state ? "all" : state)}
              />
            ))}
          </View>
          {office && folded > 0 ? (
            <Muted theme={theme} size={font.xs}>
              {folded} {folded === 1 ? "workspace" : "workspaces"} with only closed agents not shown. The Closed filter
              brings them in.
            </Muted>
          ) : null}
          {office && highlighted && highlighted.size === 0 ? (
            <Muted theme={theme} size={font.xs}>
              No matching agents
            </Muted>
          ) : null}
          {directory.error ? (
            <Text style={{ color: colors.statusDanger, fontSize: font.xs }}>{directory.error}</Text>
          ) : null}
        </View>
    ),
    // `counts` and `chips` are read through `countsKey`, `column` through `inPanel`.
    [theme, office, inPanel, allWorkspaces, directory.phase, directory.truncated, directory.error, directory.reload, countsKey, query, filter, folded, noMatches],
  );

  return (
    // Behind another tab nothing here is painted; its loops are held, not left to the browser to notice.
    <MotionPaused.Provider value={!shown}>
    <View style={{ flex: 1, backgroundColor: colors.surface0 }} onLayout={onViewLayout}>
      {header}

      {office ? (
        <View style={{ flex: 1, flexDirection: sideDock ? "row" : "column", paddingTop: space.sm }}>
          <View style={{ flex: 1, minWidth: 0, minHeight: 0 }} onLayout={onSceneLayout}>
            {roots.length === 0 ? (
              emptyLabel ? (
                <Empty theme={theme} label={emptyLabel} />
              ) : null
            ) : groups.length === 0 ? (
              <Empty theme={theme} label="Nobody is in" />
            ) : size.scene > 0 ? (
              <OfficeScene
                theme={theme}
                office={plan}
                tile={scale.tile}
                nodes={nodes}
                agents={directory.agents}
                presences={presences}
                bubbles={feed.bubbles}
                exchanges={feed.exchanges}
                selected={selected}
                highlighted={highlighted}
                still={reducedMotion}
                onSelect={toggle}
                onLeft={onLeft}
                onOpenClosed={openClosed}
                available={size.scene}
                onRoomsInView={setInView}
                inView={inView}
              />
            ) : null}
          </View>
          {selectedNode ? (
            <View
              style={[
                { backgroundColor: colors.surface1, borderColor: colors.border },
                sideDock ? { width: dockWidth, borderLeftWidth: 1 } : { height: "40%", borderTopWidth: 1 },
              ]}
            >
              {detailFor(selectedNode, {
                dock: true,
                style: { flex: 1, paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.xs },
              })}
            </View>
          ) : null}
          {!selectedNode && closedList ? (
            <View
              style={[
                { backgroundColor: colors.surface1, borderColor: colors.border },
                sideDock ? { width: dockWidth, borderLeftWidth: 1 } : { maxHeight: "40%", borderTopWidth: 1 },
              ]}
            >
              <ScrollView contentContainerStyle={{ padding: space.md, gap: space.xs }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: font.sm, fontWeight: "600" }}>
                      Closed in {closedList.name}
                    </Text>
                    <Muted theme={theme} size={font.xs}>
                      {closedList.nodes.length} {closedList.nodes.length === 1 ? "agent" : "agents"}
                      {closedList.matching > 0 ? ` · ${closedList.matching} matching` : ""}
                    </Muted>
                  </View>
                  <IconButton theme={theme} icon="X" label="Close the list" onPress={() => setClosedRoom(null)} />
                </View>
                {closedList.nodes.map((node, index) => (
                  <Pressable
                    key={node.agent.id}
                    accessibilityRole="button"
                    accessibilityLabel={`${displayTitle(node.agent)}, ${[roleOf(node.agent), STATE_LABEL[node.state]].filter(Boolean).join(", ")}`}
                    onPress={() => setSelected(node.agent.id)}
                    style={pressStyle(({ hovered, pressed }) => ({
                      minHeight: 44,
                      paddingHorizontal: space.sm,
                      borderRadius: radius.md,
                      justifyContent: "center",
                      backgroundColor: hovered || pressed ? colors.surface2 : "transparent",
                      opacity: highlighted && index >= closedList.matching ? 0.5 : 1,
                    }))}
                  >
                    <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: font.sm }}>
                      {displayTitle(node.agent)}
                    </Text>
                    <Muted theme={theme} size={font.xs} numberOfLines={1}>
                      {[roleOf(node.agent), displayModel(node.agent), formatAge(activityAt(node.agent), now)]
                        .filter(Boolean)
                        .join(" · ")}
                    </Muted>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          ) : null}
        </View>
      ) : (
        <CrewList
          theme={theme}
          roots={listed}
          grouped={scope === null}
          workspaces={directory.workspaces}
          now={now}
          compact={layout.compact}
          selected={selected}
          onSelect={setSelected}
          renderDetail={renderDetail}
          emptyLabel={noMatchLabel}
          extraData={busy}
          contentStyle={column}
        />
      )}

      <AgentDialogs
        theme={theme}
        paseo={paseo}
        actions={actions}
        agents={directory.agents}
        platform={layout.platform}
      />
    </View>
    </MotionPaused.Provider>
  );
}
