import React, { useMemo, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { normalizeMessageMarkdown } from '../../../lib/message-markdown'
import { ExpandableTable } from '../../shared/ExpandableTable'

interface MessageMarkdownProps {
  /**
   * Remote images are loaded by default (a channel message is written by people
   * and agents in the room). Pass `false` where the markdown is model-authored
   * and shown without anyone asking for it — a streamed document popup opens by
   * itself, so an `![](https://attacker/beacon.png)` in it would report the
   * viewer's IP, user agent and reading time before a human saw a word. Those
   * images render as an inert placeholder and fetch nothing.
   */
  allowRemoteImages?: boolean
  children: string
  renderInlineText: (text: string) => ReactNode
}

const renderTextChildren = (
  children: ReactNode,
  renderInlineText: MessageMarkdownProps['renderInlineText'],
): ReactNode =>
  React.Children.map(children, (child) =>
    typeof child === 'string' ? renderInlineText(child) : child,
  )

// Channel content is stored as Markdown for both humans and agents. Text nodes
// still pass through the channel mention renderer, while literal code stays
// untouched so an @name or #channel inside a snippet is never made interactive.
const ImagePlaceholder = ({ alt }: { alt?: string }) => (
  <span
    className={[
      'my-1 inline-flex max-w-full items-center gap-1.5 rounded border border-dashed',
      'border-[color:var(--sep)] px-2 py-1 text-xs text-[color:var(--tx3)]',
    ].join(' ')}
    data-testid="blocked-remote-image"
  >
    <span aria-hidden="true">🖼</span>
    <span className="min-w-0 truncate">{alt?.trim() || 'Image'} — not loaded</span>
  </span>
)

export const MessageMarkdown = ({
  allowRemoteImages = true,
  children,
  renderInlineText,
}: MessageMarkdownProps) => {
  const components = useMemo<Components>(
    () => ({
      ...(allowRemoteImages
        ? {}
        : {
            img: ({ alt }: { alt?: string }) => <ImagePlaceholder alt={alt} />,
          }),
      a: ({ children: linkChildren, node: _node, ...props }) => (
        <a
          {...props}
          rel="noreferrer noopener"
          target="_blank"
        >
          {linkChildren}
        </a>
      ),
      code: ({ children: codeChildren, className, node: _node, ...props }) => (
        <code
          {...props}
          className={[className, 'admin-message-code'].filter(Boolean).join(' ')}
        >
          {codeChildren}
        </code>
      ),
      del: ({ children: delChildren, node: _node, ...props }) => (
        <del {...props}>{renderTextChildren(delChildren, renderInlineText)}</del>
      ),
      em: ({ children: emChildren, node: _node, ...props }) => (
        <em {...props}>{renderTextChildren(emChildren, renderInlineText)}</em>
      ),
      h1: ({ children: headingChildren, node: _node, ...props }) => (
        <h1 {...props}>{renderTextChildren(headingChildren, renderInlineText)}</h1>
      ),
      h2: ({ children: headingChildren, node: _node, ...props }) => (
        <h2 {...props}>{renderTextChildren(headingChildren, renderInlineText)}</h2>
      ),
      h3: ({ children: headingChildren, node: _node, ...props }) => (
        <h3 {...props}>{renderTextChildren(headingChildren, renderInlineText)}</h3>
      ),
      h4: ({ children: headingChildren, node: _node, ...props }) => (
        <h4 {...props}>{renderTextChildren(headingChildren, renderInlineText)}</h4>
      ),
      h5: ({ children: headingChildren, node: _node, ...props }) => (
        <h5 {...props}>{renderTextChildren(headingChildren, renderInlineText)}</h5>
      ),
      h6: ({ children: headingChildren, node: _node, ...props }) => (
        <h6 {...props}>{renderTextChildren(headingChildren, renderInlineText)}</h6>
      ),
      li: ({ children: itemChildren, node: _node, ...props }) => (
        <li {...props}>{renderTextChildren(itemChildren, renderInlineText)}</li>
      ),
      p: ({ children: paragraphChildren, node: _node, ...props }) => (
        <p {...props}>{renderTextChildren(paragraphChildren, renderInlineText)}</p>
      ),
      pre: ({ children: codeBlockChildren, node: _node, ...props }) => (
        <pre {...props} className="admin-message-code-block" tabIndex={0}>
          {codeBlockChildren}
        </pre>
      ),
      strong: ({ children: strongChildren, node: _node, ...props }) => (
        <strong {...props}>
          {renderTextChildren(strongChildren, renderInlineText)}
        </strong>
      ),
      table: ({ children: tableChildren, node: _node, ...props }) => (
        <ExpandableTable label="Message table">
          <table {...props}>{tableChildren}</table>
        </ExpandableTable>
      ),
      td: ({ children: cellChildren, node: _node, ...props }) => (
        <td {...props}>{renderTextChildren(cellChildren, renderInlineText)}</td>
      ),
      th: ({ children: cellChildren, node: _node, ...props }) => (
        <th {...props}>{renderTextChildren(cellChildren, renderInlineText)}</th>
      ),
    }),
    [allowRemoteImages, renderInlineText],
  )

  return (
    <div className="admin-message-markdown">
      <Markdown components={components} remarkPlugins={[remarkGfm]}>
        {normalizeMessageMarkdown(children)}
      </Markdown>
    </div>
  )
}
