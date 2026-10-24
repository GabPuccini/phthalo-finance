# Setting it up

Two parts. First get the code onto GitHub and switch on Pages. Then install the app to
your phone.

## Where the code is

This is the repository. `https://github.com/GabPuccini/phthalo-finance`

While it was being built there was a copy parked on a branch of another repository,
because the build session could not reach anywhere else. That copy is no longer needed
and can be deleted whenever you like:

```sh
git push https://github.com/GabPuccini/CristianoRonaldo_Stats.git \
  --delete claude/phthalo-finance-tracker-q0epur
```

Nothing in the Cristiano Ronaldo project was ever changed. That branch only ever added a
folder, and deleting it removes the folder with it.

## Part one: switching on GitHub Pages

The repository exists and the code is already in it, on the `main` branch. The only step
left is telling GitHub to serve it.

### Getting the code onto your own machine

```sh
git clone https://github.com/GabPuccini/phthalo-finance.git
cd phthalo-finance
```

That is all. There is nothing to install and nothing to build.

### Switch on GitHub Pages

1. Open <https://github.com/GabPuccini/phthalo-finance/settings/pages>
2. Under **Source**, choose **Deploy from a branch**
3. Set **Branch** to `main` and the folder to `/ (root)`
4. Press **Save**

Give it a minute or two, then the app is at:

<https://gabpuccini.github.io/phthalo-finance/>

The `.nojekyll` file in the root is already there. Without it GitHub would run the files
through Jekyll, which ignores folders beginning with an underscore and can quietly break
a static site.

### Deploying a change later

```sh
node tools/stamp-sw.mjs
node --test
git add -A
git commit -m "What changed"
git push
```

**The first line matters every time.** An installed copy only notices a new release when
`sw.js` itself changes. `tools/stamp-sw.mjs` sets `CACHE_VERSION` in `sw.js` from a hash of
every file the app caches, so it changes exactly when they do. Forget it and `node --test`
fails with a message telling you to run it, so a release cannot slip out under the old
version and be served stale forever, which is the single most common way a PWA goes wrong.

Once pushed, an installed copy shows "A new version is ready" the next time it is opened
or brought back on screen. Tapping Reload now switches over; your data is not affected.

## Part two: installing it on your phone

Open <https://gabpuccini.github.io/phthalo-finance/> on the phone first, and let it
finish loading once. That first load is what fills the offline cache.

### iPhone and iPad, from Safari

It has to be Safari. Chrome and Firefox on iOS cannot add a web app to the home screen.

1. Open the address in **Safari**
2. Tap the **Share** button, the square with an arrow coming out of it, at the bottom of
   the screen
3. Scroll down the list and tap **Add to Home Screen**
4. The name will already say "Phthalo". Tap **Add** in the top right

The icon appears on your home screen and opens without the Safari address bar.

**Do this rather than leaving it as a bookmark.** iOS clears the storage of ordinary
websites you have not visited for a few weeks. A web app on the home screen is treated
differently and keeps its data. The app will remind you about this once on your first
visit.

### Android, from Chrome

1. Open the address in **Chrome**
2. Chrome usually offers an **Install app** prompt at the bottom. If it does, tap it
3. If it does not, tap the three dots menu in the top right and choose **Install app**,
   or **Add to Home screen**
4. Confirm with **Install**

### Checking the install worked

* The app should open without a browser address bar
* Turn on flight mode and open it again. It should still load and still show your data
* Open <https://gabpuccini.github.io/phthalo-finance/tests.html> on the phone. Every
  line should be green

## Getting your data on and off

Everything lives in that one browser, so a backup is worth taking.

* **Settings, Export to JSON.** One file holding everything, the plan included. Keep it
  somewhere that is not the phone.
* **Settings, Import from JSON.** Reads a backup and replaces what is in the app. Bad
  files are refused outright with a reason, never half loaded.
* **Settings, Export to CSV.** Every transaction as a spreadsheet, for Excel or Numbers.

Moving to a new phone is export on the old one, install on the new one, import.

On an iPhone the copy on the home screen keeps its own storage, separate from Safari. If
you entered your data in Safari first, export it there and import it into the installed
app once.

## Setting up the plan

Open the Plan tab and choose **Set up the house plan**. It builds the ten year plan to a
house in October 2031 and links each line to the matching account: the Lifetime ISA, the
Stocks and Shares ISA, the savings account, gold, silver, every crypto account and the
debt. Lines with no account yet, such as the house deposit pot or the pension, follow the
plan's own figures until you add an account and tick it on the line.

A few things make the comparison fair:

* **Record the loan as it really stands.** A debt account only moves with what you
  record, so either add each month's interest to it or set it to the figure on the
  lender's statement. Recording only the payments makes the loan look smaller than it is.
* **Link an account only once it has entries.** A linked account with nothing recorded is
  left out of the comparison rather than read as empty.
* **The forecast starts next month.** It assumes this month's amounts are already in, so
  pay in, record it, and the forecast moves straight away.

The first time the new release opens it upgrades your saved data to version 2 and says
so in a note. Nothing existing changes; the plan is added beside it.

## If something goes wrong

**The page is blank or the styling is missing.** Almost always a stale service worker.
Run `node tools/stamp-sw.mjs`, push, then reload. If it persists, clear the site data in
the browser settings, but export a backup first, because clearing site data also
removes what you have saved.

**Pages says 404.** Give it two or three minutes after the first push. Check the branch
and folder are `main` and `/ (root)` in the Pages settings.

**The install option never appears.** The site must be served over HTTPS, which
github.io is, and the manifest and icons must load. Open the address, then check the
browser developer tools application panel for the manifest.

**A chart looks wrong.** Open `tests.html` on the same device. If those pass, the sums
are right and the problem is in the drawing, so it is worth reporting with a screenshot.

**Prices will not refresh.** That is fine and by design. The app keeps whatever price
you last typed in, marks it as stale with the date, and carries on. Manual entry is the
source of truth; the refresh button is only ever a convenience.
