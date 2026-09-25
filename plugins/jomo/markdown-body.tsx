import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";

export function MarkdownBody({ body }: { body: string }) {
  return <div className="break-words text-sm leading-7 text-foreground/90 [&_a]:text-sky-400 [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_h1]:mb-4 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mb-3 [&_h2]:mt-8 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mt-6 [&_h3]:text-lg [&_h3]:font-semibold [&_hr]:my-6 [&_li]:ml-5 [&_li]:list-disc [&_ol_li]:list-decimal [&_p]:mb-4 [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:bg-muted [&_pre]:p-4 [&_pre_code]:bg-transparent [&_table]:block [&_table]:overflow-x-auto [&_td]:border [&_td]:border-border [&_td]:p-2 [&_th]:border [&_th]:border-border [&_th]:p-2">
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, rehypeSanitize]} components={{
      a: ({ children, href, ...props }) => <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
      img: ({ alt, src, ...props }) => <img {...props} alt={alt ?? ""} src={src} loading="lazy" className="max-w-full rounded-lg" />,
    }}>{body}</ReactMarkdown>
  </div>;
}
