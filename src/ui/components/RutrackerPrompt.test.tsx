import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { RutrackerPrompt } from "./RutrackerPrompt";

describe("RutrackerPrompt", () => {
  it("renders the username and password fields", () => {
    const { lastFrame } = render(
      <RutrackerPrompt
        width={60}
        status={{ kind: "idle" }}
        onSubmit={() => {}}
        onCopyCaptcha={() => {}}
        onCancel={() => {}}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Username");
    expect(frame).toContain("Password");
  });

  it("shows a captcha hint when a captcha is required", () => {
    const { lastFrame } = render(
      <RutrackerPrompt
        width={60}
        status={{ kind: "idle" }}
        captcha={{ sid: "s", field: "cap_code_x", imageUrl: "https://x/y.jpg" }}
        onSubmit={() => {}}
        onCopyCaptcha={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(lastFrame() ?? "").toContain("Captcha");
  });
});
