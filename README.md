<p align="center">
  <img src="preview/splash.svg" alt="torlink, curated torrents straight from your terminal" style="max-width: 832px; width: 100%; height: auto;">
</p>

> A fork of [baairon/torlink](https://github.com/baairon/torlink), headlined by optional [Real-Debrid](#real-debrid-optional) support — download and stream through Real-Debrid's servers for full speed without seeders, and keep your IP off the swarm — and an optional [browser interface](#in-your-browser-optional) with the same search, streaming and recommendations as the terminal, so a seedbox or a phone works as well as a laptop. Plus a handful of quality-of-life touches: remembered preferences, search history, a source picker with an auto health-check, and an optional DNS-over-HTTPS escape hatch for blocked networks.

Finding a torrent these days sucks. One site is a minefield of fake download buttons. Another hides the real link under a popup that spawns two more tabs. And after all that, half the results are dead, zero seeders.

torlink is a torrent finder that lives in your terminal — or, if you'd rather, in your browser — with zero setup and nothing to configure. One search checks a short, curated list of reputable sources at once, and whatever you pick downloads straight to your computer. The files are yours, saved to your downloads folder.

## Get started

Download a standalone executable from [Releases](https://github.com/WarlaxZ/torlink/releases), or install the latest macOS/Linux build without Node:

```sh
curl -fsSL https://raw.githubusercontent.com/WarlaxZ/torlink/main/scripts/install.sh | sh
```

Or, with [Node 22+](https://nodejs.org), install it from npm — the command is `torlnk`:

```sh
npm install -g torlnk-rd
torlnk
```

Or run it once, without installing anything:

```sh
npx torlnk-rd
```

On the names, since there are three: the project is **torlink** — and so is your config directory and every `TORLINK_*` variable — but the command is `torlnk` and the npm package is `torlnk-rd`. Plain `torlnk` on npm is the upstream project this forked from, and npm rejects `torlink` as too similar to it, so the short spellings are the ones that were actually available.

Globally-installed copies keep themselves current: `torlnk update` pulls the latest release (and `torlnk` quietly points it out when one is available).

You can still build from source with [Node 22+](https://nodejs.org):

1. **Clone this repo** and open the folder.
2. **Install and build:**

   ```sh
   npm install
   npm run build
   ```

3. **Start it:**

   ```sh
   npm start
   ```

That's the only thing you'll type. torlink opens straight to a search bar: search for what you want, paste in a magnet link or a bare infohash, or just press Enter on an empty box to browse the curated library. From there it's all keypresses, nothing to memorize, and `?` brings up the full list anytime.

<p align="center">
  <img src="preview/help.svg" alt="torlink's keyboard help overlay: every shortcut grouped by what it does" style="max-width: 832px; width: 100%; height: auto;">
</p>

## Finding something

Type what you're looking for and press Enter. Results stream in from every source as they answer, tagged with size and how many people are sharing each one, so you can see what'll come down fast. Arrow to what you want and press `d` to save it, or `shift+d` to pick a different folder for just that download.

Press `s` to re-sort by seeders, size, or source, and `↑` in the search box to bring back a recent search. torlink remembers your sort and the tab you were on between runs, so it opens right where you left off.

On a wide enough terminal a preview pane opens beside the results: highlight a film or show and torlink fetches its poster and plot and renders them right in the terminal (bring your own free [OMDb](https://www.omdbapi.com/apikey.aspx) key, added under Accounts). Press `p` to toggle the pane, or `i` on any result to open its IMDb page.

Press `w` on any named search to add or remove it from your Saved searches. The pane keeps up to 50; press `Enter` to run one again or `x` to remove it.

A **Continue watching** section in the sidebar lists titles you're part-way through, newest first, up to 200. Each row is the title plus — when it can tell one honestly — a suggested next episode; a season pack with no episode number in its name gets no guess, and a film gets none either. (The browser's strip shows the same list with a fuller subtitle: how long ago you streamed it and the last episode you watched, which a terminal row has no room for. Nothing is missing from the terminal but recency, and the list is newest first.) `Enter` replays the same torrent that worked last time (it does nothing while another stream is still running — stop that one first), and `x` forgets the row — except while a stream is running, when `x` stops that stream instead, so a stray keypress can't kill your playback and delete a row at once. The footer says which one `x` will do. There's no resume position: torlink can't see into mpv, iina, vlc, or a browser tab, so this remembers *what* you were watching, not *where* you got to.

<p align="center">
  <img src="preview/browse.svg" alt="torlink's Movies view: the sidebar, search bar, merged results, and a preview pane showing the highlighted film's poster and plot" style="max-width: 1024px; width: 100%; height: auto;">
</p>

## Your downloads

Active downloads sit up top with their progress, speed, and time left; when one finishes it drops into Recently downloaded just below, so the list stays tidy. Everything's still there when you come back, and anything interrupted picks up where it left off.

Downloads run in the background while you keep searching, so you can queue up as many as you want. They save to your downloads folder, and the Downloads pane keeps tabs on each one; press `o` anytime to change where that is, or grab one result with `shift+d` to send it somewhere else without touching the default. When something finishes it keeps seeding automatically so the next person can find it too, and the Seeding tab lets you pause or stop that anytime.

When a torrent contains several files, torlink pauses before transferring payload data and lets you choose exactly which files to download. Use `Space` to toggle files, `a` to select all, and `Enter` to begin.

Press `Shift+L` to set download/upload limits and automatic seeding targets. Values are entered as `download KB/s, upload KB/s, ratio, minutes`; zero or empty means unlimited. Seeding pauses when either configured target is reached.

<p align="center">
  <img src="preview/downloads.svg" alt="torlink's Downloads pane: live progress on top, recently downloaded below" style="max-width: 832px; width: 100%; height: auto;">
</p>

The Seeding tab shows everything you're sharing back — live upload speed and peers for each, with `p` to pause or resume any of them.

<p align="center">
  <img src="preview/seeding.svg" alt="torlink's Seeding tab: items being shared, with upload speed, peers, and pause controls" style="max-width: 832px; width: 100%; height: auto;">
</p>

## Streaming

Don't want to wait for a download? Press **`v`** on a movie or an episode and torlink opens the largest video file straight in your media player while it downloads. The first time it'll ask which player to use (`mpv`, `iina`, `vlc`, or a path); after that it just plays. You can set one ahead of time with `TORLINK_PLAYER`.

Without Real-Debrid, streaming runs **peer-to-peer** through a local server — the pieces you're watching download to a temporary folder as they play. Because that connects you straight to the swarm, torlink warns you once that your IP is visible to peers before the first torrent stream. While it plays, a banner shows the active stream; press **`x`** to stop. If the file finished downloading by the time you stop, torlink offers to **keep** it — moving it into your downloads folder to seed — otherwise the temporary copy is cleaned up.

With a Real-Debrid account connected (below), `v` streams from Real-Debrid's servers instead: faster, no waiting on seeders, and your IP never touches the swarm. torlink takes that route automatically whenever your account is active, and only falls back to a torrent stream if you confirm it — so setting up Real-Debrid never quietly drops you onto peer-to-peer.

## Real-Debrid (optional)

torlink works great on its own, but if you have a [Real-Debrid](https://real-debrid.com) account you can plug it in for a noticeably better ride. Real-Debrid pulls the torrent onto its own servers and hands you back a plain, direct download. That means full speed even on a torrent with no seeders, nothing waiting on a swarm to wake up, and — because Real-Debrid does the torrenting, not you — your IP never touches the network.

To connect it, open the **Accounts** tab in the sidebar (alongside Downloads and Seeding), select Real-Debrid, paste your API token from [real-debrid.com/apitoken](https://real-debrid.com/apitoken), and torlink checks it and remembers it. (Prefer to keep the token off disk? Set `REALDEBRID_API_TOKEN` in your environment instead and torlink picks it up.)

<p align="center">
  <img src="preview/accounts.svg" alt="torlink's Accounts tab: Real-Debrid and RuTracker sign-in with connection status" style="max-width: 832px; width: 100%; height: auto;">
</p>

Once it's connected, downloading and streaming get an upgrade:

- **`r` — download via Real-Debrid.** torlink hands the magnet to Real-Debrid, waits for it to be ready, and downloads the direct link straight to your folder. If it's already in Real-Debrid's cache it's basically instant. The plain `d` download still works exactly as before, but now it warns you first, since that route is peer-to-peer and exposes your IP.
- **`v` — stream via Real-Debrid.** [Streaming](#streaming) now routes through Real-Debrid's servers instead of the swarm — full-speed even with no seeders, and your IP stays private. If Real-Debrid can't prepare it (or your premium's lapsed), torlink tells you and offers a torrent stream instead rather than switching to peer-to-peer on its own.

Real-Debrid torrents are fetched, not seeded, so they land in Recently downloaded and never join the Seeding tab. Heads up: Real-Debrid's torrent features need an active **premium** account — torlink will tell you if yours isn't.

## Recommendations (optional)

If you run [reccd](https://github.com/WarlaxZ/reccd) — a small, self-hosted recommendations engine — torlink can suggest what to watch next in a **For You** tab. Connect it from the **Accounts** tab: select reccd, enter its URL and the bearer token from reccd's `user:add`. (Prefer to keep it off disk? Set `TORLINK_RECC_URL` and `TORLINK_RECC_TOKEN` in your environment instead.)

### Import your history

#### From Netflix

Seed reccd with what you've already watched on Netflix, so its recommendations know your taste.

1. Open [netflix.com/viewingactivity](https://www.netflix.com/viewingactivity) and click **Download all** (bottom of the page). You'll get a CSV.
2. Import it, either way:
   - **In the app:** open the **Accounts** tab, select **reccd** (once it's connected), press **`i`**, and give it the CSV path — you can drag the file onto the terminal to paste the path.
   - **From the shell:** `torlnk import-netflix ~/Downloads/NetflixViewingActivity.csv`

torlink doesn't care what you watch — titles go only to your own reccd server to seed recommendations, and nothing else is done with them. Large exports upload in batches automatically, and re-importing the same file won't double-count anything.

#### From Trakt

Already track your watching on [Trakt](https://trakt.tv)? Pull your watch history and ratings straight in — no file needed.

- **In the app:** open the **Accounts** tab, select **reccd** (once it's connected), press **`i`**, and choose **Trakt**. You'll get a short code and a URL — open the URL, enter the code to authorize, and torlink imports automatically. After the first time you won't need to re-authorize.
- **From the shell:** `torlnk import-trakt` — it prints the code + URL, waits for you to authorize, then imports.

This needs the reccd server to have a Trakt app configured (`RECCD_TRAKT_CLIENT_ID` / `RECCD_TRAKT_CLIENT_SECRET`); without it, torlink will tell you Trakt isn't enabled on your server.

## What it searches

A short, hand-picked list of trusted sources:

| Category | Sources |
| --- | --- |
| Games | FitGirl |
| Movies | YTS, The Pirate Bay, 1337x, Torrents.csv, BitTorrented |
| TV | EZTV, The Pirate Bay, 1337x, BitTorrented |
| Anime | Nyaa, SubsPlease |
| Books | The Pirate Bay, Nyaa |
| Music | The Pirate Bay, 1337x |

**RuTracker** is available across Games, Movies, TV, Anime, Music, and Books and requires a free account. Sign in from the **Accounts** tab in the sidebar; credentials go only to rutracker.org and only the session cookie is stored locally. If asked for a captcha, follow the link and copy the code back.

Games are the only category that intentionally distributes executable software, so they come from FitGirl alone, a repacker with a long, trusted track record; the other categories are media or document files. If a source is down, the search carries on without it, and torlink tells you which one is offline. A source that keeps failing is set aside automatically for a while so it stops slowing searches down; you can also switch sources on and off yourself with `Shift+S`.

<p align="center">
  <img src="preview/sources.svg" alt="torlink's source picker: toggle any source on or off, grouped by category" style="max-width: 832px; width: 100%; height: auto;">
</p>

### Adult content (optional, off by default)

torlink ships with an optional **Porn** category that is **off by default** — its tab, sources, and results stay completely hidden until you turn it on. Press **`Shift+X`** to toggle it; when enabled you get a **Porn** tab (backed by The Pirate Bay and 1337x) and adult results also appear under **All**.

Prefer to control it without touching the app? Set `TORLINK_ADULT=1` before launching to force it on, or `TORLINK_ADULT=0` to force it off (the env var takes precedence over the in-app setting). It can also be persisted by setting `"adultContent": true` in your config file.

### Blocked by your network?

Some networks (ISPs, work Wi-Fi, some routers) quietly block torrent sites at the DNS level, so every source looks offline. If that's happening, point torlink's own lookups at a public resolver over DNS-over-HTTPS — it doesn't touch the rest of your system.

The easiest way is right in the app: press `Shift+D` and enter a resolver alias or IPs. It's saved and applied straight away, no restart. `cloudflare`, `google`, `quad9`, and `opendns` are recognised, or pass resolver IPs directly (e.g. `1.1.1.1,1.0.0.1`).

Prefer an environment variable? Set `TORLINK_DNS` before launching (it takes precedence over the in-app setting):

```sh
TORLINK_DNS=cloudflare npm start
```

## In your browser (optional)

Add `--web` and torlink also serves a browser interface — search every source (or submit an empty box to browse the curated library, same as the TUI), posters and plots, play something, the queue, your saved searches, library and continue watching, and your For You feed — over the same queue as the process hosting it. Handy for a seedbox you check from your phone, or just for using torlink without a terminal open.

```sh
torlnk --web          # the TUI hosts it; quitting the TUI stops it
torlnk serve --web    # no TUI: the add API plus the browser UI
```

`torlnk serve --web` lands on serve's own port, **`http://127.0.0.1:9161`**, and **opens your browser there for you**. `torlnk --web` lands on **`http://127.0.0.1:9162`** and prints the address on the splash — it doesn't steal focus, because you asked for a terminal UI; press **shift+w** (anywhere but the splash's search box) to open it. Change either port with `--port`. Under `serve` there's one server, not two: the same port answers the dashboard *and* `/add`, `/downloads` and `/control`, so there's one address to remember and one thing to firewall.

Pass `--headless` to `serve --web` if you'd rather it just printed the link. It also opens nothing under `--daemon`, or when stdout isn't a terminal — a browser window on a machine nobody is sitting at is not a feature.

**Turning it off is just leaving `--web` off** — there's no setting to forget about, and nothing listens until you ask for it. If the port is already taken, the TUI says so and carries on without the dashboard (the terminal is the product; a missing web UI shouldn't kill your session), while `serve --web` treats it as a startup failure and exits, because a daemon that came up half-configured is worse than one that didn't come up.

### Reaching it from another device

Binding anything other than loopback **requires** a token — torlink will not leave your queue open to the network. `serve --web` mints one for you, because it has a link to hand it to:

```sh
torlnk serve --web --host 0.0.0.0
# web ui bound to 0.0.0.0:9161 (token required)
# open on this machine:  http://127.0.0.1:9161/#k=8f3c…
# open from your LAN:    http://192.168.1.24:9161/#k=8f3c…
# api + web ui on one port, downloads -> ~/Downloads/torlink
# token 8f3c…  (pass --token to pin it across restarts)
```

The token rides in the link's `#fragment`, which never reaches the server — so it stays out of the access log and out of any `Referer`. The page adopts it and strips it from the address bar, so a screenshot or a shoulder-surfer doesn't get the secret; the token itself keeps working until the daemon restarts.

Only `serve --web` mints. `torlnk --web` — the TUI-hosted dashboard — still refuses a non-loopback bind without a token, and says so on the splash rather than exiting: minting a fresh secret every time you open your terminal UI would be a surprise, not a convenience.

A minted token is new on every start, and it's printed to stdout — which under `--daemon` is a log file, so that file is created `0600`. Pass your own token when something else talks to the API, or when you want a link that survives a restart:

```sh
torlnk --web --host 0.0.0.0 --token "$(openssl rand -hex 16)"
torlnk serve --web --host 0.0.0.0 --token "$(openssl rand -hex 16)"
```

Without `--web` there's no link to hand back, so `serve --host 0.0.0.0` still refuses to start without a token: a script needs a secret it chose, not a fresh one every boot.

Both commands read the same three flags — `--host`, `--port`, `--token` — because both are one process making one exposure decision.

> On WSL2 without mirrored networking, the LAN address printed above is your WSL VM's, and it isn't reachable from other machines until you add a `netsh interface portproxy` rule and a firewall opening on the Windows host. torlink prints the address it really bound; it can't punch through the VM's NAT for you.

#### Setting the token

Two ways, in the order torlink prefers them:

| | |
|---|---|
| `--token <secret>` | The flag. Works on `--web`, `serve` and `files` alike. |
| `TORLINK_API_TOKEN` | Environment. Keeps the secret out of your shell history and out of `ps`, which is what you want on a shared box. Used by `serve` and by `torlnk --web`; `files` reads `TORLINK_FILES_TOKEN`. |

The flag beats the environment variable. The environment variable is only consulted when you actually pass `--web`, so a `TORLINK_API_TOKEN` you exported for the daemon doesn't quietly become a password on your interactive session.

There's no token in the config file on purpose: `config.json` is world-readable in your home directory, and a shared secret doesn't belong there.

You enter the token once in the browser, or follow a link that carries it. Either way it's kept in `sessionStorage` and sent as an `Authorization` header on every request — no cookie authenticates the API, so there's nothing for a hostile page to forge on your behalf. (The live-updates stream is the one exception: browsers can't attach headers to an `EventSource`, so it passes the token in the query string, and that route is read-only.)

On loopback with no token there is no credential at all, so requests that *change* something (`add`, `control`, `saved-searches`, `continue-watching`, `library`) are refused when the browser says they came from another origin — a page you happen to be visiting can't quietly tell your torlink to delete a download, or add or remove something from your saved lists. Only positive evidence counts: `curl` and scripts, which send no `Origin` or `Sec-Fetch-Site`, keep working exactly as before.

### From outside your network

**Don't port-forward this to the internet.** Two reasonable options:

- **[Tailscale](https://tailscale.com)** — simpler, and what I'd recommend. Bind your tailnet address and reach it from any of your devices with nothing exposed publicly.
- **A reverse proxy** terminating TLS in front of it, if you already run one.

The dashboard itself is fine behind a proxy — every URL it uses is relative. The one thing to watch is the **Download .m3u** button, which has to write an absolute URL into the playlist file. It builds that from the `Host` header, so it's correct as long as your proxy passes `Host` through (Caddy does by default; nginx needs `proxy_set_header Host $host`). `X-Forwarded-Host` and `X-Forwarded-Proto` are deliberately ignored — trusting them unconditionally would let any client poison the generated URL — so a proxy that rewrites `Host` instead will produce a playlist pointing at the wrong address until a `--trust-proxy` flag exists.

### Posters

Posters are fetched once and cached on disk. The browser gets the full-quality image; the TUI half-blocks that same cached file, so turning the web UI on makes terminal browsing slightly faster too. The cache is capped, pruned oldest-first, and safe to delete at any time.

Poster fetches are restricted to a small allowlist of known image CDNs, re-checked on every redirect hop — a refusal is logged at `warn` level.

### Searching

The browser searches every source the TUI does, and results stream in as each one answers — you'll see `12/23 sources` climb rather than staring at a spinner. Category tabs, sort orders and the alive-only filter are the same code the terminal uses, so the two never disagree about what a result is or how the list is ordered.

Selecting a result shows its poster, plot and IMDb link, if you've added a free [OMDb](https://www.omdbapi.com/apikey.aspx) key under **Accounts** in the TUI — the same key that powers the terminal's preview pane. Without one everything still works; you just get the release names.

From a result you can **add** it to the queue, **add via RD** where Real-Debrid is configured, or **play** it straight away.

### Playing something

Hit **play** on any row. torlnk resolves the torrent — through Real-Debrid if you have it, otherwise straight from the swarm — picks the video file (or asks, if there are several), and opens a player page.

What happens next depends on the release, and it's worth knowing why:

- **mp4/H.264** plays inline. The video element streams it directly, and seeking works properly because the server honours range requests.
- **mkv, HEVC, DTS** — most of the scene — will not decode in Chrome or Firefox. No browser ships those codecs. Rather than showing you a black rectangle, the page says so and offers a **Download .m3u** button: your OS hands that tiny playlist to VLC (or whatever your default player is) and it plays there. On iOS and Android you also get a direct VLC link.

There's no transcoding. torlnk will not burn your CPU re-encoding a 4K remux so a browser can play it; the `.m3u` route is faster, lossless, and works on every platform.

With Real-Debrid the player redirects straight to their CDN, so the video never passes through the machine running torlnk — you get their bandwidth and native seeking. Without it, the bytes are proxied from the local torrent client, which is what makes a phone on your LAN able to play a swarm it can't reach itself.

### For You

If you've connected [reccd](#recommendations-optional), the **for you** tab shows the same recommendations the TUI does — poster, year, and why it picked each one ("because you liked Harrowgate"). Rate a pick watched, liked or disliked, **save search** to add it to your Saved searches, or hand it straight to the search pane — the same choice the terminal's `w` makes on a For You pick, so a pick you rate here and one you rate in the terminal land in the same place. Ratings feed back into reccd exactly as they do from the terminal.

A **continue watching** strip sits above the saved pane's two columns: whatever you're part-way through, newest first, same 200-item list the terminal keeps (streaming from either surface writes the same file). Each row's subtitle gives the age, the last episode you watched, and a suggested next episode where one can be told honestly. **Play** replays the remembered torrent — falling back to a fresh search if that swarm's gone quiet — and the ✕ removes the row.

### What it doesn't do yet

- **No restarting a stopped seed.** Stopping one drops it out of the status payload into history, which the browser can't see.
- **No subtitles, no scrubber, no automatic next-episode playback.** Continue watching (above) remembers *what* you were watching and, when it can, names what's next — it cannot resume *where* you left off, or start that next episode for you, because nothing here reads back from mpv, iina, vlc, or a browser tab; none of them report a position.
- **No settings UI.** Tokens, sources, limits and folders are set in the TUI only — the browser reads that config but has no page for it. It does write three things: your saved searches, your library, and your continue-watching list (the same searches, favourites and stream history the TUI's `w`, `b`, and Continue-watching pane create), all guarded by the same Origin check as `add` and `control`.

### Working on the web UI

The dashboard is served from `dist/web`, **not** `src`. Edit anything under `src/web/static/`, reload, and you'll get silently stale assets — it reads exactly like a browser cache bug, so it's easy to lose twenty minutes in devtools before suspecting the build. Rerun `npm run build` after any change there. `npm run dev` only re-executes the server's TypeScript; it does not rebuild the browser bundle.

## Without the TUI

torlink also runs with no terminal UI at all, for servers and seedboxes:

    torlnk watch <dir>    download anything dropped into a folder
    torlnk serve          take magnets over HTTP
    torlnk files [dir]    stream finished downloads over HTTP
    torlnk attach         keep the TUI alive across ssh sessions
    torlnk import-netflix <csv>   send a Netflix viewing-activity CSV to reccd
    torlnk import-trakt           connect Trakt and import your history into reccd

Add `--daemon` to keep watch, serve, or files running after you log out, or `--web` to `serve` for the [browser dashboard](#in-your-browser-optional) on the same port as the add API; `torlnk --help` has the full list of modes and flags.

## Contributing

To run or work on torlink locally:

1. Clone the repository and open the folder.
2. Install dependencies:
   ```sh
   npm install
   ```
3. Run the development version:
   ```sh
   npm run dev
   ```
   Or build it and run the bundled version:
   ```sh
   npm run build
   npm start
   ```

Before opening a PR, skim [CONTRIBUTING.md](CONTRIBUTING.md); it lays out the bar with examples from real merged PRs.

## Privacy

Your files stay on your disk, and nothing routes through a central server; torlink only talks to the torrent network directly. Once a download finishes it keeps seeding by default, sharing it back so the next person can find it just as easily. The network only works because people pass things along, and even a few minutes makes a real difference. If you'd rather not, opt out anytime: open the Seeding tab, press `p` to pause or stop any item, and press it again to pick it back up. Always your call.

For a fail-closed VPN setup, press `Shift+V` and enter the VPN interface name (`tun0`, `utun4`, or the Windows interface alias). Before any P2P download or stream starts, torlink verifies that the interface exists and owns the default route. It continues monitoring once per second and tears down active P2P sessions if that route changes. Real-Debrid transfers are unaffected. This is a route kill switch, not a replacement for firewall-level VPN rules.

## Star History

<a href="https://www.star-history.com/?repos=WarlaxZ%2Ftorlink&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=WarlaxZ/torlink&type=date&theme=dark&legend=top-left&sealed_token=Yg4hUUad3yejtB59ol_9oa_txdk4yd_bnxalz7CMThT9SC9a-Wp0KGwr9kC5xkEDdh8NmVay3FEDNWRn7rzyua2XNIWZbPlRBKVhZBceS-_c0I17OmC4iPLdpvYczXgUs25ywnA4Xc2llpJ6bOcfu8y91CtmGj9qVOjlyMRsIzkGkABQvYWO2whetowq" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=WarlaxZ/torlink&type=date&legend=top-left&sealed_token=Yg4hUUad3yejtB59ol_9oa_txdk4yd_bnxalz7CMThT9SC9a-Wp0KGwr9kC5xkEDdh8NmVay3FEDNWRn7rzyua2XNIWZbPlRBKVhZBceS-_c0I17OmC4iPLdpvYczXgUs25ywnA4Xc2llpJ6bOcfu8y91CtmGj9qVOjlyMRsIzkGkABQvYWO2whetowq" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=WarlaxZ/torlink&type=date&legend=top-left&sealed_token=Yg4hUUad3yejtB59ol_9oa_txdk4yd_bnxalz7CMThT9SC9a-Wp0KGwr9kC5xkEDdh8NmVay3FEDNWRn7rzyua2XNIWZbPlRBKVhZBceS-_c0I17OmC4iPLdpvYczXgUs25ywnA4Xc2llpJ6bOcfu8y91CtmGj9qVOjlyMRsIzkGkABQvYWO2whetowq" />
 </picture>
</a>
