/** FIFO prompt queue with in-place edits and removals for the interactive TUI. */
export class PromptQueue {
  private readonly prompts: string[] = [];

  get length(): number {
    return this.prompts.length;
  }

  list(): readonly string[] {
    return this.prompts;
  }

  at(index: number): string | undefined {
    return this.prompts[index];
  }

  enqueue(prompt: string): void {
    const text = prompt.trim();
    if (text) this.prompts.push(text);
  }

  update(index: number, prompt: string): boolean {
    const text = prompt.trim();
    if (!text || index < 0 || index >= this.prompts.length) return false;
    this.prompts[index] = text;
    return true;
  }

  /** Update a prompt while it is being edited, including a temporarily blank draft. */
  setDraft(index: number, prompt: string): boolean {
    if (index < 0 || index >= this.prompts.length) return false;
    this.prompts[index] = prompt;
    return true;
  }

  remove(index: number): string | undefined {
    if (index < 0 || index >= this.prompts.length) return undefined;
    return this.prompts.splice(index, 1)[0];
  }

  takeNext(): string | undefined {
    return this.prompts.shift();
  }
}