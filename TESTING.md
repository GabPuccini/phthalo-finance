# Testing

What was actually run for the October 2026 redesign and the long term plan that followed
it, what it said, and what is not covered. Everything below was executed rather than
described.

Environment: Node v22.22.0 on Linux, Chromium driven by Playwright 1.63, viewport 375 by
812 at a device pixel ratio of 2, in both themes.

## Automated tests

```
$ node --test

# tests 110
# suites 0
# pass 110
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 5388.778782
```

Nothing needs installing to run this. Most of the five seconds is one test that genuinely
waits out the five second price lookup timeout.

107 of the 110 live in `tests/cases.js` and also run in the browser: opening `tests.html`
reports **All 107 tests passed** with a clean console. The other three need the file
system, so they run under Node only:

* `styles.css` carries exactly the colours in `src/logic.js`, which are the measured ones.
* The service worker caches every file and every module the app needs.
* `CACHE_VERSION` has been stamped since the cached files last changed.

### What they cover

| Area | Cases |
| --- | --- |
| Net worth | mixed assets and debt, a negative total, category totals, allocation, sorting with debt last |
| No drift | add then withdraw returns to the exact starting balance; a thousand round trips of a penny leave zero |
| Backdating | an entry between two others, entries supplied out of order, editing an old entry, moving its date, deleting one |
| Account history | built the same way as net worth, other accounts left out, debt reported as the amount owed, a one year cap, archived and empty accounts |
| Quantity holdings | a zero or missing price, a large holding that would drift in floating point, historic value at the price recorded at the time |
| Dates | impossible dates, both daylight saving changes, month boundaries, leap days, month end clamping |
| Goals | future date, past date, exceeded, target of zero, zero balance, pace ahead and behind, debt counting down |
| Saving rates | one day left, none left, negative days, nothing left to save |
| Debt | payoff with and without interest, a payment that never clears it, no payments, average repayment |
| Formatting and input | zero, large, negative, the ten thousand boundary, units, text rejected |
| CSV, import, migration | escaping, signed withdrawals, malformed and empty files, wrong types, a version 0 file, an old saved layout |
| Prices | a good response, malformed JSON, rate limiting, offline, a nonsense price, the five second timeout |
| Palette | every text colour on every background in both themes, button labels, chart marks, category badges, the fixed allocation order |
| The plan engine | months and tax years; the mortgage formula (£153,000 at 5% over 30 years is £821.34); a loan clearing on the same payment count as the payoff projection, at £188 in February 2032 and at £247 nearly two years sooner; the Lifetime ISA bonus, its £4,000 limit and the April reset; a full pot passing money on; a cleared debt passing its payment on; the purchase with the Lifetime ISA to the price, a top up from the pot, and costs the pots cannot cover coming out of savings, with net worth falling by exactly the costs; the house plan's own figures |
| The plan against real money | ahead, behind and on plan on a hand worked day; a forecast from balances exactly on plan reproducing the plan before and after the purchase and the loan; a loan account with nothing recorded not read as paid off; a debt recorded at zero passing its payment on; the Lifetime ISA allowance already used this tax year; the chart's three lines joining up |
| The plan's shape | cleaning is idempotent and leaves no reference to a missing line or account; a version 1 save gains an empty plan and keeps one a newer tab wrote; export and import byte for byte with a plan; a broken plan refused on import; deleting an account unlinks it |

## Browser testing

```
$ node tools/browser-smoke.mjs

136 of 136 checks passed
```

The site is served from the **parent** directory, so every page loads from
`/phthalo-finance/` as it does on GitHub Pages.

### Your thirteen steps

