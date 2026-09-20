# Property Panel UI Refactor Plan

## Background

The current property panel UI diverges noticeably from the `attr-ui.html` design mockup. This document lays out the refactor work in detail, ordered from highest to lowest priority, with the goal of bringing the panel's visuals and interactions in line with the mockup.

### Reference Files

- **Design mockup**: `/attr-ui.html`
- **Current styles**: `ui/shadow-host.ts`
- **Panel structure**: `ui/property-panel/property-panel.ts`
- **Control components**: `ui/property-panel/controls/*.ts`

---

## Prerequisite Tasks (Done)

### 0.1 Minimize Bug Fix ✅

**Problem**: When the toolbar and property panel are minimized, only the background disappears — the inner content is actually still there.

**Root cause**: The CSS `display: flex/inline-flex` overrides the default `display: none` that the `[hidden]` attribute provides.

**Solution**:

- [x] Add a global `[hidden] { display: none !important; }` rule at the end of `shadow-host.ts`

### 0.2 Input Field Improvements ✅

**Problems**:

1. Inputs show the placeholder instead of the real value
2. Number inputs don't support keyboard up/down adjustment

**Solution**:

- [x] Create the `ui/property-panel/controls/number-stepping.ts` utility module
  - Supports ArrowUp/ArrowDown keyboard stepping
  - Supports Shift (10x) and Alt (0.1x) modifier keys
  - Supports multiple CSS units (px, %, rem, em, vh, vw, vmin, vmax)
- [x] Update all controls to show the real value (inline first, fallback to computed)
- [x] Add keyboard stepping support to all numeric inputs:
  - `size-control.ts` - Width/Height
  - `spacing-control.ts` - Margin/Padding
  - `position-control.ts` - Top/Right/Bottom/Left/Z-Index
  - `layout-control.ts` - Gap
  - `typography-control.ts` - Font Size/Line Height
  - `appearance-control.ts` - Opacity/Border Radius/Border Width

---

## Phase 1: Base Visual System Alignment ✅ Done

### 1.1 Color Scheme Refactor ✅

**Goal**: Move the color system from the current gray palette to the mockup's white-background + gray-input style

| Property     | Old value          | New value                          | Status |
| ------------ | ------------------ | ---------------------------------- | ------ |
| Panel bg     | `#f8f8f8`          | `#ffffff`                          | ✅     |
| Input bg     | `#f0f0f0`          | `#f3f3f3`                          | ✅     |
| Input hover  | `#e8e8e8` (bg)     | `border #e0e0e0` (inset)           | ✅     |
| Input focus  | outer `box-shadow` | `inset 2px border #3b82f6` + white | ✅     |
| Border color | `#e8e8e8`          | `#e5e5e5`                          | ✅     |

**Completed tasks**:

- [x] Update CSS variable definitions (`shadow-host.ts:56-97`)
- [x] Change input hover/focus styles to inset border mode
- [x] Change panel background to pure white

### 1.2 Font & Font Size Adjustments ✅

| Property        | Old value   | New value                    | Status |
| --------------- | ----------- | ---------------------------- | ------ |
| Panel base size | `13px`      | `11px`                       | ✅     |
| Label size      | `11px`      | `10px`                       | ✅     |
| Input size      | `12px`      | `11px`                       | ✅     |
| Font family     | System font | Inter + system font fallback | ✅     |

**Completed tasks**:

- [x] Add the Inter font declaration (with system font fallback)
- [x] Adjust panel, label, and input font sizes
- [x] Remove the uppercase styling on labels

### 1.3 Spacing & Margin Adjustments ✅

| Property       | Old value   | New value  | Status |
| -------------- | ----------- | ---------- | ------ |
| Panel width    | `320px`     | `280px`    | ✅     |
| Header padding | `10px 14px` | `8px 12px` | ✅     |
| Body gap       | `10px`      | `12px`     | ✅     |

**Completed tasks**:

- [x] Adjust the padding/gap of `.we-panel`, `.we-prop-body`, `.we-field-group`
- [x] Adjust the header padding

### 1.4 Corners & Shadows ✅

| Property     | Old value   | New value          | Status |
| ------------ | ----------- | ------------------ | ------ |
| Panel shadow | `0 1px 2px` | Tailwind shadow-xl | ✅     |
| Input radius | `6px`       | `4px`              | ✅     |
| Tab shadow   | none        | `shadow-sm`        | ✅     |

**Completed tasks**:

- [x] Enhance the panel shadow (double-layer shadow to mimic shadow-xl)
- [x] Set input corner radius to 4px
- [x] Add a shadow to the active Tab

