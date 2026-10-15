import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import type { PaseoAgent, PaseoApi } from "./paseo-types";
import { useCallback, useState } from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { AgentChat } from "./chat";
import { displayModel, displayTitle, roleOf, STATE_LABEL, type CrewNode } from "./model";
import { StateIcon } from "./sprites";
import { Button, IconButton, Muted, font, radius, space, stateColor } from "./ui";

export type Dialog =
  | { kind: "message"; agent: PaseoAgent }
  | { kind: "archive"; agent: PaseoAgent }
  | { kind: "permission"; agent: PaseoAgent; requestId: string };

export interface AgentActions {
  dialog: Dialog | null;
  setDialog: (dialog: Dialog | null) => void;
  draft: string;
  setDraft: (draft: string) => void;
  busy: boolean;
  run: (label: string, action: () => Promise<unknown>) => Promise<void>;
  respond: (agent: PaseoAgent, requestId: string, allow: boolean) => Promise<void>;
}

/** The actions an agent's detail offers, shared by the list and the office. */
export function useAgentActions(paseo: PaseoApi): AgentActions {
  const toast = useToast();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (label: string, action: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await action();
        toast.show(label, { variant: "success" });
        setDialog(null);
        setDraft("");
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );

  const respond = useCallback(
    (agent: PaseoAgent, requestId: string, allow: boolean) =>
      run(allow ? "Allowed" : "Denied", () =>
        paseo.agents.ref(agent.id).respondToPermission({
          requestId,
          response: allow ? { behavior: "allow" } : { behavior: "deny", message: "Denied from Lobby" },
        }),
      ),
    [paseo, run],
  );

  return { dialog, setDialog, draft, setDraft, busy, run, respond };
}

/**
 * One agent: a header with its state and icon actions, the facts folded away,
 * any permission it waits on, and its recent chat, read-only. The same in the
 * office's dock and under a row of the list.
 */
