import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, ScrollView, useRevealedText } from "@getpaseo/plugin/client/react-native";
import type { PaseoApi } from "./paseo-types";
import { memo, useCallback, useMemo, useRef } from "react";
import {
  Pressable,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollView as NativeScrollView,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { bounded, chatRows, readableText, type ChatItem, type ChatRow } from "./chat-model";
import type { CrewState } from "./model";
import { IconButton, Muted, font, pressStyle, radius, space } from "./ui";
import { useChat } from "./use-chat";

/** Within this many points of the end, the chat follows what is written next. */
const STICK_SLOP = 24;
/**
 * Under a list row the chat has no scroller of its own, which a list row cannot hold
 * reliably on every platform: it draws this many of its last lines, each message cut
 * to this many characters, and points to the full chat for the rest.
 */
const COMPACT_ROWS = 6;
const COMPACT_CHARS = 280;

const TOOL_ICON: Record<string, string> = {
  running: "Loader",
  completed: "Check",
  failed: "X",
  canceled: "Ban",
};

/** The text being written appears as it streams; anything finished, or with less motion asked for, is shown whole. */
function AssistantText({ theme, text, streaming }: { theme: PluginTheme; text: string; streaming: boolean }) {
  const shown = useRevealedText(text, streaming ? "streaming" : "complete");
  return (
    <Text selectable style={{ color: theme.colors.foreground, fontSize: font.sm, lineHeight: font.sm * 1.5 }}>
      {shown}
    </Text>
  );
}

function Pointer({
  theme,
  label,
  onOpen,
}: {
  theme: PluginTheme;
  label: string;
  onOpen: (() => void) | null;
}) {
  const body = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
      {onOpen ? <Icon name="ArrowUpRight" size={12} color={theme.colors.foregroundMuted} /> : null}
      <Muted theme={theme} size={font.xs} numberOfLines={1} style={{ flexShrink: 1 }}>
        {label}
      </Muted>
    </View>
  );
  if (!onOpen) return body;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${label}. Open the agent`}
      onPress={onOpen}
      style={pressStyle(({ hovered }) => ({ opacity: hovered ? 0.7 : 1, alignSelf: "flex-start" }))}
    >
      {body}
    </Pressable>
  );
}

const Row = memo(function Row({
  theme,
  row,
  streaming,
  onOpen,
  maxChars,
}: {
  theme: PluginTheme;
  row: ChatRow;
  streaming: boolean;
  onOpen: (() => void) | null;
  /** Cuts each message to this many characters. */
  maxChars?: number;
}) {
  const { colors } = theme;
  if (row.kind === "tools") {
    const latest = row.tools[row.tools.length - 1] as Extract<ChatItem, { kind: "tool" }>;
    const color =
      latest.status === "failed" ? colors.statusDanger : latest.status === "running" ? colors.accent : colors.foregroundMuted;
    const more = row.tools.length - 1;
    return (
      <View
        accessible
        accessibilityLabel={`${row.tools.length === 1 ? "Tool call" : `${row.tools.length} tool calls, the latest`} ${latest.label}${latest.summary ? `, ${latest.summary}` : ""}, ${latest.status}`}
        style={{ flexDirection: "row", alignItems: "center", gap: space.xs + 2, minHeight: 20 }}
      >
        <Icon name={TOOL_ICON[latest.status] ?? "Wrench"} size={12} color={color} />
        <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: font.xs, color: colors.foregroundMuted }}>
          <Text style={{ color: colors.foreground, fontWeight: "500" }}>{latest.word}</Text>
          {latest.summary ? `  ${latest.summary}` : ""}
        </Text>
        {more > 0 ? (
          <Muted theme={theme} size={font.xs}>
            +{more}
          </Muted>
        ) : null}
      </View>
    );
  }
  const { item } = row;
  const full = "text" in item ? (item.kind === "assistant" ? readableText(item.text) : item.text) : "";
  const clipped = maxChars !== undefined && full.length > maxChars ? `${bounded(full, maxChars).text.trimEnd()}…` : full;
  const rest =
    ("cut" in item && item.cut) || clipped !== full ? (
      <Pointer theme={theme} label="Continues in the full chat" onOpen={onOpen} />
    ) : null;
  switch (item.kind) {
    case "user":
      return (
        <View style={{ gap: space.xs }}>
          <View style={{ alignSelf: "flex-end", maxWidth: "92%", backgroundColor: colors.surface2, borderRadius: radius.md, paddingHorizontal: space.sm + 2, paddingVertical: space.xs + 2 }}>
            <Text selectable style={{ color: colors.foreground, fontSize: font.sm, lineHeight: font.sm * 1.45 }}>
              {clipped}
            </Text>
          </View>
          {rest}
        </View>
      );
    case "assistant":
      return (
        <View style={{ gap: space.xs }}>
          <AssistantText theme={theme} text={clipped} streaming={streaming} />
          {rest}
        </View>
      );
    case "message":
      // A child finishing or failing is one line; a message is its sender and what it said.
      if (item.event !== "message") {
        return (
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
            <Icon name="Bell" size={12} color={item.event === "errored" ? colors.statusDanger : colors.foregroundMuted} />
            <Muted theme={theme} size={font.xs} numberOfLines={1} style={{ flexShrink: 1 }}>
              {`${item.fromTitle ?? "Another agent"} ${clipped}`}
            </Muted>
          </View>
        );
      }
      return (
        <View style={{ gap: 2, borderLeftWidth: 2, borderLeftColor: colors.border, paddingLeft: space.sm }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
            <Icon name="MessageSquare" size={12} color={colors.foregroundMuted} />
            <Muted theme={theme} size={font.xs} numberOfLines={1}>
              {item.fromTitle ? `From ${item.fromTitle}` : "From another agent"}
            </Muted>
          </View>
          <Text selectable numberOfLines={8} style={{ color: colors.foreground, fontSize: font.sm, lineHeight: font.sm * 1.45 }}>
            {clipped}
          </Text>
          {rest}
        </View>
      );
    case "error":
      return (
        <View style={{ flexDirection: "row", gap: space.xs + 2 }}>
          <Icon name="CircleAlert" size={12} color={colors.statusDanger} />
          <Text selectable numberOfLines={6} style={{ flex: 1, color: colors.statusDanger, fontSize: font.xs, lineHeight: font.xs * 1.45 }}>
            {clipped}
          </Text>
        </View>
      );
    case "note":
      return (
        <Muted theme={theme} size={font.xs} numberOfLines={2}>
          {item.text}
        </Muted>
      );
    case "elsewhere":
      return <Pointer theme={theme} label={`${item.what} this view does not show`} onOpen={onOpen} />;
  }
});

/**
 * The agent's last few items, newest at the bottom, read-only. It follows the
 * end while you are at the end, and stays where you scrolled to otherwise.
 */
export function AgentChat({
  theme,
  paseo,
  agentId,
  state,
  shown,
  still,
  onOpen,
  compact,
  style,
}: {
  theme: PluginTheme;
  paseo: PaseoApi;
  agentId: string;
  state: CrewState;
  /** False while the pane is hidden: nothing is held or asked. */
  shown: boolean;
  /** Reduced motion: streamed text is shown whole at once. */
  still: boolean;
  /** Opens the agent's own chat; null where the host cannot. */
  onOpen: (() => void) | null;
  /** Under a list row: the last few lines, no scroller of its own. */
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const chat = useChat(paseo, agentId, state, shown);
  const allRows = useMemo(() => chatRows(chat.state.items), [chat.state.items]);
  const rows = compact ? allRows.slice(-COMPACT_ROWS) : allRows;
  const earlier = rows.length > 0 && (chat.state.hasOlder || rows.length < allRows.length);
  const scroller = useRef<NativeScrollView>(null);
  const atEnd = useRef(true);
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    atEnd.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - STICK_SLOP;
  }, []);
  const onContentSizeChange = useCallback(() => {
    if (atEnd.current) scroller.current?.scrollToEnd({ animated: false });
  }, []);
  const onLayout = useCallback(() => {
    if (atEnd.current) scroller.current?.scrollToEnd({ animated: false });
  }, []);
  const { colors } = theme;
  const lastKey = rows[rows.length - 1]?.key;
  const streamingKey =
    chat.live && chat.wanted && chat.state.open && !still && rows[rows.length - 1]?.kind === "item" ? lastKey : undefined;

  let status: { text: string; tone: "muted" | "danger"; retry: boolean } | null = null;
  if (chat.phase === "loading" && rows.length === 0) status = { text: "Loading the chat", tone: "muted", retry: false };
  else if (chat.phase === "error" && rows.length === 0) status = { text: "Could not load the chat", tone: "danger", retry: true };
  else if (chat.wanted && !chat.live && chat.phase !== "loading")
    status = { text: "Not live: showing what was loaded", tone: "muted", retry: true };
  else if (rows.length === 0) status = { text: "Nothing in the chat yet", tone: "muted", retry: false };

  const lines = (
    <>
      {earlier ? <Pointer theme={theme} label="Earlier messages are in the full chat" onOpen={onOpen} /> : null}
      {rows.map((row) => (
        <Row
          key={row.key}
          theme={theme}
          row={row}
          streaming={row.key === streamingKey}
          onOpen={onOpen}
          maxChars={compact ? COMPACT_CHARS : undefined}
        />
      ))}
      {status ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
          <Text
            style={{ flex: 1, fontSize: font.xs, color: status.tone === "danger" ? colors.statusDanger : colors.foregroundMuted }}
          >
            {status.text}
          </Text>
          {status.retry ? <IconButton theme={theme} icon="RefreshCw" label="Load the chat again" onPress={chat.refresh} size={24} /> : null}
        </View>
      ) : null}
    </>
  );
  if (compact) {
    return (
      <View accessibilityLabel="Recent chat, read-only" style={[{ gap: space.sm + 2, paddingVertical: space.sm }, style]}>
        {lines}
      </View>
    );
  }
  return (
    <View style={[{ minHeight: 0 }, style]}>
      <ScrollView
        ref={scroller}
        onScroll={onScroll}
        scrollEventThrottle={100}
        onContentSizeChange={onContentSizeChange}
        onLayout={onLayout}
        contentContainerStyle={{ gap: space.sm + 2, paddingVertical: space.sm }}
        accessibilityLabel="Recent chat, read-only"
      >
        {lines}
      </ScrollView>
    </View>
  );
}
