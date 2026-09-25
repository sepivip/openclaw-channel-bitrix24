// Reply-payload degradation for the Bitrix24 delivery route.
//
// Why this exists: on the provider-owned delivery route core calls our turn
// plan's `delivery.preparePayload` (when defined) and then
// `delivery.deliverWithProviderMessageSending` with the RAW reply payload
// (`lifecycle-*.mjs`, `dispatchChannelTurnWithDeliveryOwner`). Core does not
// render presentation cards on this route; that is each channel's job.
// Bitrix24 chat has no buttons or cards we can drive through the allowlisted
// methods, so everything is degraded to plain text here, using the SDK's own
// fallback renderers from `openclaw/plugin-sdk/interactive-runtime`.
//
// Rules:
//   1. `presentation` + `presentationTextMode: "fallback"` + non-empty `text`
//      -> send `text` (the runtime authored it as the exact fallback).
//   2. `presentation` otherwise -> `renderMessagePresentationFallbackText({
//      text, presentation })` (text first, then title, blocks, buttons as
//      "- label", command buttons as "- label: `/cmd`").
//   3. legacy `interactive` (no presentation) -> its text (SDK
//      `resolveLegacyInteractiveTextFallback`) plus its buttons/selects
//      rendered by the same presentation renderer.
//   4. plain `text` -> `text`.
//   5. nothing visible yet -> `fallbackText.text` when the runtime supplied one.
//   6. still nothing -> the payload is DECLINED (never an empty message) with
//      a warning naming the reply kind and the payload's top-level keys.
// Media (`mediaUrl`/`mediaUrls`) in a reply is never sent: replies are text
// only. The one file path in this plugin is the `bitrix24_send_sheet` agent
// tool (src/tools.ts), which uploads a server-built .xlsx itself. Text next
// to media is sent with a warning; a media-only payload is declined with a
// warning.
//
// Nothing here logs message content or any credential.

import type { ChannelInboundTurnPlan } from "openclaw/plugin-sdk/channel-inbound";
import {
  isMessagePresentationInteractiveBlock,
  legacyInteractiveReplyToPresentation,
  normalizeLegacyInteractiveReply,
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
  resolveLegacyInteractiveTextFallback,
} from "openclaw/plugin-sdk/interactive-runtime";

/** Exactly the payload type core hands this channel's delivery adapter. */
export type Bitrix24ReplyPayload = Parameters<
  ChannelInboundTurnPlan<"provider_message_sending">["delivery"]["deliverWithProviderMessageSending"]
>[0];

export type Bitrix24ReplyTextSource =
  | "text"
  | "presentation_fallback_text"
  | "presentation"
  | "interactive"
  | "fallback_text";

export type Bitrix24NonVisibleReason = "empty" | "media_only" | "channel_data_only";

export type Bitrix24RenderedReply =
  | { visible: true; text: string; source: Bitrix24ReplyTextSource; mediaDropped: boolean }
  | { visible: false; reason: Bitrix24NonVisibleReason };

function nonBlank(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value : "";
}

function hasMedia(payload: Bitrix24ReplyPayload): boolean {
  if (nonBlank(payload.mediaUrl)) {
    return true;
  }
  return Array.isArray(payload.mediaUrls) && payload.mediaUrls.some((url) => Boolean(nonBlank(url)));
}

function hasChannelData(payload: Bitrix24ReplyPayload): boolean {
  const data = payload.channelData;
  return Boolean(data && typeof data === "object" && Object.keys(data).length > 0);
}

/** Legacy `interactive` -> text: its text blocks (unless `text` is set) plus its controls. */
function renderLegacyInteractive(
  text: string,
  interactive: NonNullable<ReturnType<typeof normalizeLegacyInteractiveReply>>,
): string {
  const head = nonBlank(resolveLegacyInteractiveTextFallback({ text, interactive }));
  const controls = legacyInteractiveReplyToPresentation({
    blocks: interactive.blocks.filter((block) => block.type !== "text"),
  });
  const controlsText = controls
    ? renderMessagePresentationFallbackText({
        presentation: { blocks: controls.blocks.filter(isMessagePresentationInteractiveBlock) },
      })
    : "";
  return [head, nonBlank(controlsText)].filter(Boolean).join("\n\n");
}

