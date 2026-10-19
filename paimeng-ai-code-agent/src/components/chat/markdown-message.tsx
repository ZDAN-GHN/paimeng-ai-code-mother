'use client';
import { memo, useDeferredValue } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

// 无语言标签的代码块不高亮（pi 同款决策：语言自动检测不可靠，会把散文误判成
// 某种冷门语言随机上色，且检测本身是按全语言包的猜测成本）。带标签的照常高亮。
const highlight: [typeof rehypeHighlight, { detect: false }] = [rehypeHighlight, { detect: false }];

// Raw HTML stays unparsed (skipHtml) and every link opens outside the app, so a
// model response can never execute markup inside the chat page.
//
// Perf: every text block is one full react-markdown parse (GFM + highlight.js).
// Without memo, each streaming delta re-parses *all* text blocks on the page and
// every unrelated state update (polling, timers) re-renders them too. With memo
// only blocks whose content changed re-parse; useDeferredValue additionally
// lets React finish the keystroke/poll paint before the (long, growing) parse
// of the block that is still streaming, spreading the cost over idle frames.
function MarkdownBody({ content }: { content: string }) {
  return <div className="markdown-body">
    <ReactMarkdown
      skipHtml
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[highlight]}
      components={{ a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer nofollow" /> }}
    >{content}</ReactMarkdown>
  </div>;
}

export const MarkdownMessage = memo(function MarkdownMessage({ content }: { content: string }) {
  return <MarkdownBody content={useDeferredValue(content)} />;
});
