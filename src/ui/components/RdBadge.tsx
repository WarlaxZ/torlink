import { Text } from "ink";
import { COLOR, ICON } from "../theme";
import { daysUntil, expiringSoon } from "../../integrations/debrid/status";
import type { DebridStatus } from "../../integrations/debrid/types";

// Compact, always-on Real-Debrid indicator for the header. Renders nothing when
// no account is known so the header stays clean before a token is set.
export function RdBadge({ status }: { status: DebridStatus | null }) {
  if (!status) return null;
  const now = new Date();
  if (!status.active) {
    return <Text color={COLOR.warn}>{`${ICON.warn} rd free`}</Text>;
  }
  if (status.expiresAt && expiringSoon(status, now)) {
    return (
      <Text color={COLOR.warn}>{`${ICON.warn} rd ${status.username} · ${daysUntil(status.expiresAt, now)}d`}</Text>
    );
  }
  return <Text color={COLOR.good}>{`${ICON.done} rd ${status.username}`}</Text>;
}