| # | Step | Result |
| --- | --- | --- |
| 1 | First load, empty storage | **Pass.** Net worth `£0.00`, the ten default accounts, a labelled empty state on the chart and on all four Insights charts, the welcome message, no reload, clean console. |
| 2 | Load the demo data | **Pass.** Plausible net worth, the hero line drawn, four goal progress bars visible on Home, every Insights chart drawn with a finding for a title and a table of its numbers, account bars in one colour with debt in red. |
| 3 | Add money to three accounts | **Pass.** Net worth moved by exactly £1,750.75 with no reload. The add button lists all ten accounts. |
| 4 | Withdraw, including too much | **Pass.** A normal withdrawal went through. £999,999 from a few thousand warned "below zero" and kept the form open. |
| 5 | Backdated entry | **Pass.** The line changes from the backdated day itself, not from today, and stays in strict date order. |
| 6 | Edit then delete | **Pass.** The edit stored 4242 pence exactly; the delete removed exactly one entry. |
| 7 | Goal maths | **Pass.** Days remaining, percentage, amount still needed and the daily, weekly and monthly rates all match sums done independently in the test, and the goal screen's ring, rates, target date and countdown show those same figures. |
| 8 | Custom account and chart | **Pass.** Added "Premium Bonds" with its category badge, switched a chart on and off, reordered charts, then deleted the account, which named its entry count and offered an export first. |
| 9 | Export, clear, import | **Pass.** A dated JSON file and a CSV with a row per entry. After clearing and importing, the state is byte for byte identical. A broken file was refused and nothing was half loaded. |
| 10 | Reload | **Pass.** Accounts, entries and net worth identical to the penny. |
| 11 | 375px wide | **Pass.** No sideways scroll on any tab or on an account. Every control on every tab, the account screen, its records and the entry form is at least 44 by 44. |
| 12 | Both themes | **Pass.** Every text colour, as actually rendered, reaches AA on surface, canvas and raised fills in the light theme; charts draw in both. |
| 13 | Console | **Pass, with one note.** Clean throughout. During the deliberate offline test Chromium logs four network lines of its own, which no page can suppress; the app caught each one. |

### Beyond the thirteen

* **The account screen.** It hides the tab bar, the add button steps aside on the goal tab
  where Add money and Withdraw are already in view, and Records lists every entry.
* **The back gesture.** The phone's back returns from an account to Home, and with a form
  open it closes the form first and stays on the account.
* **The crosshair.** Moving along the net worth line shows that day's value and date, and
  it resets when the pointer leaves.
* **Offline.** The app loads, draws and shows its data with no network. A price refresh
  offline keeps every typed price and says so.
* **Storage failures.** Storage switched off, a full quota, corrupt data with and without a
  good backup: each shows a clear message, offers a download, and never throws or deletes.
* **Migration.** A version 0 file upgrades with pounds turned to pence, and a saved layout
  that still lists the old net worth chart drops that entry cleanly.
* **One account only.** All seven charts render, none blank or errored, each with a title.
* **Wording.** No em dashes, en dashes or hyphenated words in the interface.
* **Wide screens.** At 1024px the chart sits beside the accounts and Insights uses two columns.
* **Holdings.** A quantity account's entry form shows pounds or units, never both.

### The plan

Step G of the browser run loads a state like the owner's, saved by the release before
the plan existed, and checks:

* the save upgrades from version 1 to version 2 with a note and keeps every entry;
* the empty Plan tab offers the house plan or a blank one, and the house plan arrives
  with its ten lines, the purchase in October 2031, and links to the matching accounts;
* the chart draws the plan, your line and the forecast, with its table of numbers;
* the status chip agrees with the engine, the purchase milestone shows its own month,
  and the purchase card warns that the buying costs are not covered in cash;
* £600 into the Lifetime ISA moves the comparison by exactly £600, on the Plan tab and in
  the Home card that leads to it;
* a monthly amount edited in its own sheet is saved at once as exact pence and returns to
  its line; a last month before the first is refused; a month box only shows when the
  condition is a month;
* a line is added with a bad growth rate refused first, opens again for its amounts,
  takes one, and is deleted; a house price of zero is refused and a real one saved;
* no sideways scroll, every control on the plan and on each of its forms at least 44 by
  44, and no dashes or hyphenated words anywhere on them;
* deleting the plan leaves every account and entry as it was.

Separately, the upgrade from the release that was live was rehearsed: installed with the
demo data, the new release put over the top, the "new version" prompt taken, and then:
the Plan tab present, the data upgraded to version 2 with a note, all 127 entries
identical, the house plan set up, the Plan tab drawing with the network off, and only
the new release left in the cache.

## Upgrading the copy already on your phone

The version installed before this redesign had a service worker that fetched the page from
the network but the scripts from its cache, so the first visit after an update could pair
the new page with old scripts. That was rehearsed directly: the version that was live was
served and installed with the demo data, the new release was put over the top, and the
app opened again.

