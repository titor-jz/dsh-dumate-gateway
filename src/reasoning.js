/**
 * Thinking control for the DuMate proxy.
 *
 * DuMate's own chat-completions endpoint takes an OpenAI-shaped `thinking`
 * object whose `type` is "enabled" or "disabled". That object is the only
 * thinking control it actually honours: `reasoning_effort`, `enable_thinking`,
 * and every `budget_tokens` spelling were probed and change nothing, so this
 * module deliberately offers two levels rather than inventing finer ones the
 * upstream would silently ignore.
 *
 * The harness asks an adapter for selectable levels through
 * `resolveModel().reasoning`; an absent field means "this model offers no
 * choice" and the model picker hides the section entirely.
 */

/** Level ids. The harness treats them as opaque strings. */
export const EFFORT_OFF = 'off'
export const EFFORT_ON = 'on'

/**
 * Models that reject `thinking:{type:"disabled"}` with a 400 from their
 * backend, so the switch is offered as "on" alone. `kimi-k3` answers
 * `invalid temperature: only 0.6 is allowed for this model` for the disabled
 * request and succeeds for the enabled one.
 */
const REFUSES_OFF = new Set(['kimi-k3'])

/**
 * Models that accept "disabled" but still emit a little reasoning before the
 * answer. They keep both levels; the "off" entry says so instead of promising
 * a silence the model will not deliver.
 */
const PARTIAL_OFF = new Set(['glm-53', 'glm-53-flash', 'kimi-k31'])

const OFF_NAME = 'Off'
const ON_NAME = 'On'

const OFF_DESCRIPTION = 'Answer without thinking. Faster and cheaper; weaker on hard reasoning.'
const OFF_PARTIAL_DESCRIPTION = 'Ask for no thinking. This model may still emit a little reasoning.'
const ON_DESCRIPTION = 'Think before answering. This is the model default.'

/**
 * The `thinking` payload to send, or `null` when no choice was made and the
 * upstream default should stand.
 * @param {string | undefined} effort - the level id the harness selected.
 * @returns {{type: 'enabled' | 'disabled'} | null} the wire object, or null.
 */
export function thinkingPayload(effort) {
  if (effort === undefined || effort === null || effort === '') return null
  if (effort === EFFORT_OFF) return { type: 'disabled' }
  if (effort === EFFORT_ON) return { type: 'enabled' }
  return null
}

/**
 * Selectable levels for one model, shaped for `LlmResolvedModelInfo.reasoning`.
 * @param {string} model - exact model id.
 * @returns {{efforts: Array<{id: string, name: string, description?: string}>} | undefined}
 *   the reasoning block, or `undefined` when the model offers no choice.
 *
 * `defaultEffort` is deliberately left out. The harness materializes a default
 * into every request, so declaring one would send `thinking` on calls where the
 * user never touched the switch — changing behaviour for every existing session
 * to gain nothing (the upstream already thinks by default). Leaving it absent
 * keeps "no selection" meaning "no field", which is what shipped before this
 * feature existed.
 */
export function reasoningInfoFor(model) {
  const partial = PARTIAL_OFF.has(model)

  if (REFUSES_OFF.has(model)) {
    // A single selectable level still renders (the harness requires a non-empty
    // list), and it is the honest statement: this model always thinks.
    return {
      efforts: [{ id: EFFORT_ON, name: ON_NAME, description: 'This model always thinks before answering.' }],
    }
  }

  return {
    efforts: [
      {
        id: EFFORT_OFF,
        name: OFF_NAME,
        description: partial ? OFF_PARTIAL_DESCRIPTION : OFF_DESCRIPTION,
      },
      { id: EFFORT_ON, name: ON_NAME, description: ON_DESCRIPTION },
    ],
  }
}

/**
 * Map an OpenAI-style `reasoning_effort` value onto a level id.
 * `none`/`off`/`disabled`/`minimal` silence thinking; every other value keeps it.
 * @param {unknown} value - the client-supplied field.
 * @returns {string | undefined} a level id, or undefined when absent.
 */
export function effortFromOpenAI(value) {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === '') return undefined
  if (normalized === 'none' || normalized === 'off' || normalized === 'disabled' || normalized === 'minimal') {
    return EFFORT_OFF
  }
  return EFFORT_ON
}

/**
 * Map an Anthropic-style `thinking` object onto a level id.
 * @param {unknown} thinking - the client-supplied object.
 * @returns {string | undefined} a level id, or undefined when absent.
 */
export function effortFromAnthropic(thinking) {
  if (thinking === null || typeof thinking !== 'object') return undefined
  const type = thinking.type
  if (type === 'disabled') return EFFORT_OFF
  if (type === 'enabled') return EFFORT_ON
  return undefined
}