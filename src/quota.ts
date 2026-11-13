import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpWorker, createAcpWorker } from "./acp-process.js";
import { DEFAULT_QUOTA_WORKER_IDLE_MS, envNumber } from "./constants.js";
import { collectTurn } from "./translate.js";
import { AgyAbortError, AgyError } from "./errors.js";
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
  private workerController: AbortController | undefined;
  private workerGeneration = 0;
  private tempDir: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private idleTimer: ReturnType<typeof setInterval> | undefined;
  private lastRequestedAt: number | null = null;
  private readonly workerIdleMs: number;
  private readonly refreshIntervalMs: number | undefined;

  constructor(options: { workerIdleMs?: number; refreshIntervalMs?: number } = {}) {
    this.workerIdleMs = options.workerIdleMs ?? envNumber("OPENCODE_ANTIGRAVITY_QUOTA_IDLE_MS", DEFAULT_QUOTA_WORKER_IDLE_MS, 25);
    this.refreshIntervalMs = options.refreshIntervalMs;
  }

  get hasActiveWorker(): boolean {
    return Boolean(
      (this.worker && this.worker.state !== "closed" && this.worker.state !== "failed") ||
      this.workerPromise,
    );
  }

  async getQuota(options: { forceRefresh?: boolean; signal?: AbortSignal } = {}): Promise<QuotaV1Response> {
    const now = Date.now();
    this.lastRequestedAt = now;
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
    const generation = this.workerGeneration;
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
      // A worker that cannot answer is replaced on the next refresh, unless a newer generation took over.
      await this.dropWorker(generation);
      if (error instanceof AgyError) throw error;
      throw new AgyError("process", "Failed to fetch Antigravity quota", { cause: error, code: "agy_quota_fetch_failed" });
    }
  }

  /**
   * The worker that answers `/usage`.
   *
   * One worker serves every refresh while the quota endpoint is actively read,
   * and is released after inactivity so unused instances hold no ACP process.
   */
  private async ensureWorker(signal?: AbortSignal): Promise<AcpWorker> {
    if (signal?.aborted) throw new AgyAbortError();
    if (this.worker) {
      if (this.worker.state !== "closed" && this.worker.state !== "failed") return this.worker;
      await this.dropWorker(this.workerGeneration);
    }
    if (!this.workerPromise) {
      const generation = this.workerGeneration;
      const controller = new AbortController();
      this.workerController = controller;
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.workerPromise = (async () => {
        let dir: string | undefined;
        let createdWorker: AcpWorker | undefined;
        try {
          if (controller.signal.aborted || generation !== this.workerGeneration) throw new AgyAbortError();
          const runtime = await resolveQuotaRuntime();
          if (controller.signal.aborted || generation !== this.workerGeneration) throw new AgyAbortError();
          if (!runtime) {
            throw new AgyError("unsupported", "No official Antigravity runtime that answers /usage is installed", {
              code: "agy_quota_runtime_missing",
            });
          }
          dir = await mkdtemp(join(tmpdir(), "agy-quota-"));
          if (controller.signal.aborted || generation !== this.workerGeneration) throw new AgyAbortError();
          createdWorker = await createAcpWorker({ cwd: dir, executable: runtime, hostTools: false }, controller.signal);
          if (controller.signal.aborted || generation !== this.workerGeneration) throw new AgyAbortError();
          this.tempDir = dir;
          this.worker = createdWorker;
          this.startIdleWatch();
          return createdWorker;
        } catch (error) {
          await createdWorker?.stop(true).catch(() => undefined);
          if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
      })().finally(() => {
        signal?.removeEventListener("abort", onAbort);
        if (this.workerController === controller) this.workerController = undefined;
        if (generation === this.workerGeneration || this.workerController === undefined) {
          this.workerPromise = undefined;
        }
      });
    }
    return this.workerPromise;
  }

  private startIdleWatch(): void {
    if (this.idleTimer) return;
    const interval = Math.max(10, Math.min(this.workerIdleMs, 30_000));
    this.idleTimer = setInterval(() => {
      if (this.inFlight || this.workerPromise) return;
      if (this.lastRequestedAt === null || Date.now() - this.lastRequestedAt >= this.workerIdleMs) {
        void this.dropWorker();
      }
    }, interval);
    this.idleTimer.unref?.();
  }

  private async dropWorker(expectedGeneration?: number): Promise<void> {
    if (expectedGeneration !== undefined && expectedGeneration !== this.workerGeneration) return;
    this.workerGeneration += 1;
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = undefined; }
    this.workerController?.abort();
    this.workerController = undefined;
    const pendingWorker = this.workerPromise;
    this.workerPromise = undefined;
    const worker = this.worker;
    this.worker = undefined;
    const tempDir = this.tempDir;
    this.tempDir = undefined;
    await Promise.all([
      pendingWorker?.then(
        (resolved) => resolved.stop(true).catch(() => undefined),
        () => undefined,
      ),
      worker?.stop(true).catch(() => undefined),
    ]);
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }

  /**
   * Keeps the snapshot warm while clients actively poll `/quota`.
   *
   * Does not spawn an ACP process eagerly on startup; the worker starts on the
   * first quota request and is dropped once requests stop arriving.
   */
  start(): void {
    if (this.timer) return;
    const interval = this.refreshIntervalMs ?? (Number(process.env.OPENCODE_ANTIGRAVITY_QUOTA_REFRESH_MS) || DEFAULT_QUOTA_REFRESH_INTERVAL_MS);
    this.timer = setInterval(() => {
      if (this.lastRequestedAt === null || Date.now() - this.lastRequestedAt >= this.workerIdleMs) {
        if (!this.inFlight && !this.workerPromise && this.worker) void this.dropWorker();
        return;
      }
      void this.refresh().catch(() => undefined);
    }, interval);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.lastRequestedAt = null;
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
