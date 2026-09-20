/**
 * @fileoverview Trigger handler interface definitions
 * @description Defines the unified interface for every kind of trigger
 */

import type { TriggerSpec, TriggerKind } from '../../domain/triggers';

/**
 * Trigger handler interface
 * @description Every trigger kind must implement this interface
 */
export interface TriggerHandler<K extends TriggerKind = TriggerKind> {
  /** Trigger kind */
  readonly kind: K;

  /**
   * Install a trigger
   * @description Registers chrome API listeners, etc.
   * @param trigger the trigger spec
   */
  install(trigger: Extract<TriggerSpec, { kind: K }>): Promise<void>;

  /**
   * Uninstall a trigger
   * @description Removes chrome API listeners, etc.
   * @param triggerId the trigger ID
   */
  uninstall(triggerId: string): Promise<void>;

  /**
   * Uninstall all triggers
   * @description Cleans up every trigger of this kind
   */
  uninstallAll(): Promise<void>;

  /**
   * Get the list of installed trigger IDs
   */
  getInstalledIds(): string[];
}

/**
 * Trigger fire callback
 * @description The callback TriggerManager injects into each Handler
 */
export interface TriggerFireCallback {
  /**
   * Called when a trigger fires
   * @param triggerId the trigger ID
   * @param context the fire context
   */
  onFire(
    triggerId: string,
    context: {
      sourceTabId?: number;
      sourceUrl?: string;
    },
  ): Promise<void>;
}

/**
 * Trigger handler factory
 */
export type TriggerHandlerFactory<K extends TriggerKind> = (
  fireCallback: TriggerFireCallback,
) => TriggerHandler<K>;
