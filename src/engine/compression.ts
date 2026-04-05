/**
 * src/engine/compression.ts — Diary-style conversation compression.
 *
 * After each conversation turn, evaluates recent messages and optionally
 * creates a compressed diary entry (summary) that replaces the raw history.
 * This prevents context window overflow while retaining important information.
 *
 * Inspired by RPGPT's diary system: https://github.com/anthropics/rpgpt
 */

import { insertDiaryEntry, compressDiary, type PersistedMessage } from '../db/database.js'
import type { LlmClient } from '../llm/client.js'

const MAX_DIARY_ACTIVE = 50

export interface CompressionResult {
  created: boolean
  entryId?: string
  summary?: string
  skipped: boolean
}

/**
 * Evaluate recent messages and create a diary entry if the conversation
 * is worth compressing. Returns whether an entry was created.
 */
export async function evaluateAndCompress(
  messages: PersistedMessage[],
  threadId: string,
  llm: LlmClient,
): Promise<CompressionResult> {
  // Only compress if we have meaningful content (≥4 messages, >2 turns)
  const userMessages = messages.filter(m => m.role === 'user')
  const assistantMessages = messages.filter(m => m.role === 'assistant')

  if (userMessages.length < 3 || assistantMessages.length < 2) {
    return { created: false, skipped: true }
  }

  // Build transcript for evaluation
  const transcript = messages
    .map(m => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n')

  const prompt = [
    { role: 'system' as const, content: `You are a memory compression system. Evaluate the following conversation transcript and decide whether it contains information worth preserving in long-term memory.

Respond with ONLY valid JSON, no markdown, no explanation:
{
  "worthy": true or false,
  "summary": "2-3 sentence natural language summary of what was discussed or decided",
  "importance": 1-5 (1=trivial smalltalk, 5=critical decisions, promises, emotional moments),
  "emotionalTone": "positive" | "negative" | "neutral" | "mixed",
  "entryType": "conversation" | "observation" | "decision" | "event"
}

Only mark worthy=true if the conversation contains:
- Decisions, agreements, or commitments
- New factual information about the user or project
- Emotional moments or relationship changes
- Problems solved or questions answered
- Questions that remain unanswered

Skip: smalltalk, greetings, simple acknowledgments, trivial chitchat.` },
    { role: 'user' as const, content: transcript },
  ]

  let raw: string
  try {
    raw = await llm.chat(prompt, { maxTokens: 300 })
  } catch {
    return { created: false, skipped: true }
  }

  let parsed: { worthy: boolean; summary: string; importance: number; emotionalTone: string; entryType: string }
  try {
    // Strip markdown code blocks if present
    const cleaned = raw.replace(/```json\n?|```\n?/g, '').trim()
    parsed = JSON.parse(cleaned)
  } catch {
    // If JSON parse fails, skip compression
    return { created: false, skipped: true }
  }

  if (!parsed.worthy || parsed.importance <= 1) {
    return { created: false, skipped: false }
  }

  const entryId = crypto.randomUUID()
  const now = Date.now()

  insertDiaryEntry({
    id: entryId,
    threadId,
    summary: parsed.summary,
    importance: Math.min(5, Math.max(1, parsed.importance)),
    emotionalTone: parsed.emotionalTone,
    entryType: parsed.entryType,
    createdAt: now,
  })

  // Fade old low-importance entries if we're over the limit
  compressDiary(threadId, MAX_DIARY_ACTIVE)

  return {
    created: true,
    entryId,
    summary: parsed.summary,
    skipped: false,
  }
}
