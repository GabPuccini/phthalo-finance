# Testing

What was actually run, what it said, and what is not covered. Everything below was
executed rather than described.

Environment: Node v22.22.2 on Linux, Chromium 141.0.7390.37 driven by Playwright,
viewport 375 by 812 at a device pixel ratio of 2.

## Automated tests

```
$ node --test

1..77
# tests 77
# suites 0
# pass 77
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 5192.919531
```

Nothing needs installing to run this. The five seconds is almost entirely one test that
genuinely waits out the five second price lookup timeout rather than faking it.

The assertions live in `tests/cases.js` and are shared by the Node runner and by
`tests.html`, so the browser page cannot drift away from the command line suite. Opening
`tests.html` in Chromium reports **All 77 tests passed** with a clean console.

### What the 77 cover

Everything on the agreed list, plus what came up while building:

| Area | Cases |
| --- | --- |
| Net worth | mixed assets and debt, a negative total, category totals, allocation, sorting with debt last |
| No drift | add then withdraw returns to the exact starting balance, and a thousand round trips of a penny leave zero |
| Backdating | an entry inserted between two existing ones, the same entries supplied out of order, editing an old entry, moving an entry's date, deleting one |
| Quantity holdings | a zero price, a missing price, a large holding that would drift in floating point, historic value at the price recorded at the time |
| Dates | impossible dates rejected, both British daylight saving changes, month boundaries, leap days, month arithmetic clamping |
| Goals | future date, past date, already exceeded, target of zero, balance of zero, pace ahead and behind, debt counting down |
| Saving rates | one day left, zero days left, negative days, nothing left to save |
| Debt | payoff with and without interest, a payment that never clears the debt, no payments at all, average repayment |
| Formatting | zero, large, negative, the ten thousand abbreviation boundary, units, input parsing rejecting text |
| CSV | commas and quotes escaped, withdrawals signed, an empty ledger |
| Import | malformed JSON, empty file, right shape with wrong types, an unknown account type, an orphan transaction, a file from a newer version |
| Migration | a version 0 object upgraded, migration not applied twice, rubbish input not wiping data |
| Prices | a good response, malformed JSON, a rate limited endpoint, an offline throw, a nonsense price, the five second timeout, symbol resolution |
| Demo data | internally consistent, no negative holdings, nothing dated in the future, repeatable |
| Palette | every text colour measured against both backgrounds in both themes, label readability on every fill, colour assignment |

Two bugs were found by writing these tests rather than by reading the code:

* The month arithmetic under borrowed. From 31 January to 1 March it returned minus two
  days. It now counts whole months first and takes the leftover, which follows the same
  end of month clamping as adding a month.
* The demo data generator sold Solana it had never bought, leaving a holding of minus
  6.04 units. It now tracks running balances and can never produce a negative position.

## Browser testing

```
$ node tools/browser-smoke.mjs

94 of 94 checks passed
```

This drives the real app in Chromium. It serves the site from the **parent** directory
on purpose, so every page loads from `/phthalo-finance/` rather than the domain root.
That is the GitHub Pages project site case and it is exactly where an absolute path
would break.

### The thirteen manual steps

| # | Step | Result |
| --- | --- | --- |
| 1 | First load with empty storage | **Pass.** Five cards, net worth `£0.00`, five charts drawing a labelled empty state, no blank card, clean console. |
| 2 | Load the demo data | **Pass.** 130 entries, net worth £55,150.39, eight charts drawn, 43 bars, no chart stuck on its empty state. Titles read "Net worth up 133 percent over the last 1 year", "Cash is your largest category at 33 percent", "2 of 4 goals are behind pace". |
| 3 | Add money to three accounts | **Pass.** Net worth moved by exactly £1,750.75 across the three, every chart redrew, and the page never reloaded. |
| 4 | Withdraw, including too much | **Pass.** A normal withdrawal went through. Trying to take £999,999 from £3,961.22 showed "That takes Savings account to minus £996,037.78, which is below zero" and kept the form open. Pressing save a second time records it anyway, which a correcting entry sometimes needs. |
| 5 | Backdated entry | **Pass.** An entry dated six months back changed the line from day 209 of 391, not from today, and the end of the line moved by exactly 200000 pence. The series stayed in strict date order. |
| 6 | Edit then delete | **Pass.** The edit stored 4242 pence exactly. The delete removed exactly one entry. |
| 7 | Goal maths | **Pass.** Checked against sums done independently inside the test: percentage 40.6122 against 40.6122, amount still needed, and the per day, per week and per month rates all matched to the penny. The countdown read in plain English and the pace marker drew. |
| 8 | Custom account and visual | **Pass.** Added "Premium Bonds", confirmed every asset account still had a distinct colour, switched a gallery visual on and off, reordered the visuals, then deleted the account. The delete confirmation named the entry count and offered an export first. |
| 9 | Export, clear, import | **Pass.** JSON export downloaded as `phthalo-finance-2026-08-26.json`. CSV export had a header and a row per entry. Clearing emptied everything. Importing reproduced a byte for byte identical state. A deliberately broken file was refused with a reason and nothing was half loaded. |
| 10 | Reload | **Pass.** Accounts, entries and net worth identical to the penny after a reload. |
| 11 | 375px wide | **Pass.** No sideways scroll on any of the four tabs. Every control on every tab, and inside both sheets, measures at least 44 by 44. |
| 12 | Both themes | **Pass.** The toggle switches, all eight charts render in both, and every text token measured at or above 4.5 to 1 against both its backgrounds. |
| 13 | Console | **Pass, with one note below.** |

