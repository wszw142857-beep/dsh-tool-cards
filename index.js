/** Host half: the tool registration plus the card-action and card-state routes. */
export { apply, inject, TOOL_NAME, ACTION_PATH, STATE_PATH } from './host.js';
export { validateUi, formatActionPrompt, ALLOWED_TYPES, LIMITS } from './protocol.js';
