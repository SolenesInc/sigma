A Claude Code run you stop now stays stopped. Claude Code reports `running` when a turn begins and again when it goes on from an approval (`requires_action` → `running`). Sigma read both as Claude Code starting a turn by itself. If the second one arrived while a stop was in flight, sigma woke the conversation: "Claude Code continued on its own." appeared, the stopped work went on, and the next prompt could stall.

The Claude adapter now reports a turn's start only when no turn is under way, as agy's adapter already does.

This is the 90 s hang of `claude-stop, claude-resume` on macOS CI (run 45284461545). The race dates from be30cd5; e69ff71, the commit CI went red on, did not cause it.
