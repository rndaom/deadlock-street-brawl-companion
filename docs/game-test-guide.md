# Try it in Deadlock

1. Double-click **Start Companion.cmd** (or `release/win-unpacked/Street Brawl Companion.exe`). Leave **Live** selected.
2. Put the companion on your second monitor. Run Deadlock in **borderless windowed** mode and click back into the game.
3. Play normally. When **Select Items** appears, the companion reads the three cards within a second or two and shows:
   - **Pick &lt;item&gt;** with its card position (Left / Middle / Right) and the main reason, or
   - **Reroll — or take &lt;item&gt;** when none of the three cards is worth taking and you have rerolls left.
   Bonuses and special effects on the cards are not read yet; check them in game.
4. The cards stay on screen while you look at the companion. They clear when the draft closes or new cards appear.
5. Hold **Tab** for a few seconds at a safe moment to let it read heroes and enemy items.

## If cards still don't show

- Make sure no ordinary window covers the middle of the game (click-through overlays such as Discord or NVIDIA are fine).
- Use **Reading status & limits → Read again**.
- Every read is logged to `Documents\Street Brawl Companion\diagnostics\reader-log.jsonl`, and draft screenshots are saved to `diagnostics\frames`. Share that folder and the exact misread can be replayed and fixed.
