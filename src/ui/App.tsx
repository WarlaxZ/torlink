import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout, useStdin } from "ink";
import { promises as fs } from "node:fs";
import os from "node:os";
import { randomBytes } from "node:crypto";
import {
  loadConfig,
  saveConfig,
  resolveDebridTokenFor,
  resolveActiveDebrid,
  resolveMediaPlayer,
  resolveDnsServers,
  resolveReccConfig,
  resolveOmdbApiKey,
  resolveAdultContent,
  resolveAdultScreenshots,
  resolveCloudflareAccess,
  isCloudflareAccessHalfConfigured,
  qualityPrefsFrom,
  type Config,
  type FavouriteItem,
} from "../config/config";
import {
  pickBestRelease,
  pickStatusLine,
  pickSearchingLine,
  pickNoneLine,
  type PickIntent,
  type FeatureId,
  type MaxResolution,
} from "../util/releasePick";
import { runSearch } from "../core/search";
import { enabledSources } from "../sources/registry";
import { setDnsServers } from "../util/dns";
import { expandHome, normalizeDownloadDir } from "../config/folder";
import type { DebridProviderId, DebridStatus } from "../integrations/debrid/types";
import { getDebridProvider, DEBRID_PROVIDER_IDS } from "../integrations/debrid";
import { attemptAutoPlay, detectAndPlay, launchPlayer, streamCandidates } from "../util/player";
import { preferredSubtitle, subtitlesFor } from "../util/subtitleFiles";
import { subtitleArgs } from "../util/subtitleFlags";
import type { ResolvedFile } from "../integrations/debrid/realdebrid";
import { streamTorrent, type TorrentStreamSession } from "../integrations/torrentStream";
import { postEvent, claimReccAccount } from "../recc/client";
import { ensureReccAccount } from "../recc/provision";
import { uploadNetflixCsv } from "../recc/netflixImport";
import { runTraktFlow, type TraktStatus } from "../recc/traktImport";
import { classifyStreamRoute } from "../core/streamRoute";
import { cachedHashesFor } from "../core/cachedHashes";
import {
  forgetStreamHistory,
  historyItemFor,
  loadStreamHistory,
  nextEpisode,
  recordPlayedFile,
  recordStream,
  removeStreamHistory,
  saveStreamHistory,
  type StreamHistoryItem,
} from "../core/streamHistory";
import { nextEpisodeIndex, packTargetFor, type PackTarget } from "../util/nextEpisodeFile";
import { keepMovePlan, moveKeptFiles } from "./streamKeep";
import { DownloadQueue } from "../download/queue";
import { loadQueue, loadSeeds } from "../download/persist";
import { loadHistory } from "../download/history";
import { reconcileQueue } from "../download/reconcile";
import {
  BOOT_SETTLE_MS,
  armBootMarker,
  disarmBootMarker,
  wasBootInterrupted,
} from "../download/bootguard";
import { logCrash } from "../util/crashlog";
import { parseInput } from "../sources/magnet";
import { magnetFromTorrentFile } from "../sources/torrentFile";
import { readClipboard, writeClipboard } from "../util/clipboard";
import { openFolder } from "../util/openFolder";
import { openUrl } from "../util/openUrl";
import { prepareLine } from "../util/prepareLine";
import { cleanText, formatBytes, truncate } from "../util/format";
import { castClock } from "../util/castStatus";
import { isCategory, parseSection } from "./store";
import {
  StoreContext,
  type CaptureMode,
  type CastRowStatus,
  type DownloadFocus,
  type Region,
  type ResultFocus,
  type Section,
  type SeedFocus,
  type Store,
  type View,
} from "./store";
import { formatSort, parseSort, type Sort } from "./sort";
import { addToHistory } from "./searchHistory";
import { toggleSavedSearches } from "../util/savedSearchList";
import {
  toggleFavourite as toggleFavouriteList,
  removeFavourite as removeFavouriteFromList,
  isFavourited as isFavouritedIn,
  watchedFor,
  markWatched,
} from "../util/favouriteList";
import { toggleDisabledSource } from "../sources/registry";
import { Logo } from "./components/Logo";
import { DebridBadge } from "./components/DebridBadge";
import { Sidebar, RAIL_WIDTH } from "./components/Sidebar";
import { Rule } from "./components/Rule";
import { Footer } from "./components/Footer";
import { HelpOverlay, helpContentHeight } from "./components/HelpOverlay";
import { Results } from "./components/Results";
import { Downloads } from "./components/Downloads";
import { Seeding } from "./components/Seeding";
import { Spinner } from "./components/Spinner";
import { TabTitle } from "./components/TabTitle";
import { Splash, type SplashWebStatus } from "./views/Splash";
import { FolderPrompt } from "./components/FolderPrompt";
import { TokenPrompt } from "./components/TokenPrompt";
import { ConfirmPrompt } from "./components/ConfirmPrompt";
import { StreamPlayerPrompt } from "./components/StreamPlayerPrompt";
import { StreamFilePrompt } from "./components/StreamFilePrompt";
import { CastPrompt } from "./components/CastPrompt";
import { SourcesPrompt } from "./components/SourcesPrompt";
import { QualityPrompt } from "./components/QualityPrompt";
import { DnsPrompt } from "./components/DnsPrompt";
import { RutrackerPrompt, type LoginStatus } from "./components/RutrackerPrompt";
import { ReccdPrompt } from "./components/ReccdPrompt";
import { ReccClaimPrompt } from "./components/ReccClaimPrompt";
import { OmdbPrompt } from "./components/OmdbPrompt";
import { NetflixImportPrompt, type NetflixImportView } from "./components/NetflixImportPrompt";
import { TraktImportPrompt, type TraktImportView } from "./components/TraktImportPrompt";
import { ImportSourcePrompt, type ImportSource } from "./components/ImportSourcePrompt";
import { checkReccConnection, type ReccStatus } from "../recc/status";
import { Settings } from "./components/Settings";
import { SavedSearches } from "./components/SavedSearches";
import { Favourites } from "./components/Favourites";
import { ContinueWatching } from "./components/ContinueWatching";
import { ForYou } from "./components/ForYou";
import { TrackersPrompt } from "./components/TrackersPrompt";
import { DownloadFilePrompt } from "./components/DownloadFilePrompt";
import { LimitsPrompt, type TransferLimits } from "./components/LimitsPrompt";
import { VpnPrompt } from "./components/VpnPrompt";
import { CastAddressPrompt } from "./components/CastAddressPrompt";
import { RatePrompt } from "./components/RatePrompt";
import { footerHints } from "./keymap";
import { COLOR, ICON } from "./theme";
import { useMouseWheel } from "./hooks/useMouseWheel";
import { VERSION } from "../version";
import { fetchLatestVersion, isNewer } from "../update/version";
import type { SourceId } from "../sources/types";
import type { QueueItem } from "../download/types";
import {
  login as rutrackerLogin,
  getSession as getRutrackerSession,
  loadSession as loadRutrackerSession,
  clearSession as clearRutrackerSession,
  type Captcha,
} from "../sources/rutracker/session";
import { clearRutrackerCache } from "../sources/rutracker";
import { clearCacheByPrefix } from "../sources/cache";
import { vpnRouteIsSafe } from "../util/vpn";
import { StreamSessionRegistry } from "../core/streamSession";
import { CastSessionRegistry } from "../core/cast/session";
import { parseManualDevice, type CastDevice } from "../core/cast/discover";
import { displayHosts, webUrl, withoutToken } from "../web/links";
import { startWebServer, type WebServerHandle, type WebServerOptions } from "../web/server";
import type { Runtime } from "../daemon/runtime";
import { log } from "../util/logger";

export interface DownloadInput {
  id: string;
  name: string;
  magnet: string;
  source?: SourceId;
  sizeBytes?: number;
}

/**
 * Injection seam for the web server. Only a test uses it: the real starter binds
 * a socket, and the point of the test is the *absence* of stdout writes, which a
 * real server would make impossible to attribute.
 */
export type StartWebServerImpl = (
  runtime: Runtime,
  options: WebServerOptions,
) => Promise<WebServerHandle>;

/**
 * Everything that must be unset to genuinely disconnect reccd. Shared by the
 * two paths that can clear it — the `x` key on the Accounts row, and blanking
 * both fields in the reccd prompt — because they make the same promise to the
 * user and must therefore have the same effect. reccAutoSignup: false is the
 * load-bearing part: without it the next launch signs them straight back up,
 * and the user who cleared it watches it come back.
 */
const RECC_CLEARED: Partial<Config> = {
  reccUrl: undefined,
  reccToken: undefined,
  reccAccountName: undefined,
  reccAccountClaimed: undefined,
  reccAutoSignup: false,
};

/**
 * True when reccd's connection comes from the environment, which config cannot
 * override — so both clear paths must refuse rather than write a change that
 * will not take effect and a notice that would be a lie.
 */
function reccSetByEnv(): boolean {
  return Boolean(process.env["TORLINK_RECC_URL"]?.trim() || process.env["TORLINK_RECC_TOKEN"]?.trim());
}

const RECC_CLEARED_NOTICE = "reccd connection cleared. Recommendations stay off until you set it up again.";
const RECC_ENV_VAR_NOTICE = "reccd is set via TORLINK_RECC_* env vars — unset them to clear it.";

