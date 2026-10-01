export const FOLIATE_FORMATS = ["epub", "fb2", "cbz"];
export const TEXT_FORMATS = ["epub", "fb2"];
export const AUDIO_FORMATS = ["mp3", "m4b", "m4a", "aac", "ogg", "opus"];
export const VIDEO_FORMATS = ["mp4", "m4v", "webm", "mov", "mkv"];

export const SUPPORTED_EXTENSIONS = [
  ".epub",
  ".pdf",
  ".fb2",
  ".cbz",
  ".mp3",
  ".m4b",
  ".m4a",
  ".aac",
  ".ogg",
  ".opus",
  ".mp4",
  ".m4v",
  ".webm",
  ".mov",
  ".mkv",
];

export const FILE_ACCEPT = SUPPORTED_EXTENSIONS.join(",");

export const HIGHLIGHT_COLORS = [
  { name: "yellow", rgba: "rgba(255, 235, 59, 0.5)" },
  { name: "green", rgba: "rgba(76, 175, 80, 0.45)" },
  { name: "blue", rgba: "rgba(33, 150, 243, 0.45)" },
  { name: "pink", rgba: "rgba(233, 30, 99, 0.45)" },
  { name: "orange", rgba: "rgba(255, 152, 0, 0.5)" },
];

export const HIGHLIGHT_COLOR_NAMES = HIGHLIGHT_COLORS.map((c) => c.name);
