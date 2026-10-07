import { ArrowLeft, ArrowRight, ExternalLink, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { GLOSSARY } from '../../guide/glossary';
import {
  GUIDE_CHAPTERS,
  type GuidePage,
  chapterPages,
  chapterTitle,
  guidePath,
  neighbours,
  resolveGuidePage,
  searchGuide,
} from '../../guide/registry';
import { useAppRoute } from '../../hooks/useAppRoute';
import { cn } from '../../lib/cn';
import { buildPath } from '../../lib/routes';
import { Badge, Card, Input, Select, buttonClass } from '../ui';
import { GlossaryList } from './GlossaryList';
import { Callout, GuideMarkdown } from './GuideMarkdown';
import { glossaryHref, isPlainClick, openGlossaryTerm } from './links';

/** Shown on the pages flagged `disclaimer` in the registry; written once, here. */
function Disclaimer() {
  return (
    <Callout kind="warning">
      <p>
        This is a personal research workbench, not investment advice. It places no orders. Its
        backtests describe how a rule behaved on past data; they are not a forecast, and a
        strategy's results count only once its validation has passed.
      </p>
    </Callout>
  );
}

function PageLink({
  page,
  active,
  onOpen,
}: {
  page: GuidePage;
  active: boolean;
  onOpen: (page: GuidePage) => void;
}) {
  return (
    <a
      href={guidePath(page)}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'block rounded-md px-2 py-1.5 text-sm transition-colors',
        active
          ? 'bg-primary/10 font-medium text-primary'
          : 'text-muted hover:bg-surface-2 hover:text-foreground',
      )}
      onClick={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        onOpen(page);
      }}
    >
      {page.title}
    </a>
  );
}

