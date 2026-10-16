# Performance harness

`scripts/perf/run.mjs` measures the paths that slow down as an account grows: loading the app,
opening conversations, reading long transcripts, the tracker, memory over a long session, and the
main-thread cost of an agent streaming its reply. It never talks to a real deployment. It starts a
throwaway [matron-journal](https://github.com/Matronhq/matron-journal) from a local checkout,
fills it with a synthetic account through the normal protocol, serves the built app in front of
it and drives headless Chromium with Playwright.

## Running it

```bash
pnpm build
git clone https://github.com/Matronhq/matron-journal ../matron-journal
(cd ../matron-journal && npm ci --omit=optional)
pnpm exec playwright install chromium

MATRON_JOURNAL_DIR=../matron-journal pnpm perf --scale=full --data=/tmp/matron-perf-full
```

Seeding the full dataset takes a few minutes. Pass `--data=DIR` to keep it: the next run with the
same `--data` reuses the database and skips seeding. Useful options:

| Option                 | Meaning                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `--scale=full\|ci`     | Dataset size, see below. Default `full`.                                                          |
| `--only=switch,stream` | Run only some scenarios: `bundle`, `cold`, `warm`, `switch`, `long`, `tracker`, `stream`, `soak`. |
| `--runs=N`             | Repeat the timed scenarios and report the median. Default 3.                                      |
| `--cpu=4`              | Throttle the CPU as DevTools does, to approximate a slower laptop or a phone.                     |
| `--profile=DIR`        | Save a `.cpuprofile` per browser page. Open it in the DevTools Performance panel.                 |
| `--budget=FILE`        | Compare against a budget and exit 1 on a breach.                                                  |
| `--out=FILE`           | Where the JSON result goes. Default `perf-results.json`.                                          |

Numbers depend on the machine. Compare runs from the same machine, ideally before and after a
change with the same `--data`.

## The dataset

Everything is generated from a fixed seed, so every run sees the same account.

|                             | `full`                                                     | `ci`                      |
| --------------------------- | ---------------------------------------------------------- | ------------------------- |
| Agent boxes                 | 6                                                          | 3                         |
| Conversations               | 1,200 + 4 long ones (8,000, 3,000, 3,000 and 1,500 events) | 150 + one of 2,000 events |
| Sub-chats                   | 150                                                        | 20                        |
| Events                      | about 57,000                                               | about 5,700               |
| Projects / missions / items | 120 / 600 / 4,000                                          | 15 / 60 / 400             |

Conversations mix the event types a coding session produces: user messages, agent prose with
markdown (lists, tables, code fences), tool output cards and diffs. Items carry comments, and
most are closed. Missions carry milestones and a status.

## Scenarios

| Scenario  | What it does                                                                                                                                            | Main numbers                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `bundle`  | Sizes of the built JS and CSS, raw and compressed.                                                                                                      | `initialGzipKB`: what a first visit downloads before it can render. |
| `cold`    | Signs in through the form with an empty browser, until the sidebar lists conversations.                                                                 | `signInToListMs`, `longTaskMs`, `maxLongTaskMs`, `domNodes`.        |
| `warm`    | Reloads a signed-in page with the local database filled.                                                                                                | `reloadToListMs`.                                                   |
| `switch`  | Opens 20 conversations and then opens them again, and clicks sidebar rows.                                                                              | `firstOpenMedianMs`, `revisitMedianMs`, `rowClickMedianMs`.         |
| `long`    | Opens the longest conversation and pages back with "Load earlier messages", then scrolls through everything loaded and receives a new message.          | `lastPageMs`, `scrollFps`, `domNodes`, `appendWithLongHistoryMs`.   |
| `tracker` | Opens Projects, For you and the biggest mission, then reopens Projects.                                                                                 | `projectsReadyMs`, `missionReadyMs`.                                |
| `stream`  | An agent streams a reply at about 25 frames a second, beside a live tool output, into a short conversation and into one with about 1,000 events loaded. | `mainThreadBusyPct`, `fps`, `maxLongTaskMs`.                        |
| `soak`    | Repeats switching and tracker visits and samples the heap after forced GC.                                                                              | `heapGrowthPerCycleMB`, event listener counts.                      |

"Ready" is when the content is on screen. "Idle" is when the main thread has also finished the
long tasks that the action started. A long task is any task over 50 ms, which is when a page
starts to feel sluggish.

## The budget

CI runs the `ci` dataset on every pull request and fails if a number goes over
`scripts/perf/budget.json`. The job summary shows every number beside its limit, and
`perf-results.json` is attached to the run. When a change makes a number clearly better, lower its
limit in the same pull request so the gain can't quietly slip back. Raise a limit only with a
reason in the pull request description. A budgeted metric that a run fails to measure counts as a
breach.

Limits sit about two to three times above the CI medians (bundle sizes about 10 KB above). That
absorbs runner noise but still catches the regressions the harness was built for. For example, when
every row re-rendered on each streamed token, the longest task while streaming was 190–340 ms on CI.
It is now 0 ms, and the limit is 150 ms.

The job runs the journal at a pinned commit (see `.github/workflows/perf.yml`), so a journal change
can't break it unannounced. Move the pin forward in a pull request of its own.
