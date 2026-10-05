export type TerminalAction = { type: "write"; text: string } | { type: "submit"; command: string } | { type: "interrupt" };

const PROMPT = "\x1b[38;5;179m$\x1b[0m ";

/**
 * Minimal line editor for the user terminal. BetaCode runs each submitted line as a command and streams its
 * output; it is not an interactive PTY (programs that read stdin or draw full-screen UIs are not supported).
 */
export class LineEditor {
  private buffer = "";
  private history: string[] = [];
  private cursor = -1;
  busy = false;

  static readonly prompt = PROMPT;

  get line(): string {
    return this.buffer;
  }

  private redraw(): TerminalAction {
    return { type: "write", text: `\r\x1b[2K${PROMPT}${this.buffer}` };
  }

  feed(data: string): TerminalAction[] {
    const out: TerminalAction[] = [];
    for (let i = 0; i < data.length; i++) {
      const c = data[i]!;
      if (c === "\x1b") {
        const seq = data.slice(i, i + 3);
        if (seq === "\x1b[A" && !this.busy && this.history.length) {
          this.cursor = this.cursor < 0 ? this.history.length - 1 : Math.max(0, this.cursor - 1);
          this.buffer = this.history[this.cursor]!;
          out.push(this.redraw());
        } else if (seq === "\x1b[B" && !this.busy && this.cursor >= 0) {
          this.cursor = this.cursor + 1;
          this.buffer = this.cursor >= this.history.length ? "" : this.history[this.cursor]!;
          if (this.cursor >= this.history.length) this.cursor = -1;
          out.push(this.redraw());
        }
        i += seq.length - 1;
        continue;
      }
      if (c === "\x03") {
        if (this.busy) out.push({ type: "interrupt" });
        else {
          this.buffer = "";
          out.push({ type: "write", text: `^C\r\n${PROMPT}` });
        }
        continue;
      }
      if (this.busy) continue; // input to a running command is not supported
      if (c === "\r" || c === "\n") {
        const command = this.buffer.trim();
        this.buffer = "";
        this.cursor = -1;
        out.push({ type: "write", text: "\r\n" });
        if (command) {
          if (this.history[this.history.length - 1] !== command) this.history.push(command);
          out.push({ type: "submit", command });
        } else out.push({ type: "write", text: PROMPT });
      } else if (c === "\x7f" || c === "\b") {
        if (this.buffer) {
          this.buffer = this.buffer.slice(0, -1);
          out.push({ type: "write", text: "\b \b" });
        }
      } else if (c >= " ") {
        this.buffer += c;
        out.push({ type: "write", text: c });
      }
    }
    return out;
  }
}
