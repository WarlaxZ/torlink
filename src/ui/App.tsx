import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout, useStdin } from "ink";
import { promises as fs } from "node:fs";
import {
  loadConfig,
  saveConfig,
  resolveRealDebridToken,
  resolveMediaPlayer,
  type Config,
} from "../config/config";
import { normalizeDownloadDir } from "../config/folder";
import { validateToken, isPremiumActive, resolveMagnet, isTokenRejection } from "../integrations/realdebrid";
import { rdStatusFromUser, type RdStatus } from "../integrations/rdStatus";
import { detectPlayer, launchPlayer, streamCandidates } from "../util/player";
import type { ResolvedFile } from "../integrations/realdebrid";
import { DownloadQueue } from "../download/queue";
import { loadQueue, loadSeeds } from "../download/persist";
import { loadHistory } from "../download/history";
import { reconcileQueue } from "../download/reconcile";
import { parseMagnet } from "../sources/magnet";
import { magnetFromTorrentFile } from "../sources/torrentFile";
import { readClipboard, writeClipboard } from "../util/clipboard";
import { cleanText, truncate } from "../util/format";
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
import { footerHints } from "./keymap";
import { COLOR, ICON } from "./theme";
import { useMouseWheel } from "./hooks/useMouseWheel";
import type { SourceId } from "../sources/types";

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
  const [region, setRegion] = useState<Region>("content");
  const [captureMode, setCaptureMode] = useState<CaptureMode>("none");
  const [downloadFocus, setDownloadFocus] = useState<DownloadFocus | null>(null);
  const [seedFocus, setSeedFocus] = useState<SeedFocus | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [editingFolder, setEditingFolder] = useState(false);
  const [editingToken, setEditingToken] = useState(false);
  const [editingPlayer, setEditingPlayer] = useState(false);
  const [pendingP2P, setPendingP2P] = useState<DownloadInput | null>(null);
  const [pendingStreamUrl, setPendingStreamUrl] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rdStatus, setRdStatus] = useState<RdStatus | null>(null);
  const [streamFiles, setStreamFiles] = useState<ResolvedFile[] | null>(null);
  const [preparing, setPreparing] = useState<{ label: string; phase: "caching" | "fetching"; pct: number } | null>(null);
  const prepareAbort = useRef<AbortController | null>(null);
  const booting = useRef(false);

  useEffect(() => {
    if (booting.current) return;
    booting.current = true;
    let alive = true;
    void (async () => {
      const cfg = await loadConfig();
      const q = new DownloadQueue();
      q.restore(reconcileQueue(await loadQueue()));
      q.restoreHistory(await loadHistory());
      q.restoreSeeds(await loadSeeds());
      if (!alive) {
        q.suspend();
        return;
      }
      setConfigState(cfg);
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
        ? parseMagnet(initialMagnet)
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
      }
    })();
    return () => {
      alive = false;
    };
  }, [initialMagnet, initialTorrent]);

  useEffect(() => {
    if (!queue) return;
    const onCompleted = (name: string): void =>
      setNotice(`${ICON.done} ${truncate(cleanText(name), 40)}`);
    queue.on("completed", onCompleted);
    return () => {
      queue.off("completed", onCompleted);
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
    if (onQuit) onQuit();
    else exit();
  }, [queue, onQuit, exit]);

  const setConfig = useCallback((c: Config) => {
    setConfigState(c);
    void saveConfig(c);
  }, []);

  const closeFolderPrompt = useCallback(() => {
    setEditingFolder(false);
  }, []);

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

  const startDownload = useCallback(
    (input: DownloadInput) => {
      if (!config || !queue) return;
      void fs.mkdir(config.downloadDir, { recursive: true }).catch(() => {});
      queue.add(input, config.downloadDir);
      setNotice(`Added: ${truncate(cleanText(input.name), 40)}`);
      setSection("downloads");
      setRegion("content");
    },
    [config, queue],
  );

  const startDebridDownload = useCallback(
    (input: DownloadInput) => {
      if (!config || !queue) return;
      const token = resolveRealDebridToken(config);
      if (!token) {
        setNotice("Set a Real-Debrid token first (press k).");
        return;
      }
      void fs.mkdir(config.downloadDir, { recursive: true }).catch(() => {});
      void queue.addDebrid(input, config.downloadDir, token);
      setNotice(`Real-Debrid: ${truncate(cleanText(input.name), 40)}`);
      setSection("downloads");
      setRegion("content");
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
        setNotice(
          `${ICON.done} Streaming ${name ? `${truncate(cleanText(name), 28)} ` : ""}in ${player}`,
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

  const cancelPreparing = useCallback(() => {
    prepareAbort.current?.abort();
    prepareAbort.current = null;
    setPreparing(null);
    setNotice("Stream cancelled.");
  }, []);

  const streamResult = useCallback(
    (input: DownloadInput) => {
      if (!config) return;
      if (preparing || streamFiles) return; // one prepare/pick at a time
      const token = resolveRealDebridToken(config);
      if (!token) {
        setNotice("Set a Real-Debrid token first (press k).");
        return;
      }
      const label = truncate(cleanText(input.name), 32);
      const controller = new AbortController();
      prepareAbort.current = controller;
      setPreparing({ label, phase: "caching", pct: 0 });
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
          const candidates = streamCandidates(files).sort((a, b) => b.bytes - a.bytes);
          if (candidates.length === 0) {
            setPreparing(null);
            setNotice("Real-Debrid returned nothing to stream.");
            return;
          }
          if (candidates.length > 1) {
            setPreparing(null);
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
          setNotice(`Real-Debrid: ${e instanceof Error ? e.message : "couldn't prepare stream"}`);
        }
      })();
    },
    [config, finishStream, preparing, streamFiles],
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

  const submitQuery = useCallback(
    (raw: string) => {
      const q = raw.trim();
      if (q) {
        const magnet = parseMagnet(q);
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
    const magnet = found ? parseMagnet(found) : null;
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
      section,
      setSection,
      region:
        showHelp || editingFolder || editingToken || editingPlayer || pendingP2P || streamFiles
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
      startDebridDownload,
      streamResult,
      debridConfigured: resolveRealDebridToken(config) !== "",
      rdStatus,
      copyLink,
      copyMagnet,
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
    section,
    region,
    showHelp,
    editingFolder,
    editingToken,
    editingPlayer,
    pendingP2P,
    streamFiles,
    captureMode,
    downloadFocus,
    seedFocus,
    startDownload,
    requestP2PDownload,
    startDebridDownload,
    streamResult,
    rdStatus,
    copyLink,
    copyMagnet,
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
      if (pendingP2P) return; // the P2P warning owns input
      if (streamFiles) return; // the file picker owns input
      if (preparing) {
        if (key.escape) cancelPreparing();
        return; // swallow other keys while preparing
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
      if (input === "k") {
        setShowHelp(false);
        setEditingToken(true);
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
      if (key.rightArrow) {
        if (region === "sidebar") setRegion("content");
        return;
      }
      if (key.leftArrow) {
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
        <Splash />
      </StoreContext.Provider>
    );
  }

  return (
    <StoreContext.Provider value={store}>
      <TabTitle />
      <Box flexDirection="column" paddingX={1}>
        <Box justifyContent="space-between">
          <Logo />
          <Box>
            <RdBadge status={rdStatus} />
            {notice ? <Text color={COLOR.good}>{`  ${notice}`}</Text> : null}
          </Box>
        </Box>
        {preparing ? (
          <Box>
            <Spinner
              label={
                preparing.phase === "caching"
                  ? `Caching on Real-Debrid… ${preparing.pct}% · ${prepElapsed}s  (esc cancels)`
                  : `Fetching link… ${prepElapsed}s  (esc cancels)`
              }
            />
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
              onSubmit={setRealDebridToken}
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

        {streamFiles ? (
          <Box marginTop={1}>
            <StreamFilePrompt
              width={Math.max(24, Math.min(cols - 4, 72))}
              files={streamFiles}
              onSelect={(file) => finishStream(file)}
              onCancel={() => {
                setStreamFiles(null);
                setNotice("Stream cancelled.");
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

        <Box
          height={bodyH}
          marginTop={compact ? 0 : 1}
          display={
            showHelp || editingFolder || editingToken || editingPlayer || pendingP2P || streamFiles
              ? "none"
              : "flex"
          }
          overflow="hidden"
        >
          <Sidebar />
          <Box flexGrow={1} flexDirection="column">
            {section === "downloads" ? (
              <Downloads />
            ) : section === "seeding" ? (
              <Seeding />
            ) : (
              <Results />
            )}
          </Box>
        </Box>

        {showFooter ? (
          <Box
            display={
              showHelp || editingFolder || editingToken || editingPlayer || pendingP2P || streamFiles
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
