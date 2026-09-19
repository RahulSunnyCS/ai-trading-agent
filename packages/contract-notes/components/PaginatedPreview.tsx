"use client";

import React, { memo, useEffect, useRef } from "react";
import "../styles/print-shared.css";

type PreviewerLike = {
  preview: (content: Element, stylesheets?: string[], renderTo?: Element) => Promise<unknown>;
  destroy?: () => void;
};

type PagedLike = {
  Previewer: new () => PreviewerLike;
};

export type PaginatedPreviewProps = {
  html: string;
  className?: string;
  debounceMs?: number;
};

/**
 * Shared asset loading guard to avoid running pagination against unstable layout.
 */
async function waitForFontsAndImages(container: HTMLElement): Promise<void> {
  if (typeof document !== "undefined" && "fonts" in document) {
    await (document as Document & { fonts: FontFaceSet }).fonts.ready;
  }

  const images = Array.from(container.querySelectorAll("img"));
  if (images.length === 0) return;

  await Promise.all(
    images.map(
      (img) =>
        new Promise<void>((resolve) => {
          if (img.complete) {
            resolve();
            return;
          }

          const onDone = () => {
            img.removeEventListener("load", onDone);
            img.removeEventListener("error", onDone);
            resolve();
          };

          img.addEventListener("load", onDone);
          img.addEventListener("error", onDone);
        }),
    ),
  );
}

const PaginatedPreview = ({ html, className, debounceMs = 120 }: PaginatedPreviewProps) => {
  // Stable container refs; these nodes are never conditionally unmounted.
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const pagedRootRef = useRef<HTMLDivElement | null>(null);

  // Lifecycle refs so pagination does not depend on React state updates.
  const previewerRef = useRef<PreviewerLike | null>(null);
  const runIdRef = useRef(0);
  const runningRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const destroyPreviewer = () => {
    if (!previewerRef.current) return;

    try {
      previewerRef.current.destroy?.();
      console.info("[PaginatedPreview] destroyed previous previewer");
    } catch (error) {
      console.warn("[PaginatedPreview] previewer destroy failed", error);
    }

    previewerRef.current = null;
  };

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const content = contentRef.current;
    const pagedRoot = pagedRootRef.current;

    if (!wrapper || !content || !pagedRoot) {
      console.warn("[PaginatedPreview] skipped pagination: required container is missing");
      return;
    }

    // Keep source markup stable before kicking pagination.
    content.innerHTML = html;

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(async () => {
      const currentRunId = ++runIdRef.current;

      // Hard guard against concurrent runs.
      if (runningRef.current) {
        console.info("[PaginatedPreview] skipped run: pagination already in progress");
        return;
      }

      runningRef.current = true;
      wrapper.dataset.paginationRunning = "true";

      try {
        await waitForFontsAndImages(content);

        // Ignore stale runs queued before latest DOM input settled.
        if (currentRunId !== runIdRef.current) {
          return;
        }

        const Paged = (window as Window & { Paged?: PagedLike }).Paged;
        if (!Paged?.Previewer) {
          console.warn("[PaginatedPreview] skipped pagination: window.Paged.Previewer unavailable");
          return;
        }

        // Always destroy old instance first to avoid duplicate handlers and stale internals.
        destroyPreviewer();

        // Reset previous output in a controlled way before new layout.
        pagedRoot.innerHTML = "";

        const previewer = new Paged.Previewer();
        previewerRef.current = previewer;
        console.info("[PaginatedPreview] starting pagination run");

        // Keep width deterministic to avoid resize underflow checks in paged internals.
        const width = wrapper.getBoundingClientRect().width;
        if (width > 0) {
          pagedRoot.style.width = `${Math.floor(width)}px`;
        }

        await previewer.preview(content, [], pagedRoot);
        console.info("[PaginatedPreview] pagination completed");
      } catch (error) {
        console.error("[PaginatedPreview] pagination failed", error);
      } finally {
        if (currentRunId === runIdRef.current) {
          runningRef.current = false;
          wrapper.dataset.paginationRunning = "false";
        }
      }
    }, debounceMs);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      // Invalidate in-flight async work and cleanup singleton previewer instance.
      runIdRef.current += 1;
      runningRef.current = false;
      wrapper.dataset.paginationRunning = "false";
      destroyPreviewer();
    };
  }, [html, debounceMs]);

  return (
    <section ref={wrapperRef} className={["print-preview-shell", className].filter(Boolean).join(" ")}>
      <div ref={contentRef} className="print-source" aria-hidden="true" />
      <div ref={pagedRootRef} className="print-paged-root print-document" />
    </section>
  );
};

export default memo(PaginatedPreview);
