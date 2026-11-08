# pi-reply-clock

Reply Clock — a footer shot clock for [pi](https://github.com/earendil-works/pi-coding-agent).

Replaces the pi footer's stats line with a reply status segment: a freshness
glyph plus how long ago the agent last replied, while it's running, and an
absolute timestamp. The rest of the footer keeps pi's built-in layout: tokens,
cache hit rate, cost, context percentage, and model — with the reply clock
placed first on line 2 so narrowing the terminal never hides it.

```
~/GitHub/pi-reply-clock (main) • session name
● 42s ago  14:03  · took 1m 12s   ↑12.3k ↓4.1k R98.2k W31.5k CH94.2% $0.482  38.4%/200k  sonnet-4-5
```

- `●` fresh (under a minute), `◐` warm (under 30 minutes), `○` idle
- While the agent works: `◌ 1m 30s` counts the current run, last reply's
  timestamp beside it
- `took 1m 12s` appears when the last run took 3 seconds or more

## Install

```bash
pi install npm:pi-reply-clock
# or
pi install git:github.com/jesserobbins/pi-reply-clock
```

If you previously ran this as a standalone extension file (e.g. copied into
`~/.pi/agent/extensions/`), delete that copy before installing — loading the
same extension twice hangs pi at startup.

## Notes

The footer is replaced wholesale, which means reproducing the built-in layout.
Three built-in details are not reachable from the extension API and are
omitted: the routed-model suffix for virtual models, the `(sub)` subscription
marker, and the `(auto)` compaction indicator.

## License

[MIT](LICENSE)
