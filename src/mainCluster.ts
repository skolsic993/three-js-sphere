import { GoldClusterScene } from "./scenes/goldClusterScene";

const app = new GoldClusterScene(document.getElementById("app") as HTMLElement);
(window as unknown as { __clusterScene: GoldClusterScene }).__clusterScene = app;

function formatStartError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (err instanceof Event) {
    const target = err.target as HTMLImageElement | HTMLScriptElement | null;
    const src =
      target && "src" in target && typeof target.src === "string"
        ? target.src
        : "";
    return src
      ? `failed to load asset (${src.split("/").pop() ?? src})`
      : `asset load failed (${err.type})`;
  }
  return String(err);
}

app.start().catch((err: unknown) => {
  console.error(err);
  const el = document.createElement("div");
  el.className = "fatal";
  el.textContent =
    `Failed to start: ${formatStartError(err)}. ` +
    "If this mentions WebGL, try a recent Chrome, Edge or Firefox.";
  document.body.appendChild(el);
});
