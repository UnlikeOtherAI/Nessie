import type { FormEvent, Ref } from 'react'
import { CHAT_MESSAGE_MAX_CHARS } from '@nessie/schemas'
import {
  MentionInput,
  type MentionEntity,
  type MentionInputHandle,
} from '../../shared/MentionInput'
import { toolbarButtonClass } from './channel-helpers'

interface ChannelComposerProps {
  mentionRef: Ref<MentionInputHandle>
  mentionEntities: MentionEntity[]
  placeholder: string
  message: string
  isSendPending: boolean
  onChangeMessage: (value: string) => void
  onOversizePaste: (paste: string) => void
  onSubmitText: (text: string) => void
  onSubmitForm: (event?: FormEvent<HTMLFormElement>) => void
  onInsertAtSign: () => void
}

export const ChannelComposer = ({
  mentionRef,
  mentionEntities,
  placeholder,
  message,
  isSendPending,
  onChangeMessage,
  onOversizePaste,
  onSubmitText,
  onSubmitForm,
  onInsertAtSign,
}: ChannelComposerProps) => (
  <div className="flex-shrink-0 px-5 pb-[14px]">
    <form className="admin-compose" onSubmit={onSubmitForm}>
      <MentionInput
        ref={mentionRef}
        entities={mentionEntities}
        maxLength={CHAT_MESSAGE_MAX_CHARS}
        onChange={onChangeMessage}
        onOversizePaste={onOversizePaste}
        onSubmit={onSubmitText}
        placeholder={placeholder}
      />
      <div className="flex items-center justify-between border-t border-[color:var(--border-strong)] px-3 py-1.5">
        <div className="flex items-center gap-1">
          <button
            className={toolbarButtonClass}
            onClick={onInsertAtSign}
            type="button"
          >
            @
          </button>
          <button className={toolbarButtonClass} type="button">
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path
                d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button className={toolbarButtonClass} type="button">
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path
                d={[
                  'M15.172 7 8.586 13.586a2 2 0 102.828 2.828l6.414-6.586',
                  'a4 4 0 00-5.656-5.656L5.757 10.757a6 6 0 108.486 8.486L20.5 13',
                ].join(' ')}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
        <button
          className="flex h-[30px] items-center justify-center rounded-lg bg-[color:var(--accent)] px-3 text-white"
          disabled={!message.trim() || isSendPending}
          type="submit"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <path
              d="m12 19 9 2-9-18-9 18 9-2Zm0 0v-8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </form>
  </div>
)
