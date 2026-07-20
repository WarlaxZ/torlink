import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout, useStdin } from "ink";
import { promises as fs } from "node:fs";
import {
  loadConfig,
  saveConfig,
  resolveRealDebridToken,
  resolveMediaPlayer,
  resolveDnsServers,
  type Config,
  type FavouriteItem,
} from "../config/config";
import { setDnsServers } from "../util/dns";
import { normalizeDownloadDir } from "../config/folder";
import { validateToken, isPremiumActive, resolveMagnet, isTokenRejection } from "../integrations/realdebrid";
import { rdStatusFromUser, type RdStatus } from "../integrations/rdStatus";
import { detectPlayer, launchPlayer, streamCandidates } from "../util/player";
import type { ResolvedFile } from "../integrations/realdebrid";
import { streamTorrent, type TorrentStreamSession } from "../integrations/torrentStream";
import { classifyStreamRoute } from "./streamRoute";
import { keepMovePlan, moveKeptFiles } from "./streamKeep";
import { DownloadQueue } from "../download/queue";
import { loadQueue, loadSeeds } from "../download/persist";
import { loadHistory } from "../download/history";
import { reconcileQueue } from "../download/reconcile";
import { parseInput } from "../sources/magnet";
import { magnetFromTorrentFile } from "../sources/torrentFile";
import { readClipboard, writeClipboard } from "../util/clipboard";
import { openFolder } from "../util/openFolder";
import { cleanText, formatBytes, truncate } from "../util/format";
import { isCategory, parseCategory } from "./store";
import {
  StoreContext,
  type CaptureMode,
  type DownloadFocus,
  type Region,
  type Section,
  type SeedFocus,
  type Store,
  type View,
} from "./store";
import { formatSort, parseSort, type Sort } from "./sort";
import { addToHistory } from "./searchHistory";
import { toggleSavedSearches } from "./savedSearches";
import {
  toggleFavourite as toggleFavouriteList,
  removeFavourite as removeFavouriteFromList,
  isFavourited as isFavouritedIn,
  watchedFor,
  markWatched,
} from "./favourites";
import { toggleDisabledSource } from "../sources/registry";
import { Logo } from "./components/Logo";
import { RdBadge } from "./components/RdBadge";
import { Sidebar, RAIL_WIDTH } from "./components/Sidebar";
import { Rule } from "./components/Rule";
import { Footer } from "./components/Footer";
import { HelpOverlay } from "./components/HelpOverlay";
import { Results } from "./components/Results";
import { Downloads } from "./components/Downloads";
import { Seeding } from "./components/Seeding";
import { Spinner } from "./components/Spinner";
import { TabTitle } from "./components/TabTitle";
import { Splash } from "./views/Splash";
import { FolderPrompt } from "./components/FolderPrompt";
import { TokenPrompt } from "./components/TokenPrompt";
import { ConfirmPrompt } from "./components/ConfirmPrompt";
import { StreamPlayerPrompt } from "./components/StreamPlayerPrompt";
import { StreamFilePrompt } from "./components/StreamFilePrompt";
import { SourcesPrompt } from "./components/SourcesPrompt";
import { DnsPrompt } from "./components/DnsPrompt";
import { RutrackerPrompt, type LoginStatus } from "./components/RutrackerPrompt";
import { Accounts } from "./components/Accounts";
import { Watchlist } from "./components/Watchlist";
import { Favourites } from "./components/Favourites";
import { TrackersPrompt } from "./components/TrackersPrompt";
import { DownloadFilePrompt } from "./components/DownloadFilePrompt";
import { LimitsPrompt, type TransferLimits } from "./components/LimitsPrompt";
import { VpnPrompt } from "./components/VpnPrompt";
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

export interface DownloadInput {
  id: string;
  name: string;
  magnet: string;
  source?: SourceId;
  sizeBytes?: number;
}

