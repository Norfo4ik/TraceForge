import chalk from "chalk";

/** 5-row block letters, each exactly 5 columns wide. */
const FONT: Record<string, string[]> = {
  T: ["█████", "  █  ", "  █  ", "  █  ", "  █  "],
  R: ["████ ", "█   █", "████ ", "█  █ ", "█   █"],
  A: [" ███ ", "█   █", "█████", "█   █", "█   █"],
  C: [" ████", "█    ", "█    ", "█    ", " ████"],
  E: ["█████", "█    ", "████ ", "█    ", "█████"],
  F: ["█████", "█    ", "████ ", "█    ", "█    "],
  O: [" ███ ", "█   █", "█   █", "█   █", " ███ "],
  G: [" ████", "█    ", "█  ██", "█   █", " ████"],
};

const WORD = "TRACEFORGE";
export const TAGLINE = "Trace work items to code — with AI that never leaves your machine.";

// Ember at the top of the forge, molten gold at the bottom.
const GRADIENT: [number, number, number][] = [
  [255, 94, 58],
  [255, 122, 48],
  [255, 150, 44],
  [255, 179, 50],
  [255, 208, 84],
];

export function logoRows(): string[] {
  return Array.from({ length: 5 }, (_, row) =>
    [...WORD].map((letter) => FONT[letter][row]).join(" ")
  );
}

export const LOGO_WIDTH = logoRows()[0].length;

export interface LogoOptions {
  /** Terminal width; the big logo needs LOGO_WIDTH plus a little margin. */
  columns: number;
  version: string;
  /** Set false for plain text (tests, no-colour terminals are handled by chalk itself). */
  color?: boolean;
}

/** The multi-line brand header: logo, tagline and version. Falls back to a one-line wordmark on narrow terminals. */
export function renderLogo({ columns, version, color = true }: LogoOptions): string {
  const paint = (rgb: [number, number, number], text: string) => (color ? chalk.rgb(...rgb)(text) : text);
  const dim = (text: string) => (color ? chalk.dim(text) : text);
  const indent = "  ";

  if (columns < LOGO_WIDTH + indent.length + 2) {
    return [
      "",
      `${indent}${paint(GRADIENT[2], color ? chalk.bold("◆ TRACEFORGE") : "◆ TRACEFORGE")} ${dim(`v${version}`)}`,
      `${indent}${dim(TAGLINE)}`,
      "",
    ].join("\n");
  }

  const rows = logoRows().map((row, i) => `${indent}${paint(GRADIENT[i], row)}`);
  const underline = `${indent}${paint(GRADIENT[4], "▔".repeat(LOGO_WIDTH))}`;
  return ["", ...rows, underline, `${indent}${dim(TAGLINE)}  ${dim(`v${version}`)}`, ""].join("\n");
}

/** Clears the screen and scrollback so the menu always starts at the top. No-op when not attached to a terminal. */
export function clearScreen(): void {
  if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
}
