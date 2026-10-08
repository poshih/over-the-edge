# Feature request: Workshop layout roadmap

**Date:** 2026-10-08 · **Baseline:** `3dfd83d` · **Status:** Stages A, B and D implemented; C planned.

**In short:** remove sideways navigation, let the Workshop grow, then use the width for navigation. Independently, pair fields rather than stretch sliders.
Compact remains complete. Wide is a browser-local layout preference, not project content; a narrow viewport may cap Wide below the navigation threshold.

Implement A, then B, then C; D is independent and may land at any point. Each stage includes its docs.
Remove this roadmap once all four stages have landed.

## Where the Workshop stands

- Tabs and section chips are horizontal scrollers (`src/editor/style.css:429-500`). Only chips translate the mouse
  wheel into sideways movement (`src/editor/workshop-section-bar.ts:184-205`); wrapping fixes the navigation itself.
- Desktop width is 354px, or 374px from 1600px; below 1040px the side panel uses `min(380px, 45vw)`, and portrait
  uses a full-width, 56dvh sheet (`src/editor/style.css:1-9,1254-1418`). The game already follows the panel's width.
- Built-in/plugin tabs share one DOM (`src/editor/workshop.html`, `src/editor/ui.ts:69-145`); the SDK has label-only tabs
  (`src/editor/workshop-sdk.ts:94-99`). `compact` is a viewport/pause policy (`src/editor/ui.ts:74`, `src/editor/main.ts:455,478`).
- Sticky headings and reveal use the pane's `.workshop-scroll`, including its spacer and measured heading inset
  (`src/editor/style.css:335-346,410-427`, `src/editor/workshop-section.ts:71-88`, `src/editor/workshop-search.ts:251-274`).
- Field layouts differ by editor: Level has field-unit grids, while Skeleton's bone form grids separate labels
  from inputs (`src/editor/level-editor.ts:469-480`, `src/editor/skeleton-editor.ts:337-350`). Do not blindly make every grid two-up.

## Rules every stage keeps

- **Run work only when something changes.** Do not add idle per-frame work. Reuse section-ID chips and observe only
  the active pane/panel. Work grows with tabs, selected sections, visible fields and drag frequency, so bound
  navigation height and coalesce scheduled updates (`AGENTS.md`, `src/editor/workshop-section-bar.ts:63-139`).
- **Accessible, complete navigation.** Keep DOM order, visible focus, named native buttons, tab/panel relationships
  and one roving Tab stop per tablist/toolbar. Mouse, keyboard and touch reach overflow vertically, never sideways.
- **Plugin parity.** Existing `addTab`, `addSection` and UI-kit groups are the extension points. Built-in and plugin
  navigation share layout, focus and lifecycle handling; no SDK change (`src/editor/workshop-sdk.ts:94-104,164-181`).
- **Editor-only, one owner.** Runtime imports no editor module. One editor module owns width, and CSS reflects it;
  preferences never enter saves/exports. Preserve the viewport-based pause policy.
- **Containment.** Panel and `.workshop-scroll` query containers (`container-type`) do not affect fixed-position UI that mounts outside them:
  the level overlay (`src/editor/level-editor.ts:721-740`, `src/editor/level-editor.css:284-292`) and directional guides
  (`src/editor/directional-editor.ts:337-348`, `src/editor/directional-editor.css:260-265`). Mount any new fixed-position Workshop UI outside a query container.
- **No dead code or compatibility.** Remove superseded scrolling, masks and width rules; no legacy preference readers.
  Unavailable or full storage (`DOMException`), invalid JSON (`SyntaxError`) and wrong-shape records only forget preferences, without notices.
  Reads use defaults (Compact for width); failed writes keep session state; all other errors propagate (`src/editor/workshop-section.ts:23-41,119-130`).
- **Docs and review.** Update README's “Finding Workshop controls” and plugin docs in each stage. Acceptance is code
  review only: no tests, fixtures, builds, typechecks, lint or application runs. Pixel budgets below are design choices, not measurements.

## Stage A: reach all navigation without sideways scrolling

**Outcome:** tabs wrap; a short section summary has an **All sections (N)** control opening the full, wrapped list.

**Requirements**
- Use equal-width, row-flow grid tabs with a 96px minimum track, bounded by available width. Prefer this to flex-wrap's
  uneven rows. Labels wrap, including unbroken plugin labels; selection changes colour, not size, order or row placement.
