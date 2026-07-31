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
  it("shows nothing extra when there are no suggestions", () => {
    const { lastFrame } = render(
      <SearchBar width={60} value="kes" editing onSubmit={() => {}} />,
    );
    expect(lastFrame()).not.toContain("Kestrel");
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
});
