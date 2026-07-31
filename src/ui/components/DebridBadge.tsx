import { Text } from "ink";
import { COLOR, ICON } from "../theme";
import { daysUntil, expiringSoon } from "../../integrations/debrid/status";
import { getDebridProvider } from "../../integrations/debrid";
import type { DebridStatus } from "../../integrations/debrid/types";

// Compact, always-on debrid indicator for the header. Renders nothing when no
// account is known so the header stays clean before a token is set.
export function DebridBadge({ status }: { status: DebridStatus | null }) {
  if (!status) return null;
  const now = new Date();
  const tag = getDebridProvider(status.provider).shortLabel.toLowerCase();
  if (!status.active) {
    return <Text color={COLOR.warn}>{`${ICON.warn} ${tag} ${status.planLabel}`}</Text>;
  }
  if (status.expiresAt && expiringSoon(status, now)) {
    return (
      <Text color={COLOR.warn}>{`${ICON.warn} ${tag} ${status.username} · ${daysUntil(status.expiresAt, now)}d`}</Text>
    );
  }
  return <Text color={COLOR.good}>{`${ICON.done} ${tag} ${status.username}`}</Text>;
}
