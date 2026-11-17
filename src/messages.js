/**
 * Translate the harness's provider-neutral messages into the OpenAI chat
 * completion shape the DuMate proxy speaks.
 *
 * Every content block the proxy cannot represent natively is projected to
 * deterministic text: attachments become a named placeholder, which matches how
 * the harness's first-party adapters keep images and files out of the wire.
 */

/** @param {{messages?: readonly any[], system?: string}} options */
export function toOpenAIMessages({ messages = [], system } = {}) {
  const output = []
  if (typeof system === 'string' && system !== '') output.push({ role: 'system', content: system })

  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    const text = flatten(message.content)

    switch (message.role) {
      case 'system':
        if (text !== '') output.push({ role: 'system', content: text })
        break
      case 'developer':
        // The harness folds tool changes into developer messages; the wire has
        // no equivalent role, so the text joins the system prompt.
        if (text !== '') output.push({ role: 'system', content: text })
        break
      case 'user':
        output.push({ role: 'user', content: text })
        break
      case 'assistant': {
        const toolCalls = toolCallsOf(message.content)
        const entry = { role: 'assistant', content: text }
        if (toolCalls.length > 0) entry.tool_calls = toolCalls
        output.push(entry)
        break
      }
      case 'tool':
        output.push({
          role: 'tool',
          tool_call_id: String(message.toolCallId ?? message.source?.callId ?? ''),
          content: text,
        })
        break
      default:
        break
    }
  }

  return output
}

/** @param {readonly any[] | undefined} content */
function flatten(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'reasoning') continue
    else if (block.type === 'image') parts.push('[image attachment]')
    else if (block.type === 'file') parts.push('[file attachment]')
    else if (block.type === 'tool-call') parts.push(`[tool call ${block.name ?? ''}]`)
  }
  return parts.join('')
}

/** @param {readonly any[] | undefined} content */
function toolCallsOf(content) {
  if (!Array.isArray(content)) return []
  return content
    .filter(block => block !== null && typeof block === 'object' && block.type === 'tool-call')
    .map(block => ({
      id: String(block.id),
      type: 'function',
      function: { name: String(block.name), arguments: typeof block.arguments === 'string' ? block.arguments : '{}' },
    }))
}

/** Map the harness tool schemas onto OpenAI function declarations. */
export function toOpenAITools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    },
  }))
}
