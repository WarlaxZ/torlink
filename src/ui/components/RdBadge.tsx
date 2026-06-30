import { Text } from "ink";
import { COLOR, ICON } from "../theme";
import { daysUntil, premiumExpiringSoon, type RdStatus } from "../../integrations/rdStatus";

// Compact, always-on Real-Debrid indicator for the header. Renders nothing when
// no account is known so the header stays clean before a token is set.
export function RdBadge({ status }: { status: RdStatus | null }) {
  if (!status) return null;
  const now = new Date();
  if (!status.premium) {
    return <Text color={COLOR.warn}>{`${ICON.warn} rd free`}</Text>;
  }
  if (status.premiumUntil && premiumExpiringSoon(status, now)) {
    return (
      <Text color={COLOR.warn}>{`${ICON.warn} rd ${status.username} · ${daysUntil(status.premiumUntil, now)}d`}</Text>
    );
  }
  return <Text color={COLOR.good}>{`${ICON.done} rd ${status.username}`}</Text>;
}
