import chalk from "chalk";

export const logger = {
  info: (msg: string) => console.log(chalk.cyan("info"), msg),
  ok: (msg: string) => console.log(chalk.green("✓"), msg),
  warn: (msg: string) => console.log(chalk.yellow("!"), msg),
  error: (msg: string) => console.error(chalk.red("✗"), msg),
  heading: (msg: string) => console.log("\n" + chalk.bold.underline(msg)),
};
