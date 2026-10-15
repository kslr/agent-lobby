import type { PluginTheme } from "@getpaseo/plugin";
import { FlatList } from "@getpaseo/plugin/client/react-native";
import type { PaseoWorkspace } from "./paseo-types";
import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import {
  activityAt,
  displayModel,
  displayTitle,
  flatten,
  formatAge,
  groupByWorkspace,
  roleOf,
  STATE_LABEL,
  summary,
  type CrewNode,
} from "./model";
import { StateIcon } from "./sprites";
import { Empty, IconButton, Muted, font, pressStyle, radius, space, stateColor, useReducedMotion } from "./ui";

type Row =
  | { kind: "group"; key: string; name: string; text: string }
  | { kind: "agent"; key: string; node: CrewNode };

/** The crew as rows: a status dot, a title, a muted second line, and the detail under the selected row. */
export function CrewList({
  theme,
  roots,
  grouped,
  workspaces,
  now,
  compact,
  selected,
  onSelect,
  renderDetail,
  emptyLabel,
  extraData,
  contentStyle,
}: {
  theme: PluginTheme;
  /** The forest to list, already filtered. */
  roots: CrewNode[];
  /** True groups the rows under a heading per workspace. */
  grouped: boolean;
  workspaces: ReadonlyMap<string, PaseoWorkspace>;
  now: number;
  compact: boolean;
  selected: string | null;
  onSelect: (agentId: string | null) => void;
  renderDetail: (node: CrewNode, style: StyleProp<ViewStyle>) => ReactElement;
  emptyLabel: string;
  extraData?: unknown;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  const { colors } = theme;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  const rows = useMemo<Row[]>(() => {
    if (!grouped) {
      return flatten(roots, collapsed).map((node) => ({ kind: "agent", key: node.agent.id, node }));
    }
    const out: Row[] = [];
    for (const group of groupByWorkspace(roots, workspaces)) {
      out.push({
        kind: "group",
        key: `group:${group.workspaceId}`,
        name: group.name,
        text: summary(group.counts),
      });
      for (const node of flatten(group.roots, collapsed)) {
        out.push({ kind: "agent", key: node.agent.id, node });
      }
    }
    return out;
  }, [grouped, roots, collapsed, workspaces]);

  const toggleCollapsed = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  const reduced = useReducedMotion();
  const renderRow = useCallback(
    ({ item }: { item: Row }) => {
      if (item.kind === "group") {
        return (
          <View
            style={{
              paddingHorizontal: space.lg,
              paddingTop: space.lg,
              paddingBottom: space.xs,
              flexDirection: "row",
              alignItems: "baseline",
              gap: space.sm,
            }}
          >
            <Text
              numberOfLines={1}
              style={{ color: colors.foreground, fontSize: font.sm, fontWeight: "600", flexShrink: 1 }}
            >
              {item.name}
            </Text>
            <Muted theme={theme} size={font.xs}>
              {item.text}
            </Muted>
          </View>
        );
      }
      const { node } = item;
      const { agent } = node;
      const isSelected = selected === agent.id;
      const secondary = [roleOf(agent), displayModel(agent)].filter(Boolean).join(" · ");
      return (
        <View style={{ paddingHorizontal: space.sm }}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: isSelected }}
            onPress={() => onSelect(isSelected ? null : agent.id)}
            style={pressStyle(({ hovered }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: space.sm,
              paddingVertical: compact ? space.md : space.sm + 2,
              paddingLeft: space.sm + node.depth * space.lg,
              paddingRight: space.sm,
              borderRadius: radius.lg,
              backgroundColor: isSelected ? colors.surface2 : hovered ? colors.surface1 : "transparent",
            }))}
          >
            {node.depth > 0 ? (
              <View
                style={{
                  position: "absolute",
                  left: space.sm + (node.depth - 1) * space.lg + 3,
                  top: 0,
                  bottom: 0,
                  width: 1,
                  backgroundColor: colors.border,
                }}
              />
            ) : null}
            {/* A shape of its own for each state, moving where the state goes on; the word for it is on the right. */}
            <StateIcon theme={theme} state={node.state} still={reduced} />
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: font.base }}>
                {displayTitle(agent)}
              </Text>
              <Muted theme={theme} size={font.xs} numberOfLines={1}>
                {secondary}
              </Muted>
            </View>
            <View style={{ alignItems: "flex-end", gap: 2 }}>
              <Text style={{ color: stateColor(theme, node.state), fontSize: font.xs }}>{STATE_LABEL[node.state]}</Text>
              <Muted theme={theme} size={font.xs}>
                {formatAge(activityAt(agent), now)}
              </Muted>
            </View>
            {node.children.length > 0 ? (
              <IconButton
                theme={theme}
                icon={collapsed.has(agent.id) ? "ChevronRight" : "ChevronDown"}
                label={collapsed.has(agent.id) ? `Expand ${node.descendants}` : "Collapse"}
                onPress={() => toggleCollapsed(agent.id)}
                size={24}
              />
            ) : (
              <View style={{ width: 24 }} />
            )}
          </Pressable>
          {isSelected
            ? renderDetail(node, {
                marginLeft: space.sm + node.depth * space.lg + space.lg,
                marginRight: space.sm,
                marginBottom: space.sm,
              })
            : null}
        </View>
      );
    },
    [colors, theme, compact, selected, collapsed, now, reduced, toggleCollapsed, onSelect, renderDetail],
  );

  return (
    <FlatList
      data={rows}
      keyExtractor={(row: Row) => row.key}
      renderItem={renderRow}
      extraData={[selected, collapsed, now, reduced, extraData]}
      contentContainerStyle={[{ paddingVertical: space.sm, paddingBottom: space.xl }, contentStyle]}
      ListEmptyComponent={emptyLabel ? <Empty theme={theme} label={emptyLabel} /> : null}
      style={{ flex: 1 }}
    />
  );
}