/** The left-hand index on wide screens: a filter box, then every chapter and its pages. */
function GuideIndex({
  current,
  onOpen,
}: {
  current: GuidePage;
  onOpen: (page: GuidePage) => void;
}) {
  const [query, setQuery] = useState('');
  const trimmed = query.trim();
  const pages = useMemo(() => (trimmed ? searchGuide(trimmed) : []), [trimmed]);
  const terms = useMemo(() => {
    const needle = trimmed.toLowerCase();
    if (!needle) return [];
    return GLOSSARY.filter(
      (entry) =>
        entry.term.toLowerCase().includes(needle) || entry.short.toLowerCase().includes(needle),
    ).slice(0, 8);
  }, [trimmed]);

  return (
    <div className="space-y-4">
      <div className="relative">
        <label htmlFor="guide-search" className="sr-only">
          Search the Guide
        </label>
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint"
          aria-hidden="true"
        />
        <Input
          id="guide-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search the Guide"
          className="pl-8"
        />
      </div>

      {trimmed ? (
        <div className="space-y-4">
          <div>
            <p className="mb-1 px-2 text-xs font-semibold uppercase tracking-wider text-faint">
              Pages
            </p>
            {pages.length ? (
              pages.map((page) => (
                <PageLink
                  key={`${page.chapter}/${page.slug}`}
                  page={page}
                  active={page === current}
                  onOpen={onOpen}
                />
              ))
            ) : (
              <p className="px-2 text-sm text-muted">No page mentions that.</p>
            )}
          </div>
          {terms.length ? (
            <div>
              <p className="mb-1 px-2 text-xs font-semibold uppercase tracking-wider text-faint">
                Glossary
              </p>
              {terms.map((entry) => (
                <a
                  key={entry.id}
                  href={glossaryHref(entry.id)}
                  className="block rounded-md px-2 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-foreground"
                  onClick={(event) => {
                    if (!isPlainClick(event)) return;
                    event.preventDefault();
                    openGlossaryTerm(entry.id);
                  }}
                >
                  {entry.term}
                </a>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        GUIDE_CHAPTERS.map((chapter) => (
          <div key={chapter.id}>
            <p className="mb-1 px-2 text-xs font-semibold uppercase tracking-wider text-faint">
              {chapter.title}
            </p>
            {chapterPages(chapter.id).map((page) => (
              <PageLink key={page.slug} page={page} active={page === current} onOpen={onOpen} />
            ))}
          </div>
        ))
      )}
    </div>
  );
}

/** Below lg the index is a single page picker. */
function GuidePicker({
  current,
  onOpen,
}: {
  current: GuidePage;
  onOpen: (page: GuidePage) => void;
}) {
  return (
    <div className="block lg:hidden">
      <label htmlFor="guide-page" className="mb-1 block text-xs font-medium text-muted">
        Guide page
      </label>
      <Select
        id="guide-page"
        value={`${current.chapter}/${current.slug}`}
        onChange={(event) => {
          const [chapter, slug] = event.target.value.split('/');
          const page = chapterPages(chapter as GuidePage['chapter']).find((p) => p.slug === slug);
          if (page) onOpen(page);
        }}
      >
        {GUIDE_CHAPTERS.map((chapter) => (
          <optgroup key={chapter.id} label={chapter.title}>
            {chapterPages(chapter.id).map((page) => (
              <option key={page.slug} value={`${page.chapter}/${page.slug}`}>
                {page.title}
              </option>
            ))}
          </optgroup>
        ))}
      </Select>
    </div>
  );
}

function PagerLink({
  page,
  direction,
  onOpen,
}: {
  page: GuidePage | undefined;
  direction: 'previous' | 'next';
  onOpen: (page: GuidePage) => void;
}) {
  if (!page) return <span />;
  const next = direction === 'next';
  return (
    <a
      href={guidePath(page)}
      className={cn(
        'group flex min-w-0 flex-1 flex-col rounded-xl border border-border bg-surface px-4 py-3 transition-colors hover:border-primary/40',
        next && 'items-end text-right',
      )}
      onClick={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        onOpen(page);
      }}
    >
      <span className="flex items-center gap-1 text-xs text-muted">
        {next ? null : <ArrowLeft className="h-3 w-3" aria-hidden="true" />}
        {next ? 'Next' : 'Previous'}
        {next ? <ArrowRight className="h-3 w-3" aria-hidden="true" /> : null}
      </span>
      <span className="mt-0.5 truncate text-sm font-medium text-foreground group-hover:text-primary">
        {page.title}
      </span>
    </a>
  );
}

/**
 * The Guide (BL-041): plain-English help for every screen. The route is
 * /guide/<chapter>/<page>; the pages themselves are Markdown files listed in guide/registry.ts.
 */
export function GuideView() {
  const { pathname, rest, navigate, replace } = useAppRoute();
  const { page, exact } = resolveGuidePage(rest);
  const { previous, next } = neighbours(page);

  // A bare /guide or /guide/<chapter>, or an unknown page, settles on its canonical path. Keyed
  // on the pathname too: App rewrites an alias (/help) to /guide after this has run once, and
  // that second change must be corrected as well.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger
  useEffect(() => {
    if (exact) return;
    // A tick later: on first load Next restores its own URL during hydration, which would
    // undo a replace made in the same commit.
    const timer = window.setTimeout(() => replace('guide', page.chapter, page.slug), 0);
    return () => window.clearTimeout(timer);
  }, [exact, page, replace, pathname]);

  // A new page starts at the top, unless the URL points at a glossary term.
  // biome-ignore lint/correctness/useExhaustiveDependencies: page is the trigger
  useEffect(() => {
    const target = window.location.hash
      ? document.getElementById(window.location.hash.slice(1))
      : null;
    if (target) target.scrollIntoView({ block: 'start' });
    else window.scrollTo({ top: 0 });
  }, [page]);

  const open = (target: GuidePage) => navigate('guide', target.chapter, target.slug);
  const screenPath = page.screen ? buildPath(page.screen.tab, ...(page.screen.rest ?? [])) : null;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <nav aria-label="Guide pages" className="hidden lg:block">
        <div className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto pb-4">
          <GuideIndex current={page} onOpen={open} />
        </div>
      </nav>

      <div className="min-w-0 space-y-4">
        <GuidePicker current={page} onOpen={open} />

        <Card className="px-5 py-6 sm:px-8">
          <article className="mx-auto max-w-3xl">
            <header className="mb-6 border-b border-border pb-5">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <span>{chapterTitle(page.chapter)}</span>
                <Badge>{page.kind}</Badge>
              </div>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
                {page.title}
              </h2>
              <p className="mt-1 text-sm text-muted">{page.summary}</p>
              {screenPath && page.screen ? (
                <a
                  href={screenPath}
                  className={cn(buttonClass('secondary', 'sm'), 'mt-4')}
                  onClick={(event) => {
                    if (!isPlainClick(event) || !page.screen) return;
                    event.preventDefault();
                    navigate(page.screen.tab, ...(page.screen.rest ?? []));
                  }}
                >
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  Open this screen
                </a>
              ) : null}
            </header>

            {page.disclaimer ? <Disclaimer /> : null}
            <GuideMarkdown>{page.body}</GuideMarkdown>
            {page.chapter === 'glossary' ? <GlossaryList /> : null}
          </article>
        </Card>

        <div className="flex gap-3">
          <PagerLink page={previous} direction="previous" onOpen={open} />
          <PagerLink page={next} direction="next" onOpen={open} />
        </div>
      </div>
    </div>
  );
}
