import { Box, Text, useInput, useStdin } from "ink";
import { Logo } from "../components/Logo";
import { UpdateBanner } from "../components/UpdateBanner";
import { SearchBar } from "../components/SearchBar";
import { LOGO_WIDTH } from "../logo";
import { useStore } from "../store";
import { sourcesByGroup } from "../../sources/registry";
import { withoutToken } from "../../web/links";
import { getDebridProvider } from "../../integrations/debrid";
import { COLOR, ICON } from "../theme";

const categoryLine = (adultEnabled: boolean): string =>
  sourcesByGroup(adultEnabled)
    .map((g) => g.group.toLowerCase())
    .join(`  ${ICON.dot}  `);

/**
 * The in-process web server's state, for the status line below. `null` means
 * `--web` was never passed (say nothing at all); a url means it is really
 * listening on that url; `failed` means the bind failed and the reason is in the
 * notice and the log.
 */
export type SplashWebStatus = { url: string } | { failed: true };

export function Splash({
  updateVersion,
  recovered,
  webStatus,
}: {
  updateVersion?: string | null;
  recovered?: boolean;
  webStatus?: SplashWebStatus | null;
} = {}) {
  const {
    submitQuery,
    searchHistory,
    quitAll,
    cols,
    rows,
    debridConfigured,
    debridProvider,
    debridStatus,
    setView,
    setRegion,
    adultEnabled,
  } = useStore();
  const { isRawModeSupported } = useStdin();
  const categories = categoryLine(adultEnabled);
  // Only rendered when debridConfigured, which implies debridProvider is set —
  // the fallback never actually reaches the screen, but stays neutral anyway.
  const debridLabel = debridProvider ? getDebridProvider(debridProvider).label : "a debrid service";

  useInput(
    (input, key) => {
      // The search field is always focused on the splash, so it owns every
      // printable keystroke — no single-key shortcuts here, or typing a query
      // like "alex" would trigger them. Tab drops into the app's sidebar menu
      // (where the shortcuts live); esc / ^c quit.
      if (key.tab) {
        setView("browser");
        setRegion("sidebar");
        return;
      }
      if (key.escape || (key.ctrl && input === "c")) quitAll();
    },
    { isActive: isRawModeSupported },
  );

  const showLogo = cols >= LOGO_WIDTH + 2;
  const barWidth = Math.max(24, Math.min(cols - 6, 62));

  return (
    <Box
      height={Math.max(1, rows - 1)}
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
    >
      <UpdateBanner latest={updateVersion ?? null} />
      {recovered ? (
        <Text dimColor>{`↻ recovered from a crashed start · downloads paused`}</Text>
      ) : null}
      {showLogo ? (
        <Logo />
      ) : (
        <Text bold color={COLOR.accent}>
          torlink
        </Text>
      )}
      <Box marginTop={2}>
        <Text color={COLOR.text}>A curated, terminal-native torrent downloader.</Text>
      </Box>
      <Box>
        <Text dimColor>{categories}</Text>
      </Box>
      <Box marginTop={1}>
        {debridConfigured ? (
          <Text dimColor>
            {`${debridLabel}: connected${debridStatus?.username ? ` as ${debridStatus.username}` : ""}`}
          </Text>
        ) : (
          <Text dimColor>Tip — open the Accounts tab to connect Real-Debrid or TorBox for instant, private streaming.</Text>
        )}
      </Box>

      {/* The browser UI's address, for as long as the splash is up: the notice
          that also carries it expires after four seconds, which left `torlnk
          --web`'s headline feature discoverable only from the log file. A status
          line in the same dim treatment as the tip above it, never a banner —
          and never a url unless the server really bound one. */}
      {webStatus ? (
        <Box>
          <Text dimColor>
            {"url" in webStatus
              ? `web ui · ${withoutToken(webStatus.url)}`
              : "web ui · failed to start (see the log)"}
          </Text>
        </Box>
      ) : null}

      <Box marginTop={1} width={barWidth}>
        <SearchBar
          width={barWidth}
          value=""
          editing
          placeholder="Search or paste a magnet link…"
          history={searchHistory}
          onSubmit={submitQuery}
          onExitDown={() => submitQuery("")}
        />
      </Box>
      <Box marginTop={1}>
        <Text>
          <Text color={COLOR.alt}>↵</Text>
          <Text dimColor> search</Text>
          <Text dimColor>{`  ${ICON.dot}  `}</Text>
          <Text color={COLOR.alt}>⇥</Text>
          <Text dimColor> browse</Text>
          <Text dimColor>{`  ${ICON.dot}  `}</Text>
          <Text color={COLOR.alt}>^c</Text>
          <Text dimColor> quit</Text>
        </Text>
      </Box>
    </Box>
  );
}
