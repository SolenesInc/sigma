Sigma's TUI now keeps what a person types before it is up, as a shell does: text typed at launch shows in the prompt once it draws, and an Enter typed with it sends it (s-rc8kfp).

On a non-production attn instance, a probe typed 0, 300 and 1000 ms after the spawn was lost on the old TUI and kept on this one; a prompt plus Enter typed at the spawn was sent. The screen test `answer-typeahead` fails on the old TUI and passes on this one.