- Put tabs and the section bar in one `.workshop-navigation` vertical scroller, capped at 30% of panel height.
  Keep a visible vertical scrollbar and contain overscroll; normal wheel, scrollbar dragging and touch swipes reach every row.
- Collapse to a one-row current-chip summary (first if none current), retaining any focused chip. Only this row may ellipsize.
  All sections shows every full label wrapped, without fit-count measurement or an always-expanded list.
- All sections is a separate button with `aria-expanded` and `aria-controls`; N is the total section count.
  Expansion is session-only, initially collapsed on tab change/reopen. Collapsing returns focus to All sections before hiding chips.
- Declare horizontal orientation: Left/Right, Home/End follow DOM order across rows. Tabs auto-select; chips use Enter/Space.
  Chip arrows expand before hidden-entry focus; Escape in an expanded list collapses/focuses All sections, not the Workshop.
- Keep `aria-current="location"`, open styling, jumps and separate All/top/fold Tab stops. Navigation controls use
  `--control-height` as their minimum height: 37px, or 48px under `body.touch-controls` (`src/game-shell.css:17-26`).
  Follow the chips' existing touch-mode enlargement pattern (`src/editor/style.css:541-547`). Removed plugin entries
  focus a survivor or the selected tab; scroll-spy never hides focused chips or steals focus.
- Remove wheel-to-sideways, horizontal reveal, fades, constants and listeners. Reveal only within navigation, never page `scrollIntoView`.
  Spy auto-reveals only outside navigation focus; coalesce spy on selected-scroller resize/scroll/toggle and keep focused chips in view.

**Layouts:** desktop and small landscape keep their widths; portrait keeps its sheet. All use the bounded wrapping band.
Plugins share its grid/chips/observer; keep the fewer-than-two-sections bar policy (`src/editor/workshop-section-bar.ts:137`).

**Files**
- `src/editor/workshop.html`: navigation wrapper, named expander, controlled toolbar ID and explicit orientation.
- `src/editor/style.css`: wrapping grid/chips, collapsed summary, bounded vertical band, control heights; remove horizontal-only CSS.
- `src/editor/workshop-section-bar.ts`: expansion, visible roving stops, focus recovery, vertical reveal and selected-scroller observer.
- `src/editor/ui.ts`: tab focus reveal/removal handling and selected-tab focus callback for a disappearing section bar.
- `README.md`, `docs/workshop-plugins.md`: replace sideways-wheel instructions with wrapping, All sections and keyboard/touch access.

**Acceptance by reading**
- No navigation `overflow-x: auto`, `scrollLeft`, wheel interception or fade/reveal remnants; full labels and every entry have vertical access.
- Trace one Tab stop per widget, expansion before hidden-chip focus, collapse/removal recovery, native activation and all three layouts.
- Section jumps still focus summaries; top/fold operate on the selected pane; observers/queued frames stop on tab close/change and abort.

## Stage B: resize the side panel and remember it

**Outcome:** a **Wide** edge tab and inner-edge resize handle grow the panel and shrink the game; Stage A navigation remains complete.

**Requirements**
- Use a focusable vertical `role="separator"` on the panel's left edge, named “Workshop width”, controlling the panel.
  Use primary-pointer capture; the visible line has a 12px pointer hit area straddling the edge, widened to `var(--control-height)` under `body.touch-controls`.
  Set `touch-action: none` on the handle only. The Wide button and separator's keys provide equivalent non-drag alternatives.
  Keep the separator's help paragraph hidden and referenced by `aria-describedby`.
- Wide is a labelled `aria-pressed` button immediately after the separator, outside the header, centred vertically on the panel's
  left edge and protruding over the game rather than covering panel content. Stack it above the separator; it is at least 24px wide
  and `var(--control-height)` tall, with a >=3:1 focus ring and forced-colors support. Its aria-hidden chevron points left to widen,
  right to narrow. On restores the last expanded width (800px initially), off returns Compact; no double-click-only gesture.
  Keep the original desktop two-row header and below-1040px one-row header, including portrait, unchanged.
- Left grows the right-hand panel, Right shrinks it: 10px steps, Shift for 50px, Home for Compact, End requests the absolute
  960px maximum rather than remembering a viewport-limited value. A key whose resulting effective width and mode are unchanged
  changes and saves nothing. Maintain pixel `aria-valuenow/min/max`, orientation and readable value text.
  Wide is pressed and value text says Wide only while the effective width is above minimum; the remembered request is independent.
