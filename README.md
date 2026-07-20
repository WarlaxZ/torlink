<p align="center">
  <img src="preview/splash.svg" alt="torlink, curated torrents straight from your terminal" style="max-width: 832px; width: 100%; height: auto;">
</p>

> A fork of [baairon/torlink](https://github.com/baairon/torlink) with some extra quality-of-life touches — remembered preferences, search history, a source picker with an auto health-check, and an optional DNS-over-HTTPS escape hatch for blocked networks.

Finding a torrent these days sucks. One site is a minefield of fake download buttons. Another hides the real link under a popup that spawns two more tabs. And after all that, half the results are dead, zero seeders.

torlink is a torrent finder that lives in your terminal, with zero setup and nothing to configure. One search checks a short, curated list of reputable sources at once, and whatever you pick downloads straight to your computer. The files are yours, saved to your downloads folder.

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

## Finding something

Type what you're looking for and press Enter. Results stream in from every source as they answer, tagged with size and how many people are sharing each one, so you can see what'll come down fast. Arrow to what you want and press `d` to save it, or `shift+d` to pick a different folder for just that download.

Press `s` to re-sort by seeders, size, or source, and `↑` in the search box to bring back a recent search. torlink remembers your sort and last category between runs, so it opens right where you left off.

Press `w` on any named search to add or remove it from your Watchlist. The Watchlist pane keeps up to 50 saved searches; press `Enter` to run one again or `x` to remove it.

<p align="center">
  <img src="preview/browse.svg" alt="torlink's browse view: the sidebar, the search bar, and merged results from every source" style="max-width: 832px; width: 100%; height: auto;">
</p>

## Your downloads

Active downloads sit up top with their progress, speed, and time left; when one finishes it drops into Recently downloaded just below, so the list stays tidy. Everything's still there when you come back, and anything interrupted picks up where it left off.

Downloads run in the background while you keep searching, so you can queue up as many as you want. They save to your downloads folder, and the Downloads pane keeps tabs on each one; press `o` anytime to change where that is, or grab one result with `shift+d` to send it somewhere else without touching the default. When something finishes it keeps seeding automatically so the next person can find it too, and the Seeding tab lets you pause or stop that anytime.

When a torrent contains several files, torlink pauses before transferring payload data and lets you choose exactly which files to download. Use `Space` to toggle files, `a` to select all, and `Enter` to begin.

Press `Shift+L` to set download/upload limits and automatic seeding targets. Values are entered as `download KB/s, upload KB/s, ratio, minutes`; zero or empty means unlimited. Seeding pauses when either configured target is reached.

<p align="center">
  <img src="preview/downloads.svg" alt="torlink's Downloads pane: live progress on top, recently downloaded below" style="max-width: 832px; width: 100%; height: auto;">
</p>

## Streaming

Don't want to wait for a download? Press **`v`** on a movie or an episode and torlink opens the largest video file straight in your media player while it downloads. The first time it'll ask which player to use (`mpv`, `iina`, `vlc`, or a path); after that it just plays. You can set one ahead of time with `TORLINK_PLAYER`.

Without Real-Debrid, streaming runs **peer-to-peer** through a local server — the pieces you're watching download to a temporary folder as they play. Because that connects you straight to the swarm, torlink warns you once that your IP is visible to peers before the first torrent stream. While it plays, a banner shows the active stream; press **`x`** to stop. If the file finished downloading by the time you stop, torlink offers to **keep** it — moving it into your downloads folder to seed — otherwise the temporary copy is cleaned up.

With a Real-Debrid account connected (below), `v` streams from Real-Debrid's servers instead: faster, no waiting on seeders, and your IP never touches the swarm. torlink takes that route automatically whenever your account is active, and only falls back to a torrent stream if you confirm it — so setting up Real-Debrid never quietly drops you onto peer-to-peer.

## Real-Debrid (optional)

torlink works great on its own, but if you have a [Real-Debrid](https://real-debrid.com) account you can plug it in for a noticeably better ride. Real-Debrid pulls the torrent onto its own servers and hands you back a plain, direct download. That means full speed even on a torrent with no seeders, nothing waiting on a swarm to wake up, and — because Real-Debrid does the torrenting, not you — your IP never touches the network.

To connect it, open the **Accounts** tab in the sidebar (alongside Downloads and Seeding), select Real-Debrid, paste your API token from [real-debrid.com/apitoken](https://real-debrid.com/apitoken), and torlink checks it and remembers it. (Prefer to keep the token off disk? Set `REALDEBRID_API_TOKEN` in your environment instead and torlink picks it up.)

Once it's connected, downloading and streaming get an upgrade:

- **`r` — download via Real-Debrid.** torlink hands the magnet to Real-Debrid, waits for it to be ready, and downloads the direct link straight to your folder. If it's already in Real-Debrid's cache it's basically instant. The plain `d` download still works exactly as before, but now it warns you first, since that route is peer-to-peer and exposes your IP.
- **`v` — stream via Real-Debrid.** [Streaming](#streaming) now routes through Real-Debrid's servers instead of the swarm — full-speed even with no seeders, and your IP stays private. If Real-Debrid can't prepare it (or your premium's lapsed), torlink tells you and offers a torrent stream instead rather than switching to peer-to-peer on its own.

Real-Debrid torrents are fetched, not seeded, so they land in Recently downloaded and never join the Seeding tab. Heads up: Real-Debrid's torrent features need an active **premium** account — torlink will tell you if yours isn't.

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

### Blocked by your network?

Some networks (ISPs, work Wi-Fi, some routers) quietly block torrent sites at the DNS level, so every source looks offline. If that's happening, point torlink's own lookups at a public resolver over DNS-over-HTTPS — it doesn't touch the rest of your system.

The easiest way is right in the app: press `Shift+D` and enter a resolver alias or IPs. It's saved and applied straight away, no restart. `cloudflare`, `google`, `quad9`, and `opendns` are recognised, or pass resolver IPs directly (e.g. `1.1.1.1,1.0.0.1`).

Prefer an environment variable? Set `TORLINK_DNS` before launching (it takes precedence over the in-app setting):

```sh
TORLINK_DNS=cloudflare npm start
```

## Headless

torlink also runs without the TUI, for servers and seedboxes:

    torlnk watch <dir>    download anything dropped into a folder
    torlnk serve          take magnets over HTTP
    torlnk files          stream finished downloads over HTTP
    torlnk attach         keep the TUI alive across ssh sessions

Add `--daemon` to keep watch, serve, or files running after you log out; `torlnk --help` has the full list of modes and flags.

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
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=WarlaxZ/torlink&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=WarlaxZ/torlink&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=WarlaxZ/torlink&type=date&legend=top-left" />
 </picture>
</a>
