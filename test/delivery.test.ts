// Part A: reply payloads that are not plain text must degrade to text, never
// vanish silently, and never produce an empty Bitrix message.
//
// Two layers:
//   1. `renderBitrix24ReplyText` / `prepareBitrix24ReplyPayload` as pure
//      functions, over the real SDK renderers (interactive-runtime).
//   2. The turn plan's delivery adapter, driven exactly like core's routed
//      delivery (`lifecycle-*.mjs` dispatchChannelTurnWithDeliveryOwner):
//      `preparePayload(payload, info)`; `null` => suppressed; otherwise
//      `deliverWithProviderMessageSending(prepared, info)`. Asserts what reaches
//      `imbot.v2.Chat.Message.send` and what is logged.

import { beforeEach, describe, expect, it, vi } from "vitest";

type Plan = {
  delivery: {
    preparePayload?: (payload: unknown, info: { kind: string }) => unknown;
    deliverWithProviderMessageSending: (payload: unknown, info: unknown) => Promise<unknown>;
  };
};

const harness = vi.hoisted(() => ({ plans: [] as Plan[] }));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    runChannelInboundEvent: async (params: {
      raw: unknown;
      adapter: {
        ingest: (raw: unknown) => unknown;
        resolveTurn: (input: unknown, eventClass: unknown, preflight: unknown) => Promise<unknown>;
      };
    }) => {
      const input = await params.adapter.ingest(params.raw);
      const plan = (await params.adapter.resolveTurn(
        input,
        { kind: "message", canStartAgentTurn: true },
        {},
      )) as Plan & { ctxPayload: unknown; route: { sessionKey: string } };
      harness.plans.push(plan);
      return {
        admission: { kind: "dispatch" },
        dispatched: true,
        ctxPayload: plan.ctxPayload,
        routeSessionKey: plan.route.sessionKey,
        dispatchResult: {},
      };
    },
  };
});

import {
  describeReplyPayloadKeys,
  prepareBitrix24ReplyPayload,
  renderBitrix24ReplyText,
  type Bitrix24ReplyPayload,
} from "../src/delivery.js";
import { handleBitrix24InboundEvent } from "../src/inbound.js";
import { buildConfig, buildDeps, dmEvent, groupEvent, LISTED_GROUP, OWNER } from "./fixtures.js";

/** `/status` shape: `{ text, presentation, presentationTextMode: "fallback" }` (commands-status-*.mjs). */
const STATUS_PAYLOAD = {
  text: "Status: ok\nModel: synthetic/model-1",
  presentation: {
    title: "Status",
    blocks: [
      { type: "text", text: "Model: synthetic/model-1" },
      { type: "buttons", buttons: [{ label: "Refresh", action: { type: "command", command: "/status" } }] },
    ],
  },
  presentationTextMode: "fallback",
} as unknown as Bitrix24ReplyPayload;

/** Presentation with no text: title, body, command/url/callback buttons. */
const CARD_PAYLOAD = {
  presentation: {
    title: "Pick a mode",
    blocks: [
      { type: "text", text: "Choose how to continue." },
      {
        type: "buttons",
        buttons: [
          { label: "Fast", action: { type: "command", command: "/fast on" } },
          { label: "Docs", action: { type: "url", url: "https://docs.example.test/modes" } },
          { label: "Approve", action: { type: "callback", value: "cb-secret-approve-token" } },
        ],
      },
    ],
  },
} as unknown as Bitrix24ReplyPayload;

/** Legacy interactive buttons only (deprecated `interactive` field). */
const INTERACTIVE_PAYLOAD = {
  interactive: {
    blocks: [
      { type: "text", text: "Approve the request?" },
      { type: "buttons", buttons: [{ label: "Yes", value: "cb-yes-token" }, { label: "No", value: "cb-no-token" }] },
    ],
  },
} as unknown as Bitrix24ReplyPayload;

const CHANNEL_DATA_ONLY = {
  channelData: { someChannel: { buttons: [[{ text: "Model A", callback_data: "mdl:cb-token" }]] } },
} as unknown as Bitrix24ReplyPayload;

const MEDIA_ONLY = { mediaUrl: "file:///tmp/synthetic/secret-report.pdf" } as unknown as Bitrix24ReplyPayload;

beforeEach(() => {
  harness.plans.length = 0;
});

