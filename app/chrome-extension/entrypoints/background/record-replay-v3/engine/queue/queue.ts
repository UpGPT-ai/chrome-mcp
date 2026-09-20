/**
 * @fileoverview RunQueue interface definition
 * @description Defines the management interface for the Run queue
 */

import type { JsonObject, UnixMillis } from '../../domain/json';
import type { FlowId, NodeId, RunId } from '../../domain/ids';
import type { TriggerFireContext } from '../../domain/triggers';

/**
 * RunQueue config
 */
export interface RunQueueConfig {
  /** Max number of parallel Runs */
  maxParallelRuns: number;
  /** Lease TTL (milliseconds) */
  leaseTtlMs: number;
  /** Heartbeat interval (milliseconds) */
  heartbeatIntervalMs: number;
}

/**
 * Default queue config
 */
export const DEFAULT_QUEUE_CONFIG: RunQueueConfig = {
  maxParallelRuns: 3,
  leaseTtlMs: 15_000,
  heartbeatIntervalMs: 5_000,
};

/**
 * Queue item status
 */
export type QueueItemStatus = 'queued' | 'running' | 'paused';

/**
 * Lease info
 */
export interface Lease {
  /** Owner ID */
  ownerId: string;
  /** Expiration time */
  expiresAt: UnixMillis;
}

/**
 * RunQueue item
 */
export interface RunQueueItem {
  /** Run ID */
  id: RunId;
  /** Flow ID */
  flowId: FlowId;
  /** Status */
  status: QueueItemStatus;
  /** Creation time */
  createdAt: UnixMillis;
  /** Update time */
  updatedAt: UnixMillis;
  /** Priority (higher number = higher priority) */
  priority: number;
  /** Current attempt count */
  attempt: number;
  /** Max attempt count */
  maxAttempts: number;
  /** Tab ID */
  tabId?: number;
  /** Run args */
  args?: JsonObject;
  /** Trigger context */
  trigger?: TriggerFireContext;
  /** Lease info */
  lease?: Lease;
  /** Debug config */
  debug?: { breakpoints?: NodeId[]; pauseOnStart?: boolean };
}

/**
 * Enqueue request (excludes auto-generated fields)
 * - priority defaults to 0
 * - maxAttempts defaults to 1
 */
export type EnqueueInput = Omit<
  RunQueueItem,
  'status' | 'createdAt' | 'updatedAt' | 'attempt' | 'lease' | 'priority' | 'maxAttempts'
> & {
  id: RunId;
  /** Priority (higher number = higher priority, default 0) */
  priority?: number;
  /** Max attempt count (default 1) */
  maxAttempts?: number;
};

/**
 * RunQueue interface
 * @description Manages the Run queue and scheduling
 */
export interface RunQueue {
  /**
   * Enqueue
   * @param input Enqueue request
   * @returns Queue item
   */
  enqueue(input: EnqueueInput): Promise<RunQueueItem>;

  /**
   * Claim the next executable Run
   * @param ownerId Claimer ID
   * @param now Current time
   * @returns Queue item or null
   */
  claimNext(ownerId: string, now: UnixMillis): Promise<RunQueueItem | null>;

  /**
   * Renew lease via heartbeat
   * @param ownerId Claimer ID
   * @param now Current time
   */
  heartbeat(ownerId: string, now: UnixMillis): Promise<void>;

  /**
   * Reclaim expired leases
   * @description Reclaims running/paused items where lease.expiresAt < now back to queued
   * @param now Current time
   * @returns List of reclaimed Run IDs
   */
  reclaimExpiredLeases(now: UnixMillis): Promise<RunId[]>;

  /**
   * Recover orphaned leases (called after SW restart)
   * @description
   * - Reclaims orphaned running items to queued (status -> queued, lease cleared)
   * - Adopts orphaned paused items (keeps status=paused, lease ownerId updated to the new ownerId)
   * @param ownerId New ownerId (current Service Worker instance)
   * @param now Current time
   * @returns List of affected runIds (includes the prior ownerId for auditing)
   */
  recoverOrphanLeases(
    ownerId: string,
    now: UnixMillis,
  ): Promise<{
    requeuedRunning: Array<{ runId: RunId; prevOwnerId?: string }>;
    adoptedPaused: Array<{ runId: RunId; prevOwnerId?: string }>;
  }>;

  /**
   * Mark as running
   */
  markRunning(runId: RunId, ownerId: string, now: UnixMillis): Promise<void>;

  /**
   * Mark as paused
   */
  markPaused(runId: RunId, ownerId: string, now: UnixMillis): Promise<void>;

  /**
   * Mark as done (remove from queue)
   */
  markDone(runId: RunId, now: UnixMillis): Promise<void>;

  /**
   * Cancel a Run
   */
  cancel(runId: RunId, now: UnixMillis, reason?: string): Promise<void>;

  /**
   * Get a queue item
   */
  get(runId: RunId): Promise<RunQueueItem | null>;

  /**
   * List queue items
   */
  list(status?: QueueItemStatus): Promise<RunQueueItem[]>;
}

/**
 * Create a NotImplemented RunQueue
 * @description Phase 0 placeholder implementation
 */
export function createNotImplementedQueue(): RunQueue {
  const notImplemented = () => {
    throw new Error('RunQueue not implemented');
  };

  return {
    enqueue: async () => notImplemented(),
    claimNext: async () => notImplemented(),
    heartbeat: async () => notImplemented(),
    reclaimExpiredLeases: async () => notImplemented(),
    recoverOrphanLeases: async () => notImplemented(),
    markRunning: async () => notImplemented(),
    markPaused: async () => notImplemented(),
    markDone: async () => notImplemented(),
    cancel: async () => notImplemented(),
    get: async () => notImplemented(),
    list: async () => notImplemented(),
  };
}
