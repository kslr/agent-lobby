# Agent Lobby

Agent Lobby shows your agents as a small pixel-art office. Each workspace is a room, each agent has a desk, and a character's pose tells you what its agent is doing: typing, waiting for you, finished, resting, or gone home. It is meant to sit in a side pane and be glanced at while you work.

It adds a Lobby tab to a workspace's Explorer, showing that workspace's room with a switch to show every workspace, and a Lobby surface that lays out every workspace as one floor plan with rooms of different sizes sharing walls. Workspaces whose agents are all closed stay folded away until a search or the Closed filter asks for them.

## What you see

A working agent sits typing with code scrolling on its screen and a one-word bubble naming its tool. An agent that needs you stands at its desk with a question mark and the permission request in a bubble. A failed agent has an error screen and a cross. A finished agent gathers at the pantry with the others who have finished, a check bobbing over its head. An idle agent rests in the lounge, then sleeps at its desk. A closed agent walks out and the room's filing cabinet counts it; pressing the cabinet lists them.

A message from one agent to another shows as a bubble over the sender and an envelope that travels to the recipient's desk. Characters walk between their desk, the pantry and the lounge instead of jumping. Seats come from who started an agent and when, so nobody moves when somebody else starts or finishes.

Selecting a character shows its recent chat, read-only, under its pending permissions with Allow, Deny and Review and icons for details, Open, Message and Archive. A List toggle shows the same agents as rows with a small animated state icon.

An optional `ghostline/role` label on an agent changes its character's outline (`overseer`, `nexus` or `meow`); without it an agent is a plain character. Labels only change the drawing.

## Size and cost

The office is drawn small on purpose, at the crisp size nearest 1.2 screen pixels per art pixel. A four-desk room with its pantry and lounge fits a 313 pixel Explorer pane as a strip about 115 pixels tall. A hidden pane holds no timers, subscriptions or requests. With about thirty looping animations on screen the office costs roughly one to four points of one CPU core on an Apple M4; the List view with animated icons costs about the same as no animation. Reduced motion stops every animation and shows first frames.

## Data and limits

The plugin reads the agent list and a few agent timelines through Paseo's client API, keeping at most eight timeline subscriptions open per daemon connection. It sends nothing on its own; messages, permission responses and archives happen only when you press those buttons. Only the daemon's own record of an agent-to-agent message, with its verified sender, is drawn as an exchange.

Every sprite, tile and font is original and drawn as code; no third-party assets are bundled. Verified in the Paseo desktop app; the iOS and Android code paths are typechecked but have not been run on a device. Bubble text drops accents, and at this size it is something to lean in for. Requires Paseo 0.11.2 or newer.