- Let V be the available CSS viewport width. Minimum is Compact: 354px desktop, 374px at >=1600px, or
  `min(380px, 0.45 * V)` for the small landscape panel. On desktop (V >=1040px), maximum is `min(960px, V - 480px)`;
  on small landscapes (V <1040px), maximum is `0.45 * V`. Clamp the 800px preset and every requested width to these bounds.
  Reserve at least 480px for desktop play; small landscapes retain at least 55% of V. Whenever maximum is not above minimum,
  hide Wide and the separator, moving focus to Close first if either had focus. Hide both in the portrait sheet as well.
- Set one effective root `--workshop-width` before opening. Move Compact's breakpoint policy into the width module;
  delete competing 1600px/mobile width rules. Side panel/game/chrome/toasts/notices share it; portrait's overrides stay.
- While open, width owns `body.dataset.gameChrome`: `compact` in the portrait sheet or below 686px of remaining game width,
  `plain` below 926px, absent otherwise. Those thresholds are the narrowest areas served by today's desktop chrome:
  1040px and 1280px viewports beside the 354px Compact panel. Write only changed values, including during drags;
  remove the attribute on close/disposal. Compact uses today's small-screen header/toolbar/help rules; both compact and plain
  hide the brand mark and signature and use a 12px header gap. Keep viewport-based `game-ui.css` and notice rules unchanged.
- Store only `{ mode: 'compact' | 'wide', wideWidth: number }` at `over-the-edge:workshop:width:v1`.
  Validate the exact shape and finite width in 354–960px; no migrations. Save on button/key actions and successful drag end,
  never per move. Dragging back to minimum chooses Compact, retaining the last expanded width for the next Wide action.
- Keep requested and effective width separate: viewport clamping must not overwrite the remembered request.
  A storage `DOMException`, parse `SyntaxError` or wrong-shape record only forgets the preference: use Compact on read
  failures and retain session state on write failures, without notices. Any other error propagates.
- Extract that read/write policy from `src/editor/workshop-section.ts:23-41,119-130` into shared editor helper
  `src/editor/layout-preference.ts`; both sections and width use it. Keep width-shape validation in `src/editor/workshop-width.ts`.
- Resize live, not on release; cache drag geometry/bounds and coalesce to one changed width write per animation frame.
  Dragging triggers CSS layout, selected-pane scroll-spy, a canvas rect read, a camera snap and renderer `setSize`, which may reallocate
  its buffer (`src/view.ts`). ResizeObserver validates the canvas size as before, throwing on zero size, and queues only a changed size;
  `render()` applies the latest pending size, snaps the camera and resizes the buffer before drawing, then clears the pending state.
  Initial constructor sizing stays immediate. Do not clear the buffer after a frame's render, add draws, or do resize work at unchanged sizes.
  Add no renderer, scene rebuild or idle loop; this source-reviewed cost path is unmeasured.
- Restore committed state and release capture on drag Escape, cancellation, lost capture, window blur, a move without the primary
  button, close, a side-panel/sheet switch or disposal. Consume drag Escape on window capture with `stopImmediatePropagation`,
  before game input and the level editor; the level editor leaves navigation and width-handle keys alone.
  Cancel frames, bind to UI abort and clear root styles and the body chrome attribute on HMR/disposal (`src/editor/ui.ts`, `src/editor/main.ts`).

**Layouts:** enable on desktop and landscape side panels; re-clamp on viewport changes, deferring work while closed.
Portrait remains full-width/56dvh: hide the handle and Wide button, retain the side-panel preference for rotation back.
Compact keeps today's header/chrome presentation: plain desktop chrome at 1040–1279px, full desktop chrome from 1280px,
and compact chrome for every small landscape and portrait sheet. Use `(width < 1040px)` to complement the desktop query at fractional widths.
Keep `WorkshopState.compact` unchanged. Plugins inherit the same mount width and Stage A navigation; no new plugin event or API.

**Files**
- `src/editor/layout-preference.ts` (new): one owner of disposable preference read/write handling.
- `src/editor/workshop-section.ts`: use the shared helper with remembered-sections behaviour unchanged.
- `src/editor/workshop-width.ts` (new): width policy and shape validation, pointer/key transactions, shared-helper persistence and cleanup.
- `src/editor/ui.ts`: initialise before first open, wire open/close/abort; do not reinterpret `compact` or change pause/play.
- `src/editor/workshop.html`: separator, its hidden help and Wide edge tab before the unchanged header.
- `src/editor/style.css`: handle/tab/focus/touch styling, one side-width variable, room-based chrome and complementary media queries;
  restore the original desktop and small-screen header layouts.
