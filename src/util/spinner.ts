const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Small terminal spinner that is a no-op when stdout is not a TTY. */
export class Spinner {
  private timer: NodeJS.Timeout | undefined;
  private frame = 0;
  private label: string;

  constructor(
    label = "thinking",
    private readonly stream: NodeJS.WriteStream = process.stdout,
  ) {
    this.label = label;
  }

  get active(): boolean {
    return this.timer !== undefined;
  }

  start(label?: string): void {
    if (label) this.label = label;
    if (this.timer || !this.stream.isTTY) return;

    this.timer = setInterval(() => {
      const frame = FRAMES[this.frame++ % FRAMES.length]!;
      this.stream.write(`\r\u001b[2K\u001b[90m${frame} ${this.label}…\u001b[39m`);
    }, 80);
    this.timer.unref?.();
  }

  setLabel(label: string): void {
    this.label = label;
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    if (this.stream.isTTY) this.stream.write("\r\u001b[2K");
  }
}