describe("renderBitrix24ReplyText (pure)", () => {
  it("plain text is sent as is", () => {
    expect(renderBitrix24ReplyText({ text: "pong" } as Bitrix24ReplyPayload)).toEqual({
      visible: true,
      text: "pong",
      source: "text",
      mediaDropped: false,
    });
  });

  it("presentation + fallback text mode + text => the text only", () => {
    expect(renderBitrix24ReplyText(STATUS_PAYLOAD)).toEqual({
      visible: true,
      text: "Status: ok\nModel: synthetic/model-1",
      source: "presentation_fallback_text",
      mediaDropped: false,
    });
  });

  it("presentation + fallback text mode + EMPTY text => the presentation is rendered", () => {
    const rendered = renderBitrix24ReplyText({ ...STATUS_PAYLOAD, text: "  " } as Bitrix24ReplyPayload);
    expect(rendered).toMatchObject({ visible: true, source: "presentation" });
    expect((rendered as { text: string }).text).toBe(
      "Status\n\nModel: synthetic/model-1\n\n- Refresh: `/status`",
    );
  });

  it("presentation without text => title, blocks and buttons; callback data never shown", () => {
    const rendered = renderBitrix24ReplyText(CARD_PAYLOAD);
    expect(rendered).toMatchObject({ visible: true, source: "presentation" });
    const text = (rendered as { text: string }).text;
    expect(text).toBe(
      "Pick a mode\n\nChoose how to continue.\n\n" +
        "- Fast: `/fast on`\n- Docs: https://docs.example.test/modes\n- Approve",
    );
    expect(text).not.toContain("cb-secret-approve-token");
  });

  it("presentation + text (not fallback mode) => text first, then the presentation", () => {
    const rendered = renderBitrix24ReplyText({ ...CARD_PAYLOAD, text: "Heads up." } as Bitrix24ReplyPayload);
    expect((rendered as { text: string }).text.startsWith("Heads up.\n\nPick a mode")).toBe(true);
  });

  it("legacy interactive only => its text plus its buttons as a list; values never shown", () => {
    const rendered = renderBitrix24ReplyText(INTERACTIVE_PAYLOAD);
    expect(rendered).toEqual({
      visible: true,
      text: "Approve the request?\n\n- Yes\n- No",
      source: "interactive",
      mediaDropped: false,
    });
  });

  it("legacy interactive + text => the text replaces its text blocks, buttons appended", () => {
    const rendered = renderBitrix24ReplyText({
      ...INTERACTIVE_PAYLOAD,
      text: "Please decide.",
    } as Bitrix24ReplyPayload);
    expect((rendered as { text: string }).text).toBe("Please decide.\n\n- Yes\n- No");
  });

  it("presentation wins over legacy interactive when both are present", () => {
    const rendered = renderBitrix24ReplyText({ ...CARD_PAYLOAD, ...INTERACTIVE_PAYLOAD } as Bitrix24ReplyPayload);
    expect(rendered).toMatchObject({ source: "presentation" });
    expect((rendered as { text: string }).text).not.toContain("Approve the request?");
  });

  it("channelData next to text => the text", () => {
    expect(
      renderBitrix24ReplyText({ ...CHANNEL_DATA_ONLY, text: "Select a provider:" } as Bitrix24ReplyPayload),
    ).toMatchObject({ visible: true, text: "Select a provider:", source: "text" });
  });

  it("channelData only => not visible (opaque transport data, no SDK renderer)", () => {
    expect(renderBitrix24ReplyText(CHANNEL_DATA_ONLY)).toEqual({ visible: false, reason: "channel_data_only" });
  });

  it("channelData only + fallbackText => the runtime-supplied fallback text", () => {
    expect(
      renderBitrix24ReplyText({
        ...CHANNEL_DATA_ONLY,
        fallbackText: { text: "Model menu is not available here. Use /model <name>." },
      } as Bitrix24ReplyPayload),
    ).toMatchObject({ visible: true, source: "fallback_text" });
  });

  it("empty and whitespace-only payloads => not visible", () => {
    expect(renderBitrix24ReplyText({} as Bitrix24ReplyPayload)).toEqual({ visible: false, reason: "empty" });
    expect(renderBitrix24ReplyText({ text: " \n\t" } as Bitrix24ReplyPayload)).toEqual({
      visible: false,
      reason: "empty",
    });
    expect(
      renderBitrix24ReplyText({ presentation: { blocks: [] } } as unknown as Bitrix24ReplyPayload),
    ).toEqual({ visible: false, reason: "empty" });
  });

  it("media only => not visible (this bridge cannot upload); text + media => text, media flagged", () => {
    expect(renderBitrix24ReplyText(MEDIA_ONLY)).toEqual({ visible: false, reason: "media_only" });
    expect(
      renderBitrix24ReplyText({ mediaUrls: ["file:///tmp/a.png"], text: "see chart" } as Bitrix24ReplyPayload),
    ).toEqual({ visible: true, text: "see chart", source: "text", mediaDropped: true });
  });
});

