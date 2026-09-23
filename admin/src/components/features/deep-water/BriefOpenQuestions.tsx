import type { DeepWaterOpenQuestion } from '@nessie/schemas'
import { openQuestionReply } from './research-presentation'

/**
 * What the planner still needs to know, each with why it asks and the answers
 * it suggests. A suggested answer is a one-tap reply; anything else is typed
 * in the reply box. An empty list means the planner has nothing left to ask.
 */
export const BriefOpenQuestions = ({
  canAnswer,
  onAnswer,
  questions,
}: {
  canAnswer: boolean
  onAnswer: (reply: string) => void
  questions: readonly DeepWaterOpenQuestion[]
}) => {
  if (questions.length === 0) return null
  return (
    <section aria-label="Questions from the planner" className="flex flex-col gap-3" data-testid="research-brief-questions">
      {questions.map((entry) => (
        <div className="flex flex-col gap-1.5 border-l-2 border-[color:var(--accent)] pl-3" key={entry.question}>
          <p className="text-sm font-semibold text-[color:var(--tx)]">{entry.question}</p>
          {entry.why ? <p className="text-xs text-[color:var(--tx3)]">{entry.why}</p> : null}
          {entry.suggestedAnswers.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {entry.suggestedAnswers.map((answer) => (
                <button
                  className="admin-button admin-button-secondary admin-button-compact"
                  disabled={!canAnswer}
                  key={answer}
                  onClick={() => onAnswer(openQuestionReply(entry.question, answer))}
                  type="button"
                >
                  {answer}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </section>
  )
}
