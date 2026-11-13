import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcpWorker, type AcpWorker } from "./acp-process.js";
import { collectTurn } from "./translate.js";
import { AgyError } from "./errors.js";
import { info, warn } from "./log.js";
import { resolveQuotaRuntime } from "./quota-runtime.js";

export type QuotaV1Entry = {
  kind: "percent";
  name: string;
  label: string;
  resultType: "quota";
  percentRemaining: number;
  resetTimeIso?: string;
};

export type QuotaV1Response = {
  version: "quota-v1";
  entries: QuotaV1Entry[];
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const RESET_REGEX = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4}), (\d{2}):(\d{2}) UTC$/u;
const GROUP_REGEX = /^- \*\*(.+)\*\*$/u;
const BUCKET_REGEX = /^- \*\*(.+?):\*\* (\d+)% remaining(?: \(resets (.+)\))?$/u;

export function parseResetIso(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const match = RESET_REGEX.exec(text.trim());
  if (!match) return undefined;
  const [, month, day, year, hours, minutes] = match;
  const monthIdx = MONTHS.indexOf(month!);
  if (monthIdx === -1) return undefined;
  return new Date(Date.UTC(Number(year), monthIdx, Number(day), Number(hours), Number(minutes))).toISOString();
}

function normalizeGroupLabel(group: string): string {
  if (/claude.*gpt/i.test(group)) return "Claude & GPT";
  return group.trim();
}

function normalizeWindow(bucketLabel: string): { id: string; label: string } {
  if (/weekly/i.test(bucketLabel)) return { id: "weekly", label: "Weekly" };
  if (/five hour|5h/i.test(bucketLabel)) return { id: "5h", label: "5h" };
  const clean = bucketLabel.replace(/limit|remaining/gi, "").trim();
  const id = clean.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return { id: id || "quota", label: clean || bucketLabel };
}

export function parseUsageToQuotaV1(text: string): QuotaV1Response {
  const sectionMatch = /^### Quota Limits$([\s\S]*?)(?=^### |(?![\s\S]))/mu.exec(text);
  const section = sectionMatch ? sectionMatch[1]! : text;
  const entries: QuotaV1Entry[] = [];
  let currentGroup = "";

  for (const rawLine of section.split("\n")) {
    const line = rawLine.trim();
    const groupMatch = GROUP_REGEX.exec(line);
    if (groupMatch) {
      currentGroup = groupMatch[1]!.trim();
      continue;
    }
    const bucketMatch = BUCKET_REGEX.exec(line);
    if (bucketMatch && currentGroup) {
      const [, bucketLabel, percent, reset] = bucketMatch;
      const windowInfo = normalizeWindow(bucketLabel!);
      const groupDisplayName = normalizeGroupLabel(currentGroup);
      const groupSlug = groupDisplayName.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
      const name = `${groupSlug}-${windowInfo.id}`;
      const label = `${groupDisplayName} (${windowInfo.label})`;
      const resetTimeIso = parseResetIso(reset);
      entries.push({
        kind: "percent",
        name,
        label,
        resultType: "quota",
        percentRemaining: Number(percent),
        ...(resetTimeIso ? { resetTimeIso } : {}),
      });
    }
  }

  return { version: "quota-v1", entries };
}

export const DEFAULT_QUOTA_CACHE_TTL_MS = 30_000;
/** How often the background refresh keeps the snapshot warm. */
export const DEFAULT_QUOTA_REFRESH_INTERVAL_MS = 60_000;
/** A snapshot older than this is not served; the caller waits for a live one. */
export const DEFAULT_QUOTA_MAX_STALE_MS = 10 * 60_000;

export class QuotaManager {
  private cache: { snapshot: QuotaV1Response; timestamp: number } | null = null;
  private inFlight: Promise<QuotaV1Response> | null = null;
  private worker: AcpWorker | undefined;
  private workerPromise: Promise<AcpWorker> | undefined;
  private tempDir: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  async getQuota(options: { forceRefresh?: boolean; signal?: AbortSignal } = {}): Promise<QuotaV1Response> {
    const now = Date.now();
    const ttl = Number(process.env.OPENCODE_ANTIGRAVITY_QUOTA_TTL_MS) || DEFAULT_QUOTA_CACHE_TTL_MS;
    const maxStale = Number(process.env.OPENCODE_ANTIGRAVITY_QUOTA_MAX_STALE_MS) || DEFAULT_QUOTA_MAX_STALE_MS;

    if (!options.forceRefresh && this.cache && (now - this.cache.timestamp) < maxStale) {
      // A stale snapshot still answers the request; the refresh happens in the
      // background so the quota panel never waits for the ACP round trip.
      if ((now - this.cache.timestamp) >= ttl) void this.refresh().catch(() => undefined);
      return this.cache.snapshot;
    }

    return this.refresh(options.signal);
  }

