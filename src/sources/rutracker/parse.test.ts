import { describe, expect, it } from "vitest";
import { parseRows, buildGroupMap } from "./index";
import { decodeCp1251 } from "./session";

const ROW = (forum: string, title: string, forumId = 635) => `
<tr class="tCenter hl-tr">
  <td class="row1 f-name-col"><div class="f-name"><a class="gen f" href="tracker.php?f=${forumId}">${forum}</a></div></td>
  <td class="row4 med tLeft t-title-col tt"><div class="wbr t-title"><a data-topic_id="123" class="med tLink bold" href="viewtopic.php?t=123">${title}</a></div></td>
  <td class="row4 small nowrap tor-size" data-ts_text="13192355840"><a class="small tr-dl dl-stub" href="dl.php?t=123">12.3 GB</a></td>
  <td class="row4 nowrap" data-ts_text="42"><b class="seedmed">42</b></td>
  <td class="row4 leechmed bold" data-ts_text="3">3</td>
  <td class="row4 small nowrap" data-ts_text="1700000000">date</td>
</tr>`;

const TABLE = (rows: string) => `<table id="tor-tbl"><tbody>${rows}</tbody></table>`;

describe("parseRows", () => {
  it("extracts the size, seeders, leechers and added timestamp", () => {
    const rows = parseRows(TABLE(ROW("Зарубежное кино", "Dune Part Two 2024 2160p")));
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.topicId).toBe("123");
    expect(r.name).toBe("Dune Part Two 2024 2160p");
    expect(r.sizeBytes).toBe(13192355840);
    expect(r.seeders).toBe(42);
    expect(r.leechers).toBe(3);
    expect(r.added).toBe(1700000000);
  });

  it("classifies by forum name when no forum map is available", () => {
    const groupFor = (forum: string) => parseRows(TABLE(ROW(forum, "Title")))[0]?.group;
    expect(groupFor("Аниме (HD Video)")).toBe("Anime");
    expect(groupFor("PC игры")).toBe("Games");
    expect(groupFor("Зарубережные сериалы")).toBe("TV");
    expect(groupFor("Зарубережное кино")).toBe("Movies");
    expect(groupFor("Электронные книги")).toBe("Books");
    expect(groupFor("Аудиокниги (AAC)")).toBe("Books");
  });

  it("drops results that aren't one of the four tabs", () => {
    expect(parseRows(TABLE(ROW("Рок-музыка (lossless)", "Some Album")))).toHaveLength(0);
    expect(parseRows(TABLE("<tr><td>nothing</td></tr>"))).toHaveLength(0);
  });
});

const SELECT = `
<select name="f[]" multiple="multiple">
  <optgroup label="&nbsp;Кино, Видео и ТВ">
    <option id="fs-7" value="7" class='root_forum has_sf' >Зарубережное кино&nbsp;</option>
    <option id="fs-313" value="313" class='fp-7' > |- Зарубережное кино (HD Video)&nbsp;</option>
    <option id="fs-33" value="33" class='root_forum has_sf' >Аниме&nbsp;</option>
    <option id="fs-1390" value="1390" class='fp-33' > |- Наруто&nbsp;</option>
  </optgroup>
  <optgroup label="&nbsp;Сериалы">
    <option id="fs-266" value="266" class='fp-189' > |- Сериалы США и Канады (HD Video)&nbsp;</option>
  </optgroup>
  <optgroup label="&nbsp;Игры">
    <option id="fs-973" value="973" class='fp-548' > |- PS4&nbsp;</option>
  </optgroup>
  <optgroup label="&nbsp;Музыка">
    <option id="fs-408" value="408" class='fp-409' > |- Поп-музыка (lossless)&nbsp;</option>
  </optgroup>
  <optgroup label="&nbsp;Книги и журналы">
    <option id="fs-21" value="21" class='root_forum' >Книги и журналы (общий раздел)&nbsp;</option>
  </optgroup>
  <optgroup label="&nbsp;Аудиокниги">
    <option id="fs-1909" value="1909" class='root_forum' >Аудиокниги (AAC, ALAC)&nbsp;</option>
  </optgroup>
</select>`;

describe("buildGroupMap", () => {
  const map = buildGroupMap(SELECT);
  it("maps top sections onto the four tabs", () => {
    expect(map.get(313)).toBe("Movies");
    expect(map.get(266)).toBe("TV");
    expect(map.get(973)).toBe("Games");
    expect(map.get(21)).toBe("Books");
    expect(map.get(1909)).toBe("Books");
  });
  it("overrides the section for anime nested under films", () => {
    expect(map.get(33)).toBe("Anime");
    expect(map.get(1390)).toBe("Anime");
  });
  it("omits sections with no tab", () => {
    expect(map.has(408)).toBe(false);
  });
});

describe("parseRows with a forum map", () => {
  it("classifies a title-only anime forum by id, not its name", () => {
    const map = buildGroupMap(SELECT);
    const rows = parseRows(TABLE(ROW("Наруто", "Naruto Shippuuden", 1390)), map);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.group).toBe("Anime");
  });
});

describe("decodeCp1251", () => {
  it("decodes Windows-1251 Cyrillic bytes", () => {
    const bytes = new Uint8Array([0xca, 0xe8, 0xed, 0xee]);
    expect(decodeCp1251(bytes.buffer)).toBe("Кино");
  });
});
