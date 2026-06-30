/**
 * Home view (fe-home-redesign): the idle landing layout from the shell
 * mockup — a hero record button, three entry capsules (quick voice / record
 * meeting / import file), an enhance hint, and up to three recent-item
 * cards. Structure + classes only; CSS lands in a later task.
 *
 * `setEntriesDisabled` is the seam the sibling recording-layer module calls
 * to grey out the recording entry points (hero, quick, import — never the
 * meeting capsule) while a recording is in flight.
 */

import { t } from "../i18n";
import { itemDisplayTitle, type Item } from "../library/items";
import type { View } from "../routing/view-route";
import { deriveStats, renderSparkline } from "./home-stats";

export interface HomeViewDeps {
  /** `full` shows the recent + activity dashboard rows and the ⌥Space hint;
   *  `compact` omits the heavy rows and foregrounds the capture entry. */
  homeDensity: "full" | "compact";
  listItems: () => Promise<Item[]>;
  navigateToView: (v: View) => void;
  onHeroStart: () => void;
  onQuickStart: () => void;
  onImportPick: () => void;
  onMeeting: () => void;
  /** Current live-captions preference (drives the toggle's checked state). */
  liveCaptionsEnabled: boolean;
  /** Flip the live-captions preference from the home capture entry. */
  onLiveCaptionsToggle: (on: boolean) => void;
  /** Injectable clock for the activity stats (tests); defaults to Date.now. */
  now?: () => number;
}

export interface HomeViewHandle {
  element: HTMLElement;
  setEntriesDisabled(disabled: boolean, title?: string): void;
  /** Re-pull items and re-render the recent + activity rows (full density). */
  refresh(): void;
  destroy(): void;
}

const RECENT_LIMIT = 3;

function capsule(label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cap";
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

function cardTitle(item: Item): string {
  return itemDisplayTitle(item);
}

function metaLineText(item: Item): string {
  const date = new Date(item.createdAt).toLocaleDateString();
  if (item.durationMs == null) return date;
  const minutes = Math.max(1, Math.round(item.durationMs / 60_000));
  return `${date} · ${minutes}m`;
}

function cardEl(item: Item, navigate: (v: View) => void): HTMLElement {
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.itemId = item.id;

  const meta = document.createElement("div");
  meta.className = "meta";
  if (item.category) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = item.category;
    meta.appendChild(badge);
  }
  if (item.project) {
    const proj = document.createElement("span");
    proj.className = "badge proj";
    proj.textContent = `📂 ${item.project}`;
    meta.appendChild(proj);
  }
  if (item.starred) {
    const star = document.createElement("span");
    star.className = "star";
    star.textContent = "⭐";
    meta.appendChild(star);
  }

  const title = document.createElement("b");
  title.textContent = cardTitle(item);

  const metaLine = document.createElement("p");
  metaLine.className = "meta-line";
  metaLine.textContent = metaLineText(item);

  card.append(meta, title, metaLine);
  card.addEventListener("click", () =>
    navigate({ name: "detail", itemId: item.id }),
  );
  return card;
}

function recentSection(
  items: Item[],
  navigate: (v: View) => void,
): HTMLElement[] {
  const rowTitle = document.createElement("div");
  rowTitle.className = "row-title";
  const heading = document.createElement("h3");
  heading.textContent = t("home.recentTitle");
  const showAll = document.createElement("a");
  showAll.textContent = t("home.showAll");
  showAll.addEventListener("click", () => navigate({ name: "library" }));
  rowTitle.append(heading, showAll);

  const cards = document.createElement("div");
  cards.className = "cards";
  for (const item of items.slice(0, RECENT_LIMIT)) {
    cards.appendChild(cardEl(item, navigate));
  }
  return [rowTitle, cards];
}

/** "<1" reads more honestly than a rounded-down 0 for sub-minute totals. */
function fmtMinutes(mins: number): string {
  return mins > 0 && mins < 1 ? "<1" : String(Math.round(mins));
}

function statCard(icon: string, value: string, label: string): HTMLElement {
  const card = document.createElement("div");
  card.className = "stat-card";
  const ic = document.createElement("span");
  ic.className = "ic";
  ic.textContent = icon;
  const big = document.createElement("b");
  big.textContent = value;
  const cap = document.createElement("span");
  cap.className = "cap-label";
  cap.textContent = label;
  card.append(ic, big, cap);
  return card;
}

/** Activity dashboard (fe-home-dashboard, VoiceInk-style per user feedback):
 *  a weekly banner, 4 stat cards, and the 14-day sparkline — derived from the
 *  same items array the recent cards use. Zero items → empty hint. */
