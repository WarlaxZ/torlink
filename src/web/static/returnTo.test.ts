import { describe, expect, it } from "vitest";
import { backTarget } from "./returnTo";

const HOME = "/";

describe("backTarget", () => {
  it("goes back one entry when the dashboard sent us here", () => {
    expect(backTarget("/?q=harrowgate&group=TV", 2, HOME)).toEqual({ kind: "back" });
  });

  /**
   * A player URL opened cold — a bookmark, a link pasted onto a phone — in a tab
   * that has browsed elsewhere. `history.length > 1` is true there too, so going
   * back on that alone would leave the site. The note is what distinguishes them.
   */
  it("navigates when there is no note, however long the history is", () => {
    expect(backTarget("", 9, HOME)).toEqual({ kind: "href", href: HOME });
  });

  it("navigates when this is the only entry in the tab", () => {
    expect(backTarget("/?q=kepler", 1, HOME)).toEqual({ kind: "href", href: "/?q=kepler" });
  });

  it("prefers the remembered search over the bare fallback", () => {
    // Someone who bookmarked a player page still gets the search that led to it,
    // when this tab happens to know it.
    expect(backTarget("/?q=kepler&group=TV", 1, HOME)).toEqual({
      kind: "href",
      href: "/?q=kepler&group=TV",
    });
  });
});

/**
 * sessionStorage is user-writable and survives upgrades, and this value ends up
 * in `location`. Every one of these must fall back rather than be followed.
 */
describe("backTarget — a hostile note", () => {
  it.each([
    ["a protocol-relative URL", "//evil.example/"],
    ["an absolute URL", "https://evil.example/"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["a data: URL", "data:text/html,<script>1</script>"],
    ["a relative path with no leading slash", "evil.example"],
    ["another page on this origin", "/play/abc/0?k=leak"],
    ["a path that only starts like the dashboard", "/admin?q=x"],
    ["empty", ""],
    ["whitespace", "   "],
  ])("refuses %s", (_why, value) => {
    expect(backTarget(value, 5, HOME)).toEqual({ kind: "href", href: HOME });
  });

  it("refuses a hostile note even when it would only be used for history.back", () => {
    // The `back` branch does not navigate to the value — but accepting it here
    // would mean a crafted note decides whether Back leaves the app, so the
    // validation gates both branches rather than just the one that reads it.
    expect(backTarget("//evil.example/", 5, HOME)).toEqual({ kind: "href", href: HOME });
  });
});
