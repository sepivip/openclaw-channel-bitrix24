// HARD GUARD: data-exposure checks on every inbound Bitrix24 event.
//
// Runs BEFORE ingress and before any reply. Pure: no I/O, no config, no
// logging. Fail closed: a field that must prove safety and is missing or has an
// unexpected shape is treated as unsafe.
//
// Field names are from the official imbot.v2 docs (github.com/bitrix24/
// b24restdocs, api-reference/chat-bots/chat-bots-v2, ONIMBOTV2MESSAGEADD):
//   chat: id, dialogId, name, type, messageType, owner, extranet,
//         containsCollaber, entityType, entityId
//   user: id, extranet, bot, connector, externalAuthId
//
// Rules (reviewer policy; do not widen here):
//   every event   chat.entityType non-empty                      -> refuse
//                 chat.extranet === true                         -> refuse
//                 chat.containsCollaber === true                 -> refuse
//                 user.extranet / user.connector / user.bot set  -> refuse
//                 user.externalAuthId is a documented EXTERNAL type
//                 (email, replica, bot, imconnector)             -> refuse
//   groups also   chat.extranet !== false (missing = unsafe)     -> refuse
//                 chat.containsCollaber !== false (missing = unsafe) -> refuse
//                 chat.type !== "chat"                           -> refuse
//                 chat.messageType present and !== "C"           -> refuse
//                 user.id and message.authorId both set, differ  -> refuse
//   DMs also      dialogId must be a numeric user id             -> refuse
//
// For a DM, a MISSING chat.extranet / chat.containsCollaber is accepted, so a
// normal employee's DM behaves exactly as before this guard existed.
//
// externalAuthId is a DENYLIST, not an allowlist: ordinary employees carry
// values other than "default" (a live portal showed "socservices" for staff
// who sign in through a social/SSO provider), so "anything but default"
// would refuse real staff. Only the documented external types are refused;
// every other value passes this rule. Being on allowFrom is still required
// (core ingress), and the extranet / connector / bot flags still refuse.

export type Bitrix24GuardChat = {
  type?: unknown;
  messageType?: unknown;
  extranet?: unknown;
  containsCollaber?: unknown;
  entityType?: unknown;
};

export type Bitrix24GuardUser = {
  id?: unknown;
  extranet?: unknown;
  connector?: unknown;
  bot?: unknown;
  /** Tolerated alias of `bot` (see the loop guard). */
  isBot?: unknown;
  externalAuthId?: unknown;
};

export type Bitrix24GuardReason =
  | "chat_entity_linked"
  | "chat_extranet"
  | "chat_extranet_unknown"
  | "chat_contains_collaber"
  | "chat_collaber_unknown"
  | "chat_type_not_allowed"
  | "chat_message_type_not_allowed"
  | "dm_dialog_id_not_numeric"
  | "sender_extranet"
  | "sender_connector"
  | "sender_bot"
  | "sender_external_auth"
  | "sender_author_mismatch";

export type Bitrix24GuardVerdict =
  | { allowed: true }
  | { allowed: false; reason: Bitrix24GuardReason };

const ALLOW: Bitrix24GuardVerdict = { allowed: true };

function refuse(reason: Bitrix24GuardReason): Bitrix24GuardVerdict {
  return { allowed: false, reason };
}

/** Present = not undefined/null and not an empty/blank string. */
function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  return !(typeof value === "string" && value.trim() === "");
}

/**
 * A boolean flag that is set. v2 documents booleans; the v1 `"Y"` spelling is
 * also treated as set, so an older portal build can only make this stricter.
 */
function isFlagSet(value: unknown): boolean {
  return value === true || (typeof value === "string" && value.trim().toUpperCase() === "Y");
}

/**
 * `user.externalAuthId` values of documented external (non-employee) account
 * types: email guests, replicas from another portal, bots, and Open Lines
 * connectors. Compared trimmed and case-insensitively.
 */
export const BITRIX24_DENIED_EXTERNAL_AUTH_IDS: readonly string[] = Object.freeze([
  "email",
  "replica",
  "bot",
  "imconnector",
]);

