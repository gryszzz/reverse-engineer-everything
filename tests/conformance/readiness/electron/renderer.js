document.querySelector("#run").addEventListener("click", async () => {
  document.querySelector("#result").textContent =
    await window.readiness.echo("renderer");
});
window.readiness.onDeepLink((_event, url) => {
  document.querySelector("#result").textContent = url;
});
