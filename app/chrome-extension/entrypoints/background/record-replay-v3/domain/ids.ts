/**
 * @fileoverview ID type definitions
 * @description Defines the various ID types used in Record-Replay V3
 */

/** Flow unique identifier */
export type FlowId = string;

/** Node unique identifier */
export type NodeId = string;

/** Edge unique identifier */
export type EdgeId = string;

/** Run unique identifier */
export type RunId = string;

/** Trigger unique identifier */
export type TriggerId = string;

/** Edge label type */
export type EdgeLabel = string;

/** Predefined Edge label constants */
export const EDGE_LABELS = {
  /** Default edge */
  DEFAULT: 'default',
  /** Error-handling edge */
  ON_ERROR: 'onError',
  /** Edge taken when the condition is true */
  TRUE: 'true',
  /** Edge taken when the condition is false */
  FALSE: 'false',
} as const;

/** Edge label type (derived from the constants) */
export type EdgeLabelValue = (typeof EDGE_LABELS)[keyof typeof EDGE_LABELS];
