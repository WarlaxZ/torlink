import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { SearchBar } from "./SearchBar";
import type { TitleSuggestion } from "../../util/titleSuggest";

const KESTREL: TitleSuggestion = {
  imdbId: "tt0000001", title: "Kestrel", year: 2010, type: "movie", matchedAka: null,
};
const KEPLER: TitleSuggestion = {
  imdbId: "tt0000002", title: "Kepler", year: 2019, type: "tv", matchedAka: null,
};
const ASHFALL_AKA: TitleSuggestion = {
  imdbId: "tt0000003", title: "Ashfall", year: 1999, type: "movie", matchedAka: "Ashfall Rising",
};

describe("SearchBar suggestions", () => {
  // AN EMPTY LIST COSTS NO ROWS — the spec's promise that the layout does not
  // move as replies arrive, and the reason the results view can budget for the
  // bar plus exactly the rows it is showing. Asserted as a row COUNT against the
  // one-suggestion case: the previous version asserted the frame did not contain
  // "Kestrel" on a render that was passed no suggestions at all, so nothing could
  // have put the string there and no bug could have failed it.
  const rowCount = (frame: string | undefined): number => (frame ?? "").split("\n").length;

  it("costs no extra rows when there are no suggestions", () => {
    const empty = render(<SearchBar width={60} value="kes" editing suggestions={[]} onSubmit={() => {}} />);
    const one = render(
      <SearchBar
        width={60}
        value="kes"
        editing
        suggestions={[KESTREL]}
        completion="Kestrel 2010"
        onSubmit={() => {}}
      />,
    );
    expect(rowCount(one.lastFrame())).toBe(rowCount(empty.lastFrame()) + 1);
  });

  it("lists each suggestion with its year and kind", () => {
    const { lastFrame } = render(
      <SearchBar
        width={60}
        value="ke"
        editing
        suggestions={[KESTREL, KEPLER]}
        completion="Kestrel 2010"
        onSubmit={() => {}}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Kestrel (2010) · film");
    expect(frame).toContain("Kepler (2019) · show");
  });

  it("shows the aka note on a hit that matched an alternate title", () => {
    const { lastFrame } = render(
      <SearchBar
        width={60}
        value="ashfall ris"
        editing
        suggestions={[ASHFALL_AKA]}
        completion="Ashfall 1999"
        onSubmit={() => {}}
      />,
    );
    expect(lastFrame() ?? "").toContain("Ashfall Rising");
  });

  // Suggestions belong to the box you are typing in. Leaving them under a
  // collapsed bar would leave a stale list on screen with nothing editing it.
  it("shows no suggestions when the bar is not being edited", () => {
    const { lastFrame } = render(
      <SearchBar
        width={60}
        value="ke"
        editing={false}
        suggestions={[KESTREL]}
        completion="Kestrel 2010"
        onSubmit={() => {}}
      />,
    );
    expect(lastFrame() ?? "").not.toContain("Kestrel (2010)");
  });

  /**
   * TAB COMPLETES ONLY WHEN THERE IS SOMETHING TO COMPLETE. The rest of the
   * time it must still leave the field — that is what it has always done
   * (TextField's onExitDown), and both the results pane and the splash depend
   * on it.
   */
  it("completes to the top suggestion on tab", async () => {
    const onComplete = vi.fn();
    const onExitDown = vi.fn();
    const { stdin } = render(
      <SearchBar
        width={60}
        value="ke"
        editing
        suggestions={[KESTREL, KEPLER]}
        completion="Kestrel 2010"
        onComplete={onComplete}
        onExitDown={onExitDown}
        onSubmit={() => {}}
      />,
    );
    await new Promise((r) => setTimeout(r, 10));
    stdin.write("\t");
    await new Promise((r) => setTimeout(r, 10));
    expect(onComplete).toHaveBeenCalledWith("Kestrel 2010");
    expect(onExitDown).not.toHaveBeenCalled();
  });

  it("still leaves the field on tab with no completion available", async () => {
    const onComplete = vi.fn();
    const onExitDown = vi.fn();
    const { stdin } = render(
      <SearchBar width={60} value="ke" editing onComplete={onComplete} onExitDown={onExitDown} onSubmit={() => {}} />,
    );
    await new Promise((r) => setTimeout(r, 10));
    stdin.write("\t");
    await new Promise((r) => setTimeout(r, 10));
    expect(onExitDown).toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  // The arrows are search history's and stay that way — a suggestion list is
  // not worth taking a working binding away from.
  it("leaves the up arrow to search history even with a list open", async () => {
    const { stdin, lastFrame } = render(
      <SearchBar
        width={60}
        value=""
        editing
        history={["Tin Rivers 2024"]}
        suggestions={[KESTREL]}
        completion="Kestrel 2010"
        onSubmit={() => {}}
      />,
    );
    await new Promise((r) => setTimeout(r, 10));
    stdin.write("\u001B[A");
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame() ?? "").toContain("Tin Rivers 2024");
  });
  /**
   * Completing mid-recall must end the recall. `recall()` deliberately leaves
   * history-navigation state alone - that is what the arrows walk through with -
   * so completing through it left `histIndex` pointing at an entry no longer in
   * the field, and the next arrow press then moved relative to that stale index
   * instead of starting again from the completed text.
   *
   * With a one-entry history the symptom is that the arrow does nothing at all,
   * because the stale index is already the end of the list.
   */
  it("restarts history navigation after a tab completion", async () => {
    const { stdin, lastFrame } = render(
      <SearchBar
        width={60}
        value=""
        editing
        history={["Tin Rivers 2024"]}
        suggestions={[KESTREL]}
        completion="Kestrel 2010"
        onSubmit={() => {}}
      />,
    );
    await new Promise((r) => setTimeout(r, 10));
    stdin.write("\u001B[A");
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame() ?? "").toContain("Tin Rivers 2024");

    stdin.write("\t");
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame() ?? "").toContain("Kestrel 2010");

    // The completion is a fresh draft, so up recalls the history entry again.
    stdin.write("\u001B[A");
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame() ?? "").toContain("Tin Rivers 2024");
  });
});