export function App({
  initialMagnet,
  initialTorrent,
  onQuit,
}: { initialMagnet?: string; initialTorrent?: string; onQuit?: () => void } = {}) {
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
  const [view, setView] = useState<View>("splash");
  const [query, setQuery] = useState("");
  const [section, setSection] = useState<Section>("all");
  const [sort, setSortState] = useState<Sort>("none");
  const [region, setRegion] = useState<Region>("content");
  const [captureMode, setCaptureMode] = useState<CaptureMode>("none");
  const [downloadFocus, setDownloadFocus] = useState<DownloadFocus | null>(null);
  const [seedFocus, setSeedFocus] = useState<SeedFocus | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [editingFolder, setEditingFolder] = useState(false);
  const [editingToken, setEditingToken] = useState(false);
  const [editingPlayer, setEditingPlayer] = useState(false);
  const [editingSources, setEditingSources] = useState(false);
  const [editingDns, setEditingDns] = useState(false);
  const [editingRutracker, setEditingRutracker] = useState(false);
  const [rutrackerStatus, setRutrackerStatus] = useState<LoginStatus>({ kind: "idle" });
  const [rutrackerCaptcha, setRutrackerCaptcha] = useState<Captcha | undefined>(undefined);
  const [rutrackerUser, setRutrackerUser] = useState<string | undefined>(undefined);
  const [editingTrackers, setEditingTrackers] = useState(false);
  const [editingLimits, setEditingLimits] = useState(false);
  const [editingVpn, setEditingVpn] = useState(false);
  const [pendingP2P, setPendingP2P] = useState<DownloadInput | null>(null);
  const [fileSelection, setFileSelection] = useState<QueueItem | null>(null);
  const [pendingStreamUrl, setPendingStreamUrl] = useState<string | null>(null);
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
  const [rdStatus, setRdStatus] = useState<RdStatus | null>(null);
  const [streamFiles, setStreamFiles] = useState<ResolvedFile[] | null>(null);
  // Episodes streamed from the current picker session (marked ✓, cleared when
  // the picker opens/closes). Union with the favourite's persisted watched list.
  const [streamedFiles, setStreamedFiles] = useState<Set<string>>(new Set());
  // The torrent behind the open picker, so we can favourite it / persist watched
  // progress. Cleared only when the picker closes (survives keep-open replays).
  const [streamSource, setStreamSource] = useState<DownloadInput | null>(null);
  const [preparing, setPreparing] = useState<{
    label: string;
    phase: "caching" | "fetching";
    pct: number;
    source: "rd" | "torrent";
  } | null>(null);
  const [activeStream, setActiveStream] = useState<
    { session: TorrentStreamSession; name: string; input: DownloadInput } | null
  >(null);
  // Confirm state for the two torrent privacy prompts.
  const [torrentPrompt, setTorrentPrompt] = useState<
    { input: DownloadInput; reason?: string } | null
  >(null);
  // Offer to keep a fully-downloaded torrent stream as a real download + seed.
  const [keepPrompt, setKeepPrompt] = useState<
    { session: TorrentStreamSession; input: DownloadInput } | null
  >(null);
  const vpnUnsafe = useRef(false);
  const prepareAbort = useRef<AbortController | null>(null);
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
      q.restore(reconcileQueue(await loadQueue()));
      q.restoreHistory(await loadHistory());
      q.restoreSeeds(await loadSeeds());
      if (!alive) {
        q.suspend();
        return;
      }
      setConfigState(cfg);
      // Apply any custom DNS before the first network call (e.g. token check).
      setDnsServers(resolveDnsServers(cfg));
      // Restore remembered UI preferences (validated, so stale values degrade
      // to defaults rather than throwing).
      setSortState(parseSort(cfg.sort));
      const launchToken = resolveRealDebridToken(cfg);
      if (launchToken) {
        void validateToken(launchToken)
          .then((u) => {
            if (alive) setRdStatus(rdStatusFromUser(u, new Date()));
          })
          .catch(() => {
            /* offline or bad token at launch: leave the badge hidden, no toast */
          });
      }
      setQueue(q);
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
        setSection(parseCategory(cfg.category));
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

  // If a Real-Debrid download fails because the token was rejected, clear the
  // stale status and re-open the token prompt — once per failure, not on every
  // queue tick.
  const reauthSeen = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!queue) return;
    const onUpdate = (): void => {
      const selecting = queue.getItems().find((it) => it.status === "selecting");
      setFileSelection(selecting ? { ...selecting } : null);
      for (const it of queue.getItems()) {
        if (it.status !== "failed" || it.via !== "realdebrid" || !it.error) continue;
        if (reauthSeen.current.has(it.id)) continue;
        if (isTokenRejection(it.error)) {
          reauthSeen.current.add(it.id);
          setRdStatus(null);
          setNotice("Real-Debrid token expired — re-enter it.");
          setShowHelp(false);
          setEditingToken(true);
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

  // Keep the queue's Real-Debrid token in step with config (and the env var), so
  // a retry can re-run the pipeline without the UI handing it back in.
  useEffect(() => {
    if (queue && config) queue.setRealDebridToken(resolveRealDebridToken(config));
  }, [queue, config]);

  const quitAll = useCallback(() => {
    // Flush all state synchronously up front so nothing is lost to the hard
    // exit; the unmount effect still runs suspend() for the engine teardown.
    queue?.persistSync();
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

  // Change the section; remember the last *category* so torlink reopens on it
  // (downloads/seeding are transient and never persisted).
  const changeSection = useCallback(
    (s: Section) => {
      setSection(s);
      if (isCategory(s)) persistConfig({ category: s });
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
    setNotice("Watchlist updated.");
  }, []);

  const toggleFavourite = useCallback((item: FavouriteItem) => {
    setConfigState((prev) => {
      if (!prev) return prev;
      const favourites = toggleFavouriteList(prev.favourites ?? [], item);
      const next = { ...prev, favourites };
      void saveConfig(next);
      return next;
    });
    setNotice("Favourites updated.");
  }, []);

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
    setEditingToken(false);
  }, []);

  const openTokenPrompt = useCallback(() => {
    setView("browser");
    setShowHelp(false);
    setEditingToken(true);
  }, []);

  const setRealDebridToken = useCallback(
    (raw: string) => {
      closeTokenPrompt();
      if (!config) return;
      const token = raw.trim();
      if (!token) {
        setNotice("Real-Debrid token unchanged.");
        return;
      }
      setConfig({ ...config, realDebridToken: token });
      void (async () => {
        try {
          const user = await validateToken(token);
          setRdStatus(rdStatusFromUser(user, new Date()));
          if (!isPremiumActive(user)) {
            setNotice(`Real-Debrid: ${user.username}'s account isn't premium — torrents need premium.`);
            return;
          }
          setNotice(`${ICON.done} Real-Debrid connected as ${user.username}`);
        } catch (e) {
          setRdStatus(null);
          setNotice(`Real-Debrid: ${e instanceof Error ? e.message : "could not validate token"}`);
        }
      })();
    },
    [config, setConfig, closeTokenPrompt],
  );

  const clearRealDebridToken = useCallback(() => {
    closeTokenPrompt();
    if (!config) return;
    if (process.env["REALDEBRID_API_TOKEN"]?.trim()) {
      setNotice("Token is set via REALDEBRID_API_TOKEN — unset the env var to clear it.");
      return;
    }
    setConfig({ ...config, realDebridToken: undefined });
    setRdStatus(null);
    setNotice("Real-Debrid token cleared.");
  }, [config, setConfig, closeTokenPrompt]);

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
      const token = resolveRealDebridToken(config);
      if (!token) {
        setNotice("Set a Real-Debrid token first — open the Accounts tab.");
        return;
      }
      void fs.mkdir(config.downloadDir, { recursive: true }).catch(() => {});
      void queue.addDebrid(input, config.downloadDir, token);
      setNotice(`Real-Debrid: ${truncate(cleanText(input.name), 40)}`);
    },
    [config, queue],
  );

  // Try to play a resolved stream URL: use the configured/detected player, else
  // copy the link to the clipboard and prompt for a player command.
  const playStream = useCallback(
    async (url: string, name?: string) => {
      if (!config) return;
      let player = resolveMediaPlayer(config);
      if (!player) player = (await detectPlayer()) ?? "";
      if (player && (await launchPlayer(player, url))) {
        const copied = await writeClipboard(url);
        setNotice(
          `${ICON.done} Streaming ${name ? `${truncate(cleanText(name), 28)} ` : ""}in ${player}${copied ? " · link copied" : ""}`,
        );
        return;
      }
      // No player available (or it failed to launch): stash the URL, put it on
      // the clipboard, and ask the user for a command to use.
      setPendingStreamUrl(url);
      await writeClipboard(url);
      setEditingPlayer(true);
    },
    [config],
  );

  // Hand a resolved file to the player path and clear any picker/preparing UI.
  const finishStream = useCallback(
    (file: ResolvedFile, name?: string) => {
      setStreamFiles(null);
      setPreparing(null);
      void playStream(file.url, name ?? file.filename);
    },
    [playStream],
  );

  // Play a picked episode but KEEP the picker open (unlike finishStream) so the
  // user can go straight to the next episode. Marks it streamed this session and
  // persists watched progress when the current torrent is favourited.
  const playFromPicker = useCallback(
    (file: ResolvedFile) => {
      void playStream(file.url, file.filename);
      setStreamedFiles((prev) => new Set(prev).add(file.filename));
      if (streamSource && isFavouritedIn(config?.favourites ?? [], streamSource.id)) {
        markWatchedInFavourite(streamSource.id, file.filename);
      }
    },
    [playStream, streamSource, config, markWatchedInFavourite],
  );

  const cancelPreparing = useCallback(() => {
    prepareAbort.current?.abort();
    prepareAbort.current = null;
    setPreparing(null);
    setNotice("Stream cancelled.");
  }, []);

  // Stream a torrent directly (no Real-Debrid): cache metadata, spin up a
  // local HTTP server for the files, then hand off to the same player/picker
  // path the Real-Debrid flow uses.
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
          if (candidates.length > 1) {
            setStreamedFiles(new Set());
            setStreamSource(input);
            setStreamFiles(candidates);
          } else {
            void playStream(candidates[0]!.url, input.name);
          }
        } catch (e) {
          prepareAbort.current = null;
          setPreparing(null);
          if (controller.signal.aborted) return;
          setNotice(e instanceof Error ? e.message : "Couldn't start torrent stream.");
        }
      })();
    },
    [config, preparing, streamFiles, activeStream, playStream, ensureVpnSafe],
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
      const route = classifyStreamRoute(config, rdStatus);
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
      // route.kind === "realdebrid": fall through to the existing RD flow.
      const token = resolveRealDebridToken(config);
      if (!token) {
        setNotice("Set a Real-Debrid token first — open the Accounts tab.");
        return;
      }
      const label = truncate(cleanText(input.name), 32);
      const controller = new AbortController();
      prepareAbort.current = controller;
      setPreparing({ label, phase: "caching", pct: 0, source: "rd" });
      void (async () => {
        try {
          const files = await resolveMagnet(token, input.magnet, {
            knownHash: input.id,
            signal: controller.signal,
            // 0<pct<100 means RD is still caching server-side; otherwise we're
            // about to fetch the direct link.
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
            setNotice("Real-Debrid returned nothing to stream.");
            return;
          }
          if (candidates.length > 1) {
            setPreparing(null);
            setStreamedFiles(new Set());
            setStreamSource(input);
            setStreamFiles(candidates);
            return;
          }
          finishStream(candidates[0]!, input.name);
        } catch (e) {
          prepareAbort.current = null;
          setPreparing(null);
          // A user-initiated cancel already surfaced its own notice; don't
          // clobber it with the cancellation error this throws.
          if (controller.signal.aborted) return;
          if (isTokenRejection(e)) {
            setRdStatus(null);
            setNotice("Real-Debrid token expired — re-enter it.");
            setShowHelp(false);
            setEditingToken(true);
            return;
          }
          setTorrentPrompt({
            input,
            reason: `Real-Debrid couldn't prepare this stream (${e instanceof Error ? e.message : "unknown error"})`,
          });
        }
      })();
    },
    [config, finishStream, preparing, streamFiles, activeStream, rdStatus, startTorrentStream],
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

  const closePlayerPrompt = useCallback(() => {
    setEditingPlayer(false);
    setPendingStreamUrl(null);
    setNotice("Stream link is on your clipboard.");
  }, []);

  const setMediaPlayer = useCallback(
    (raw: string) => {
      setEditingPlayer(false);
      if (!config) return;
      const cmd = raw.trim();
      const url = pendingStreamUrl;
      setPendingStreamUrl(null);
      if (!cmd) {
        setNotice("Stream link is on your clipboard.");
        return;
      }
      setConfig({ ...config, mediaPlayer: cmd });
      void (async () => {
        if (!url) {
          setNotice(`Media player set: ${cmd}`);
          return;
        }
        const ok = await launchPlayer(cmd, url);
        setNotice(ok ? `${ICON.done} Streaming in ${cmd}` : `Couldn't launch ${cmd}. Link is on your clipboard.`);
      })();
    },
    [config, setConfig, pendingStreamUrl],
  );

  const openDnsPrompt = useCallback(() => {
    setShowHelp(false);
    setEditingDns(true);
  }, []);

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

  // The plain (P2P) download button: when Real-Debrid is configured, route
  // through a warning first since P2P exposes the user's IP to the swarm.
  const requestP2PDownload = useCallback(
    (input: DownloadInput) => {
      if (config && resolveRealDebridToken(config)) {
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
      section,
      setSection: changeSection,
      sort,
      setSort,
      disabledSources: (config.disabledSources ?? []) as SourceId[],
      toggleSource,
      region:
        showHelp || editingFolder || editingToken || editingPlayer || editingSources || editingDns || editingRutracker || editingTrackers || editingLimits || editingVpn || pendingP2P || pendingDownload || fileSelection || streamFiles || preparing || torrentPrompt || keepPrompt
          ? "help"
          : region,
      setRegion,
      captureMode,
      setCaptureMode,
      downloadFocus,
      setDownloadFocus,
      seedFocus,
      setSeedFocus,
      startDownload,
      requestP2PDownload,
      requestDownloadTo,
      startDebridDownload,
      streamResult,
      debridConfigured: resolveRealDebridToken(config) !== "",
      streamActive: activeStream !== null,
      rdStatus,
      copyLink,
      copyMagnet,
      openDownloadFolder,
      exportTorrent,
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
    section,
    changeSection,
    sort,
    setSort,
    region,
    showHelp,
    editingFolder,
    editingToken,
    editingPlayer,
    editingSources,
    editingDns,
    editingRutracker,
    editingTrackers,
    editingLimits,
    editingVpn,
    toggleSource,
    pendingP2P,
    pendingDownload,
    fileSelection,
    streamFiles,
    preparing,
    torrentPrompt,
    keepPrompt,
    activeStream,
    captureMode,
    downloadFocus,
    seedFocus,
    startDownload,
    requestP2PDownload,
    requestDownloadTo,
    startDebridDownload,
    streamResult,
    rdStatus,
    copyLink,
    copyMagnet,
    openDownloadFolder,
    exportTorrent,
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
      if (editingPlayer) return; // the media-player prompt owns input
      if (editingSources) return; // the sources panel owns input
      if (editingDns) return; // the DNS prompt owns input
      if (editingRutracker) return; // the RuTracker prompt owns input
      if (editingTrackers) return; // the trackers prompt owns input
      if (editingLimits) return; // the limits prompt owns input
      if (editingVpn) return; // the VPN prompt owns input
      if (pendingP2P) return; // the P2P warning owns input
      if (pendingDownload) return; // the download-to prompt owns input
      if (fileSelection) return; // the download file picker owns input
      if (torrentPrompt) return; // the torrent privacy warning owns input
      if (keepPrompt) return; // the keep-download prompt owns input
      if (streamFiles) return; // the file picker owns input
      if (preparing) {
        if (key.escape) cancelPreparing();
        return; // swallow other keys while preparing
      }
      if (activeStream && (input === "x" || input === "X")) {
        stopStream();
        return;
      }
      if (captureMode === "text") return;
      if (showHelp) {
        setShowHelp(false);
        return;
      }
      if (input === "?") {
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
      if (input === "D") {
        openDnsPrompt();
        return;
      }
      if (input === "t") {
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
        <Splash updateVersion={updateVersion} />
      </StoreContext.Provider>
    );
  }

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
            <RdBadge status={rdStatus} />
            {notice ? (
              <Text color={COLOR.good} wrap="truncate-end">{`  ${notice}`}</Text>
            ) : null}
          </Box>
        </Box>
        {preparing ? (
          <Box>
            <Spinner
              label={
                preparing.source === "torrent"
                  ? `Finding peers… ${preparing.label} · ${prepElapsed}s  (esc cancels)`
                  : preparing.phase === "caching"
                    ? `Caching on Real-Debrid… ${preparing.pct}% · ${prepElapsed}s  (esc cancels)`
                    : `Fetching link… ${prepElapsed}s  (esc cancels)`
              }
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
            <HelpOverlay />
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
              value={store.config.realDebridToken ?? ""}
              status={rdStatus}
              onSubmit={setRealDebridToken}
              onClear={clearRealDebridToken}
              onCancel={closeTokenPrompt}
            />
          </Box>
        ) : null}

        {editingPlayer ? (
          <Box marginTop={1}>
            <StreamPlayerPrompt
              width={Math.max(24, Math.min(cols - 4, 62))}
              value={resolveMediaPlayer(store.config)}
              onSubmit={setMediaPlayer}
              onCancel={closePlayerPrompt}
            />
          </Box>
        ) : null}

        {editingSources ? (
          <Box marginTop={1}>
            <SourcesPrompt
              width={Math.max(24, Math.min(cols - 4, 62))}
              disabled={(store.config.disabledSources ?? []) as SourceId[]}
              onToggle={toggleSource}
              onCancel={() => setEditingSources(false)}
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

        {streamFiles ? (
          <Box marginTop={1}>
            <StreamFilePrompt
              width={Math.max(24, Math.min(cols - 4, 72))}
              maxRows={Math.max(3, bodyH - 4)}
              files={streamFiles}
              watched={
                streamSource
                  ? [...watchedFor(config?.favourites ?? [], streamSource.id), ...streamedFiles]
                  : [...streamedFiles]
              }
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
              onCancel={() => {
                setStreamFiles(null);
                setStreamedFiles(new Set());
                setStreamSource(null);
                // The Real-Debrid path has no activeStream (files are hosted
                // by RD, not a local torrent session), so this only fires for
                // the torrent-stream path — leave that path unaffected.
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
              message="This download uses peer-to-peer, so your IP is visible to the swarm. Real-Debrid keeps it private. Continue with P2P?"
              altKey="r"
              altLabel="use Real-Debrid"
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
              title={torrentPrompt.reason ? "Real-Debrid unavailable" : "Stream via torrent?"}
              message={
                torrentPrompt.reason
                  ? `${torrentPrompt.reason}. Streaming via torrent connects you directly to peers, so your IP is visible to the swarm. Continue via torrent?`
                  : "Streaming via torrent connects you directly to peers, so your IP is visible to the swarm (Real-Debrid keeps it private). Continue?"
              }
              onConfirm={() => {
                const { input, reason } = torrentPrompt;
                setTorrentPrompt(null);
                // Remember the acknowledgement only for the no-RD one-time warning.
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
            showHelp || editingFolder || editingToken || editingPlayer || editingSources || editingDns || editingRutracker || editingTrackers || editingLimits || editingVpn || pendingP2P || pendingDownload || fileSelection || streamFiles || preparing || torrentPrompt || keepPrompt
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
              <Results />
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
            <Box display={section === "accounts" ? "flex" : "none"} flexDirection="column">
              <Accounts
                rdToken={resolveRealDebridToken(store.config)}
                rdStatus={rdStatus}
                rutrackerUser={rutrackerUser}
                streamActive={store.streamActive}
                onManageRd={openTokenPrompt}
                onSignOutRd={clearRealDebridToken}
                onManageRutracker={openRutrackerPrompt}
                onSignOutRutracker={signOutRutracker}
              />
            </Box>
            <Box display={section === "watchlist" ? "flex" : "none"} flexDirection="column">
              <Watchlist />
            </Box>
            <Box display={section === "library" ? "flex" : "none"} flexDirection="column">
              <Favourites />
            </Box>
          </Box>
        </Box>

        {showFooter ? (
          <Box
            display={
              showHelp || editingFolder || editingToken || editingPlayer || editingSources || editingDns || editingRutracker || editingTrackers || editingLimits || editingVpn || pendingP2P || pendingDownload || streamFiles || preparing || torrentPrompt || keepPrompt
                ? "none"
                : "flex"
            }
          >
            <Footer
              hints={footerHints(region, section, downloadFocus, seedFocus, store.debridConfigured)}
            />
          </Box>
        ) : null}
      </Box>
    </StoreContext.Provider>
  );
}
