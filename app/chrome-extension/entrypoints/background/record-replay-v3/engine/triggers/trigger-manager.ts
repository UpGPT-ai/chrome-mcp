/**
 * @fileoverview Trigger manager
 * @description
 * TriggerManager owns the lifecycle of every trigger Handler:
 * - Loads triggers from TriggerStore and installs them
 * - Handles trigger fire events and calls enqueueRun
 * - Provides storm protection (cooldown + maxQueued)
 *
 * Design rationale:
 * - Orchestrator pattern: TriggerManager doesn't implement per-kind trigger logic
 *   directly; it delegates to a per-kind Handler
 * - Handler factory pattern: TriggerManager creates Handler instances at construction
 *   time, injecting fireCallback
 * - Storm protection: cooldown (per-trigger) + maxQueued (global best-effort)
 */

import type { UnixMillis } from '../../domain/json';
import type { RunId, TriggerId } from '../../domain/ids';
import type { TriggerFireContext, TriggerKind, TriggerSpec } from '../../domain/triggers';
import type { StoragePort } from '../storage/storage-port';
import type { EventsBus } from '../transport/events-bus';
import type { RunScheduler } from '../queue/scheduler';
import { enqueueRun, type EnqueueRunResult } from '../queue/enqueue-run';
import type { TriggerFireCallback, TriggerHandler, TriggerHandlerFactory } from './trigger-handler';

// ==================== Types ====================

/**
 * Handler factory map
 */
export type TriggerHandlerFactories = Partial<{
  [K in TriggerKind]: TriggerHandlerFactory<K>;
}>;

/**
 * Storm protection config
 */
export interface TriggerManagerStormControl {
  /**
   * Minimum interval between two fires of the same trigger (ms)
   * - 0 or undefined disables the cooldown
   */
  cooldownMs?: number;

  /**
   * Global max number of queued Runs
   * - Rejects new fires once the limit is reached
   * - undefined disables the limit check
   * - Note: this is a best-effort check, not atomic
   */
  maxQueued?: number;
}

/**
 * TriggerManager dependencies
 */
export interface TriggerManagerDeps {
  /** Storage layer */
  storage: Pick<StoragePort, 'triggers' | 'flows' | 'runs' | 'queue'>;
  /** Event bus */
  events: Pick<EventsBus, 'append'>;
  /** Scheduler (optional) */
  scheduler?: Pick<RunScheduler, 'kick'>;
  /** Handler factory map */
  handlerFactories: TriggerHandlerFactories;
  /** Storm protection config */
  storm?: TriggerManagerStormControl;
  /** RunId generator (for test injection) */
  generateRunId?: () => RunId;
  /** Time source (for test injection) */
  now?: () => UnixMillis;
  /** Logger */
  logger?: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
}

/**
 * TriggerManager state
 */
export interface TriggerManagerState {
  /** Whether it has been started */
  started: boolean;
  /** List of installed trigger IDs */
  installedTriggerIds: TriggerId[];
}

/**
 * TriggerManager interface
 */
export interface TriggerManager {
  /** Start the manager: load and install all enabled triggers */
  start(): Promise<void>;
  /** Stop the manager: uninstall all triggers */
  stop(): Promise<void>;
  /** Refresh triggers: reload from storage and reinstall */
  refresh(): Promise<void>;
  /**
   * Manually fire a trigger
   * @description For RPC/UI calls only, used by manual triggers
   */
  fire(
    triggerId: TriggerId,
    context?: { sourceTabId?: number; sourceUrl?: string },
  ): Promise<EnqueueRunResult>;
  /** Dispose the manager */
  dispose(): Promise<void>;
  /** Get the current state */
  getState(): TriggerManagerState;
}

// ==================== Utilities ====================

/**
 * Validate a non-negative integer
 */
function normalizeNonNegativeInt(value: unknown, fallback: number, fieldName: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number`);
  }
  return Math.max(0, Math.floor(value));
}

/**
 * Validate a positive integer
 */
function normalizePositiveInt(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number`);
  }
  const intValue = Math.floor(value);
  if (intValue < 1) {
    throw new Error(`${fieldName} must be >= 1`);
  }
  return intValue;
}

// ==================== Implementation ====================

/**
 * Create a TriggerManager
 */
