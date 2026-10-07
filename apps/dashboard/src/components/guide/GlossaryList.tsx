import { GLOSSARY, GLOSSARY_GROUPS, glossaryAnchor, glossaryEntry } from '../../guide/glossary';
import { glossaryHref, isPlainClick, openGlossaryTerm } from './links';

/** The Glossary page's body: every entry, grouped, alphabetical within a group. */
export function GlossaryList() {
  return (
    <div className="mt-6 space-y-8">
      {GLOSSARY_GROUPS.map((group) => {
        const entries = GLOSSARY.filter((entry) => entry.group === group).sort((a, b) =>
          a.term.localeCompare(b.term),
        );
        return (
          <section key={group} aria-labelledby={`glossary-${group}`}>
            <h2
              id={`glossary-${group}`}
              className="mb-3 text-xs font-semibold uppercase tracking-wider text-faint"
            >
              {group}
            </h2>
            <dl className="divide-y divide-border rounded-lg border border-border">
              {entries.map((entry) => (
                <div
                  key={entry.id}
                  id={glossaryAnchor(entry.id)}
                  className="scroll-mt-24 px-4 py-3 target:bg-primary/10"
                >
                  <dt className="text-sm font-semibold text-foreground">{entry.term}</dt>
                  <dd className="mt-1 space-y-1.5 text-sm leading-relaxed text-foreground/90">
                    <p>{entry.short}</p>
                    {entry.long ? <p className="text-muted">{entry.long}</p> : null}
                    {entry.seeAlso?.length ? (
                      <p className="text-xs text-muted">
                        See also:{' '}
                        {entry.seeAlso.map((id, index) => {
                          const other = glossaryEntry(id);
                          if (!other) return null;
                          return (
                            <span key={id}>
                              {index > 0 ? ', ' : null}
                              <a
                                href={glossaryHref(id)}
                                className="font-medium text-primary underline-offset-2 hover:underline"
                                onClick={(event) => {
                                  if (!isPlainClick(event)) return;
                                  event.preventDefault();
                                  openGlossaryTerm(id);
                                }}
                              >
                                {other.term}
                              </a>
                            </span>
                          );
                        })}
                      </p>
                    ) : null}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        );
      })}
    </div>
  );
}
