/** A Markdown file imported as its text (`./page.md?raw`); see next.config.ts. */
declare module '*.md?raw' {
  const body: string;
  export default body;
}
