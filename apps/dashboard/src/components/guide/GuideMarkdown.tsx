import { AlertTriangle, Info, Lightbulb } from 'lucide-react';
import type { ReactNode } from 'react';
import ReactMarkdown, { type Components, defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { glossaryEntry } from '../../guide/glossary';
import { guidePageByRef, guidePath } from '../../guide/registry';
import { useAppRoute } from '../../hooks/useAppRoute';
import { parsePath } from '../../lib/routes';
import { GlossaryTerm } from './GlossaryTerm';
import { isPlainClick } from './links';

/** The link schemes a guide page may use besides ordinary web links (see guide/registry.ts). */
const GUIDE_SCHEMES = /^(app|guide|glossary):/;

// ---- Callouts: `> [!NOTE]`, `> [!TIP]`, `> [!WARNING]` -------------------------------------

/** The slice of the Markdown syntax tree the callout plugin touches. */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hProperties?: Record<string, string> };
}

const CALLOUT_MARK = /^\[!(NOTE|TIP|WARNING)\]\s*/;

/** Turns a blockquote that starts with `[!NOTE]` (GitHub's syntax) into a tagged callout. */
function remarkCallouts() {
  const visit = (node: MdNode): void => {
    if (node.type === 'blockquote') {
      const paragraph = node.children?.[0];
      const text = paragraph?.type === 'paragraph' ? paragraph.children?.[0] : undefined;
      const match = text?.type === 'text' ? CALLOUT_MARK.exec(text.value ?? '') : null;
      if (text && match) {
        text.value = (text.value ?? '').slice(match[0].length);
        node.data = {
          ...node.data,
          hProperties: { 'data-callout': (match[1] ?? 'note').toLowerCase() },
        };
      }
    }
    node.children?.forEach(visit);
  };
  return (tree: MdNode) => visit(tree);
}

const CALLOUTS = {
  note: {
    icon: Info,
    label: 'Note',
    className: 'border-info/30 bg-info/10',
    iconClass: 'text-info',
  },
  tip: {
    icon: Lightbulb,
    label: 'Tip',
    className: 'border-positive/30 bg-positive/10',
    iconClass: 'text-positive',
  },
  warning: {
    icon: AlertTriangle,
    label: 'Watch out',
    className: 'border-warning/30 bg-warning/10',
    iconClass: 'text-warning',
  },
} as const;

export function Callout({
  kind,
  children,
}: {
  kind: keyof typeof CALLOUTS;
  children: ReactNode;
}) {
  const style = CALLOUTS[kind];
  const Icon = style.icon;
  return (
    <aside
      aria-label={style.label}
      className={`my-4 flex gap-3 rounded-lg border px-4 py-3 text-sm ${style.className}`}
    >
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${style.iconClass}`} aria-hidden="true" />
      <div className="min-w-0 space-y-2 text-foreground [&>p]:my-0">{children}</div>
    </aside>
  );
}

// ---- Links ---------------------------------------------------------------------------------

const linkClass =
  'font-medium text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary';

function GuideAnchor({ href, children }: { href: string | undefined; children: ReactNode }) {
  const { navigate } = useAppRoute();
  if (!href) return <>{children}</>;

  if (href.startsWith('glossary:')) {
    const entry = glossaryEntry(href.slice('glossary:'.length));
    return entry ? <GlossaryTerm entry={entry}>{children}</GlossaryTerm> : <>{children}</>;
  }

  let target: string | null = null;
  if (href.startsWith('app:')) target = href.slice('app:'.length);
  if (href.startsWith('guide:')) {
    const page = guidePageByRef(href.slice('guide:'.length));
    target = page ? guidePath(page) : null;
  }
  if (target !== null) {
    const route = parsePath(target);
    return (
      <a
        href={target}
        className={linkClass}
        onClick={(event) => {
          if (!route.tab || !isPlainClick(event)) return;
          event.preventDefault();
          navigate(route.tab, ...route.rest);
        }}
      >
        {children}
      </a>
    );
  }

  const external = /^https?:/.test(href);
  return (
    <a
      href={href}
      className={linkClass}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
    >
      {children}
    </a>
  );
}

// ---- Elements --------------------------------------------------------------------------------

const COMPONENTS: Components = {
  h1: ({ children }) => (
    <h2 className="mb-3 mt-8 text-lg font-semibold tracking-tight text-foreground first:mt-0">
      {children}
    </h2>
  ),
  h2: ({ children }) => (
    <h2 className="mb-3 mt-8 text-lg font-semibold tracking-tight text-foreground first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-2 mt-6 text-base font-semibold text-foreground">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-2 mt-4 text-sm font-semibold text-foreground">{children}</h4>
  ),
  p: ({ children }) => <p className="my-3 leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="my-3 list-disc space-y-1.5 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-3 list-decimal space-y-1.5 pl-5">{children}</ol>,
  li: ({ children }) => <li className="pl-1 leading-relaxed [&>p]:my-1">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  hr: () => <hr className="my-6 border-border" />,
  a: ({ href, children }) => <GuideAnchor href={href}>{children}</GuideAnchor>,
  blockquote: ({ children, ...props }) => {
    const kind = (props as Record<string, unknown>)['data-callout'];
    if (kind === 'note' || kind === 'tip' || kind === 'warning') {
      return <Callout kind={kind}>{children}</Callout>;
    }
    return (
      <blockquote className="my-4 border-l-2 border-border pl-4 text-muted">{children}</blockquote>
    );
  },
  pre: ({ children }) => (
    <pre className="my-4 overflow-x-auto rounded-lg border border-border bg-surface-2/70 px-3 py-2 font-mono text-xs text-foreground [&_code]:border-0 [&_code]:bg-transparent [&_code]:p-0">
      {children}
    </pre>
  ),
  code: ({ children }) => (
    <code className="rounded border border-border bg-surface-2/70 px-1 py-0.5 font-mono text-[0.85em] text-foreground">
      {children}
    </code>
  ),
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-border bg-surface-2/50 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-faint">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-border/60 px-3 py-2 align-top leading-relaxed">{children}</td>
  ),
};

/** Keeps the guide's own link schemes, which react-markdown would otherwise strip as unsafe. */
function urlTransform(url: string): string {
  return GUIDE_SCHEMES.test(url) ? url : defaultUrlTransform(url);
}

/** Renders one guide page's Markdown with the dashboard's own tokens (no typography plugin). */
export function GuideMarkdown({ children }: { children: string }) {
  return (
    <div className="text-sm text-foreground/90">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkCallouts]}
        components={COMPONENTS}
        urlTransform={urlTransform}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
