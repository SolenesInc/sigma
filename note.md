A client now says which conversation it shows. `client/shows {conversation, author}` is a stream that lasts while the client keeps it open. `status/watch` sends `{_tag: "shown", author, conversation}` when one starts, and its opening snapshot lists the current ones in `shown`.

The TUI holds one for the conversation on its screen. It opens one after the screen comes up, again after each reconnect, and again after a fork switches the screen. So a watcher such as attn learns about a fork the TUI actually opened, before anything is typed there. A fork the TUI made but never opened is never reported.

Trade-off: `PROTOCOL_VERSION` stays 2. The addition is additive, and attn reads Sigma's protocol number as `attn-app-server-v2`, so a bump would ripple to every plugin. `sigma exec` and the TUI's re-list ignore the new item.