function activitySection(items: Item[], now: () => number): HTMLElement {
  const section = document.createElement("section");
  section.className = "activity";

  const rowTitle = document.createElement("div");
  rowTitle.className = "row-title";
  const heading = document.createElement("h3");
  heading.textContent = t("home.activityTitle");
  rowTitle.appendChild(heading);
  section.appendChild(rowTitle);

  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "activity-empty";
    empty.textContent = t("home.activityEmpty");
    section.appendChild(empty);
    return section;
  }

  const stats = deriveStats(items, now);
  const totalMinutes = items.reduce(
    (sum, i) => sum + (i.durationMs ?? 0) / 60_000,
    0,
  );

  const banner = document.createElement("div");
  banner.className = "stat-banner";
  banner.textContent = t("home.banner", {
    m: fmtMinutes(stats.minutesThisWeek),
    n: String(stats.itemsThisWeek),
  });
  section.appendChild(banner);

  const cards = document.createElement("div");
  cards.className = "stat-cards";
  cards.append(
    statCard("🎙️", String(stats.itemsThisWeek), t("home.cardItemsWeek")),
    statCard("⏱️", fmtMinutes(stats.minutesThisWeek), t("home.cardMinutesWeek")),
    statCard("📚", String(stats.totalItems), t("home.cardTotalItems")),
    statCard("🕰️", fmtMinutes(totalMinutes), t("home.cardTotalMinutes")),
  );
  section.appendChild(cards);

  const canvas = document.createElement("canvas");
  canvas.className = "sparkline";
  canvas.width = 280;
  canvas.height = 48;
  section.appendChild(canvas);
  renderSparkline(canvas, stats.perDayMinutes);

  return section;
}

export function mountHomeView(
  container: HTMLElement,
  deps: HomeViewDeps,
): HomeViewHandle {
  const root = document.createElement("div");
  root.className = "home-view";

  const hero = document.createElement("section");
  hero.className = "hero";

  const recBtn = document.createElement("button");
  recBtn.type = "button";
  recBtn.className = "rec-btn";
  recBtn.setAttribute("aria-label", t("home.heroAria"));
  recBtn.appendChild(document.createElement("i"));
  recBtn.addEventListener("click", () => deps.onHeroStart());

  const heading = document.createElement("h2");
  heading.textContent = t("home.heroTitle");
  const subtitle = document.createElement("p");
  subtitle.textContent = t("home.heroSubtitle");

  const capsRow = document.createElement("div");
  capsRow.className = "caps";
  const quickCap = capsule(`⚡ ${t("home.capQuick")}`, () =>
    deps.onQuickStart(),
  );
  if (deps.homeDensity === "full") {
    const kbd = document.createElement("kbd");
    kbd.textContent = "⌥Space";
    quickCap.appendChild(kbd);
  }
  const meetingCap = capsule(`🖥️ ${t("home.capMeeting")}`, () =>
    deps.onMeeting(),
  );
  const importCap = capsule(`📄 ${t("home.capImport")}`, () =>
    deps.onImportPick(),
  );
  capsRow.append(quickCap, meetingCap, importCap);

  // Live-captions toggle: the single capture model drives captions off a
  // toggle (not a separate live-vs-batch mode button). Flipping it persists the
  // preference; main.ts also reflects it on the recbar mid-recording.
  const liveToggleWrap = document.createElement("label");
  liveToggleWrap.className = "home-live-toggle";
  const liveToggleInput = document.createElement("input");
  liveToggleInput.type = "checkbox";
  liveToggleInput.className = "live-toggle-input";
  liveToggleInput.checked = deps.liveCaptionsEnabled;
  const liveToggleLabel = document.createElement("span");
  liveToggleLabel.textContent = t("rec.liveCaptions");
  liveToggleWrap.append(liveToggleInput, liveToggleLabel);
  liveToggleInput.addEventListener("change", () =>
    deps.onLiveCaptionsToggle(liveToggleInput.checked),
  );

  const enh = document.createElement("p");
  enh.className = "enh";
  enh.textContent = t("home.enhanceHint");

  hero.append(recBtn, heading, subtitle, capsRow, liveToggleWrap, enh);
  root.appendChild(hero);
  container.appendChild(root);

  let destroyed = false;

  // Hero renders synchronously. In `full` density the recent cards + activity
  // dashboard fill in when the items resolve (ONE list read feeds both): an
  // empty list renders the activity empty hint and no recent section; a
  // rejected fetch renders neither — the rest of Home stays functional either
  // way. `compact` omits both rows (and skips the fetch entirely) so the
  // capture-first web home stays light. `renderDashboard` is re-runnable so a
  // landed capture / deletion refreshes the rows in place (no remount).
  function renderDashboard(): void {
    if (deps.homeDensity !== "full") return;
    deps
      .listItems()
      .then((items) => {
        if (destroyed) return;
        // Clear any previously-rendered rows so a refresh replaces, not stacks.
        root
          .querySelectorAll(".row-title, .cards, .activity")
          .forEach((el) => el.remove());
        if (items.length > 0) {
          root.append(...recentSection(items, deps.navigateToView));
        }
        root.appendChild(activitySection(items, deps.now ?? Date.now));
      })
      .catch(() => {
        // Recent + activity are best-effort; Home works without them.
      });
  }
  renderDashboard();

  const entryButtons = [recBtn, quickCap, importCap];

  return {
    element: root,
    setEntriesDisabled(disabled: boolean, title?: string): void {
      for (const btn of entryButtons) {
        btn.disabled = disabled;
        if (disabled && title !== undefined) btn.setAttribute("title", title);
        else btn.removeAttribute("title");
      }
    },
    /** Re-pull items and re-render the recent + activity rows in place. */
    refresh(): void {
      renderDashboard();
    },
    destroy(): void {
      destroyed = true;
      root.remove();
    },
  };
}
