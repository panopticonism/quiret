<script>
  import { onMount } from "svelte";
  import Library from "./components/Library.svelte";
  import Reader from "./components/Reader.svelte";

  let currentView = $state("library");
  let selectedBookId = $state(null);
  let libraryScroll = $state(0);

  onMount(() => {
    updateFromURL();

    window.addEventListener("popstate", updateFromURL);

    return () => {
      window.removeEventListener("popstate", updateFromURL);
    };
  });

  const updateFromURL = () => {
    const path = window.location.pathname;
    const match = path.match(/^\/book\/([^\/]+)$/);

    if (match) {
      selectedBookId = match[1];
      currentView = "reader";
    } else {
      currentView = "library";
      selectedBookId = null;
    }
  };

  const openBook = (bookId) => {
    libraryScroll = window.scrollY;
    selectedBookId = bookId;
    currentView = "reader";
    window.history.pushState({}, "", `/book/${bookId}`);
  };

  const closeReader = () => {
    currentView = "library";
    selectedBookId = null;
    window.history.pushState({}, "", "/");
  };
</script>

{#if currentView === "library"}
  <Library onOpenBook={openBook} initialScroll={libraryScroll} />
{:else if currentView === "reader"}
  <Reader bookId={selectedBookId} onClose={closeReader} />
{/if}
