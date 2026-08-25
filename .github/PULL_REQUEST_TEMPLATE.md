## Summary

<!-- What does this change do, and why? -->

## Checklist

- [ ] `npm test` passes locally
- [ ] `npm run lint` is clean
- [ ] No new colors are hardcoded outside CSS variables (`var(--...)` tokens only)
- [ ] Existing HTML IDs referenced by front-end JS were not removed or renamed
- [ ] If `treeRenderer.js` (or the tree stylesheet) was touched: the
      [tree-rendering invariants](../CLAUDE.md#tree-rendering-invariants-do-not-break) still
      hold — in particular, `nodeHeightFor()` still returns a constant for every node
- [ ] If the email body rendering was touched: the iframe sandbox still has **no**
      `allow-scripts`
- [ ] Commits are small, focused, and follow the conventional-commit style (see
      [CONTRIBUTING.md](../CONTRIBUTING.md))

## Testing

<!-- How did you verify this change? Manual steps, screenshots, etc. -->