export function App({
  initialMagnet,
  initialTorrent,
  onQuit,
  // The TUI hosts the browser UI in-process, sharing this component's own
  // in-memory DownloadQueue and stream registry: what the terminal sees, the
  // browser sees, with no IPC and no second copy of the queue.
  web,
  webPort,
  webHost,
  webToken,
  startWebServerImpl = startWebServer,
}: {
  initialMagnet?: string;
  initialTorrent?: string;
  onQuit?: () => void;
  web?: boolean;
  webPort?: number;
  webHost?: string;
  webToken?: string;
  startWebServerImpl?: StartWebServerImpl;
} = {}) {
  useMouseWheel();
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const { stdout } = useStdout();

  const [size, setSize] = useState({
    rows: stdout?.rows ?? 24,
    cols: stdout?.columns ?? 80,
  });
  useEffect(() => {
    if (!stdout) return;
    let last = { rows: stdout.rows ?? 24, cols: stdout.columns ?? 80 };
    const onResize = (): void => {
      const next = { rows: stdout.rows ?? 24, cols: stdout.columns ?? 80 };
      if (next.rows === last.rows && next.cols === last.cols) return;
      if (next.rows < last.rows || next.cols < last.cols) {
        stdout.write("\x1b[2J\x1b[H");
      }
      last = next;
      setSize(next);
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  const rows = size.rows;
  const cols = size.cols;

  const [queue, setQueue] = useState<DownloadQueue | null>(null);
  const [config, setConfigState] = useState<Config | null>(null);

  // Live stream sessions for this process. The TUI owns no Runtime, so it owns
  // this: a stream started in the terminal has to be visible to the browser and
  // vice versa, which means exactly one registry per process. Lazily built in a
  // ref so it survives every re-render (a fresh one per render would strand the
  // sessions the previous render's server handed out).
  const sessionsRef = useRef<StreamSessionRegistry | null>(null);
  if (!sessionsRef.current) sessionsRef.current = new StreamSessionRegistry();
  // A ref for the same reason: a cast outlives any one render, and the web
  // server mounted below is handed this exact instance so a cast started in the
  // terminal is the one a browser on this process sees.
  const castsRef = useRef<CastSessionRegistry | null>(null);
  if (!castsRef.current) castsRef.current = new CastSessionRegistry();
  // Mirrored into React state, because the registry is a plain object and a
  // component cannot re-render from one. Kept in step by the subscription below.
  const [castStatus, setCastStatus] = useState<CastRowStatus | null>(null);
  // The device list, while the prompt is open. `finding` covers the two seconds
  // discovery spends listening on a multicast socket.
  const [castPrompt, setCastPrompt] = useState<
    { file: ResolvedFile; devices: CastDevice[]; finding: boolean } | null
  >(null);
  /**
   * Set when a cast needed the web UI and started it.
   *
   * Casting requires an origin the TELEVISION can fetch from, and the TUI's own
   * stream server binds `localhost` on an ephemeral port
   * (src/integrations/torrentStream.ts). The web server is the only LAN-reachable,
   * token-authenticated origin torlink has, so a cast brings it up — bound to a
   * wildcard, with a generated token, because `startWebServer` rightly refuses a
   * non-loopback bind without one. That is a real change to what this machine
   * exposes, so it is announced rather than done quietly.
   */
  const [castWeb, setCastWeb] = useState(false);
  // What the web server actually bound, for the cast routes to reach over
  // loopback. A ref rather than state: nothing renders from it.
  const webBoundRef = useRef<{ port: number; token: string | undefined } | null>(null);
  // One subscription for the life of the app, so the cast row follows a device
  // that was paused or stopped from the television's own remote — and so a lost
  // connection reaches the screen rather than leaving a row that claims to be
  // playing. The registry hands its notice over exactly once, which is why it is
  // read here and not polled anywhere else in this process.
  useEffect(() => {
    const casts = castsRef.current!;
    const sync = (): void => {
      const active = casts.active();
      setCastStatus(
        active
          ? {
              deviceName: active.device.name,
              title: active.title,
              state: active.status.state,
              positionSec: active.status.positionSec,
              durationSec: active.status.durationSec,
            }
          : null,
      );
      const notice = casts.takeNotice();
      if (notice) setNotice(notice);
    };
    sync();
    return casts.onChange(sync);
  }, []);
  const [view, setView] = useState<View>("splash");
  const [query, setQuery] = useState("");
  const [section, setSection] = useState<Section>("all");
  const [sort, setSortState] = useState<Sort>("none");
  const [region, setRegion] = useState<Region>("content");
  const [captureMode, setCaptureMode] = useState<CaptureMode>("none");
  const [downloadFocus, setDownloadFocus] = useState<DownloadFocus | null>(null);
  const [seedFocus, setSeedFocus] = useState<SeedFocus | null>(null);
  const [resultFocus, setResultFocus] = useState<ResultFocus | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [helpScroll, setHelpScroll] = useState(0);
  const [editingFolder, setEditingFolder] = useState(false);
  const [editingToken, setEditingToken] = useState<{ provider: DebridProviderId } | null>(null);
  const [editingRecc, setEditingRecc] = useState(false);
  // The claim overlay is local state, exactly as editingRecc is — no Store field.
  const [claimingRecc, setClaimingRecc] = useState(false);
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimError, setClaimError] = useState<string | undefined>(undefined);
  // Bumped whenever the claim overlay opens or closes. Same generation guard as
  // netflixImportGen / traktImportGen below: a claim request can't be aborted, so
  // a late one must not flash stale state onto a reopened overlay — and, worse
  // than a flash, must not clear `claimBusy` while a second attempt is still in
  // flight, which would invite a third.
  const claimGen = useRef(0);
  const [editingOmdb, setEditingOmdb] = useState(false);
  const [importingNetflix, setImportingNetflix] = useState(false);
  const [netflixImport, setNetflixImport] = useState<NetflixImportView>({ phase: "form" });
  // Bumped whenever the import overlay opens or closes. An in-flight upload can't
  // be aborted (reccd is idempotent, so a stray extra chunk is harmless), but a
  // late completion must not flash stale state onto a reopened overlay — so each
  // run captures the current generation and ignores its own setState once superseded.
  const netflixImportGen = useRef(0);
  const [importChooser, setImportChooser] = useState(false);
  const [importingTrakt, setImportingTrakt] = useState(false);
  const [traktImport, setTraktImport] = useState<TraktImportView>({ phase: "checking" });
  // Same generation guard as Netflix: an in-flight poll/import can't be aborted,
  // but a late completion must not flash stale state onto a reopened overlay.
  const traktImportGen = useRef(0);
  const [reccStatus, setReccStatus] = useState<ReccStatus | null>(null);
  const [editingPlayer, setEditingPlayer] = useState(false);
  const [editingSources, setEditingSources] = useState(false);
  const [editingQuality, setEditingQuality] = useState(false);
  const [editingDns, setEditingDns] = useState(false);
  const [editingRutracker, setEditingRutracker] = useState(false);
  const [rutrackerStatus, setRutrackerStatus] = useState<LoginStatus>({ kind: "idle" });
  const [rutrackerCaptcha, setRutrackerCaptcha] = useState<Captcha | undefined>(undefined);
  const [rutrackerUser, setRutrackerUser] = useState<string | undefined>(undefined);
  const [editingTrackers, setEditingTrackers] = useState(false);
  const [editingLimits, setEditingLimits] = useState(false);
  const [editingVpn, setEditingVpn] = useState(false);
  const [editingCastDevice, setEditingCastDevice] = useState(false);
  const [editingCastHost, setEditingCastHost] = useState(false);
  const [pendingP2P, setPendingP2P] = useState<DownloadInput | null>(null);
  const [fileSelection, setFileSelection] = useState<QueueItem | null>(null);
  // Context for a stream awaiting a player-command decision: the URL, an
  // optional display name, an onPlayed callback fired ONLY when a player really
  // launches (e.g. to mark an episode watched), and the configured command that
  // failed (set only for the auto-detect/edit choice prompt).
  const [pendingStream, setPendingStream] = useState<{
    url: string;
    name?: string;
    onPlayed?: () => void;
    configured?: string;
    // Carried here (rather than recomputed at the fallback prompt) because that
    // scope has no file list to recompute it from — see setMediaPlayer.
    subtitleUrl?: string;
  } | null>(null);
  // Which media-player prompt is showing: the auto-detect/edit choice (after a
  // configured player failed) or the plain command entry.
  const [playerPromptMode, setPlayerPromptMode] = useState<"choice" | "edit">("edit");
  // A result waiting on the "download to" prompt (f); null when the prompt is
  // closed. lastDownloadToDir pre-fills the next prompt so queueing a batch
  // into the same alternate folder only costs one typed path per session.
  const [pendingDownload, setPendingDownload] = useState<{
    id: string;
    name: string;
    magnet: string;
    source?: SourceId;
    sizeBytes?: number;
  } | null>(null);
  const [lastDownloadToDir, setLastDownloadToDir] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [debridStatus, setDebridStatus] = useState<DebridStatus | null>(null);
  // Info hashes the active debrid provider has cached, for the results marker.
  // Empty when the provider cannot answer — see cachedTag's reasoning in
  // src/web/static/searchModel.ts, which this mirrors for the terminal.
  const [cachedHashes, setCachedHashes] = useState<ReadonlySet<string>>(new Set());
  // Guards an in-flight cached-hashes lookup landing after a newer search or a
  // provider switch has already reset the set — a marker on the wrong row is
  // worse than no marker.
  const cachedRequestId = useRef(0);
  const [streamFiles, setStreamFiles] = useState<ResolvedFile[] | null>(null);
  // The session's UNFILTERED file list — streamFiles has already been through
  // streamCandidates, which drops exactly the .srt files the subtitle matcher
  // needs. Kept alongside streamFiles, reset on the same two paths.
  const [streamAllFiles, setStreamAllFiles] = useState<ResolvedFile[] | null>(null);
  // Episodes streamed from the current picker session (marked ✓, cleared when
  // the picker opens/closes). Union with the favourite's persisted watched list.
  const [streamedFiles, setStreamedFiles] = useState<Set<string>>(new Set());
  // The torrent behind the open picker, so we can favourite it / persist watched
  // progress. Cleared only when the picker closes (survives keep-open replays).
  const [streamSource, setStreamSource] = useState<DownloadInput | null>(null);
  // Which candidate the picker should open on — an index into the list handed to
  // StreamFilePrompt, from nextEpisodeIndex. Null is the ordinary answer (a film,
  // a pack with no episode number, or nothing matching) and means "first row".
  const [streamPreselect, setStreamPreselect] = useState<number | null>(null);
  const [preparing, setPreparing] = useState<{
    label: string;
    phase: "caching" | "fetching";
    pct: number;
    source: "rd" | "torrent";
    // Only set for source === "rd"; names the provider actually caching this
    // stream, so the spinner never says "Real-Debrid" for a TorBox user.
    providerLabel?: string;
  } | null>(null);
  const [activeStream, setActiveStream] = useState<
    { session: TorrentStreamSession; name: string; input: DownloadInput } | null
  >(null);
  const [streamHistory, setStreamHistory] = useState<StreamHistoryItem[]>([]);
  // Confirm state for the two torrent privacy prompts.
  const [torrentPrompt, setTorrentPrompt] = useState<
    { input: DownloadInput; reason?: string } | null
  >(null);
  // Offer to keep a fully-downloaded torrent stream as a real download + seed.
  const [keepPrompt, setKeepPrompt] = useState<
    { session: TorrentStreamSession; input: DownloadInput } | null
  >(null);
  // Ask for an explicit like/dislike signal once a stream ends.
  const [ratePrompt, setRatePrompt] = useState<{
    name: string;
    showWatched?: boolean;
    title?: string;
    onRated?: () => void;
  } | null>(null);
  const vpnUnsafe = useRef(false);
  const prepareAbort = useRef<AbortController | null>(null);
  const [recovered, setRecovered] = useState(false);
  const booting = useRef(false);

  useEffect(() => {
    if (booting.current) return;
    booting.current = true;
    let alive = true;
    void (async () => {
      const cfg = await loadConfig();
      const q = new DownloadQueue();
      q.setTrackers(cfg.trackers);
      q.setTransferPolicy(cfg);
      // Crash-boot breaker: a marker left behind by the previous boot means it
      // died mid-restore, so this one restores everything paused with the
      // engine cold (safe mode) instead of walking into the same explosion.
      const safeBoot = wasBootInterrupted();
      armBootMarker();
      // One fail-safe around the whole restore, holding a single invariant: the
      // app always reaches a usable screen. Nothing below throws today (every
      // loader falls back to empty state and the engine calls are guarded), but
      // a future one that did would otherwise strand the boot on the loading
      // spinner, which is the worst failure this app has.
      try {
        q.restore(reconcileQueue(await loadQueue()), { safe: safeBoot });
        q.restoreHistory(await loadHistory());
        q.restoreSeeds(await loadSeeds(), { safe: safeBoot });
      } catch (e) {
        logCrash("boot-restore", e);
      }
      setTimeout(disarmBootMarker, BOOT_SETTLE_MS).unref();
      if (!alive) {
        q.suspend();
        return;
      }
      setConfigState(cfg);
      setStreamHistory(await loadStreamHistory());
      // Apply any custom DNS before the first network call (e.g. token check).
      setDnsServers(resolveDnsServers(cfg));
      // Restore remembered UI preferences (validated, so stale values degrade
      // to defaults rather than throwing).
      setSortState(parseSort(cfg.sort));
      const launchActive = resolveActiveDebrid(cfg);
      if (launchActive) {
        const meta = getDebridProvider(launchActive.provider);
        void meta.validateToken(launchActive.token)
          .then((status) => {
            if (alive) setDebridStatus(status);
          })
          .catch(() => {
            /* offline or bad token at launch: leave the badge hidden, no toast */
          });
      }
      setQueue(q);
      if (safeBoot) {
        setRecovered(true);
        setNotice("Recovered from a crashed start · downloads paused");
      }
      const launch = initialMagnet
        ? parseInput(initialMagnet)
        : initialTorrent
          ? await magnetFromTorrentFile(initialTorrent)
          : null;
      if (launch) {
        await fs.mkdir(cfg.downloadDir, { recursive: true }).catch(() => {});
        q.add(
          { id: launch.infoHash, name: launch.name, magnet: launch.magnet },
          cfg.downloadDir,
        );
        setView("browser");
        setSection("downloads");
        setRegion("content");
      } else {
        // Reopen on the last section the user was on. `lastSection` is the
        // current field; fall back to the older category-only `category` for
        // pre-upgrade configs. Never restore into a tab that's currently hidden
        // (Porn with adult content off, For You without reccd) — land on "all".
        let restored = parseSection(cfg.lastSection ?? cfg.category);
        if (restored === "porn" && !resolveAdultContent(cfg)) restored = "all";
        if (restored === "forYou" && !resolveReccConfig(cfg).reccUrl) restored = "all";
        setSection(restored);
      }
    })();
    return () => {
      alive = false;
    };
  }, [initialMagnet, initialTorrent]);

  // Best-effort, once per launch, off the hot path: if a newer release exists,
  // surface a quiet banner. Any failure (offline, opt-out) just leaves it hidden.
  useEffect(() => {
    if (process.env.TORLINK_NO_UPDATE_CHECK) return;
    let alive = true;
    void (async () => {
      const latest = await fetchLatestVersion();
      if (alive && latest && isNewer(VERSION, latest)) setUpdateVersion(latest);
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    void loadRutrackerSession().then((s) => setRutrackerUser(s?.username));
  }, []);

  useEffect(() => {
    if (!queue) return;
    const onCompleted = (name: string): void =>
      setNotice(`${ICON.done} ${truncate(cleanText(name), 40)}`);
    queue.on("completed", onCompleted);
    return () => {
      queue.off("completed", onCompleted);
    };
  }, [queue]);

  // If a debrid download fails because the token was rejected, clear the
  // stale status and re-open the token prompt — once per failure, not on every
  // queue tick.
  const reauthSeen = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!queue) return;
    const onUpdate = (): void => {
      const selecting = queue.getItems().find((it) => it.status === "selecting");
      setFileSelection(selecting ? { ...selecting } : null);
      for (const it of queue.getItems()) {
        if (it.status !== "failed" || it.via !== "debrid" || !it.error) continue;
        if (reauthSeen.current.has(it.id)) continue;
        const provider = it.provider ?? "realdebrid";
        const meta = getDebridProvider(provider);
        if (meta.isTokenRejection(it.error)) {
          reauthSeen.current.add(it.id);
          setDebridStatus(null);
          setNotice(`${meta.label} token expired — re-enter it.`);
          setShowHelp(false);
          setEditingToken({ provider });
        }
      }
    };
    queue.on("update", onUpdate);
    onUpdate();
    return () => {
      queue.off("update", onUpdate);
    };
  }, [queue]);

  useEffect(
    () => () => {
      queue?.suspend();
    },
    [queue],
  );

  // The download dir the in-process web server adds torrents into, read through
  // a ref rather than a dependency (see the mount effect below). Assigned during
  // render so it is already current by the time any effect in this commit runs —
  // it is never read during render, only by the server's `downloadDir` getter.
  const downloadDirRef = useRef("");
  if (config) downloadDirRef.current = config.downloadDir;

  // The Cloudflare Access policy the in-process web server enforces, held in a
  // ref for the same reason downloadDir is: read once at mount by the effect
  // below, never a dependency of it.
  const cloudflareAccessRef = useRef<ReturnType<typeof resolveCloudflareAccess>>(null);
  cloudflareAccessRef.current = config ? resolveCloudflareAccess(config) : null;
  // Held in a ref for the same reason as above (read once by the mount effect,
  // never a dependency of it). True when exactly one Access half is set, which
  // resolves to a null policy that enforces nothing — worth a warning.
  const cfAccessHalfConfiguredRef = useRef(false);
  cfAccessHalfConfiguredRef.current = config ? isCloudflareAccessHalfConfigured(config) : false;

  // The web server's state for the splash's status line. Stays null unless
  // --web was passed, so a plain launch says nothing; only ever holds a url the
  // server reported back as bound.
  const [webStatus, setWebStatus] = useState<SplashWebStatus | null>(null);

  // Host the browser UI inside the TUI process, over this component's own queue.
  //
  // Deps are deliberately narrow: `queue` flips null -> queue exactly once, and
  // everything else here is a launch flag. `config` is NOT a dependency — it
  // changes whenever the user edits a setting, and re-running this would tear
  // down a listening socket and rebind it, which can fail EADDRINUSE against the
  // copy of itself that has not finished closing.
  useEffect(() => {
    // `castWeb` is the second way in: a cast needs a LAN-reachable origin, and
    // this is the only server torlink has that is one. It can only ever flip from
    // false while no server is mounted (see `ensureCastWeb`), so it cannot tear
    // down and rebind a socket that is already serving.
    if ((!web && !castWeb) || !queue) return;
    // A half-configured Access gate (one of team domain / AUD, not both) resolves
    // to null above and enforces nothing — warn so it isn't mistaken for "on".
    if (cfAccessHalfConfiguredRef.current) {
      log.warn(
        "[web] cloudflare access is half-configured (need BOTH team domain and AUD) — origin gate is OFF",
      );
    }
    const sessions = sessionsRef.current!;
    // A cast needs an address a television can route to, so a wildcard rather
    // than loopback — and therefore a token, which startWebServer requires for
    // any non-loopback bind. An explicit --web-host still wins.
    const host = webHost?.trim() || (castWeb ? "0.0.0.0" : "127.0.0.1");
    let handle: WebServerHandle | null = null;
    // Teardown can happen while listen() is still in flight, in which case the
    // cleanup below has no handle to close yet — so it sets this instead and the
    // starter closes the server it just got. Without it, quitting during startup
    // leaks a listening socket for the life of the process.
    let cancelled = false;
    const runtime: Runtime = {
      queue,
      // A getter, not a snapshot: the mount happens once, and a user who changes
      // their download folder mid-session expects POST /api/add to honour it.
      get downloadDir(): string {
        return downloadDirRef.current;
      },
      sessions,
      casts: castsRef.current!,
    };
    // One reading of the token for the whole mount: the server is given it and
    // the displayed link embeds it, and those two must agree — a link carrying a
    // token the server does not enforce (or vice versa) is a dashboard that
    // won't open. Empty and whitespace-only both mean "no token", matching
    // web/server.ts's own check.
    const token = webToken?.trim() || (castWeb ? randomBytes(16).toString("base64url") : undefined);
    void (async () => {
      try {
        const started = await startWebServerImpl(runtime, {
          ...(webPort !== undefined ? { port: webPort } : {}),
          host,
          ...(token ? { token } : {}),
          ...(cloudflareAccessRef.current ? { cloudflareAccess: cloudflareAccessRef.current } : {}),
          // THE constraint of this mount: Ink owns stdout and repaints by
          // tracking cursor position, so a stray write from a request handler
          // lands inside a rendered frame and corrupts it — and reads as a
          // rendering bug, not a logging one. The file logger is the only safe
          // sink here. Never console, never process.stdout.
          log: (message: string) => log.info(`[web] ${message}`),
        });
        if (cancelled) {
          void started.close();
          return;
        }
        handle = started;
        // The port comes from the handle, not from webPort: the handle reports
        // what was actually bound, which is the only correct answer once
        // `port: 0` is in play (the daemon reads it back the same way).
        // Not `host`: a wildcard bind is not an address, and printing it here
        // sent users to http://0.0.0.0:9162. The token rides in the fragment so
        // the link works without typing it (web/links.ts).
        const { local } = displayHosts(host, os.networkInterfaces());
        const url = webUrl(local, started.port, token);
        // The notice is shown without the token for the same reason the splash
        // line is (web/links.ts): both land in terminal scrollback, which
        // `torlnk attach` keeps alive in a tmux session. `webStatus` holds the
        // real link, so shift+w still opens something that works.
        // What the cast routes reach over loopback. The bound port, never the
        // requested one, for the reason the line above reads it back.
        webBoundRef.current = { port: started.port, token };
        setNotice(
          castWeb && !web
            ? // Unmissable on purpose: pressing `c` has just put a
              // token-protected dashboard on this machine's LAN address, which is
              // more than "the web UI started".
              `${ICON.done} Casting needs the TV to reach this machine, so the web UI is now on ${withoutToken(url)} (token required)`
            : `${ICON.done} Web UI on ${withoutToken(url)}`,
        );
        setWebStatus({ url });
      } catch (e) {
        // Every failure mode lands here, including startWebServer's refusal to
        // bind a non-loopback host without a token. The TUI keeps running: a
        // thrown error would unmount mid-session, and a printed stack would go
        // straight through the frame.
        const message = e instanceof Error ? e.message : String(e);
        log.error(`[web] could not start on ${host}:${webPort ?? "default"}: ${message}`);
        if (cancelled) return;
        setNotice(`Web UI failed: ${message}`);
        // Said on the splash too, briefly: staying silent after a failed bind
        // sends the user to the log file to find out why, once the notice has
        // expired — which is the gap this line exists to close.
        setWebStatus({ failed: true });
      }
    })();
    return () => {
      cancelled = true;
      void handle?.close();
    };
  }, [web, castWeb, queue, webPort, webHost, webToken, startWebServerImpl]);

  // `--port 8080` without `--web` parses fine and does nothing. Say so rather
  // than silently accepting a flag the user believes turned something on.
  useEffect(() => {
    if (web) return;
    const orphans = [
      webPort !== undefined ? "--port" : null,
      webHost ? "--host" : null,
      webToken ? "--token" : null,
    ].filter((f): f is string => f !== null);
    if (orphans.length === 0) return;
    log.warn(`[web] ${orphans.join(", ")} ignored without --web`);
    setNotice(`${orphans.join(", ")} ignored without --web`);
  }, [web, webPort, webHost, webToken]);

  // Keep the queue's active debrid provider/token in step with config (and any
  // env var), so a retry can re-run the pipeline without the UI handing it back in.
  useEffect(() => {
    if (!queue || !config) return;
    const active = resolveActiveDebrid(config);
    queue.setDebridToken(active?.provider ?? null, active?.token ?? "");
  }, [queue, config]);

  const quitAll = useCallback(() => {
    // Flush all state synchronously up front so nothing is lost to the hard
    // exit; the unmount effect still runs suspend() for the engine teardown.
    queue?.persistSync();
    // Same reason as the unmount effect: a stream the browser started is a live
    // engine, and quit is a hard exit — stop them here too, since forceExit()
    // can beat the unmount cleanup to the process.
    void sessionsRef.current?.stopAll();
    void activeStream?.session.stop();
    // A keep prompt awaiting a decision still holds a live (complete) stream
    // session — discard it too rather than leaking its temp dir on quit.
    void keepPrompt?.session.stop();
    // Clear so the unmount-only cleanup effect below has nothing left to
    // re-stop (stop() is also idempotent, but this avoids relying on that).
    activeStreamRef.current = null;
    setActiveStream(null);
    setKeepPrompt(null);
    if (onQuit) onQuit();
    else exit();
  }, [queue, onQuit, exit, activeStream, keepPrompt]);

  const setConfig = useCallback(
    (c: Config) => {
      setConfigState(c);
      queue?.setTrackers(c.trackers);
      queue?.setTransferPolicy(c);
      void saveConfig(c);
    },
    [queue],
  );

  // Merge a small patch into config and persist it, skipping the write when
  // nothing actually changed (so idle navigation doesn't churn the disk).
  const persistConfig = useCallback((patch: Partial<Config>) => {
    setConfigState((prev) => {
      if (!prev) return prev;
      const changed = (Object.keys(patch) as (keyof Config)[]).some(
        (k) => prev[k] !== patch[k],
      );
      if (!changed) return prev;
      const next = { ...prev, ...patch };
      void saveConfig(next);
      return next;
    });
  }, []);

  // Change the sort and remember it for next launch.
  const setSort = useCallback(
    (s: Sort) => {
      setSortState(s);
      persistConfig({ sort: formatSort(s) });
    },
    [persistConfig],
  );

  // Change the section, remembering it so torlink reopens on the same tab next
  // launch (any section — categories and downloads/seeding/For You alike).
  const changeSection = useCallback(
    (s: Section) => {
      setSection(s);
      persistConfig({ lastSection: s });
    },
    [persistConfig],
  );

  // Flip a source on/off and persist. Functional update so concurrent toggles
  // always build on the latest list.
  const toggleSource = useCallback((id: SourceId) => {
    setConfigState((prev) => {
      if (!prev) return prev;
      const next = {
        ...prev,
        disabledSources: toggleDisabledSource((prev.disabledSources ?? []) as SourceId[], id),
      };
      void saveConfig(next);
      return next;
    });
  }, []);

  // Same functional-update-then-save shape as toggleSource, so a stale
  // snapshot from outside the updater never overwrites a concurrent write.
  const setQualityPrefs = useCallback(
    (next: { maxResolution?: MaxResolution; require: FeatureId[]; exclude: FeatureId[] }) => {
      setConfigState((prev) => {
        if (!prev) return prev;
        const updated = {
          ...prev,
          maxResolution: next.maxResolution,
          requireFeatures: next.require,
          excludeFeatures: next.exclude,
        };
        void saveConfig(updated);
        return updated;
      });
    },
    [],
  );

  const toggleSavedSearch = useCallback((raw: string) => {
    const query = raw.trim();
    if (!query) return;
    setConfigState((prev) => {
      if (!prev) return prev;
      const current = prev.savedSearches ?? [];
      const savedSearches = toggleSavedSearches(current, query);
      const next = { ...prev, savedSearches };
      void saveConfig(next);
      return next;
    });
    setNotice("Saved searches updated.");
  }, []);

  // Opens the shared RatePrompt for a For You pick (adds the "watched" action and
  // a fitting title). `onRated` fires only on a real rating (not on skip), so the
  // caller can dismiss the pick from its list.
  const openRatePick = useCallback((name: string, onRated: () => void) => {
    setRatePrompt({ name, showWatched: true, title: "Rate this pick", onRated });
  }, []);

  const toggleFavourite = useCallback((item: FavouriteItem) => {
    if (!config) return;
    const wasFavourited = isFavouritedIn(config.favourites ?? [], item.id);
    setConfigState((prev) => {
      if (!prev) return prev;
      const favourites = toggleFavouriteList(prev.favourites ?? [], item);
      const next = { ...prev, favourites };
      void saveConfig(next);
      return next;
    });
    void postEvent(
      resolveReccConfig(config),
      {
        type: wasFavourited ? "unfavourited" : "favourited",
        rawName: item.name,
        ts: Date.now(),
        source: "torlink",
      },
    );
    setNotice("Favourites updated.");
  }, [config]);

  const removeFavourite = useCallback((id: string) => {
    setConfigState((prev) => {
      if (!prev) return prev;
      const favourites = removeFavouriteFromList(prev.favourites ?? [], id);
      const next = { ...prev, favourites };
      void saveConfig(next);
      return next;
    });
    setNotice("Removed from favourites.");
  }, []);

  // Record a streamed episode against a favourite (deduped). Skips the disk
  // write when the id isn't favourited or the episode was already recorded.
  const markWatchedInFavourite = useCallback((id: string, filename: string) => {
    setConfigState((prev) => {
      if (!prev) return prev;
      const current = prev.favourites ?? [];
      const favourites = markWatched(current, id, filename);
      if (favourites === current) return prev; // no change: don't churn disk
      const next = { ...prev, favourites };
      void saveConfig(next);
      return next;
    });
  }, []);

  // Advance the watch position from the file a player really opened.
  //
  // RE-READS before writing. `serve --web` is a SEPARATE PROCESS writing this
  // same file, so a writer that trusted its own React snapshot would silently
  // drop every row the browser recorded since this TUI started — the rule
  // `forgetStreamHistory` already states.
  //
  // Totally swallowed: this is a convenience list, and an unhandled rejection in
  // a TUI's Node process can take the terminal down with it.
  const advancePosition = useCallback(async (infoHash: string, filename: string) => {
    try {
      const current = await loadStreamHistory();
      const next = recordPlayedFile(current, infoHash, filename);
      if (next === current) return; // nothing moved — do not churn the file
      await saveStreamHistory(next);
      setStreamHistory(next);
    } catch {
      // ignored, deliberately
    }
  }, []);

  // Mark a file streamed this session and, when its torrent is favourited,
  // persist watched progress. Called only once a player actually launches, so a
  // failed/cancelled stream never earns a ✓.
  //
  // ALSO the watch position: `historyItemFor` ran at stream start and parsed the
  // TORRENT's name, which for a season pack names no episode. This is the first
  // moment we know which episode was really opened.
  const markPlayed = useCallback(
    (favId: string, filename: string) => {
      setStreamedFiles((prev) => new Set(prev).add(filename));
      if (isFavouritedIn(config?.favourites ?? [], favId)) {
        markWatchedInFavourite(favId, filename);
      }
      void advancePosition(favId, filename);
    },
    [config, markWatchedInFavourite, advancePosition],
  );

  const isFavourited = useCallback(
    (id: string) => isFavouritedIn(config?.favourites ?? [], id),
    [config],
  );

  const closeFolderPrompt = useCallback(() => {
    setEditingFolder(false);
  }, []);

  const closeTrackersPrompt = useCallback(() => {
    setEditingTrackers(false);
  }, []);

  const setTrackers = useCallback(
    (list: string[]) => {
      closeTrackersPrompt();
      if (!config) return;
      const same =
        list.length === config.trackers.length &&
        list.every((t, i) => t === config.trackers[i]);
      if (same) {
        setNotice("Trackers unchanged.");
        return;
      }
      setConfig({ ...config, trackers: list });
      setNotice(list.length === 0 ? "Cleared extra trackers." : `Saved ${list.length} tracker${list.length === 1 ? "" : "s"}.`);
    },
    [config, setConfig, closeTrackersPrompt],
  );

  const setLimits = useCallback((limits: TransferLimits) => {
    setEditingLimits(false);
    if (!config) return;
    setConfig({ ...config, ...limits });
    setNotice("Transfer and seeding limits saved.");
  }, [config, setConfig]);

  const setVpnInterface = useCallback((raw: string) => {
    setEditingVpn(false);
    if (!config) return;
    const vpnInterface = raw.trim() || undefined;
    setConfig({ ...config, vpnInterface });
    setNotice(vpnInterface ? `VPN guard set to ${vpnInterface}.` : "VPN guard disabled.");
  }, [config, setConfig]);

  // A manual Chromecast address, for a device mDNS cannot reach (a Docker bridge
  // or a VLAN). Persisted so it is offered alongside discovered devices next time.
  const setCastDeviceAddress = useCallback((raw: string) => {
    setEditingCastDevice(false);
    if (!config) return;
    const castDevice = raw.trim() || undefined;
    setConfig({ ...config, castDevice });
    setNotice(castDevice ? `Cast device set to ${castDevice}.` : "Cast device cleared.");
  }, [config, setConfig]);

  // The host a TV should fetch media FROM when this machine's own address is not
  // routable from the LAN (WSL2's default NAT, bridged Docker).
  const setCastHost = useCallback((raw: string) => {
    setEditingCastHost(false);
    if (!config) return;
    const castAdvertiseHost = raw.trim() || undefined;
    setConfig({ ...config, castAdvertiseHost });
    setNotice(castAdvertiseHost ? `Cast host set to ${castAdvertiseHost}.` : "Cast host cleared.");
  }, [config, setConfig]);

  const ensureVpnSafe = useCallback(async (): Promise<boolean> => {
    const name = config?.vpnInterface?.trim();
    if (!name) return true;
    const safe = await vpnRouteIsSafe(name);
    queue?.setP2PAllowed(safe);
    if (!safe) setNotice(`P2P blocked: ${name} is not the active default route.`);
    return safe;
  }, [config, queue]);


  const setDownloadDir = useCallback(
    (raw: string) => {
      closeFolderPrompt();
      const dir = normalizeDownloadDir(raw);
      if (!config || !dir || dir === config.downloadDir) {
        if (config && dir && dir === config.downloadDir) setNotice("Download folder unchanged.");
        return;
      }
      void (async () => {
        try {
          await fs.mkdir(dir, { recursive: true });
        } catch {
          setNotice(`Couldn't use folder: ${truncate(dir, 48)}`);
          return;
        }
        setConfig({ ...config, downloadDir: dir });
        setNotice(`Download folder: ${truncate(dir, 48)}`);
      })();
    },
    [config, setConfig, closeFolderPrompt],
  );

  const closeTokenPrompt = useCallback(() => {
    setEditingToken(null);
  }, []);

  const openTokenPrompt = useCallback((provider: DebridProviderId) => {
    setView("browser");
    setShowHelp(false);
    setEditingToken({ provider });
  }, []);

  const setDebridToken = useCallback(
    (provider: DebridProviderId, raw: string) => {
      closeTokenPrompt();
      if (!config) return;
      const meta = getDebridProvider(provider);
      const token = raw.trim();
      if (!token) {
        setNotice(`${meta.label} token unchanged.`);
        return;
      }
      const field = provider === "torbox" ? "torBoxToken" : "realDebridToken";
      // First token set also becomes the active provider: the user just
      // configured it, so silently leaving the other one in charge would be
      // the opposite of what they asked for.
      const next: Config = { ...config, [field]: token };
      if (!resolveActiveDebrid(config)) next.debridProvider = provider;
      setConfig(next);
      void (async () => {
        try {
          const status = await meta.validateToken(token);
          setDebridStatus(status);
          if (!status.active) {
            setNotice(`${meta.label}: ${status.username}'s ${status.planLabel} account can't add torrents.`);
            return;
          }
          setNotice(`${ICON.done} ${meta.label} connected as ${status.username}`);
        } catch (e) {
          setDebridStatus(null);
          setNotice(`${meta.label}: ${e instanceof Error ? e.message : "could not validate token"}`);
        }
      })();
    },
    [config, setConfig, closeTokenPrompt],
  );

  const clearDebridToken = useCallback(
    (provider: DebridProviderId) => {
      closeTokenPrompt();
      if (!config) return;
      const meta = getDebridProvider(provider);
      if (process.env[meta.tokenEnvVar]?.trim()) {
        setNotice(`Token is set via ${meta.tokenEnvVar} — unset the env var to clear it.`);
        return;
      }
      const field = provider === "torbox" ? "torBoxToken" : "realDebridToken";
      const next: Config = { ...config, [field]: undefined };
      // Never leave the preference pointing at a provider that has no token:
      // resolveActiveDebrid would ignore it, but the accounts pane would still
      // show it as active.
      if (next.debridProvider === provider) next.debridProvider = undefined;
      setConfig(next);
      if (debridStatus?.provider === provider) setDebridStatus(null);
      setNotice(`${meta.label} token cleared.`);
    },
    [config, setConfig, closeTokenPrompt, debridStatus],
  );

  const setActiveDebrid = useCallback(
    (provider: DebridProviderId) => {
      if (!config) return;
      const meta = getDebridProvider(provider);
      setConfig({ ...config, debridProvider: provider });
      setDebridStatus(null); // re-probed below; a stale status is a wrong badge
      setNotice(`${ICON.done} Using ${meta.label} for streams and debrid downloads.`);
      void (async () => {
        try {
          setDebridStatus(await meta.validateToken(resolveDebridTokenFor(config, provider)));
        } catch {
          setDebridStatus(null);
        }
      })();
    },
    [config, setConfig],
  );

  const refreshReccStatus = useCallback(
    (cfg: Config | null) => {
      const rc = cfg ? resolveReccConfig(cfg) : {};
      if (!rc.reccUrl) {
        setReccStatus(null);
        return;
      }
      void checkReccConnection(rc).then((status) => {
        setReccStatus(status);
        const account = status.account;
        if (!account) return;
        // Differs-only, deliberately: this runs on every status refresh, and an
        // unconditional write here would turn a network read into a config write
        // on a timer — the same two-process race provision.ts takes a lock to
        // avoid, reintroduced.
        if (account.name !== cfg?.reccAccountName || account.claimed !== cfg?.reccAccountClaimed) {
          persistConfig({ reccAccountName: account.name, reccAccountClaimed: account.claimed });
        }
      });
    },
    [persistConfig],
  );

  useEffect(() => {
    refreshReccStatus(config);
  }, [config?.reccUrl, config?.reccToken, refreshReccStatus]);

  // Auto-provision an anonymous reccd account on first run. Fire-and-forget and
  // never awaited: reccd is a value-add, and nothing here may delay or break the
  // TUI.
  //
  // onProvisioned is NOT optional here. persistConfig writes the whole config
  // object from React state (see its definition above), so an account written to
  // config.json behind that state's back is silently reverted by the next
  // unrelated setting change. Applying the patch to state without re-saving
  // keeps the two in agreement.
  const provisionStarted = useRef(false);
  useEffect(() => {
    if (!config || provisionStarted.current) return;
    provisionStarted.current = true;
    void ensureReccAccount({
      onProvisioned: (patch) => {
        setConfigState((prev) => (prev ? { ...prev, ...patch } : prev));
        setNotice(
          `${ICON.done} Recommendations are on — reccd account ${patch.reccAccountName} created.`,
        );
      },
    }).catch(() => {});
  }, [config]);

  const closeReccPrompt = useCallback(() => setEditingRecc(false), []);

  const openReccPrompt = useCallback(() => {
    setView("browser");
    setShowHelp(false);
    setEditingRecc(true);
    refreshReccStatus(config);
  }, [config, refreshReccStatus]);

  const saveReccConfig = useCallback(
    (rawUrl: string, rawToken: string) => {
      closeReccPrompt();
      const url = rawUrl.trim().replace(/\/+$/, "");
      const token = rawToken.trim();
      if (url) {
        // Clear the remembered account only when the host is genuinely
        // changing: the account name belongs to whoever is at the old URL, and
        // /api/sources would otherwise keep publishing it. Deliberately NOT
        // unconditional — re-pasting a token for the SAME host is the
        // documented recovery after reccd's sign-in reissues one, and the
        // stored name is what names the account while offline.
        const switchingHost = url !== config?.reccUrl;
        persistConfig({
          reccUrl: url,
          reccToken: token || undefined,
          ...(switchingHost ? { reccAccountName: undefined, reccAccountClaimed: undefined } : {}),
        });
        setNotice(`${ICON.done} reccd set to ${url}`);
      } else {
        if (reccSetByEnv()) {
          setNotice(RECC_ENV_VAR_NOTICE);
          return;
        }
        persistConfig(RECC_CLEARED);
        setNotice(RECC_CLEARED_NOTICE);
      }
    },
    [closeReccPrompt, persistConfig, config?.reccUrl],
  );

  const clearReccConfig = useCallback(() => {
    closeReccPrompt();
    if (reccSetByEnv()) {
      setNotice(RECC_ENV_VAR_NOTICE);
      return;
    }
    persistConfig(RECC_CLEARED);
    setNotice(RECC_CLEARED_NOTICE);
  }, [closeReccPrompt, persistConfig]);

  const closeOmdbPrompt = useCallback(() => setEditingOmdb(false), []);

  const openOmdbPrompt = useCallback(() => {
    setView("browser");
    setShowHelp(false);
    setEditingOmdb(true);
  }, []);

  const saveOmdbKey = useCallback(
    (rawKey: string) => {
      closeOmdbPrompt();
      const key = rawKey.trim();
      persistConfig({ omdbApiKey: key || undefined });
      setNotice(key ? `${ICON.done} OMDb key saved.` : "OMDb key cleared.");
    },
    [closeOmdbPrompt, persistConfig],
  );

  const clearOmdbKey = useCallback(() => {
    closeOmdbPrompt();
    if (process.env["TORLINK_OMDB_KEY"]?.trim()) {
      setNotice("OMDb key is set via the TORLINK_OMDB_KEY env var — unset it to clear.");
      return;
    }
    persistConfig({ omdbApiKey: undefined });
    setNotice("OMDb key cleared.");
  }, [closeOmdbPrompt, persistConfig]);

  const closeNetflixImport = useCallback(() => {
    netflixImportGen.current++; // supersede any in-flight run so it can't update state after close
    setImportingNetflix(false);
  }, []);

  const openNetflixImport = useCallback(() => {
    netflixImportGen.current++; // fresh generation; a stale upload's late setState is ignored
    setView("browser");
    setShowHelp(false);
    setNetflixImport({ phase: "form" });
    setImportingNetflix(true);
  }, []);

  const runNetflixImport = useCallback(
    (path: string) => {
      if (!config) return;
      const gen = netflixImportGen.current;
      const isCurrent = (): boolean => netflixImportGen.current === gen;
      // Expand a leading ~ ourselves — we read the raw input field, so (unlike the
      // shell-expanded CLI arg) a typed "~/Downloads/…" wouldn't otherwise resolve.
      const filePath = expandHome(path);
      setNetflixImport({ phase: "running", progress: { done: 0, total: 0 } });
      void (async () => {
        let csvText: string;
        try {
          csvText = await fs.readFile(filePath, "utf8");
        } catch {
          if (isCurrent()) setNetflixImport({ phase: "done", error: `Couldn't read ${filePath}` });
          return;
        }
        const outcome = await uploadNetflixCsv(resolveReccConfig(config), csvText, {
          onProgress: (done, total) => {
            if (isCurrent()) setNetflixImport({ phase: "running", progress: { done, total } });
          },
        });
        if (!isCurrent()) return;
        if (outcome.ok) {
          setNetflixImport({ phase: "done", result: outcome.result });
        } else {
          setNetflixImport({ phase: "done", error: outcome.error, result: outcome.partial });
        }
      })();
    },
    [config],
  );

  const openImportChooser = useCallback(() => {
    setView("browser");
    setShowHelp(false);
    setImportChooser(true);
  }, []);

  const closeImportChooser = useCallback(() => setImportChooser(false), []);

  const openClaimPrompt = useCallback(() => {
    claimGen.current++; // supersede any in-flight claim so it can't touch this overlay
    setView("browser");
    setShowHelp(false);
    // Clearing the error here is what stops a failure that landed after an esc
    // from greeting the user again the next time they open the prompt.
    setClaimError(undefined);
    setClaimingRecc(true);
  }, []);

  const closeClaimPrompt = useCallback(() => {
    claimGen.current++; // as above: esc does not cancel the request, so supersede it
    setClaimingRecc(false);
    setClaimBusy(false);
    setClaimError(undefined);
  }, []);

  const submitClaim = useCallback(
    (name: string, password: string) => {
      if (!config) return;
      const gen = ++claimGen.current;
      const isCurrent = (): boolean => claimGen.current === gen;
      setClaimBusy(true);
      setClaimError(undefined);
      void (async () => {
        try {
          const result = await claimReccAccount(resolveReccConfig(config), name, password);
          // The guard is asymmetric ON PURPOSE, and a uniform one would be a bug.
          // Only this overlay's own state — busy and the error message — belongs
          // to the attempt that is currently on screen, so only those are gated.
          // What reccd already did is not ours to discard: a claim that succeeded
          // must be persisted and reported even if the user pressed esc while it
          // was in flight, so the branches below stay ungated.
          if (isCurrent()) setClaimBusy(false);
          if (result.ok) {
            closeClaimPrompt();
            const claimed = { reccAccountName: result.name, reccAccountClaimed: true };
            persistConfig(claimed);
            setNotice(`${ICON.done} reccd account claimed as ${result.name}.`);
            // The POST-CLAIM config, not `config`. Passing the stale one means the
            // differs-only check in refreshReccStatus compares /profile's
            // `claimed: true` against a snapshot still saying false, and writes the
            // whole config a second time for no reason — defeating the very rule
            // that check exists to enforce.
            refreshReccStatus({ ...config, ...claimed });
            return;
          }
          if (result.reason === "alreadyClaimed") {
            // Claimed from another machine. Local state was simply stale, so close
            // and let the status check correct it rather than nagging. Ungated for
            // the same reason as the success branch: it is reccd's word, not this
            // overlay's state.
            closeClaimPrompt();
            persistConfig({ reccAccountClaimed: true });
            setNotice(result.message);
            refreshReccStatus({ ...config, reccAccountClaimed: true });
            return;
          }
          // nameTaken / invalid / unauthorized / unreachable: keep the prompt open
          // with the message so the user can try again without retyping.
          if (isCurrent()) setClaimError(result.message);
        } catch {
          // Unreachable as things stand — claimReccAccount catches everything and
          // always returns a result. Kept because the cost of being wrong is a
          // prompt that can never be submitted again: ReccClaimPrompt's submit()
          // returns early while busy, so a leaked `claimBusy` wedges it until the
          // user escapes out.
          if (isCurrent()) {
            setClaimBusy(false);
            setClaimError("couldn't reach reccd");
          }
        }
      })();
    },
    [config, closeClaimPrompt, persistConfig, refreshReccStatus],
  );

  const closeTraktImport = useCallback(() => {
    traktImportGen.current++; // supersede any in-flight run so it can't update state after close
    setImportingTrakt(false);
  }, []);

  const openTraktImport = useCallback(() => {
    if (!config) return;
    setImportChooser(false);
    const gen = ++traktImportGen.current;
    const isCurrent = (): boolean => traktImportGen.current === gen;
    setTraktImport({ phase: "checking" });
    setImportingTrakt(true);
    void (async () => {
      const outcome = await runTraktFlow(resolveReccConfig(config), {
        onConnect: (info) => {
          if (isCurrent()) {
            setTraktImport({ phase: "connect", connect: { userCode: info.userCode, verificationUrl: info.verificationUrl } });
          }
        },
        onStatus: (status: TraktStatus) => {
          if (isCurrent() && status === "pending") {
            setTraktImport((s) => (s.phase === "connect" ? s : { phase: "checking" }));
          }
        },
        onImporting: () => {
          if (isCurrent()) setTraktImport({ phase: "running", progress: { message: "Importing from Trakt…" } });
        },
      });
      if (!isCurrent()) return;
      if (outcome.ok) setTraktImport({ phase: "done", result: outcome.result });
      else setTraktImport({ phase: "done", error: outcome.error });
    })();
  }, [config]);

  const chooseImportSource = useCallback(
    (source: ImportSource) => {
      if (source === "netflix") {
        setImportChooser(false);
        openNetflixImport();
      } else {
        openTraktImport();
      }
    },
    [openNetflixImport, openTraktImport],
  );

  const startDownload = useCallback(
    (input: DownloadInput) => {
      if (!config || !queue) return;
      void (async () => {
        if (!(await ensureVpnSafe())) return;
        await fs.mkdir(config.downloadDir, { recursive: true }).catch(() => {});
        queue.add(input, config.downloadDir);
        setNotice(`Added: ${truncate(cleanText(input.name), 40)}`);
      })();
    },
    [config, queue, ensureVpnSafe],
  );

  const startDebridDownload = useCallback(
    (input: DownloadInput) => {
      if (!config || !queue) return;
      const active = resolveActiveDebrid(config);
      if (!active) {
        setNotice("Set a Real-Debrid or TorBox token first — open the Settings tab.");
        return;
      }
      const meta = getDebridProvider(active.provider);
      void fs.mkdir(config.downloadDir, { recursive: true }).catch(() => {});
      void queue.addDebrid(input, config.downloadDir, active.provider, active.token);
      setNotice(`${meta.label}: ${truncate(cleanText(input.name), 40)}`);
    },
    [config, queue],
  );

  // Try to play a resolved stream URL: use the configured/detected player, else
  // copy the link to the clipboard and prompt for a player command.
  const playStream = useCallback(
    async (url: string, name?: string, onPlayed?: () => void, subtitleUrl = "") => {
      if (!config) return;
      const configured = resolveMediaPlayer(config);
      const outcome = await attemptAutoPlay(configured, url, subtitleUrl);
      if (outcome.played) {
        const copied = await writeClipboard(url);
        // A subtitle matched but the launched player is one subtitleArgs does not
        // know a flag for (a wrapper script, say): say so rather than staying
        // silent about a subtitle that never actually loaded.
        const attached = subtitleUrl !== "" && subtitleArgs(outcome.player ?? "", subtitleUrl).length > 0;
        const subNote = subtitleUrl !== "" && !attached ? " · subtitle not loaded" : "";
        setNotice(
          `${ICON.done} Streaming ${name ? `${truncate(cleanText(name), 28)} ` : ""}in ${outcome.player}${copied ? " · link copied" : ""}${subNote}`,
        );
        onPlayed?.();
        void postEvent(
          resolveReccConfig(config),
          { type: "watched", rawName: name ?? url, ts: Date.now(), source: "torlink" },
        );
        return;
      }
      // Couldn't play automatically: stash context, copy the link, and open the
      // right prompt — a configured player that failed to launch gets the
      // auto-detect/edit choice; otherwise the plain command entry. The
      // subtitle URL is carried on pendingStream so it survives to
      // setMediaPlayer's launch, whose scope has no file list to recompute it.
      setPendingStream({
        url,
        name,
        onPlayed,
        configured: outcome.configuredFailed ? configured : undefined,
        subtitleUrl,
      });
      await writeClipboard(url);
      setPlayerPromptMode(outcome.configuredFailed ? "choice" : "edit");
      setEditingPlayer(true);
    },
    [config],
  );

  // Hand a resolved file to the player path and clear any picker/preparing UI.
  const finishStream = useCallback(
    (file: ResolvedFile, name?: string, onPlayed?: () => void, subtitleUrl = "") => {
      setStreamFiles(null);
      setStreamAllFiles(null);
      setPreparing(null);
      void playStream(file.url, name ?? file.filename, onPlayed, subtitleUrl);
    },
    [playStream],
  );

  // Play a picked episode but KEEP the picker open (unlike finishStream) so the
  // user can go straight to the next episode. Marks it streamed this session and
  // persists watched progress when the current torrent is favourited.
  const playFromPicker = useCallback(
    (file: ResolvedFile) => {
      const preferred = preferredSubtitle(subtitlesFor(file, streamAllFiles ?? []));
      // Mark streamed/watched ONLY once a player actually launches (the
      // onPlayed callback), so a failed stream never gets a ✓.
      void playStream(
        file.url,
        file.filename,
        () => {
          if (streamSource) markPlayed(streamSource.id, file.filename);
        },
        preferred?.url ?? "",
      );
    },
    [playStream, streamSource, markPlayed, streamAllFiles],
  );

  // ---- casting -------------------------------------------------------------
  //
  // The terminal drives casting through its OWN web server's routes, over
  // loopback. That looks indirect and is deliberate: those routes already hold
  // the source ladder, the LAN origin rule, the refusal messages and the
  // played-file write, and calling them is what keeps the terminal and the
  // browser from growing two implementations of one decision — the
  // copy-then-drift bug this codebase has recorded four times. The registry
  // itself is shared in-process, so what the terminal casts, a browser on this
  // process sees.

  /**
   * Make sure there is a web server a television can fetch from, and answer with
   * how to reach it over loopback.
   *
   * Null when it could not be started, having already said why.
   */
  const ensureCastWeb = useCallback(async (): Promise<{ port: number; token?: string } | null> => {
    const bound = webBoundRef.current;
    if (bound) return { port: bound.port, ...(bound.token ? { token: bound.token } : {}) };
    setCastWeb(true);
    // Poll for the mount rather than threading a promise out of the effect: the
    // effect owns the socket's lifetime, and a second owner is how a server
    // outlives the component that started it. Ten seconds is far longer than a
    // bind takes and short enough to give up in front of a user.
    for (let i = 0; i < 100; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const now = webBoundRef.current;
      if (now) return { port: now.port, ...(now.token ? { token: now.token } : {}) };
    }
    setNotice("Could not start the web UI, so there is nothing for the TV to fetch from.");
    return null;
  }, []);

  /** Call one of this process's own cast routes. */
  const castApi = useCallback(
    async (
      where: { port: number; token?: string },
      path: string,
      body?: unknown,
    ): Promise<{ ok: boolean; json: Record<string, unknown> }> => {
      const res = await fetch(`http://127.0.0.1:${String(where.port)}${path}`, {
        ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
        headers: {
          "Content-Type": "application/json",
          ...(where.token ? { Authorization: `Bearer ${where.token}` } : {}),
        },
      });
      const json = (await res.json()) as Record<string, unknown>;
      return { ok: res.ok, json };
    },
    [],
  );

  /**
   * `c` in the file picker: find the devices, then offer them.
   *
   * The session is adopted BEFORE the prompt opens, so choosing a device is one
   * request rather than two — and adopted rather than re-resolved, because these
   * files have already been paid for once (a debrid resolve is the user's
   * account, a torrent is their bandwidth).
   */
  const castFromPicker = useCallback(
    (file: ResolvedFile) => {
      if (!streamSource) return;
      setCastPrompt({ file, devices: [], finding: true });
      void (async () => {
        const where = await ensureCastWeb();
        if (!where) {
          setCastPrompt(null);
          return;
        }
        try {
          const { json } = await castApi(where, "/api/cast/devices");
          const devices = (json.devices ?? []) as CastDevice[];
          setCastPrompt((current) => (current ? { ...current, devices, finding: false } : null));
        } catch {
          setCastPrompt((current) => (current ? { ...current, finding: false } : null));
        }
      })();
    },
    [streamSource, ensureCastWeb, castApi],
  );

  /** Cast the picked file to `deviceId`, having adopted a session for it. */
  const castTo = useCallback(
    (deviceId: string) => {
      const picked = castPrompt?.file;
      const input = streamSource;
      const all = streamAllFiles;
      setCastPrompt(null);
      if (!picked || !input || !all) return;
      void (async () => {
        const where = webBoundRef.current;
        if (!where) return;
        const index = all.findIndex((f) => f.url === picked.url);
        if (index < 0) return;
        const session = sessionsRef.current!.adopt({
          infoHash: input.id,
          name: input.name,
          // Every file, not just the video candidates: the subtitle the cast
          // carries is addressed by its index in this same list.
          files: all,
          backend: activeStream ? "torrent" : "debrid",
          ...(activeStream || !config
            ? {}
            : { provider: resolveActiveDebrid(config)?.provider }),
        });
        const subtitle = preferredSubtitle(subtitlesFor(picked, all));
        const subtitleIndex = subtitle ? all.findIndex((f) => f.url === subtitle.url) : -1;
        try {
          const { ok, json } = await castApi(
            { port: where.port, ...(where.token ? { token: where.token } : {}) },
            "/api/cast/start",
            {
              deviceId,
              sid: session.id,
              index,
              ...(subtitleIndex >= 0 ? { subtitleIndex } : {}),
            },
          );
          // The route's message is already written to be read by a person — that
          // is what a CastError means — so it is shown as it stands.
          if (!ok) setNotice(String(json.error ?? "Could not cast that."));
        } catch (e) {
          setNotice(`Could not cast: ${e instanceof Error ? e.message : String(e)}`);
        }
      })();
    },
    [castPrompt, streamSource, streamAllFiles, activeStream, config, castApi],
  );

  /** Save a typed address, then cast to it. Read-modify-write, never a snapshot. */
  const castToAddress = useCallback(
    (address: string) => {
      void (async () => {
        try {
          const current = await loadConfig();
          await saveConfig({ ...current, castDevice: address });
          setConfig({ ...current, castDevice: address });
        } catch {
          // A setting that could not be saved must not stop this cast: the
          // address is still usable for it, it just will not be remembered.
        }
        const manual = parseManualDevice(address);
        if (manual) castTo(manual.id);
      })();
    },
    [castTo, setConfig],
  );

  /** `p` and `x` on the cast row. Same routes the browser's buttons call. */
  const castCommand = useCallback(
    (action: "play" | "pause" | "stop") => {
      const where = webBoundRef.current;
      if (!where) return;
      void (async () => {
        try {
          const { ok, json } = await castApi(
            { port: where.port, ...(where.token ? { token: where.token } : {}) },
            "/api/cast/command",
            { action },
          );
          if (!ok) setNotice(String(json.error ?? "That did not work."));
        } catch {
          // The socket to our own server. Nothing useful to say.
        }
      })();
    },
    [castApi],
  );

  const cancelPreparing = useCallback(() => {
    prepareAbort.current?.abort();
    prepareAbort.current = null;
    setPreparing(null);
    setNotice("Stream cancelled.");
  }, []);

  // The same store the web writes, from src/core so neither front end owns it.
  //
  // Returns the row as STORED — which is not the row just built: recordStream
  // keeps the high-water episode, so resuming "Harrowgate.S03" comes back with
  // the E04 the user actually reached, and `nextEpisode` on it is the same
  // S03E05 the Continue-watching row displays. Callers await it to decide where
  // the file picker opens.
  //
  // Awaiting is safe even though a convenience list must never interrupt a
  // stream: every failure path — the parse included — is swallowed here, so this
  // cannot reject, and it cannot become an unhandled rejection in the TUI's Node
  // process either (which can take the whole terminal down with it). What a
  // caller waits for is a small JSON read and write, after a resolve that already
  // took seconds, and both call sites have already cleared their abort handle.
  const recordStreamHistory = useCallback(async (
    input: DownloadInput,
  ): Promise<StreamHistoryItem | null> => {
    try {
      const item = historyItemFor(input, Date.now());
      if (!item) return null; // no title in the release name, so no row to draw
      const current = await loadStreamHistory();
      const next = recordStream(current, item);
      await saveStreamHistory(next);
      setStreamHistory(next);
      return next.find((e) => e.key === item.key) ?? null;
    } catch {
      return null; // ignore — see above
    }
  }, []);

  // Open the file picker on a resolved multi-file torrent. Both stream paths
  // (debrid and direct torrent) end here, so the cursor's opening position
  // is decided once. `recorded` is the stream-history row this play just wrote,
  // whose `nextEpisode` is the same suggestion the Continue-watching pane shows.
  const openStreamPicker = useCallback(
    (
      candidates: ResolvedFile[],
      input: DownloadInput,
      recorded: StreamHistoryItem | null,
      allFiles: ResolvedFile[],
    ) => {
      setStreamedFiles(new Set());
      setStreamSource(input);
      // KEYED BY INFOHASH, not just cleared on read. `openStreamPicker` runs
      // only when a MULTI-FILE torrent actually resolves, so every other path
      // leaves the ref set: `streamResult` bailing on its guard, the
      // torrent-stream ack prompt being cancelled, an RD resolve failing, or a
      // single-file torrent. Without the key, a stale target from an abandoned
      // play preselects the wrong episode in a later, unrelated picker.
      const packTarget = packTargetFor(packTargetRef.current, input.id);
      if (packTarget) packTargetRef.current = null;
      setStreamPreselect(
        nextEpisodeIndex(candidates, {
          next: packTarget ?? (recorded ? nextEpisode(recorded) : null),
          watched: watchedFor(config?.favourites ?? [], input.id),
        }),
      );
      setStreamFiles(candidates);
      setStreamAllFiles(allFiles);
    },
    [config],
  );

  // Stream a torrent directly (no debrid): cache metadata, spin up a
  // local HTTP server for the files, then hand off to the same player/picker
  // path the debrid flow uses.
  const startTorrentStream = useCallback(
    (input: DownloadInput) => {
      if (!config) return;
      if (preparing || streamFiles || activeStream) return;
      const controller = new AbortController();
      prepareAbort.current = controller;
      setPreparing({
        label: truncate(cleanText(input.name), 32),
        phase: "caching",
        pct: 0,
        source: "torrent",
      });
      void (async () => {
        try {
          if (!(await ensureVpnSafe())) {
            setPreparing(null);
            return;
          }
          const session = await streamTorrent(input.magnet, { signal: controller.signal });
          if (controller.signal.aborted) {
            void session.stop();
            return;
          }
          prepareAbort.current = null;
          setPreparing(null);
          // StreamFilePrompt orders the list (title by default, size on toggle),
          // so the pre-sort here only decided candidates[0] for the single-file case.
          const candidates = streamCandidates(session.files);
          if (candidates.length === 0) {
            setNotice("This torrent has nothing to stream.");
            void session.stop();
            return;
          }
          setActiveStream({ session, name: input.name, input });
          void postEvent(
            resolveReccConfig(config),
            { type: "started", rawName: input.name, ts: Date.now(), source: "torlink" },
          );
          const recorded = await recordStreamHistory(input);
          if (candidates.length > 1) {
            openStreamPicker(candidates, input, recorded, session.files);
          } else {
            const preferred = preferredSubtitle(subtitlesFor(candidates[0]!, session.files));
            void playStream(
              candidates[0]!.url,
              input.name,
              () => markPlayed(input.id, candidates[0]!.filename),
              preferred?.url ?? "",
            );
          }
        } catch (e) {
          prepareAbort.current = null;
          setPreparing(null);
          if (controller.signal.aborted) return;
          setNotice(e instanceof Error ? e.message : "Couldn't start torrent stream.");
        }
      })();
    },
    [config, preparing, streamFiles, activeStream, playStream, ensureVpnSafe, markPlayed, recordStreamHistory, openStreamPicker],
  );

  useEffect(() => {
    const name = config?.vpnInterface?.trim();
    if (!queue) return;
    if (!name) { vpnUnsafe.current = false; queue.setP2PAllowed(true); return; }
    let alive = true;
    const check = async (): Promise<void> => {
      const safe = await vpnRouteIsSafe(name);
      if (!alive) return;
      queue.setP2PAllowed(safe);
      if (!safe && !vpnUnsafe.current) {
        vpnUnsafe.current = true;
        const active = activeStreamRef.current;
        if (active) {
          activeStreamRef.current = null;
          setActiveStream(null);
          void active.session.stop();
        }
        setNotice(`VPN kill switch: ${name} lost the default route; P2P stopped.`);
      } else if (safe) vpnUnsafe.current = false;
    };
    void check();
    const timer = setInterval(() => void check(), 1000);
    timer.unref();
    return () => { alive = false; clearInterval(timer); };
  }, [config?.vpnInterface, queue]);

  const stopStream = useCallback(() => {
    const active = activeStream;
    if (!active) return;
    setActiveStream(null);
    setRatePrompt({ name: active.name });
    if (active.session.isComplete()) {
      // Fully downloaded: offer to keep it as a real download + seed instead
      // of discarding the temp files.
      setKeepPrompt({ session: active.session, input: active.input });
    } else {
      void active.session.stop(); // partial: discard
      setNotice("Stream stopped.");
    }
  }, [activeStream]);

  // Keep a ref to the latest active stream so the unmount-only cleanup effect
  // below (and quitAll) can reach it without re-running on every change.
  const activeStreamRef = useRef<typeof activeStream>(null);
  useEffect(() => {
    activeStreamRef.current = activeStream;
  }, [activeStream]);

  // Same pattern for a pending keep prompt: it still holds a live (complete)
  // stream session awaiting a keep/discard decision, so it needs the same
  // unmount-time cleanup as activeStreamRef.
  const keepPromptRef = useRef<typeof keepPrompt>(null);
  useEffect(() => {
    keepPromptRef.current = keepPrompt;
  }, [keepPrompt]);

  // Defensively make sure a live torrent-stream session (and its temp dir)
  // don't leak past the process if the component unmounts unexpectedly.
  useEffect(() => {
    return () => {
      void activeStreamRef.current?.session.stop();
      void keepPromptRef.current?.session.stop();
      // Stream sessions are engines and temp dirs, not just rows in a map: a
      // stream the browser started outlives the TUI unless it is stopped on the
      // same teardown path the queue's suspend() runs on. Deliberately in the
      // unmount-only effect rather than beside that suspend(), whose cleanup
      // also fires when `queue` flips null -> queue during boot.
      void sessionsRef.current?.stopAll();
    };
  }, []);

  const streamResult = useCallback(
    (input: DownloadInput) => {
      if (!config) return;
      if (preparing || streamFiles) return; // one prepare/pick at a time
      if (activeStream) {
        setNotice("Stop the current stream first (x).");
        return;
      }
      const route = classifyStreamRoute(config, debridStatus);
      if (route.kind === "torrent-auto") {
        if (config.torrentStreamAck) {
          startTorrentStream(input);
          return;
        }
        setTorrentPrompt({ input }); // one-time warning, remembered on confirm
        return;
      }
      if (route.kind === "torrent-confirm") {
        setTorrentPrompt({ input, reason: route.reason }); // always warn
        return;
      }
      // route.kind === "debrid": resolve via whichever provider
      // classifyStreamRoute picked.
      const provider = route.provider;
      const meta = getDebridProvider(provider);
      const token = resolveDebridTokenFor(config, provider);
      if (!token) {
        setNotice(`Set a ${meta.label} token first — open the Settings tab.`);
        return;
      }
      const label = truncate(cleanText(input.name), 32);
      const controller = new AbortController();
      prepareAbort.current = controller;
      setPreparing({ label, phase: "caching", pct: 0, source: "rd", providerLabel: meta.label });
      void (async () => {
        try {
          const files = await meta.resolveMagnet(token, input.magnet, {
            knownHash: input.id,
            signal: controller.signal,
            // 0<pct<100 means the provider is still caching server-side;
            // otherwise we're about to fetch the direct link.
            onProgress: (pct) =>
              setPreparing((p) =>
                p ? { ...p, phase: pct > 0 && pct < 100 ? "caching" : "fetching", pct } : p,
              ),
          });
          if (controller.signal.aborted) return;
          prepareAbort.current = null;
          // Ordering is handled by StreamFilePrompt; a single candidate needs none.
          const candidates = streamCandidates(files);
          if (candidates.length === 0) {
            setPreparing(null);
            setNotice(`${meta.label} returned nothing to stream.`);
            return;
          }
          void postEvent(
            resolveReccConfig(config),
            { type: "started", rawName: input.name, ts: Date.now(), source: "torlink" },
          );
          const recorded = await recordStreamHistory(input);
          if (candidates.length > 1) {
            setPreparing(null);
            openStreamPicker(candidates, input, recorded, files);
            return;
          }
          const preferred = preferredSubtitle(subtitlesFor(candidates[0]!, files));
          finishStream(
            candidates[0]!,
            input.name,
            () => markPlayed(input.id, candidates[0]!.filename),
            preferred?.url ?? "",
          );
        } catch (e) {
          prepareAbort.current = null;
          setPreparing(null);
          // A user-initiated cancel already surfaced its own notice; don't
          // clobber it with the cancellation error this throws.
          if (controller.signal.aborted) return;
          if (meta.isTokenRejection(e)) {
            setDebridStatus(null);
            setNotice(`${meta.label} token expired — re-enter it.`);
            setShowHelp(false);
            setEditingToken({ provider });
            return;
          }
          setTorrentPrompt({
            input,
            reason: `${meta.label} couldn't prepare this stream (${e instanceof Error ? e.message : "unknown error"})`,
          });
        }
      })();
    },
    [config, finishStream, preparing, streamFiles, activeStream, debridStatus, startTorrentStream, markPlayed, recordStreamHistory, openStreamPicker],
  );

  // Reopen a favourited series: re-resolve its magnet through the same stream
  // flow (RD or torrent), which reopens the picker for multi-file torrents.
  const openFavourite = useCallback(
    (fav: FavouriteItem) => {
      streamResult({
        id: fav.id,
        name: fav.name,
        magnet: fav.magnet,
        source: fav.source,
        sizeBytes: fav.sizeBytes,
      });
    },
    [streamResult],
  );

  // Replay the remembered torrent. `streamResult` is the same path a search hit
  // takes, so a dead swarm surfaces the same way it does anywhere else.
  const openStreamHistory = useCallback(
    (item: StreamHistoryItem) => {
      streamResult({ id: item.infoHash, name: item.rawName, magnet: item.magnet, source: item.source });
    },
    [streamResult],
  );

  // Search, pick, play. Calls `runSearch` directly rather than going through
  // `submitQuery`: that only sets query state, and the fetch lives in
  // `useConcurrentSearch`, which a callback cannot invoke. This is the same
  // core entry point the hook uses, so results are identical to what the
  // Results pane would have shown.
  // Cancels any auto-play already in flight. `runSearch`'s per-source timeout
  // is 25 SECONDS, so without this a user who hits Enter and then moves on gets
  // a player for a title they left, and a double Enter runs two searches whose
  // second `streamResult` bounces off "Stop the current stream first". Note the
  // guards inside `streamResult` cannot help: they are evaluated after the
  // await, when nothing is streaming yet. `useConcurrentSearch` aborts the same
  // way on cleanup; this is the keypress path's equivalent.
  const autoPlayRef = useRef<AbortController | null>(null);

  // The episode auto-play is actually after, when it had to settle for a pack.
  // Beats `nextEpisode(recorded)` because the pack's own history row has no
  // episode to derive one from. Keyed by infohash and cleared on use.
  const packTargetRef = useRef<PackTarget | null>(null);

  const autoPlayTitle = useCallback(
    (title: string, intent: PickIntent, fallback?: () => void) => {
      if (!config) return;
      // Cancel-and-replace rather than ignore-while-busy: pressing Enter on a
      // different row is a clear statement about what the user now wants.
      autoPlayRef.current?.abort();
      const ctrl = new AbortController();
      autoPlayRef.current = ctrl;
      void (async () => {
        setNotice(pickSearchingLine(title));
        const sources = enabledSources(
          (config.disabledSources ?? []) as SourceId[],
          resolveAdultContent(config),
        );
        const snap = await runSearch(title, sources, { signal: ctrl.signal });
        // An aborted search RESOLVES rather than rejecting, with whatever the
        // snapshot held when the abort landed — usually empty
        // (src/core/search.ts:108-111 documents this, and requires callers to
        // treat an abort as a discard). So no try/catch: the identity check
        // below is what discards it, and it must come before anything that
        // reads `snap`, or a superseded search would report "no release found"
        // over the newer one's status line.
        if (autoPlayRef.current !== ctrl) return;
        autoPlayRef.current = null;
        const prefs = qualityPrefsFrom(config);
        const pick = pickBestRelease(snap.results, prefs, intent);
        if (!pick) {
          // Say so even when there is a fallback: `openStreamHistory` (the
          // fallback Continue Watching passes) only starts a stream — it does
          // not set a notice of its own — so without this the resumed torrent
          // just appears with no explanation, unlike the browser, which shows
          // "No release found…" before it falls back to the same replay.
          setNotice(pickNoneLine(title));
          fallback?.();
          return;
        }
        setNotice(pickStatusLine(pick, prefs.maxResolution));
        packTargetRef.current =
          pick.fromPack && intent.kind === "episode"
            ? { infoHash: pick.chosen.infoHash, next: { season: intent.season, episode: intent.episode } }
            : null;
        streamResult({
          id: pick.chosen.infoHash,
          name: pick.chosen.name,
          magnet: pick.chosen.magnet,
          source: pick.chosen.source,
          sizeBytes: pick.chosen.sizeBytes,
        });
      })();
    },
    [config, streamResult],
  );

  // Optimistic locally, re-read on disk. The row must vanish under the cursor
  // now; the FILE must not be written from this component's snapshot, because
  // `serve --web` is a separate process appending to it (see
  // forgetStreamHistory). Same total swallow as recordStreamHistory above, and
  // for the same reason: every throwable call sits inside the try, so nothing
  // here can become an unhandled rejection in the TUI's Node process.
  const removeStreamHistoryEntry = useCallback((key: string) => {
    setStreamHistory((prev) => removeStreamHistory(prev, key));
    void (async () => {
      try {
        setStreamHistory(await forgetStreamHistory(key));
      } catch {
        /* ignore — see above */
      }
    })();
  }, []);

  const closePlayerPrompt = useCallback(() => {
    setEditingPlayer(false);
    setPendingStream(null);
    setNotice("Stream link is on your clipboard.");
  }, []);

  const setMediaPlayer = useCallback(
    (raw: string) => {
      setEditingPlayer(false);
      if (!config) return;
      const cmd = raw.trim();
      const ctx = pendingStream;
      setPendingStream(null);
      if (!cmd) {
        setNotice("Stream link is on your clipboard.");
        return;
      }
      setConfig({ ...config, mediaPlayer: cmd });
      void (async () => {
        if (!ctx?.url) {
          setNotice(`Media player set: ${cmd}`);
          return;
        }
        const ok = await launchPlayer(cmd, ctx.url, ctx.subtitleUrl ?? "");
        if (ok) {
          setNotice(`${ICON.done} Streaming in ${cmd}`);
          ctx.onPlayed?.();
        } else {
          setNotice(`Couldn't launch ${cmd}. Link is on your clipboard.`);
        }
      })();
    },
    [config, setConfig, pendingStream],
  );

  // Auto-detect a working player, launch it, and persist it so a bad saved
  // command self-heals. Falls back to the command-entry prompt when detection
  // finds nothing or the detected player won't launch.
  const autoDetectPlayer = useCallback(() => {
    const ctx = pendingStream;
    if (!config || !ctx) {
      setEditingPlayer(false);
      setPendingStream(null);
      return;
    }
    void (async () => {
      const player = await detectAndPlay(ctx.url, ctx.subtitleUrl ?? "");
      if (player) {
        setConfig({ ...config, mediaPlayer: player });
        setNotice(`${ICON.done} Streaming in ${player}`);
        ctx.onPlayed?.();
        setEditingPlayer(false);
        setPendingStream(null);
      } else {
        setNotice("No player detected — enter a command.");
        setPlayerPromptMode("edit");
      }
    })();
  }, [config, pendingStream, setConfig]);

  // Switch the choice prompt to the plain command-entry prompt.
  const editPlayerCommand = useCallback(() => {
    setPlayerPromptMode("edit");
  }, []);

  const openDnsPrompt = useCallback(() => {
    setShowHelp(false);
    setEditingDns(true);
  }, []);

  // The adult / relay toggles, extracted so the `X` and `N` keybindings and the
  // Settings pane's rows drive one implementation — a second copy is the
  // copy-then-drift bug this codebase keeps hitting.
  const toggleAdult = useCallback(() => {
    setShowHelp(false);
    // The env var wins over config (resolveAdultContent), so flipping the stored
    // preference can't override it — say so rather than silently no-op'ing.
    if (process.env.TORLINK_ADULT !== undefined) {
      setNotice("Adult content is controlled by the TORLINK_ADULT env var.");
      return;
    }
    const enabled = config?.adultContent !== true;
    persistConfig({ adultContent: enabled });
    setNotice(enabled ? "Adult content enabled." : "Adult content disabled.");
  }, [config, persistConfig]);

  const toggleProxy = useCallback(() => {
    setShowHelp(false);
    const enabled = config?.proxyDebridStreams !== true;
    persistConfig({ proxyDebridStreams: enabled });
    setNotice(
      enabled
        ? "Debrid streams now relay through this machine — uses your upload bandwidth."
        : "Debrid streams go straight from the provider to the player.",
    );
  }, [config, persistConfig]);

  const toggleAdultScreenshots = useCallback(() => {
    setShowHelp(false);
    // Default is ON (absent === enabled), so the first toggle turns it OFF.
    const enabled = config?.adultScreenshots === false;
    persistConfig({ adultScreenshots: enabled });
    setNotice(enabled ? "Adult screenshots enabled." : "Adult screenshots disabled.");
  }, [config, persistConfig]);

  // Persist a custom DNS spec and apply it immediately, so the next search uses
  // it without a restart. An empty value falls back to the system resolver.
  const setDns = useCallback(
    (raw: string) => {
      setEditingDns(false);
      if (!config) return;
      const spec = raw.trim();
      const servers = spec ? spec.split(",").map((s) => s.trim()).filter(Boolean) : [];
      const next: Config = { ...config, dnsServers: servers.length ? servers : undefined };
      setConfig(next);
      setDnsServers(resolveDnsServers(next));
      if (process.env["TORLINK_DNS"]?.trim()) {
        setNotice("DNS saved, but TORLINK_DNS is set — unset it for the change to apply.");
      } else {
        setNotice(servers.length ? `Custom DNS set: ${servers.join(", ")}` : "Using system DNS.");
      }
    },
    [config, setConfig],
  );

  const clearDns = useCallback(() => {
    setEditingDns(false);
    if (!config) return;
    setConfig({ ...config, dnsServers: undefined });
    if (process.env["TORLINK_DNS"]?.trim()) {
      setNotice("DNS is set via TORLINK_DNS — unset the env var to use system DNS.");
      return;
    }
    setDnsServers([]);
    setNotice("Using system DNS.");
  }, [config, setConfig]);

  const openRutrackerPrompt = useCallback(() => {
    setRutrackerCaptcha(undefined);
    setRutrackerStatus({ kind: "idle" });
    setRutrackerUser(getRutrackerSession()?.username);
    setShowHelp(false);
    setEditingRutracker(true);
  }, []);

  const closeRutrackerPrompt = useCallback(() => {
    setEditingRutracker(false);
    setRutrackerStatus({ kind: "idle" });
    setRutrackerCaptcha(undefined);
  }, []);

  const signOutRutracker = useCallback(() => {
    void clearRutrackerSession().then(() => {
      setRutrackerUser(undefined);
      clearRutrackerCache();
      clearCacheByPrefix("rt-");
      setNotice(`${ICON.done} Signed out of RuTracker`);
    });
  }, [setNotice]);

  const submitRutrackerLogin = useCallback(
    (username: string, password: string, captchaCode?: string) => {
      setRutrackerStatus({ kind: "busy" });
      const captchaAnswer =
        rutrackerCaptcha && captchaCode
          ? { sid: rutrackerCaptcha.sid, field: rutrackerCaptcha.field, code: captchaCode }
          : undefined;
      void rutrackerLogin(username, password, { captcha: captchaAnswer })
        .then((outcome) => {
          if (outcome.kind === "ok") {
            setRutrackerUser(outcome.session.username);
            clearRutrackerCache();
            clearCacheByPrefix("rt-");
            setNotice(`${ICON.done} Signed in to RuTracker`);
            closeRutrackerPrompt();
          } else if (outcome.kind === "captcha") {
            setRutrackerCaptcha(outcome.captcha);
            setRutrackerStatus({ kind: "idle" });
          } else {
            setRutrackerStatus({ kind: "error", message: outcome.message });
          }
        })
        .catch((e: unknown) => {
          setRutrackerStatus({
            kind: "error",
            message: e instanceof Error ? e.message : "Couldn't reach RuTracker.",
          });
        });
    },
    [rutrackerCaptcha, closeRutrackerPrompt],
  );

  const copyCaptchaLink = useCallback((url: string) => {
    void writeClipboard(url).then((ok) =>
      setNotice(ok ? `${ICON.done} Captcha link copied` : "Couldn't copy the captcha link."),
    );
  }, []);

  // The plain (P2P) download button: when a debrid provider is configured,
  // route through a warning first since P2P exposes the user's IP to the swarm.
  const requestP2PDownload = useCallback(
    (input: DownloadInput) => {
      if (config && resolveActiveDebrid(config)) {
        setPendingP2P(input);
        return;
      }
      startDownload(input);
    },
    [config, startDownload],
  );

  const requestDownloadTo = useCallback(
    (input: {
      id: string;
      name: string;
      magnet: string;
      source?: SourceId;
      sizeBytes?: number;
    }) => {
      setPendingDownload(input);
    },
    [],
  );

  const closeDownloadToPrompt = useCallback(() => {
    setPendingDownload(null);
  }, []);

  const startDownloadTo = useCallback(
    (raw: string) => {
      const input = pendingDownload;
      setPendingDownload(null);
      const dir = normalizeDownloadDir(raw);
      if (!queue || !input || !dir) return;
      // add() ignores the dir for anything already active, so don't claim a
      // folder that won't be used. Failed items fall through: a re-add with a
      // fresh dir is exactly how a bad-disk download gets redirected.
      const existing = queue.getItems().find((it) => it.id === input.id);
      if (existing && existing.status !== "failed") {
        setNotice(`Already in queue: ${truncate(cleanText(input.name), 40)}`);
        return;
      }
      void (async () => {
        try {
          await fs.mkdir(dir, { recursive: true });
        } catch {
          setNotice(`Couldn't use folder: ${truncate(dir, 48)}`);
          return;
        }
        setLastDownloadToDir(dir);
        queue.add(input, dir);
        setNotice(`Added: ${truncate(cleanText(input.name), 28)} → ${truncate(dir, 36)}`);
        setSection("downloads");
        setRegion("content");
      })();
    },
    [queue, pendingDownload],
  );

  const copyMagnet = useCallback((input: { name: string; magnet: string }) => {
    void (async () => {
      const ok = await writeClipboard(input.magnet);
      if (ok) {
        setNotice(`Copied magnet: ${truncate(cleanText(input.magnet), 60)}`);
        return;
      }
      setNotice(`Couldn't copy magnet for ${truncate(cleanText(input.name), 32)}.`);
    })();
  }, []);

  const copyLink = useCallback((url: string, name: string) => {
    void (async () => {
      const ok = await writeClipboard(url);
      setNotice(
        ok
          ? `Copied link: ${truncate(cleanText(name), 40)}`
          : `Couldn't copy the link for ${truncate(cleanText(name), 32)}.`,
      );
    })();
  }, []);

  const openDownloadFolder = useCallback((dir: string) => {
    void (async () => {
      const ok = await openFolder(dir);
      if (ok) {
        setNotice(`Opened: ${truncate(dir, 48)}`);
        return;
      }
      setNotice(`Couldn't open folder: ${truncate(dir, 48)}`);
    })();
  }, []);

  const exportTorrent = useCallback(
    (input: { id: string; name: string }) => {
      if (!queue) return;
      void (async () => {
        const file = await queue.exportTorrentFile(input.id);
        if (file) {
          setNotice(`Exported torrent file: ${truncate(file, 48)}`);
          return;
        }
        setNotice(`No torrent file yet for ${truncate(cleanText(input.name), 32)}.`);
      })();
    },
    [queue],
  );

  const fetchAndExportTorrent = useCallback(
    (input: { id: string; name: string; magnet: string }) => {
      if (!queue || !config) return;
      setNotice("Fetching torrent metadata…");
      void (async () => {
        const file = await queue.fetchAndExportTorrent(input, config.downloadDir);
        if (file) {
          setNotice(`Exported torrent file: ${truncate(file, 48)}`);
          return;
        }
        setNotice(`Couldn't export torrent file for ${truncate(cleanText(input.name), 32)}.`);
      })();
    },
    [queue, config],
  );

  const submitQuery = useCallback(
    (raw: string) => {
      const q = raw.trim();
      if (q) {
        const magnet = parseInput(q);
        if (magnet) {
          requestP2PDownload({
            id: magnet.infoHash,
            name: magnet.name,
            magnet: magnet.magnet,
          });
          setView("browser");
          return;
        }
      }
      setQuery(q);
      if (q) {
        // Record the search for up-arrow recall. Functional update so it always
        // extends the latest persisted history, never a stale snapshot.
        setConfigState((prev) => {
          if (!prev) return prev;
          const next = { ...prev, searchHistory: addToHistory(prev.searchHistory ?? [], q) };
          void saveConfig(next);
          return next;
        });
      }
      setView("browser");
      if (section === "downloads") setSection("all");
      setRegion("content");
    },
    [section, requestP2PDownload],
  );

  const pasteFromClipboard = useCallback(async () => {
    const text = (await readClipboard()).trim();
    if (!text) {
      setNotice("Clipboard is empty.");
      return;
    }
    const found = text.match(/magnet:\?xt=urn:btih:[^\s"'<>]+/i)?.[0];
    const magnet = parseInput(found ?? text);
    if (magnet) {
      requestP2PDownload({ id: magnet.infoHash, name: magnet.name, magnet: magnet.magnet });
      setView("browser");
      return;
    }
    setNotice("No magnet link on the clipboard.");
  }, [requestP2PDownload]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  // Stale cached markers are worse than none — a marker on the wrong row — so
  // both triggers that mean "these results no longer apply" reset the set:
  // a new query, and switching which debrid account is active.
  useEffect(() => {
    cachedRequestId.current += 1;
    setCachedHashes(new Set());
  }, [query]);

  const activeCachedProvider = config ? (resolveActiveDebrid(config)?.provider ?? null) : null;
  useEffect(() => {
    cachedRequestId.current += 1;
    setCachedHashes(new Set());
  }, [activeCachedProvider]);

  // Called by Results.tsx once a search settles with the hashes on screen.
  // Lives here, not in Results.tsx, because only App.tsx holds the debrid
  // token — Store deliberately carries no token (see Store's own comments) —
  // and resolveActiveDebrid/getDebridProvider is the one place that already
  // knows how to find both.
  const refreshCachedHashes = useCallback(
    (hashes: readonly string[]) => {
      const requestId = ++cachedRequestId.current;
      const active = config ? resolveActiveDebrid(config) : null;
      if (!active || getDebridProvider(active.provider).checkCached === undefined || hashes.length === 0) {
        setCachedHashes(new Set());
        return;
      }
      void cachedHashesFor(getDebridProvider(active.provider), active.token, hashes).then((result) => {
        if (cachedRequestId.current === requestId) setCachedHashes(result);
      });
    },
    [config],
  );

  const [prepElapsed, setPrepElapsed] = useState(0);
  useEffect(() => {
    if (!preparing) {
      setPrepElapsed(0);
      return;
    }
    const started = Date.now();
    const t = setInterval(() => setPrepElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [preparing]);

  const compact = rows < 18;
  const showTopRule = !compact;
  const showFooter = rows >= 12;
  const chrome =
    3 +
    (showTopRule ? 1 : 0) +
    (compact ? 0 : 1) +
    (showFooter ? 1 : 0);
  const bodyH = Math.max(6, rows - 1 - chrome);
  const listRows = Math.max(4, bodyH);
  // The help sheet replaces the body region. Cap its scrollable groups area so
  // its header and footer stay on screen; `helpMaxScroll` bounds paging.
  const helpMaxRows = Math.max(4, bodyH - 9);
  const helpMaxScroll = Math.max(0, helpContentHeight(cols) - helpMaxRows);
  const contentWidth = Math.max(24, cols - RAIL_WIDTH - 3);
  const ruleWidth = Math.max(10, cols - 2);

  const store: Store | null = useMemo(() => {
    if (!queue || !config) return null;
    return {
      config,
      setConfig,
      queue,
      view,
      setView,
      query,
      submitQuery,
      searchHistory: config.searchHistory ?? [],
      savedSearches: config.savedSearches ?? [],
      toggleSavedSearch,
      favourites: config.favourites ?? [],
      toggleFavourite,
      removeFavourite,
      openFavourite,
      isFavourited,
      streamHistory,
      openStreamHistory,
      removeStreamHistory: removeStreamHistoryEntry,
      autoPlayTitle,
      section,
      setSection: changeSection,
      sort,
      setSort,
      disabledSources: (config.disabledSources ?? []) as SourceId[],
      toggleSource,
      region:
        showHelp || editingFolder || editingToken || editingRecc || claimingRecc || editingOmdb || editingPlayer || editingSources || editingQuality || editingDns || editingRutracker || editingTrackers || editingLimits || editingVpn || editingCastDevice || editingCastHost || pendingP2P || pendingDownload || fileSelection || streamFiles || preparing || torrentPrompt || keepPrompt || ratePrompt || importingNetflix || importChooser || importingTrakt
          ? "help"
          : region,
      setRegion,
      captureMode,
      setCaptureMode,
      downloadFocus,
      setDownloadFocus,
      seedFocus,
      setSeedFocus,
      resultFocus,
      setResultFocus,
      startDownload,
      requestP2PDownload,
      requestDownloadTo,
      startDebridDownload,
      streamResult,
      debridConfigured: resolveActiveDebrid(config) !== null,
      debridProvider: resolveActiveDebrid(config)?.provider ?? null,
      reccConfigured: Boolean(resolveReccConfig(config).reccUrl),
      omdbConfigured: resolveOmdbApiKey(config) !== "",
      omdbApiKey: resolveOmdbApiKey(config),
      adultEnabled: resolveAdultContent(config),
      adultScreenshots: resolveAdultScreenshots(config),
      streamActive: activeStream !== null,
    castStatus,
      debridStatus,
      cachedHashes,
      refreshCachedHashes,
      copyLink,
      copyMagnet,
      openDownloadFolder,
      exportTorrent,
      fetchAndExportTorrent,
      notice,
      setNotice,
      quitAll,
      listRows,
      compact,
      contentWidth,
      cols,
      rows,
    };
  }, [
    queue,
    config,
    view,
    query,
    submitQuery,
    toggleSavedSearch,
    toggleFavourite,
    removeFavourite,
    openFavourite,
    isFavourited,
    streamHistory,
    openStreamHistory,
    removeStreamHistoryEntry,
    autoPlayTitle,
    section,
    changeSection,
    sort,
    setSort,
    region,
    showHelp,
    editingFolder,
    editingToken,
    editingRecc,
    claimingRecc,
    editingOmdb,
    editingPlayer,
    editingSources,
    editingQuality,
    editingDns,
    editingRutracker,
    editingTrackers,
    editingLimits,
    editingVpn,
    editingCastDevice,
    editingCastHost,
    toggleSource,
    pendingP2P,
    pendingDownload,
    fileSelection,
    streamFiles,
    preparing,
    torrentPrompt,
    keepPrompt,
    ratePrompt,
    importingNetflix,
    importChooser,
    importingTrakt,
    activeStream,
    castStatus,
    captureMode,
    downloadFocus,
    seedFocus,
    resultFocus,
    startDownload,
    requestP2PDownload,
    requestDownloadTo,
    startDebridDownload,
    streamResult,
    debridStatus,
    cachedHashes,
    refreshCachedHashes,
    copyLink,
    copyMagnet,
    openDownloadFolder,
    exportTorrent,
    fetchAndExportTorrent,
    notice,
    listRows,
    compact,
    contentWidth,
    cols,
    rows,
    setConfig,
    quitAll,
  ]);

  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") {
        quitAll();
        return;
      }
      if (editingFolder) return; // the folder prompt owns input (its own esc + enter)
      if (editingToken) return; // the token prompt owns input
      if (editingRecc) return; // the reccd prompt owns input
      if (claimingRecc) return; // the claim prompt owns input
      if (editingOmdb) return; // the OMDb key prompt owns input
      if (importingNetflix) return; // the Netflix import prompt owns input
      if (importChooser) return; // the import-source chooser owns input
      if (importingTrakt) return; // the Trakt import prompt owns input
      if (editingPlayer) return; // the media-player prompt owns input
      if (editingSources) return; // the sources panel owns input
      if (editingQuality) return; // the quality prompt owns input
      if (editingDns) return; // the DNS prompt owns input
      if (editingRutracker) return; // the RuTracker prompt owns input
      if (editingTrackers) return; // the trackers prompt owns input
      if (editingLimits) return; // the limits prompt owns input
      if (editingVpn) return; // the VPN prompt owns input
      if (editingCastDevice) return; // the cast-device prompt owns input
      if (editingCastHost) return; // the cast-host prompt owns input
      if (pendingP2P) return; // the P2P warning owns input
      if (pendingDownload) return; // the download-to prompt owns input
      if (fileSelection) return; // the download file picker owns input
      if (torrentPrompt) return; // the torrent privacy warning owns input
      if (keepPrompt) return; // the keep-download prompt owns input
      if (ratePrompt) return; // the like/dislike prompt owns input
      if (streamFiles) return; // the file picker owns input
      if (preparing) {
        if (key.escape) cancelPreparing();
        return; // swallow other keys while preparing
      }
      // The cast row's two keys, ahead of the stream's own `x`. A cast and a
      // local stream can both be live — casting does not stop the torrent
      // feeding it — and while a television is playing, "stop" means the thing
      // on the television. Stopping the cast leaves the stream running, which is
      // what makes pressing `x` twice do the two obvious things in order.
      if (castStatus && (input === "x" || input === "X")) {
        castCommand("stop");
        return;
      }
      if (castStatus && (input === "p" || input === "P")) {
        castCommand(castStatus.state === "paused" ? "play" : "pause");
        return;
      }
      if (activeStream && (input === "x" || input === "X")) {
        stopStream();
        return;
      }
      if (captureMode === "text") return;
      if (showHelp) {
        // While the sheet overflows, arrows/jk page through it; any other key
        // (and arrows once it fits) dismisses it.
        if (helpMaxScroll > 0 && (key.upArrow || input === "k")) {
          setHelpScroll((s) => Math.max(0, s - 1));
          return;
        }
        if (helpMaxScroll > 0 && (key.downArrow || input === "j")) {
          setHelpScroll((s) => Math.min(helpMaxScroll, s + 1));
          return;
        }
        setShowHelp(false);
        return;
      }
      if (input === "?") {
        setHelpScroll(0);
        setShowHelp(true);
        return;
      }
      if (input === "o") {
        setShowHelp(false);
        setEditingFolder(true);
        return;
      }
      if (input === "S") {
        setShowHelp(false);
        setEditingSources(true);
        return;
      }
      if (input === "P") {
        setShowHelp(false);
        setEditingQuality(true);
        return;
      }
      if (input === "D") {
        openDnsPrompt();
        return;
      }
      if (input === "t" && !(region === "content" && section === "forYou")) {
        setShowHelp(false);
        setEditingTrackers(true);
        return;
      }
      if (input === "L") {
        setShowHelp(false);
        setEditingLimits(true);
        return;
      }
      if (input === "V") {
        setShowHelp(false);
        setEditingVpn(true);
        return;
      }
      if (input === "W") {
        setShowHelp(false);
        // Deliberately not stealing focus like the daemon's auto-open does:
        // this is a terminal UI, so opening a browser only happens on request.
        if (webStatus && "url" in webStatus) {
          const target = webStatus.url;
          void openUrl(target).then((ok) => {
            if (!ok) setNotice(`Couldn't open a browser — open ${target} yourself`);
          });
        } else if (webStatus) {
          // Three states, not two. A failed bind is not the same as no --web,
          // and telling someone who passed the flag to pass the flag sends them
          // in a circle — the reason is in the log (the splash says so too).
          setNotice("The web UI failed to start — see the log");
        } else {
          setNotice("The web UI is not running — relaunch with --web");
        }
        return;
      }
      if (input === "X") {
        toggleAdult();
        return;
      }
      if (input === "N") {
        toggleProxy();
        return;
      }
      if (input === "m") {
        void pasteFromClipboard();
        return;
      }
      if (key.tab) {
        setRegion(region === "sidebar" ? "content" : "sidebar");
        return;
      }
      if (key.rightArrow || input === "l") {
        if (region === "sidebar") setRegion("content");
        return;
      }
      if (key.leftArrow || input === "h") {
        if (region === "content") setRegion("sidebar");
        return;
      }
      if (key.escape) {
        if (captureMode === "esc") return;
        if (region === "content") {
          setRegion("sidebar");
          return;
        }
        setView("splash");
        return;
      }
      if (input === "q") {
        quitAll();
        return;
      }
    },
    { isActive: isRawModeSupported && view === "browser" && !!store },
  );

  if (!store) {
    return (
      <Box height={rows} justifyContent="center" alignItems="center">
        <Spinner label="Starting torlink" />
      </Box>
    );
  }

  if (view === "splash") {
    return (
      <StoreContext.Provider value={store}>
        <TabTitle />
        <Splash
          updateVersion={updateVersion}
          recovered={recovered}
          webStatus={webStatus}
          reccConfig={resolveReccConfig(store.config)}
        />
      </StoreContext.Provider>
    );
  }

  // The active provider's display name, or undefined when none is configured —
  // every "Real-Debrid" string below reads from this rather than a literal, so
  // a TorBox-only account sees its own provider named back to it.
  const activeDebridLabel = store.debridProvider ? getDebridProvider(store.debridProvider).label : undefined;

  return (
    <StoreContext.Provider value={store}>
      <TabTitle />
      <Box flexDirection="column" paddingX={1}>
        <Box justifyContent="space-between">
          {/* The wordmark never shrinks: without these constraints a long notice
              squeezes the logo box and wraps its own text through the art. */}
          <Box flexShrink={0}>
            <Logo />
          </Box>
          <Box flexShrink={1} minWidth={0} marginLeft={2}>
            <DebridBadge status={debridStatus} />
            {notice ? (
              <Text color={COLOR.good} wrap="truncate-end">{`  ${notice}`}</Text>
            ) : null}
          </Box>
        </Box>
        {preparing ? (
          <Box>
            <Spinner
              // The line itself is shared with the browser
              // (src/util/prepareLine.ts) so the two front ends cannot drift on
              // what a waiting user reads. The key hint is appended here and
              // only here: the browser has a Cancel button in its place.
              label={`${prepareLine({ ...preparing, elapsedSec: prepElapsed })}  (esc cancels)`}
            />
          </Box>
        ) : null}
        {activeStream ? (
          <Box>
            <Text color={COLOR.warn}>
              {`▶ Streaming ${truncate(cleanText(activeStream.name), 40)} via torrent · your IP is visible to peers · x to stop`}
            </Text>
          </Box>
        ) : null}
        {showTopRule ? <Rule width={ruleWidth} /> : null}

        {showHelp ? (
          <Box marginTop={1}>
            <HelpOverlay maxRows={helpMaxRows} scroll={helpScroll} />
          </Box>
        ) : null}

        {editingFolder ? (
          <Box marginTop={1}>
            <FolderPrompt
              width={Math.max(24, Math.min(cols - 4, 62))}
              value={store.config.downloadDir}
              onSubmit={setDownloadDir}
              onCancel={closeFolderPrompt}
            />
          </Box>
        ) : null}

        {editingToken ? (
          <Box marginTop={1}>
            <TokenPrompt
              width={Math.max(24, Math.min(cols - 4, 62))}
              value={
                (editingToken.provider === "torbox"
                  ? store.config.torBoxToken
                  : store.config.realDebridToken) ?? ""
              }
              status={debridStatus?.provider === editingToken.provider ? debridStatus : null}
              provider={getDebridProvider(editingToken.provider)}
              onSubmit={(raw) => setDebridToken(editingToken.provider, raw)}
              onClear={() => clearDebridToken(editingToken.provider)}
              onCancel={closeTokenPrompt}
            />
          </Box>
        ) : null}

        {editingRecc ? (
          <Box marginTop={1}>
            <ReccdPrompt
              width={Math.max(24, Math.min(cols - 4, 62))}
              url={store.config.reccUrl ?? ""}
              token={store.config.reccToken ?? ""}
              status={reccStatus}
              onSubmit={saveReccConfig}
              onCancel={closeReccPrompt}
            />
          </Box>
        ) : null}

        {claimingRecc ? (
          <Box marginTop={1}>
            <ReccClaimPrompt
              width={Math.max(24, Math.min(cols - 4, 62))}
              accountName={reccStatus?.account?.name ?? store.config.reccAccountName}
              error={claimError}
              busy={claimBusy}
              onSubmit={submitClaim}
              onCancel={closeClaimPrompt}
            />
          </Box>
        ) : null}

        {editingOmdb ? (
          <Box marginTop={1}>
            <OmdbPrompt
              width={Math.max(24, Math.min(cols - 4, 62))}
              value={store.config.omdbApiKey ?? ""}
              onSubmit={saveOmdbKey}
              onClear={clearOmdbKey}
              onCancel={closeOmdbPrompt}
            />
          </Box>
        ) : null}

        {importingNetflix ? (
          <Box marginTop={1}>
            <NetflixImportPrompt
              width={Math.max(30, Math.min(cols - 4, 72))}
              state={netflixImport}
              onSubmit={runNetflixImport}
              onClose={closeNetflixImport}
            />
          </Box>
        ) : null}

        {importChooser ? (
          <Box marginTop={1}>
            <ImportSourcePrompt
              width={Math.max(30, Math.min(cols - 4, 72))}
              onSelect={chooseImportSource}
              onCancel={closeImportChooser}
            />
          </Box>
        ) : null}

        {importingTrakt ? (
          <Box marginTop={1}>
            <TraktImportPrompt
              width={Math.max(30, Math.min(cols - 4, 72))}
              state={traktImport}
              onClose={closeTraktImport}
            />
          </Box>
        ) : null}

        {editingPlayer ? (
          <Box marginTop={1}>
            {playerPromptMode === "choice" && pendingStream?.configured ? (
              <ConfirmPrompt
                width={Math.max(24, Math.min(cols - 4, 62))}
                title="media player"
                message={`Couldn't launch "${pendingStream.configured}". Auto-detect a player?`}
                altKey="e"
                altLabel="edit command"
                onConfirm={autoDetectPlayer}
                onAlt={editPlayerCommand}
                onCancel={closePlayerPrompt}
              />
            ) : (
              <StreamPlayerPrompt
                width={Math.max(24, Math.min(cols - 4, 62))}
                value={resolveMediaPlayer(store.config)}
                onSubmit={setMediaPlayer}
                onCancel={closePlayerPrompt}
              />
            )}
          </Box>
        ) : null}

        {editingSources ? (
          <Box marginTop={1}>
            <SourcesPrompt
              width={Math.max(24, Math.min(cols - 4, 62))}
              disabled={(store.config.disabledSources ?? []) as SourceId[]}
              adultEnabled={store.adultEnabled}
              onToggle={toggleSource}
              onCancel={() => setEditingSources(false)}
            />
          </Box>
        ) : null}

        {editingQuality ? (
          <Box marginTop={1}>
            <QualityPrompt
              width={Math.max(24, Math.min(cols - 4, 62))}
              maxResolution={store.config.maxResolution}
              require={store.config.requireFeatures ?? []}
              exclude={store.config.excludeFeatures ?? []}
              onChange={setQualityPrefs}
              onCancel={() => setEditingQuality(false)}
            />
          </Box>
        ) : null}

        {editingDns ? (
          <Box marginTop={1}>
            <DnsPrompt
              width={Math.max(24, Math.min(cols - 4, 62))}
              value={(store.config.dnsServers ?? []).join(",")}
              envOverride={!!process.env["TORLINK_DNS"]?.trim()}
              onSubmit={setDns}
              onClear={clearDns}
              onCancel={() => setEditingDns(false)}
            />
          </Box>
        ) : null}

        {editingRutracker ? (
          <Box marginTop={1}>
            <RutrackerPrompt
              width={Math.max(24, Math.min(cols - 4, 62))}
              currentUser={rutrackerUser}
              status={rutrackerStatus}
              captcha={rutrackerCaptcha}
              onSubmit={submitRutrackerLogin}
              onCopyCaptcha={copyCaptchaLink}
              onCancel={closeRutrackerPrompt}
            />
          </Box>
        ) : null}

        {castPrompt ? (
          <Box marginTop={1}>
            <CastPrompt
              width={Math.max(24, Math.min(cols - 4, 72))}
              devices={castPrompt.devices}
              finding={castPrompt.finding}
              {...(config?.castDevice ? { configured: config.castDevice } : {})}
              onSelect={(device) => castTo(device.id)}
              onAddress={castToAddress}
              onCancel={() => setCastPrompt(null)}
            />
          </Box>
        ) : null}

        {castStatus ? (
          <Box marginTop={1} flexDirection="column">
            <Box>
              <Text color={COLOR.accent}>{`${ICON.pointer} `}</Text>
              <Text>{`Casting to ${castStatus.deviceName}`}</Text>
              <Text dimColor>{`  ${truncate(cleanText(castStatus.title), 40)}`}</Text>
            </Box>
            <Box>
              <Text dimColor>{`  ${castClock(castStatus)}`}</Text>
            </Box>
            <Box marginTop={1}>
              <Text color={COLOR.alt}>p</Text>
              <Text dimColor>{castStatus.state === "paused" ? " resume" : " pause"}</Text>
              <Text dimColor>{` ${ICON.dot} `}</Text>
              <Text color={COLOR.alt}>x</Text>
              <Text dimColor> stop casting</Text>
            </Box>
          </Box>
        ) : null}

        {streamFiles ? (
          <Box marginTop={1}>
            <StreamFilePrompt
              width={Math.max(24, Math.min(cols - 4, 72))}
              maxRows={Math.max(3, bodyH - 4)}
              files={streamFiles}
              allFiles={streamAllFiles ?? streamFiles}
              watched={
                streamSource
                  ? [...watchedFor(config?.favourites ?? [], streamSource.id), ...streamedFiles]
                  : [...streamedFiles]
              }
              preselect={streamPreselect ?? undefined}
              favourited={streamSource ? isFavourited(streamSource.id) : false}
              onFavourite={
                streamSource
                  ? () =>
                      toggleFavourite({
                        id: streamSource.id,
                        name: streamSource.name,
                        magnet: streamSource.magnet,
                        source: streamSource.source,
                        sizeBytes: streamSource.sizeBytes,
                        addedAt: Date.now(),
                      })
                  : undefined
              }
              onSelect={playFromPicker}
              {...(streamSource ? { onCast: castFromPicker } : {})}
              onCancel={() => {
                setStreamFiles(null);
                setStreamAllFiles(null);
                setStreamedFiles(new Set());
                setStreamSource(null);
                setStreamPreselect(null);
                // A debrid stream has no activeStream (files are hosted by the
                // provider, not a local torrent session), so this only fires
                // for the torrent-stream path — leave that path unaffected.
                if (activeStream) {
                  void activeStream.session.stop();
                  activeStreamRef.current = null;
                  setActiveStream(null);
                }
                setNotice("Stream cancelled.");
              }}
            />
          </Box>
        ) : null}

        {fileSelection?.availableFiles ? (
          <Box marginTop={1}>
            <DownloadFilePrompt
              width={Math.max(30, Math.min(cols - 4, 78))}
              files={fileSelection.availableFiles}
              onSubmit={(indices) => {
                if (queue?.selectFiles(fileSelection.id, indices)) {
                  setFileSelection(null);
                  setNotice(`Downloading ${indices.length} selected file${indices.length === 1 ? "" : "s"}.`);
                }
              }}
              onCancel={() => {
                queue?.cancel(fileSelection.id);
                setFileSelection(null);
                setNotice("Download cancelled.");
              }}
            />
          </Box>
        ) : null}

        {pendingP2P ? (
          <Box marginTop={1}>
            <ConfirmPrompt
              width={Math.max(24, Math.min(cols - 4, 62))}
              title="peer-to-peer download"
              message={`This download uses peer-to-peer, so your IP is visible to the swarm. ${activeDebridLabel ?? "A debrid service"} keeps it private. Continue with P2P?`}
              altKey="r"
              altLabel={`use ${activeDebridLabel ?? "debrid"}`}
              onConfirm={() => {
                const input = pendingP2P;
                setPendingP2P(null);
                startDownload(input);
              }}
              onAlt={() => {
                const input = pendingP2P;
                setPendingP2P(null);
                startDebridDownload(input);
              }}
              onCancel={() => setPendingP2P(null)}
            />
          </Box>
        ) : null}

        {torrentPrompt ? (
          <Box marginTop={1}>
            <ConfirmPrompt
              width={Math.max(24, Math.min(cols - 4, 62))}
              title={torrentPrompt.reason ? `${activeDebridLabel ?? "Debrid"} unavailable` : "Stream via torrent?"}
              message={
                torrentPrompt.reason
                  ? `${torrentPrompt.reason}. Streaming via torrent connects you directly to peers, so your IP is visible to the swarm. Continue via torrent?`
                  : `Streaming via torrent connects you directly to peers, so your IP is visible to the swarm (${activeDebridLabel ? `${activeDebridLabel} keeps it private` : "a debrid service keeps it private"}). Continue?`
              }
              onConfirm={() => {
                const { input, reason } = torrentPrompt;
                setTorrentPrompt(null);
                // Remember the acknowledgement only for the no-active-debrid
                // one-time warning (torrent-auto); a torrent-confirm prompt
                // (reason set — a configured-but-inactive Real-Debrid or
                // TorBox account) always prompts again and is never persisted.
                if (!reason && config) setConfig({ ...config, torrentStreamAck: true });
                startTorrentStream(input);
              }}
              onCancel={() => {
                setTorrentPrompt(null);
                setNotice("Stream cancelled.");
              }}
            />
          </Box>
        ) : null}

        {keepPrompt ? (
          <Box marginTop={1}>
            <ConfirmPrompt
              width={Math.max(24, Math.min(cols - 4, 62))}
              title="Keep this download?"
              message={`"${truncate(cleanText(keepPrompt.session.name), 40)}" finished downloading. Keep it in your downloads and seed it?`}
              onConfirm={() => {
                const { session, input } = keepPrompt;
                setKeepPrompt(null);
                void (async () => {
                  try {
                    await session.stop({ keep: true }); // close server/client, leave files
                    if (!config) return;
                    const plan = keepMovePlan({
                      streamDir: session.dir,
                      torrentName: session.name,
                      downloadDir: config.downloadDir,
                    });
                    const ok = await moveKeptFiles(plan, config.downloadDir, {
                      mkdir: (dir, opts) => fs.mkdir(dir, opts),
                      rename: (from, to) => fs.rename(from, to),
                      cp: (from, to, opts) => fs.cp(from, to, opts),
                      rm: (from, opts) => fs.rm(from, opts),
                    });
                    if (!ok) {
                      setNotice("Couldn't keep the download — files left in a temp folder.");
                      return;
                    }
                    startDownload(input); // queue.add verifies on-disk files + seeds
                    setNotice(`Kept & seeding: ${truncate(cleanText(session.name), 32)}`);
                  } catch {
                    setNotice("Couldn't keep the download — files left in a temp folder.");
                  }
                })();
              }}
              onCancel={() => {
                const { session } = keepPrompt;
                setKeepPrompt(null);
                void session.stop(); // discard temp
                setNotice("Stream stopped.");
              }}
            />
          </Box>
        ) : null}

        {ratePrompt ? (
          <Box marginTop={1}>
            <RatePrompt
              width={Math.max(24, Math.min(cols - 4, 62))}
              name={ratePrompt.name}
              title={ratePrompt.title}
              onWatched={
                ratePrompt.showWatched
                  ? () => {
                      if (config) {
                        void postEvent(
                          resolveReccConfig(config),
                          { type: "watched", rawName: ratePrompt.name, ts: Date.now(), source: "torlink" },
                        );
                      }
                      ratePrompt.onRated?.();
                      setRatePrompt(null);
                    }
                  : undefined
              }
              onLike={() => {
                if (config) {
                  void postEvent(
                    resolveReccConfig(config),
                    { type: "liked", rawName: ratePrompt.name, ts: Date.now(), source: "torlink" },
                  );
                }
                ratePrompt.onRated?.();
                setRatePrompt(null);
              }}
              onDislike={() => {
                if (config) {
                  void postEvent(
                    resolveReccConfig(config),
                    { type: "disliked", rawName: ratePrompt.name, ts: Date.now(), source: "torlink" },
                  );
                }
                ratePrompt.onRated?.();
                setRatePrompt(null);
              }}
              onDismiss={() => setRatePrompt(null)}
            />
          </Box>
        ) : null}

        {editingTrackers ? (
          <Box marginTop={1}>
            <TrackersPrompt
              width={Math.max(24, Math.min(cols - 4, 78))}
              value={store.config.trackers}
              onSubmit={setTrackers}
              onCancel={closeTrackersPrompt}
            />
          </Box>
        ) : null}

        {editingLimits ? (
          <Box marginTop={1}>
            <LimitsPrompt
              width={Math.max(30, Math.min(cols - 4, 72))}
              value={store.config}
              onSubmit={setLimits}
              onCancel={() => setEditingLimits(false)}
            />
          </Box>
        ) : null}

        {editingVpn ? (
          <Box marginTop={1}>
            <VpnPrompt
              width={Math.max(30, Math.min(cols - 4, 72))}
              value={store.config.vpnInterface ?? ""}
              onSubmit={setVpnInterface}
              onCancel={() => setEditingVpn(false)}
            />
          </Box>
        ) : null}

        {editingCastDevice ? (
          <Box marginTop={1}>
            <CastAddressPrompt
              width={Math.max(30, Math.min(cols - 4, 72))}
              title="cast device"
              value={store.config.castDevice ?? ""}
              placeholder="host or host:port (192.168.0.40:8009)"
              hint="A Chromecast mDNS can't find. Empty clears it. TORLINK_CAST_DEVICE overrides this."
              onSubmit={setCastDeviceAddress}
              onCancel={() => setEditingCastDevice(false)}
            />
          </Box>
        ) : null}

        {editingCastHost ? (
          <Box marginTop={1}>
            <CastAddressPrompt
              width={Math.max(30, Math.min(cols - 4, 72))}
              title="cast host"
              value={store.config.castAdvertiseHost ?? ""}
              placeholder="host or host:port (192.168.0.10:8080)"
              hint="The LAN address a TV should fetch from (WSL / bridged Docker). Empty clears it. TORLINK_CAST_HOST overrides this."
              onSubmit={setCastHost}
              onCancel={() => setEditingCastHost(false)}
            />
          </Box>
        ) : null}

        {pendingDownload ? (
          <Box marginTop={1}>
            <FolderPrompt
              title="download to"
              width={Math.max(24, Math.min(cols - 4, 62))}
              subject={
                pendingDownload.sizeBytes
                  ? `${cleanText(pendingDownload.name)}  ${ICON.dot}  ${formatBytes(pendingDownload.sizeBytes)}`
                  : cleanText(pendingDownload.name)
              }
              submitLabel="download"
              value={lastDownloadToDir ?? store.config.downloadDir}
              onSubmit={startDownloadTo}
              onCancel={closeDownloadToPrompt}
            />
          </Box>
        ) : null}

        <Box
          height={bodyH}
          marginTop={compact ? 0 : 1}
          display={
            showHelp || editingFolder || editingToken || editingRecc || claimingRecc || editingOmdb || editingPlayer || editingSources || editingQuality || editingDns || editingRutracker || editingTrackers || editingLimits || editingVpn || editingCastDevice || editingCastHost || pendingP2P || pendingDownload || fileSelection || streamFiles || preparing || torrentPrompt || keepPrompt || importingNetflix || importChooser || importingTrakt
              ? "none"
              : "flex"
          }
          overflow="hidden"
        >
          <Sidebar />
          <Box flexGrow={1} flexDirection="column">
            <Box
              flexGrow={1}
              flexDirection="column"
              display={isCategory(section) ? "flex" : "none"}
            >
              <Results reccConfig={resolveReccConfig(store.config)} />
            </Box>
            <Box
              flexGrow={1}
              flexDirection="column"
              display={section === "downloads" ? "flex" : "none"}
            >
              <Downloads />
            </Box>
            <Box
              flexGrow={1}
              flexDirection="column"
              display={section === "seeding" ? "flex" : "none"}
            >
              <Seeding />
            </Box>
            <Box display={section === "settings" ? "flex" : "none"} flexDirection="column">
              <Settings
                debrid={DEBRID_PROVIDER_IDS.map((provider) => ({
                  provider,
                  token: resolveDebridTokenFor(store.config, provider),
                  status: debridStatus?.provider === provider ? debridStatus : null,
                  onManage: () => openTokenPrompt(provider),
                  onSignOut: () => clearDebridToken(provider),
                }))}
                activeDebrid={store.debridProvider}
                onSetActiveDebrid={setActiveDebrid}
                rutrackerUser={rutrackerUser}
                streamActive={store.streamActive}
                onManageRutracker={openRutrackerPrompt}
                onSignOutRutracker={signOutRutracker}
                reccConfigured={store.reccConfigured}
                reccStatus={reccStatus}
                reccEnvOverride={Boolean(
                  process.env["TORLINK_RECC_URL"]?.trim() || process.env["TORLINK_RECC_TOKEN"]?.trim(),
                )}
                onManageRecc={openReccPrompt}
                onSignOutRecc={clearReccConfig}
                onImportRecc={openImportChooser}
                onClaimRecc={openClaimPrompt}
                omdbConfigured={store.omdbConfigured}
                omdbEnvOverride={Boolean(process.env["TORLINK_OMDB_KEY"]?.trim())}
                onManageOmdb={openOmdbPrompt}
                onSignOutOmdb={clearOmdbKey}
                cfAccessEnforced={cloudflareAccessRef.current !== null}
                onEditFolder={() => setEditingFolder(true)}
                onEditSources={() => setEditingSources(true)}
                onEditQuality={() => setEditingQuality(true)}
                onEditDns={openDnsPrompt}
                onEditTrackers={() => setEditingTrackers(true)}
                onEditLimits={() => setEditingLimits(true)}
                onEditVpn={() => setEditingVpn(true)}
                onEditPlayer={() => setEditingPlayer(true)}
                onEditCastDevice={() => setEditingCastDevice(true)}
                onEditCastHost={() => setEditingCastHost(true)}
                onToggleAdult={toggleAdult}
                onToggleProxy={toggleProxy}
                onToggleAdultScreenshots={toggleAdultScreenshots}
                dnsEnvOverride={process.env["TORLINK_DNS"] !== undefined}
                playerEnvOverride={Boolean(process.env["TORLINK_PLAYER"]?.trim())}
                adultEnvOverride={process.env["TORLINK_ADULT"] !== undefined}
                castDeviceEnvOverride={Boolean(process.env["TORLINK_CAST_DEVICE"]?.trim())}
                castHostEnvOverride={Boolean(process.env["TORLINK_CAST_HOST"]?.trim())}
              />
            </Box>
            <Box display={section === "continueWatching" ? "flex" : "none"} flexDirection="column">
              <ContinueWatching />
            </Box>
            <Box display={section === "savedSearches" ? "flex" : "none"} flexDirection="column">
              <SavedSearches />
            </Box>
            <Box display={section === "library" ? "flex" : "none"} flexDirection="column">
              <Favourites />
            </Box>
            <Box display={section === "forYou" ? "flex" : "none"} flexDirection="column">
              <ForYou
                reccConfig={resolveReccConfig(store.config)}
                omdbApiKey={resolveOmdbApiKey(store.config)}
                width={contentWidth}
                height={bodyH}
                visible={section === "forYou"}
                active={store.region === "content" && section === "forYou"}
                setSection={store.setSection}
                submitQuery={store.submitQuery}
                setCaptureMode={store.setCaptureMode}
                onRatePick={openRatePick}
                toggleSavedSearch={store.toggleSavedSearch}
                autoPlayTitle={store.autoPlayTitle}
              />
            </Box>
          </Box>
        </Box>

        {showFooter ? (
          <Box
            display={
              showHelp || editingFolder || editingToken || editingRecc || claimingRecc || editingOmdb || editingPlayer || editingSources || editingQuality || editingDns || editingRutracker || editingTrackers || editingLimits || editingVpn || editingCastDevice || editingCastHost || pendingP2P || pendingDownload || streamFiles || preparing || torrentPrompt || keepPrompt || importingNetflix || importChooser || importingTrakt
                ? "none"
                : "flex"
            }
          >
            <Footer
              hints={footerHints(
                region,
                section,
                downloadFocus,
                seedFocus,
                activeDebridLabel,
                store.streamActive,
                resultFocus,
              )}
            />
          </Box>
        ) : null}
      </Box>
    </StoreContext.Provider>
  );
}