function isDeniedExternalAuthId(value: unknown): boolean {
  return (
    typeof value === "string" &&
    BITRIX24_DENIED_EXTERNAL_AUTH_IDS.includes(value.trim().toLowerCase())
  );
}

function asIdString(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value).trim();
}

/** Chat-level rules. `kind` is the plugin's own direct/group classification. */
export function evaluateBitrix24ChatGuard(params: {
  kind: "direct" | "group";
  dialogId: string;
  chat: Bitrix24GuardChat | undefined;
}): Bitrix24GuardVerdict {
  const chat = params.chat ?? {};
  if (isPresent(chat.entityType)) {
    // LINES (Open Lines / Open Channels) and any other entity-linked chat.
    return refuse("chat_entity_linked");
  }
  if (params.kind === "group") {
    if (chat.type !== "chat") {
      return refuse("chat_type_not_allowed");
    }
    if (isPresent(chat.messageType) && chat.messageType !== "C") {
      return refuse("chat_message_type_not_allowed");
    }
    if (chat.extranet !== false) {
      return refuse(isFlagSet(chat.extranet) ? "chat_extranet" : "chat_extranet_unknown");
    }
    if (chat.containsCollaber !== false) {
      return refuse(
        isFlagSet(chat.containsCollaber) ? "chat_contains_collaber" : "chat_collaber_unknown",
      );
    }
    return ALLOW;
  }
  // Direct message. The reply goes to `dialogId`; for a personal chat that is
  // the user id (`Chat.Message.send` docs). A non-numeric dialogId on a
  // "direct" event would route a DM-policy reply into some other chat.
  if (!/^\d+$/.test(params.dialogId)) {
    return refuse("dm_dialog_id_not_numeric");
  }
  if (isFlagSet(chat.extranet)) {
    return refuse("chat_extranet");
  }
  if (isFlagSet(chat.containsCollaber)) {
    return refuse("chat_contains_collaber");
  }
  return ALLOW;
}

/** Sender-level rules, applied to DMs and groups alike. */
export function evaluateBitrix24SenderGuard(user: Bitrix24GuardUser | undefined): Bitrix24GuardVerdict {
  const sender = user ?? {};
  if (isFlagSet(sender.extranet)) {
    return refuse("sender_extranet");
  }
  if (isFlagSet(sender.connector)) {
    // Open Lines connector: an external customer.
    return refuse("sender_connector");
  }
  if (isFlagSet(sender.bot) || isFlagSet(sender.isBot)) {
    return refuse("sender_bot");
  }
  if (isDeniedExternalAuthId(sender.externalAuthId)) {
    // Denylist of documented external types. "default", "socservices" and any
    // other value are ordinary accounts for this rule.
    return refuse("sender_external_auth");
  }
  return ALLOW;
}

/**
 * The full guard for one `ONIMBOTV2MESSAGEADD` event: chat rules first, then
 * sender rules, then (groups only) sender identity consistency. Returns the
 * first failing rule.
 */
export function evaluateBitrix24EventGuard(params: {
  kind: "direct" | "group";
  dialogId: string;
  chat: Bitrix24GuardChat | undefined;
  user: Bitrix24GuardUser | undefined;
  authorId?: unknown;
}): Bitrix24GuardVerdict {
  const chatVerdict = evaluateBitrix24ChatGuard(params);
  if (!chatVerdict.allowed) {
    return chatVerdict;
  }
  const senderVerdict = evaluateBitrix24SenderGuard(params.user);
  if (!senderVerdict.allowed) {
    return senderVerdict;
  }
  if (params.kind === "group") {
    // In a group the sender id is the authorization key (allowFrom and
    // commands.allowFrom). Two different ids for one message is refused.
    const userId = asIdString(params.user?.id);
    const authorId = asIdString(params.authorId);
    if (userId && authorId && userId !== authorId) {
      return refuse("sender_author_mismatch");
    }
  }
  return ALLOW;
}