describe("prepareBitrix24ReplyPayload (pure)", () => {
  it("returns a plain-text payload untouched (same object), no warning", () => {
    const warn = vi.fn();
    const payload = { text: "pong", replyToId: "900" } as Bitrix24ReplyPayload;
    expect(prepareBitrix24ReplyPayload(payload, { kind: "final" }, warn)).toBe(payload);
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns a text-only copy for a degraded payload, keeping unrelated fields", () => {
    const warn = vi.fn();
    const prepared = prepareBitrix24ReplyPayload(
      { ...CARD_PAYLOAD, replyToId: "900", channelData: { x: 1 } } as Bitrix24ReplyPayload,
      { kind: "final" },
      warn,
    );
    expect(prepared).toMatchObject({ replyToId: "900" });
    expect(Object.keys(prepared ?? {}).sort()).toEqual(["replyToId", "text"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns null and warns with kind and key names only when nothing is visible", () => {
    const warn = vi.fn();
    expect(prepareBitrix24ReplyPayload(CHANNEL_DATA_ONLY, { kind: "block" }, warn)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[bitrix24] reply payload declined as non-visible, nothing sent " +
        "(kind=block reason=channel_data_only keys=channelData)",
    );
  });

  it("describes keys without values, masking odd key names", () => {
    expect(describeReplyPayloadKeys({ text: "secret words", mediaUrl: "file:///x" })).toBe("mediaUrl,text");
    expect(describeReplyPayloadKeys({})).toBe("<none>");
    expect(describeReplyPayloadKeys({ "odd key\nwith newline": 1, text: "x" })).toBe("text+1other");
    expect(describeReplyPayloadKeys(null)).toBe("<none>");
  });
});

/** Mirror of core's routed delivery for one payload (lifecycle-*.mjs). */
async function deliverLikeCore(plan: Plan, payload: unknown, kind = "final") {
  const info = {
    kind,
    assertPlatformSendAuthorized: vi.fn(),
    onPlatformSendDispatch: vi.fn(async () => {}),
  };
  const prepared = plan.delivery.preparePayload
    ? await plan.delivery.preparePayload(payload, { kind })
    : payload;
  if (prepared === null) {
    return { suppressed: true as const, info };
  }
  const result = await plan.delivery.deliverWithProviderMessageSending(prepared, info);
  return { suppressed: false as const, result, info };
}

async function dmPlan(cfgSection: Record<string, unknown> = {}) {
  const built = buildDeps(buildConfig(cfgSection));
  const outcome = await handleBitrix24InboundEvent({ deps: built.deps, raw: dmEvent() });
  expect(outcome).toMatchObject({ status: "dispatched" });
  expect(harness.plans).toHaveLength(1);
  return { ...built, plan: harness.plans[0] as Plan };
}

describe("delivery adapter, driven like core (preparePayload -> deliverWithProviderMessageSending)", () => {
  it("defines preparePayload so core degrades before the provider hook", async () => {
    const { plan } = await dmPlan();
    expect(typeof plan.delivery.preparePayload).toBe("function");
  });

  it("plain text: sent once, visible", async () => {
    const { plan, sent, log } = await dmPlan();
    const run = await deliverLikeCore(plan, { text: "pong" });
    expect(run.suppressed).toBe(false);
    expect(run.result).toMatchObject({ visibleReplySent: true, content: "pong" });
    expect(run.info.assertPlatformSendAuthorized).toHaveBeenCalledTimes(1);
    expect(run.info.onPlatformSendDispatch).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([{ dialogId: String(OWNER), message: "pong" }]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("/status (presentation + fallback text): the fallback text is sent", async () => {
    const { plan, sent, log } = await dmPlan();
    const run = await deliverLikeCore(plan, STATUS_PAYLOAD);
    expect(run.result).toMatchObject({ visibleReplySent: true });
    expect(sent).toEqual([{ dialogId: String(OWNER), message: "Status: ok\nModel: synthetic/model-1" }]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("presentation without text: rendered and sent as BB-code text", async () => {
    const { plan, sent } = await dmPlan();
    await deliverLikeCore(plan, CARD_PAYLOAD);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.message).toBe(
      "Pick a mode\n\nChoose how to continue.\n\n" +
        "• Fast: [code]/fast on[/code]\n• Docs: https://docs.example.test/modes\n• Approve",
    );
    expect(sent[0]?.message).not.toContain("cb-secret-approve-token");
  });

  it("interactive (buttons) only: text and button labels are sent", async () => {
    const { plan, sent } = await dmPlan();
    await deliverLikeCore(plan, INTERACTIVE_PAYLOAD);
    expect(sent).toEqual([{ dialogId: String(OWNER), message: "Approve the request?\n\n• Yes\n• No" }]);
  });

  it("channelData only: declined (suppressed by core), one warning, nothing sent", async () => {
    const { plan, sent, log } = await dmPlan();
    const run = await deliverLikeCore(plan, CHANNEL_DATA_ONLY, "final");
    expect(run.suppressed).toBe(true);
    expect(sent).toEqual([]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      "[bitrix24] reply payload declined as non-visible, nothing sent " +
        "(kind=final reason=channel_data_only keys=channelData)",
    );
    expect(log.all().join("\n")).not.toContain("cb-token");
  });

  it("channelData + text (model menu shape): the text is sent", async () => {
    const { plan, sent, log } = await dmPlan();
    await deliverLikeCore(plan, { ...CHANNEL_DATA_ONLY, text: "Select a provider:" });
    expect(sent).toEqual([{ dialogId: String(OWNER), message: "Select a provider:" }]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("empty payload: declined with a warning, never an empty message", async () => {
    const { plan, sent, log } = await dmPlan();
    for (const payload of [{}, { text: "" }, { text: "   " }]) {
      const run = await deliverLikeCore(plan, payload, "tool");
      expect(run.suppressed).toBe(true);
    }
    expect(sent).toEqual([]);
    expect(log.warn).toHaveBeenCalledTimes(3);
    expect(log.warn).toHaveBeenNthCalledWith(
      1,
      "[bitrix24] reply payload declined as non-visible, nothing sent (kind=tool reason=empty keys=<none>)",
    );
    expect(log.warn).toHaveBeenNthCalledWith(
      2,
      "[bitrix24] reply payload declined as non-visible, nothing sent (kind=tool reason=empty keys=text)",
    );
  });

  it("media only: declined with a warning; the file URL is never logged or sent", async () => {
    const { plan, sent, log } = await dmPlan();
    const run = await deliverLikeCore(plan, MEDIA_ONLY);
    expect(run.suppressed).toBe(true);
    expect(sent).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      "[bitrix24] reply payload declined as non-visible, nothing sent " +
        "(kind=final reason=media_only keys=mediaUrl)",
    );
    expect(log.all().join("\n")).not.toContain("secret-report");
  });

  it("text + media: the text is sent, the media is reported as not sent", async () => {
    const { plan, sent, log } = await dmPlan();
    await deliverLikeCore(plan, { text: "see the attached chart", mediaUrls: ["file:///tmp/synthetic/c.png"] });
    expect(sent).toEqual([{ dialogId: String(OWNER), message: "see the attached chart" }]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      "[bitrix24] reply media not sent (this bridge sends text only); sending the text part " +
        "(kind=final keys=mediaUrls,text)",
    );
  });

  it("the provider hook alone (no preparePayload call) still degrades and still refuses empties", async () => {
    const { plan, sent, log } = await dmPlan();
    const info = { kind: "final", assertPlatformSendAuthorized: vi.fn(), onPlatformSendDispatch: vi.fn(async () => {}) };
    await plan.delivery.deliverWithProviderMessageSending(INTERACTIVE_PAYLOAD, info);
    expect(sent).toEqual([{ dialogId: String(OWNER), message: "Approve the request?\n\n• Yes\n• No" }]);
    const declined = await plan.delivery.deliverWithProviderMessageSending({}, info);
    expect(declined).toEqual({ visibleReplySent: false });
    expect(info.assertPlatformSendAuthorized).toHaveBeenCalledTimes(1); // not for the declined one
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("reason=empty keys=<none>"));
  });

  it("group replies go to the group dialog, degraded the same way", async () => {
    const built = buildDeps(buildConfig());
    await handleBitrix24InboundEvent({ deps: built.deps, raw: groupEvent() });
    const plan = harness.plans[0] as Plan;
    await deliverLikeCore(plan, STATUS_PAYLOAD);
    expect(built.sent).toEqual([{ dialogId: LISTED_GROUP, message: "Status: ok\nModel: synthetic/model-1" }]);
  });
});
