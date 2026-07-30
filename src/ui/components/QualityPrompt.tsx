import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { Panel } from "./Panel";
import { wrapStep } from "../move";
import { COLOR, ICON } from "../theme";
import { FEATURE_IDS, FEATURES, MAX_RESOLUTIONS, type FeatureId, type MaxResolution } from "../../util/releasePick";

/** none -> highest -> … -> lowest -> none. `undefined` is "no ceiling". */
export function cycleResolution(current: MaxResolution | undefined): MaxResolution | undefined {
  if (current === undefined) return MAX_RESOLUTIONS[0];
  const i = MAX_RESOLUTIONS.indexOf(current);
  return i === MAX_RESOLUTIONS.length - 1 ? undefined : MAX_RESOLUTIONS[i + 1];
}

// Off -> require -> exclude -> off. One three-state cell per feature rather
// than two parallel lists, so a feature cannot be required and excluded at once.
type FeatureState = "off" | "require" | "exclude";
const NEXT_STATE: Record<FeatureState, FeatureState> = { off: "require", require: "exclude", exclude: "off" };
const MARK: Record<FeatureState, string> = { off: "·", require: "✓", exclude: "✗" };

export interface QualityPromptProps {
  width: number;
  maxResolution?: MaxResolution;
  require: readonly FeatureId[];
  exclude: readonly FeatureId[];
  onChange: (next: { maxResolution?: MaxResolution; require: FeatureId[]; exclude: FeatureId[] }) => void;
  onCancel: () => void;
}

export function QualityPrompt({ width, maxResolution, require, exclude, onChange, onCancel }: QualityPromptProps) {
  const [cursor, setCursor] = useState(0);
  const rows = 1 + FEATURE_IDS.length;
  const clamped = Math.min(cursor, rows - 1);

  const stateOf = (id: FeatureId): FeatureState =>
    exclude.includes(id) ? "exclude" : require.includes(id) ? "require" : "off";

  useInput((input, key) => {
    if (key.escape) { onCancel(); return; }
    if (key.upArrow) setCursor(wrapStep(clamped, -1, rows));
    else if (key.downArrow) setCursor(wrapStep(clamped, 1, rows));
    else if (input === " " || key.return) {
      if (clamped === 0) {
        onChange({ maxResolution: cycleResolution(maxResolution), require: [...require], exclude: [...exclude] });
        return;
      }
      const id = FEATURE_IDS[clamped - 1]!;
      const next = NEXT_STATE[stateOf(id)];
      onChange({
        maxResolution,
        require: next === "require" ? [...require, id] : require.filter((x) => x !== id),
        exclude: next === "exclude" ? [...exclude, id] : exclude.filter((x) => x !== id),
      });
    }
  });

  return (
    <Box flexDirection="column" width={width}>
      <Panel title="playback quality" width={width} focused>
        <Box>
          <Text color={clamped === 0 ? COLOR.accent : undefined}>{clamped === 0 ? `${ICON.pointer} ` : "  "}</Text>
          <Text>max resolution </Text>
          <Text color={COLOR.accent}>{maxResolution ?? "no limit"}</Text>
        </Box>
        {FEATURE_IDS.map((id, i) => {
          const selected = clamped === i + 1;
          const state = stateOf(id);
          return (
            <Box key={id}>
              <Text color={selected ? COLOR.accent : undefined}>{selected ? `${ICON.pointer} ` : "  "}</Text>
              <Text color={state === "require" ? COLOR.good : state === "exclude" ? COLOR.bad : undefined}>
                {MARK[state]}
              </Text>
              <Text dimColor={state === "off"}>{` ${FEATURES[id].label}`}</Text>
            </Box>
          );
        })}
      </Panel>
      <Text dimColor>
        With nothing set, the best resolution available wins — then the largest file.
      </Text>
      <Box marginTop={1}>
        <Text color={COLOR.alt}>↑↓</Text><Text dimColor> move</Text>
        <Text dimColor>{`     ${ICON.dot}     `}</Text>
        <Text color={COLOR.alt}>space</Text><Text dimColor> off / require / exclude</Text>
        <Text dimColor>{`     ${ICON.dot}     `}</Text>
        <Text color={COLOR.alt}>esc</Text><Text dimColor> done</Text>
      </Box>
    </Box>
  );
}
