# Group chats in detail

How a group message is admitted, step by step. The short version is in the [README](../README.md#group-chats).

Off by default. Enabling needs both keys, and only listed chats are eligible:

```json5
channels: {
  bitrix24: {
    groupPolicy: "allowlist",                 // default "disabled"; there is no "open"
    groups: { "chat<N>": { requireMention: true } },  // requireMention defaults to true
    // group senders are matched against allowFrom; there is no separate groupAllowFrom
  },
},
```

Per `ONIMBOTV2MESSAGEADD`, in this order (`src/inbound.ts`):

1. **Loop guard.** The bot's own messages and bot senders are dropped.
2. **Hard guard** (`src/guard.ts`), every event, DM or group. Refused (no
   reply, info log `reason=<rule>`): `chat.entityType` non-empty (Open Lines
   and any entity-linked chat); `chat.extranet === true`;
   `chat.containsCollaber === true`; sender `extranet`, `connector` or `bot`;
   sender `externalAuthId` one of the documented external types `email`,
   `replica`, `bot`, `imconnector`. This is a denylist: employees carry
   `default`, `socservices` (social/SSO sign-in) or other values, and those
   pass this rule; they still have to be on `allowFrom`. Groups additionally
   need `chat.extranet === false` and `chat.containsCollaber === false` (a
   missing field is unsafe), `chat.type === "chat"`, `chat.messageType` absent
   or `"C"`, and `user.id` equal to `message.authorId`. A DM needs a numeric
   dialog id. A normal employee's DM behaves as before.
3. **Eligibility.** A group is ignored (info log) unless `groupPolicy` is
   `allowlist` and its dialog id is a key of `groups`.
4. **Mention** (`src/mentions.ts`): the bot's `[USER=<botId>]…[/USER]`, with
   `<botId>` = `data.bot.id`, is detected and stripped. The format is not
   documented but was confirmed on a real v2 group event: `message.params` is
   empty and there is no structured mentions field. The stripped text is what
   the agent sees and what commands are parsed from. Bitrix itself sends no
   event for an unmentioned group message to a `bot`-type bot, so core's
   `requireMention` gate is a second layer.
5. **Core ingress** decides: `groupPolicy`, `groupAllowFrom = allowFrom`, and
   the activation gate (`mentionFacts` + `requireMention`,
   `allowTextCommands: false`, so not even a command bypasses the mention).
6. **Session.** A group runs in its own session
   (`agent:<agent>:bitrix24:group:chat<N>`, core's default
   `session.groupScope: "per-group"`). If config folds groups into the main
   session, the message is refused with a warning.

Commands stay owner-only through core's `commands.allowFrom`, which matches
the sender id; the plugin hands core the real author (`data.user.id`,
falling back to `message.authorId`) and the mention-stripped command text.
Replies in a group are visible to every member of that chat.

`ONIMBOTV2JOINCHAT` (bot added to a chat) is logged once at info with the
dialog id, who added the bot, the chat type, the hard-guard verdict and
whether the chat is listed. The bot never replies to it. When the bot created
the chat itself, Bitrix reports the bot as the user who added it; that is
logged as `addedBy=self` (another bot: `addedBy=bot:<id>`).

The poller waits 2 s after an `Event.get` page with `hasMore: true` before
fetching the next one, as the imbot.v2 contract requires.

## Reply delivery

Core hands this channel the raw reply payload (`preparePayload`, then
`deliverWithProviderMessageSending`) and renders no cards on this route.
`src/delivery.ts` degrades everything to plain text with the SDK's own
renderers (`openclaw/plugin-sdk/interactive-runtime`): a presentation with
`presentationTextMode: "fallback"` sends its text (for example `/status`); any
other presentation, and legacy `interactive` buttons, are rendered as text
lines (command buttons show the command; callback values are never shown).
`channelData` is opaque transport data: with text the text is sent, alone it
is declined. Media in a reply is never sent (files go only through the
[`bitrix24_send_sheet`](tools/bitrix24_send_sheet.md) tool). A payload with nothing visible is declined
with a warning naming the reply kind and the payload's key names; no content
is logged, and no empty message is ever sent.
