<p align="center">
  <img src="preview/splash.svg" alt="torlink, curated torrents straight from your terminal" style="max-width: 832px; width: 100%; height: auto;">
</p>

Finding a torrent these days sucks. One site is a minefield of fake download buttons. Another hides the real link under a popup that spawns two more tabs. And after all that, half the results are dead, zero seeders.

torlink is a torrent finder that lives in your terminal, with zero setup and nothing to configure. One search checks a short, curated list of reputable sources at once, and whatever you pick downloads straight to your computer. The files are yours, saved to your downloads folder.

## Get started

1. **Install Node** (from [nodejs.org](https://nodejs.org)), it's all torlink needs.
2. **Open your terminal.**
3. **Start it:**

   ```sh
   npx torlnk
   ```

That's the only thing you'll type. torlink opens straight to a search bar: search for what you want, paste in a magnet link, or just press Enter on an empty box to browse the curated library. From there it's all keypresses, nothing to memorize, and `?` brings up the full list anytime.

## Finding something

Type what you're looking for and press Enter. Results stream in from every source as they answer, tagged with size and how many people are sharing each one, so you can see what'll come down fast. Arrow to what you want and press `d` to save it.

<p align="center">
  <img src="preview/browse.svg" alt="torlink's browse view: the sidebar, the search bar, and merged results from every source" style="max-width: 832px; width: 100%; height: auto;">
</p>

## Your downloads

Active downloads sit up top with their progress, speed, and time left; when one finishes it drops into Recently downloaded just below, so the list stays tidy. Everything's still there when you come back, and anything interrupted picks up where it left off.

Downloads run in the background while you keep searching, so you can queue up as many as you want. They save to your downloads folder, and the Downloads pane keeps tabs on each one. When something finishes it keeps seeding automatically so the next person can find it too, and the Seeding tab lets you pause or stop that anytime.

<p align="center">
  <img src="preview/downloads.svg" alt="torlink's Downloads pane: live progress on top, recently downloaded below" style="max-width: 832px; width: 100%; height: auto;">
</p>

## Real-Debrid (optional)

torlink works great on its own, but if you have a [Real-Debrid](https://real-debrid.com) account you can plug it in for a noticeably better ride. Real-Debrid pulls the torrent onto its own servers and hands you back a plain, direct download. That means full speed even on a torrent with no seeders, nothing waiting on a swarm to wake up, and — because Real-Debrid does the torrenting, not you — your IP never touches the network.

Connecting it is two keys. Press `k`, paste your API token from [real-debrid.com/apitoken](https://real-debrid.com/apitoken), and torlink checks it and remembers it. (Prefer to keep the token off disk? Set `REALDEBRID_API_TOKEN` in your environment instead and torlink picks it up.)

Once it's connected, every result gains two new moves:

- **`r` — download via Real-Debrid.** torlink hands the magnet to Real-Debrid, waits for it to be ready, and downloads the direct link straight to your folder. If it's already in Real-Debrid's cache it's basically instant. The plain `d` download still works exactly as before, but now it warns you first, since that route is peer-to-peer and exposes your IP.
- **`v` — stream it.** For a movie or an episode, skip the download entirely: torlink resolves the largest video file and opens it in your media player. The first time, it'll ask which player to use (`mpv`, `iina`, `vlc`, or a path); after that it just plays. You can also set one ahead of time with `TORLINK_PLAYER`.

Real-Debrid torrents are fetched, not seeded, so they land in Recently downloaded and never join the Seeding tab. Heads up: Real-Debrid's torrent features need an active **premium** account — torlink will tell you if yours isn't.

## What it searches

A short, hand-picked list of trusted sources:

| Category | Sources |
| --- | --- |
| Games | FitGirl |
| Movies | YTS, The Pirate Bay, 1337x |
| TV | EZTV, SolidTorrents, The Pirate Bay, 1337x |
| Anime | Nyaa, SubsPlease |

Games are the only category that can run code, so they come from FitGirl alone, a repacker with a long, trusted track record; everything else is plain video and subtitles. If a source is down, the search carries on without it, and torlink tells you which one is offline.

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
   npx torlnk
   ```

Before opening a PR, skim [CONTRIBUTING.md](CONTRIBUTING.md); it lays out the bar with examples from real merged PRs.

## Privacy

Your files stay on your disk, and nothing routes through a central server; torlink only talks to the torrent network directly. Once a download finishes it keeps seeding by default, sharing it back so the next person can find it just as easily. The network only works because people pass things along, and even a few minutes makes a real difference. If you'd rather not, opt out anytime: open the Seeding tab, press `p` to pause or stop any item, and press it again to pick it back up. Always your call.

## Star History

<a href="https://www.star-history.com/?repos=baairon%2Ftorlink&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=baairon/torlink&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=baairon/torlink&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=baairon/torlink&type=date&legend=top-left" />
 </picture>
</a>
