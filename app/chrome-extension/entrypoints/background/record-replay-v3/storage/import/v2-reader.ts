/**
 * @fileoverview V2 data reader
 * @description Reads V2-format data (placeholder implementation)
 */

/**
 * V2 data reader interface
 * @description Implemented in Phase 5+
 */
export interface V2Reader {
  /** Read V2 Flows */
  readFlows(): Promise<unknown[]>;
  /** Read V2 Runs */
  readRuns(): Promise<unknown[]>;
  /** Read V2 Triggers */
  readTriggers(): Promise<unknown[]>;
  /** Read V2 Schedules */
  readSchedules(): Promise<unknown[]>;
}

/**
 * Create a NotImplemented V2Reader
 */
export function createNotImplementedV2Reader(): V2Reader {
  const notImplemented = async () => {
    throw new Error('V2Reader not implemented');
  };

  return {
    readFlows: notImplemented,
    readRuns: notImplemented,
    readTriggers: notImplemented,
    readSchedules: notImplemented,
  };
}
