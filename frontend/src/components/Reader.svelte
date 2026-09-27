<script>
  import { onMount } from "svelte";
  import "foliate-js/view.js";
  import { Overlayer } from "foliate-js/overlayer.js";
  import * as pdfjsLib from "pdfjs-dist";
  import ReaderHeader from "./ReaderHeader.svelte";
  import AnnotationPanel from "./AnnotationPanel.svelte";
  import AnnotationsList from "./AnnotationsList.svelte";
  import AudioPlayer from "./AudioPlayer.svelte";
  import TableOfContents from "./TableOfContents.svelte";
  import { FOLIATE_FORMATS, TEXT_FORMATS, AUDIO_FORMATS } from "../lib/constants.js";
  import { saveLocalProgress, effectiveProgress } from "../lib/offline.js";
  import {
    drawPDFHighlightsForPage,
    applyPDFHighlight,
    removePDFHighlight,
    goToPDFAnnotation,
    capturePDFSelection,
  } from "../lib/pdfAnnotations.js";

  let { bookId, onClose } = $props();

  let readerContainer = $state();
  let view = $state(null);
  let loading = $state(true);
  let error = $state(null);
  let currentLocation = $state(0);
  let totalLocations = $state(0);

  let bookBlob = $state(null);
  let bookMetadata = $state(null);
  let isAudio = $state(false);
  let pdfDoc = $state(null);
  let currentPage = $state(1);
  let totalPages = $state(0);

  let headerVisible = $state(true);
  let hideTimeout = null;
  let isFullscreen = $state(false);

  let fontSize = $state(20);
  const MIN_FONT_SIZE = 12;
  const MAX_FONT_SIZE = 32;
  let epubContentDoc = null;

  let annotationColors = new Map();
  let annotations = $state([]);
  let showAnnotationPanel = $state(false);
  let showAnnotationsList = $state(false);
  let toc = $state([]);
  let showToc = $state(false);
  let selectedText = $state(null);

  let selectedPosition = $state(null);
  let annotationNote = $state("");
  let annotationColor = $state("yellow");

  const foliateState = {
    cfi: null,
    sectionIndex: null,
    sectionTotal: null,
  };

  const pdfState = {
    textLayer: null,
    scale: null,
  };
  let pdfSelectionTimeout = null;

  const anyPanelOpen = $derived(
    showAnnotationPanel || showAnnotationsList || showToc,
  );

  const flattenToc = (nodes, level = 0, out = []) => {
    for (const n of nodes || []) {
      out.push({ label: (n.label || "").trim(), href: n.href, level });
      if (n.subitems?.length) flattenToc(n.subitems, level + 1, out);
    }
    return out;
  };

  const flattenPdfOutline = (nodes, level = 0, out = []) => {
    for (const n of nodes || []) {
      out.push({ label: (n.title || "").trim(), dest: n.dest, level });
      if (n.items?.length) flattenPdfOutline(n.items, level + 1, out);
    }
    return out;
  };

  const goToPdfDest = async (dest) => {
    if (!pdfDoc || !dest) return;
    try {
      let d = dest;
      if (typeof d === "string") d = await pdfDoc.getDestination(d);
      if (!Array.isArray(d) || d.length === 0) return;
      const pageIndex = await pdfDoc.getPageIndex(d[0]);
      renderPDFPage(pageIndex + 1);
    } catch (e) {}
  };

  const handleGoToTocItem = (item) => {
    if (bookMetadata?.fileType === "pdf") goToPdfDest(item.dest);
    else view?.goTo(item.href);
    showToc = false;
  };

  $effect(() => {
    if (anyPanelOpen) {
      headerVisible = false;
    }
  });

  $effect(() => {
    if (bookMetadata?.fileType !== "pdf") return;
    document.addEventListener("selectionchange", handlePDFSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", handlePDFSelectionChange);
    };
  });

  const isTouchDevice =
    typeof window !== "undefined" &&
    window.matchMedia("(pointer: coarse)").matches;

  pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

  const IFRAME_STYLE_ID = "quiret-font-style";

  const buildIframeStyle = ({ fontSize, isDark }) => `
    p, div, span, li, td, th {
      font-size: ${fontSize}px !important;
    }
    ${
      isDark
        ? `* { color: #E8EDF5 !important; }
           a { color: #8FB0D8 !important; }`
        : ""
    }
  `;

  let saveTimeout = null;
  const saveProgress = (progress) => {
    saveLocalProgress(bookId, progress);
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
      try {
        await fetch(`/api/books/${bookId}/progress`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ progress }),
        });
      } catch (err) {
        // Silently fail
      }
    }, 1000);
  };

  const fetchAnnotations = async () => {
    try {
      const res = await fetch(`/api/books/${bookId}/annotations`);
      if (res.ok) {
        annotations = await res.json();
      }
    } catch (err) {
      console.error("Failed to fetch annotations:", err);
    }
  };

  const createAnnotation = async () => {
    if (!selectedText || !selectedPosition) return;

    try {
      const res = await fetch(`/api/books/${bookId}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cfi: selectedPosition,
          text: selectedText,
          note: annotationNote,
          color: annotationColor,
        }),
      });
      if (res.ok) {
        const annotation = await res.json();
        annotations = [annotation, ...annotations];
        applyHighlight(annotation);
        closeAnnotationPanel();
      }
    } catch (err) {
      console.error("Failed to create annotation:", err);
    }
  };

  const deleteAnnotation = async (id) => {
    try {
      const res = await fetch(`/api/books/${bookId}/annotations/${id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        const annotation = annotations.find((a) => a.id === id);
        annotations = annotations.filter((a) => a.id !== id);
        if (annotation) removeHighlight(annotation);
      }
    } catch (err) {
      console.error("Failed to delete annotation:", err);
    }
  };

  const applyHighlight = (annotation) => {
    if (!annotation?.cfi) return;
    if (bookMetadata?.fileType === "pdf") {
      applyPDFHighlight(annotation, pdfState, currentPage);
      return;
    }
    if (!view) return;
    annotationColors.set(annotation.cfi, annotation.color);
    view.addAnnotation({ value: annotation.cfi });
  };

  const removeHighlight = (annotation) => {
    if (!annotation?.cfi) return;
    if (bookMetadata?.fileType === "pdf") {
      removePDFHighlight(annotation, pdfState);
      return;
    }
    if (!view) return;
    annotationColors.delete(annotation.cfi);
    view.addAnnotation({ value: annotation.cfi }, true);
  };

  const applyAllAnnotations = () => {
    if (bookMetadata?.fileType === "pdf") return;
    if (!view || annotations.length === 0) return;
    for (const annotation of annotations) {
      applyHighlight(annotation);
    }
  };

  const closeAnnotationPanel = () => {
    showAnnotationPanel = false;
    selectedText = null;
    selectedPosition = null;
    annotationNote = "";
    annotationColor = "yellow";
  };

  const handleGoToAnnotation = (cfi) => {
    if (bookMetadata?.fileType === "pdf") {
      goToPDFAnnotation(cfi, renderPDFPage);
    } else {
      view?.goTo(cfi);
    }
    showAnnotationsList = false;
  };

  const handlePDFSelectionChange = () => {
    if (bookMetadata?.fileType !== "pdf") return;
    if (!pdfState.textLayer) return;
    if (pdfSelectionTimeout) clearTimeout(pdfSelectionTimeout);
    pdfSelectionTimeout = setTimeout(() => {
      const captured = capturePDFSelection(pdfState, currentPage);
      if (!captured) return;
      selectedText = captured.text;
      selectedPosition = captured.position;
      showAnnotationPanel = true;
    }, 200);
  };

  const bookmarkCurrentPage = () => {
    if (!foliateState.cfi) return;
    if (foliateState.sectionIndex !== null) {
      selectedText = foliateState.sectionTotal
        ? `Page ${foliateState.sectionIndex + 1} of ${foliateState.sectionTotal}`
        : `Page ${foliateState.sectionIndex + 1}`;
    } else {
      selectedText = "Bookmark";
    }
    selectedPosition = foliateState.cfi;
    showAnnotationPanel = true;
  };

  const goNext = () => {
    if (FOLIATE_FORMATS.includes(bookMetadata?.fileType)) {
      view?.next();
    } else if (bookMetadata?.fileType === "pdf" && currentPage < totalPages) {
      renderPDFPage(currentPage + 1);
    }
  };

  const goPrev = () => {
    if (FOLIATE_FORMATS.includes(bookMetadata?.fileType)) {
      view?.prev();
    } else if (bookMetadata?.fileType === "pdf" && currentPage > 1) {
      renderPDFPage(currentPage - 1);
    }
  };

  let touchStartX = 0;
  let touchStartY = 0;
  const handleTouchStart = (event) => {
    touchStartX = event.touches[0].clientX;
    touchStartY = event.touches[0].clientY;
  };

  const handleTouchEnd = (event) => {
    const touchEndX = event.changedTouches[0].clientX;
    const touchEndY = event.changedTouches[0].clientY;
    const diffX = touchStartX - touchEndX;
    const diffY = touchStartY - touchEndY;
    const absDiffX = Math.abs(diffX);
    const absDiffY = Math.abs(diffY);

    if (absDiffX < 10 && absDiffY < 10) {
      if (touchStartY < 80) {
        headerVisible = !headerVisible;
      }
      return;
    }

    if (absDiffY < 50) {
      if (diffX > 50) goNext();
      else if (diffX < -50) goPrev();
    }
  };

  const startHideTimer = () => {
    if (hideTimeout) clearTimeout(hideTimeout);
    hideTimeout = setTimeout(() => {
      headerVisible = false;
    }, 3000);
  };

  const handleMouseMove = (event) => {
    if (isTouchDevice) return;
    if (event.clientY < 60 && !headerVisible) {
      headerVisible = true;
    }
  };

  const increaseFontSize = () => {
    if (fontSize < MAX_FONT_SIZE) {
      fontSize += 2;
      localStorage.setItem("readerFontSize", fontSize.toString());
    }
  };

  const decreaseFontSize = () => {
    if (fontSize > MIN_FONT_SIZE) {
      fontSize -= 2;
      localStorage.setItem("readerFontSize", fontSize.toString());
    }
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
      isFullscreen = true;
    } else {
      document.exitFullscreen();
      isFullscreen = false;
    }
  };

  const handleFullscreenChange = () => {
    isFullscreen = !!document.fullscreenElement;
  };

  const handleKeyPress = (event) => {
    if (isAudio) return; // AudioPlayer handles its own keyboard shortcuts
    if (event.key === "Escape") {
      if (showAnnotationPanel) closeAnnotationPanel();
      else if (showAnnotationsList) showAnnotationsList = false;
      else if (showToc) showToc = false;
      else onClose();
      return;
    }
    if (anyPanelOpen) return;
    if (event.key === "ArrowRight") goNext();
    else if (event.key === "ArrowLeft") goPrev();
  };

  const loadPDF = async () => {
    try {
      const arrayBuffer = await bookBlob.arrayBuffer();
      pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      totalPages = pdfDoc.numPages;
      totalLocations = totalPages;

      try {
        toc = flattenPdfOutline(await pdfDoc.getOutline());
      } catch (e) {
        toc = [];
      }

      let startPage = 1;
      const savedPdf = effectiveProgress(bookMetadata);
      if (savedPdf) {
        try {
          const progress = JSON.parse(savedPdf);
          if (progress.type === "pdf" && progress.page) {
            startPage = Math.min(progress.page, totalPages);
          }
        } catch (e) {}
      }
      await renderPDFPage(startPage);
    } catch (err) {
      error = "Failed to load PDF: " + err.message;
    }
  };

  const renderPDFPage = async (pageNum) => {
    if (!pdfDoc || !readerContainer) return;

    currentPage = pageNum;
    currentLocation = pageNum;

    pdfState.textLayer = null;

    const page = await pdfDoc.getPage(pageNum);
    const containerHeight = window.innerHeight;
    const containerWidth = Math.min(window.innerWidth, 900);
    const originalViewport = page.getViewport({ scale: 1 });
    const scaleHeight = containerHeight / originalViewport.height;
    const scaleWidth = containerWidth / originalViewport.width;
    const scale = Math.min(scaleHeight, scaleWidth);
    const viewport = page.getViewport({ scale });

    readerContainer.innerHTML = "";

    const wrapper = document.createElement("div");
    wrapper.style.position = "relative";
    wrapper.style.width = `${viewport.width}px`;
    wrapper.style.height = `${viewport.height}px`;
    wrapper.style.margin = "0 auto";

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    canvas.height = viewport.height;
    canvas.width = viewport.width;
    canvas.style.display = "block";
    wrapper.appendChild(canvas);

    const textLayerDiv = document.createElement("div");
    textLayerDiv.className = "pdf-text-layer";
    textLayerDiv.style.position = "absolute";
    textLayerDiv.style.left = "0";
    textLayerDiv.style.top = "0";
    textLayerDiv.style.right = "0";
    textLayerDiv.style.bottom = "0";
    textLayerDiv.style.overflow = "hidden";
    textLayerDiv.style.lineHeight = "1";
    wrapper.appendChild(textLayerDiv);

    readerContainer.appendChild(wrapper);

    await page.render({ canvasContext: context, viewport }).promise;

    const textContent = await page.getTextContent();
    const textLayer = new pdfjsLib.TextLayer({
      textContentSource: textContent,
      container: textLayerDiv,
      viewport,
    });
    await textLayer.render();

    pdfState.textLayer = textLayerDiv;
    pdfState.scale = viewport.scale;
    drawPDFHighlightsForPage(
      textLayerDiv,
      pageNum,
      annotations,
      pdfState.scale,
    );

    saveProgress(JSON.stringify({ type: "pdf", page: pageNum, totalPages }));
  };

  onMount(async () => {
    const savedFontSize = localStorage.getItem("readerFontSize");
    if (savedFontSize) {
      fontSize = parseInt(savedFontSize, 10);
    }

    try {
      const metadataResponse = await fetch(`/api/books/${bookId}`);
      if (!metadataResponse.ok) throw new Error("Failed to load book metadata");
      bookMetadata = await metadataResponse.json();

      // Audiobooks stream directly via the <audio> element (range requests),
      // so skip the blob download and text/PDF rendering machinery entirely.
      if (AUDIO_FORMATS.includes(bookMetadata.fileType)) {
        isAudio = true;
        loading = false;
        return;
      }

      await fetchAnnotations();

      const fileResponse = await fetch(`/api/books/${bookId}/file`);
      if (!fileResponse.ok) throw new Error("Failed to load book");
      bookBlob = await fileResponse.blob();

      loading = false;
      startHideTimer();
    } catch (err) {
      error = err.message;
      loading = false;
    }

    return () => {
      if (hideTimeout) clearTimeout(hideTimeout);
      if (saveTimeout) clearTimeout(saveTimeout);
      if (view) {
        try {
          view.remove();
        } catch (e) {}
        view = null;
      }
      if (pdfDoc) {
        pdfDoc.destroy();
        pdfDoc = null;
      }
      epubContentDoc = null;
    };
  });

  $effect(() => {
    if (
      readerContainer &&
      bookBlob &&
      bookMetadata &&
      FOLIATE_FORMATS.includes(bookMetadata.fileType) &&
      !view
    ) {
      view = document.createElement("foliate-view");
      view.style.width = "100%";
      view.style.height = "100%";
      readerContainer.appendChild(view);

      view.addEventListener("relocate", (e) => {
        const fraction = e.detail.fraction;
        if (fraction !== undefined) {
          currentLocation = Math.round(fraction * 100);
          totalLocations = 100;
        }
        if (e.detail.section?.current !== undefined) {
          foliateState.sectionIndex = e.detail.section.current;
          foliateState.sectionTotal = e.detail.section.total ?? null;
        }
        const cfi = e.detail.cfi;
        if (cfi) {
          foliateState.cfi = cfi;
          saveProgress(
            JSON.stringify({ type: bookMetadata.fileType, cfi, fraction }),
          );
        }
        applyAllAnnotations();
      });

      view.addEventListener("load", (e) => {
        try {
          const doc = e.detail?.doc;
          if (doc && doc.documentElement && doc.head) {
            epubContentDoc = doc;

            const style = doc.createElement("style");
            style.id = IFRAME_STYLE_ID;
            style.textContent = buildIframeStyle({
              fontSize,
              isDark: document.documentElement.classList.contains("dark"),
            });
            doc.head.appendChild(style);

            doc.addEventListener("keydown", handleKeyPress);

            let selectionTimeout = null;
            doc.addEventListener("selectionchange", () => {
              if (!TEXT_FORMATS.includes(bookMetadata?.fileType)) return;
              if (selectionTimeout) clearTimeout(selectionTimeout);
              selectionTimeout = setTimeout(() => {
                const selection = doc.getSelection();
                if (
                  selection &&
                  selection.rangeCount > 0 &&
                  !selection.isCollapsed
                ) {
                  const range = selection.getRangeAt(0);
                  const text = selection.toString().trim();
                  if (text && text.length > 0) {
                    selectedText = text;
                    try {
                      const cfi = view.getCFI(e.detail.index, range);
                      selectedPosition = cfi || `section-${e.detail.index}`;
                    } catch {
                      selectedPosition = `section-${e.detail.index}`;
                    }
                    showAnnotationPanel = true;
                  }
                }
              }, 200);
            });
          }
        } catch (err) {}
      });

      view.addEventListener("draw-annotation", (e) => {
        const { draw, annotation } = e.detail;
        const cfi = annotation.value;
        const color = annotationColors.get(cfi) || "yellow";
        draw(Overlayer.highlight, { color });
      });

      const extMap = { epub: ".epub", fb2: ".fb2", cbz: ".cbz" };
      const mimeMap = {
        epub: "application/epub+zip",
        fb2: "application/x-fictionbook+xml",
        cbz: "application/vnd.comicbook+zip",
      };
      const ext = extMap[bookMetadata.fileType] || ".epub";
      const mime = mimeMap[bookMetadata.fileType] || "application/epub+zip";
      const filename = bookMetadata.title
        ? `${bookMetadata.title}${ext}`
        : `book${ext}`;
      const file = new File([bookBlob], filename, { type: mime });

      view
        .open(file)
        .then(() => {
          try {
            toc = flattenToc(view.book?.toc);
          } catch (e) {
            toc = [];
          }
          const savedFoliate = effectiveProgress(bookMetadata);
          if (savedFoliate) {
            try {
              const progress = JSON.parse(savedFoliate);
              if (FOLIATE_FORMATS.includes(progress.type) && progress.cfi) {
                view.goTo(progress.cfi);
                return;
              }
            } catch (e) {}
          }
          view.goTo(0);
        })
        .catch((err) => {
          error = "Failed to open book: " + err.message;
        });
    }
  });

  $effect(() => {
    if (
      readerContainer &&
      bookBlob &&
      bookMetadata &&
      bookMetadata.fileType === "pdf" &&
      !pdfDoc
    ) {
      loadPDF();
    }
  });

  $effect(() => {
    const currentSize = fontSize;
    if (epubContentDoc && TEXT_FORMATS.includes(bookMetadata?.fileType)) {
      const style = epubContentDoc.getElementById(IFRAME_STYLE_ID);
      if (style) {
        style.textContent = style.textContent.replace(
          /font-size:\s*\d+px/g,
          `font-size: ${currentSize}px`,
        );
      }
    }
  });
</script>

<svelte:window
  onkeydown={handleKeyPress}
  onfullscreenchange={handleFullscreenChange}
/>

{#if isAudio}
  <AudioPlayer {bookId} metadata={bookMetadata} {onClose} />
{:else}
<div class="reader-wrapper">
  <div
    class="reader-content"
    role="main"
    inert={anyPanelOpen}
    onmousemove={handleMouseMove}
    ontouchstart={handleTouchStart}
    ontouchend={handleTouchEnd}
  >
    <ReaderHeader
      visible={headerVisible}
      fileType={bookMetadata?.fileType}
      annotationsCount={annotations.length}
      {fontSize}
      minFontSize={MIN_FONT_SIZE}
      maxFontSize={MAX_FONT_SIZE}
      {isFullscreen}
      {isTouchDevice}
      hasToc={toc.length > 0}
      {onClose}
      onToggleToc={() => (showToc = !showToc)}
      onToggleAnnotations={() => (showAnnotationsList = !showAnnotationsList)}
      onBookmarkPage={bookmarkCurrentPage}
      onIncreaseFontSize={increaseFontSize}
      onDecreaseFontSize={decreaseFontSize}
      onToggleFullscreen={toggleFullscreen}
      onMouseEnter={() => (headerVisible = true)}
      onMouseLeave={() => (headerVisible = false)}
    />
    {#if loading}
      <div class="loading">
        <div class="spinner"></div>
        <p>Loading book...</p>
      </div>
    {:else if error}
      <div class="error">
        <p>Error: {error}</p>
        <button onclick={onClose}>Go Back</button>
      </div>
    {:else}
      <div
        class="reader-container"
        class:pdf-mode={bookMetadata?.fileType === "pdf"}
        bind:this={readerContainer}
        role="region"
        aria-label="Book reader"
      ></div>
      {#if totalLocations > 0}
        <div class="progress-bar">
          <span>{Math.round((currentLocation / totalLocations) * 100)}%</span>
        </div>
      {/if}
    {/if}
  </div>
  {#if showAnnotationPanel}
    <AnnotationPanel
      {selectedText}
      bind:annotationNote
      bind:annotationColor
      onSave={createAnnotation}
      onClose={closeAnnotationPanel}
    />
  {/if}
  {#if showAnnotationsList}
    <AnnotationsList
      {annotations}
      onGoTo={handleGoToAnnotation}
      onDelete={deleteAnnotation}
      onClose={() => (showAnnotationsList = false)}
    />
  {/if}
  {#if showToc}
    <TableOfContents
      items={toc}
      onGoTo={handleGoToTocItem}
      onClose={() => (showToc = false)}
    />
  {/if}
</div>
{/if}

<style>
  .reader-wrapper {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    background: var(--bg);
    z-index: 1000;
    overscroll-behavior: none;
    touch-action: pan-x pan-y;
  }

  .reader-content {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  .reader-container {
    flex: 1;
    overflow: auto;
    position: relative;
    max-width: 900px;
    margin: 0 auto;
    width: 100%;
    padding: 2rem;
    overscroll-behavior: contain;
  }

  .reader-container.pdf-mode {
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
  }

  .loading,
  .error {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    color: var(--text-muted);
    padding-top: 4rem;
  }

  .spinner {
    width: 40px;
    height: 40px;
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .error button {
    padding: 0.65rem 1.25rem;
    background: var(--accent);
    color: white;
    border: none;
    border-radius: var(--radius);
    cursor: pointer;
    font-size: 0.95rem;
    font-family: inherit;
  }

  .error button:hover {
    background: var(--accent-hover);
  }

  .progress-bar {
    position: fixed;
    bottom: 1.5rem;
    right: 1.5rem;
    font-size: 0.85rem;
    color: var(--text-faint);
    z-index: 1001;
    font-variant-numeric: tabular-nums;
  }

  @media (max-width: 768px) {
    .reader-container {
      padding: 1rem;
    }
  }

  :global(.pdf-text-layer) {
    opacity: 0.2;
    line-height: 1;
    pointer-events: auto;
  }

  :global(.pdf-text-layer > span) {
    color: transparent;
    position: absolute;
    white-space: pre;
    pointer-events: all;
    transform-origin: 0 0;
  }

  :global(.pdf-text-layer ::selection) {
    background: var(--accent-soft);
  }

  :global(.pdf-text-layer ::-moz-selection) {
    background: var(--accent-soft);
  }
</style>