export function Detail({
  theme,
  paseo,
  node,
  shown,
  still,
  workspaceName,
  title,
  onClose,
  closeIcon = "X",
  closeLabel = "Close details",
  canOpen,
  onOpen,
  onMessage,
  onArchive,
  onReview,
  onRespond,
  busy,
  compact,
  style,
  chatStyle,
}: {
  theme: PluginTheme;
  paseo: PaseoApi;
  node: CrewNode;
  /** False while the pane is hidden. */
  shown: boolean;
  still: boolean;
  workspaceName: string | null;
  /** True draws the state, title and model; the list's own row already does. */
  title: boolean;
  onClose?: () => void;
  closeIcon?: string;
  closeLabel?: string;
  canOpen: boolean;
  onOpen: () => void;
  onMessage: () => void;
  onArchive: () => void;
  onReview: (requestId: string) => void;
  onRespond: (requestId: string, allow: boolean) => void;
  busy: boolean;
  /** Under a list row: the chat shows its last few lines without a scroller of its own. */
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
  chatStyle?: StyleProp<ViewStyle>;
}) {
  const { agent } = node;
  const { colors } = theme;
  const [factsOpen, setFactsOpen] = useState(false);
  const facts: Array<[string, string]> = [];
  if (workspaceName) facts.push(["Workspace", workspaceName]);
  facts.push(["Directory", agent.cwd]);
  // Labels are shown as they are, under their last segment; Paseo's own bookkeeping labels are not.
  for (const key of Object.keys(agent.labels).sort()) {
    const value = agent.labels[key];
    if (!value || key.startsWith("paseo.")) continue;
    facts.push([key.slice(key.lastIndexOf("/") + 1), value]);
  }
  if (agent.lastError) facts.push(["Last error", agent.lastError]);
  const secondary = [roleOf(agent), displayModel(agent)].filter(Boolean).join(" · ");
  const actions = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
      <IconButton
        theme={theme}
        icon="Info"
        label={factsOpen ? "Hide details" : agent.lastError ? "Show details and the last error" : "Show details"}
        color={agent.lastError ? colors.statusDanger : factsOpen ? colors.foreground : undefined}
        onPress={() => setFactsOpen((open) => !open)}
      />
      {canOpen ? <IconButton theme={theme} icon="ArrowUpRight" label="Open the agent" onPress={onOpen} /> : null}
      <IconButton theme={theme} icon="MessageSquare" label="Message the agent" onPress={onMessage} />
      {agent.status !== "closed" ? (
        <IconButton theme={theme} icon="Archive" label="Archive the agent" onPress={onArchive} />
      ) : null}
      {onClose ? <IconButton theme={theme} icon={closeIcon} label={closeLabel} onPress={onClose} /> : null}
    </View>
  );
  return (
    <View style={[{ gap: space.sm, minHeight: 0 }, style]}>
      {title ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <StateIcon theme={theme} state={node.state} still={still} />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: font.base, fontWeight: "600" }}>
              {displayTitle(agent)}
            </Text>
            <Text numberOfLines={1} style={{ fontSize: font.xs, lineHeight: font.xs * 1.4, color: colors.foregroundMuted }}>
              <Text style={{ color: stateColor(theme, node.state) }}>{STATE_LABEL[node.state]}</Text>
              {secondary ? ` · ${secondary}` : ""}
            </Text>
          </View>
          {actions}
        </View>
      ) : (
        <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>{actions}</View>
      )}
      {factsOpen ? (
        <View style={{ gap: space.xs }}>
          {facts.map(([label, value]) => (
            <View key={label} style={{ flexDirection: "row", gap: space.sm }}>
              <Muted theme={theme} size={font.xs} style={{ width: 72 }}>
                {label}
              </Muted>
              <Text
                selectable
                numberOfLines={label === "Last error" ? 4 : 2}
                style={{
                  flex: 1,
                  color: label === "Last error" ? colors.statusDanger : colors.foreground,
                  fontSize: font.xs,
                  lineHeight: font.xs * 1.4,
                }}
              >
                {value}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {agent.pendingPermissions.map((request) => (
        <View
          key={request.id}
          style={{
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: radius.md,
            padding: space.md,
            gap: space.sm,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Icon name="ShieldQuestion" size={14} color={colors.statusWarning} />
            <Text numberOfLines={2} style={{ flex: 1, color: colors.foreground, fontSize: font.sm }}>
              {request.title ?? request.name}
            </Text>
          </View>
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <Button theme={theme} size="xs" variant="ghost" label="Review" onPress={() => onReview(request.id)} />
            <View style={{ flex: 1 }} />
            <Button
              theme={theme}
              size="xs"
              variant="outline"
              label="Deny"
              disabled={busy}
              onPress={() => onRespond(request.id, false)}
            />
            <Button
              theme={theme}
              size="xs"
              variant="default"
              label="Allow"
              disabled={busy}
              onPress={() => onRespond(request.id, true)}
            />
          </View>
        </View>
      ))}
      <AgentChat
        theme={theme}
        paseo={paseo}
        agentId={agent.id}
        state={node.state}
        shown={shown}
        still={still}
        onOpen={canOpen ? onOpen : null}
        compact={compact}
        style={chatStyle}
      />
    </View>
  );
}

/** The message, archive and permission dialogs. `agents` is the live directory, so an answered request disappears. */
export function AgentDialogs({
  theme,
  paseo,
  actions,
  agents,
  platform,
}: {
  theme: PluginTheme;
  paseo: PaseoApi;
  actions: AgentActions;
  agents: ReadonlyMap<string, PaseoAgent>;
  platform: "ios" | "android" | "web";
}) {
  const { colors } = theme;
  const { dialog, setDialog, draft, setDraft, busy, run, respond } = actions;
  const pendingAgent = dialog?.kind === "permission" ? agents.get(dialog.agent.id) : undefined;
  const pending =
    dialog?.kind === "permission"
      ? pendingAgent?.pendingPermissions.find((request) => request.id === dialog.requestId)
      : undefined;
  return (
    <>
      <Modal
        title={dialog?.kind === "message" ? "Message agent" : ""}
        open={dialog?.kind === "message"}
        onOpenChange={(open) => !open && setDialog(null)}
      >
        <Modal.Content>
          {dialog?.kind === "message" ? (
            <>
              <Muted theme={theme}>{displayTitle(dialog.agent)}</Muted>
              <TextInput
                value={draft}
                onChangeText={setDraft}
                multiline
                autoFocus
                placeholder="What should it know or do next?"
                placeholderTextColor={colors.foregroundMuted}
                style={{
                  minHeight: 96,
                  padding: space.md,
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: colors.border,
                  color: colors.foreground,
                  fontSize: font.base,
                  textAlignVertical: "top",
                }}
              />
              <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
                <Button theme={theme} label="Cancel" onPress={() => setDialog(null)} />
                <Button
                  theme={theme}
                  variant="default"
                  label="Send"
                  disabled={busy || draft.trim().length === 0}
                  onPress={() =>
                    void run("Message sent", () => paseo.agents.ref(dialog.agent.id).send(draft.trim()))
                  }
                />
              </View>
            </>
          ) : null}
        </Modal.Content>
      </Modal>

      <Modal
        title="Archive agent"
        open={dialog?.kind === "archive"}
        onOpenChange={(open) => !open && setDialog(null)}
      >
        <Modal.Content>
          {dialog?.kind === "archive" ? (
            <>
              <Text style={{ color: colors.foreground, fontSize: font.base, lineHeight: font.base * 1.5 }}>
                Archive “{displayTitle(dialog.agent)}”? Its chat stays in History. Children keep running.
              </Text>
              <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
                <Button theme={theme} label="Cancel" onPress={() => setDialog(null)} />
                <Button
                  theme={theme}
                  variant="destructive"
                  label="Archive"
                  disabled={busy}
                  onPress={() => void run("Archived", () => paseo.agents.ref(dialog.agent.id).archive())}
                />
              </View>
            </>
          ) : null}
        </Modal.Content>
      </Modal>

      <Modal
        title={pending?.title ?? pending?.name ?? "Permission"}
        open={dialog?.kind === "permission"}
        onOpenChange={(open) => !open && setDialog(null)}
      >
        <Modal.Content>
          {dialog?.kind === "permission" && pending ? (
            <>
              <Muted theme={theme}>{displayTitle(dialog.agent)}</Muted>
              {pending.description ? (
                <Text style={{ color: colors.foreground, fontSize: font.base, lineHeight: font.base * 1.5 }}>
                  {pending.description}
                </Text>
              ) : null}
              {pending.input ? (
                <Text
                  selectable
                  style={{
                    color: colors.foregroundMuted,
                    fontSize: font.sm,
                    fontFamily: platform === "ios" ? "Menlo" : "monospace",
                    backgroundColor: colors.surface1,
                    padding: space.md,
                    borderRadius: radius.md,
                  }}
                >
                  {JSON.stringify(pending.input, null, 2)}
                </Text>
              ) : null}
              <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
                <Button
                  theme={theme}
                  variant="outline"
                  label="Deny"
                  disabled={busy}
                  onPress={() => void respond(dialog.agent, dialog.requestId, false)}
                />
                <Button
                  theme={theme}
                  variant="default"
                  label="Allow"
                  disabled={busy}
                  onPress={() => void respond(dialog.agent, dialog.requestId, true)}
                />
              </View>
            </>
          ) : dialog?.kind === "permission" ? (
            <Muted theme={theme}>This request was already answered.</Muted>
          ) : null}
        </Modal.Content>
      </Modal>
    </>
  );
}