- `src/editor/level-editor.ts`: leave the width handle's keys to the width module, as for Workshop navigation.
- `src/view.ts`: validate/queue observed sizes and apply pending size before the next draw, keeping initial sizing immediate.
- `README.md`, `docs/workshop-plugins.md`: bounds, edge tab/drag/keys, browser-local remembering, no-room/portrait exclusion,
  compact game chrome and fluid plugin mounts.

**Acceptance by reading**
- Bounds always leave positive game width; every side-panel width/notice consumer shares the variable, and portrait overrides do not depend on it.
- Preference writes occur only at commit boundaries; resize/rotation does not save a clamped width; invalid/unavailable storage follows the stated failure path.
  No-op keys do not save, End remembers 960px, and pressed/value text reflects the effective width rather than the request.
- One shared helper owns the read/write policy; `src/editor/workshop-section.ts` keeps its remembered-sections behaviour.
  The width record's shape validation stays in `src/editor/workshop-width.ts`; no notice is added for disposable failures.
- Trace capture, cancellation, ARIA values, hidden/no-room focus recovery and HMR cleanup, including the body attribute;
  no idle RAF, runtime imports or pause-policy change. The edge tab cannot start a drag or cover panel content; original headers remain.
- Trace chrome thresholds against Compact's current layouts; resizing the drawing buffer happens before drawing, never in ResizeObserver,
  and unchanged canvas sizes trigger no resize work or extra draws. These are source-reviewed invariants, not measured runtime behaviour.

## Stage C: navigation column

**Outcome:** side panels at least 720px wide have navigation on the left and content on the right. This stage requires A and B.

**Requirements**
- Name the panel's inline-size container `workshop`; at 720px, a container query changes an inner `.workshop-layout`
  frame to grid areas: header across both columns, 176px navigation, remaining width for the selected pane and its footer.
  The frame is necessary because a container cannot query itself. Viewport queries only distinguish side panel from portrait sheet.
- Reuse Stage A's wrapper, tablist and toolbar: one vertical scroller, one full-label tab/chip per row, no duplicate DOM.
  Wide layout shows all chips and hides All sections. Narrowing preserves chip focus and expansion; widening moves
  expander focus to the current chip, or the first chip if none is current.
- CSS emits a navigation-orientation custom property; an open-panel ResizeObserver reads it to set both widgets'
  `aria-orientation` and keyboard axis. Vertical uses Up/Down, horizontal Left/Right; Home/End and activation stay unchanged.
  CSS owns the threshold, not a second JS pixel constant; abort disconnects the observer.
- Plugin tabs/sections use the same navigation; append plugin panes to the frame rather than the panel.

**Layouts:** desktop with a >=720px panel uses left navigation; capped Wide and small landscapes remain stacked under B's bounds.
Portrait keeps stacked navigation and no width controls. All navigation overflow remains vertical.

**Files**
- `src/editor/workshop.html`: frame around header/navigation/panes, retaining IDs, roles and DOM order.
- `src/editor/style.css`: panel query container, `.workshop-layout` frame and navigation styles.
- `src/editor/ui.ts`: append plugin panes to the frame, not the aside; CSS-derived orientation, tab keys/focus and observer disposal.
- `src/editor/workshop-section-bar.ts`: vertical toolbar keys/reveal, full-list Wide presentation and focus-safe return to Compact.
- `README.md`, `docs/workshop-plugins.md`: width-driven navigation and changed arrow axis.

**Acceptance by reading**
- One tablist, toolbar and pane per ID; plugin creation/removal targets the frame and never changes mount identity or visibility semantics.
- The 720px query, portrait exclusion, CSS-derived ARIA/keys and focus-safe transitions agree; navigation never needs horizontal scrolling.

## Stage D: paired fields

**Outcome:** fields pair when pane content is at least 560px wide. This stage is independent of A, B and C and may land
at any point; its effect appears with the full-width Workshop sheet on tablets in portrait.