### 1.5 Group/Section Style Refactor ✅

| Property        | Old style    | New style   | Status |
| --------------- | ------------ | ----------- | ------ |
| Group border    | Card border  | No border   | ✅     |
| Section divider | none         | Top divider | ✅     |
| Header style    | Bold + large | 11px + #333 | ✅     |

**Completed tasks**:

- [x] Remove the border and background from `.we-group`
- [x] Add a divider line between sections (`border-top`)
- [x] Adjust the Group header style

---

## Phase 2: Input Container Component Refactor ✅ Base Done

### 2.1 Build the Input Container System ✅

**Background**: The mockup's input is not a single `input` but a container system that supports:

- Prefix: label, icon
- Suffix: unit, icon
- Container-driven hover/focus styles

**Current structure**:

```html
<div class="we-field">
  <span class="we-field-label">Width</span>
  <input class="we-input" />
</div>
```

**Target structure**:

```html
<div class="we-field">
  <span class="we-field-label">Position</span>
  <div class="we-input-container">
    <!-- new container -->
    <span class="we-input-container__prefix">X</span>
    <!-- optional prefix -->
    <input class="we-input-container__input" />
    <span class="we-input-container__suffix">px</span>
    <!-- optional suffix -->
  </div>
</div>
```

**Done**:

- [x] Define the `.we-input-container` style in `shadow-host.ts`
- [x] Define the `.we-input-container__prefix` and `.we-input-container__suffix` styles
- [x] Create the `ui/property-panel/components/input-container.ts` component
- [x] Move hover/focus styles to the container level (using `:focus-within`)

### 2.2 Update Each Control to Use the New Container ✅ Done

**Controls to update**:

- [x] `size-control.ts` - Width/Height (2-column layout + W/H prefix + dynamic unit suffix)
- [x] `spacing-control.ts` - Margin/Padding (refactored to a 2x2 grid + direction icons + dynamic unit suffix)
- [x] `position-control.ts` - Top/Right/Bottom/Left/Z-Index (T/R/B/L prefix + dynamic unit suffix)
- [x] `layout-control.ts` - Gap (icon prefix + dynamic unit suffix)
- [x] `typography-control.ts` - Font Size/Line Height (dynamic unit suffix, smart line-height display)
- [ ] `appearance-control.ts` - Opacity/Border Radius/Border Width (pending)

**Shared module completed**:

- [x] Create the `css-helpers.ts` shared module (extractUnitSuffix, hasExplicitUnit, normalizeLength)
- [x] All controls use the shared helper, eliminating duplicated code

---

## Phase 3: Section Structure Refactor (Pending)

### 3.1 Tab Information Architecture Adjustment

**Current**: 4 Tabs (Design/CSS/Props/DOM)
**Mockup**: 2 Tabs (Design/CSS)

**Options**:

- **Option A**: Keep 4 Tabs, switch to an overflow menu
- **Option B**: Move Props/DOM to a different entry point
- **Option C**: Keep 4 Tabs, adjust styling to fit

**Tasks**:

- [ ] Make the product decision on Tab count
- [ ] Implement the chosen option

---

## Phase 4: Feature Component Implementation (Pending)

### 4.1 Flow Layout Icon Group ✅ Done

**Mockup location**: `attr-ui.html:133-156`
**Function**: 4 icon buttons controlling `flex-direction`

```
[→] Row
[↓] Column
[←] Row Reverse
[↑] Column Reverse
```

**Done**:

- [x] Create the reusable `ui/property-panel/components/icon-button-group.ts` component
- [x] Add the `.we-icon-button-group` style in `shadow-host.ts`
- [x] Replace the Direction select with the icon group in `layout-control.ts`
- [x] Add the matching SVG arrow icons (row/column/row-reverse/column-reverse)

### 4.2 Alignment 3x3 Grid ✅ Done

**Mockup location**: `attr-ui.html:166-208`
**Function**: 3x3 grid controlling `justify-content` + `align-items`

```
[↖][↑][↗]
[←][·][→]
[↙][↓][↘]
```

**Done**:

- [x] Create the `ui/property-panel/components/alignment-grid.ts` component
- [x] Add the `.we-alignment-grid` style in `shadow-host.ts`
- [x] Replace the Justify/Align selects in `layout-control.ts`
- [x] Use `beginMultiStyle` for an atomic commit of both properties

### 4.3 Fix the Color Picker ✅ Partially Done

**Current issues**:

- `showPicker()` has no try/catch and may throw
- The alpha channel is dropped
- Token values `var(--xxx)` display incorrectly

**Done**:

- [x] Add error handling to `showPicker()` (try/catch + fallback to click)
- [x] Improve parsing and display of `var()` values (pass computed value in via placeholder)

**Pending**:

- [ ] Support the alpha channel (RGBA/HSLA) - requires a third-party color picker
- [ ] Consider adopting a third-party color picker (e.g. `@simonwep/pickr`)

---

## Phase 5: New Feature Modules (Pending)

### 5.1 Shadow & Blur Controls

**Mockup location**: `attr-ui.html:396-425`
**Function**:

- Enable/disable toggle
- Type selection (Drop shadow/Inner shadow/Layer Blur/Backdrop Blur)
- Visibility control

**CSS properties**:

- `box-shadow`
- `filter: blur()`
- `backdrop-filter: blur()`

**Tasks**:

- [x] Create `ui/property-panel/controls/effects-control.ts`
- [x] Implement parsing and editing of `box-shadow` values
- [x] Implement parsing and editing of `filter` values
- [x] Implement parsing and editing of `backdrop-filter` values
- [x] Add the type-switcher UI
- [ ] Add the enable/disable toggle (optional, later)

### 5.2 Gradient Editor

**Mockup location**: `attr-ui.html:269-325`
**Function**:

- Linear/Radial gradient types
- Color stops
- Angle control
- Flip button

**CSS properties**:

- `background-image: linear-gradient(...)`
- `background-image: radial-gradient(...)`

**Tasks**:

- [x] Create `ui/property-panel/controls/gradient-control.ts`
- [x] Implement gradient value parsing (CSS gradient → data structure)
- [x] Implement angle/position inputs
- [x] Implement editing of 2 color stops
- [x] Integrate into the property panel (as a standalone Gradient control group)
- [ ] Implement the gradient preview slider (optional, later optimization)
- [ ] Implement color stop add/remove/drag (optional, later optimization)

### 5.3 Token/Variable Pill Display

**Mockup location**: `attr-ui.html:374-384`
**Function**: When the value is a CSS variable, show it as a clickable pill

**Tasks**:

- [ ] Detect `var(--xxx)` values
- [ ] Render as a pill style
- [ ] Open the token picker on click

---

## Phase 6: Code Quality (Throughout)

### 6.1 Unify the Style System

- [x] All colors use CSS variables (done in Phase 1)
- [ ] All sizes use consistent tokens
- [ ] Remove inline styles, consolidate into `shadow-host.ts`

### 6.2 Component Reuse

- [ ] Extract shared components into `ui/property-panel/components/`
- [ ] Unify the event-handling pattern
- [ ] Unify disabled/enabled state handling

### 6.3 Type Safety

- [ ] All components use strict TypeScript types
- [ ] Define clear interfaces and types
- [ ] Remove `any` type assertions

---

## Implementation Progress

| Phase | Task               | Status    | Notes                                                 |
| ----- | ------------------ | --------- | ----------------------------------------------------- |
| 0.1   | Minimize bug fix   | ✅        | Added global `[hidden]` rule                          |
| 0.2   | Input improvements | ✅        | number-stepping + real value display                  |
| 1.1   | Color scheme       | ✅        | White bg + gray inputs + inset focus                  |
| 1.2   | Font & size        | ✅        | 11px base + Inter font                                |
| 1.3   | Spacing & margins  | ✅        | More compact layout                                   |
| 1.4   | Corners & shadows  | ✅        | shadow-xl + 4px corners                               |
| 1.5   | Group/Section      | ✅        | Divider-line style                                    |
| 2.1   | Input container    | ✅        | Component + CSS styles                                |
| 2.2   | Update Controls    | ✅        | All major controls migrated, shared css-helpers.ts    |
| 3.1   | Tab info arch      | Pending   |                                                       |
| 4.1   | Flow icon group    | ✅        | icon-button-group.ts + integrated into layout-control |
| 4.2   | Alignment 3x3 grid | ✅        | alignment-grid.ts + integrated into layout-control    |
| 4.3   | Fix Color Picker   | ✅ partly | showPicker error handling + var() parsing             |
| 5.1   | Shadow & Blur      | ✅        | effects-control.ts + integrated into property-panel   |
| 5.2   | Gradient editor    | ✅        | gradient-control.ts + integrated into property-panel  |
| 5.3   | Token Pill         | Pending   |                                                       |

---

## Notes

1. **Incremental rollout**: Each Phase should be independently testable and shippable once complete
2. **Maintain backward compatibility**: The refactor must not break existing functionality
3. **Record design decisions**: When the mockup conflicts with actual requirements, record the reason for the decision
4. **Performance considerations**: New components must account for render performance and avoid unnecessary DOM operations