export function createTriggerManager(deps: TriggerManagerDeps): TriggerManager {
  const logger = deps.logger ?? console;
  const now = deps.now ?? (() => Date.now());

  // Storm protection params
  const cooldownMs = normalizeNonNegativeInt(deps.storm?.cooldownMs, 0, 'storm.cooldownMs');
  const maxQueued =
    deps.storm?.maxQueued === undefined || deps.storm?.maxQueued === null
      ? undefined
      : normalizePositiveInt(deps.storm.maxQueued, 'storm.maxQueued');

  // State
  const installed = new Map<TriggerId, TriggerSpec>();
  const lastFireAt = new Map<TriggerId, UnixMillis>();
  let started = false;
  let inFlightEnqueues = 0;

  // Prevent refresh re-entrancy
  let refreshPromise: Promise<void> | null = null;
  let pendingRefresh = false;

  // Handler instances
  const handlers = new Map<TriggerKind, TriggerHandler<TriggerKind>>();

  // Fire callback
  const fireCallback: TriggerFireCallback = {
    onFire: async (triggerId, context) => {
      // Catch all exceptions to avoid throwing into the chrome API listener
      try {
        await handleFire(triggerId as TriggerId, context);
      } catch (e) {
        logger.error('[TriggerManager] onFire failed:', e);
      }
    },
  };

  // Initialize Handler instances
  for (const [kind, factory] of Object.entries(deps.handlerFactories) as Array<
    [TriggerKind, TriggerHandlerFactory<TriggerKind> | undefined]
  >) {
    if (!factory) continue; // Skip undefined factory values

    const handler = factory(fireCallback) as TriggerHandler<TriggerKind>;
    if (handler.kind !== kind) {
      throw new Error(
        `[TriggerManager] Handler kind mismatch: factory key is "${kind}", but handler.kind is "${handler.kind}"`,
      );
    }
    handlers.set(kind, handler);
  }

  /**
   * Handle a trigger fire (internal method)
   * @param throwOnDrop if true, throws on cooldown/maxQueued and similar drops
   * @returns EnqueueRunResult, or null (silently dropped)
   */
  async function handleFire(
    triggerId: TriggerId,
    context: { sourceTabId?: number; sourceUrl?: string },
    options?: { throwOnDrop?: boolean },
  ): Promise<EnqueueRunResult | null> {
    if (!started) {
      if (options?.throwOnDrop) {
        throw new Error('TriggerManager is not started');
      }
      return null;
    }

    const trigger = installed.get(triggerId);
    if (!trigger) {
      if (options?.throwOnDrop) {
        throw new Error(`Trigger "${triggerId}" is not installed`);
      }
      return null;
    }

    const t = now();

    // Per-trigger cooldown check
    const prevLastFireAt = lastFireAt.get(triggerId);
    if (cooldownMs > 0 && prevLastFireAt !== undefined && t - prevLastFireAt < cooldownMs) {
      logger.debug(`[TriggerManager] Dropping trigger "${triggerId}" (cooldown ${cooldownMs}ms)`);
      if (options?.throwOnDrop) {
        throw new Error(`Trigger "${triggerId}" dropped (cooldown ${cooldownMs}ms)`);
      }
      return null;
    }

    // Global maxQueued check (best-effort)
    // Note: check before setting cooldown so a maxQueued drop doesn't wrongly set cooldown
    if (maxQueued !== undefined) {
      const queued = await deps.storage.queue.list('queued');
      if (queued.length + inFlightEnqueues >= maxQueued) {
        logger.warn(
          `[TriggerManager] Dropping trigger "${triggerId}" (queued=${queued.length}, inFlight=${inFlightEnqueues}, maxQueued=${maxQueued})`,
        );
        if (options?.throwOnDrop) {
          throw new Error(`Trigger "${triggerId}" dropped (maxQueued=${maxQueued})`);
        }
        return null;
      }
    }

    // Set lastFireAt to suppress concurrent fires (after the maxQueued check passes)
    if (cooldownMs > 0) {
      lastFireAt.set(triggerId, t);
    }

    // Build the fire context
    const triggerContext: TriggerFireContext = {
      triggerId: trigger.id,
      kind: trigger.kind,
      firedAt: t,
      sourceTabId: context.sourceTabId,
      sourceUrl: context.sourceUrl,
    };

    inFlightEnqueues += 1;
    try {
      const result = await enqueueRun(
        {
          storage: deps.storage,
          events: deps.events,
          scheduler: deps.scheduler,
          generateRunId: deps.generateRunId,
          now,
        },
        {
          flowId: trigger.flowId,
          args: trigger.args,
          trigger: triggerContext,
        },
      );
      return result;
    } catch (e) {
      // Roll back the cooldown marker if enqueue fails
      if (cooldownMs > 0) {
        if (prevLastFireAt === undefined) {
          lastFireAt.delete(triggerId);
        } else {
          lastFireAt.set(triggerId, prevLastFireAt);
        }
      }
      const msg = e instanceof Error ? e.message : String(e);
      logger.error(`[TriggerManager] enqueueRun failed for trigger "${triggerId}":`, e);
      if (options?.throwOnDrop) {
        throw new Error(`enqueueRun failed for trigger "${triggerId}": ${msg}`);
      }
      return null;
    } finally {
      inFlightEnqueues -= 1;
    }
  }

  /**
   * Manually fire a trigger (public API)
   * @description For RPC/UI calls; throws an error instead of silently dropping
   */
  async function fire(
    triggerId: TriggerId,
    context: { sourceTabId?: number; sourceUrl?: string } = {},
  ): Promise<EnqueueRunResult> {
    const result = await handleFire(triggerId, context, { throwOnDrop: true });
    if (!result) {
      throw new Error(`Trigger "${triggerId}" did not enqueue a run`);
    }
    return result;
  }

  /**
   * Perform a refresh
   */
  async function doRefresh(): Promise<void> {
    const triggers = await deps.storage.triggers.list();
    if (!started) return;

    // Uninstall everything first, then reinstall (simple strategy that guarantees consistency)
    // Best-effort: one handler failing to uninstall doesn't affect the others
    for (const handler of handlers.values()) {
      try {
        await handler.uninstallAll();
      } catch (e) {
        logger.warn(`[TriggerManager] Error during uninstallAll for kind "${handler.kind}":`, e);
      }
    }
    installed.clear();

    // Install the enabled triggers
    for (const trigger of triggers) {
      if (!started) return;
      if (!trigger.enabled) continue;

      const handler = handlers.get(trigger.kind);
      if (!handler) {
        logger.warn(`[TriggerManager] No handler registered for kind "${trigger.kind}"`);
        continue;
      }

      try {
        await handler.install(trigger as Parameters<typeof handler.install>[0]);
        installed.set(trigger.id, trigger);
      } catch (e) {
        logger.error(`[TriggerManager] Failed to install trigger "${trigger.id}":`, e);
      }
    }
  }

  /**
   * Refresh triggers (coalesces concurrent calls)
   */
  async function refresh(): Promise<void> {
    if (!started) {
      throw new Error('TriggerManager is not started');
    }

    pendingRefresh = true;
    if (!refreshPromise) {
      refreshPromise = (async () => {
        while (started && pendingRefresh) {
          pendingRefresh = false;
          await doRefresh();
        }
      })().finally(() => {
        refreshPromise = null;
      });
    }

    return refreshPromise;
  }

  /**
   * Start the manager
   */
  async function start(): Promise<void> {
    if (started) return;
    started = true;
    await refresh();
  }

  /**
   * Stop the manager
   */
  async function stop(): Promise<void> {
    if (!started) return;

    started = false;
    pendingRefresh = false;

    // Wait for any in-progress refresh to finish
    if (refreshPromise) {
      try {
        await refreshPromise;
      } catch {
        // Ignore refresh errors
      }
    }

    // Uninstall all triggers
    for (const handler of handlers.values()) {
      try {
        await handler.uninstallAll();
      } catch (e) {
        logger.warn('[TriggerManager] Error uninstalling handler:', e);
      }
    }
    installed.clear();
    lastFireAt.clear();
  }

  /**
   * Dispose the manager
   */
  async function dispose(): Promise<void> {
    await stop();
  }

  /**
   * Get the state
   */
  function getState(): TriggerManagerState {
    return {
      started,
      installedTriggerIds: Array.from(installed.keys()),
    };
  }

  return { start, stop, refresh, fire, dispose, getState };
}
