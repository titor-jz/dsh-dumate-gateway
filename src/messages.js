/**
 * Translate the harness's provider-neutral messages into the OpenAI chat
 * completion shape the DuMate proxy speaks.
 *
 * Text, tool calls and history map one to one. Images are the one block the
 * proxy understands but the harness keeps off the wire: when the caller passes
 * `resolveImage`, a user image is turned into a `data:` URL and sent as
 * `image_url`; without it (or when the block was offloaded) the block becomes
 * deterministic placeholder text. Files are never sent.
 */

/** @param {{messages?: readonly any[], system?: string, resolveImage?: ((block: any) => Promise<string | null>) | null}} options */
export async function toOpenAIMessages({ messages = [], system, resolveImage = null } = {}) {
  const output = []
  if (typeof system === 'string' && system !== '') output.push({ role: 'system', content: system })

  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue

    if (message.role === 'user') {
      output.push({ role: 'user', content: await userContent(message.content, resolveImage) })
      continue
    }

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

/**
 * A user message keeps its order: text parts and resolved images interleave the
 * way they were sent, while blocks the wire cannot carry become text.
 */
async function userContent(content, resolveImage) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  const parts = []
  let carriesImage = false

  for (const block of content) {
    if (block === null || typeof block !== 'object') continue

    if (block.type === 'text' && typeof block.text === 'string') {
      if (block.text !== '') parts.push({ type: 'text', text: block.text })
      continue
    }

    if (block.type === 'image') {
      const url = await imageURL(block, resolveImage)
      if (url !== null) {
        parts.push({ type: 'image_url', image_url: { url } })
        carriesImage = true
        continue
      }
      parts.push({ type: 'text', text: '[image attachment]' })
      continue
    }

    if (block.type === 'reasoning') continue
    if (block.type === 'file') parts.push({ type: 'text', text: '[file attachment]' })
    else if (block.type === 'tool-call') parts.push({ type: 'text', text: `[tool call ${block.name ?? ''}]` })
  }

  // Without an image this stays a plain string: the proxy has always seen one,
  // and a text-only array would only add noise to the wire and the logs.
  if (!carriesImage) return parts.map(part => part.text).join('')
  return parts
}

async function imageURL(block, resolveImage) {
  if (resolveImage === null || block.offloaded === true) return null
  const ref = block.attachment
  if (ref === null || typeof ref !== 'object' || typeof ref.attachmentId !== 'string') return null
  try {
    const url = await resolveImage(block)
    return typeof url === 'string' && url !== '' ? url : null
  } catch {
    // A storage problem must degrade to the placeholder, never fail the turn.
    return null
  }
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