/**
 * Decide the plain text Bitrix24 should receive for one reply payload.
 * Pure: no I/O and no logging.
 */
export function renderBitrix24ReplyText(payload: Bitrix24ReplyPayload): Bitrix24RenderedReply {
  const text = nonBlank(payload.text);
  const presentation = normalizeMessagePresentation(payload.presentation);
  const interactive = presentation ? undefined : normalizeLegacyInteractiveReply(payload.interactive);

  let body = "";
  let source: Bitrix24ReplyTextSource = "text";
  if (presentation) {
    if (payload.presentationTextMode === "fallback" && text) {
      body = text;
      source = "presentation_fallback_text";
    } else {
      body = renderMessagePresentationFallbackText({ text, presentation });
      source = "presentation";
    }
  } else if (interactive) {
    body = renderLegacyInteractive(text, interactive);
    source = "interactive";
  } else {
    body = text;
    source = "text";
  }

  if (!nonBlank(body)) {
    const fallback = nonBlank(payload.fallbackText?.text);
    if (fallback) {
      body = fallback;
      source = "fallback_text";
    }
  }

  if (!nonBlank(body)) {
    return {
      visible: false,
      reason: hasMedia(payload) ? "media_only" : hasChannelData(payload) ? "channel_data_only" : "empty",
    };
  }
  return { visible: true, text: body, source, mediaDropped: hasMedia(payload) };
}

const SAFE_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * The payload's top-level key NAMES, sorted, for diagnostics. Never values.
 * An odd-looking key is counted, not printed.
 */
export function describeReplyPayloadKeys(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "<none>";
  }
  const keys = Object.keys(payload);
  const safe = keys.filter((key) => SAFE_KEY_RE.test(key)).sort();
  const other = keys.length - safe.length;
  const listed = safe.length > 0 ? safe.join(",") : "<none>";
  return other > 0 ? `${listed}+${other}other` : listed;
}

export type Bitrix24DeliveryWarn = (message: string) => void;

export function warnReplyDeclined(
  warn: Bitrix24DeliveryWarn,
  kind: string,
  payload: unknown,
  reason: Bitrix24NonVisibleReason,
): void {
  warn(
    `[bitrix24] reply payload declined as non-visible, nothing sent ` +
      `(kind=${kind} reason=${reason} keys=${describeReplyPayloadKeys(payload)})`,
  );
}

export function warnReplyMediaDropped(
  warn: Bitrix24DeliveryWarn,
  kind: string,
  payload: unknown,
): void {
  warn(
    `[bitrix24] reply media not sent (this bridge sends text only); sending the text part ` +
      `(kind=${kind} keys=${describeReplyPayloadKeys(payload)})`,
  );
}

/**
 * `delivery.preparePayload`: degrade one payload to a text-only payload, or
 * return `null` (core records `no_visible_payload`) after a warning.
 *
 * A plain-text payload is returned as the same object. Anything else becomes a
 * copy with the degraded `text` and without the fields this channel cannot
 * deliver, so what core observes as sent matches what Bitrix24 receives.
 * Core copies the reply metadata onto the returned object
 * (`copyReplyPayloadMetadata`), so pending-final bookkeeping is preserved.
 */
export function prepareBitrix24ReplyPayload(
  payload: Bitrix24ReplyPayload,
  info: { kind: string },
  warn: Bitrix24DeliveryWarn,
): Bitrix24ReplyPayload | null {
  const rendered = renderBitrix24ReplyText(payload);
  if (!rendered.visible) {
    warnReplyDeclined(warn, info.kind, payload, rendered.reason);
    return null;
  }
  if (rendered.mediaDropped) {
    warnReplyMediaDropped(warn, info.kind, payload);
  }
  const untouched =
    rendered.source === "text" &&
    !rendered.mediaDropped &&
    payload.presentation === undefined &&
    payload.interactive === undefined &&
    payload.channelData === undefined &&
    payload.fallbackText === undefined;
  if (untouched) {
    return payload;
  }
  const {
    presentation: _presentation,
    presentationTextMode: _presentationTextMode,
    interactive: _interactive,
    channelData: _channelData,
    fallbackText: _fallbackText,
    mediaUrl: _mediaUrl,
    mediaUrls: _mediaUrls,
    attachments: _attachments,
    ...rest
  } = payload;
  return { ...rest, text: rendered.text };
}
