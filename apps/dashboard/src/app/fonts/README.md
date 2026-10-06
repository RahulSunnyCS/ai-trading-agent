# Self-hosted fonts

IBM Plex Sans (400/500/600/700) and IBM Plex Mono (400/500/600), latin subset, woff2.
Source: the `@fontsource/ibm-plex-sans` and `@fontsource/ibm-plex-mono` npm packages, v5.3.0
(`files/ibm-plex-*-latin-<weight>-normal.woff2`). Licence: SIL OFL 1.1, the two `OFL-*.txt` files here.

Loaded by `../layout.tsx` with `next/font/local`, so `next build` makes no network request.
To add a weight or subset, copy the matching file from the same package and list it in `layout.tsx`.
