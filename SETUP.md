# Setting it up

Two parts. First get the code onto GitHub and switch on Pages. Then install the app to
your phone.

## Where the code is right now

This project was built in a temporary cloud container, which gets wiped once the session
ends. So that nothing was lost, the whole thing, with its commit history, was pushed to a
branch of the only repository that session could reach:

* Repository: `GabPuccini/CristianoRonaldo_Stats`
* Branch: `claude/phthalo-finance-tracker-q0epur`

**That branch is not part of the Cristiano Ronaldo site.** It shares no history with
`master`, nothing in that project was touched, and the branch holds only Phthalo Finance
at its root. Do not merge it into `master`. It is a parking space, nothing more.

To get the project onto your own machine as a standalone repository:

```sh
git clone -b claude/phthalo-finance-tracker-q0epur --single-branch \
  https://github.com/GabPuccini/CristianoRonaldo_Stats.git phthalo-finance
cd phthalo-finance
git remote remove origin
```

You now have the folder, the files and the commit history, with no remote attached. Carry
on with part one below to give it a repository of its own. Once that is done the parking
branch can be deleted:

```sh
git push https://github.com/GabPuccini/CristianoRonaldo_Stats.git \
  --delete claude/phthalo-finance-tracker-q0epur
```

## Part one: the GitHub repository

### Create the repository

Go to <https://github.com/new> and create a repository under the `GabPuccini` account:

* **Repository name:** `phthalo-finance`
* **Visibility:** private is fine. GitHub Pages works on a private repository on a paid
  plan; on the free plan the repository has to be public for Pages to serve it.
* **Do not** tick "Add a README file", "Add .gitignore" or "Choose a license". The
  folder already has everything, and an extra commit on the remote just gets in the way.

### Push the code

From inside the `phthalo-finance` folder:

```sh
cd phthalo-finance
git remote add origin https://github.com/GabPuccini/phthalo-finance.git
git branch -M main
git push -u origin main
```

If the folder is not a git repository yet, or you are starting from a copy:

```sh
cd phthalo-finance
git init -b main
git add -A
git commit -m "Phthalo Finance"
git remote add origin https://github.com/GabPuccini/phthalo-finance.git
git push -u origin main
```

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
git add -A
git commit -m "What changed"
git push
```

**One thing to remember every time.** Open `sw.js` and bump `CACHE_VERSION` before you
push:

```js
const CACHE_VERSION = 'v2';   // was v1
```

The service worker serves the cached copy first so the app works offline. If the version
does not change, an installed copy can keep serving the old files indefinitely. Bumping
it makes the app notice the new version, delete the old cache and offer you a
"new version is ready" prompt rather than silently staying stale. This is the single
most common thing that goes wrong with a PWA.

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

* **Data tab, Export to JSON.** One file holding everything. Keep it somewhere that is
  not the phone.
* **Data tab, Import from JSON.** Reads a backup and replaces what is in the app. Bad
  files are refused outright with a reason, never half loaded.
* **Data tab, Export to CSV.** Every transaction as a spreadsheet, for Excel or Numbers.

Moving to a new phone is export on the old one, install on the new one, import.

## If something goes wrong

**The page is blank or the styling is missing.** Almost always a stale service worker.
Bump `CACHE_VERSION` in `sw.js`, push, then in the browser clear the site data and
reload.

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
