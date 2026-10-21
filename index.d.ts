/**
 * Type definitions for dsh-tool-cards (Host half).
 *
 * The plugin registers a `chat_ui` tool and two Web routes. These types
 * describe what the package exports; the Cordis context is typed loosely
 * on purpose, because it comes from the host application.
 */

/** Component type whitelist for a `chat-ui/1.0` payload. */
export type ChatUiComponentType =
  | 'Slider' | 'Checkbox' | 'Radio' | 'Select' | 'Segmented' | 'Input' | 'Textarea' | 'Date' | 'Button'
  | 'Form' | 'Pressable' | 'Popover' | 'Carousel' | 'Chart' | 'Map'
  | 'Card' | 'Metric' | 'Text' | 'Heading' | 'Row' | 'Column' | 'Divider' | 'Badge' | 'Alert' | 'Table' | 'KeyValue';

/** Expression AST node. Whitelisted operators only — never evaluated as code. */
export type ChatUiExpr =
  | string
  | number
  | boolean
  | null
  | { var: string }
  | {
      op: 'add' | 'sub' | 'mul' | 'div' | 'round' | 'eq' | 'and' | 'or' | 'not';
      args: ChatUiExpr[];
    };

/** One node in the card tree. */
export interface ChatUiNode {
  id: string;
  type: ChatUiComponentType;
  label?: string;
  /** State key this control reads and writes. */
  bind?: string;
  props?: Record<string, unknown>;
  children?: ChatUiNode[];
  /** Computed value for output nodes such as `Metric`. */
  value?: ChatUiExpr;
  /** Action dispatched when this node is activated. */
  actionId?: string;
}

/** What a button click can do. */
export type ChatUiAction =
  | { kind: 'submitToAgent'; operation: string; includeKeys: string[] }
  | { kind: 'callTool'; operation: string; includeKeys: string[] }
  | { kind: 'openUrl'; url: string };

/** The `ui` argument of the `chat_ui` tool. */
export interface ChatUiPayload {
  schemaVersion: 'chat-ui/1.0';
  initialState?: Record<string, unknown>;
  tree: ChatUiNode;
  actions?: Record<string, ChatUiAction>;
}

/** Result of validating a payload. */
export type ValidateUiResult =
  | { ok: true; ui: ChatUiPayload }
  | { ok: false; error: string };

/** Validation limits enforced on the host. */
export interface ChatUiLimits {
  maxNodes: number;
  maxDepth: number;
  maxStateKeys: number;
  maxProps: number;
  maxActions: number;
  maxIncludeKeys: number;
}

export declare const TOOL_NAME: 'chat_ui';
export declare const ACTION_PATH: '/chat-ui/action';
export declare const STATE_PATH: '/chat-ui/state';
export declare const ALLOWED_TYPES: readonly ChatUiComponentType[];
export declare const LIMITS: Readonly<ChatUiLimits>;

/** Services the host half requires before it activates. */
export declare const inject: readonly ['tools'];

/**
 * Validate and normalize a `chat-ui/1.0` payload.
 * Rejects unknown component types, duplicate ids, over-deep trees and bad actions.
 */
export declare function validateUi(ui: unknown): ValidateUiResult;

/** Render one card action as the text the model receives. */
export declare function formatActionPrompt(payload: {
  actionId?: string;
  operation?: string;
  values?: Record<string, unknown>;
}): string;

/** Cordis plugin entry: registers the tool and the two Web routes. */
export declare function apply(ctx: {
  tools: { register(definition: unknown): () => void };
  effect(fn: () => unknown, label?: string): () => void;
  get(name: string): any;
  logger?(name: string): { warn?(msg: string): void; info?(msg: string): void };
}, config?: { echoPrompt?: boolean }): void;
