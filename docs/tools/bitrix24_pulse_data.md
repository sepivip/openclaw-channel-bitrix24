# `bitrix24_pulse_data`

Optional read-only tool, off unless an agent's tool policy allows it. Built for one deployment: see the assumptions below. Back to the [README](../../README.md).

An optional, **read-only** agent tool for a "business pulse" skill, built for a
portal whose CRM deals are logged customer calls (one pipeline; in-progress
stages, one won stage, and failure stages that are really call topics; no
amounts). It returns one section, `calls`: calls created and closed in the last
7 days against the 7 before, calls waiting now (count, oldest in days, how many
over 2 days), the median hours to close over the last 7 days, the call topics
(closing stages) of the last 7 days, and closed calls per pipeline.

* **Separate webhook, separate client.** `channels.bitrix24.crmWebhookUrl`
  (optional SecretInput, `${BITRIX24_CRM_WEBHOOK_URL}`), created by a
  low-privilege service user with scope `crm` only and a CRM role that can only
  read deals. `src/crm-client.ts` allows exactly `crm.item.list`,
  `crm.category.list` and `crm.status.list`; anything else (every write,
  `batch`, tasks, calendar, `user.get`) throws `METHOD_NOT_ALLOWED`
  synchronously, before any request. The imbot client and its allowlist are
  unchanged.
* **Counts only.** Deals are read with `id`, `categoryId`, `stageId`,
  `createdTime` and `movedTime`; never a title, amount, person or contact.
* **Limits.** At most 2 request starts per second per call, 60 s per request,
  one retry on `QUERY_LIMIT_EXCEEDED` / `OPERATION_TIME_LIMIT`, 50 rows per
  page, at most 40 pages per listing (`meta.truncated` when hit). A normal run
  is about 10 requests.
* **Caller.** Only the agent the bitrix24 channel routes to (`bindings`), taken
  from the host-set tool context `agentId`. Any other agent or a call without
  an agent id: `NOT_BITRIX_AGENT`, no request.
* **Failures.** Unset webhook, disabled channel or a URL outside
  `portalDomain`: `NOT_CONFIGURED`, no request. No visible deal pipeline
  (Bitrix answers empty lists, not errors, without read rights):
  `NO_CRM_ACCESS`, never "zero calls". When every requested section failed the
  call is `ALL_SECTIONS_UNAVAILABLE` with the per-section codes.
* **Windows** are whole days in Asia/Tbilisi (the portal this was built for):
  last 7 = today-6 .. today, prior 7 = today-13 .. today-7.
* **Enabling it.** Set `crmWebhookUrl` and add `bitrix24_pulse_data` to the
  agent's `alsoAllow` (the tool is `optional: true`, `sideEffecting: false`).
