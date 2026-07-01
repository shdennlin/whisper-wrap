/**
 * Library view (fe-item-library, simplified after VoiceInk's History).
 *
 * One flat, newest-first list of every item. Each row leads with the
 * transcript preview (the content), with the timestamp as a muted sub-line and
 * a chevron — no emoji thumbs, kind labels, durations, category segments, or
 * quick/full split. A search box filters by transcript/title text; a star
 * toggle (also driven by the sidebar ⭐ entry) narrows to favourites.
 *
 * Rows route to Item Detail; the star toggle persists via the item-metadata
 * PATCH. Mounted into the app-shell's view container.
 */

import { itemDisplayTitle, listItems, type Item } from "../library/items";
import { navigateToView } from "../routing/view-route";
import { patchSession } from "../storage/history-api-client";
import { patchMeetingMeta } from "../meeting/meeting-history-api";
import { t } from "../i18n";

export interface LibraryDeps {
  /** Item source — overridable for tests. */
  load?: () => Promise<Item[]>;
  /** Persist a star toggle — overridable for tests. */
  toggleStar?: (item: Item, starred: boolean) => Promise<void>;
  /** Open with the star filter pre-applied (sidebar ⭐ entry). */
  initialStarred?: boolean;
}

async function defaultToggleStar(item: Item, starred: boolean): Promise<void> {
  if (item.kind === "session") await patchSession(item.id, { starred });
  else await patchMeetingMeta(item.id, { starred });
}

/** createdAt is unix-ish — treat small values as seconds, large as millis. */
function toDate(createdAt: number): Date {
  return new Date(createdAt < 1e12 ? createdAt * 1000 : createdAt);
}

/** "6/26 15:38" — the muted timestamp sub-line. */
function fmtDateTime(createdAt: number): string {
  const d = toDate(createdAt);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

/** The row's main text: the transcript preview, falling back to the display
 *  title (meetings have a filename, untitled captures get a time label). */
function rowText(it: Item): string {
  return it.preview || itemDisplayTitle(it);
}

export async function renderLibrary(
  container: HTMLElement,
  deps: LibraryDeps = {},
): Promise<void> {
  const load = deps.load ?? (() => listItems());
  const toggleStar = deps.toggleStar ?? defaultToggleStar;

  container.replaceChildren();
  container.classList.add("library-view");

  const searchBar = document.createElement("div");
  searchBar.className = "library-search";
  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.className = "library-search-input";
  searchInput.placeholder = t("library.searchPlaceholder");
  const starFilter = document.createElement("button");
  starFilter.type = "button";
  starFilter.className = "library-starfilter";
  searchBar.append(searchInput, starFilter);

  const list = document.createElement("div");
  list.className = "library-list";
  container.append(searchBar, list);

  let items = await load();
  let query = "";
  let starredOnly = deps.initialStarred ?? false;

  function visible(): Item[] {
    const q = query.trim().toLowerCase();
    return items.filter(
      (it) =>
        (!starredOnly || it.starred) &&
        (q === "" ||
          rowText(it).toLowerCase().includes(q) ||
          (it.title ?? "").toLowerCase().includes(q)),
    );
  }

  function starEl(it: Item): HTMLElement {
    const star = document.createElement("span");
    star.className = "library-star lib-row-star";
    const paint = (on: boolean) => {
      star.classList.toggle("on", on);
      star.textContent = on ? "★" : "☆";
    };
    paint(it.starred);
    star.addEventListener("click", async (e) => {
      e.stopPropagation();
      const next = !it.starred;
      it.starred = next;
      paint(next);
      try {
        await toggleStar(it, next);
      } catch {
        it.starred = !next;
        paint(!next);
      }
    });
    return star;
  }

  /** One clean row: [time / transcript] + star + chevron. */
  function rowEl(it: Item): HTMLElement {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "lib-row";
    row.dataset.itemId = it.id;
    row.dataset.kind = it.kind;

    const body = document.createElement("div");
    body.className = "lib-row-body";
    const time = document.createElement("div");
    time.className = "lib-row-time";
    time.textContent = fmtDateTime(it.createdAt);
    const text = document.createElement("div");
    text.className = "lib-row-text";
    text.textContent = rowText(it);
    body.append(time, text);

    const chev = document.createElement("span");
    chev.className = "lib-row-chev";
    chev.textContent = "›";

    row.append(body, starEl(it), chev);
    row.addEventListener("click", () =>
      navigateToView({ name: "detail", itemId: it.id }),
    );
    return row;
  }

  function renderList(): void {
    list.replaceChildren();
    const vis = visible();
    if (vis.length === 0) {
      const empty = document.createElement("div");
      empty.className = "library-empty";
      empty.textContent = query.trim() ? t("library.noMatch") : t("library.empty");
      list.appendChild(empty);
      return;
    }
    for (const it of vis) list.appendChild(rowEl(it));
  }

  function paintStarFilter(): void {
    starFilter.classList.toggle("on", starredOnly);
    starFilter.textContent = t("library.starred");
  }

  searchInput.addEventListener("input", () => {
    query = searchInput.value;
    renderList();
  });
  starFilter.addEventListener("click", () => {
    starredOnly = !starredOnly;
    paintStarFilter();
    renderList();
  });

  paintStarFilter();
  renderList();
}
