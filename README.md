# Conversation Tracker for Claude Code

A pane beside the chat that keeps a running record of each conversation: its title and goal, the action items, open questions, decisions and sidequests it turns up, and what got done.

```
Pricing launch
Goal: Launch paid plans by November.

5 open · 3 done · 3 decisions

Action items +
☐ Send revised proposal to client (owner: me, due: Nov 7)
☐ Set up the Stripe test account (owner: Claude)
▾ Done (2)
☑ Draft pricing page copy (done Oct 30, you finished it)

Open questions +
? What is the launch date?
✓ Who owns the launch email? (done Oct 31, Dana owns it)

Decisions +
Oct 29: Launch with monthly billing only (simpler to support)
```

## Install

At the prompt of a terminal session:

```
/plugin install conversation-tracker --marketplace njwlnet/claude-code-conversation-tracker
```

From a shell:

```
claude plugin install conversation-tracker --marketplace njwlnet/claude-code-conversation-tracker
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `njwlnet/claude-code-conversation-tracker`, then Add plugin.

Needs Claude Code 2.1.309 or later. Conversations already open pick it up after `/reload-plugins`; new ones load it on their own.

## What it does

- **Fills itself in.** After each of Claude's replies, the latest exchange and the current tracker go to Claude Sonnet, which reports what to add: action items (with owners and due dates when they're mentioned, relative dates turned into real ones), open questions, decisions with their reason, and, rarely, a sidequest (a helpful adjacent to-do nobody asked for). Nothing is ever deleted or rewritten by it.
- **Ticks things off.** When the conversation shows an item is done, it's crossed out with the date and a few words on who did it. A question that gets answered shows the answer.
- **Your changes win.** Tick or untick any item. The **+** by a heading, or an item's **✎** (shown when you hover over it), puts a `/tracker` command in the message box for you to finish. What you edit stays as you set it. An item's **✕** moves it to a collapsed Dismissed group, where **Restore** brings it back.
- **Replies.** Click a question's **?** to start a reply to it in the message box.
- **Helper agents.** Each helper agent the conversation starts gets its own small tracker under **Helper agents**.
- **Per conversation.** Each conversation's tracker is saved to its own file and comes back when you return to it. **Scan earlier messages** (or `/tracker scan`) fills a tracker from a conversation that began before it was installed.

## Commands

```
/tracker                          show or hide the pane (prints the tracker where no pane can draw)
/tracker show                     print the tracker as text, with each item's id
/tracker scan                     fill it from earlier messages, then print it
/tracker add action: <words>      also question:, decision:, sidequest:
/tracker edit <id> <words>        ids show in /tracker show
/tracker dismiss <id>             also restore <id>
/tracker title <words>
/tracker goal <words>
```

Send each command as its own message: pasting several at once sends them to Claude as text.

## Cloud sessions

Tested only in the Claude desktop app (Code tab) and the terminal (Claude Code 2.1.309+). It hasn't been tested in the VS Code extension. Panes don't draw in a cloud session (Claude Code on the web): see [Where mods run](https://code.claude.com/docs/en/plugins/mods/overview.md#where-mods-run). There, if the plugin reaches the session, the tracker still fills itself in, `/tracker` or `/tracker show` prints it as text, and `/tracker scan` fills it from the conversation so far.

Getting the plugin into a cloud session:

- A repository's `.claude/settings.json` doesn't install plugins in cloud sessions, and plugins installed on your own machine don't carry over ([cloud environments](https://code.claude.com/docs/en/cloud-environments.md)).
- One route, not yet confirmed to load: add these lines to your cloud environment's setup script.

  ```
  claude plugin marketplace add njwlnet/claude-code-conversation-tracker
  claude plugin install conversation-tracker@njwlnet --scope user
  ```

- On a Team or Enterprise plan, an owner can turn it on for everyone through server-managed settings.
- The setup script only runs when a new cloud session starts, and `/reload-plugins` doesn't run over a cloud session's remote connection, so a cloud session that's already running can't load the plugin. Start a new one.

A tracker saved in a cloud session lives on that cloud machine, so it can be lost when the machine is reclaimed. To keep the pane while working away from your desk, use [Remote Control](https://code.claude.com/docs/en/remote-control.md): the session runs on your own machine, where the pane draws.

## What it costs, and where your data goes

Each of Claude's replies costs one extra Claude Sonnet call through your own Claude Code session (your plan or API key), a few thousand tokens. So does each `/tracker add` or `/tracker edit`, and each stretch read by **Scan earlier messages**. Trackers are saved as JSON under `~/.claude/conversation-tracker/`, one file per conversation id. Nothing is sent anywhere else.

## Developing

```
claude plugin validate .
claude plugin test .
```
