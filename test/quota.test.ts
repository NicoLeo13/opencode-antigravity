import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseResetIso, parseUsageToQuotaV1 } from "../src/quota.js";

const reply = await readFile(join(import.meta.dir, "fixtures/usage-reply.md"), "utf8");

/**
 * The keys an OpenCode Quota `quota-v1` row may carry. A row with any other
 * key is rejected by the parser, so an entry that grows a field silently
 * stops showing up in the quota panel.
 */
const QUOTA_V1_ROW_KEYS = new Set([
  "kind",
  "name",
  "resultType",
  "percentRemaining",
  "value",
  "label",
  "right",
  "resetTimeIso",
  "observedAtIso",
]);

test("parseUsageToQuotaV1 reads every group and bucket of the /usage reply", () => {
  const parsed = parseUsageToQuotaV1(reply);

  expect(parsed.version).toBe("quota-v1");
  expect(parsed.entries).toEqual([
    {
      kind: "percent",
      name: "gemini-models-weekly",
      label: "Gemini Models (Weekly)",
      resultType: "quota",
      percentRemaining: 75,
      resetTimeIso: "2026-01-12T18:00:00.000Z",
    },
    {
      kind: "percent",
      name: "gemini-models-5h",
      label: "Gemini Models (5h)",
      resultType: "quota",
      percentRemaining: 90,
      resetTimeIso: "2026-01-08T04:30:00.000Z",
    },
    {
      kind: "percent",
      name: "claude-gpt-weekly",
      label: "Claude & GPT (Weekly)",
      resultType: "quota",
      percentRemaining: 60,
      resetTimeIso: "2026-01-14T09:15:00.000Z",
    },
    {
      kind: "percent",
      name: "claude-gpt-5h",
      label: "Claude & GPT (5h)",
      resultType: "quota",
      percentRemaining: 100,
      resetTimeIso: "2026-01-08T06:45:00.000Z",
    },
    {
      kind: "percent",
      name: "gemini-4-argon-weekly",
      label: "Gemini 4 Argon (Weekly)",
      resultType: "quota",
      percentRemaining: 40,
      resetTimeIso: "2026-01-13T12:00:00.000Z",
    },
  ]);
});

test("every parsed row only carries keys the quota-v1 contract allows", () => {
  for (const entry of parseUsageToQuotaV1(reply).entries) {
    for (const key of Object.keys(entry)) {
      expect(QUOTA_V1_ROW_KEYS.has(key)).toBe(true);
    }
  }
});

test("a reply without quota groups yields no rows", () => {
  const parsed = parseUsageToQuotaV1("### Session Usage\n- **Session total:** data not available yet\n");
  expect(parsed.entries).toEqual([]);
});

test("parseResetIso reads the reset stamp of the /usage reply", () => {
  expect(parseResetIso("Jan 12, 2026, 18:00 UTC")).toBe("2026-01-12T18:00:00.000Z");
  expect(parseResetIso("not a date")).toBeUndefined();
  expect(parseResetIso(undefined)).toBeUndefined();
});
