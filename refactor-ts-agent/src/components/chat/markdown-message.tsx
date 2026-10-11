'use client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

// Raw HTML stays unparsed (skipHtml) and every link opens outside the app, so a
// model response can never execute markup inside the chat page.
export function MarkdownMessage({ content }: { content: string }) {
  return <div className="markdown-body">
    <ReactMarkdown
      skipHtml
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{ a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer nofollow" /> }}
    >{content}</ReactMarkdown>
  </div>;
}