| Path | What happens | Result |
| --- | --- | --- |
| The phone still has the old page cached | The old version keeps running whole, never half updated, and the next cold start opens the redesign | **Pass,** all 127 entries intact, old cache gone |
| The phone fetches the new page fresh | The mismatch is spotted, the app repairs itself with one reload and opens the redesign | **Pass,** all 127 entries intact, works offline straight after |
| A later release | "A new version is ready", tap, and it switches to the new cache | **Pass,** data intact |

The new service worker serves the page and its code from one cache per release, so this
cannot happen again, and `tools/stamp-sw.mjs` plus a test make sure every release changes
`sw.js` so installed copies notice it.

## Bugs found during the redesign

Found by testing and by looking at screenshots, and fixed:

1. **Goal progress bars were invisible** on Home in both themes. The bar was an inline
   element with no height. Labels showed, the bar did not.
2. **A first visit reloaded itself** a second after opening, as the service worker took
   charge, which also threw away the welcome message. This was in the first version too.
3. **Editing a withdrawal checked the balance the wrong way round.** It added the original
   entry back instead of removing it before checking for going below zero. Also present in
   the first version.
4. **The update prompt could miss an update** the browser had already found before the
   page loaded. The new code checks for a waiting update as well as listening for one.
5. **The debt badge and the cash badge were too alike** in dark mode: measured, the two
   reds sat below the colour separation floor. The debt badge is now an outlined ring, so
   it differs in kind as well as colour.
6. **The lowest axis figure hid under the line,** and one axis mixed `£12k` with
   `£8,000`. Labels now draw on top with a halo, and each axis uses one format.
7. **The troubleshooting advice to clear site data** did not say that this also deletes
   everything saved. It now says to export first.

## Bugs found while building the plan

1. **A hidden form field could still show.** `.field { display: grid }` outranked the
   `hidden` attribute, so the entry form for a holding showed the pounds field and the
   units field together. A single rule now makes `hidden` always win.
2. **The house plan's own arithmetic.** Running the plan month by month showed that the
   loan at £188 a month clears in February 2032, not March 2030, and that the cash pots
   cannot cover the £7,100 of buying costs, because a Lifetime ISA can only go toward the
   price. The engine reports both rather than hiding them.

## Measurements behind the colours

The palette is no longer limited to a single hue, which removes the shortfall recorded
for the first version, where nine accounts could not sit 15 lightness points apart.

* **Text.** Ink, muted, accent, positive, negative and warning text each reach at least
  4.5 to 1 against the surface, canvas and raised fills in both themes. The lowest is
  5.19 to 1, light mode negative text on the raised fill.
* **Category colours.** From a documented, colour vision checked palette, with a separate
  step per theme. The allocation bar keeps one fixed order, chosen by running all 120
  arrangements through a validator: its closest neighbours measure an OKLab difference of
  9.2 under simulated deuteranopia (8 is the target) and 19.3 with full colour vision (15
  is the floor), in both themes. No set of five hues passes when any two may touch, so the
  category colours appear only where their order is fixed.
* **Light mode relief.** Three category colours sit below 3 to 1 against white. The
  allocation chart carries every value in its legend and in its table view, which is the
  required relief.

## What is not covered

1. **The live price services were never reached.** All three are still blocked from the
   environment this was built in. The failure path is tested thoroughly and the parsing of
   a good response is tested against a stubbed `fetch`, but the real services have not
   answered. Press Refresh once on your phone before relying on it.
2. **No real device.** Everything ran in Chromium at a phone sized viewport. Touch, the
   home screen install, and the share sheet are unverified on hardware.
3. **Chromium only.** Safari and Firefox were not tested. The upgrade rehearsal in
   particular ran in Chromium; iOS manages service workers in installed apps its own way,
   so the exact moment the redesign appears on an iPhone may differ, though no path
   touches your saved data.
4. **iOS storage eviction** is documented Safari behaviour, not something reproduced here.
5. **Screen readers** were not tested, though labels, roles and table views are in place.
6. **Very large ledgers** were not profiled. History is rebuilt from every entry on each
   draw, which is instant with the demo data.

## Running the tests yourself

```sh
node --test                      # 110 checks, nothing to install
python3 -m http.server 8000      # then open http://localhost:8000/tests.html
```

The browser suite needs Playwright, which the app itself never does:

```sh
npm install -g playwright
node tools/browser-smoke.mjs
```
