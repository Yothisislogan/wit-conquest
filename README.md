# Monster Territory

A mobile-first hexagonal territory strategy game that runs in the browser. Pick a
monster, clone it next door or jump it two spaces, and every enemy touching where
you land joins your team. Whoever holds the most spaces when nobody can move wins.

Matches run two to five minutes, the whole game is playable with one thumb, and
once it has loaded it works with no network at all.

> **Working title.** "Monster Territory" is the project name until final branding
> is chosen. See [`docs/ORIGINALITY.md`](docs/ORIGINALITY.md) for the provenance
> of every asset in this repository.

---

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
```

| Script                | What it does                                            |
| --------------------- | ------------------------------------------------------- |
| `npm run dev`         | Vite dev server, exposed on the LAN for phone testing    |
| `npm run build`       | Type-checks, then builds to `dist/` (service worker too) |
| `npm run preview`     | Serves the production build on port 4173                 |
| `npm run typecheck`   | `tsc --noEmit`                                           |
| `npm test`            | Vitest unit suite                                        |
| `npm run test:e2e`    | Playwright, four viewport profiles                       |
| `npm run test:all`    | Type-check, unit tests, end-to-end tests                 |
| `node scripts/generate-icons.mjs` | Regenerates the PWA icons from code         |

Deploy by serving `dist/` as static files. `base` is `./`, so a sub-path such as
`https://example.com/games/monsters/` works without reconfiguration.

---

## How the game works

**The board.** A regular hexagon of 61 spaces, some of them obstacles. Three
layouts ship: **Classic** (open, six standing stones), **Crossroads** (a blocked
hub with spokes and six approach lanes) and **Islands** (three bands joined by
narrow corridors). Every layout is 180°-rotationally symmetric, so neither side
starts with an advantage.

**The two moves.**

- **Clone** — move to an empty space one step away. Your monster stays and a copy
  appears. Marked on the board with a solid dot.
- **Jump** — move to an empty space exactly two steps away. The space you left
  becomes empty. Marked with a hollow ring. Jumps ignore whatever lies between.

**Conversion.** After landing, every opposing monster directly adjacent to the
destination flips to the mover.

**Ending.** A player with no legal move is skipped and the other keeps playing.
The match ends when neither can move, when the board fills, or when a player is
wiped out. Highest piece count wins; ties are a real result. Scores are always a
straight count of the monsters on the board.

---

## Architecture

Game rules are completely separate from rendering. Nothing under `src/game/`
imports the DOM, which is what lets the same code run in a Web Worker, in Node
under Vitest, and in the browser.

```
src/
  game/          rules engine — hex maths, board compilation, moves,
                 scoring, immutable state transitions, match controller
  ai/            local opponent — evaluation, alpha-beta search,
                 three difficulties, Web Worker host and client
  ui/            SVG renderer, pointer input, screens, monsters,
                 animation and the runtime-synthesised sound engine
  accessibility/ live-region announcements, keyboard grid navigation
  data/          board layouts, preferences, statistics, analytics
  pwa/           service worker template and registration
  styles/        one stylesheet, driven by design tokens
e2e/             Playwright specs
scripts/         icon generator (hand-rolled PNG encoder, no deps)
```

**Coordinates.** Axial (`q`, `r`) over flat-top hexes. Pixel positions are
derived from coordinates; adjacency is never inferred from screen distance.
Flat-top is a deliberate mobile choice — a hexagonal board drawn flat-top is
taller than it is wide, which is the shape a phone actually has, and it makes
every tile about a quarter larger than the pointy-top equivalent.

**Rendering.** SVG rather than canvas, because every space has to be a real,
labelled, focusable node for screen readers and keyboard play. The whole board is
one `<svg>` with a `viewBox`, so it scales to any viewport without re-layout and
can never overflow the screen.

**Validation.** `rules.ts` is the only place a board state changes. `applyMove`
validates first and returns a new state; there is no way for the UI to construct
an illegal position, and the AI's chosen move is re-checked against the legal
move list before it is played.

---

## Touch design

- Taps resolve to the **nearest space**, not to whatever element the finger
  landed on, so there are no dead gaps between hexes.
- When a monster is selected, a tap near a highlighted destination **snaps** to
  it, which is the single most effective mis-tap guard on a small screen.
- Activation happens on pointer *up*, and only if the finger barely moved.
- Tiles are at least 44 CSS px wide on every supported phone, including a 320px
  iPhone SE, and at least 44px tall from 360px up.
- Tapping your monster again cancels; tapping a different one re-selects; taps on
  unreachable spaces are ignored and never cost a turn.
- `touch-action: manipulation` kills double-tap zoom without disabling pinch
  zoom, which accessibility needs.

---

## The computer opponent

Entirely local — no external service. `src/ai/`:

- **Easy** — mostly random legal moves, prefers a conversion when one exists, and
  deliberately blunders often enough to be beatable by a first-time player.
- **Normal** — 3-ply search weighing material, conversions, mobility, position
  and the risk of a large counter-conversion on the reply.
- **Hard** — iterative-deepening alpha-beta with move ordering, killer moves and
  a hard wall-clock budget (1.1s on mobile, 1.5s on desktop). Reaches depth 5–8
  in the middlegame.

The search runs in a Web Worker, so the board never freezes; a "Thinking…"
indicator shows while it works, and there is a synchronous fallback for browsers
without workers.

---

## Accessibility

- Every space is a `gridcell` with a label like *"Row 3, column 4. Empty space.
  Valid clone move."*
- Turn changes, moves, conversions, skipped turns and results are announced
  through live regions. Messages raised in the same tick are coalesced so a
  screen reader hears all of them, not just the last.
- Roving-tabindex keyboard grid: arrows move focus, <kbd>Enter</kbd>/<kbd>Space</kbd>
  select, <kbd>Esc</kbd> cancels, <kbd>R</kbd> restarts after confirmation.
- Clone and jump destinations differ by **shape** (filled disc vs hollow ring),
  not only colour; the two teams differ by silhouette as well as hue.
- Reduced-motion and high-contrast settings, plus automatic honouring of
  `prefers-reduced-motion` and `forced-colors`.
- Dialogs trap focus and restore it on close.

---

## Offline

A hand-written service worker (`src/pwa/sw-template.js`) precaches the build,
serves navigations network-first with a cached shell fallback and assets
cache-first. It never calls `skipWaiting()` on its own, so a new version cannot
swap the page out mid-match — the player gets a "Reload" prompt instead.

Installable from the browser with a maskable icon set generated by
`scripts/generate-icons.mjs`, which rasterises the artwork and encodes real PNGs
using nothing but `node:zlib`.

---

## Privacy

No account, no server, no personal data. `localStorage` holds preferences,
aggregate win/loss counters and the board of an in-progress match. Analytics are
anonymous local counters (match started, completed, board chosen, duration
*bucket*) with a pluggable sink that is off by default.

---

## Testing

See [`docs/TESTING.md`](docs/TESTING.md) for coverage, the manual cross-browser
checklist and how to run the suites.