**Compact decision:** layouts below 560px content width stay exactly as they are today. Grids that already show two or
more columns at compact widths are internal clusters of short related values, not candidates for pairing: retain their
markup, modifier classes, columns and viewport rules. This includes Level's `.level-field-grid` / `.level-action-row`
and their landscape restatement, Sprite's flipbook values, Directional's pivot values, and Skeleton's inline coordinate
and direction clusters, including their 700px viewport rules. The bone form is the exception: wrap its label/control
pairs as units, preserving its aligned label/control columns above a 700px viewport and stacking at or below 700px
when content is under 560px. At 560px content width or more, the bone form shows two units per row.

**Requirements**
- Use `.workshop-scroll` as the named `workshop-fields` container; one 560px query enables at most two atomic fields per row.
  Share an inherited/intrinsic policy with a 260px minimum cell and 720px maximum grid width; smaller/nested groups stay one-up.
  Cap single fields at 360px and help at 65ch. These are initial usability budgets, not measured comfort claims.
- Apply pairing only to field lists that are one-up today, plus the bone-form units above. Keep each label and control
  together as one field unit; help, status and actions span the grid. Do not turn range-step, bone-map, label/value,
  palette, action or other existing multi-column clusters into field grids. Preserve `.workshop-scroll`, its spacer,
  native details and sticky headings so search, `headingInset`, jumps and scroll-spy keep the same owners and coordinate system.
- Plugin tabs and sections share the field query. UI-kit `group` pairs range/select/toggle units; notes, buttons and unknown children span the group.
  Arbitrary plugin DOM remains plugin-owned; document fluid sizing, not a new SDK or hard-coded 354px assumption (`src/editor/workshop-ui-kit.ts:27-104`).

**Layouts:** when a tab's content is at least 560px wide, such as the full-width Workshop sheet on a tablet in portrait,
one-up field lists pair. Groups too narrow for two 260px cells stay one-up; compact desktop and side-panel layouts are unchanged.

**Files**
- `src/editor/style.css`: scroller query, shared column policy and caps; pair Physics range groups and Appearance alignment/arm-IK groups.
- `src/editor/level-editor.css`: preserve `.level-field-grid`, its landscape restatement and action/palette layouts; no column changes.
- `src/editor/character-editor.css`: pair arm-length, grip, grip-range and grip-rotation control containers.
- `src/editor/sprite-editor.css`: pair layer-transform ranges; preserve flipbook columns and the flat label/input layer form.
- `src/editor/directional-editor.css`: share single-field caps; preserve pivot columns, label/input internals, readouts and the direction table.
- `src/editor/skeleton-editor.ts`: wrap bone-form label/input pairs as units, retaining every control ID, label association and inline-grid modifier class.
- `src/editor/skeleton-editor.css`: pair bone-form units, using shared compact tracks (for example, subgrid); preserve inline/direction,
  action and other internal grids and their 700px viewport rules.
- `src/editor/project-editor.css`: adapt `.project-fields` as units, not clip/media records or their internal columns.
- `src/editor/workshop-plugins.css`: adaptive UI-kit groups, full-row non-fields and spacing; SDK/host contracts stay unchanged.
- `README.md`, `docs/workshop-plugins.md`: field pairing and existing `host.ui.group` usage.

**Acceptance by reading**
- The 560px field policy acts on atomic pairs in the one-up lists and bone form, not viewport width or internal grids;
  trace search/spy through unchanged scrollers. Below 560px content width, layouts are unchanged, including aligned compact
  bone-form tracks, stacked bone fields at or below a 700px viewport, and existing multi-column clusters and viewport rules.
- Trace shared column policy/caps and one-up smaller/nested groups; UI-kit pairs range/select/toggle units, with non-fields spanning.

## Not planned

- **Maximise sprite, skeleton or outline editors over the game view.** Revisit only if those editors still feel cramped at Wide.
- **Pop-out window.** Revisit for a demonstrated separate-window authoring workflow, not as an overflow workaround.
- **Plugin icons or contract changes.** Labels and current places suffice here; revisit only for a separately approved plugin-API need.
- **Portrait sheet resizing or two-pane navigation.** Revisit after tablet feedback shows the full-width sheet and adaptive fields are insufficient.
- **Specialist table/canvas redesign.** This is sideways-scroll-free navigation, not all content: the direction table keeps its
  horizontal region (`src/editor/directional-editor.css:221-258`). Revisit if Wide still leaves that editor hard to use.

## Open questions

None.

## Context

The owner reported: “workshop side bar need expanded mode, it have too much and there is no way to scroll side way”.
