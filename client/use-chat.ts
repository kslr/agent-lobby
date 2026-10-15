import type { PaseoApi } from "./paseo-types";
import { useCallback, useEffect, useRef, useState } from "react";
import { createChatController, type ChatController } from "./chat-controller";
import { CHAT_PAGE, EMPTY_CHAT, wantsLive, type ChatState, type ChatWant } from "./chat-model";
import type { CrewState } from "./model";
import { timelineHub } from "./use-feed";

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
  const control = useRef<ChatController | null>(null);
  const want: ChatWant = { agentId, shown, state: crewState };

  useEffect(() => {
    const controller = createChatController(
      {
        refetch: (target) =>
          paseo.agents.ref(target).timeline.refetch({ direction: "tail", limit: CHAT_PAGE, projection: "projected" }),
      },
      timelineHub(paseo),
      { state: setState, phase: setPhase, live: setLive },
    );
    control.current = controller;
    return () => {
      control.current = null;
      controller.dispose();
    };
  }, [paseo]);

  useEffect(() => {
    control.current?.update({ agentId, shown, state: crewState });
  }, [paseo, agentId, shown, crewState]);

  const refresh = useCallback(() => control.current?.refresh(), []);
  return { state, phase, wanted: wantsLive(want), live, refresh };
}
