import { describe, expect, it, vi, beforeEach } from "vitest";
import { playScanSound } from "./playScanSound";

describe("playScanSound", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("plays the success tone for accepted scans", () => {
    const play = vi.fn().mockResolvedValue(undefined);
    const AudioMock = vi.fn().mockImplementation(() => ({
      volume: 0,
      play,
    }));

    vi.stubGlobal("Audio", AudioMock);

    playScanSound("success");

    expect(AudioMock).toHaveBeenCalledWith(new URL("./assets/branding/correct.mp3", window.location.href).toString());
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("plays the error tone for rejected scans", () => {
    const play = vi.fn().mockResolvedValue(undefined);
    const AudioMock = vi.fn().mockImplementation(() => ({
      volume: 0,
      play,
    }));

    vi.stubGlobal("Audio", AudioMock);

    playScanSound("error");

    expect(AudioMock).toHaveBeenCalledWith(new URL("./assets/branding/error.mp3", window.location.href).toString());
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("does not throw when media playback is unavailable in jsdom", () => {
    const AudioMock = vi.fn().mockImplementation(() => ({
      volume: 0,
      play: undefined,
    }));

    vi.stubGlobal("Audio", AudioMock);
    const originalPlay = HTMLMediaElement.prototype.play;
    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      value: undefined,
      configurable: true,
    });

    expect(() => playScanSound("error")).not.toThrow();

    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      value: originalPlay,
      configurable: true,
    });
  });
});