### Extra checks beyond the thirteen

* **Offline.** With the network disconnected the app still loads, still draws, and still
  shows the data. A price refresh with no network kept every manual price unchanged,
  showed "Prices left as they were, 5 kept the last manual price", and left the app
  fully usable.
* **Storage disabled.** With `localStorage` throwing a `SecurityError` on every call, the
  app loads, warns clearly, offers a backup download, and never throws.
* **Quota exceeded.** With writes throwing `QuotaExceededError`, the change is reported
  as not saved, a backup download is offered, and the change stays on screen.
* **Corrupt data.** Damaged JSON with no backup shows a banner, offers to download the
  damaged file, leaves the damaged value in storage rather than deleting it, and the app
  still runs. Damaged JSON *with* a good rolling backup loads the backup and says so.
* **Migration in the browser.** A version 0 object with money as floating point pounds
  was upgraded on load: pounds became integer pence, a negative amount became a
  withdrawal, the goal survived, the quantity account kept its type, and nothing was
  dropped.
* **A single account.** With one account and two entries, all eight visuals render, none
  errors, none is blank, net worth reads `£2,000.00`, and every card still carries a
  plain English title, including "Savings account holds 100 percent of your assets" and
  "No quantity based holdings yet".
* **Interface wording.** The rendered text of the home screen, header, tab bar and
  banners was scraped and checked: no em dashes, no en dashes, no hyphenated words.
* **Wide screens.** No sideways scroll at 1024px, and the grid moves to three columns.
* **Subfolder serving.** Every page above was loaded from `/phthalo-finance/`.

### The one console note

During the deliberate offline test, Chromium logs four `ERR_INTERNET_DISCONNECTED`
lines of its own for the price requests. These come from the browser's network stack,
not from the app, and no page can suppress them. The app caught every one and carried
on. Outside that deliberate test the console is completely clean: on first load, through
all thirteen steps, and after a reload.

## Known limitations, measured rather than assumed

### The palette cannot meet the 15 point rule everywhere

This was asked for and it is worth being exact about. Measured lightness gaps:

* The five categories that physically touch in the stacked allocation bar: adjacent gaps
  of 16.5, 11.2, 13.7 and 15.7 points. The smallest is **11.2**, not 15.
* The nine asset accounts, walking down the scale: smallest gap between any two is
  **4.5** points, with adjacent greyscale contrast ratios from 1.12 to 1.61.

Nine series cannot all sit 15 points apart on an eleven stop single hue scale. The stops
span about 89 lightness points, so 15 point spacing allows roughly six colours, not nine.
There is also a direct conflict in the brief: "assign account colours by walking down the
phthalo scale so that categories stay visually related" puts accounts in the same
category on *neighbouring* shades, which is the opposite of separating them by 15 points.

Categories staying visually related was treated as the assignment rule, since it was
stated as such, and the shortfall is handled where it actually matters:

* Every bar carries its name and value **directly on the chart**, so colour is never the
  only way to tell two series apart.
* Every filled shape has a hairline outline, so even the palest fill reads against a pale
  background and the darkest reads against a dark one.
* Bars are separated by whitespace. The only place segments touch is the allocation bar,
  which has the widest spacing available and direct labels.
* The debt keeps `--negative` exclusively and nothing else uses it.

### What is not covered

1. **The live price endpoints were never reached.** Outbound access to
   `api.coingecko.com`, `api.gold-api.com` and `api.frankfurter.app` is blocked in the
   environment this was built in; all three returned a proxy 403. The failure path is
   tested thoroughly, which is the part that matters for the app never breaking, and the
   parsing of a good response is tested against a stubbed `fetch`. But the endpoint URLs
   and response shapes have **not** been confirmed against the real services. Press
   "Refresh prices now" once on your phone and check the result before relying on it.
   If an endpoint has moved, only `src/prices.js` needs changing and nothing else can
   break as a result.
2. **No real device.** Everything was tested in desktop Chromium at a 375px viewport.
   No real iPhone, iPad or Android handset was involved. Touch handling, the iOS home
   screen install, and the Safari share sheet are unverified on hardware.
3. **Chromium only.** Safari and Firefox were not tested at all. The app uses no exotic
   features, but that is an expectation rather than a measurement.
4. **iOS storage eviction is not observable here.** The warning about iOS clearing the
   storage of sites not opened for a few weeks is based on documented Safari behaviour,
   not on something reproduced in testing.
5. **GitHub Pages was not deployed.** Subfolder serving was verified locally by serving
   from the parent directory, which exercises the same relative path behaviour, but no
   real Pages deployment was made and the service worker update prompt has therefore only
   been tested locally.
6. **Screen readers were not tested.** Landmarks, labels and focus order are in place and
   colour contrast is measured, but no VoiceOver or TalkBack pass was done.
7. **Very large ledgers were not profiled.** The daily series is rebuilt from the whole
   transaction history on every draw. That is deliberate, because it is what makes
   backdating correct, and it is instant with the 130 entry demo. It has not been timed
   with tens of thousands of entries.

## Running the tests yourself

```sh
node --test                      # 77 assertions, needs nothing installed
python3 -m http.server 8000      # then open http://localhost:8000/tests.html
```

The browser smoke test is a development tool and is the one thing here that needs a
dependency:

```sh
npm install -g playwright
node tools/browser-smoke.mjs
```

It writes screenshots to `tools/screenshots/`. Note that the file is deliberately **not**
called `smoke-test.mjs`: that name matches the pattern `node --test` uses to find test
files, so the unit suite would try to launch a browser and would fail anywhere Playwright
is not installed.
