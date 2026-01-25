# Site Design TODO

## Critical Engineering

- [ ] **Accessibility:** The terminal `div` is a black hole. Add `tabindex`, `role`, and proper keyboard support.
- [ ] **Refactor:** Extract the `scenario` logic out of the HTML. Data belongs in a data structure, not mixed with DOM manipulation.
- [ ] **Iconography:** Replace the Unicode checkmark (`✓`) with an SVG. Don't rely on system fonts for UI icons.
- [ ] **Optical Alignment:** Fix the left vertical axis. The `h1` (with its magic negative margin), the manifesto text, and the CTA button are not aligned.

## Hierarchy

- [x] Face vs terminal: two focal points fighting for attention. Pick one winner.
  - ~~Option A: Push face further back (more blur, darker, `brightness(0.15)`)~~ Done
- [ ] Left panel floats in dead space while terminal dominates — rebalance

## Mobile

- [ ] Terminal gets cramped at 1200px breakpoint
- [ ] Test touch interactions for terminal input

## Missing Elements

- [x] No attribution — added Axiom link at bottom
- [ ] No OG image / Twitter card meta tags
- [ ] No favicon

## Polish

- [ ] **Performance:** Lazy-load the terminal animation ONLY if it blocks the initial paint (unlikely, but verify).
- [ ] **Input:** Escape key should not just clear input, but reset focus state properly.