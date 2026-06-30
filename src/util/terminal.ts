// OSC 8 hyperlink. Modern terminals (Windows Terminal, VS Code, iTerm2,
// WezTerm, GNOME Terminal, …) render `label` as a clickable link to `url`;
// terminals that don't understand the escape swallow it and just show the
// label, so we default the label to the URL itself to keep it readable.
const OSC = "\x1b]8;;";
const ST = "\x1b\\";

export function hyperlink(url: string, label: string = url): string {
  return `${OSC}${url}${ST}${label}${OSC}${ST}`;
}
