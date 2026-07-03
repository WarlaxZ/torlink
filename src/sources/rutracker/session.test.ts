import { describe, expect, it } from "vitest";
import { decodeCp1251, pickCookies, parseCaptcha } from "./session";

describe("decodeCp1251", () => {
  it("decodes Windows-1251 Cyrillic bytes", () => {
    const bytes = new Uint8Array([0xca, 0xe8, 0xed, 0xee]);
    expect(decodeCp1251(bytes.buffer)).toBe("Кино");
  });
});

describe("pickCookies", () => {
  it("keeps bb_* cookies and requires a real bb_session", () => {
    const cookie = pickCookies([
      "bb_session=abc123; path=/; HttpOnly",
      "bb_data=xyz; path=/",
      "other=nope; path=/",
    ]);
    expect(cookie).toBe("bb_session=abc123; bb_data=xyz");
  });

  it("returns null when bb_session is deleted or missing", () => {
    expect(pickCookies(["bb_session=deleted; path=/"])).toBeNull();
    expect(pickCookies(["bb_data=xyz; path=/"])).toBeNull();
  });
});

describe("parseCaptcha", () => {
  it("extracts sid, dynamic field name, and image url", () => {
    const html = `
      <input type="hidden" name="cap_sid" value="SID123">
      <img src="//static.rutracker.cc/captcha/1234.jpg">
      <input type="text" name="cap_code_abc">`;
    const cap = parseCaptcha(html);
    expect(cap).toEqual({
      sid: "SID123",
      field: "cap_code_abc",
      imageUrl: "https://static.rutracker.cc/captcha/1234.jpg",
    });
  });

  it("returns null when there is no captcha", () => {
    expect(parseCaptcha("<p>no captcha here</p>")).toBeNull();
  });
});