  /** Fetches the quota and caches it. One fetch runs at a time. */
  refresh(signal?: AbortSignal): Promise<QuotaV1Response> {
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.fetchLiveQuota(signal)
      .then((snapshot) => {
        this.cache = { snapshot, timestamp: Date.now() };
        return snapshot;
      })
      .catch((error) => {
        if (this.cache) {
          warn("Failed to fetch fresh quota; returning cached snapshot", { cause: error });
          return this.cache.snapshot;
        }
        throw error;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  private async fetchLiveQuota(signal?: AbortSignal): Promise<QuotaV1Response> {
    const worker = await this.ensureWorker(signal);
    try {
      const turn = worker.runTurn([{ type: "text", text: "/usage" }], signal);
      const collected = await collectTurn(turn);

      if (!collected.content.trim()) {
        throw new AgyError("process", "ACP /usage returned empty output", { code: "agy_quota_empty" });
      }

      const parsed = parseUsageToQuotaV1(collected.content);
      if (parsed.entries.length === 0) {
        throw new AgyError("protocol", "ACP /usage reply contained no recognizable quota groups", {
          code: "agy_quota_parse_failed",
          details: { text: collected.content },
        });
      }

      info("Fetched fresh Antigravity quota", { count: parsed.entries.length });
      return parsed;
    } catch (error) {
      // A worker that cannot answer is replaced on the next refresh.
      await this.dropWorker();
      if (error instanceof AgyError) throw error;
      throw new AgyError("process", "Failed to fetch Antigravity quota", { cause: error, code: "agy_quota_fetch_failed" });
    }
  }

  /**
   * The worker that answers `/usage`.
   *
   * One worker serves every refresh: spawning one per request costs the
   * whole ACP startup, and the quota panel reads the endpoint far more often
   * than the quota actually changes.
   */
  private async ensureWorker(signal?: AbortSignal): Promise<AcpWorker> {
    if (this.worker) return this.worker;
    if (!this.workerPromise) {
      this.workerPromise = (async () => {
        const runtime = await resolveQuotaRuntime();
        if (!runtime) {
          throw new AgyError("unsupported", "No official Antigravity runtime that answers /usage is installed", {
            code: "agy_quota_runtime_missing",
          });
        }
        this.tempDir = await mkdtemp(join(tmpdir(), "agy-quota-"));
        const worker = await createAcpWorker({ cwd: this.tempDir, executable: runtime, hostTools: false }, signal);
        this.worker = worker;
        return worker;
      })().finally(() => { this.workerPromise = undefined; });
    }
    return this.workerPromise;
  }

  private async dropWorker(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    const tempDir = this.tempDir;
    this.tempDir = undefined;
    await worker?.stop(true).catch(() => undefined);
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }

  /**
   * Keeps the snapshot warm so the quota endpoint answers from the cache.
   *
   * A live `/usage` takes seconds, far longer than the quota panel waits for
   * a reply, so the endpoint never fetches on the request path once the
   * cache holds a snapshot.
   */
  start(): void {
    if (this.timer) return;
    const interval = Number(process.env.OPENCODE_ANTIGRAVITY_QUOTA_REFRESH_MS) || DEFAULT_QUOTA_REFRESH_INTERVAL_MS;
    this.timer = setInterval(() => { void this.refresh().catch(() => undefined); }, interval);
    this.timer.unref?.();
    void this.refresh().catch(() => undefined);
  }

  async stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    await this.dropWorker();
    this.clearCache();
  }

  clearCache(): void {
    this.cache = null;
    this.inFlight = null;
  }
}

export const quotaManager = new QuotaManager();
export const getQuotaSnapshot = (signal?: AbortSignal, forceRefresh = false) =>
  quotaManager.getQuota({ signal, forceRefresh });
