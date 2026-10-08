export type ScanSoundType = "success" | "error" | "beep";

export const playScanSound = (type: ScanSoundType) => {
  try {
    if (typeof window === "undefined" || typeof Audio === "undefined") {
      return;
    }

    const soundFile =
      type === "success" ? "correct.mp3" :
      type === "error" ? "error.mp3" :
      "correct.mp3";

    const assetUrl = new URL(`./assets/branding/${soundFile}`, window.location.href).toString();
    const audio = new Audio(assetUrl);

    if (!audio || typeof audio.play !== "function") {
      return;
    }

    audio.volume = 0.9;

    try {
      const playback = audio.play();
      if (playback && typeof playback.catch === "function") {
        playback.catch((error) => {
          console.log("Audio playback failed:", error);
        });
      }
    } catch (error) {
      console.log("Audio playback failed:", error);
    }
  } catch (error) {
    console.log("Audio playback failed:", error);
  }
};
