import { describe, expect, it } from "vitest";
import {
  groupCountLabel,
  groupKeyFor,
  groupResults,
  groupRowPlan,
  resultAtRow,
} from "./resultGroup";

const r = (name: string) => ({ name });

describe("groupKeyFor", () => {
  it("keys a film on title and year, so two films sharing a title stay apart", () => {
    expect(groupKeyFor("Kestrel.2010.1080p.BluRay.x264")).toBe("kestrel|2010|movie");
    // The real case this protects: same title, different film.
    expect(groupKeyFor("Ashfall.1999.1080p")).not.toBe(groupKeyFor("Ashfall.2024.1080p"));
  });

  it("collapses different releases of one film onto one key", () => {
    expect(groupKeyFor("Kestrel.2010.1080p.BluRay.x264")).toBe(
      groupKeyFor("Kestrel.2010.2160p.WEB-DL.DV.HDR-OTHER"),
    );
  });

  // parseRelease's own `key` is `title|year|type`, which for ANY series is
  // `kepler||series` — every episode of every season in one bucket. These two
  // fixtures exist to catch exactly that.
  it("keys an episode on season and episode", () => {
    expect(groupKeyFor("Kepler.S02E04.1080p.WEB-DL")).toBe("kepler|series|s2|e4");
  });

  it("keys a season pack distinctly from an episode of that season", () => {
    expect(groupKeyFor("Harrowgate.S03.1080p.WEB-DL")).toBe("harrowgate|series|s3|pack");
    expect(groupKeyFor("Harrowgate.S03.1080p.WEB-DL")).not.toBe(
      groupKeyFor("Harrowgate.S03E01.1080p.WEB-DL"),
    );
  });

  it("keeps two episodes of one season apart", () => {
    expect(groupKeyFor("Kepler.S02E04.1080p.WEB-DL")).not.toBe(
      groupKeyFor("Kepler.S02E05.1080p.WEB-DL"),
    );
  });

  it("strips a tracker prefix, which stranded 5 of 129 live results in its own group", () => {
    expect(groupKeyFor("www.uindex.org    -    Kestrel 2010 1080p BluRay")).toBe(
      groupKeyFor("Kestrel.2010.1080p.BluRay.x264"),
    );
  });

  it("strips a container extension", () => {
    expect(groupKeyFor("Kestrel.2010.1080p.TELESYNC.x264.mkv")).toBe(
      groupKeyFor("Kestrel.2010.1080p.BluRay.x264"),
    );
  });

  // Order matters: punctuation must become spaces BEFORE the leading article is
  // dropped. Built the other way round, a wrapped title keeps its "the" once the
  // wrapper is stripped and splits into its own group.
  it("drops a leading article after punctuation is normalised, not before", () => {
    expect(groupKeyFor("(Кестрел) The Kestrel 2010 1080p")).toBe(
      groupKeyFor("Kestrel.2010.1080p.BluRay.x264"),
    );
  });

  it("falls back to the normalised raw name when the parser returns null", () => {
    // parseRelease returns null for some real names. The group must still exist.
    const key = groupKeyFor("     ");
    expect(typeof key).toBe("string");
    expect(key.length).toBeGreaterThan(0);
  });
});

describe("groupResults", () => {
  it("preserves the caller's order: groups by first member, members as given", () => {
    const list = [
      r("Ashfall.1999.1080p"),
      r("Kestrel.2010.1080p.BluRay.x264"),
      r("Ashfall.1999.2160p.WEB-DL"),
    ];
    const groups = groupResults(list);
    expect(groups.map((g) => g.title)).toEqual(["Ashfall", "Kestrel"]);
    expect(groups[0]!.members.map((m) => m.name)).toEqual([
      "Ashfall.1999.1080p",
      "Ashfall.1999.2160p.WEB-DL",
    ]);
  });

  it("carries the display title and year for the group heading", () => {
    const groups = groupResults([r("Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP")]);
    expect(groups[0]!.title).toBe("Tin Rivers");
    expect(groups[0]!.year).toBe(2024);
  });
});

describe("groupRowPlan", () => {
  const groups = groupResults([
    r("Kestrel.2010.1080p.BluRay.x264"),
    r("Kestrel.2010.2160p.WEB-DL"),
    r("Ashfall.1999.1080p"),
  ]);

  it("renders a lone release as a plain row, not a group of one", () => {
    const rows = groupRowPlan(groups, new Set());
    const ashfall = rows.filter((row) => row.kind === "release");
    expect(ashfall).toHaveLength(1);
    expect(ashfall[0]!.kind === "release" && ashfall[0]!.inGroup).toBe(false);
  });

  it("collapses a real group to its header alone", () => {
    const rows = groupRowPlan(groups, new Set());
    expect(rows.map((row) => row.kind)).toEqual(["group", "release"]);
    expect(rows[0]!.kind === "group" && rows[0]!.members).toHaveLength(2);
    expect(rows[0]!.kind === "group" && rows[0]!.expanded).toBe(false);
  });

  it("emits a header plus every member once expanded", () => {
    const rows = groupRowPlan(groups, new Set(["kestrel|2010|movie"]));
    expect(rows.map((row) => row.kind)).toEqual(["group", "release", "release", "release"]);
    expect(rows[1]!.kind === "release" && rows[1]!.inGroup).toBe(true);
  });

  it("gives every row a unique key, so a re-render cannot collide them", () => {
    const rows = groupRowPlan(groups, new Set(["kestrel|2010|movie"]));
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });
});

describe("resultAtRow", () => {
  it("resolves a collapsed header to its first member, so every action still has a target", () => {
    const groups = groupResults([
      r("Kestrel.2010.1080p.BluRay.x264"),
      r("Kestrel.2010.2160p.WEB-DL"),
    ]);
    const rows = groupRowPlan(groups, new Set());
    expect(resultAtRow(rows[0]!)?.name).toBe("Kestrel.2010.1080p.BluRay.x264");
  });
});

describe("groupCountLabel", () => {
  it("says releases, and gets the singular right", () => {
    expect(groupCountLabel(2)).toBe("2 releases");
    expect(groupCountLabel(1)).toBe("1 release");
  });
});
