# Testing

```bash
npm run typecheck   # tsc --noEmit, strict
npm test            # Vitest
npm run test:e2e    # Playwright
npm run test:all    # all three
```

Both suites are green at the time of writing: **201 unit tests** and **238
end-to-end tests** across four viewport profiles.

## Unit tests (Vitest)

Pure-logic tests run under Node; the two that need `localStorage` or a DOM use
the `*.dom.test.ts` suffix and run under jsdom.

| File                             | Covers                                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `game/hex.test.ts`               | Neighbours, distance metric, rings, hexagon construction, axial↔offset round-trip, pixel spacing            |
| `game/board.test.ts`             | Row/column labelling, adjacency built from coordinates, obstacle handling, layout validation, symmetry      |
| `game/moves.test.ts`             | Clone and jump detection, illegal moves, conversion sets, apply/undo symmetry, opening-move balance         |
| `game/rules.test.ts`             | Validation rejections, immutability, turn hand-off, skipped turns, every end condition, ties, full playouts  |
| `game/scoring.test.ts`           | Score = pieces on board, per-move gain/loss accounting, invariants over whole matches                        |
| `game/game-state.test.ts`        | Save round-trip, version/layout/tamper rejection, corrupt payload sanitising                                 |
| `game/game-controller.dom.test.ts` | Selection, mis-tap handling, undo policy, AI turn scheduling, persistence and resume                       |
| `ai/ai.test.ts`                  | Legality across full playouts on all layouts and difficulties, time budgets, determinism, strength ordering  |
| `ui/sound-controller.test.ts`    | Every method is a safe no-op with no Web Audio, hostile stubs, rate limiting, volume clamping                |
| `ui/music-controller.test.ts`    | Scene changes and cross-fades, scheduler lifecycle, node-leak bounds, determinism, safe no-ops with no Web Audio |
| `pwa/*.test.ts`                  | Service-worker template contract, precache manifest, registration behaviour                                  |

Two of these are property-style rather than example-based: `rules.test.ts` plays
random matches to completion on all three layouts and asserts after every move
that scores equal the piece count, that the current player always has a legal
move, and that the match only ends for a valid reason; `ai.test.ts` does the
same while driving the opponent.

## End-to-end tests (Playwright)

Four projects, all Chromium: `mobile-portrait` (Pixel 7), `mobile-small`
(iPhone SE metrics, 320×568), `tablet` (iPad gen 7) and `desktop-chrome`. The
touch projects drive the game with real taps; desktop uses clicks, through the
`press()` helper — the same specs run both ways.

| Spec                   | Covers                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `gameplay.spec.ts`     | Menu → match, board choice, selection and cancellation, clone, jump, conversion, a whole match to a result, restart confirmation, pause, difficulty, local two-player |
| `mobile.spec.ts`       | No horizontal scroll, touch-target sizes, controls inside the safe area, rotation preserving the match, no accidental zoom/selection/scroll, taps in the seam between hexes, taps outside the board |
| `accessibility.spec.ts`| Cell labels, named move types, grid roles, live-region announcements, arrow-key navigation, Escape, `R`-to-restart confirmation, roving tabindex, dialog focus trapping, reduced motion, high contrast, coordinate labels |
| `tutorial.spec.ts`     | Each lesson advances by doing the thing it teaches; Next/Back/Skip                               |
| `pwa.spec.ts`          | Manifest validity, every icon served and non-trivial, theme colour, service worker registration, full offline reload and offline play against the computer |
| `title.spec.ts`        | Crest, wordmark and backdrop render; the backdrop is deterministic and decorative-only; reduced motion removes every decorative animation; the boot-failure notice stays hidden on a healthy start; music toggling, persistence and independent volume |
| `persistence.spec.ts`  | Resuming an interrupted match from the menu and across a reload, starting fresh discarding the save, preferences surviving a reload, sound toggling, statistics and reset, board previews |

Deep links make setup deterministic: `?start=1&board=islands&mode=local-two-player&motion=reduced&seed=42`.

### Running against a pre-installed browser

If the image ships a Chromium build that does not match this Playwright
revision, point at it instead of downloading:

```bash
PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e
```

## Manual cross-browser checklist

Automation covers Chromium only. Before release, run this by hand:

- [ ] iOS Safari, small iPhone (SE class) — portrait and landscape
- [ ] iOS Safari, large iPhone with a notch or Dynamic Island — check the status
      bar and the bottom home indicator never overlap the board or the controls
- [ ] iPadOS Safari — split view and Slide Over
- [ ] Android Chrome, phone and tablet
- [ ] Desktop Safari, Firefox, Edge
- [ ] VoiceOver (iOS) and TalkBack (Android): swipe through the board, confirm
      each space is announced with its position and state, and that turn changes
      and results are read out
- [ ] Install to home screen on iOS and Android, then play with the device in
      aeroplane mode
- [ ] System reduced-motion and increased-contrast settings
- [ ] Text scaling at 200%

## Defects this suite has already caught

Kept as a record of what the tests are actually worth:

1. **Offline play silently failed.** The service worker matched precached assets
   without `ignoreVary`, and any server sending `Vary: Origin` — Vite's own
   preview server does — turned every precache entry into a miss. Guarded now by
   both `pwa.spec.ts` and a unit test on the worker template.
2. **Screen readers only heard the last announcement.** A move and the following
   turn change wrote to the same live region in the same tick. Messages raised
   together are now coalesced into one utterance.
3. **The board overflowed the viewport on short, wide screens.** An SVG with a
   `viewBox` is a replaced element with an intrinsic ratio, so its automatic grid
   minimum size beat `height: 100%`.
4. **GitHub Pages published the raw source.** The Pages workflow used
   `jekyll-build-pages` with `source: ./`, which copies the repository as-is —
   Jekyll does not run Vite and cannot compile TypeScript, so visitors got an
   unstyled page with no game on it. Replaced with a workflow that installs,
   type-checks, tests, builds and publishes `dist/`. The built output was
   verified serving from a project sub-path.
5. **The whole page could render unstyled.** The stylesheet was imported from
   `src/main.ts`, so anything that stopped the module graph — most easily,
   opening the source folder instead of a build — took the styling down with it
   and left raw browser defaults on screen. The stylesheet is now linked from
   the HTML, and an inline watchdog explains the failure instead of leaving a
   half-rendered page. Covered by `title.spec.ts`.
6. **"Resume match" showed on a fresh install.** The user-agent
   `[hidden] { display: none }` rule is a bare attribute selector, so
   `.btn { display: inline-flex }` beat it. The attribute is now authoritative
   for every component.
