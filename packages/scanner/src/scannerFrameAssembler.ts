export interface ScannerFrameOptions {
  frameTimeoutMs?: number;
  maxFrameLength?: number;
}

export interface ScanFrameResult {
  accepted: boolean;
  frame?: string;
  reason?: string;
}

export class ScannerFrameAssembler {
  private buffer = "";
  private lastCharAt = 0;
  private readonly frameTimeoutMs: number;
  private readonly maxFrameLength: number;

  constructor(options: ScannerFrameOptions = {}) {
    this.frameTimeoutMs = options.frameTimeoutMs ?? 120;
    this.maxFrameLength = options.maxFrameLength ?? 256;
  }

  pushCharacter(character: string, atMs: number = Date.now()): ScanFrameResult {
    if (character.length !== 1 && character !== "Enter") {
      return { accepted: false, reason: "Unsupported scanner input token." };
    }

    if (this.lastCharAt > 0 && atMs - this.lastCharAt > this.frameTimeoutMs) {
      this.buffer = "";
    }
    this.lastCharAt = atMs;

    if (character === "Enter") {
      const frame = this.buffer.trim();
      this.buffer = "";
      if (!frame) {
        return { accepted: false, reason: "Empty scanner frame." };
      }
      return { accepted: true, frame };
    }

    if (this.buffer.length >= this.maxFrameLength) {
      this.buffer = "";
      return { accepted: false, reason: "Scanner frame exceeded max length." };
    }

    this.buffer += character;
    return { accepted: false };
  }
}
