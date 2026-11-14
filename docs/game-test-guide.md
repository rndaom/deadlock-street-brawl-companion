# Try it in Deadlock

1. Start **Street Brawl Companion.exe** from the folder you extracted (from a source checkout: **Start Companion.cmd**). Leave **Live** selected.
2. Put the companion on your second monitor. Run Deadlock in **borderless windowed** mode with the **English** interface, and click back into the game.
3. Play normally. When **Select Items** appears, the companion reads the three cards within a second or two and shows:
   - **Pick &lt;item&gt;** with its card position (Left / Middle / Right) and the main reason, or
   - **Reroll — or take &lt;item&gt;** when none of the three cards is worth taking and you have rerolls left.
4. The cards stay on screen while you look at the companion. They clear when the draft closes or new cards appear.
5. Hold **Tab** for a few seconds at a safe moment to let it read heroes and enemy items.

## If cards still don't show

- Check the game's display mode is **borderless windowed**. Exclusive fullscreen can show a black picture to screen readers.
- Make sure no ordinary window covers the middle of the game (click-through overlays such as Discord or NVIDIA are fine).
- Use **Reading status & limits → Read again**.
- Every read is logged to `Documents\Street Brawl Companion\diagnostics\reader-log.jsonl`, and draft screenshots are saved to `diagnostics\frames`. Share that folder and the exact misread can be replayed and fixed. The frames are screenshots of your game, so they can show your Steam name, other players' names and chat; look through them before you send them to anyone.
- "Windows text recognition has no English language": add English (United States) in **Settings → Time & language → Language & region**, then restart the companion.
